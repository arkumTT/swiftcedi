import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldAlert, FileWarning, Landmark } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { Card } from '../../../components/Card';
import { DataTable } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../../components/FormField';
import { formatDate, formatDateTime, formatGhs, parseGhsInput } from '../../../lib/format';
import type { ReportTemplate, ReportSubmission, AmlRule, AmlFlag, SanctionsListEntry, SanctionsScreeningResult } from '../../../types/api';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function CompliancePage() {
  const { hasPermission } = useAuth();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Compliance & Regulatory</h1>
        <p className="text-[13px] text-text-secondary">Regulatory reporting, AML monitoring, and sanctions screening.</p>
      </div>
      {hasPermission('compliance.generate_reports') && <ReportGenerationSection />}
      {hasPermission('compliance.manage_aml') && <AmlSection />}
      {hasPermission('compliance.manage_sanctions') && <SanctionsSection />}
    </div>
  );
}

function ReportGenerationSection() {
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [submitId, setSubmitId] = useState<string | null>(null);

  const templatesQuery = useQuery({ queryKey: ['report-templates'], queryFn: () => api.get<ReportTemplate[]>('/compliance/report-templates', { status: 'active' }) });
  const submissionsQuery = useQuery({ queryKey: ['report-submissions'], queryFn: () => api.get<ReportSubmission[]>('/compliance/reports') });

  const generateMutation = useMutation({
    mutationFn: () => api.post('/compliance/reports/generate', { templateId, periodStart: periodStart || undefined, periodEnd: periodEnd || undefined, asOfDate }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['report-submissions'] });
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to generate report'),
  });

  return (
    <Card title={<span className="flex items-center gap-1.5"><FileWarning size={16} /> Regulatory reports</span>} padded={false}>
      <div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3">
        <FormField label="Template">
          {(id) => (
            <select id={id} value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={selectClasses}>
              <option value="">Select a template…</option>
              {templatesQuery.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.target_authority.toUpperCase()})
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="Period start">{(id) => <input id={id} type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Period end">{(id) => <input id={id} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="As of date">{(id) => <input id={id} type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className={inputClasses} />}</FormField>
        <Button variant="primary" size="md" disabled={!templateId || generateMutation.isPending} onClick={() => generateMutation.mutate()}>
          Generate
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-4 pt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <DataTable
        columns={[
          { key: 'id', header: 'Report', render: (r) => `#${r.id}` },
          { key: 'period', header: 'Period', render: (r) => (r.period_start ? `${formatDate(r.period_start)} – ${formatDate(r.period_end)}` : '—') },
          { key: 'generated', header: 'Generated', render: (r) => formatDateTime(r.generated_at) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'reference', header: 'File reference', render: (r) => r.file_reference ?? '—' },
        ]}
        rows={submissionsQuery.data ?? []}
        getRowKey={(r) => r.id}
        isLoading={submissionsQuery.isLoading}
        emptyTitle="No reports generated yet"
        rowActions={(r) =>
          r.status === 'generated' && (
            <Button variant="secondary" size="sm" onClick={() => setSubmitId(r.id)}>
              Mark submitted
            </Button>
          )
        }
      />
      <SubmitReportModal
        open={submitId !== null}
        submissionId={submitId}
        onClose={() => setSubmitId(null)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['report-submissions'] })}
      />
    </Card>
  );
}

