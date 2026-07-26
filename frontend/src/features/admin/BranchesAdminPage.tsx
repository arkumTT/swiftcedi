import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses } from '../../components/FormField';
import { api, ApiError } from '../../lib/apiClient';
import type { Branch } from '../../types/api';

const STATUS_TRANSITIONS: Record<string, string[]> = {
  active: ['suspended', 'under_review'],
  suspended: ['active', 'under_review', 'closed'],
  under_review: ['active', 'suspended', 'closed'],
  closed: [],
};

export function BranchesAdminPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const branchesQuery = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/branches/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['branches'] }),
  });

  const columns: Column<Branch>[] = [
    {
      key: 'name',
      header: 'Branch',
      render: (b) => (
        <div>
          <p className="font-medium">{b.name}</p>
          <p className="text-[12px] text-text-secondary">{b.code}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Branches"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New branch
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={columns}
          rows={branchesQuery.data ?? []}
          getRowKey={(b) => b.id}
          isLoading={branchesQuery.isLoading}
          error={branchesQuery.error instanceof ApiError ? branchesQuery.error.message : null}
          onRetry={() => branchesQuery.refetch()}
          emptyTitle="No branches yet — create the first one"
          rowActions={(b) => (
            <div className="flex justify-end gap-1.5">
              {(STATUS_TRANSITIONS[b.status] ?? []).map((next) => (
                <Button
                  key={next}
                  variant={next === 'closed' ? 'danger' : 'secondary'}
                  size="sm"
                  onClick={() => statusMutation.mutate({ id: b.id, status: next })}
                >
                  {next.replace(/_/g, ' ')}
                </Button>
              ))}
            </div>
          )}
        />
      </Card>
      <CreateBranchModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['branches'] })} />
    </div>
  );
}

function CreateBranchModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [openingFloat, setOpeningFloat] = useState('0');
  const [dailyLimit, setDailyLimit] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/branches', {
        code,
        name,
        openingFloatPesewas: Math.round(Number(openingFloat) * 100),
        dailyCashLimitPesewas: Math.round(Number(dailyLimit) * 100),
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      setCode('');
      setName('');
      setOpeningFloat('0');
      setDailyLimit('0');
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create branch'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New branch"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create branch
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Branch code" hint="Immutable once created.">
          {(id) => <input id={id} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={inputClasses} />}
        </FormField>
        <FormField label="Branch name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Opening float (GHS)">
          {(id) => <input id={id} type="number" min="0" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Daily cash limit (GHS)">
          {(id) => <input id={id} type="number" min="0" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} className={inputClasses} />}
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
