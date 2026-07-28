import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, Send, Banknote, HandCoins, Repeat, Ban, Plus, Percent } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KpiCard } from '../../../components/KpiCard';
import { FormField, inputClasses, selectClasses, textareaClasses } from '../../../components/FormField';
import { ErrorState } from '../../../components/ErrorState';
import { formatDate, formatGhs, formatBps, parseGhsInput, parsePercentToBps } from '../../../lib/format';
import type {
  Loan,
  LoanProduct,
  LoanScheduleRow,
  LoanRepayment,
  LoanAppraisal,
  LoanCollateral,
  LoanGuarantor,
  LoanConcession,
  OverdraftStatus,
  Customer,
} from '../../../types/api';

const CONCESSION_ELIGIBLE_STATUSES = ['applied', 'appraised', 'pending_approval', 'approved'];

export function LoanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [appraiseOpen, setAppraiseOpen] = useState(false);
  const [disburseOpen, setDisburseOpen] = useState(false);
  const [repaymentOpen, setRepaymentOpen] = useState(false);
  const [restructureOpen, setRestructureOpen] = useState(false);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [accrueOpen, setAccrueOpen] = useState(false);
  const [collateralOpen, setCollateralOpen] = useState(false);
  const [guarantorOpen, setGuarantorOpen] = useState(false);
  const [concessionOpen, setConcessionOpen] = useState(false);

  const invalidateLoan = () => queryClient.invalidateQueries({ queryKey: ['loan', id] });

  const loanQuery = useQuery({ queryKey: ['loan', id], queryFn: () => api.get<Loan>(`/loans/${id}`), enabled: Boolean(id) });
  const loan = loanQuery.data;

  const customerQuery = useQuery({
    queryKey: ['customer', loan?.customer_id],
    queryFn: () => api.get<Customer>(`/customers/${loan!.customer_id}`),
    enabled: Boolean(loan),
  });
  const productQuery = useQuery({
    queryKey: ['loan-product', loan?.product_id],
    queryFn: () => api.get<LoanProduct>(`/loans/products/${loan!.product_id}`),
    enabled: Boolean(loan),
  });
  const scheduleQuery = useQuery({
    queryKey: ['loan-schedule', id],
    queryFn: () => api.get<LoanScheduleRow[]>(`/loans/${id}/schedule`),
    enabled: Boolean(id) && loan?.status !== 'applied' && loan?.status !== 'appraised' && loan?.status !== 'pending_approval',
  });
  const repaymentsQuery = useQuery({ queryKey: ['loan-repayments', id], queryFn: () => api.get<LoanRepayment[]>(`/loans/${id}/repayments`), enabled: Boolean(id) });
  const appraisalsQuery = useQuery({ queryKey: ['loan-appraisals', id], queryFn: () => api.get<LoanAppraisal[]>(`/loans/${id}/appraisals`), enabled: Boolean(id) });
  const collateralQuery = useQuery({ queryKey: ['loan-collateral', id], queryFn: () => api.get<LoanCollateral[]>(`/loans/${id}/collateral`), enabled: Boolean(id) });
  const guarantorsQuery = useQuery({ queryKey: ['loan-guarantors', id], queryFn: () => api.get<LoanGuarantor[]>(`/loans/${id}/guarantors`), enabled: Boolean(id) });
  const concessionsQuery = useQuery({ queryKey: ['loan-concessions', id], queryFn: () => api.get<LoanConcession[]>(`/loans/${id}/concessions`), enabled: Boolean(id) });
  const overdraftQuery = useQuery({
    queryKey: ['loan-overdraft-status', id],
    queryFn: () => api.get<OverdraftStatus>(`/loans/${id}/overdraft-status`),
    enabled: Boolean(id) && loan?.loan_type === 'overdraft' && loan?.status !== 'applied' && loan?.status !== 'appraised' && loan?.status !== 'pending_approval' && loan?.status !== 'rejected',
  });

  const requestApprovalMutation = useMutation({
    mutationFn: () => api.post(`/loans/${id}/approval-requests`),
    onSuccess: invalidateLoan,
  });
  const verifyCollateralMutation = useMutation({
    mutationFn: ({ collateralId, verificationStatus }: { collateralId: string; verificationStatus: string }) =>
      api.post(`/loans/${id}/collateral/${collateralId}/verify`, { verificationStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['loan-collateral', id] }),
  });

  if (loanQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading loan…</p>;
  if (loanQuery.error || !loan) {
    return <ErrorState message={loanQuery.error instanceof ApiError ? loanQuery.error.message : 'Unable to load this loan'} onRetry={() => loanQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === loan.branch_id)?.name ?? loan.branch_id;
  const isOverdraft = loan.loan_type === 'overdraft';

  const scheduleColumns: Column<LoanScheduleRow>[] = [
    { key: 'no', header: '#', render: (r) => r.installment_number },
    { key: 'due', header: 'Due date', render: (r) => formatDate(r.due_date) },
    { key: 'principal', header: 'Principal due', render: (r) => formatGhs(r.principal_due_pesewas), align: 'right' },
    { key: 'interest', header: 'Interest due', render: (r) => formatGhs(r.interest_due_pesewas), align: 'right' },
    { key: 'fees', header: 'Fees due', render: (r) => formatGhs(r.fees_due_pesewas), align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  const repaymentColumns: Column<LoanRepayment>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDate(r.payment_date) },
    { key: 'amount', header: 'Amount', render: (r) => formatGhs(r.amount_pesewas), align: 'right' },
    { key: 'principal', header: 'Principal', render: (r) => formatGhs(r.principal_component_pesewas), align: 'right' },
    { key: 'interest', header: 'Interest', render: (r) => formatGhs(r.interest_component_pesewas), align: 'right' },
    { key: 'fees', header: 'Fees', render: (r) => formatGhs(r.fees_component_pesewas), align: 'right' },
  ];
  const appraisalColumns: Column<LoanAppraisal>[] = [
    { key: 'date', header: 'Date', render: (a) => formatDate(a.created_at) },
    { key: 'recommendation', header: 'Recommendation', render: (a) => <StatusBadge status={a.recommendation === 'recommend' ? 'approved' : 'rejected'} label={a.recommendation} /> },
    { key: 'notes', header: 'Notes', render: (a) => a.notes ?? '—' },
  ];
  const collateralColumns: Column<LoanCollateral>[] = [
    { key: 'description', header: 'Description', render: (c) => c.description },
    { key: 'value', header: 'Estimated value', render: (c) => formatGhs(c.estimated_value_pesewas), align: 'right' },
    { key: 'status', header: 'Verification', render: (c) => <StatusBadge status={c.verification_status} /> },
  ];
  const guarantorColumns: Column<LoanGuarantor>[] = [
    { key: 'name', header: 'Name', render: (g) => g.guarantor_name ?? `Customer #${g.customer_id}` },
    { key: 'phone', header: 'Phone', render: (g) => g.guarantor_phone ?? '—' },
    { key: 'amount', header: 'Guaranteed amount', render: (g) => formatGhs(g.guaranteed_amount_pesewas), align: 'right' },
    { key: 'status', header: 'Verification', render: (g) => <StatusBadge status={g.verification_status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/loans')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to loans
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">Loan #{loan.id}</h1>
              <span className="rounded-pill border border-border bg-surface-alt px-2 py-0.5 text-[11.5px] font-medium capitalize text-text-secondary">{loan.loan_type}</span>
              <StatusBadge status={loan.status} />
            </div>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              Customer{' '}
              <button type="button" onClick={() => navigate(`/app/customers/${loan.customer_id}`)} className="text-primary underline">
                {customerQuery.data?.full_name ?? `#${loan.customer_id}`}
              </button>{' '}
              · {branchName} · Product: {productQuery.data?.name ?? `#${loan.product_id}`}
            </p>
            <p className="text-[13px] text-text-secondary">
              {formatGhs(loan.principal_pesewas)} principal · {loan.term_months} months · disbursed {formatDate(loan.disbursed_at)}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('loan.appraise') && (loan.status === 'applied' || loan.status === 'appraised') && (
              <Button variant="secondary" size="sm" onClick={() => setAppraiseOpen(true)}>
                <ClipboardCheck size={14} /> Appraise
              </Button>
            )}
            {hasPermission('loan.request_approval') && loan.status === 'appraised' && (
              <Button variant="secondary" size="sm" disabled={requestApprovalMutation.isPending} onClick={() => requestApprovalMutation.mutate()}>
                <Send size={14} /> Request approval
              </Button>
            )}
            {hasPermission('loan.disburse') && loan.status === 'approved' && (
              <Button variant="primary" size="sm" onClick={() => setDisburseOpen(true)}>
                <Banknote size={14} /> Disburse
              </Button>
            )}
            {hasPermission('loan.post_repayment') && loan.status === 'disbursed' && (
              <Button variant="secondary" size="sm" onClick={() => setRepaymentOpen(true)}>
                <HandCoins size={14} /> Record repayment
              </Button>
            )}
            {hasPermission('loan.restructure') && loan.status === 'disbursed' && !isOverdraft && (
              <Button variant="secondary" size="sm" onClick={() => setRestructureOpen(true)}>
                <Repeat size={14} /> Restructure
              </Button>
            )}
            {hasPermission('loan.grant_concession') && CONCESSION_ELIGIBLE_STATUSES.includes(loan.status) && (
              <Button variant="secondary" size="sm" onClick={() => setConcessionOpen(true)}>
                <Percent size={14} /> Propose concession
              </Button>
            )}
            {hasPermission('loan.write_off') && loan.status === 'disbursed' && (
              <Button variant="danger" size="sm" onClick={() => setWriteOffOpen(true)}>
                <Ban size={14} /> Write off
              </Button>
            )}
          </div>
        </div>
      </Card>

      <TermsCard loan={loan} product={productQuery.data} concessions={concessionsQuery.data ?? []} isLoading={concessionsQuery.isLoading} />

      {isOverdraft && overdraftQuery.data && (
        <Card title="Overdraft facility">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Limit" value={formatGhs(overdraftQuery.data.limitPesewas)} />
            <KpiCard label="Drawn" value={formatGhs(overdraftQuery.data.drawnPesewas)} higherIsBetter={false} />
            <KpiCard label="Available" value={formatGhs(overdraftQuery.data.availablePesewas)} />
            <KpiCard label="Account balance" value={formatGhs(overdraftQuery.data.balancePesewas)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {hasPermission('loan.accrue_overdraft_interest') && loan.status === 'disbursed' && (
              <Button variant="secondary" size="sm" onClick={() => setAccrueOpen(true)}>
                Accrue interest
              </Button>
            )}
            {hasPermission('loan.close_overdraft') && loan.status === 'disbursed' && (
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  await api.post(`/loans/${id}/overdraft/close`);
                  invalidateLoan();
                  queryClient.invalidateQueries({ queryKey: ['loan-overdraft-status', id] });
                }}
              >
                Close overdraft
              </Button>
            )}
          </div>
        </Card>
      )}

      {!isOverdraft && (
        <Card title="Repayment schedule" padded={false}>
          <DataTable columns={scheduleColumns} rows={scheduleQuery.data ?? []} getRowKey={(r) => r.id} isLoading={scheduleQuery.isLoading} emptyTitle="No schedule yet — loan has not been disbursed" />
        </Card>
      )}

      <Card title="Repayments" padded={false}>
        <DataTable columns={repaymentColumns} rows={repaymentsQuery.data ?? []} getRowKey={(r) => r.id} isLoading={repaymentsQuery.isLoading} emptyTitle="No repayments recorded yet" />
      </Card>

      <Card title="Appraisal history" padded={false}>
        <DataTable columns={appraisalColumns} rows={appraisalsQuery.data ?? []} getRowKey={(a) => a.id} isLoading={appraisalsQuery.isLoading} emptyTitle="No appraisals submitted yet" />
      </Card>

      <Card
        title="Collateral"
        actions={
          hasPermission('loan.manage_collateral') && (
            <Button variant="secondary" size="sm" onClick={() => setCollateralOpen(true)}>
              <Plus size={14} /> Add collateral
            </Button>
          )
        }
        padded={false}
      >
        <DataTable
          columns={collateralColumns}
          rows={collateralQuery.data ?? []}
          getRowKey={(c) => c.id}
          isLoading={collateralQuery.isLoading}
          emptyTitle="No collateral recorded"
          rowActions={
            hasPermission('loan.manage_collateral')
              ? (c) =>
                  c.verification_status === 'pending' && (
                    <div className="flex justify-end gap-1.5">
                      <Button variant="secondary" size="sm" onClick={() => verifyCollateralMutation.mutate({ collateralId: c.id, verificationStatus: 'verified' })}>
                        Verify
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => verifyCollateralMutation.mutate({ collateralId: c.id, verificationStatus: 'rejected' })}>
                        Reject
                      </Button>
                    </div>
                  )
              : undefined
          }
        />
      </Card>

      <Card
        title="Guarantors"
        actions={
          hasPermission('loan.manage_guarantors') && (
            <Button variant="secondary" size="sm" onClick={() => setGuarantorOpen(true)}>
              <Plus size={14} /> Add guarantor
            </Button>
          )
        }
        padded={false}
      >
        <DataTable columns={guarantorColumns} rows={guarantorsQuery.data ?? []} getRowKey={(g) => g.id} isLoading={guarantorsQuery.isLoading} emptyTitle="No guarantors recorded" />
      </Card>

      <AppraiseModal open={appraiseOpen} onClose={() => setAppraiseOpen(false)} loanId={loan.id} onSaved={() => { invalidateLoan(); queryClient.invalidateQueries({ queryKey: ['loan-appraisals', id] }); }} />
      <DisburseModal open={disburseOpen} onClose={() => setDisburseOpen(false)} loanId={loan.id} onSaved={invalidateLoan} />
      <RepaymentModal open={repaymentOpen} onClose={() => setRepaymentOpen(false)} loanId={loan.id} onSaved={() => { invalidateLoan(); queryClient.invalidateQueries({ queryKey: ['loan-schedule', id] }); queryClient.invalidateQueries({ queryKey: ['loan-repayments', id] }); }} />
      <RestructureModal open={restructureOpen} onClose={() => setRestructureOpen(false)} loanId={loan.id} onSaved={invalidateLoan} />
      <ConcessionModal
        open={concessionOpen}
        onClose={() => setConcessionOpen(false)}
        loanId={loan.id}
        loan={loan}
        product={productQuery.data}
        onSaved={() => {
          invalidateLoan();
          queryClient.invalidateQueries({ queryKey: ['loan-concessions', id] });
        }}
      />
      <WriteOffModal open={writeOffOpen} onClose={() => setWriteOffOpen(false)} loanId={loan.id} onSaved={invalidateLoan} />
      <AccrueInterestModal open={accrueOpen} onClose={() => setAccrueOpen(false)} loanId={loan.id} onSaved={() => queryClient.invalidateQueries({ queryKey: ['loan-overdraft-status', id] })} />
      <AddCollateralModal open={collateralOpen} onClose={() => setCollateralOpen(false)} loanId={loan.id} onSaved={() => queryClient.invalidateQueries({ queryKey: ['loan-collateral', id] })} />
      <AddGuarantorModal open={guarantorOpen} onClose={() => setGuarantorOpen(false)} loanId={loan.id} onSaved={() => queryClient.invalidateQueries({ queryKey: ['loan-guarantors', id] })} />
    </div>
  );
}

