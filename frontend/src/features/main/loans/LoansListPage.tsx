import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Calculator, ShieldAlert, ChevronUp, ChevronDown, ClipboardList } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { isCrossBranchRole } from '../../../lib/roleScope';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { FilterToolbar } from '../../../components/FilterToolbar';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KpiCard } from '../../../components/KpiCard';
import { FormField, inputClasses, selectClasses } from '../../../components/FormField';
import { formatDate, formatGhs, formatBps, parseGhsInput, parsePercentToBps } from '../../../lib/format';
import type { Loan, LoanProduct, PolicyRate, ArrearsReport, LoanCalculatorResult, Customer, LoanScheduleRow } from '../../../types/api';

const LOAN_STATUSES = [
  'applied',
  'appraised',
  'pending_approval',
  'approved',
  'rejected',
  'disbursed',
  'paying',
  'missed_payment',
  'closed',
  'written_off',
];

type SortKey = 'principal_pesewas' | 'total_paid_pesewas' | 'status';

function sortLoans(loans: Loan[], sortKey: SortKey | null, sortDir: 'asc' | 'desc'): Loan[] {
  if (!sortKey) return loans;
  const sorted = [...loans].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv));
  });
  return sortDir === 'asc' ? sorted : sorted.reverse();
}

/** Clickable column header for the three sortable columns — DataTable's header cell accepts any ReactNode, sort state lives entirely in LoansListPage. */
function SortableHeader({ label, active, direction, onClick }: { label: string; active: boolean; direction: 'asc' | 'desc'; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 uppercase tracking-wide">
      {label}
      {active ? (
        direction === 'asc' ? (
          <ChevronUp size={12} />
        ) : (
          <ChevronDown size={12} />
        )
      ) : (
        <span className="opacity-30">
          <ChevronDown size={12} />
        </span>
      )}
    </button>
  );
}

