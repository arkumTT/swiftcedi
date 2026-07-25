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

# 4. Run migrations (creates schema + seeds roles/permissions/HQ branch)
npm run migrate

# 5. Bootstrap the first system_admin user (RBAC endpoints require an
#    authenticated admin to create further users)
SEED_ADMIN_EMAIL=admin@swiftcedi.local SEED_ADMIN_PASSWORD='ChangeMe123!' npm run seed:admin

# 6. Run the API
npm run dev
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
