import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MapPin, ClipboardList } from 'lucide-react';
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
import { formatDate, formatGhs } from '../../../lib/format';
import type { FieldAgent, AgentReconciliation } from '../../../types/api';

export function FieldAgentsPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission('agent.manage');
  const canViewLocations = hasPermission('agent.view_locations');
  const canReconcile = hasPermission('agent.reconcile');
  const canPing = hasPermission('agent.ping_location');
  const isSupervisor = canManage || canViewLocations || canReconcile;

  if (!isSupervisor && canPing) {
    return <MyLocationCard />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Field Agents</h1>
        <p className="text-[13px] text-text-secondary">Agent roster, GPS coverage, and cash-collection reconciliation.</p>
      </div>
      {canManage && <AgentsListSection />}
      {canReconcile && <ReconciliationsSection />}
    </div>
  );

  function AgentsListSection() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const crossBranch = isCrossBranchRole(user!.roleName);
    const { data: branches } = useBranches();
    const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
    const [status, setStatus] = useState('');
    const [createOpen, setCreateOpen] = useState(false);

    const agentsQuery = useQuery({
      queryKey: ['field-agents', { branchId, status }],
      // 'all' is the resolveConsolidatedBranchScope sentinel (see
      // Decisions_Log.md) — omitting branchId would silently default to
      // the caller's OWN home branch even for a cross-branch supervisor.
      queryFn: () => api.get<FieldAgent[]>('/agents', { branchId: crossBranch ? branchId || 'all' : user!.homeBranchId, status }),
    });

    const columns: Column<FieldAgent>[] = [
      { key: 'id', header: 'Agent', render: (a) => `#${a.id}` },
      { key: 'user', header: 'User', render: (a) => `#${a.user_id}` },
      { key: 'branch', header: 'Branch', render: (a) => branches?.find((b) => b.id === a.home_branch_id)?.name ?? a.home_branch_id },
      { key: 'territory', header: 'Territory', render: (a) => a.territory ?? '—' },
      { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    ];

    return (
      <>
        <Card
          title="Agent roster"
          actions={
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> Register agent
            </Button>
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
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </FilterToolbar>
          <DataTable
            columns={columns}
            rows={agentsQuery.data ?? []}
            getRowKey={(a) => a.id}
            isLoading={agentsQuery.isLoading}
            error={agentsQuery.error instanceof ApiError ? agentsQuery.error.message : null}
            onRetry={() => agentsQuery.refetch()}
            onRowClick={(a) => navigate(`/app/agents/${a.id}`)}
            emptyTitle="No field agents match these filters"
          />
        </Card>
        <CreateAgentModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          branches={branches ?? []}
          defaultBranchId={crossBranch ? '' : user!.homeBranchId}
          onCreated={(agentId) => {
            queryClient.invalidateQueries({ queryKey: ['field-agents'] });
            navigate(`/app/agents/${agentId}`);
          }}
        />
      </>
    );
  }

  function ReconciliationsSection() {
    const crossBranch = isCrossBranchRole(user!.roleName);
    const { data: branches } = useBranches();
    const queryClient = useQueryClient();
    const [status, setStatus] = useState('');
    const [runOpen, setRunOpen] = useState(false);
    const [resolveId, setResolveId] = useState<string | null>(null);

    const reconQuery = useQuery({
      queryKey: ['agent-reconciliations', { status }],
      queryFn: () => api.get<AgentReconciliation[]>('/agents/reconciliations', { branchId: crossBranch ? 'all' : undefined, status }),
    });

    return (
      <>
        <Card
          title={<span className="flex items-center gap-1.5"><ClipboardList size={16} /> Cash reconciliation</span>}
          actions={
            <Button variant="secondary" size="sm" onClick={() => setRunOpen(true)}>
              Run branch reconciliation
            </Button>
          }
          padded={false}
        >
          <FilterToolbar>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
              <option value="">All statuses</option>
              <option value="matched">Matched</option>
              <option value="pending_review">Pending review</option>
              <option value="resolved">Resolved</option>
            </select>
          </FilterToolbar>
          <DataTable
            columns={[
              { key: 'agent', header: 'Agent', render: (r) => `#${r.agent_id}` },
              { key: 'date', header: 'Date', render: (r) => formatDate(r.reconciliation_date) },
              { key: 'expected', header: 'Expected', render: (r) => formatGhs(r.expected_amount_pesewas), align: 'right' },
              { key: 'received', header: 'Received', render: (r) => formatGhs(r.received_amount_pesewas), align: 'right' },
              { key: 'variance', header: 'Variance', render: (r) => formatGhs(r.variance_pesewas), align: 'right' },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            ]}
            rows={reconQuery.data ?? []}
            getRowKey={(r) => r.id}
            isLoading={reconQuery.isLoading}
            emptyTitle="No reconciliation runs yet"
            rowActions={(r) =>
              r.status === 'pending_review' && (
                <Button variant="secondary" size="sm" onClick={() => setResolveId(r.id)}>
                  Resolve
                </Button>
              )
            }
          />
        </Card>
        <RunReconciliationModal
          open={runOpen}
          onClose={() => setRunOpen(false)}
          branches={branches ?? []}
          crossBranch={crossBranch}
          defaultBranchId={crossBranch ? '' : user!.homeBranchId}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['agent-reconciliations'] })}
        />
        <ResolveReconciliationModal
          open={resolveId !== null}
          reconciliationId={resolveId}
          onClose={() => setResolveId(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['agent-reconciliations'] })}
        />
      </>
    );
  }
}

