import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wallet, Undo2, CalendarCheck } from 'lucide-react';
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
import { formatDate, formatDateTime, formatGhs, parseGhsInput } from '../../../lib/format';
import type { CashierTill, TransactionReversal, DayCloseSnapshot, BranchCashPosition, ConsolidatedCashPosition } from '../../../types/api';

export function CashierVaultPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [tillStatus, setTillStatus] = useState('');
  const [openTillModal, setOpenTillModal] = useState(false);
  const [requestReversalOpen, setRequestReversalOpen] = useState(false);
  const [closeOutOpen, setCloseOutOpen] = useState(false);

  const consolidatedQuery = useQuery({
    queryKey: ['cash-position-consolidated'],
    queryFn: () => api.get<ConsolidatedCashPosition>('/cashier/cash-position'),
    enabled: crossBranch && hasPermission('cashier.view'),
  });
  const branchPositionQuery = useQuery({
    queryKey: ['cash-position-branch', branchId || user!.homeBranchId],
    queryFn: () => api.get<BranchCashPosition>(`/cashier/cash-position/${branchId || user!.homeBranchId}`),
    enabled: hasPermission('cashier.view') && (!crossBranch || Boolean(branchId)),
  });

  const tillsQuery = useQuery({
    queryKey: ['cashier-tills', { branchId, tillStatus }],
    queryFn: () => api.get<CashierTill[]>('/cashier/tills', { branchId: crossBranch ? branchId : user!.homeBranchId, status: tillStatus }),
  });

  const reversalsQuery = useQuery({
    queryKey: ['cashier-reversals', { branchId }],
    queryFn: () => api.get<TransactionReversal[]>('/cashier/reversals', { branchId: crossBranch ? branchId : user!.homeBranchId }),
    enabled: hasPermission('cashier.view'),
  });
  const executeReversalMutation = useMutation({
    mutationFn: (reversalId: string) => api.post(`/cashier/reversals/${reversalId}/execute`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cashier-reversals'] }),
  });

  const closeOutsQuery = useQuery({
    queryKey: ['close-outs', { branchId }],
    queryFn: () => api.get<DayCloseSnapshot[]>('/cashier/close-outs', { branchId: crossBranch ? branchId : user!.homeBranchId }),
    enabled: hasPermission('cashier.view'),
  });

  const tillColumns: Column<CashierTill>[] = [
    { key: 'id', header: 'Till', render: (t) => `#${t.id}` },
    { key: 'cashier', header: 'Cashier', render: (t) => `#${t.cashier_id}` },
    { key: 'date', header: 'Business date', render: (t) => formatDate(t.business_date) },
    { key: 'opening', header: 'Opening float', render: (t) => formatGhs(t.opening_balance_pesewas), align: 'right' },
    { key: 'variance', header: 'Variance', render: (t) => (t.variance_pesewas != null ? formatGhs(t.variance_pesewas) : '—'), align: 'right' },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Cashier & Vault</h1>
        <p className="text-[13px] text-text-secondary">Till floats, cash-back requests, reversals, and period close-outs.</p>
      </div>

      {hasPermission('cashier.view') && (
        <Card title={<span className="flex items-center gap-1.5"><Wallet size={16} /> Cash position</span>}>
          {crossBranch ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Cash in hand (all branches)" value={formatGhs(consolidatedQuery.data?.totals.cashInHandBalancePesewas)} />
              <KpiCard label="Vault (all branches)" value={formatGhs(consolidatedQuery.data?.totals.vaultBalancePesewas)} />
              <KpiCard label="Total cash position" value={formatGhs(consolidatedQuery.data?.totals.totalCashPositionPesewas)} />
              <KpiCard label="Open tills" value={String(consolidatedQuery.data?.totals.openTillCount ?? 0)} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Cash in hand" value={formatGhs(branchPositionQuery.data?.cashInHandBalancePesewas)} />
              <KpiCard label="Vault" value={formatGhs(branchPositionQuery.data?.vaultBalancePesewas)} />
              <KpiCard label="Total cash position" value={formatGhs(branchPositionQuery.data?.totalCashPositionPesewas)} />
              <KpiCard label="Open tills" value={String(branchPositionQuery.data?.openTillCount ?? 0)} />
            </div>
          )}
        </Card>
      )}

      <Card
        title="Tills"
        actions={
          hasPermission('cashier.till_open') && (
            <Button variant="primary" size="sm" onClick={() => setOpenTillModal(true)}>
              <Plus size={14} /> Open till
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
          <select value={tillStatus} onChange={(e) => setTillStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </FilterToolbar>
        <DataTable
          columns={tillColumns}
          rows={tillsQuery.data ?? []}
          getRowKey={(t) => t.id}
          isLoading={tillsQuery.isLoading}
          error={tillsQuery.error instanceof ApiError ? tillsQuery.error.message : null}
          onRetry={() => tillsQuery.refetch()}
          onRowClick={(t) => navigate(`/app/cashier/tills/${t.id}`)}
          emptyTitle="No tills match these filters"
        />
      </Card>

      {hasPermission('cashier.view') && (
        <Card
          title={<span className="flex items-center gap-1.5"><Undo2 size={16} /> Reversals</span>}
          actions={
            hasPermission('cashier.request_reversal') && (
              <Button variant="secondary" size="sm" onClick={() => setRequestReversalOpen(true)}>
                <Plus size={14} /> Request reversal
              </Button>
            )
          }
          padded={false}
        >
          <DataTable
            columns={[
              { key: 'id', header: 'Reversal', render: (r) => `#${r.id}` },
              { key: 'entry', header: 'Original entry', render: (r) => `#${r.original_journal_entry_id}` },
              { key: 'reason', header: 'Reason', render: (r) => r.reason_code },
              { key: 'date', header: 'Requested', render: (r) => formatDateTime(r.created_at) },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]}
            rows={reversalsQuery.data ?? []}
            getRowKey={(r) => r.id}
            isLoading={reversalsQuery.isLoading}
            emptyTitle="No reversal requests"
            rowActions={
              hasPermission('cashier.request_reversal')
                ? (r) =>
                    r.status === 'approved' && (
                      <Button variant="secondary" size="sm" disabled={executeReversalMutation.isPending} onClick={() => executeReversalMutation.mutate(r.id)}>
                        Execute
                      </Button>
                    )
                : undefined
            }
          />
        </Card>
      )}

      {hasPermission('cashier.view') && (
        <Card
          title={<span className="flex items-center gap-1.5"><CalendarCheck size={16} /> Period close-outs</span>}
          actions={
            hasPermission('cashier.close_out') && (
              <Button variant="secondary" size="sm" onClick={() => setCloseOutOpen(true)}>
                <Plus size={14} /> New close-out
              </Button>
            )
          }
          padded={false}
        >
          <DataTable
            columns={[
              { key: 'branch', header: 'Branch', render: (c) => branches?.find((b) => b.id === c.branch_id)?.name ?? c.branch_id },
              { key: 'type', header: 'Period', render: (c) => <span className="capitalize">{c.period_type}</span> },
              { key: 'start', header: 'Period start', render: (c) => formatDate(c.period_start) },
              { key: 'end', header: 'Period end', render: (c) => formatDate(c.period_end) },
              { key: 'cash', header: 'Cash in hand', render: (c) => formatGhs(c.cash_in_hand_balance_pesewas), align: 'right' },
              { key: 'vault', header: 'Vault', render: (c) => formatGhs(c.vault_balance_pesewas), align: 'right' },
              { key: 'tills', header: 'Tills closed', render: (c) => c.tills_closed_count, align: 'right' },
            ]}
            rows={closeOutsQuery.data ?? []}
            getRowKey={(c) => c.id}
            isLoading={closeOutsQuery.isLoading}
            emptyTitle="No period close-outs yet"
          />
        </Card>
      )}

      <OpenTillModal
        open={openTillModal}
        onClose={() => setOpenTillModal(false)}
        defaultBranchId={crossBranch ? '' : user!.homeBranchId}
        onOpened={(tillId) => {
          queryClient.invalidateQueries({ queryKey: ['cashier-tills'] });
          navigate(`/app/cashier/tills/${tillId}`);
        }}
      />
      <RequestReversalModal
        open={requestReversalOpen}
        onClose={() => setRequestReversalOpen(false)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['cashier-reversals'] })}
      />
      <CreateCloseOutModal
        open={closeOutOpen}
        onClose={() => setCloseOutOpen(false)}
        branches={branches ?? []}
        defaultBranchId={crossBranch ? '' : user!.homeBranchId}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['close-outs'] })}
      />
    </div>
  );
}

