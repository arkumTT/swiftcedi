import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
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
import { FormField, inputClasses, selectClasses } from '../../../components/FormField';
import { formatDate, formatGhs, formatBps, parseGhsInput } from '../../../lib/format';
import type { Investment, InvestmentProduct } from '../../../types/api';

const INVESTMENT_STATUSES = ['applied', 'pending_approval', 'rejected', 'approved', 'active', 'matured', 'redeemed'];

export function InvestmentsListPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const productsQuery = useQuery({ queryKey: ['investment-products'], queryFn: () => api.get<InvestmentProduct[]>('/investments/products') });

  const investmentsQuery = useQuery({
    queryKey: ['investments', { branchId, status, productId }],
    queryFn: () => api.get<Investment[]>('/investments', { branchId: crossBranch ? branchId : user!.homeBranchId, status, productId }),
  });

  const columns: Column<Investment>[] = [
    { key: 'id', header: 'Investment', render: (i) => `#${i.id}` },
    { key: 'customer', header: 'Customer', render: (i) => `#${i.customer_id}` },
    { key: 'product', header: 'Product', render: (i) => productsQuery.data?.find((p) => p.id === i.product_id)?.name ?? `#${i.product_id}` },
    { key: 'principal', header: 'Principal', render: (i) => formatGhs(i.principal_pesewas), align: 'right' },
    { key: 'tenor', header: 'Tenor', render: (i) => `${i.tenor_months} mo` },
    { key: 'maturity', header: 'Maturity', render: (i) => formatDate(i.maturity_date) },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Investments"
        actions={
          hasPermission('investment.book') && (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New investment
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
            {INVESTMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={investmentsQuery.data ?? []}
          getRowKey={(i) => i.id}
          isLoading={investmentsQuery.isLoading}
          error={investmentsQuery.error instanceof ApiError ? investmentsQuery.error.message : null}
          onRetry={() => investmentsQuery.refetch()}
          onRowClick={(i) => navigate(`/app/investments/${i.id}`)}
          emptyTitle="No investments match these filters"
        />
      </Card>

      <InvestmentProductsCard products={productsQuery.data ?? []} isLoading={productsQuery.isLoading} canManage={hasPermission('investment.manage_products')} />

      <CreateInvestmentModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        products={(productsQuery.data ?? []).filter((p) => p.status === 'active')}
        onCreated={(investmentId) => {
          queryClient.invalidateQueries({ queryKey: ['investments'] });
          navigate(`/app/investments/${investmentId}`);
        }}
      />
    </div>
  );
}

function CreateInvestmentModal({
  open,
  onClose,
  products,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  products: InvestmentProduct[];
  onCreated: (investmentId: string) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedProduct = products.find((p) => p.id === productId);

  function reset() {
    setCustomerId('');
    setProductId('');
    setPrincipal('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/investments', {
        customerId: Number(customerId),
        productId,
        principalPesewas: parseGhsInput(principal),
      }),
    onSuccess: (investment) => {
      onCreated(investment.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to book investment'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New investment"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Book investment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Customer ID" hint="Customer must be active and KYC-verified.">
          {(id) => <input id={id} type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Product">
          {(id) => (
            <select id={id} value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses}>
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({formatBps(p.annual_interest_rate_bps)} p.a., {p.tenor_months} mo)
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField
          label="Principal (GH₵)"
          hint={
            selectedProduct
              ? `Min ${formatGhs(selectedProduct.min_principal_pesewas)}${selectedProduct.max_principal_pesewas ? ` – max ${formatGhs(selectedProduct.max_principal_pesewas)}` : ''}`
              : undefined
          }
        >
          {(id) => <input id={id} type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} className={inputClasses} />}
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

function InvestmentProductsCard({ products, isLoading, canManage }: { products: InvestmentProduct[]; isLoading: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Card
      title="Investment products"
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
          { key: 'rate', header: 'Rate (p.a.)', render: (p) => formatBps(p.annual_interest_rate_bps) },
          { key: 'tenor', header: 'Tenor', render: (p) => `${p.tenor_months} mo` },
          { key: 'principal', header: 'Min principal', render: (p) => formatGhs(p.min_principal_pesewas) },
          { key: 'frequency', header: 'Payout frequency', render: (p) => <span className="capitalize">{p.payout_frequency.replace(/_/g, ' ')}</span> },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
        ]}
        rows={products}
        getRowKey={(p) => p.id}
        isLoading={isLoading}
        emptyTitle="No investment products configured yet"
      />
      <CreateInvestmentProductModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['investment-products'] })} />
    </Card>
  );
}

function CreateInvestmentProductModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [tenorMonths, setTenorMonths] = useState('');
  const [annualRate, setAnnualRate] = useState('');
  const [minPrincipal, setMinPrincipal] = useState('');
  const [maxPrincipal, setMaxPrincipal] = useState('');
  const [payoutFrequency, setPayoutFrequency] = useState<'monthly' | 'at_maturity'>('monthly');
  const [earlyPenalty, setEarlyPenalty] = useState('0');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setCode('');
    setTenorMonths('');
    setAnnualRate('');
    setMinPrincipal('');
    setMaxPrincipal('');
    setPayoutFrequency('monthly');
    setEarlyPenalty('0');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/investments/products', {
        name,
        code,
        tenorMonths: Number(tenorMonths),
        annualInterestRateBps: Math.round(Number(annualRate) * 100),
        minPrincipalPesewas: parseGhsInput(minPrincipal),
        maxPrincipalPesewas: maxPrincipal ? parseGhsInput(maxPrincipal) : undefined,
        payoutFrequency,
        earlyWithdrawalPenaltyBps: Math.round(Number(earlyPenalty) * 100),
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create investment product'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New investment product"
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
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tenor (months)">{(id) => <input id={id} type="number" value={tenorMonths} onChange={(e) => setTenorMonths(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Annual interest rate (%)">{(id) => <input id={id} type="number" step="0.01" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} className={inputClasses} />}</FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min principal (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={minPrincipal} onChange={(e) => setMinPrincipal(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Max principal (GH₵, optional)">{(id) => <input id={id} type="number" step="0.01" value={maxPrincipal} onChange={(e) => setMaxPrincipal(e.target.value)} className={inputClasses} />}</FormField>
        </div>
        <FormField label="Payout frequency">
          {(id) => (
            <select id={id} value={payoutFrequency} onChange={(e) => setPayoutFrequency(e.target.value as typeof payoutFrequency)} className={selectClasses}>
              <option value="monthly">Monthly</option>
              <option value="at_maturity">At maturity</option>
            </select>
          )}
        </FormField>
        <FormField label="Early withdrawal penalty (% of accrued interest)">
          {(id) => <input id={id} type="number" step="0.01" value={earlyPenalty} onChange={(e) => setEarlyPenalty(e.target.value)} className={inputClasses} />}
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
