import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { Card } from '../../components/Card';
import { DataTable, type Column } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { FormField, inputClasses, selectClasses } from '../../components/FormField';
import { api, ApiError } from '../../lib/apiClient';

interface TemplateRow {
  id: string;
  name: string;
  target_authority: string;
  version: string;
  status: 'active' | 'retired';
  effective_date: string;
}

// Mirrors backend/src/modules/compliance/complianceService.js's
// REPORT_DATA_SOURCES map exactly — a template field can only name one of
// these, so the picker is a select, not free text.
const DATA_SOURCES = [
  'loan_classification_summary',
  'capital_adequacy_ratio',
  'liquidity_ratio',
  'social_performance_summary',
  'withholding_tax_summary',
  'vat_summary',
];

export function RegulatoryTemplatesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const templatesQuery = useQuery({
    queryKey: ['report-templates'],
    queryFn: () => api.get<TemplateRow[]>('/compliance/report-templates'),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/compliance/report-templates/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['report-templates'] }),
  });

  const columns: Column<TemplateRow>[] = [
    { key: 'name', header: 'Template', render: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'authority', header: 'Target authority', render: (t) => t.target_authority.toUpperCase() },
    { key: 'version', header: 'Version', render: (t) => `v${t.version}` },
    { key: 'effective', header: 'Effective date', render: (t) => t.effective_date },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Regulatory report templates"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New template
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={columns}
          rows={templatesQuery.data ?? []}
          getRowKey={(t) => t.id}
          isLoading={templatesQuery.isLoading}
          error={templatesQuery.error instanceof ApiError ? templatesQuery.error.message : null}
          onRetry={() => templatesQuery.refetch()}
          emptyTitle="No report templates yet"
          emptyDescription="Creating another template with the same name adds a new version — the old one's field mappings never change, so a report generated last year can still be regenerated as it was then."
          rowActions={(t) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => statusMutation.mutate({ id: t.id, status: t.status === 'active' ? 'retired' : 'active' })}
            >
              {t.status === 'active' ? 'Retire' : 'Reactivate'}
            </Button>
          )}
        />
      </Card>

      <CreateTemplateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => queryClient.invalidateQueries({ queryKey: ['report-templates'] })} />
    </div>
  );
}

function CreateTemplateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [targetAuthority, setTargetAuthority] = useState('bog');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [fields, setFields] = useState<{ key: string; source: string }[]>([{ key: '', source: DATA_SOURCES[0] }]);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/compliance/report-templates', {
        name,
        targetAuthority,
        effectiveDate,
        fieldMappings: { fields: fields.filter((f) => f.key.trim()) },
      }),
    onSuccess: () => {
      onCreated();
      onClose();
      setName('');
      setEffectiveDate('');
      setFields([{ key: '', source: DATA_SOURCES[0] }]);
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create template'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New report template"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create template
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Template name" hint="Reusing a name creates the next version, not an edit-in-place.">
          {(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} className={inputClasses} />}
        </FormField>
        <FormField label="Target authority">
          {(id) => (
            <select id={id} value={targetAuthority} onChange={(e) => setTargetAuthority(e.target.value)} className={selectClasses}>
              <option value="bog">Bank of Ghana</option>
              <option value="gra">Ghana Revenue Authority</option>
            </select>
          )}
        </FormField>
        <FormField label="Effective date">
          {(id) => <input id={id} type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={inputClasses} />}
        </FormField>

        <div>
          <p className="mb-1.5 text-[13px] font-medium text-text-primary">Fields</p>
          <div className="flex flex-col gap-2">
            {fields.map((field, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={field.key}
                  onChange={(e) => setFields(fields.map((f, fi) => (fi === i ? { ...f, key: e.target.value } : f)))}
                  placeholder="Report field key…"
                  className={inputClasses + ' flex-1'}
                />
                <select
                  value={field.source}
                  onChange={(e) => setFields(fields.map((f, fi) => (fi === i ? { ...f, source: e.target.value } : f)))}
                  className={selectClasses + ' flex-1'}
                >
                  {DATA_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" onClick={() => setFields(fields.filter((_, fi) => fi !== i))} aria-label="Remove field">
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => setFields([...fields, { key: '', source: DATA_SOURCES[0] }])}>
            <Plus size={13} /> Add field
          </Button>
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