function OpenTillModal({
  open,
  onClose,
  defaultBranchId,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  defaultBranchId: string;
  onOpened: (tillId: string) => void;
}) {
  const { user } = useAuth();
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [cashierId, setCashierId] = useState(user!.id);
  const [openingBalance, setOpeningBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setBranchId(defaultBranchId);
    setCashierId(user!.id);
    setOpeningBalance('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/cashier/tills', {
        branchId,
        cashierId: Number(cashierId),
        openingBalancePesewas: parseGhsInput(openingBalance || '0'),
      }),
    onSuccess: (till) => {
      onOpened(till.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to open till'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Open till"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Open till
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Branch">{(id) => <input id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Cashier ID" hint="Defaults to you.">{(id) => <input id={id} value={cashierId} onChange={(e) => setCashierId(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Opening float (GH₵)">{(id) => <input id={id} type="number" step="0.01" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function RequestReversalModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [originalJournalEntryId, setOriginalJournalEntryId] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/cashier/reversals', {
        originalJournalEntryId: Number(originalJournalEntryId),
        reasonCode,
        notes: notes || undefined,
      }),
    onSuccess: () => {
      onSaved();
      setSubmitted(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to request reversal'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSubmitted(false);
        setOriginalJournalEntryId('');
        setReasonCode('');
        setNotes('');
      }}
      title="Request reversal"
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
            <Button variant="danger" size="sm" disabled={mutation.isPending || !originalJournalEntryId || !reasonCode} onClick={() => mutation.mutate()}>
              Submit for approval
            </Button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-[13px] text-text-secondary">Reversal request submitted. Reversals always require maker-checker approval — execute it from this list once approved.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="Original journal entry ID">
            {(id) => <input id={id} type="number" value={originalJournalEntryId} onChange={(e) => setOriginalJournalEntryId(e.target.value)} className={inputClasses} />}
          </FormField>
          <FormField label="Reason code">{(id) => <input id={id} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
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

function CreateCloseOutModal({
  open,
  onClose,
  branches,
  defaultBranchId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  onSaved: () => void;
}) {
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [periodType, setPeriodType] = useState<'day' | 'month' | 'year'>('day');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setBranchId(defaultBranchId);
    setPeriodType('day');
    setPeriodStart('');
    setPeriodEnd('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => api.post('/cashier/close-outs', { branchId, periodType, periodStart, periodEnd }),
    onSuccess: () => {
      onSaved();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to close out this period'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New period close-out"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !periodStart || !periodEnd} onClick={() => mutation.mutate()}>
            Close out
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-secondary">Requires every till in the branch to be closed first.</p>
        <FormField label="Branch">
          {(id) => (
            <select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses}>
              <option value="">Select a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Period type">
          {(id) => (
            <select id={id} value={periodType} onChange={(e) => setPeriodType(e.target.value as typeof periodType)} className={selectClasses}>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          )}
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Period start">{(id) => <input id={id} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Period end">{(id) => <input id={id} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={inputClasses} />}</FormField>
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
