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
- A PostgreSQL 15+ instance

There is no `docker-compose.yml` — point `DATABASE_URL` at any Postgres you have. The test suite does not need one: it downloads and runs a real PostgreSQL 15 binary via `embedded-postgres`.

### Setup

No Postgres installed? `npm run dev:db` downloads and runs one — no Docker, no install.

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL and JWT_SECRET

npm run dev:db            # terminal 1 — starts PostgreSQL, prints the DATABASE_URL
npm run db:migrate        # terminal 2 — create the tables
npm run db:seed           # outlets, departments, designations
npm run dev               # start the API on http://localhost:4000
```

The database must be **UTF8**. Hindi and Gujarati content (§6) cannot be stored
in a single-byte encoding, and the API refuses to boot against one. `dev:db`
handles this; for a real database, create it explicitly:

```sql
CREATE DATABASE bookends WITH ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
```

### What you can see today

**There is no user interface yet** — the admin panel (React) and the staff
Android app are not built. The API answers JSON:

```bash
curl http://localhost:4000/api/v1/health

# Log in as the seeded super admin, then change the password it forces (§7.3)
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","password":"..."}'
```

Seed a super admin first with `SEED_ADMIN_PHONE` and `SEED_ADMIN_PASSWORD`
(see below). Every other endpoint needs that token.

### Other commands

```bash
npm test                  # full suite — no Docker, no Redis required
npm run lint
npm run build
npm run db:studio         # browse the database in a GUI
```

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
