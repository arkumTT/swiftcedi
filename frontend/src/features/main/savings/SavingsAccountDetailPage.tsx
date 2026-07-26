import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowDownToLine, ArrowUpFromLine, Receipt, Ban } from 'lucide-react';
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
import type { SavingsAccount, SavingsStatement, AccountReconciliation, Customer } from '../../../types/api';

export function SavingsAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['savings-account', id] });
    queryClient.invalidateQueries({ queryKey: ['savings-statement', id] });
    queryClient.invalidateQueries({ queryKey: ['savings-reconciliation', id] });
  };

  const accountQuery = useQuery({ queryKey: ['savings-account', id], queryFn: () => api.get<SavingsAccount>(`/savings/${id}`), enabled: Boolean(id) });
  const account = accountQuery.data;
  const customerQuery = useQuery({
    queryKey: ['customer', account?.customer_id],
    queryFn: () => api.get<Customer>(`/customers/${account!.customer_id}`),
    enabled: Boolean(account),
  });
  const statementQuery = useQuery({ queryKey: ['savings-statement', id], queryFn: () => api.get<SavingsStatement>(`/savings/${id}/statement`), enabled: Boolean(id) });
  const reconciliationQuery = useQuery({
    queryKey: ['savings-reconciliation', id],
    queryFn: () => api.get<AccountReconciliation>(`/savings/${id}/reconciliation`),
    enabled: Boolean(id),
  });

  if (accountQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading account…</p>;
  if (accountQuery.error || !account) {
    return <ErrorState message={accountQuery.error instanceof ApiError ? accountQuery.error.message : 'Unable to load this account'} onRetry={() => accountQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === account.branch_id)?.name ?? account.branch_id;

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
              · {branchName}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('savings.deposit') && account.status !== 'closed' && (
              <Button variant="primary" size="sm" onClick={() => setDepositOpen(true)}>
                <ArrowDownToLine size={14} /> Deposit
              </Button>
            )}
            {hasPermission('savings.withdraw') && account.status !== 'closed' && (
              <Button variant="secondary" size="sm" onClick={() => setWithdrawOpen(true)}>
                <ArrowUpFromLine size={14} /> Withdraw
              </Button>
            )}
            {hasPermission('savings.apply_charges') && account.status !== 'closed' && (
              <Button variant="secondary" size="sm" onClick={() => setChargesOpen(true)}>
                <Receipt size={14} /> Apply charges
              </Button>
            )}
            {hasPermission('savings.close_account') && account.status !== 'closed' && (
              <Button variant="danger" size="sm" onClick={() => setCloseOpen(true)}>
                <Ban size={14} /> Close account
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Balance" value={formatGhs(account.balance_pesewas)} />
        <KpiCard label="Ledger sum" value={formatGhs(reconciliationQuery.data?.ledgerSumPesewas)} />
        <KpiCard
          label="Reconciled"
          value={reconciliationQuery.data ? (reconciliationQuery.data.reconciled ? 'Yes' : 'No — variance') : '—'}
          higherIsBetter={reconciliationQuery.data?.reconciled ?? true}
        />
      </div>

      <Card title="Statement" padded={false}>
        <DataTable
          columns={
            [
              { key: 'date', header: 'Date', render: (t) => formatDateTime(t.created_at) },
              { key: 'type', header: 'Type', render: (t) => <span className="capitalize">{t.txn_type.replace(/_/g, ' ')}</span> },
              { key: 'description', header: 'Description', render: (t) => t.description ?? '—' },
              { key: 'amount', header: 'Amount', render: (t) => formatGhs(t.amount_pesewas), align: 'right' },
              { key: 'balance', header: 'Balance after', render: (t) => formatGhs(t.balance_after_pesewas), align: 'right' },
            ] as Column<SavingsStatement['transactions'][number]>[]
          }
          rows={statementQuery.data?.transactions ?? []}
          getRowKey={(t) => t.id}
          isLoading={statementQuery.isLoading}
          emptyTitle="No transactions yet"
        />
      </Card>

      <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} accountId={account.id} onSaved={invalidate} />
      <WithdrawModal open={withdrawOpen} onClose={() => setWithdrawOpen(false)} accountId={account.id} onSaved={invalidate} />
      <ChargesModal open={chargesOpen} onClose={() => setChargesOpen(false)} accountId={account.id} onSaved={invalidate} />
      <CloseAccountModal open={closeOpen} onClose={() => setCloseOpen(false)} accountId={account.id} onSaved={invalidate} />
    </div>
  );
}

function DepositModal({ open, onClose, accountId, onSaved }: { open: boolean; onClose: () => void; accountId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/savings/${accountId}/deposits`, { amountPesewas: parseGhsInput(amount), description: description || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
      setAmount('');
      setDescription('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to record deposit'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record deposit"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !amount} onClick={() => mutation.mutate()}>
            Deposit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Description">{(id) => <input id={id} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function WithdrawModal({ open, onClose, accountId, onSaved }: { open: boolean; onClose: () => void; accountId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ paidOut?: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post<{ paidOut?: boolean }>(`/savings/${accountId}/withdrawal-requests`, { amountPesewas: parseGhsInput(amount) }),
    onSuccess: (res) => {
      onSaved();
      setResult(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit withdrawal'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setAmount('');
        setResult(null);
        setError(null);
      }}
      title="Request withdrawal"
      footer={
        result ? (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={mutation.isPending || !amount} onClick={() => mutation.mutate()}>
              Submit
            </Button>
          </>
        )
      }
    >
      {result ? (
        <p className="text-[13px] text-text-secondary">
          {result.paidOut ? 'Below the approval threshold — paid out immediately.' : 'Above the approval threshold — queued for maker-checker approval before payout.'}
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

function ChargesModal({ open, onClose, accountId, onSaved }: { open: boolean; onClose: () => void; accountId: string; onSaved: () => void }) {
  const CHARGE_TYPES = ['maintenance_fee', 'withdrawal_fee', 'min_balance_charge'];
  const [selected, setSelected] = useState<string[]>(['maintenance_fee']);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/savings/${accountId}/charges`, { chargeTypes: selected }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to apply charges'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply charges"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || selected.length === 0} onClick={() => mutation.mutate()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {CHARGE_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-2 text-[13px] text-text-primary capitalize">
            <input
              type="checkbox"
              checked={selected.includes(type)}
              onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, type] : prev.filter((t) => t !== type)))}
            />
            {type.replace(/_/g, ' ')}
          </label>
        ))}
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function CloseAccountModal({ open, onClose, accountId, onSaved }: { open: boolean; onClose: () => void; accountId: string; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/savings/${accountId}/close`, { reason }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to close account'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close account"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={mutation.isPending || !reason} onClick={() => mutation.mutate()}>
            Close account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Reason">{(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
