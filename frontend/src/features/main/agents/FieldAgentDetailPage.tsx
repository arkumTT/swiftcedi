import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Repeat, Pencil } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../../components/FormField';
import { ErrorState } from '../../../components/ErrorState';
import { formatDate, formatDateTime } from '../../../lib/format';
import type { FieldAgent, AgentAssignment, AgentLocation } from '../../../types/api';

export function FieldAgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [editOpen, setEditOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['field-agent', id] });

  const agentQuery = useQuery({ queryKey: ['field-agent', id], queryFn: () => api.get<FieldAgent>(`/agents/${id}`), enabled: Boolean(id) });
  const agent = agentQuery.data;
  const currentLocationQuery = useQuery({
    queryKey: ['agent-current-location', id],
    queryFn: () => api.get<AgentLocation | null>(`/agents/${id}/location`),
    enabled: Boolean(id) && hasPermission('agent.view_locations'),
  });
  const locationHistoryQuery = useQuery({
    queryKey: ['agent-location-history', id],
    queryFn: () => api.get<AgentLocation[]>(`/agents/${id}/locations`),
    enabled: Boolean(id) && hasPermission('agent.view_locations'),
  });
  const assignmentsQuery = useQuery({
    queryKey: ['agent-assignments', id],
    queryFn: () => api.get<AgentAssignment[]>(`/agents/${id}/assignments`),
    enabled: Boolean(id) && hasPermission('agent.manage'),
  });

  if (agentQuery.isLoading) return <p className="p-4 text-[13px] text-text-secondary">Loading agent…</p>;
  if (agentQuery.error || !agent) {
    return <ErrorState message={agentQuery.error instanceof ApiError ? agentQuery.error.message : 'Unable to load this agent'} onRetry={() => agentQuery.refetch()} />;
  }

  const branchName = branches?.find((b) => b.id === agent.home_branch_id)?.name ?? agent.home_branch_id;

  const locationColumns: Column<AgentLocation>[] = [
    { key: 'time', header: 'Recorded', render: (l) => formatDateTime(l.recorded_at) },
    { key: 'coords', header: 'Coordinates', render: (l) => `${l.gps_lat}, ${l.gps_lng}` },
  ];
  const assignmentColumns: Column<AgentAssignment>[] = [
    { key: 'branch', header: 'Branch', render: (a) => branches?.find((b) => b.id === a.branch_id)?.name ?? a.branch_id },
    { key: 'territory', header: 'Territory', render: (a) => a.territory ?? '—' },
    { key: 'start', header: 'Start', render: (a) => formatDate(a.start_date) },
    { key: 'end', header: 'End', render: (a) => (a.end_date ? formatDate(a.end_date) : 'Current') },
    { key: 'reason', header: 'Reason', render: (a) => a.reason ?? '—' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => navigate('/app/agents')} className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary">
        <ArrowLeft size={14} /> Back to field agents
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">Agent #{agent.id}</h1>
              <StatusBadge status={agent.status} />
            </div>
            <p className="mt-1.5 text-[13px] text-text-secondary">
              User #{agent.user_id} · {branchName} · {agent.territory ?? 'No territory set'}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('agent.manage') && (
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil size={14} /> Edit
              </Button>
            )}
            {hasPermission('agent.manage') && (
              <Button variant="secondary" size="sm" onClick={() => setReassignOpen(true)}>
                <Repeat size={14} /> Reassign
              </Button>
            )}
          </div>
        </div>
      </Card>

      {hasPermission('agent.view_locations') && (
        <>
          <Card title="Current location">
            {currentLocationQuery.data ? (
              <p className="text-[13px] text-text-primary">
                {currentLocationQuery.data.gps_lat}, {currentLocationQuery.data.gps_lng} — last seen {formatDateTime(currentLocationQuery.data.recorded_at)}
              </p>
            ) : (
              <p className="text-[13px] text-text-secondary">No location pings recorded yet.</p>
            )}
          </Card>
          <Card title="Location history" padded={false}>
            <DataTable columns={locationColumns} rows={locationHistoryQuery.data ?? []} getRowKey={(l) => l.id} isLoading={locationHistoryQuery.isLoading} emptyTitle="No location history" />
          </Card>
        </>
      )}

      {hasPermission('agent.manage') && (
        <Card title="Assignment history" padded={false}>
          <DataTable columns={assignmentColumns} rows={assignmentsQuery.data ?? []} getRowKey={(a) => a.id} isLoading={assignmentsQuery.isLoading} emptyTitle="No assignment history" />
        </Card>
      )}

      <EditAgentModal open={editOpen} onClose={() => setEditOpen(false)} agent={agent} onSaved={invalidate} />
      <ReassignAgentModal open={reassignOpen} onClose={() => setReassignOpen(false)} agentId={agent.id} branches={branches ?? []} currentBranchId={agent.home_branch_id} onSaved={invalidate} />
    </div>
  );
}

function EditAgentModal({ open, onClose, agent, onSaved }: { open: boolean; onClose: () => void; agent: FieldAgent; onSaved: () => void }) {
  const [territory, setTerritory] = useState(agent.territory ?? '');
  const [status, setStatus] = useState(agent.status);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.patch(`/agents/${agent.id}`, { territory, status }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to save changes'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit agent"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Territory">{(id) => <input id={id} value={territory} onChange={(e) => setTerritory(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value as FieldAgent['status'])} className={selectClasses}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          )}
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

function ReassignAgentModal({
  open,
  onClose,
  agentId,
  branches,
  currentBranchId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  branches: { id: string; name: string }[];
  currentBranchId: string;
  onSaved: () => void;
}) {
  const [newBranchId, setNewBranchId] = useState('');
  const [territory, setTerritory] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setNewBranchId('');
    setTerritory('');
    setReason('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => api.post(`/agents/${agentId}/reassign`, { newBranchId, territory: territory || undefined, reason: reason || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to reassign agent'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="Reassign agent"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !newBranchId} onClick={() => mutation.mutate()}>
            Reassign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="New branch">
          {(id) => (
            <select id={id} value={newBranchId} onChange={(e) => setNewBranchId(e.target.value)} className={selectClasses}>
              <option value="">Select a branch…</option>
              {branches.filter((b) => b.id !== currentBranchId).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="New territory">{(id) => <input id={id} value={territory} onChange={(e) => setTerritory(e.target.value)} className={inputClasses} />}</FormField>
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