function MyLocationCard() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ gpsLat, gpsLng }: { gpsLat: number; gpsLng: number }) => api.post('/agents/ping', { gpsLat, gpsLng }),
    onSuccess: () => setStatus('sent'),
    onError: (err) => {
      setStatus('error');
      setError(err instanceof ApiError ? err.message : 'Unable to record location');
    },
  });

  function sendPing() {
    setStatus('sending');
    setError(null);
    if (!navigator.geolocation) {
      setStatus('error');
      setError('This browser does not support location services.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => mutation.mutate({ gpsLat: pos.coords.latitude, gpsLng: pos.coords.longitude }),
      () => {
        setStatus('error');
        setError('Location permission denied or unavailable.');
      }
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Field Agents</h1>
        <p className="text-[13px] text-text-secondary">Share your current location with your supervisor.</p>
      </div>
      <Card title={<span className="flex items-center gap-1.5"><MapPin size={16} /> My location</span>}>
        <p className="mb-3 text-[13px] text-text-secondary">
          Your supervisor can view your location history — there is no way for you to see it back from here.
        </p>
        <Button variant="primary" size="md" disabled={status === 'sending'} onClick={sendPing}>
          Record my location
        </Button>
        {status === 'sent' && <p className="mt-2 text-[13px] text-success">Location sent.</p>}
        {status === 'error' && error && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}

function CreateAgentModal({
  open,
  onClose,
  branches,
  defaultBranchId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  onCreated: (agentId: string) => void;
}) {
  const [userId, setUserId] = useState('');
  const [homeBranchId, setHomeBranchId] = useState(defaultBranchId);
  const [territory, setTerritory] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setUserId('');
    setHomeBranchId(defaultBranchId);
    setTerritory('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => api.post<{ id: string }>('/agents', { userId: Number(userId), homeBranchId, territory: territory || undefined }),
    onSuccess: (agent) => {
      onCreated(agent.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to register field agent'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Register field agent"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !userId || !homeBranchId} onClick={() => mutation.mutate()}>
            Register
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="User ID" hint="The staff account this agent record belongs to.">
          {(id) => <input id={id} type="number" value={userId} onChange={(e) => setUserId(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Home branch">
          {(id) => (
            <select id={id} value={homeBranchId} onChange={(e) => setHomeBranchId(e.target.value)} className={selectClasses}>
              <option value="">Select a branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Territory">{(id) => <input id={id} value={territory} onChange={(e) => setTerritory(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function RunReconciliationModal({
  open,
  onClose,
  branches,
  crossBranch,
  defaultBranchId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  branches: { id: string; name: string }[];
  crossBranch: boolean;
  defaultBranchId: string;
  onSaved: () => void;
}) {
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/agents/reconciliations/run-branch', { branchId: crossBranch ? branchId : undefined, date: date || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to run reconciliation'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run branch reconciliation"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Run
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-secondary">Reconciles every active agent in the branch against their susu collections for the day.</p>
        {crossBranch && (
          <FormField label="Branch">
            {(id) => (
              <select id={id} value={branchId} onChange={(e) => setBranchId(e.target.value)} className={selectClasses}>
                <option value="">Your default branch</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        )}
        <FormField label="Date" hint="Defaults to today if left blank.">
          {(id) => <input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClasses} />}
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

function ResolveReconciliationModal({
  open,
  reconciliationId,
  onClose,
  onSaved,
}: {
  open: boolean;
  reconciliationId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/agents/reconciliations/${reconciliationId}/resolve`, { resolutionNotes: notes }),
    onSuccess: () => {
      onSaved();
      onClose();
      setNotes('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to resolve reconciliation'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resolve reconciliation variance"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !notes} onClick={() => mutation.mutate()}>
            Resolve
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Resolution notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
