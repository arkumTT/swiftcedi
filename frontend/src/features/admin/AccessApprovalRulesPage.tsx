import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../components/FormField';
import { formatGhs } from '../../lib/format';
import { useRoles, useBranches } from '../../lib/adminHooks';
import { api, ApiError } from '../../lib/apiClient';

interface ThresholdRow {
  id: string;
  action_type: string;
  branch_id: string | null;
  amount_threshold_pesewas: string;
  required_approver_role_name: string;
}

export function AccessApprovalRulesPage() {
  const queryClient = useQueryClient();
  const { data: roles } = useRoles();
  const { data: branches } = useBranches();
  const [createOpen, setCreateOpen] = useState(false);

  const thresholdsQuery = useQuery({
    queryKey: ['approval-thresholds'],
    queryFn: () => api.get<ThresholdRow[]>('/approvals/thresholds'),
  });

  const branchName = (id: string | null) => (id ? branches?.find((b) => b.id === id)?.name ?? `#${id}` : 'All branches');

  const columns: Column<ThresholdRow>[] = [
    { key: 'action', header: 'Action type', render: (t) => <span className="font-mono text-[12.5px]">{t.action_type}</span> },
    { key: 'branch', header: 'Scope', render: (t) => branchName(t.branch_id) },
    { key: 'threshold', header: 'Threshold', align: 'right', render: (t) => <span className="tabular-nums">{formatGhs(t.amount_threshold_pesewas)}</span> },
    { key: 'approver', header: 'Required approver role', render: (t) => <span className="capitalize">{t.required_approver_role_name.replace(/_/g, ' ')}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Maker-checker thresholds"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> Set threshold
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={columns}
          rows={thresholdsQuery.data ?? []}
          getRowKey={(t) => t.id}
          isLoading={thresholdsQuery.isLoading}
          error={thresholdsQuery.error instanceof ApiError ? thresholdsQuery.error.message : null}
          onRetry={() => thresholdsQuery.refetch()}
          emptyTitle="No thresholds configured yet"
          emptyDescription="Above-threshold amounts require dual-control approval; anything unconfigured uses whichever module's own default gate applies."
        />
      </Card>

      <ThresholdModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        roles={roles ?? []}
        branches={branches ?? []}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['approval-thresholds'] })}
      />
    </div>
  );
}

function ThresholdModal({
  open,
  onClose,
  roles,
  branches,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  roles: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [actionType, setActionType] = useState('');
  const [branchId, setBranchId] = useState('');
  const [amount, setAmount] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/approvals/thresholds', {
        actionType,
        branchId: branchId || null,
        amountThresholdPesewas: Math.round(Number(amount) * 100),
        requiredApproverRoleId: roleId,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
      setActionType('');
      setBranchId('');
      setAmount('');
      setRoleId('');
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save threshold'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set a maker-checker threshold"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Action type" hint="e.g. loan.disburse, savings.withdraw, gl.request_manual_jv">
          {(id) => <input id={id} value={actionType} onChange={(e) => setActionType(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Branch scope" hint="Leave unset to apply org-wide; a branch-specific row overrides it.">
          {(id) => (
            <select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Amount threshold (GHS)">
          {(id) => <input id={id} type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Required approver role">
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
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