function SubmitReportModal({ open, submissionId, onClose, onSaved }: { open: boolean; submissionId: string | null; onClose: () => void; onSaved: () => void }) {
  const [fileReference, setFileReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/compliance/reports/${submissionId}/submit`, { fileReference }),
    onSuccess: () => {
      onSaved();
      onClose();
      setFileReference('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to mark report submitted'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mark report submitted"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !fileReference} onClick={() => mutation.mutate()}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="File reference" hint="No live regulator submission integration yet — record the reference for the file sent out of band.">
          {(id) => <input id={id} value={fileReference} onChange={(e) => setFileReference(e.target.value)} className={inputClasses} />}
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

function AmlSection() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [reviewFlagId, setReviewFlagId] = useState<string | null>(null);

  const rulesQuery = useQuery({ queryKey: ['aml-rules'], queryFn: () => api.get<AmlRule[]>('/compliance/aml/rules') });
  const flagsQuery = useQuery({ queryKey: ['aml-flags', status], queryFn: () => api.get<AmlFlag[]>('/compliance/aml/flags', { status }) });

  const toggleRuleMutation = useMutation({
    mutationFn: ({ ruleId, newStatus }: { ruleId: string; newStatus: string }) => api.patch(`/compliance/aml/rules/${ruleId}/status`, { status: newStatus }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aml-rules'] }),
  });

  return (
    <>
      <Card title={<span className="flex items-center gap-1.5"><ShieldAlert size={16} /> AML rules</span>} actions={<Button variant="secondary" size="sm" onClick={() => setCreateRuleOpen(true)}><Plus size={14} /> New rule</Button>} padded={false}>
        <DataTable
          columns={[
            { key: 'name', header: 'Rule', render: (r) => r.name },
            { key: 'threshold', header: 'Threshold', render: (r) => formatGhs(r.threshold_pesewas), align: 'right' },
            { key: 'scope', header: 'Scope', render: (r) => <span className="capitalize">{r.transaction_scope.replace(/_/g, ' ')}</span> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
          rows={rulesQuery.data ?? []}
          getRowKey={(r) => r.id}
          isLoading={rulesQuery.isLoading}
          emptyTitle="No AML rules configured"
          rowActions={(r) => (
            <Button variant="secondary" size="sm" onClick={() => toggleRuleMutation.mutate({ ruleId: r.id, newStatus: r.status === 'active' ? 'inactive' : 'active' })}>
              {r.status === 'active' ? 'Deactivate' : 'Activate'}
            </Button>
          )}
        />
      </Card>

      <Card
        title="AML flags"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setScreenOpen(true)}>
            Run screening
          </Button>
        }
        padded={false}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="reviewed">Reviewed</option>
            <option value="cleared">Cleared</option>
          </select>
        </div>
        <DataTable
          columns={[
            { key: 'id', header: 'Flag', render: (f) => `#${f.id}` },
            { key: 'type', header: 'Transaction', render: (f) => <span className="capitalize">{f.transaction_type.replace(/_/g, ' ')}</span> },
            { key: 'customer', header: 'Customer', render: (f) => (f.customer_id ? `#${f.customer_id}` : '—') },
            { key: 'amount', header: 'Amount', render: (f) => formatGhs(f.amount_pesewas), align: 'right' },
            { key: 'flagged', header: 'Flagged', render: (f) => formatDateTime(f.flagged_at) },
            { key: 'status', header: 'Status', render: (f) => <StatusBadge status={f.status} /> },
          ]}
          rows={flagsQuery.data ?? []}
          getRowKey={(f) => f.id}
          isLoading={flagsQuery.isLoading}
          emptyTitle="No AML flags"
          rowActions={(f) =>
            f.status === 'open' && (
              <Button variant="secondary" size="sm" onClick={() => setReviewFlagId(f.id)}>
                Review
              </Button>
            )
          }
        />
      </Card>

      <CreateAmlRuleModal open={createRuleOpen} onClose={() => setCreateRuleOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['aml-rules'] })} />
      <RunAmlScreeningModal open={screenOpen} onClose={() => setScreenOpen(false)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['aml-flags'] })} />
      <ReviewAmlFlagModal open={reviewFlagId !== null} flagId={reviewFlagId} onClose={() => setReviewFlagId(null)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['aml-flags'] })} />
    </>
  );
}

function CreateAmlRuleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState('');
  const [scope, setScope] = useState('all');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/compliance/aml/rules', { name, thresholdPesewas: parseGhsInput(threshold), transactionScope: scope }),
    onSuccess: () => {
      onCreated();
      onClose();
      setName('');
      setThreshold('');
      setScope('all');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create rule'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New AML rule"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !name || !threshold} onClick={() => mutation.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Rule name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Threshold (GH₵)" hint="Flags any single transaction at or above this amount.">
          {(id) => <input id={id} type="number" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Transaction scope">
          {(id) => (
            <select id={id} value={scope} onChange={(e) => setScope(e.target.value)} className={selectClasses}>
              <option value="all">All</option>
              <option value="savings">Savings</option>
              <option value="loan_disbursement">Loan disbursement</option>
              <option value="investment">Investment</option>
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

function RunAmlScreeningModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown[] | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post<unknown[]>('/compliance/aml/screen', { fromDate, toDate }),
    onSuccess: (res) => {
      onSaved();
      setResult(res);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to run screening'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setResult(null);
        setError(null);
      }}
      title="Run AML screening"
      footer={
        result ? (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={mutation.isPending || !fromDate} onClick={() => mutation.mutate()}>
              Run
            </Button>
          </>
        )
      }
    >
      {result ? (
        <p className="text-[13px] text-text-secondary">Screening complete — {result.length} new flag(s) raised.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="From date">{(id) => <input id={id} type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="To date">{(id) => <input id={id} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputClasses} />}</FormField>
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

function ReviewAmlFlagModal({ open, flagId, onClose, onSaved }: { open: boolean; flagId: string | null; onClose: () => void; onSaved: () => void }) {
  const [newStatus, setNewStatus] = useState('reviewed');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/compliance/aml/flags/${flagId}/review`, { newStatus, reviewNotes: notes }),
    onSuccess: () => {
      onSaved();
      onClose();
      setNotes('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to review flag'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review AML flag"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !notes} onClick={() => mutation.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Outcome">
          {(id) => (
            <select id={id} value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className={selectClasses}>
              <option value="reviewed">Reviewed</option>
              <option value="cleared">Cleared</option>
            </select>
          )}
        </FormField>
        <FormField label="Review notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function SanctionsSection() {
  const queryClient = useQueryClient();
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [matchStatus, setMatchStatus] = useState('');

  const entriesQuery = useQuery({ queryKey: ['sanctions-entries'], queryFn: () => api.get<SanctionsListEntry[]>('/compliance/sanctions/list-entries') });
  const resultsQuery = useQuery({ queryKey: ['sanctions-results', matchStatus], queryFn: () => api.get<SanctionsScreeningResult[]>('/compliance/sanctions/results', { matchStatus }) });

  return (
    <>
      <Card
        title={<span className="flex items-center gap-1.5"><Landmark size={16} /> Sanctions list</span>}
        actions={
          <div className="flex gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => setScreenOpen(true)}>
              Screen customers
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAddEntryOpen(true)}>
              <Plus size={14} /> Add entry
            </Button>
          </div>
        }
        padded={false}
      >
        <DataTable
          columns={[
            { key: 'name', header: 'Full name', render: (e) => e.full_name },
            { key: 'source', header: 'List source', render: (e) => e.list_source },
            { key: 'added', header: 'Added', render: (e) => formatDate(e.added_at) },
          ]}
          rows={entriesQuery.data ?? []}
          getRowKey={(e) => e.id}
          isLoading={entriesQuery.isLoading}
          emptyTitle="No sanctions list entries loaded yet"
          emptyDescription="This list starts empty until a real sanctions feed is loaded — every screening will return no_match until then."
        />
      </Card>

      <Card title="Screening results" padded={false}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <select value={matchStatus} onChange={(e) => setMatchStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="no_match">No match</option>
            <option value="potential_match">Potential match</option>
            <option value="confirmed_match">Confirmed match</option>
            <option value="cleared">Cleared</option>
          </select>
        </div>
        <DataTable
          columns={[
            { key: 'customer', header: 'Customer', render: (r) => `#${r.customer_id}` },
            { key: 'screened', header: 'Screened', render: (r) => formatDateTime(r.screened_at) },
            { key: 'status', header: 'Match status', render: (r) => <StatusBadge status={r.match_status} /> },
          ]}
          rows={resultsQuery.data ?? []}
          getRowKey={(r) => r.id}
          isLoading={resultsQuery.isLoading}
          emptyTitle="No screening results yet"
          rowActions={(r) =>
            r.match_status === 'potential_match' && (
              <Button variant="secondary" size="sm" onClick={() => setResolveId(r.id)}>
                Resolve
              </Button>
            )
          }
        />
      </Card>

      <AddSanctionsEntryModal open={addEntryOpen} onClose={() => setAddEntryOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['sanctions-entries'] })} />
      <ScreenCustomersModal open={screenOpen} onClose={() => setScreenOpen(false)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['sanctions-results'] })} />
      <ResolveScreeningModal open={resolveId !== null} resultId={resolveId} onClose={() => setResolveId(null)} onSaved={() => queryClient.invalidateQueries({ queryKey: ['sanctions-results'] })} />
    </>
  );
}

function AddSanctionsEntryModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [fullName, setFullName] = useState('');
  const [listSource, setListSource] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post('/compliance/sanctions/list-entries', { fullName, listSource, notes: notes || undefined }),
    onSuccess: () => {
      onCreated();
      onClose();
      setFullName('');
      setListSource('');
      setNotes('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to add entry'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add sanctions list entry"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !fullName || !listSource} onClick={() => mutation.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Full name">{(id) => <input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="List source" hint="e.g. UN Consolidated List, OFAC SDN">
          {(id) => <input id={id} value={listSource} onChange={(e) => setListSource(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ScreenCustomersModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [customerIds, setCustomerIds] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const ids = customerIds
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Boolean);
      return ids.length === 1
        ? api.post('/compliance/sanctions/screen', { customerId: ids[0] })
        : api.post('/compliance/sanctions/screen-batch', { customerIds: ids });
    },
    onSuccess: () => {
      onSaved();
      setDone(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to screen customer(s)'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setDone(false);
        setCustomerIds('');
      }}
      title="Screen customers"
      footer={
        done ? (
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={mutation.isPending || !customerIds} onClick={() => mutation.mutate()}>
              Screen
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-[13px] text-text-secondary">Screening complete — results appear in the list below.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <FormField label="Customer ID(s)" hint="Comma-separated for a batch, e.g. 12,14,19.">
            {(id) => <input id={id} value={customerIds} onChange={(e) => setCustomerIds(e.target.value)} className={inputClasses} />}
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

function ResolveScreeningModal({ open, resultId, onClose, onSaved }: { open: boolean; resultId: string | null; onClose: () => void; onSaved: () => void }) {
  const [resolution, setResolution] = useState('cleared');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/compliance/sanctions/results/${resultId}/resolve`, { resolution, notes }),
    onSuccess: () => {
      onSaved();
      onClose();
      setNotes('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to resolve screening result'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resolve potential match"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !notes} onClick={() => mutation.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Resolution">
          {(id) => (
            <select id={id} value={resolution} onChange={(e) => setResolution(e.target.value)} className={selectClasses}>
              <option value="cleared">Cleared — not a real match</option>
              <option value="confirmed_match">Confirmed match</option>
            </select>
          )}
        </FormField>
        <FormField label="Notes">{(id) => <input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