function feeScheduleSummary(feeSchedule: Loan['fee_schedule']): string {
  if (!feeSchedule || feeSchedule.length === 0) return 'No fees';
  return feeSchedule
    .map((f) => (f.type === 'flat' ? `${f.code ?? 'Fee'}: ${formatGhs(f.amountPesewas)}` : `${f.code ?? 'Fee'}: ${formatBps(f.rateBps)} of principal`))
    .join(', ');
}

/**
 * Standard (product) terms vs this loan's actual current terms, plus its
 * full concession history — kept as a clearly separate comparison rather
 * than only showing the loan's already-blended current rate, per the
 * "visible... with a clear standard vs negotiated comparison, not
 * silently blended in" requirement.
 */
function TermsCard({
  loan,
  product,
  concessions,
  isLoading,
}: {
  loan: Loan;
  product: LoanProduct | undefined;
  concessions: LoanConcession[];
  isLoading: boolean;
}) {
  const hasConcessions = concessions.length > 0;
  const currentDiffersFromStandard = product && Number(loan.annual_interest_rate_bps) !== Number(product.annual_interest_rate_bps);

  const concessionColumns: Column<LoanConcession>[] = [
    { key: 'date', header: 'Requested', render: (c) => formatDate(c.created_at) },
    { key: 'reason', header: 'Reason', render: (c) => <span className="capitalize">{c.reason_code.replace(/_/g, ' ')}</span> },
    { key: 'rate', header: 'Standard → negotiated rate', render: (c) => `${formatBps(c.standard_annual_interest_rate_bps)} → ${formatBps(c.negotiated_annual_interest_rate_bps)}` },
    {
      key: 'spread',
      header: 'Standard → negotiated spread',
      render: (c) => (c.standard_spread_bps !== null ? `${formatBps(c.standard_spread_bps)} → ${formatBps(c.negotiated_spread_bps)}` : '—'),
    },
    {
      key: 'term',
      header: 'Standard → negotiated term',
      render: (c) => (c.standard_term_months !== c.negotiated_term_months ? `${c.standard_term_months} → ${c.negotiated_term_months} mo` : '—'),
    },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
  ];

  return (
    <Card title="Terms & concessions">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Current rate (p.a.)" value={formatBps(loan.annual_interest_rate_bps)} />
        <KpiCard label="Interest method" value={loan.interest_method === 'flat' ? 'Flat' : 'Reducing balance'} />
        <KpiCard label="Term" value={`${loan.term_months} months`} />
        <KpiCard label="Fees" value={feeScheduleSummary(loan.fee_schedule)} />
      </div>

      {product && (
        <div className="mt-3 rounded-md border border-border bg-surface-alt p-3">
          <p className="text-[12.5px] font-medium text-text-primary">Product standard terms ({product.code})</p>
          <p className="mt-1 text-[12.5px] text-text-secondary">
            {formatBps(product.annual_interest_rate_bps)} p.a.
            {product.rate_type === 'floating' && ` (floating: reference + ${formatBps(product.spread_bps)} spread, resets ${product.reset_frequency})`}
            {' · '}
            {product.min_term_months}–{product.max_term_months} months allowed
          </p>
          {currentDiffersFromStandard && (
            <p className="mt-1 text-[12.5px] font-medium text-warning-text-strong">
              This loan's current rate differs from the product's standard rate — see the concession that granted it below, not a
              silent override.
            </p>
          )}
        </div>
      )}

      {hasConcessions && (
        <div className="mt-3">
          <DataTable columns={concessionColumns} rows={concessions} getRowKey={(c) => c.id} isLoading={isLoading} emptyTitle="No concessions" />
        </div>
      )}
    </Card>
  );
}

