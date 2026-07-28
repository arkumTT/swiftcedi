# SwiftCedi Backend

Node.js/Express + PostgreSQL API. This milestone builds Module 11
(RBAC/Audit) and Module 7 (GL) as shared infrastructure — see
`../Decisions_Log.md` for the settled table names, status enums, and
service signatures every later module must build against.

## Local setup

```bash
# 1. Postgres: either run the repo-root docker-compose, or point at your own instance.
docker compose -f ../docker-compose.yml up -d

# 2. Install deps
npm install

# 3. Configure env
cp .env.example .env
# .env's DATABASE_URL/TEST_DATABASE_URL already match the docker-compose defaults
# Add SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD here too if you want step 4 below
# to bootstrap your first login automatically (see "Bootstrapping the first
# admin user" below) — safe to leave unset for now and add later.

# 4. Run the API — this also runs migrations and (if SEED_ADMIN_PASSWORD is
#    set) bootstraps the first system_admin user automatically first
npm run dev
```

## Bootstrapping the first admin user

RBAC endpoints require an authenticated `system_admin`/`owner` user to create
further users, so something has to create the very first one. `npm run dev`
and `npm start` both run `src/db/seedAdmin.js` automatically before starting
the server (via `predev`/`prestart`) — it's idempotent (no-ops if the email
already exists) and skips itself with a log line, rather than crashing the
server, if `SEED_ADMIN_PASSWORD` isn't set.

Set it either in `.env` or inline:

```bash
SEED_ADMIN_EMAIL=admin@swiftcedi.local SEED_ADMIN_PASSWORD='ChangeMe123!' npm run dev
```

Or run it standalone at any time (e.g. against a deployed database) without
starting the server:

```bash
SEED_ADMIN_EMAIL=admin@swiftcedi.local SEED_ADMIN_PASSWORD='ChangeMe123!' npm run seed:admin
```

## Tests

```bash
npm test
```

Runs two suites:
- `tests/unit` — pure business-logic tests (balanced-entry validation,
  maker-checker enforcement, threshold routing) with a mocked db, no
  Postgres required.
- `tests/integration` — exercises the actual database triggers/constraints
  (deferred balance check, audit_log immutability, maker-checker CHECK
  constraint) against `TEST_DATABASE_URL`. Skipped automatically if that
  env var isn't set.

## Shared services (Module 11 / Module 7)

Every other module calls into these instead of writing to the underlying
tables directly:

- `src/shared/auditLog.js` — the only writer to `audit_log` (DB-enforced
  immutable/append-only).
- `src/shared/approvalWorkflow.js` — maker-checker approval requests
  (DB-enforced: approver can never equal requester).
- `src/shared/glPosting.js` — the only writer to `gl_journal_entries` /
  `gl_journal_lines` (DB-enforced: lines must balance at commit, immutable
  once posted; corrections are a new reversing entry).

See `Decisions_Log.md` at the repo root for exact signatures.

## Auth note

Login/session handling (`src/middleware/sessionStore.js`) is an in-memory
placeholder for this milestone — tokens don't survive a process restart and
aren't shared across instances. It's flagged in `Decisions_Log.md` under
Open Questions for a follow-up session to replace with a real
JWT/persisted-session mechanism before this goes anywhere near production.
