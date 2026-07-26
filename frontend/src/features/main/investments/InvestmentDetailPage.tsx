import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, PlayCircle, TrendingUp, Banknote, DoorClosed } from 'lucide-react';
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
import { formatDate, formatGhs, parseGhsInput } from '../../../lib/format';
import type { Investment, InvestmentProduct, InvestorStatement, Customer } from '../../../types/api';

export function InvestmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [activateOpen, setActivateOpen] = useState(false);
  const [accrueOpen, setAccrueOpen] = useState(false);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [settlePayoutId, setSettlePayoutId] = useState<string | null>(null);
  const [confirmRedemption, setConfirmRedemption] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['investment', id] });
    queryClient.invalidateQueries({ queryKey: ['investment-statement', id] });
  };

  const investmentQuery = useQuery({ queryKey: ['investment', id], queryFn: () => api.get<Investment>(`/investments/${id}`), enabled: Boolean(id) });
  const investment = investmentQuery.data;
  const customerQuery = useQuery({
    queryKey: ['customer', investment?.customer_id],
    queryFn: () => api.get<Customer>(`/customers/${investment!.customer_id}`),
    enabled: Boolean(investment),
  });
  const productQuery = useQuery({
    queryKey: ['investment-product', investment?.product_id],
    queryFn: () => api.get<InvestmentProduct>(`/investments/products/${investment!.product_id}`),
    enabled: Boolean(investment),
  });
  const statementQuery = useQuery({
    queryKey: ['investment-statement', id],
    queryFn: () => api.get<InvestorStatement>(`/investments/${id}/statement`),
    enabled: Boolean(id) && hasPermission('investment.view'),
  });

  if (investmentQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading investment…</p>;
  if (investmentQuery.error || !investment) {
    return <ErrorState message={investmentQuery.error instanceof ApiError ? investmentQuery.error.message : 'Unable to load this investment'} onRetry={() => investmentQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === investment.branch_id)?.name ?? investment.branch_id;
  const statement = statementQuery.data;
  const pendingPayout = statement?.payouts.find((p) => p.status === 'pending');
  const redemption = statement?.redemption;

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/investments')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to investments
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">Investment #{investment.id}</h1>
              <StatusBadge status={investment.status} />
            </div>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              Customer{' '}
              <button type="button" onClick={() => navigate(`/app/customers/${investment.customer_id}`)} className="text-primary underline">
                {customerQuery.data?.full_name ?? `#${investment.customer_id}`}
              </button>{' '}
              · {branchName} · Product: {productQuery.data?.name ?? `#${investment.product_id}`}
            </p>
            <p className="text-[13px] text-text-secondary">
              {formatGhs(investment.principal_pesewas)} principal · {investment.tenor_months} months · maturity {formatDate(investment.maturity_date)}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('investment.activate') && investment.status === 'approved' && (
              <Button variant="primary" size="sm" onClick={() => setActivateOpen(true)}>
                <PlayCircle size={14} /> Activate
              </Button>
            )}
            {hasPermission('investment.accrue_interest') && investment.status === 'active' && (
              <Button variant="secondary" size="sm" onClick={() => setAccrueOpen(true)}>
                <TrendingUp size={14} /> Accrue interest
              </Button>
            )}
            {hasPermission('investment.request_payout') && investment.status === 'active' && productQuery.data?.payout_frequency === 'monthly' && (
              <Button variant="secondary" size="sm" onClick={() => setPayoutOpen(true)}>
                <Banknote size={14} /> Request payout
              </Button>
            )}
            {hasPermission('investment.request_redemption') && investment.status === 'active' && !redemption && (
              <Button variant="danger" size="sm" onClick={() => setRedeemOpen(true)}>
                <DoorClosed size={14} /> Request redemption
              </Button>
            )}
          </div>
        </div>
      </Card>

      {statement && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard label="Total accrued" value={formatGhs(statement.totalAccruedPesewas)} />
          <KpiCard label="Total paid out" value={formatGhs(statement.totalPaidOutPesewas)} />
          <KpiCard label="Current principal" value={formatGhs(investment.principal_pesewas)} />
        </div>
      )}

      {hasPermission('investment.view') && (
        <>
          <Card title="Interest accruals" padded={false}>
            <DataTable
              columns={
                [
                  { key: 'date', header: 'Date', render: (a) => formatDate(a.accrual_date) },
                  { key: 'principal', header: 'Principal balance', render: (a) => formatGhs(a.principal_balance_pesewas), align: 'right' },
                  { key: 'interest', header: 'Interest accrued', render: (a) => formatGhs(a.interest_pesewas), align: 'right' },
                ] as Column<InvestorStatement['accruals'][number]>[]
              }
              rows={statement?.accruals ?? []}
              getRowKey={(a) => a.id}
              isLoading={statementQuery.isLoading}
              emptyTitle="No interest accrued yet"
            />
          </Card>

          <Card title="Payouts" padded={false}>
            <DataTable
              columns={
                [
                  { key: 'date', header: 'Requested', render: (p) => formatDate(p.created_at) },
                  { key: 'amount', header: 'Amount', render: (p) => formatGhs(p.amount_pesewas), align: 'right' },
                  { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
                  { key: 'reference', header: 'Reference', render: (p) => p.payment_reference ?? '—' },
                ] as Column<InvestorStatement['payouts'][number]>[]
              }
              rows={statement?.payouts ?? []}
              getRowKey={(p) => p.id}
              isLoading={statementQuery.isLoading}
              emptyTitle="No payouts requested yet"
              rowActions={
                hasPermission('investment.request_payout')
                  ? (p) =>
                      p.status === 'pending' &&
                      !p.threshold_flag && (
                        <Button variant="secondary" size="sm" onClick={() => setSettlePayoutId(p.id)}>
                          Settle
                        </Button>
                      )
                  : undefined
              }
            />
            {pendingPayout?.threshold_flag && (
              <p className="px-4 pb-3 text-[12.5px] text-text-secondary">
                The pending payout is above the approval threshold — it must clear maker-checker approval before it can be settled here.
              </p>
            )}
          </Card>

          {redemption && (
            <Card title="Redemption">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard label="Accrued interest" value={formatGhs(redemption.accrued_interest_pesewas)} />
                <KpiCard label="Early penalty" value={formatGhs(redemption.penalty_pesewas)} higherIsBetter={false} />
                <KpiCard label="Interest payable" value={formatGhs(redemption.interest_payable_pesewas)} />
                <KpiCard label="Total payout" value={formatGhs(redemption.total_payout_pesewas)} />
              </div>
              <div className="mt-3 flex items-center gap-2">
                <StatusBadge status={redemption.status} />
                {redemption.is_early && <span className="text-[12.5px] text-text-secondary">Early redemption</span>}
                {hasPermission('investment.request_redemption') && redemption.status === 'pending' && (
                  <Button variant="secondary" size="sm" onClick={() => setConfirmRedemption(true)}>
                    Confirm payout
                  </Button>
                )}
              </div>
            </Card>
          )}
        </>
      )}

      <ActivateModal open={activateOpen} onClose={() => setActivateOpen(false)} investmentId={investment.id} onSaved={invalidate} />
      <AccrueInterestModal open={accrueOpen} onClose={() => setAccrueOpen(false)} investmentId={investment.id} onSaved={invalidate} />
      <RequestPayoutModal open={payoutOpen} onClose={() => setPayoutOpen(false)} investmentId={investment.id} onSaved={invalidate} />
      <RequestRedemptionModal open={redeemOpen} onClose={() => setRedeemOpen(false)} investmentId={investment.id} onSaved={invalidate} />
      <SettlePayoutModal open={settlePayoutId !== null} payoutId={settlePayoutId} onClose={() => setSettlePayoutId(null)} onSaved={invalidate} />
      <ConfirmRedemptionModal open={confirmRedemption} redemptionId={redemption?.id ?? null} onClose={() => setConfirmRedemption(false)} onSaved={invalidate} />
    </div>
  );
}

