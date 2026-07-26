# SwiftCedi Frontend

Two platforms sharing one design system (see `../SwiftCedi_UIUX_Design_Specification`-derived
tokens in `src/styles/tokens.css`), one React SPA, one route tree:

- **`/admin/*`** — Admin Back Office (Users & Roles, Roles & Permissions,
  Access & Approval Rules, Branches, Regulatory Templates, System Jobs &
  Scheduler, Audit Log, Backups & Data, System Health).
- **`/app/*`** — Main Banking Application (role-scoped dashboard, Customers &
  CRM, Loans & Credit, Savings & Susu, Investments, Cashier & Vault,
  Transactions, Branches, Field Agents, Reports & Analytics, Compliance &
  Regulatory).

Both are permission-gated from the same `GET /auth/me` response — a role
simply doesn't see nav items it lacks the permission for; the backend
enforces the same gate server-side on every route.

## Local setup

```bash
cp .env.example .env   # VITE_API_BASE_URL=/api is correct for local dev
npm install
npm run dev             # proxies /api/* to http://localhost:4000 (see vite.config.ts)
```

The backend (`../backend`) must be running and migrated — see
`../backend/README.md`.

## Stack

Vite + React 19 + TypeScript, Tailwind v4 (mapped onto the CSS custom-property
token system, not Tailwind's default palette), TanStack Query for server
state, React Router, Recharts for charts, lucide-react for icons.

## Conventions

- Every color is a token (`src/styles/tokens.css`) — never a hardcoded hex in
  a component. Light/dark is a single `data-theme` attribute flip.
- Money renders through `src/lib/format.ts`'s `formatGhs()` — never divide
  pesewas by 100 inline in a component.
- All list screens go through `src/components/DataTable.tsx` for the
  sticky-header/empty-state/error-state/row-action pattern to stay
  consistent across modules.
- See `../Decisions_Log.md` for the handful of backend endpoints added
  specifically to power this frontend (GET /auth/me, GET /rbac/users,
  GET /approvals, approval_thresholds CRUD, etc.).
