# Bookends Hospitality — Staff Performance & Examination Portal

A staff performance management platform for Bookends Hospitality's restaurant outlets in Gujarat, India — **Aiko** (Japanese/Asian), **Capiche** (Italian), and **Prep** — covering roughly 300 employees.

It is not only an exam portal. Monthly examinations are the input; the product is the performance record that comes out — individual growth over time, outlet and department comparisons, targeted training for people who are struggling, and recognition for people who aren't.

> **Status: early.** The database foundation is built and verified. The API is in progress. Sections marked _planned_ are not built yet.

## What it does

- **Monthly exams, scheduled automatically** on the 15th, shifting to the next Monday when the 15th lands on a weekend
- **Three question types** — multiple choice (auto-graded), theory (manually graded), and video/image responses graded against a rubric
- **Trilingual throughout** — every staff-facing string exists in English, Hindi, and Gujarati, falling back Gujarati → Hindi → English
- **Performance tracking** — monthly snapshots, topic-level breakdowns, outlet/department/overall ranking, month-over-month deltas
- **Training recommendations** driven by weak topic scores
- **Certificates, rewards, and leaderboards**
- Staff take exams on an **Android app**; management uses a **web admin panel**

## Roles

Six roles with scoped permissions (see §3.2 of the spec for the full matrix):

| Role           | Scope                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| Super Admin    | Everything, including role management and audit logs                      |
| Admin          | Everything except role management — the operations team                   |
| Outlet Manager | Their own outlet's employees, questions, exams, and reports               |
| Trainer        | Authors questions (edits only their own), grades theory and video answers |
| HR             | Employee records and reports across all outlets                           |
| Staff          | Takes exams, views only their own results and performance                 |

Permissions are not a flat role check — many are scoped to "own outlet" or "own resource", enforced at the data layer rather than the route.

## Tech stack

| Layer     | Choice                                                      |
| --------- | ----------------------------------------------------------- |
| API       | Node.js 22+, Express 5, TypeScript (ESM)                    |
| Database  | PostgreSQL 15+ via Prisma                                   |
| Auth      | JWT access tokens (15 min) + opaque refresh tokens (7 days) |
| Admin web | React 18 + Tailwind + shadcn/ui — _planned_                 |
| Staff app | Android APK — _planned_                                     |
| Queue     | BullMQ + Redis — _planned, arrives with auto-scheduling_    |

## Repository layout

```
packages/core/   @bookends/core — pure logic, zero I/O. Password hashing,
                 the RBAC permission matrix, API envelope types.
packages/db/     @bookends/db — Prisma schema, migrations, seed data.
apps/api/        @bookends/api — the Express API.
```

`packages/core` has no dependencies on the other two on purpose: the seed in `packages/db` must produce a password hash the API can verify, so the hasher cannot live in `apps/api` without creating a dependency cycle.

## Getting started

### Prerequisites

- Node.js 22+ (see `.nvmrc`)
- A Supabase project (or any PostgreSQL 15+ you can reach)

There is no `docker-compose.yml` and no local database to start. Development runs against hosted Postgres, so `npm run dev` is the only process you need.

The test suite is unaffected by any of this: it starts its own throwaway PostgreSQL on a random port and never touches Supabase. Tests need no credentials and no network.

### Setup

```bash
npm install
cp .env.example .env      # then fill in the two database URLs and JWT_SECRET
npm run build
```

Both database URLs come from the Supabase dashboard, under **Project Settings → Database → Connection string**. They are different endpoints and both are needed:

| Variable       | Port         | Used by                                  |
| -------------- | ------------ | ---------------------------------------- |
| `DATABASE_URL` | 6543, pooled | the API's own traffic                    |
| `DIRECT_URL`   | 5432, direct | `prisma migrate`, `introspect`, `studio` |

Keep `?pgbouncer=true` on `DATABASE_URL` — it stops Prisma emitting prepared statements, which transaction-mode pooling cannot support. Do not add `connection_limit=1`; that is a serverless setting and this API is a long-lived process. If the password contains `@ : / ?`, URL-encode it.

`.env` is read through Node's built-in `--env-file`, so there is no `dotenv` dependency. Generate a signing secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Running

Once, to prepare the database:

```bash
npm run db:deploy         # applies migrations
npm run db:seed           # loads outlets, departments, designations
```

Then, in a single terminal:

```bash
npm run dev               # API + web panel together
```

That starts both, prefixing their output `[api]` and `[web]`. Open the link Vite
prints — **http://localhost:5173** — which proxies `/api` to the API on 4000.
Ctrl-C once stops both, and if the API fails to boot the web server stops with
it rather than serving a panel that 500s on every request.

To run just one:

```bash
npm run dev:api
npm run dev:web
```

```bash
npm test                  # full suite — no Docker, no Redis, no Supabase
npm run lint
```

#### Where tests get their database

`npm test` needs a real PostgreSQL, and finds one in this order:

1. **`TEST_DATABASE_SERVER_URL`**, if you set it — a throwaway database is created there.
2. **Embedded PostgreSQL** — a real binary downloaded and run on a random port. The default, and what CI uses.
3. **Your `DIRECT_URL` server** — a throwaway `bookends_test_*` database, dropped afterwards.

The third exists because PostgreSQL **refuses to run as Administrator**, so the
embedded server cannot start in an elevated terminal — a common way to work on
Windows. Rather than making `npm test` depend on which terminal you opened, it
falls back to a server you already run. The run prints which one it used.

Your development database is never touched: the fallback always creates a
separate database and refuses to proceed if the name it generates is not a fresh
`bookends_test_*` one.

### Writing a migration

`npm run db:deploy` (`prisma migrate deploy`) applies existing migrations and is what you want against Supabase.

Authoring a _new_ migration is different: `prisma migrate dev` needs a shadow database that it creates and drops itself, and Supabase does not grant `CREATE DATABASE`. Point `SHADOW_DATABASE_URL` at a throwaway PostgreSQL you control, then run `npm run db:migrate`.

### Seeding a first admin

The seed creates a super admin only when both variables are set:

```bash
SEED_ADMIN_PHONE=9876543210 SEED_ADMIN_PASSWORD='...' npm run db:seed
```

The account is created with `must_change_password = true`, so the first login forces a password change.

## Project conventions

- **Feature-first, not layered.** A module's routes, schemas, service, and tests live together under `apps/api/src/<feature>/`, rather than being scattered across global `routes/`, `controllers/`, and `services/` directories.
- **`app.ts` builds; `main.ts` listens.** `buildApp(deps)` never binds a port, so tests drive the real middleware chain over supertest.
- **Trilingual columns** follow `<field>_en` (required) / `<field>_hi` / `<field>_gu` (both nullable). Language fallback happens in the API layer, never in the database.
- **Tests run against real PostgreSQL**, not a mock. The schema leans on `INET`, `JSONB`, `TEXT[]`, partial indexes, and CHECK constraints; anything less would be testing a different database than production.

## Contributing

Branch off `main`, keep commits scoped, and open a pull request describing what changed and how you verified it.

## License

Not yet specified.