// --- Action modals ---------------------------------------------------------

function ConcessionModal({
  open,
  onClose,
  loanId,
  loan,
  product,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  loanId: string;
  loan: Loan;
  product: LoanProduct | undefined;
  onSaved: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<'loyal_customer' | 'competitive_match' | 'hardship' | 'other'>('loyal_customer');
  const [reasonNotes, setReasonNotes] = useState('');
  const [negotiatedRate, setNegotiatedRate] = useState('');
  const [negotiatedSpread, setNegotiatedSpread] = useState('');
  const [negotiatedTerm, setNegotiatedTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ needsApproval: boolean } | null>(null);

  const isFloating = product?.rate_type === 'floating';

  function reset() {
    setReasonCode('loyal_customer');
    setReasonNotes('');
    setNegotiatedRate('');
    setNegotiatedSpread('');
    setNegotiatedTerm('');
    setError(null);
    setResult(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ needsApproval: boolean }>(`/loans/${loanId}/concessions`, {
        negotiatedAnnualInterestRateBps: !isFloating && negotiatedRate ? parsePercentToBps(negotiatedRate) : undefined,
        negotiatedSpreadBps: isFloating && negotiatedSpread ? parsePercentToBps(negotiatedSpread) : undefined,
        negotiatedTermMonths: negotiatedTerm ? Number(negotiatedTerm) : undefined,
        reasonCode,
        reasonNotes: reasonNotes || undefined,
      }),
    onSuccess: (data) => {
      onSaved();
      setResult(data);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit concession'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Propose a concession"
      footer={
        result ? (
          <Button variant="secondary" size="sm" onClick={() => { onClose(); reset(); }}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={mutation.isPending || !reasonCode || (!negotiatedRate && !negotiatedSpread && !negotiatedTerm)}
              onClick={() => mutation.mutate()}
            >
              Submit
            </Button>
          </>
        )
      }
    >
      {result ? (
        <p className="text-[13px] text-text-secondary">
          {result.needsApproval
            ? "Submitted for branch manager approval — this loan can't disburse until it's decided."
            : "Applied immediately — within this product's approval-free threshold, so no second sign-off was needed."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-secondary">
            Standard terms: {formatBps(product?.annual_interest_rate_bps)} p.a.
            {isFloating && ` (spread ${formatBps(product?.spread_bps)})`}, {loan.term_months} months. A concession beyond this
            product's approval-free threshold routes to a branch manager before the loan can disburse.
          </p>
          <FormField label="Reason">
            {(id) => (
              <select id={id} value={reasonCode} onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)} className={selectClasses}>
                <option value="loyal_customer">Loyal customer</option>
                <option value="competitive_match">Competitive match</option>
                <option value="hardship">Hardship</option>
                <option value="other">Other</option>
              </select>
            )}
          </FormField>
          <FormField label="Reason notes">{(id) => <textarea id={id} rows={2} value={reasonNotes} onChange={(e) => setReasonNotes(e.target.value)} className={textareaClasses} />}</FormField>
          {isFloating ? (
            <FormField label="Negotiated spread (%)" hint={`Standard spread is ${formatBps(product?.spread_bps)} — only the spread is negotiable, never the reference rate.`}>
              {(id) => <input id={id} type="number" step="0.01" value={negotiatedSpread} onChange={(e) => setNegotiatedSpread(e.target.value)} className={inputClasses} />}
            </FormField>
          ) : (
            <FormField label="Negotiated rate (%)" hint={`Standard rate is ${formatBps(product?.annual_interest_rate_bps)}.`}>
              {(id) => <input id={id} type="number" step="0.01" value={negotiatedRate} onChange={(e) => setNegotiatedRate(e.target.value)} className={inputClasses} />}
            </FormField>
          )}
          <FormField label="Negotiated term (months)" hint={`Leave blank to keep the current term (${loan.term_months} months).`}>
            {(id) => <input id={id} type="number" value={negotiatedTerm} onChange={(e) => setNegotiatedTerm(e.target.value)} className={inputClasses} />}
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

function AppraiseModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [recommendation, setRecommendation] = useState<'recommend' | 'decline'>('recommend');
  const [checklistNotes, setChecklistNotes] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/appraisals`, { checklist: { notes: checklistNotes || 'reviewed' }, recommendation, notes: notes || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
      setChecklistNotes('');
      setNotes('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit appraisal'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Submit appraisal"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Submit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Recommendation">
          {(id) => (
            <select id={id} value={recommendation} onChange={(e) => setRecommendation(e.target.value as typeof recommendation)} className={selectClasses}>
              <option value="recommend">Recommend</option>
              <option value="decline">Decline</option>
            </select>
          )}
        </FormField>
        <FormField label="Checklist findings" hint="Key points reviewed (identity, income, collateral adequacy, etc.).">
          {(id) => <textarea id={id} value={checklistNotes} onChange={(e) => setChecklistNotes(e.target.value)} className={textareaClasses} rows={3} />}
        </FormField>
        <FormField label="Decision notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function DisburseModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [disbursementDate, setDisbursementDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/disburse`, { disbursementDate: disbursementDate || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to disburse loan'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Disburse loan"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Disburse
          </Button>
        </>
      }
    >
      <FormField label="Disbursement date" hint="Defaults to today if left blank.">
        {(id) => <input id={id} type="date" value={disbursementDate} onChange={(e) => setDisbursementDate(e.target.value)} className={inputClasses} />}
      </FormField>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function RepaymentModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/repayments`, { amountPesewas: parseGhsInput(amount), paymentDate: paymentDate || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
      setAmount('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to record repayment'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record repayment"
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
        <FormField label="Payment date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClasses} />}
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

function RestructureModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [newTermMonths, setNewTermMonths] = useState('');
  const [newRate, setNewRate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/restructure-requests`, {
        newTermMonths: Number(newTermMonths),
        newAnnualInterestRateBps: parsePercentToBps(newRate),
        reason,
      }),
    onSuccess: () => {
      onSaved();
      setSubmitted(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit restructure request'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSubmitted(false);
        setNewTermMonths('');
        setNewRate('');
        setReason('');
      }}
      title="Request restructure"
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
            <Button variant="primary" size="sm" disabled={mutation.isPending || !newTermMonths || !reason} onClick={() => mutation.mutate()}>
              Submit for approval
            </Button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-[13px] text-text-secondary">Restructure request submitted for maker-checker approval.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-secondary">
            Dual-control: this creates a pending request. The current schedule and repayment history stay untouched until approved.
          </p>
          <FormField label="New term (months)">{(id) => <input id={id} type="number" value={newTermMonths} onChange={(e) => setNewTermMonths(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="New annual interest rate (%)">{(id) => <input id={id} type="number" step="0.01" value={newRate} onChange={(e) => setNewRate(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Reason">{(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClasses} />}</FormField>
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

function WriteOffModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [writeOffDate, setWriteOffDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/write-off`, { reason, writeOffDate: writeOffDate || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to write off loan'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Write off loan"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={mutation.isPending || !reason} onClick={() => mutation.mutate()}>
            Write off
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-secondary">This moves the outstanding principal to Loan Loss Expense and clears the receivable. This cannot be undone.</p>
        <FormField label="Reason">{(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Write-off date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={writeOffDate} onChange={(e) => setWriteOffDate(e.target.value)} className={inputClasses} />}
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

function AccrueInterestModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [accrualDate, setAccrualDate] = useState('');
  const [days, setDays] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/overdraft/accrue-interest`, { accrualDate: accrualDate || undefined, days: Number(days) }),
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
      title="Accrue overdraft interest"
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

function AddCollateralModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/loans/${loanId}/collateral`, { description, estimatedValuePesewas: estimatedValue ? parseGhsInput(estimatedValue) : undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
      setDescription('');
      setEstimatedValue('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to add collateral'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add collateral"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !description} onClick={() => mutation.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Description">{(id) => <input id={id} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Estimated value (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={estimatedValue} onChange={(e) => setEstimatedValue(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AddGuarantorModal({ open, onClose, loanId, onSaved }: { open: boolean; onClose: () => void; loanId: string; onSaved: () => void }) {
  const [customerId, setCustomerId] = useState('');
  const [guarantorName, setGuarantorName] = useState('');
  const [guarantorPhone, setGuarantorPhone] = useState('');
  const [guaranteedAmount, setGuaranteedAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/loans/${loanId}/guarantors`, {
        customerId: customerId ? Number(customerId) : undefined,
        guarantorName: guarantorName || undefined,
        guarantorPhone: guarantorPhone || undefined,
        guaranteedAmountPesewas: guaranteedAmount ? parseGhsInput(guaranteedAmount) : undefined,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
      setCustomerId('');
      setGuarantorName('');
      setGuarantorPhone('');
      setGuaranteedAmount('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to add guarantor'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add guarantor"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || (!customerId && !guarantorName)} onClick={() => mutation.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-secondary">Either an existing customer ID, or a name for someone not in the system.</p>
        <FormField label="Customer ID (optional)">{(id) => <input id={id} type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Guarantor name (if not a customer)">{(id) => <input id={id} value={guarantorName} onChange={(e) => setGuarantorName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Phone">{(id) => <input id={id} value={guarantorPhone} onChange={(e) => setGuarantorPhone(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Guaranteed amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={guaranteedAmount} onChange={(e) => setGuaranteedAmount(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
