Banking management solution for transaction monitoring

SwiftCedi is a multi-branch microfinance banking management platform for a
licensed microfinance institution operating in Ghana. See `CLAUDE.md` for
the project's non-negotiable rules, `SwiftCedi_Module_Build_Prompts.md` for
the full module specs, and `Decisions_Log.md` for conventions actually
adopted during the build.

- `backend/` — Node.js/Express + PostgreSQL API. See `backend/README.md`
  for local setup. Module 11 (RBAC/Audit) and Module 7 (GL) are built as
  shared infrastructure first.
- `frontend/` — React app; not started yet (see `frontend/README.md`).

