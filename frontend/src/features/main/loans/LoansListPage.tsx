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
import { formatDate, formatGhs, formatBps, parseGhsInput } from '../../../lib/format';
import type { Loan, LoanProduct, ArrearsReport, LoanCalculatorResult } from '../../../types/api';

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

function LoanProductsCard({ products, isLoading, canManage }: { products: LoanProduct[]; isLoading: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

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
          { key: 'rate', header: 'Rate (p.a.)', render: (p) => formatBps(p.annual_interest_rate_bps) },
          { key: 'term', header: 'Term range', render: (p) => `${p.min_term_months}–${p.max_term_months} mo` },
          { key: 'principal', header: 'Principal range', render: (p) => `${formatGhs(p.min_principal_pesewas)} – ${formatGhs(p.max_principal_pesewas)}` },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
        ]}
        rows={products}
        getRowKey={(p) => p.id}
        isLoading={isLoading}
        emptyTitle="No loan products configured yet"
      />
      <CreateLoanProductModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['loan-products'] })}
      />
    </Card>
  );
}

function CreateLoanProductModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [loanType, setLoanType] = useState<'individual' | 'group' | 'overdraft'>('individual');
  const [interestMethod, setInterestMethod] = useState<'flat' | 'reducing_balance'>('reducing_balance');
  const [annualRate, setAnnualRate] = useState('');
  const [minTerm, setMinTerm] = useState('');
  const [maxTerm, setMaxTerm] = useState('');
  const [minPrincipal, setMinPrincipal] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setCode('');
    setLoanType('individual');
    setInterestMethod('reducing_balance');
    setAnnualRate('');
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
        loanType,
        interestMethod,
        annualInterestRateBps: Math.round(Number(annualRate) * 100),
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
        <FormField label="Annual interest rate (%)">
          {(id) => <input id={id} type="number" step="0.01" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} className={inputClasses} />}
        </FormField>
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
