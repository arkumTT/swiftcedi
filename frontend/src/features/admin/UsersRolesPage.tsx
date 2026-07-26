import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { FilterToolbar } from '../../components/FilterToolbar';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../components/FormField';
import { formatDateTime } from '../../lib/format';
import { useRoles, useBranches } from '../../lib/adminHooks';
import { api, ApiError } from '../../lib/apiClient';
import type { AdminUserRow } from '../../types/api';

export function UsersRolesPage() {
  const queryClient = useQueryClient();
  const { data: roles } = useRoles();
  const { data: branches } = useBranches();

  const [search, setSearch] = useState('');
  const [roleId, setRoleId] = useState('');
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['admin-users', { search, roleId, status }],
    queryFn: () => api.get<AdminUserRow[]>('/rbac/users', { search, roleId, status }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ userId, newStatus }: { userId: string; newStatus: string }) =>
      api.patch(`/rbac/users/${userId}/status`, { status: newStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const columns: Column<AdminUserRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (u) => (
        <div>
          <p className="font-medium">{u.full_name}</p>
          <p className="text-[12px] text-text-secondary">{u.email}</p>
        </div>
      ),
    },
    { key: 'role', header: 'Role', render: (u) => <span className="capitalize">{u.role_name.replace(/_/g, ' ')}</span> },
    { key: 'branch', header: 'Branch', render: (u) => u.home_branch_name },
    { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    { key: 'lastLogin', header: 'Last login', render: (u) => formatDateTime(u.last_login_at) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Users & Roles"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New user
          </Button>
        }
        padded={false}
      >
        <FilterToolbar search={{ value: search, onChange: setSearch, placeholder: 'Search name or email…' }}>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All roles</option>
            {roles?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="disabled">Disabled</option>
          </select>
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={usersQuery.data ?? []}
          getRowKey={(u) => u.id}
          isLoading={usersQuery.isLoading}
          error={usersQuery.error instanceof ApiError ? usersQuery.error.message : null}
          onRetry={() => usersQuery.refetch()}
          emptyTitle="No staff accounts match these filters"
          rowActions={(u) => (
            <div className="flex justify-end gap-1.5">
              {u.status !== 'active' && (
                <Button variant="secondary" size="sm" onClick={() => statusMutation.mutate({ userId: u.id, newStatus: 'active' })}>
                  Reactivate
                </Button>
              )}
              {u.status === 'active' && (
                <Button variant="secondary" size="sm" onClick={() => statusMutation.mutate({ userId: u.id, newStatus: 'suspended' })}>
                  Suspend
                </Button>
              )}
              {u.status !== 'disabled' && (
                <Button variant="danger" size="sm" onClick={() => statusMutation.mutate({ userId: u.id, newStatus: 'disabled' })}>
                  Disable
                </Button>
              )}
            </div>
          )}
        />
      </Card>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        roles={roles ?? []}
        branches={branches ?? []}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['admin-users'] })}
      />
    </div>
  );
}

interface CreateUserModalProps {
  open: boolean;
  onClose: () => void;
  roles: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  onCreated: () => void;
}

function CreateUserModal({ open, onClose, roles, branches, onCreated }: CreateUserModalProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [homeBranchId, setHomeBranchId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/rbac/users', { fullName, email, password, roleId, homeBranchId }),
    onSuccess: () => {
      onCreated();
      onClose();
      setFullName('');
      setEmail('');
      setPassword('');
      setRoleId('');
      setHomeBranchId('');
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create user'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New staff account"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* The design spec's "one-time invite link" flow isn't backed by
            real infrastructure (no invite-token table/email delivery) —
            this sets a real initial password directly, same as the
            existing seed-admin script, rather than faking an email step. */}
        <FormField label="Full name">{(id) => <input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Initial password" hint="Share this with the new user out of band; they should change it on first login.">
          {(id) => <input id={id} type="text" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Role">
          {(id) => (
            <select id={id} value={roleId} onChange={(e) => setRoleId(e.target.value)} className={selectClasses}>
              <option value="">Select a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Home branch">
          {(id) => (
            <select id={id} value={homeBranchId} onChange={(e) => setHomeBranchId(e.target.value)} className={selectClasses}>
              <option value="">Select a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