export function LoansListPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [manageLoan, setManageLoan] = useState<Loan | null>(null);

  const productsQuery = useQuery({ queryKey: ['loan-products'], queryFn: () => api.get<LoanProduct[]>('/loans/products') });

  const loansQuery = useQuery({
    queryKey: ['loans', { branchId, status, productId }],
    queryFn: () =>
      api.get<Loan[]>('/loans', {
        branchId: crossBranch ? branchId : user!.homeBranchId,
        status,
        productId,
      }),
  });

  // Loaded in full (same client-side-join pattern productsQuery already
  // uses for the Loan Offer column) to resolve each row's Photo/Customer
  // cell without an N+1 fetch per row.
  const customersQuery = useQuery({
    queryKey: ['customers-for-loans', { branchId }],
    queryFn: () => api.get<Customer[]>('/customers', { branchId: crossBranch ? branchId : user!.homeBranchId }),
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const columns: Column<Loan>[] = [
    { key: 'id', header: '#', render: (l) => `#${l.id}` },
    { key: 'reference', header: 'Reference', render: (l) => <span className="font-mono text-[12px]">{l.reference}</span> },
    {
      key: 'photo',
      header: 'Photo',
      render: (l) => {
        const photoUrl = customersQuery.data?.find((c) => c.id === l.customer_id)?.photo_url;
        return photoUrl ? (
          <img src={photoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-alt text-[11px] text-text-secondary">—</div>
        );
      },
    },
    { key: 'customer', header: 'Customer', render: (l) => customersQuery.data?.find((c) => c.id === l.customer_id)?.full_name ?? `#${l.customer_id}` },
    // No loan-officer-assignment concept exists on a loan today — the
    // closest available field is who submitted the application.
    { key: 'agent', header: 'Agent', render: (l) => `#${l.applied_by}` },
    { key: 'product', header: 'Loan Offer', render: (l) => productsQuery.data?.find((p) => p.id === l.product_id)?.name ?? `#${l.product_id}` },
    {
      key: 'principal',
      header: <SortableHeader label="Principal" active={sortKey === 'principal_pesewas'} direction={sortDir} onClick={() => toggleSort('principal_pesewas')} />,
      render: (l) => formatGhs(l.principal_pesewas),
      align: 'right',
    },
    { key: 'term', header: 'Term', render: (l) => `${l.term_months} ${l.duration_unit}` },
    { key: 'expected', header: 'Expected', render: (l) => formatGhs(l.expected_pesewas), align: 'right' },
    {
      key: 'totalPaid',
      header: <SortableHeader label="Total Paid" active={sortKey === 'total_paid_pesewas'} direction={sortDir} onClick={() => toggleSort('total_paid_pesewas')} />,
      render: (l) => formatGhs(l.total_paid_pesewas),
      align: 'right',
    },
    { key: 'balance', header: 'Balance', render: (l) => formatGhs(l.balance_pesewas), align: 'right' },
    {
      key: 'status',
      header: <SortableHeader label="Status" active={sortKey === 'status'} direction={sortDir} onClick={() => toggleSort('status')} />,
      render: (l) => <StatusBadge status={l.status} />,
    },
    {
      key: 'action',
      header: 'Action',
      render: (l) =>
        ['disbursed', 'paying', 'missed_payment'].includes(l.status) && hasPermission('loan.post_repayment') ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setManageLoan(l);
            }}
          >
            <ClipboardList size={14} /> Manage
          </Button>
        ) : (
          '—'
        ),
    },
  ];

  const sortedLoans = sortLoans(loansQuery.data ?? [], sortKey, sortDir);

  return (
    <div className="flex flex-col gap-4">
      <LoanProductsCard products={productsQuery.data ?? []} isLoading={productsQuery.isLoading} canManage={hasPermission('loan.manage_products')} />

      <Card
        title="Loans & Credit"
        actions={
          hasPermission('loan.apply') && (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New loan application
            </Button>
          )
        }
        padded={false}
      >
        <FilterToolbar>
          {crossBranch && (
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
              <option value="">All branches</option>
              {branches?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All offers</option>
            {productsQuery.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            {LOAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={sortedLoans}
          getRowKey={(l) => l.id}
          isLoading={loansQuery.isLoading}
          error={loansQuery.error instanceof ApiError ? loansQuery.error.message : null}
          onRetry={() => loansQuery.refetch()}
          onRowClick={(l) => navigate(`/app/loans/${l.id}`)}
          emptyTitle="No loans match these filters"
        />
      </Card>

      <ManageRepaymentsModal
        loan={manageLoan}
        onClose={() => setManageLoan(null)}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['loans'] })}
      />

      <LoanCalculatorCard products={productsQuery.data ?? []} />

      {hasPermission('loan.view_reports') && <ArrearsReportCard crossBranch={crossBranch} branches={branches ?? []} defaultBranchId={crossBranch ? '' : user!.homeBranchId} />}

      {hasPermission('loan.manage_policy_rates') && <PolicyRatesCard />}

      <CreateLoanModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        products={(productsQuery.data ?? []).filter((p) => p.status === 'active')}
        onCreated={(loanId) => {
          queryClient.invalidateQueries({ queryKey: ['loans'] });
          navigate(`/app/loans/${loanId}`);
        }}
      />
    </div>
  );
}

function CreateLoanModal({
  open,
  onClose,
  products,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  products: LoanProduct[];
  onCreated: (loanId: string) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [termMonths, setTermMonths] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [purposeNotes, setPurposeNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedProduct = products.find((p) => p.id === productId);

  function reset() {
    setCustomerId('');
    setProductId('');
    setPrincipal('');
    setTermMonths('');
    setReasonCode('');
    setPurposeNotes('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/loans', {
        customerId: Number(customerId),
        productId,
        principalPesewas: parseGhsInput(principal),
        termMonths: Number(termMonths),
        reasonCode: reasonCode || undefined,
        purposeNotes: purposeNotes || undefined,
      }),
    onSuccess: (loan) => {
      onCreated(loan.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit loan application'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New loan application"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Submit application
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Customer ID" hint="Open this from a customer's 360 page, or enter their ID directly — there's no name search yet.">
          {(id) => <input id={id} type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Loan offer">
          {(id) => (
            <select id={id} value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses}>
              <option value="">Select a loan offer…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatBps(p.annual_interest_rate_bps)} p.a.)
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="Principal (GH₵)"
          hint={selectedProduct ? `Range: ${formatGhs(selectedProduct.min_principal_pesewas)} – ${formatGhs(selectedProduct.max_principal_pesewas)}` : undefined}
        >
          {(id) => <input id={id} type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField
          label="Term (months)"
          hint={selectedProduct ? `Range: ${selectedProduct.min_term_months} – ${selectedProduct.max_term_months} months` : undefined}
        >
          {(id) => <input id={id} type="number" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Reason code">
          {(id) =>
            selectedProduct && selectedProduct.reason_codes.length > 0 ? (
              <select id={id} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={selectClasses}>
                <option value="">Select a reason…</option>
                {selectedProduct.reason_codes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <input id={id} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={inputClasses} />
            )
          }
        </FormField>
        <FormField label="Purpose notes">
          {(id) => <input id={id} value={purposeNotes} onChange={(e) => setPurposeNotes(e.target.value)} className={inputClasses} />}
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

/**
 * The Loans & Credit table's "Action" management panel (item 4): record a
 * repayment against the loan's open installments, and waive an
 * installment's outstanding default charge. Ties directly into the
 * schedule generated at disbursement (item 3a) and the loan's
 * paying/missed_payment status (item 5) — posting a repayment or waiving
 * a charge both trigger loanService's own status recompute server-side,
 * so re-opening this panel (or the table refetch onChanged triggers)
 * reflects the new status without any client-side status logic here.
 */
function ManageRepaymentsModal({ loan, onClose, onChanged }: { loan: Loan | null; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [waiveReason, setWaiveReason] = useState('');
  const [waivingScheduleId, setWaivingScheduleId] = useState<string | null>(null);

  const scheduleQuery = useQuery({
    queryKey: ['loan-schedule', loan?.id],
    queryFn: () => api.get<LoanScheduleRow[]>(`/loans/${loan!.id}/schedule`),
    enabled: !!loan,
  });

  const repayMutation = useMutation({
    mutationFn: () => api.post(`/loans/${loan!.id}/repayments`, { amountPesewas: parseGhsInput(amount) }),
    onSuccess: () => {
      setAmount('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['loan-schedule', loan?.id] });
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to record repayment'),
  });

  const waiveMutation = useMutation({
    mutationFn: (scheduleId: string) => api.post(`/loans/${loan!.id}/schedule/${scheduleId}/waive-default-charge`, { reason: waiveReason }),
    onSuccess: () => {
      setWaivingScheduleId(null);
      setWaiveReason('');
      queryClient.invalidateQueries({ queryKey: ['loan-schedule', loan?.id] });
      onChanged();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to waive charge'),
  });

  return (
    <Modal
      open={!!loan}
      onClose={() => {
        onClose();
        setAmount('');
        setError(null);
        setWaivingScheduleId(null);
      }}
      title={loan ? `Manage repayments — ${loan.reference}` : 'Manage repayments'}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loan && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <KpiCard label="Expected" value={formatGhs(loan.expected_pesewas)} />
            <KpiCard label="Total paid" value={formatGhs(loan.total_paid_pesewas)} />
            <KpiCard label="Balance" value={formatGhs(loan.balance_pesewas)} higherIsBetter={false} />
          </div>

          <div className="flex items-end gap-2">
            <FormField label="Record repayment (GH₵)">
              {(id) => <input id={id} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}
            </FormField>
            <Button variant="primary" size="md" disabled={!amount || repayMutation.isPending} onClick={() => repayMutation.mutate()}>
              Record
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}

          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-[11.5px] font-semibold tracking-wide text-text-secondary uppercase">
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Due date</th>
                  <th className="px-3 py-2 text-right">Principal</th>
                  <th className="px-3 py-2 text-right">Interest</th>
                  <th className="px-3 py-2 text-right">Fees / Charges</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left" />
                </tr>
              </thead>
              <tbody>
                {(scheduleQuery.data ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">{row.installment_number}</td>
                    <td className="px-3 py-2">{formatDate(row.due_date)}</td>
                    <td className="px-3 py-2 text-right">
                      {formatGhs(row.principal_paid_pesewas)} / {formatGhs(row.principal_due_pesewas)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {formatGhs(row.interest_paid_pesewas)} / {formatGhs(row.interest_due_pesewas)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {formatGhs(row.fees_paid_pesewas)} / {formatGhs(row.fees_due_pesewas)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2">
                      {row.default_charge_applied && row.fees_due_pesewas > row.fees_paid_pesewas && (
                        <>
                          {waivingScheduleId === row.id ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                value={waiveReason}
                                onChange={(e) => setWaiveReason(e.target.value)}
                                placeholder="Reason"
                                className={inputClasses + ' h-7 w-32 text-[12px]'}
                              />
                              <Button variant="danger" size="sm" disabled={!waiveReason || waiveMutation.isPending} onClick={() => waiveMutation.mutate(row.id)}>
                                Confirm
                              </Button>
                            </div>
                          ) : (
                            <Button variant="secondary" size="sm" onClick={() => setWaivingScheduleId(row.id)}>
                              Waive charge
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

function LoanCalculatorCard({ products }: { products: LoanProduct[] }) {
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [termMonths, setTermMonths] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post<LoanCalculatorResult>('/loans/calculator', {
        productId,
        principalPesewas: parseGhsInput(principal),
        termMonths: Number(termMonths),
      }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to calculate a schedule preview'),
  });

  return (
    <Card title={<span className="flex items-center gap-1.5"><Calculator size={16} /> Loan calculator</span>}>
      <p className="mb-3 text-[13px] text-text-secondary">Preview a repayment schedule without creating anything.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <FormField label="Offer">
          {(id) => (
            <select id={id} value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses}>
              <option value="">Select…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Principal (GH₵)">
          {(id) => <input id={id} type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Term (months)">
          {(id) => <input id={id} type="number" value={termMonths} onChange={(e) => setTermMonths(e.target.value)} className={inputClasses} />}
        </FormField>
        <div className="flex items-end">
          <Button variant="secondary" size="md" className="w-full" disabled={!productId || !principal || !termMonths || mutation.isPending} onClick={() => mutation.mutate()}>
            Calculate
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {mutation.data && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Fees" value={formatGhs(mutation.data.feesPesewas)} />
            <KpiCard label="Net disbursed" value={formatGhs(mutation.data.netDisbursedPesewas)} />
            <KpiCard label="Total interest" value={formatGhs(mutation.data.totalInterestPesewas)} />
            <KpiCard label="Total repayable" value={formatGhs(mutation.data.totalRepayablePesewas)} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-[11.5px] font-semibold tracking-wide text-text-secondary uppercase">
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">Due date</th>
                  <th className="px-3 py-2 text-right">Principal</th>
                  <th className="px-3 py-2 text-right">Interest</th>
                </tr>
              </thead>
              <tbody>
                {mutation.data.schedule.map((row) => (
                  <tr key={row.installmentNumber} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">{row.installmentNumber}</td>
                    <td className="px-3 py-2">{formatDate(row.dueDate)}</td>
                    <td className="px-3 py-2 text-right">{formatGhs(row.principalDuePesewas)}</td>
                    <td className="px-3 py-2 text-right">{formatGhs(row.interestDuePesewas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function ArrearsReportCard({
  crossBranch,
  branches,
  defaultBranchId,
}: {
  crossBranch: boolean;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
}) {
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [asOfDate, setAsOfDate] = useState('');

  const reportQuery = useQuery({
    queryKey: ['loan-arrears', { branchId, asOfDate }],
    queryFn: () => api.get<ArrearsReport>('/loans/reports/arrears', { branchId, asOfDate: asOfDate || undefined }),
  });

  const bucketEntries = Object.entries(reportQuery.data?.totals.buckets ?? {});

  return (
    <Card title={<span className="flex items-center gap-1.5"><ShieldAlert size={16} /> Arrears report</span>} padded={false}>
      <FilterToolbar>
        {crossBranch && (
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="h-8 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent" />
      </FilterToolbar>
      <div className="p-[var(--card-padding)] pb-0">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Outstanding" value={formatGhs(reportQuery.data?.totals.totalOutstandingPesewas)} />
          <KpiCard label="At risk" value={formatGhs(reportQuery.data?.totals.totalAtRiskPesewas)} higherIsBetter={false} />
          <KpiCard label="PAR ratio" value={reportQuery.data ? `${(reportQuery.data.totals.parRatio * 100).toFixed(1)}%` : '—'} higherIsBetter={false} />
          {bucketEntries.map(([bucket, amount]) => (
            <KpiCard key={bucket} label={`Bucket ${bucket}`} value={formatGhs(amount)} higherIsBetter={false} />
          ))}
        </div>
      </div>
      <DataTable
        columns={[
          { key: 'loan', header: 'Loan', render: (l) => `#${l.loanId}` },
          { key: 'customer', header: 'Customer', render: (l) => `#${l.customerId}` },
          { key: 'outstanding', header: 'Outstanding', render: (l) => formatGhs(l.outstandingPrincipalPesewas), align: 'right' },
          { key: 'days', header: 'Days overdue', render: (l) => l.daysOverdue, align: 'right' },
          { key: 'bucket', header: 'Bucket', render: (l) => (l.bucket ? <StatusBadge status="overdue" label={l.bucket} /> : <StatusBadge status="active" label="Current" />) },
        ]}
        rows={reportQuery.data?.loans ?? []}
        getRowKey={(l) => l.loanId}
        isLoading={reportQuery.isLoading}
        emptyTitle="No disbursed loans to report on"
      />
    </Card>
  );
}

function PolicyRatesCard() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const ratesQuery = useQuery({ queryKey: ['policy-rates'], queryFn: () => api.get<PolicyRate[]>('/loans/policy-rates') });

  return (
    <Card
      title="Policy (reference) rates"
      actions={
        <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> New policy rate
        </Button>
      }
      padded={false}
    >
      <p className="px-4 pt-3 text-[12.5px] text-text-secondary">
        What floating-rate loan offers link to — an offer's rate is this value plus its own spread, recomputed whenever this
        changes and on the offer's own reset cadence.
      </p>
      <DataTable
        columns={[
          { key: 'code', header: 'Code', render: (r) => r.code },
          { key: 'name', header: 'Name', render: (r) => r.name },
          { key: 'rate', header: 'Current rate', render: (r) => formatBps(r.rate_bps) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]}
        rows={ratesQuery.data ?? []}
        getRowKey={(r) => r.id}
        isLoading={ratesQuery.isLoading}
        emptyTitle="No policy rates configured yet"
      />
      <CreatePolicyRateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['policy-rates'] })}
      />
    </Card>
  );
}

function CreatePolicyRateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCode('');
    setName('');
    setRate('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => api.post('/loans/policy-rates', { code, name, rateBps: parsePercentToBps(rate) }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create policy rate'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New policy rate"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Code">{(id) => <input id={id} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={inputClasses} />}</FormField>
        <FormField label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Rate (%)">{(id) => <input id={id} type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function LoanProductsCard({ products, isLoading, canManage }: { products: LoanProduct[]; isLoading: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<LoanProduct | null>(null);

  return (
    <Card
      title="Loan Offers"
      actions={
        canManage && (
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New offer
          </Button>
        )
      }
      padded={false}
    >
      <DataTable
        columns={[
          { key: 'code', header: 'Code', render: (p) => p.code },
          { key: 'name', header: 'Name', render: (p) => p.name },
          { key: 'type', header: 'Type', render: (p) => <span className="capitalize">{p.loan_type}</span> },
          {
            key: 'rate',
            header: 'Rate (p.a.)',
            render: (p) =>
              p.rate_type === 'floating' ? (
                <span title={`reference + ${formatBps(p.spread_bps)} spread, resets ${p.reset_frequency}`}>
                  {formatBps(p.annual_interest_rate_bps)} <span className="text-text-muted">(floating)</span>
                </span>
              ) : (
                formatBps(p.annual_interest_rate_bps)
              ),
          },
          { key: 'term', header: 'Term range', render: (p) => `${p.min_term_months}–${p.max_term_months} mo` },
          { key: 'principal', header: 'Principal range', render: (p) => `${formatGhs(p.min_principal_pesewas)} – ${formatGhs(p.max_principal_pesewas)}` },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
        ]}
        rows={products}
        getRowKey={(p) => p.id}
        isLoading={isLoading}
        onRowClick={canManage ? (p) => setEditProduct(p) : undefined}
        emptyTitle="No loan offers configured yet"
      />
      <CreateLoanProductModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['loan-products'] })}
      />
      <EditLoanProductModal
        product={editProduct}
        onClose={() => setEditProduct(null)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['loan-products'] })}
      />
    </Card>
  );
}

/** Shared fixed/floating rate + concession-bound fields used by both create and edit — kept as one block since the two modals otherwise diverge (create starts blank, edit starts prefilled and PATCHes). */
function RateAndConcessionFields({
  rateType,
  setRateType,
  annualRate,
  setAnnualRate,
  referenceRateId,
  setReferenceRateId,
  spread,
  setSpread,
  resetFrequency,
  setResetFrequency,
  rateFloor,
  setRateFloor,
  spreadFloor,
  setSpreadFloor,
  concessionThreshold,
  setConcessionThreshold,
  policyRates,
}: {
  rateType: 'fixed' | 'floating';
  setRateType: (v: 'fixed' | 'floating') => void;
  annualRate: string;
  setAnnualRate: (v: string) => void;
  referenceRateId: string;
  setReferenceRateId: (v: string) => void;
  spread: string;
  setSpread: (v: string) => void;
  resetFrequency: 'monthly' | 'quarterly' | 'annually';
  setResetFrequency: (v: 'monthly' | 'quarterly' | 'annually') => void;
  rateFloor: string;
  setRateFloor: (v: string) => void;
  spreadFloor: string;
  setSpreadFloor: (v: string) => void;
  concessionThreshold: string;
  setConcessionThreshold: (v: string) => void;
  policyRates: PolicyRate[];
}) {
  return (
    <>
      <FormField label="Rate type">
        {(id) => (
          <select id={id} value={rateType} onChange={(e) => setRateType(e.target.value as typeof rateType)} className={selectClasses}>
            <option value="fixed">Fixed</option>
            <option value="floating">Floating</option>
          </select>
        )}
      </FormField>
      {rateType === 'fixed' ? (
        <>
          <FormField label="Annual interest rate (%)">
            {(id) => <input id={id} type="number" step="0.01" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} className={inputClasses} />}
          </FormField>
          <FormField label="Concession floor — rate can never be negotiated below (%)" hint="Leave blank to not allow any concessions on this offer.">
            {(id) => <input id={id} type="number" step="0.01" value={rateFloor} onChange={(e) => setRateFloor(e.target.value)} className={inputClasses} />}
          </FormField>
        </>
      ) : (
        <>
          <FormField label="Reference (policy) rate">
            {(id) => (
              <select id={id} value={referenceRateId} onChange={(e) => setReferenceRateId(e.target.value)} className={selectClasses}>
                <option value="">Select a policy rate…</option>
                {policyRates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({formatBps(r.rate_bps)})
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Spread / margin (%)">
              {(id) => <input id={id} type="number" step="0.01" value={spread} onChange={(e) => setSpread(e.target.value)} className={inputClasses} />}
            </FormField>
            <FormField label="Reset frequency">
              {(id) => (
                <select id={id} value={resetFrequency} onChange={(e) => setResetFrequency(e.target.value as typeof resetFrequency)} className={selectClasses}>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              )}
            </FormField>
          </div>
          <FormField label="Concession floor — spread can never be negotiated below (%)" hint="Leave blank to not allow any concessions on this offer. The reference rate itself is never negotiable, only the spread.">
            {(id) => <input id={id} type="number" step="0.01" value={spreadFloor} onChange={(e) => setSpreadFloor(e.target.value)} className={inputClasses} />}
          </FormField>
        </>
      )}
      <FormField
        label="Concession approval threshold (%)"
        hint="A concession discounting the rate/spread by more than this many percentage points — or changing term or fees at all — needs branch manager sign-off. Within this window it applies immediately."
      >
        {(id) => <input id={id} type="number" step="0.01" value={concessionThreshold} onChange={(e) => setConcessionThreshold(e.target.value)} className={inputClasses} />}
      </FormField>
    </>
  );
}

const REPAYMENT_FREQUENCY_OPTIONS: { value: 'daily' | 'weekly' | 'biweekly' | 'monthly'; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Bi-weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/** A basis select ('flat' GH₵ amount or '% of principal') plus the single amount input whose unit follows the selected basis — reused for processing fee, insurance fee, and default charge, which all share this shape (see migration 060). */
function BasisAmountField({
  label,
  hint,
  basis,
  setBasis,
  amount,
  setAmount,
}: {
  label: string;
  hint?: string;
  basis: 'flat' | 'percent_of_principal';
  setBasis: (v: 'flat' | 'percent_of_principal') => void;
  amount: string;
  setAmount: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label={`${label} basis`} hint={hint}>
        {(id) => (
          <select id={id} value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)} className={selectClasses}>
            <option value="flat">Flat amount</option>
            <option value="percent_of_principal">% of principal</option>
          </select>
        )}
      </FormField>
      <FormField label={basis === 'flat' ? `${label} (GH₵)` : `${label} (%)`}>
        {(id) => <input id={id} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}
      </FormField>
    </div>
  );
}

/**
 * Loan Duration, fee/charge, and grace-period fields shared by create and
 * edit (item 2 of the loan module amendment). Duration reuses the
 * existing min/max term bounds — durationUnit (days/weeks/months) governs
 * what unit those two numbers are expressed in for THIS offer; every
 * pre-existing offer stays in 'months', unaffected. See migration 060.
 *
 * repaymentGracePeriodDays and installmentGracePeriodDays are DIFFERENT:
 * the former delays the first installment's due date after disbursement,
 * the latter is how many days an installment can sit unpaid past its OWN
 * due date before it counts as missed (drives the loan's 'missed_payment'
 * status and the auto-applied default charge — see Decisions_Log.md).
 */
function OfferDurationAndChargesFields({
  durationUnit,
  setDurationUnit,
  minTerm,
  setMinTerm,
  maxTerm,
  setMaxTerm,
  allowedFrequencies,
  toggleFrequency,
  processingFeeBasis,
  setProcessingFeeBasis,
  processingFeeAmount,
  setProcessingFeeAmount,
  insuranceFeeEnabled,
  setInsuranceFeeEnabled,
  insuranceFeeBasis,
  setInsuranceFeeBasis,
  insuranceFeeAmount,
  setInsuranceFeeAmount,
  defaultChargeBasis,
  setDefaultChargeBasis,
  defaultChargeAmount,
  setDefaultChargeAmount,
  repaymentGracePeriodDays,
  setRepaymentGracePeriodDays,
  installmentGracePeriodDays,
  setInstallmentGracePeriodDays,
}: {
  durationUnit: 'days' | 'weeks' | 'months';
  setDurationUnit: (v: 'days' | 'weeks' | 'months') => void;
  minTerm: string;
  setMinTerm: (v: string) => void;
  maxTerm: string;
  setMaxTerm: (v: string) => void;
  allowedFrequencies: string[];
  toggleFrequency: (v: string) => void;
  processingFeeBasis: 'flat' | 'percent_of_principal';
  setProcessingFeeBasis: (v: 'flat' | 'percent_of_principal') => void;
  processingFeeAmount: string;
  setProcessingFeeAmount: (v: string) => void;
  insuranceFeeEnabled: boolean;
  setInsuranceFeeEnabled: (v: boolean) => void;
  insuranceFeeBasis: 'flat' | 'percent_of_principal';
  setInsuranceFeeBasis: (v: 'flat' | 'percent_of_principal') => void;
  insuranceFeeAmount: string;
  setInsuranceFeeAmount: (v: string) => void;
  defaultChargeBasis: 'flat' | 'percent_of_principal';
  setDefaultChargeBasis: (v: 'flat' | 'percent_of_principal') => void;
  defaultChargeAmount: string;
  setDefaultChargeAmount: (v: string) => void;
  repaymentGracePeriodDays: string;
  setRepaymentGracePeriodDays: (v: string) => void;
  installmentGracePeriodDays: string;
  setInstallmentGracePeriodDays: (v: string) => void;
}) {
  return (
    <>
      <FormField label="Loan Duration unit" hint="Governs the unit the min/max duration below (and the application form's duration input) are expressed in.">
        {(id) => (
          <select id={id} value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as typeof durationUnit)} className={selectClasses}>
            <option value="days">Days</option>
            <option value="weeks">Weeks</option>
            <option value="months">Months</option>
          </select>
        )}
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={`Min duration (${durationUnit})`}>
          {(id) => <input id={id} type="number" min="1" value={minTerm} onChange={(e) => setMinTerm(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label={`Max duration (${durationUnit})`}>
          {(id) => <input id={id} type="number" min="1" value={maxTerm} onChange={(e) => setMaxTerm(e.target.value)} className={inputClasses} />}
        </FormField>
      </div>
      <FormField label="Allowed repayment frequencies" hint="Which cadences an applicant can choose from at application time.">
        {(id) => (
          <div id={id} className="flex flex-wrap gap-3 rounded-md border border-border p-2">
            {REPAYMENT_FREQUENCY_OPTIONS.map((f) => (
              <label key={f.value} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={allowedFrequencies.includes(f.value)} onChange={() => toggleFrequency(f.value)} />
                {f.label}
              </label>
            ))}
          </div>
        )}
      </FormField>
      <BasisAmountField label="Processing fee" basis={processingFeeBasis} setBasis={setProcessingFeeBasis} amount={processingFeeAmount} setAmount={setProcessingFeeAmount} />
      <FormField label="Insurance fee" hint="Optional — leave unchecked if this offer has no insurance fee.">
        {(id) => (
          <label id={id} className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={insuranceFeeEnabled} onChange={(e) => setInsuranceFeeEnabled(e.target.checked)} />
            This offer charges an insurance fee
          </label>
        )}
      </FormField>
      {insuranceFeeEnabled && (
        <BasisAmountField label="Insurance fee" basis={insuranceFeeBasis} setBasis={setInsuranceFeeBasis} amount={insuranceFeeAmount} setAmount={setInsuranceFeeAmount} />
      )}
      <FormField label="Repayment grace period (days)" hint="Days after disbursement before the borrower's first repayment obligation starts at all.">
        {(id) => <input id={id} type="number" min="0" value={repaymentGracePeriodDays} onChange={(e) => setRepaymentGracePeriodDays(e.target.value)} className={inputClasses} />}
      </FormField>
      <BasisAmountField
        label="Default charge"
        hint="Charged once per installment that goes missed (see installment grace period below) — distinct from the repayment grace period above."
        basis={defaultChargeBasis}
        setBasis={setDefaultChargeBasis}
        amount={defaultChargeAmount}
        setAmount={setDefaultChargeAmount}
      />
      <FormField
        label="Installment grace period (days)"
        hint="Days AFTER an installment's own due date before it's marked missed and the default charge above applies — not the same as the repayment grace period, which only delays the FIRST installment."
      >
        {(id) => (
          <input id={id} type="number" min="0" value={installmentGracePeriodDays} onChange={(e) => setInstallmentGracePeriodDays(e.target.value)} className={inputClasses} />
        )}
      </FormField>
    </>
  );
}

function CreateLoanProductModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const policyRatesQuery = useQuery({ queryKey: ['policy-rates'], queryFn: () => api.get<PolicyRate[]>('/loans/policy-rates'), enabled: open });
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [loanType, setLoanType] = useState<'individual' | 'group' | 'overdraft'>('individual');
  const [interestMethod, setInterestMethod] = useState<'flat' | 'reducing_balance'>('reducing_balance');
  const [rateType, setRateType] = useState<'fixed' | 'floating'>('fixed');
  const [annualRate, setAnnualRate] = useState('');
  const [referenceRateId, setReferenceRateId] = useState('');
  const [spread, setSpread] = useState('');
  const [resetFrequency, setResetFrequency] = useState<'monthly' | 'quarterly' | 'annually'>('monthly');
  const [rateFloor, setRateFloor] = useState('');
  const [spreadFloor, setSpreadFloor] = useState('');
  const [concessionThreshold, setConcessionThreshold] = useState('0');
  const [durationUnit, setDurationUnit] = useState<'days' | 'weeks' | 'months'>('months');
  const [minTerm, setMinTerm] = useState('');
  const [maxTerm, setMaxTerm] = useState('');
  const [minPrincipal, setMinPrincipal] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [allowedFrequencies, setAllowedFrequencies] = useState<string[]>(['monthly']);
  const [processingFeeBasis, setProcessingFeeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [processingFeeAmount, setProcessingFeeAmount] = useState('0');
  const [insuranceFeeEnabled, setInsuranceFeeEnabled] = useState(false);
  const [insuranceFeeBasis, setInsuranceFeeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [insuranceFeeAmount, setInsuranceFeeAmount] = useState('0');
  const [defaultChargeBasis, setDefaultChargeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [defaultChargeAmount, setDefaultChargeAmount] = useState('0');
  const [repaymentGracePeriodDays, setRepaymentGracePeriodDays] = useState('0');
  const [installmentGracePeriodDays, setInstallmentGracePeriodDays] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const toggleFrequency = (v: string) =>
    setAllowedFrequencies((prev) => (prev.includes(v) ? prev.filter((f) => f !== v) : [...prev, v]));

  function reset() {
    setName('');
    setCode('');
    setDescription('');
    setLoanType('individual');
    setInterestMethod('reducing_balance');
    setRateType('fixed');
    setAnnualRate('');
    setReferenceRateId('');
    setSpread('');
    setResetFrequency('monthly');
    setRateFloor('');
    setSpreadFloor('');
    setConcessionThreshold('0');
    setDurationUnit('months');
    setMinTerm('');
    setMaxTerm('');
    setMinPrincipal('');
    setMaxPrincipal('');
    setAllowedFrequencies(['monthly']);
    setProcessingFeeBasis('flat');
    setProcessingFeeAmount('0');
    setInsuranceFeeEnabled(false);
    setInsuranceFeeBasis('flat');
    setInsuranceFeeAmount('0');
    setDefaultChargeBasis('flat');
    setDefaultChargeAmount('0');
    setRepaymentGracePeriodDays('0');
    setInstallmentGracePeriodDays('0');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/loans/products', {
        name,
        code,
        description: description || null,
        loanType,
        interestMethod,
        rateType,
        annualInterestRateBps: rateType === 'fixed' ? parsePercentToBps(annualRate) : undefined,
        referenceRateId: rateType === 'floating' ? referenceRateId : undefined,
        spreadBps: rateType === 'floating' ? parsePercentToBps(spread) : undefined,
        resetFrequency: rateType === 'floating' ? resetFrequency : undefined,
        minRateFloorBps: rateType === 'fixed' && rateFloor ? parsePercentToBps(rateFloor) : null,
        minSpreadFloorBps: rateType === 'floating' && spreadFloor ? parsePercentToBps(spreadFloor) : null,
        concessionApprovalThresholdBps: parsePercentToBps(concessionThreshold),
        allowedRepaymentFrequencies: allowedFrequencies,
        durationUnit,
        minTermMonths: Number(minTerm),
        maxTermMonths: Number(maxTerm),
        minPrincipalPesewas: parseGhsInput(minPrincipal),
        maxPrincipalPesewas: parseGhsInput(maxPrincipal),
        processingFeeBasis,
        processingFeeAmountPesewas: processingFeeBasis === 'flat' ? parseGhsInput(processingFeeAmount) : undefined,
        processingFeeRateBps: processingFeeBasis === 'percent_of_principal' ? parsePercentToBps(processingFeeAmount) : undefined,
        insuranceFeeBasis: insuranceFeeEnabled ? insuranceFeeBasis : null,
        insuranceFeeAmountPesewas: insuranceFeeEnabled && insuranceFeeBasis === 'flat' ? parseGhsInput(insuranceFeeAmount) : undefined,
        insuranceFeeRateBps: insuranceFeeEnabled && insuranceFeeBasis === 'percent_of_principal' ? parsePercentToBps(insuranceFeeAmount) : undefined,
        defaultChargeBasis,
        defaultChargeAmountPesewas: defaultChargeBasis === 'flat' ? parseGhsInput(defaultChargeAmount) : undefined,
        defaultChargeRateBps: defaultChargeBasis === 'percent_of_principal' ? parsePercentToBps(defaultChargeAmount) : undefined,
        repaymentGracePeriodDays: Number(repaymentGracePeriodDays),
        installmentGracePeriodDays: Number(installmentGracePeriodDays),
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create loan offer'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New loan offer"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create offer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Code">{(id) => <input id={id} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={inputClasses} />}</FormField>
        <FormField label="Description">
          {(id) => <textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Loan type">
          {(id) => (
            <select id={id} value={loanType} onChange={(e) => setLoanType(e.target.value as typeof loanType)} className={selectClasses}>
              <option value="individual">Individual</option>
              <option value="group">Group</option>
              <option value="overdraft">Overdraft</option>
            </select>
          )}
        </FormField>
        <FormField label="Interest Basis" hint="How interest is calculated — the same concept as this offer's fixed/floating rate TYPE below is a separate axis (what the rate itself is pegged to).">
          {(id) => (
            <select id={id} value={interestMethod} onChange={(e) => setInterestMethod(e.target.value as typeof interestMethod)} className={selectClasses}>
              <option value="reducing_balance">Reducing balance</option>
              <option value="flat">Flat</option>
            </select>
          )}
        </FormField>
        <RateAndConcessionFields
          rateType={rateType}
          setRateType={setRateType}
          annualRate={annualRate}
          setAnnualRate={setAnnualRate}
          referenceRateId={referenceRateId}
          setReferenceRateId={setReferenceRateId}
          spread={spread}
          setSpread={setSpread}
          resetFrequency={resetFrequency}
          setResetFrequency={setResetFrequency}
          rateFloor={rateFloor}
          setRateFloor={setRateFloor}
          spreadFloor={spreadFloor}
          setSpreadFloor={setSpreadFloor}
          concessionThreshold={concessionThreshold}
          setConcessionThreshold={setConcessionThreshold}
          policyRates={policyRatesQuery.data ?? []}
        />
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min principal (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={minPrincipal} onChange={(e) => setMinPrincipal(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Max principal (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={maxPrincipal} onChange={(e) => setMaxPrincipal(e.target.value)} className={inputClasses} />}</FormField>
        </div>
        <OfferDurationAndChargesFields
          durationUnit={durationUnit}
          setDurationUnit={setDurationUnit}
          minTerm={minTerm}
          setMinTerm={setMinTerm}
          maxTerm={maxTerm}
          setMaxTerm={setMaxTerm}
          allowedFrequencies={allowedFrequencies}
          toggleFrequency={toggleFrequency}
          processingFeeBasis={processingFeeBasis}
          setProcessingFeeBasis={setProcessingFeeBasis}
          processingFeeAmount={processingFeeAmount}
          setProcessingFeeAmount={setProcessingFeeAmount}
          insuranceFeeEnabled={insuranceFeeEnabled}
          setInsuranceFeeEnabled={setInsuranceFeeEnabled}
          insuranceFeeBasis={insuranceFeeBasis}
          setInsuranceFeeBasis={setInsuranceFeeBasis}
          insuranceFeeAmount={insuranceFeeAmount}
          setInsuranceFeeAmount={setInsuranceFeeAmount}
          defaultChargeBasis={defaultChargeBasis}
          setDefaultChargeBasis={setDefaultChargeBasis}
          defaultChargeAmount={defaultChargeAmount}
          setDefaultChargeAmount={setDefaultChargeAmount}
          repaymentGracePeriodDays={repaymentGracePeriodDays}
          setRepaymentGracePeriodDays={setRepaymentGracePeriodDays}
          installmentGracePeriodDays={installmentGracePeriodDays}
          setInstallmentGracePeriodDays={setInstallmentGracePeriodDays}
        />
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function EditLoanProductModal({ product, onClose, onSaved }: { product: LoanProduct | null; onClose: () => void; onSaved: () => void }) {
  const policyRatesQuery = useQuery({ queryKey: ['policy-rates'], queryFn: () => api.get<PolicyRate[]>('/loans/policy-rates'), enabled: !!product });
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [description, setDescription] = useState('');
  const [rateType, setRateType] = useState<'fixed' | 'floating'>('fixed');
  const [annualRate, setAnnualRate] = useState('');
  const [referenceRateId, setReferenceRateId] = useState('');
  const [spread, setSpread] = useState('');
  const [resetFrequency, setResetFrequency] = useState<'monthly' | 'quarterly' | 'annually'>('monthly');
  const [rateFloor, setRateFloor] = useState('');
  const [spreadFloor, setSpreadFloor] = useState('');
  const [concessionThreshold, setConcessionThreshold] = useState('0');
  const [durationUnit, setDurationUnit] = useState<'days' | 'weeks' | 'months'>('months');
  const [minTerm, setMinTerm] = useState('');
  const [maxTerm, setMaxTerm] = useState('');
  const [allowedFrequencies, setAllowedFrequencies] = useState<string[]>(['monthly']);
  const [processingFeeBasis, setProcessingFeeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [processingFeeAmount, setProcessingFeeAmount] = useState('0');
  const [insuranceFeeEnabled, setInsuranceFeeEnabled] = useState(false);
  const [insuranceFeeBasis, setInsuranceFeeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [insuranceFeeAmount, setInsuranceFeeAmount] = useState('0');
  const [defaultChargeBasis, setDefaultChargeBasis] = useState<'flat' | 'percent_of_principal'>('flat');
  const [defaultChargeAmount, setDefaultChargeAmount] = useState('0');
  const [repaymentGracePeriodDays, setRepaymentGracePeriodDays] = useState('0');
  const [installmentGracePeriodDays, setInstallmentGracePeriodDays] = useState('0');
  const [error, setError] = useState<string | null>(null);

  const toggleFrequency = (v: string) =>
    setAllowedFrequencies((prev) => (prev.includes(v) ? prev.filter((f) => f !== v) : [...prev, v]));

  // Reset local state to the product's current values whenever a different
  // (or no) product is opened for editing — this modal is mounted once and
  // reused, not remounted per-row.
  const [loadedProductId, setLoadedProductId] = useState<string | null>(null);
  if (product && product.id !== loadedProductId) {
    setLoadedProductId(product.id);
    setStatus(product.status);
    setDescription(product.description ?? '');
    setRateType(product.rate_type);
    setAnnualRate(product.rate_type === 'fixed' ? (product.annual_interest_rate_bps / 100).toString() : '');
    setReferenceRateId(product.reference_rate_id ?? '');
    setSpread(product.spread_bps !== null ? (product.spread_bps / 100).toString() : '');
    setResetFrequency(product.reset_frequency ?? 'monthly');
    setRateFloor(product.min_rate_floor_bps !== null ? (product.min_rate_floor_bps / 100).toString() : '');
    setSpreadFloor(product.min_spread_floor_bps !== null ? (product.min_spread_floor_bps / 100).toString() : '');
    setConcessionThreshold((product.concession_approval_threshold_bps / 100).toString());
    setDurationUnit(product.duration_unit);
    setMinTerm(product.min_term_months.toString());
    setMaxTerm(product.max_term_months.toString());
    setAllowedFrequencies(product.allowed_repayment_frequencies);
    setProcessingFeeBasis(product.processing_fee_basis);
    setProcessingFeeAmount(
      product.processing_fee_basis === 'flat'
        ? ((product.processing_fee_amount_pesewas ?? 0) / 100).toString()
        : ((product.processing_fee_rate_bps ?? 0) / 100).toString()
    );
    setInsuranceFeeEnabled(product.insurance_fee_basis !== null);
    setInsuranceFeeBasis(product.insurance_fee_basis ?? 'flat');
    setInsuranceFeeAmount(
      product.insurance_fee_basis === 'flat'
        ? ((product.insurance_fee_amount_pesewas ?? 0) / 100).toString()
        : ((product.insurance_fee_rate_bps ?? 0) / 100).toString()
    );
    setDefaultChargeBasis(product.default_charge_basis);
    setDefaultChargeAmount(
      product.default_charge_basis === 'flat'
        ? ((product.default_charge_amount_pesewas ?? 0) / 100).toString()
        : ((product.default_charge_rate_bps ?? 0) / 100).toString()
    );
    setRepaymentGracePeriodDays(product.repayment_grace_period_days.toString());
    setInstallmentGracePeriodDays(product.installment_grace_period_days.toString());
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.patch(`/loans/products/${product!.id}`, {
        status,
        description: description || null,
        rateType,
        annualInterestRateBps: rateType === 'fixed' ? parsePercentToBps(annualRate) : undefined,
        referenceRateId: rateType === 'floating' ? referenceRateId : undefined,
        spreadBps: rateType === 'floating' ? parsePercentToBps(spread) : undefined,
        resetFrequency: rateType === 'floating' ? resetFrequency : undefined,
        minRateFloorBps: rateType === 'fixed' && rateFloor ? parsePercentToBps(rateFloor) : null,
        minSpreadFloorBps: rateType === 'floating' && spreadFloor ? parsePercentToBps(spreadFloor) : null,
        concessionApprovalThresholdBps: parsePercentToBps(concessionThreshold),
        allowedRepaymentFrequencies: allowedFrequencies,
        durationUnit,
        minTermMonths: Number(minTerm),
        maxTermMonths: Number(maxTerm),
        processingFeeBasis,
        processingFeeAmountPesewas: processingFeeBasis === 'flat' ? parseGhsInput(processingFeeAmount) : undefined,
        processingFeeRateBps: processingFeeBasis === 'percent_of_principal' ? parsePercentToBps(processingFeeAmount) : undefined,
        insuranceFeeBasis: insuranceFeeEnabled ? insuranceFeeBasis : null,
        insuranceFeeAmountPesewas: insuranceFeeEnabled && insuranceFeeBasis === 'flat' ? parseGhsInput(insuranceFeeAmount) : undefined,
        insuranceFeeRateBps: insuranceFeeEnabled && insuranceFeeBasis === 'percent_of_principal' ? parsePercentToBps(insuranceFeeAmount) : undefined,
        defaultChargeBasis,
        defaultChargeAmountPesewas: defaultChargeBasis === 'flat' ? parseGhsInput(defaultChargeAmount) : undefined,
        defaultChargeRateBps: defaultChargeBasis === 'percent_of_principal' ? parsePercentToBps(defaultChargeAmount) : undefined,
        repaymentGracePeriodDays: Number(repaymentGracePeriodDays),
        installmentGracePeriodDays: Number(installmentGracePeriodDays),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to update loan offer'),
  });

  return (
    <Modal
      open={!!product}
      onClose={onClose}
      title={product ? `Edit ${product.code}` : 'Edit offer'}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      {product && (
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-text-secondary">
            Editing terms here only affects future applications — loans already applied for keep their own snapshotted rate,
            term, and fees regardless of what changes here.
          </p>
          <FormField label="Status">
            {(id) => (
              <select id={id} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={selectClasses}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            )}
          </FormField>
          <FormField label="Description">
            {(id) => <textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={inputClasses} />}
          </FormField>
          <RateAndConcessionFields
            rateType={rateType}
            setRateType={setRateType}
            annualRate={annualRate}
            setAnnualRate={setAnnualRate}
            referenceRateId={referenceRateId}
            setReferenceRateId={setReferenceRateId}
            spread={spread}
            setSpread={setSpread}
            resetFrequency={resetFrequency}
            setResetFrequency={setResetFrequency}
            rateFloor={rateFloor}
            setRateFloor={setRateFloor}
            spreadFloor={spreadFloor}
            setSpreadFloor={setSpreadFloor}
            concessionThreshold={concessionThreshold}
            setConcessionThreshold={setConcessionThreshold}
            policyRates={policyRatesQuery.data ?? []}
          />
          <OfferDurationAndChargesFields
            durationUnit={durationUnit}
            setDurationUnit={setDurationUnit}
            minTerm={minTerm}
            setMinTerm={setMinTerm}
            maxTerm={maxTerm}
            setMaxTerm={setMaxTerm}
            allowedFrequencies={allowedFrequencies}
            toggleFrequency={toggleFrequency}
            processingFeeBasis={processingFeeBasis}
            setProcessingFeeBasis={setProcessingFeeBasis}
            processingFeeAmount={processingFeeAmount}
            setProcessingFeeAmount={setProcessingFeeAmount}
            insuranceFeeEnabled={insuranceFeeEnabled}
            setInsuranceFeeEnabled={setInsuranceFeeEnabled}
            insuranceFeeBasis={insuranceFeeBasis}
            setInsuranceFeeBasis={setInsuranceFeeBasis}
            insuranceFeeAmount={insuranceFeeAmount}
            setInsuranceFeeAmount={setInsuranceFeeAmount}
            defaultChargeBasis={defaultChargeBasis}
            setDefaultChargeBasis={setDefaultChargeBasis}
            defaultChargeAmount={defaultChargeAmount}
            setDefaultChargeAmount={setDefaultChargeAmount}
            repaymentGracePeriodDays={repaymentGracePeriodDays}
            setRepaymentGracePeriodDays={setRepaymentGracePeriodDays}
            installmentGracePeriodDays={installmentGracePeriodDays}
            setInstallmentGracePeriodDays={setInstallmentGracePeriodDays}
          />
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
