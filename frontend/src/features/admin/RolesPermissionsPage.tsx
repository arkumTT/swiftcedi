import { Fragment } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { useRoles, usePermissions } from '../../lib/adminHooks';
import { api } from '../../lib/apiClient';

/**
 * A checkbox grid — roles as columns, permission codes as rows (Section
 * 6.3): "can this role disburse loans" is answered by looking at one cell.
 * Each cell toggle is a single grant/revoke call against the real
 * role_permissions join table, not a client-side simulation.
 */
export function RolesPermissionsPage() {
  const queryClient = useQueryClient();
  const { data: roles } = useRoles();
  const { data: permissions } = usePermissions();

  const grantedQueries = useQueries({
    queries: (roles ?? []).map((role) => ({
      queryKey: ['role-permissions', role.id],
      queryFn: () => api.get<string[]>(`/rbac/roles/${role.id}/permissions`),
      enabled: Boolean(roles),
    })),
  });

  if (!roles || !permissions) {
    return (
      <Card title="Roles & Permissions">
        <p className="text-[13px] text-text-secondary">Loading…</p>
      </Card>
    );
  }

  async function toggle(roleId: string, code: string, currentlyGranted: boolean) {
    if (currentlyGranted) {
      await api.delete(`/rbac/roles/${roleId}/permissions/${code}`);
    } else {
      await api.post(`/rbac/roles/${roleId}/permissions`, { permissionCode: code });
    }
    queryClient.invalidateQueries({ queryKey: ['role-permissions', roleId] });
  }

  // Group permission codes by module prefix (e.g. "loan.", "savings.") so the
  // matrix reads as sections rather than one flat 60+-row list.
  const groups = new Map<string, typeof permissions>();
  for (const p of permissions) {
    const prefix = p.code.split('.')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(p);
  }

  return (
    <Card title="Roles & Permissions" padded={false}>
      {roles.length === 0 || permissions.length === 0 ? (
        <EmptyState title="Nothing to configure yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="sticky top-0 bg-surface-alt">
                <th className="sticky left-0 z-10 min-w-[220px] border-b border-border bg-surface-alt px-3 py-2 text-left text-[11.5px] font-semibold uppercase text-text-secondary">
                  Permission
                </th>
                {roles.map((role) => (
                  <th key={role.id} className="border-b border-border px-3 py-2 text-center text-[11.5px] font-semibold whitespace-nowrap uppercase text-text-secondary">
                    {role.name.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([prefix, perms]) => (
                <Fragment key={prefix}>
                  <tr>
                    <td colSpan={roles.length + 1} className="bg-surface-alt px-3 py-1.5 text-[11px] font-semibold uppercase text-text-muted">
                      {prefix}
                    </td>
                  </tr>
                  {perms.map((perm) => (
                    <tr key={perm.code} className="border-b border-border">
                      <td className="sticky left-0 bg-surface px-3 py-1.5 text-text-primary">{perm.code}</td>
                      {roles.map((role, ri) => {
                        const granted = grantedQueries[ri]?.data?.includes(perm.code) ?? false;
                        return (
                          <td key={role.id} className="px-3 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => toggle(role.id, perm.code, granted)}
                              aria-pressed={granted}
                              aria-label={`${granted ? 'Revoke' : 'Grant'} ${perm.code} for ${role.name}`}
                              className={clsx(
                                'inline-flex size-5 items-center justify-center rounded border transition-colors',
                                granted ? 'border-success bg-success/15 text-success' : 'border-border text-transparent hover:border-accent'
                              )}
                            >
                              <Check size={13} />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
