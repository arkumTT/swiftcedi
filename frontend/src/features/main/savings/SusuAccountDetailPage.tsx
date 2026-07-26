import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, HandCoins, CheckCircle2, Banknote } from 'lucide-react';
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
import { formatBps, formatDate, formatGhs, parseGhsInput } from '../../../lib/format';
import type { SusuAccount, SusuCollection, Customer } from '../../../types/api';

export function SusuAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [collectOpen, setCollectOpen] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['susu-account', id] });
    queryClient.invalidateQueries({ queryKey: ['susu-collections', id] });
  };

  const accountQuery = useQuery({ queryKey: ['susu-account', id], queryFn: () => api.get<SusuAccount>(`/susu/${id}`), enabled: Boolean(id) });
  const account = accountQuery.data;
  const customerQuery = useQuery({
    queryKey: ['customer', account?.customer_id],
    queryFn: () => api.get<Customer>(`/customers/${account!.customer_id}`),
    enabled: Boolean(account),
  });
  const collectionsQuery = useQuery({
    queryKey: ['susu-collections', id],
    queryFn: () => api.get<SusuCollection[]>('/susu/collections', { susuAccountId: id }),
    enabled: Boolean(id) && hasPermission('susu.view'),
  });

  const completeCycleMutation = useMutation({
    mutationFn: () => api.post(`/susu/${id}/complete-cycle`),
    onSuccess: invalidate,
  });

  if (accountQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading susu account…</p>;
  if (accountQuery.error || !account) {
    return <ErrorState message={accountQuery.error instanceof ApiError ? accountQuery.error.message : 'Unable to load this account'} onRetry={() => accountQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === account.branch_id)?.name ?? account.branch_id;
  const progressRatio = Number(account.target_amount_pesewas) > 0 ? Number(account.collected_pesewas) / Number(account.target_amount_pesewas) : 0;

  const collectionColumns: Column<SusuCollection>[] = [
    { key: 'date', header: 'Date', render: (c) => formatDate(c.collection_date) },
    { key: 'agent', header: 'Agent', render: (c) => `#${c.agent_id}` },
    { key: 'amount', header: 'Amount', render: (c) => formatGhs(c.amount_pesewas), align: 'right' },
    { key: 'remitted', header: 'Remitted', render: (c) => (c.remittance_id ? <StatusBadge status="posted" label="Remitted" /> : <StatusBadge status="pending" label="With agent" />) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/savings')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to savings & susu
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">{account.account_no}</h1>
              <StatusBadge status={account.status} />
            </div>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              Customer{' '}
              <button type="button" onClick={() => navigate(`/app/customers/${account.customer_id}`)} className="text-primary underline">
                {customerQuery.data?.full_name ?? `#${account.customer_id}`}
              </button>{' '}
              · {branchName} · Commission {formatBps(account.commission_rate_bps)}
            </p>
            <p className="text-[13px] text-text-secondary">
              Cycle: {formatDate(account.cycle_start_date)} – {formatDate(account.cycle_end_date)} ({account.cycle_length_days} days)
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('susu.record_collection') && account.status === 'active' && (
              <Button variant="primary" size="sm" onClick={() => setCollectOpen(true)}>
                <HandCoins size={14} /> Record collection
              </Button>
            )}
            {hasPermission('susu.complete_cycle') && account.status === 'active' && (
              <Button variant="secondary" size="sm" disabled={completeCycleMutation.isPending} onClick={() => completeCycleMutation.mutate()}>
                <CheckCircle2 size={14} /> Complete cycle
              </Button>
            )}
            {hasPermission('susu.complete_cycle') && (account.status === 'completed' || account.status === 'uncompleted') && (
              <Button variant="secondary" size="sm" onClick={() => setPayoutOpen(true)}>
                <Banknote size={14} /> Pay out
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Collected" value={formatGhs(account.collected_pesewas)} />
        <KpiCard label="Target" value={formatGhs(account.target_amount_pesewas)} />
        <KpiCard label="Progress" value={`${(progressRatio * 100).toFixed(1)}%`} />
      </div>

      {hasPermission('susu.view') && (
        <Card title="Collections" padded={false}>
          <DataTable columns={collectionColumns} rows={collectionsQuery.data ?? []} getRowKey={(c) => c.id} isLoading={collectionsQuery.isLoading} emptyTitle="No collections recorded yet" />
        </Card>
      )}

      <RecordCollectionModal open={collectOpen} onClose={() => setCollectOpen(false)} susuAccountId={account.id} onSaved={invalidate} />
      <PayoutModal open={payoutOpen} onClose={() => setPayoutOpen(false)} susuAccountId={account.id} defaultPayoutAccountId={account.payout_savings_account_id} onSaved={invalidate} />
    </div>
  );
}

function RecordCollectionModal({ open, onClose, susuAccountId, onSaved }: { open: boolean; onClose: () => void; susuAccountId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [collectionDate, setCollectionDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/susu/${susuAccountId}/collections`, {
        amountPesewas: parseGhsInput(amount),
        idempotencyKey: crypto.randomUUID(),
        collectionDate: collectionDate || undefined,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
      setAmount('');
      setCollectionDate('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to record collection'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record susu collection"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !amount} onClick={() => mutation.mutate()}>
            Record
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Collection date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} className={inputClasses} />}
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

function PayoutModal({
  open,
  onClose,
  susuAccountId,
  defaultPayoutAccountId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  susuAccountId: string;
  defaultPayoutAccountId: string | null;
  onSaved: () => void;
}) {
  const [payoutSavingsAccountId, setPayoutSavingsAccountId] = useState(defaultPayoutAccountId ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/susu/${susuAccountId}/payout`, { payoutSavingsAccountId: payoutSavingsAccountId ? Number(payoutSavingsAccountId) : undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to pay out cycle'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pay out susu cycle"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !payoutSavingsAccountId} onClick={() => mutation.mutate()}>
            Pay out
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Payout savings account ID">
          {(id) => <input id={id} type="number" value={payoutSavingsAccountId} onChange={(e) => setPayoutSavingsAccountId(e.target.value)} className={inputClasses} />}
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
