-- Least-privilege database roles for ExamHub.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- The application connects as `postgres`: a superuser. That means the only
-- thing standing between a bug and every tenant's data is application code —
-- the Prisma tenant extension. The extension is good and it is tested, but it
-- is one layer, and it has already been wrong once: question-selection.ts
-- shipped raw SQL with no tenant predicate and served one customer's question
-- bank into another customer's exam.
--
-- A superuser also silently ignores row-level security, so any future RLS work
-- would be decorative until this lands. Verified on this box: with a policy
-- enabled and a tenant GUC set, `postgres` saw BOTH tenants' rows; a
-- NOBYPASSRLS role saw one.
--
-- This is not RLS. There are no policies here. This is the smaller, cheaper
-- thing underneath it: the app cannot DROP TABLE, cannot read pg_authid, cannot
-- turn RLS off, and cannot escalate. It costs nothing at runtime.
-- ---------------------------------------------------------------------------
--
-- NOT a Prisma migration, deliberately:
--   * roles are CLUSTER-global, not per-database, so they are not part of a
--     schema's version history;
--   * a migration runs AS the migrator, and cannot bootstrap the role it is
--     already connected as;
--   * `prisma migrate dev` replays migrations against a shadow database in the
--     same cluster, so a CREATE ROLE inside one fails the second time.
--
-- USAGE (as a superuser, once per database):
--   psql -U postgres -d bookends_dev \
--        -v app_pw="'...'" -v migrator_pw="'...'" -v dbname=bookends_dev \
--        -f scripts/provision-roles.sql
--
-- Then point the app at examhub_app and migrations at examhub_migrator:
--   DATABASE_URL=postgresql://examhub_app:...@host:5432/bookends_dev
--   MIGRATE_DATABASE_URL=postgresql://examhub_migrator:...@host:5432/bookends_dev

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

-- Idempotent: this script is run by hand, on databases that may already have
-- been provisioned, and failing on a re-run would push people toward not
-- running it at all.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examhub_migrator') THEN
    CREATE ROLE examhub_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'examhub_app') THEN
    CREATE ROLE examhub_app LOGIN;
  END IF;
END $$;

-- Owns the schema and runs migrations. NOT a superuser: it needs DDL on this
-- database and nothing else.
--
-- CREATEDB is deliberate, and it is the one privilege here worth arguing about.
-- `prisma migrate dev` builds a throwaway SHADOW DATABASE to diff the schema
-- against, so without it every developer's day-one command dies with an opaque
-- P3014. Withholding it would buy nothing anyway: this role already owns the
-- entire schema, so a compromised migrator can DROP TABLE regardless — being
-- able to CREATE DATABASE adds no reach it does not already have.
--
-- `migrate deploy`, the production path, does NOT need it. If your deploy role
-- is separate from your development one, drop CREATEDB there.
ALTER ROLE examhub_migrator
  NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :migrator_pw;

-- The application. Reads and writes rows; owns nothing; changes no structure.
--
-- NOBYPASSRLS is the point of the exercise. NOINHERIT means that even if
-- someone later grants this role membership in a privileged one, it does not
-- silently acquire those rights — it would have to SET ROLE explicitly, which
-- is visible in a diff.
ALTER ROLE examhub_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD :app_pw;

-- Deliberately NOT granted: examhub_app has no membership in examhub_migrator.
-- Role attributes are not inherited through membership, which looks safe — but
-- membership permits SET ROLE, which reaches the same place in one statement.

-- ---------------------------------------------------------------------------
-- 2. Ownership
-- ---------------------------------------------------------------------------

ALTER DATABASE :dbname OWNER TO examhub_migrator;

-- REQUIRED on PostgreSQL 15+. PUBLIC lost CREATE on `public`, so migrations run
-- as a non-superuser fail with "permission denied for schema public" until the
-- schema is owned by the role running them.
ALTER SCHEMA public OWNER TO examhub_migrator;

-- Existing tables were created by postgres. Hand them over, or the migrator
-- cannot ALTER them and the app's grants below are the only thing it has.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO examhub_migrator', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON DATABASE :dbname FROM PUBLIC;
REVOKE ALL ON SCHEMA   public  FROM PUBLIC;

GRANT CONNECT ON DATABASE :dbname TO examhub_app;
-- USAGE, never CREATE: the app may reach into the schema, not add to it.
GRANT USAGE   ON SCHEMA   public  TO examhub_app;

-- Covers tables that exist NOW. On an empty database this grants on nothing,
-- which is fine — the default privileges below are what cover the migration
-- that follows. This script must work in either order.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO examhub_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO examhub_app;