function ActivateModal({ open, onClose, investmentId, onSaved }: { open: boolean; onClose: () => void; investmentId: string; onSaved: () => void }) {
  const [startDate, setStartDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/${investmentId}/activate`, { startDate: startDate || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to activate investment'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Activate investment"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Activate
          </Button>
        </>
      }
    >
      <FormField label="Start date" hint="Defaults to today if left blank.">
        {(id) => <input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClasses} />}
      </FormField>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function AccrueInterestModal({ open, onClose, investmentId, onSaved }: { open: boolean; onClose: () => void; investmentId: string; onSaved: () => void }) {
  const [accrualDate, setAccrualDate] = useState('');
  const [days, setDays] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/${investmentId}/accrue-interest`, { accrualDate: accrualDate || undefined, days: Number(days) }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to accrue interest'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Accrue interest"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Accrue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Accrual date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={accrualDate} onChange={(e) => setAccrualDate(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Days">{(id) => <input id={id} type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function RequestPayoutModal({ open, onClose, investmentId, onSaved }: { open: boolean; onClose: () => void; investmentId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/${investmentId}/payout-requests`, { amountPesewas: parseGhsInput(amount) }),
    onSuccess: () => {
      onSaved();
      setSubmitted(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to request payout'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSubmitted(false);
        setAmount('');
      }}
      title="Request payout"
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
        <p className="text-[13px] text-text-secondary">Payout request submitted. It clears maker-checker approval if above the product's threshold, then can be settled from the Payouts list.</p>
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

function RequestRedemptionModal({ open, onClose, investmentId, onSaved }: { open: boolean; onClose: () => void; investmentId: string; onSaved: () => void }) {
  const [redemptionDate, setRedemptionDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/${investmentId}/redemption-requests`, { redemptionDate: redemptionDate || undefined }),
    onSuccess: () => {
      onSaved();
      setSubmitted(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to request redemption'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSubmitted(false);
        setRedemptionDate('');
      }}
      title="Request redemption"
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
            <Button variant="danger" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              Submit for approval
            </Button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-[13px] text-text-secondary">
          Redemption request submitted for maker-checker approval. An early redemption (before maturity) forfeits a penalty on accrued interest only — never on principal.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="Redemption date" hint="Defaults to today if left blank. Before maturity counts as early.">
            {(id) => <input id={id} type="date" value={redemptionDate} onChange={(e) => setRedemptionDate(e.target.value)} className={inputClasses} />}
          </FormField>
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

function SettlePayoutModal({ open, payoutId, onClose, onSaved }: { open: boolean; payoutId: string | null; onClose: () => void; onSaved: () => void }) {
  const [paymentReference, setPaymentReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/payout-requests/${payoutId}/settle`, { paymentReference }),
    onSuccess: () => {
      onSaved();
      onClose();
      setPaymentReference('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to settle payout'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settle payout"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !paymentReference} onClick={() => mutation.mutate()}>
            Settle
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Payment reference" hint="MoMo/bank reference or cashier voucher number — no live payment integration yet.">
          {(id) => <input id={id} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} className={inputClasses} />}
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

function ConfirmRedemptionModal({ open, redemptionId, onClose, onSaved }: { open: boolean; redemptionId: string | null; onClose: () => void; onSaved: () => void }) {
  const [paymentReference, setPaymentReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/investments/redemption-requests/${redemptionId}/confirm`, { paymentReference }),
    onSuccess: () => {
      onSaved();
      onClose();
      setPaymentReference('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to confirm redemption'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm redemption payout"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !paymentReference} onClick={() => mutation.mutate()}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Payment reference">{(id) => <input id={id} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
