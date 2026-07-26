import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Repeat } from 'lucide-react';
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
import { formatDate, formatGhs, parseGhsInput, parsePercentToBps } from '../../../lib/format';
import type { SavingsAccount, SavingsProduct, SusuAccount, StandingOrder } from '../../../types/api';

export function SavingsSusuPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();
  const [view, setView] = useState<'savings' | 'susu'>('savings');

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const productsQuery = useQuery({ queryKey: ['savings-products'], queryFn: () => api.get<SavingsProduct[]>('/savings/products') });

  const savingsQuery = useQuery({
    queryKey: ['savings-accounts', { branchId, status }],
    queryFn: () => api.get<SavingsAccount[]>('/savings', { branchId: crossBranch ? branchId : user!.homeBranchId, status }),
    enabled: view === 'savings',
  });
  const susuQuery = useQuery({
    queryKey: ['susu-accounts', { branchId, status }],
    queryFn: () => api.get<SusuAccount[]>('/susu', { branchId: crossBranch ? branchId : user!.homeBranchId, status }),
    enabled: view === 'susu',
  });

  const savingsColumns: Column<SavingsAccount>[] = [
    { key: 'account', header: 'Account no.', render: (a) => a.account_no },
    { key: 'customer', header: 'Customer', render: (a) => `#${a.customer_id}` },
    { key: 'product', header: 'Product', render: (a) => productsQuery.data?.find((p) => p.id === a.product_id)?.name ?? `#${a.product_id}` },
    { key: 'balance', header: 'Balance', render: (a) => formatGhs(a.balance_pesewas), align: 'right' },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'opened', header: 'Opened', render: (a) => formatDate(a.opened_at) },
  ];
  const susuColumns: Column<SusuAccount>[] = [
    { key: 'account', header: 'Account no.', render: (a) => a.account_no },
    { key: 'customer', header: 'Customer', render: (a) => `#${a.customer_id}` },
    { key: 'progress', header: 'Collected / target', render: (a) => `${formatGhs(a.collected_pesewas)} / ${formatGhs(a.target_amount_pesewas)}` },
    { key: 'cycle', header: 'Cycle ends', render: (a) => formatDate(a.cycle_end_date) },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Savings & Susu"
        actions={
          (view === 'savings' ? hasPermission('savings.open_account') : hasPermission('susu.manage_accounts')) && (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> {view === 'savings' ? 'Open savings account' : 'Open susu account'}
            </Button>
          )
        }
        padded={false}
      >
        <FilterToolbar
          chips={[
            { label: 'Savings accounts', active: view === 'savings', onClick: () => setView('savings') },
            { label: 'Susu accounts', active: view === 'susu', onClick: () => setView('susu') },
          ]}
        >
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
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            {view === 'savings' ? (
              <>
                <option value="active">Active</option>
                <option value="dormant">Dormant</option>
                <option value="closed">Closed</option>
              </>
            ) : (
              <>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="uncompleted">Uncompleted</option>
                <option value="paid_out">Paid out</option>
              </>
            )}
          </select>
        </FilterToolbar>
        {view === 'savings' ? (
          <DataTable
            columns={savingsColumns}
            rows={savingsQuery.data ?? []}
            getRowKey={(a) => a.id}
            isLoading={savingsQuery.isLoading}
            error={savingsQuery.error instanceof ApiError ? savingsQuery.error.message : null}
            onRetry={() => savingsQuery.refetch()}
            onRowClick={(a) => navigate(`/app/savings/accounts/${a.id}`)}
            emptyTitle="No savings accounts match these filters"
          />
        ) : (
          <DataTable
            columns={susuColumns}
            rows={susuQuery.data ?? []}
            getRowKey={(a) => a.id}
            isLoading={susuQuery.isLoading}
            error={susuQuery.error instanceof ApiError ? susuQuery.error.message : null}
            onRetry={() => susuQuery.refetch()}
            onRowClick={(a) => navigate(`/app/savings/susu/${a.id}`)}
            emptyTitle="No susu accounts match these filters"
          />
        )}
      </Card>

      <StandingOrdersCard canManage={hasPermission('standing_order.manage')} />

      <SavingsProductsCard products={productsQuery.data ?? []} isLoading={productsQuery.isLoading} canManage={hasPermission('savings.manage_products')} />

      {view === 'savings' ? (
        <CreateSavingsAccountModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          products={(productsQuery.data ?? []).filter((p) => p.status === 'active')}
          defaultBranchId={crossBranch ? '' : user!.homeBranchId}
          onCreated={(id) => {
            queryClient.invalidateQueries({ queryKey: ['savings-accounts'] });
            navigate(`/app/savings/accounts/${id}`);
          }}
        />
      ) : (
        <CreateSusuAccountModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          defaultBranchId={crossBranch ? '' : user!.homeBranchId}
          onCreated={(id) => {
            queryClient.invalidateQueries({ queryKey: ['susu-accounts'] });
            navigate(`/app/savings/susu/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateSavingsAccountModal({
  open,
  onClose,
  products,
  defaultBranchId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  products: SavingsProduct[];
  defaultBranchId: string;
  onCreated: (accountId: string) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCustomerId('');
    setProductId('');
    setBranchId(defaultBranchId);
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => api.post<{ id: string }>('/savings', { customerId: Number(customerId), productId, branchId }),
    onSuccess: (account) => {
      onCreated(account.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to open savings account'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Open savings account"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Open account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Customer ID" hint="Open this from a customer's 360 page, or enter their ID directly.">
          {(id) => <input id={id} type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Product">
          {(id) => (
            <select id={id} value={productId} onChange={(e) => setProductId(e.target.value)} className={selectClasses}>
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Branch">{(id) => <input id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function CreateSusuAccountModal({
  open,
  onClose,
  defaultBranchId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultBranchId: string;
  onCreated: (accountId: string) => void;
}) {
  const [customerId, setCustomerId] = useState('');
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [cycleLengthDays, setCycleLengthDays] = useState('30');
  const [expectedCollection, setExpectedCollection] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [commissionRate, setCommissionRate] = useState('');
  const [cycleStartDate, setCycleStartDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCustomerId('');
    setBranchId(defaultBranchId);
    setCycleLengthDays('30');
    setExpectedCollection('');
    setTargetAmount('');
    setCommissionRate('');
    setCycleStartDate('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/susu', {
        customerId: Number(customerId),
        branchId,
        cycleLengthDays: Number(cycleLengthDays),
        expectedCollectionPesewas: parseGhsInput(expectedCollection),
        targetAmountPesewas: parseGhsInput(targetAmount),
        commissionRateBps: parsePercentToBps(commissionRate),
        cycleStartDate: cycleStartDate || undefined,
      }),
    onSuccess: (account) => {
      onCreated(account.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to open susu account'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Open susu account"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Open account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Customer ID">{(id) => <input id={id} type="number" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Branch">{(id) => <input id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Cycle length (days)">{(id) => <input id={id} type="number" value={cycleLengthDays} onChange={(e) => setCycleLengthDays(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Cycle start date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={cycleStartDate} onChange={(e) => setCycleStartDate(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Expected collection per round (GH₵)">
          {(id) => <input id={id} type="number" step="0.01" value={expectedCollection} onChange={(e) => setExpectedCollection(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Target amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Commission rate (%)">{(id) => <input id={id} type="number" step="0.01" value={commissionRate} onChange={(e) => setCommissionRate(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function StandingOrdersCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const ordersQuery = useQuery({ queryKey: ['standing-orders'], queryFn: () => api.get<StandingOrder[]>('/savings/standing-orders') });

  const statusMutation = useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: string }) => api.post(`/savings/standing-orders/${orderId}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['standing-orders'] }),
  });

  return (
    <Card
      title={<span className="flex items-center gap-1.5"><Repeat size={16} /> Standing orders</span>}
      actions={
        canManage && (
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New standing order
          </Button>
        )
      }
      padded={false}
    >
      <DataTable
        columns={[
          { key: 'source', header: 'From account', render: (o) => `#${o.source_account_id}` },
          { key: 'destination', header: 'To account', render: (o) => `#${o.destination_account_id}` },
          { key: 'amount', header: 'Amount', render: (o) => formatGhs(o.amount_pesewas), align: 'right' },
          { key: 'frequency', header: 'Frequency', render: (o) => <span className="capitalize">{o.frequency}</span> },
          { key: 'next', header: 'Next run', render: (o) => formatDate(o.next_run_date) },
          { key: 'failures', header: 'Failures', render: (o) => o.consecutive_failures, align: 'right' },
          { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
        ]}
        rows={ordersQuery.data ?? []}
        getRowKey={(o) => o.id}
        isLoading={ordersQuery.isLoading}
        emptyTitle="No standing orders configured"
        rowActions={
          canManage
            ? (o) => (
                <div className="flex justify-end gap-1.5">
                  {o.status === 'active' && (
                    <Button variant="secondary" size="sm" onClick={() => statusMutation.mutate({ orderId: o.id, status: 'paused' })}>
                      Pause
                    </Button>
                  )}
                  {(o.status === 'paused' || o.status === 'suspended') && (
                    <Button variant="secondary" size="sm" onClick={() => statusMutation.mutate({ orderId: o.id, status: 'active' })}>
                      Resume
                    </Button>
                  )}
                  {o.status !== 'cancelled' && o.status !== 'completed' && (
                    <Button variant="danger" size="sm" onClick={() => statusMutation.mutate({ orderId: o.id, status: 'cancelled' })}>
                      Cancel
                    </Button>
                  )}
                </div>
              )
            : undefined
        }
      />
      <CreateStandingOrderModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['standing-orders'] })} />
    </Card>
  );
}

function CreateStandingOrderModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [sourceAccountId, setSourceAccountId] = useState('');
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [nextRunDate, setNextRunDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSourceAccountId('');
    setDestinationAccountId('');
    setAmount('');
    setFrequency('monthly');
    setNextRunDate('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/savings/standing-orders', {
        sourceAccountId: Number(sourceAccountId),
        destinationAccountId: Number(destinationAccountId),
        amountPesewas: parseGhsInput(amount),
        frequency,
        nextRunDate,
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create standing order'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New standing order"
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
        <FormField label="Source account ID">{(id) => <input id={id} type="number" value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Destination account ID">{(id) => <input id={id} type="number" value={destinationAccountId} onChange={(e) => setDestinationAccountId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Amount (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Frequency">
          {(id) => (
            <select id={id} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className={selectClasses}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          )}
        </FormField>
        <FormField label="Next run date">{(id) => <input id={id} type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function SavingsProductsCard({ products, isLoading, canManage }: { products: SavingsProduct[]; isLoading: boolean; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <Card
      title="Savings products"
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
          { key: 'minBalance', header: 'Min balance', render: (p) => formatGhs(p.min_balance_pesewas), align: 'right' },
          { key: 'maintenance', header: 'Maintenance fee', render: (p) => formatGhs(p.maintenance_fee_pesewas), align: 'right' },
          { key: 'withdrawalFee', header: 'Withdrawal fee', render: (p) => formatGhs(p.withdrawal_fee_pesewas), align: 'right' },
          { key: 'overdraft', header: 'Overdraft', render: (p) => (p.allows_overdraft ? 'Allowed' : 'Not allowed') },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} /> },
        ]}
        rows={products}
        getRowKey={(p) => p.id}
        isLoading={isLoading}
        emptyTitle="No savings products configured yet"
      />
      <CreateSavingsProductModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['savings-products'] })} />
    </Card>
  );
}

function CreateSavingsProductModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [minBalance, setMinBalance] = useState('0');
  const [maintenanceFee, setMaintenanceFee] = useState('0');
  const [withdrawalFee, setWithdrawalFee] = useState('0');
  const [withdrawalThreshold, setWithdrawalThreshold] = useState('0');
  const [allowsOverdraft, setAllowsOverdraft] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setCode('');
    setMinBalance('0');
    setMaintenanceFee('0');
    setWithdrawalFee('0');
    setWithdrawalThreshold('0');
    setAllowsOverdraft(false);
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/savings/products', {
        name,
        code,
        minBalancePesewas: parseGhsInput(minBalance),
        maintenanceFeePesewas: parseGhsInput(maintenanceFee),
        withdrawalFeePesewas: parseGhsInput(withdrawalFee),
        withdrawalApprovalThresholdPesewas: parseGhsInput(withdrawalThreshold),
        allowsOverdraft,
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create savings product'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New savings product"
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
          <FormField label="Min balance (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={minBalance} onChange={(e) => setMinBalance(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Maintenance fee (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={maintenanceFee} onChange={(e) => setMaintenanceFee(e.target.value)} className={inputClasses} />}</FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Withdrawal fee (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={withdrawalFee} onChange={(e) => setWithdrawalFee(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Withdrawal approval threshold (GH₵)" hint="0 means every withdrawal needs approval.">
            {(id) => <input id={id} type="number" step="0.01" value={withdrawalThreshold} onChange={(e) => setWithdrawalThreshold(e.target.value)} className={inputClasses} />}
          </FormField>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-text-primary">
          <input type="checkbox" checked={allowsOverdraft} onChange={(e) => setAllowsOverdraft(e.target.checked)} />
          Allows overdraft
        </label>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