-- The line above just granted the app DELETE on Prisma's own bookkeeping. The
-- app has no business touching migration history; only the migrator does.
--
-- Guarded: on a fresh database Prisma has not created this table yet, and an
-- unconditional REVOKE aborts the script — leaving the default privileges below
-- unregistered, which is the silent failure this whole section exists to avoid.
--
-- But skipping it is not enough either: on a fresh database the migration then
-- CREATES the table, and the default privileges below hand the app full rights
-- to it. So provisioning must also be run (or this revoked) after the first
-- migration — which the verification block at the end now enforces rather than
-- trusting. See revoke_prisma_migrations() below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_prisma_migrations') THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM examhub_app;
  END IF;
END $$;

-- Tables created by FUTURE migrations. Without this, every new table is
-- invisible to the app until someone remembers to re-grant — and the failure
-- mode is a permission error in production, days after the migration merged.
--
-- Keyed to the CREATING role: if migrations ever run as anyone other than
-- examhub_migrator, new tables silently get no grants at all.
ALTER DEFAULT PRIVILEGES FOR ROLE examhub_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO examhub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE examhub_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO examhub_app;

-- ---------------------------------------------------------------------------
-- 4. Prove it worked, here, rather than trusting it did
-- ---------------------------------------------------------------------------

DO $$
DECLARE r record;
DECLARE ungranted text[];
BEGIN
  SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    INTO r FROM pg_roles WHERE rolname = 'examhub_app';

  -- The APP role, unlike the migrator, gets none of these. rolbypassrls is the
  -- one that matters most: with it, every policy in the database is ignored and
  -- any future RLS work is decorative.
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole THEN
    RAISE EXCEPTION 'examhub_app still holds a privilege it must not have: super=% bypassrls=% createdb=% createrole=%',
      r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole;
  END IF;

  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'examhub_migrator';
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION 'examhub_migrator must not be a superuser or bypass RLS (super=%, bypassrls=%)',
      r.rolsuper, r.rolbypassrls;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_tables
     WHERE schemaname = 'public' AND tableowner = 'examhub_app'
  ) THEN
    -- A table's OWNER bypasses RLS regardless of NOBYPASSRLS, so this would
    -- quietly undo the whole point the moment policies land.
    RAISE EXCEPTION 'examhub_app owns tables; it must own nothing';
  END IF;

  -- The default privileges must be REGISTERED, not merely executed.
  --
  -- This check exists because the statement silently no-ops in some orderings
  -- and psql reports success either way. The consequence is invisible until a
  -- migration months later adds a table the app cannot read — in production,
  -- long after the change that caused it. Verified by asking the catalogue.
  IF NOT EXISTS (
    SELECT 1 FROM pg_default_acl d
     WHERE pg_get_userbyid(d.defaclrole) = 'examhub_migrator'
       AND d.defaclobjtype = 'r'
       AND array_to_string(d.defaclacl, ',') LIKE '%examhub_app=%'
  ) THEN
    RAISE EXCEPTION
      'default privileges for examhub_migrator did not register — tables from future migrations would be unreadable by examhub_app. Re-run the ALTER DEFAULT PRIVILEGES statements as examhub_migrator.';
  END IF;

  -- Every existing table must actually be granted. Belt and braces over
  -- GRANT ON ALL TABLES, which covers only what exists at the moment it runs.
  SELECT array_agg(c.relname ORDER BY c.relname) INTO ungranted
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND c.relname <> '_prisma_migrations'
     AND NOT has_table_privilege('examhub_app', c.oid, 'SELECT');

  IF ungranted IS NOT NULL THEN
    RAISE EXCEPTION 'examhub_app cannot SELECT these tables: %', ungranted;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public') THEN
    -- Provisioned ahead of the first migration. Legitimate, and the default
    -- privileges above are what make it safe — they are verified registered, so
    -- the tables the migration creates will be reachable.
    RAISE WARNING 'Schema is empty. Run migrations, then RUN THIS SCRIPT AGAIN — the second pass revokes the app''s access to _prisma_migrations, which does not exist yet.';
    RAISE NOTICE 'examhub_app: NOSUPERUSER, NOBYPASSRLS, owns nothing, default privileges registered. OK so far.';
  ELSE
    -- Enforced, not assumed. On a fresh database the first pass cannot revoke a
    -- table Prisma has not created, and the default privileges then grant the
    -- app full rights to it the moment the migration runs. Only a second pass
    -- closes that, so refuse to report success until it has happened.
    IF has_table_privilege('examhub_app', '_prisma_migrations', 'SELECT') THEN
      RAISE EXCEPTION
        'examhub_app can read _prisma_migrations. If this database was provisioned before its first migration, simply run this script once more.';
    END IF;

    RAISE NOTICE 'examhub_app: NOSUPERUSER, NOBYPASSRLS, owns nothing, can reach every table except _prisma_migrations, and future migrations are covered. OK.';
  END IF;
END $$;
