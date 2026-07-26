import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, HandCoins, DoorClosed } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KpiCard } from '../../../components/KpiCard';
import { FormField, inputClasses } from '../../../components/FormField';
import { ErrorState } from '../../../components/ErrorState';
import { formatDateTime, formatGhs, parseGhsInput } from '../../../lib/format';
import type { CashierTill, CashBackRequest } from '../../../types/api';

export function TillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [cashBackOpen, setCashBackOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [settleId, setSettleId] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['cashier-till', id] });
    queryClient.invalidateQueries({ queryKey: ['cashback-requests', id] });
  };

  const tillQuery = useQuery({ queryKey: ['cashier-till', id], queryFn: () => api.get<CashierTill>(`/cashier/tills/${id}`), enabled: Boolean(id) });
  const till = tillQuery.data;
  const cashBackQuery = useQuery({
    queryKey: ['cashback-requests', id],
    queryFn: () => api.get<CashBackRequest[]>(`/cashier/tills/${id}/cashback-requests`),
    enabled: Boolean(id),
  });

  const settleMutation = useMutation({
    mutationFn: (cashBackRequestId: string) => api.post(`/cashier/cashback-requests/${cashBackRequestId}/settle`),
    onSuccess: invalidate,
  });

  if (tillQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading till…</p>;
  if (tillQuery.error || !till) {
    return <ErrorState message={tillQuery.error instanceof ApiError ? tillQuery.error.message : 'Unable to load this till'} onRetry={() => tillQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === till.branch_id)?.name ?? till.branch_id;

  const columns: Column<CashBackRequest>[] = [
    { key: 'id', header: 'Request', render: (r) => `#${r.id}` },
    { key: 'amount', header: 'Amount', render: (r) => formatGhs(r.amount_pesewas), align: 'right' },
    { key: 'threshold', header: 'Needs approval', render: (r) => (r.threshold_flag ? 'Yes' : 'No') },
    { key: 'requested', header: 'Requested', render: (r) => formatDateTime(r.created_at) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/cashier')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to cashier & vault
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">Till #{till.id}</h1>
              <StatusBadge status={till.status} />
            </div>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              {branchName} · Cashier #{till.cashier_id}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('cashier.request_cashback') && till.status === 'open' && (
              <Button variant="secondary" size="sm" onClick={() => setCashBackOpen(true)}>
                <HandCoins size={14} /> Request cash-back
              </Button>
            )}
            {hasPermission('cashier.till_close') && till.status === 'open' && (
              <Button variant="primary" size="sm" onClick={() => setCloseOpen(true)}>
                <DoorClosed size={14} /> Close till
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <KpiCard label="Opening float" value={formatGhs(till.opening_balance_pesewas)} />
        <KpiCard label="Closing balance" value={till.closing_balance_pesewas != null ? formatGhs(till.closing_balance_pesewas) : '—'} />
        <KpiCard label="Expected closing" value={till.expected_closing_balance_pesewas != null ? formatGhs(till.expected_closing_balance_pesewas) : '—'} />
        <KpiCard label="Variance" value={till.variance_pesewas != null ? formatGhs(till.variance_pesewas) : '—'} higherIsBetter={false} />
      </div>

      <Card title="Cash-back requests" padded={false}>
        <DataTable
          columns={columns}
          rows={cashBackQuery.data ?? []}
          getRowKey={(r) => r.id}
          isLoading={cashBackQuery.isLoading}
          emptyTitle="No cash-back requests for this till"
          rowActions={
            hasPermission('cashier.request_cashback')
              ? (r) =>
                  r.status === 'pending' && (
                    <Button variant="secondary" size="sm" disabled={settleMutation.isPending} onClick={() => setSettleId(r.id)}>
                      Settle
                    </Button>
                  )
              : undefined
          }
        />
      </Card>

      <RequestCashBackModal open={cashBackOpen} onClose={() => setCashBackOpen(false)} tillId={till.id} onSaved={invalidate} />
      <CloseTillModal open={closeOpen} onClose={() => setCloseOpen(false)} tillId={till.id} onSaved={invalidate} />
      {settleId && (
        <ConfirmSettleModal
          open={settleId !== null}
          onClose={() => setSettleId(null)}
          onConfirm={() => {
            settleMutation.mutate(settleId);
            setSettleId(null);
          }}
        />
      )}
    </div>
  );
}

function RequestCashBackModal({ open, onClose, tillId, onSaved }: { open: boolean; onClose: () => void; tillId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ paidOut: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post<{ paidOut: boolean }>(`/cashier/tills/${tillId}/cashback-requests`, { amountPesewas: parseGhsInput(amount) }),
    onSuccess: (res) => {
      onSaved();
      setSubmitted(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to request cash-back'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setAmount('');
        setSubmitted(null);
        setError(null);
      }}
      title="Request cash-back from vault"
      footer={
        submitted ? (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={mutation.isPending || !amount} onClick={() => mutation.mutate()}>
              Request
            </Button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-[13px] text-text-secondary">
          {submitted.paidOut ? 'Below the approval threshold — paid out immediately from the vault.' : 'Above the approval threshold — queued for maker-checker approval before settlement.'}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="Amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}</FormField>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function CloseTillModal({ open, onClose, tillId, onSaved }: { open: boolean; onClose: () => void; tillId: string; onSaved: () => void }) {
  const [closingBalance, setClosingBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/cashier/tills/${tillId}/close`, { closingBalancePesewas: parseGhsInput(closingBalance) }),
    onSuccess: () => {
      onSaved();
      onClose();
      setClosingBalance('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to close till'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close till"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !closingBalance} onClick={() => mutation.mutate()}>
            Close till
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Counted closing balance (GH₵)" hint="The actual physical cash count in the drawer.">
          {(id) => <input id={id} type="number" step="0.01" value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} className={inputClasses} />}
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

function ConfirmSettleModal({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settle cash-back request"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            Settle
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-text-secondary">
        If this request is above the approval threshold, it must already be approved — settling here will fail otherwise.
      </p>
    </Modal>
  );
}
