import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Calculator, ShieldAlert } from 'lucide-react';
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
import type { Loan, LoanProduct, PolicyRate, ArrearsReport, LoanCalculatorResult } from '../../../types/api';

const LOAN_STATUSES = ['applied', 'appraised', 'pending_approval', 'approved', 'rejected', 'disbursed', 'closed', 'written_off'];

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

  const columns: Column<Loan>[] = [
    { key: 'id', header: 'Loan', render: (l) => `#${l.id}` },
    { key: 'customer', header: 'Customer', render: (l) => `#${l.customer_id}` },
    { key: 'type', header: 'Type', render: (l) => <span className="capitalize">{l.loan_type}</span> },
    { key: 'product', header: 'Product', render: (l) => productsQuery.data?.find((p) => p.id === l.product_id)?.name ?? `#${l.product_id}` },
    { key: 'principal', header: 'Principal', render: (l) => formatGhs(l.principal_pesewas), align: 'right' },
    { key: 'term', header: 'Term', render: (l) => `${l.term_months} mo` },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} /> },
    { key: 'created', header: 'Applied', render: (l) => formatDate(l.created_at) },
  ];

  return (
    <div className="flex flex-col gap-4">
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
            <option value="">All products</option>
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
          rows={loansQuery.data ?? []}
          getRowKey={(l) => l.id}
          isLoading={loansQuery.isLoading}
          error={loansQuery.error instanceof ApiError ? loansQuery.error.message : null}
          onRetry={() => loansQuery.refetch()}
          onRowClick={(l) => navigate(`/app/loans/${l.id}`)}
          emptyTitle="No loans match these filters"
        />
      </Card>

      <LoanCalculatorCard products={productsQuery.data ?? []} />

      {hasPermission('loan.view_reports') && <ArrearsReportCard crossBranch={crossBranch} branches={branches ?? []} defaultBranchId={crossBranch ? '' : user!.homeBranchId} />}

      {hasPermission('loan.manage_policy_rates') && <PolicyRatesCard />}

      <LoanProductsCard products={productsQuery.data ?? []} isLoading={productsQuery.isLoading} canManage={hasPermission('loan.manage_products')} />

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
        <FormField label="Loan product">
          {(id) => (
            <select id={id} value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses}>
              <option value="">Select a product…</option>
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
        <FormField label="Product">
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
        What floating-rate loan products link to — a product's rate is this value plus its own spread, recomputed whenever this
        changes and on the product's own reset cadence.
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
      title="Loan products"
      actions={
        canManage && (
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New product
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
        emptyTitle="No loan products configured yet"
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
          <FormField label="Concession floor — rate can never be negotiated below (%)" hint="Leave blank to not allow any concessions on this product.">
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
          <FormField label="Concession floor — spread can never be negotiated below (%)" hint="Leave blank to not allow any concessions on this product. The reference rate itself is never negotiable, only the spread.">
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
  const [minTerm, setMinTerm] = useState('');
  const [maxTerm, setMaxTerm] = useState('');
  const [minPrincipal, setMinPrincipal] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    setMinTerm('');
    setMaxTerm('');
    setMinPrincipal('');
    setMaxPrincipal('');
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
        minTermMonths: Number(minTerm),
        maxTermMonths: Number(maxTerm),
        minPrincipalPesewas: parseGhsInput(minPrincipal),
        maxPrincipalPesewas: parseGhsInput(maxPrincipal),
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create loan product'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New loan product"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create product
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
        <FormField label="Interest method">
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
          <FormField label="Min term (months)">{(id) => <input id={id} type="number" value={minTerm} onChange={(e) => setMinTerm(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Max term (months)">{(id) => <input id={id} type="number" value={maxTerm} onChange={(e) => setMaxTerm(e.target.value)} className={inputClasses} />}</FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min principal (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={minPrincipal} onChange={(e) => setMinPrincipal(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Max principal (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={maxPrincipal} onChange={(e) => setMaxPrincipal(e.target.value)} className={inputClasses} />}</FormField>
        </div>
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
  const [error, setError] = useState<string | null>(null);

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
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to update loan product'),
  });

  return (
    <Modal
      open={!!product}
      onClose={onClose}
      title={product ? `Edit ${product.code}` : 'Edit product'}
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
