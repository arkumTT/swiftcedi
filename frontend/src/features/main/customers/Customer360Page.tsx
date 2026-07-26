import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, UserCheck, UserX, ArrowLeftRight, Tag, ShieldCheck, DoorClosed } from 'lucide-react';
import { useAuth } from '../../../auth/AuthContext';
import { api, ApiError } from '../../../lib/apiClient';
import { useBranches } from '../../../lib/adminHooks';
import { Card } from '../../../components/Card';
import { DataTable, type Column } from '../../../components/DataTable';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button } from '../../../components/Button';
import { Modal } from '../../../components/Modal';
import { KpiCard } from '../../../components/KpiCard';
import { FormField, inputClasses, selectClasses } from '../../../components/FormField';
import { ErrorState } from '../../../components/ErrorState';
import { formatDate, formatDateTime, formatGhs } from '../../../lib/format';
import type { Customer360, Loan, SavingsAccount, Investment, CustomerDocument, NextOfKin } from '../../../types/api';

const DOCUMENT_TYPES = ['ghana_card_scan', 'photo', 'signed_agreement', 'fingerprint', 'other'];

export function Customer360Page() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const { data: branches } = useBranches();

  const [editOpen, setEditOpen] = useState(false);
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [kycOpen, setKycOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState<'active' | 'inactive' | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [addKinOpen, setAddKinOpen] = useState(false);

  const invalidate360 = () => queryClient.invalidateQueries({ queryKey: ['customer-360', id] });

  const customer360 = useQuery({
    queryKey: ['customer-360', id],
    queryFn: () => api.get<Customer360>(`/customers/${id}/360`),
    enabled: Boolean(id),
  });

  const loansQuery = useQuery({
    queryKey: ['loans', { customerId: id }],
    queryFn: () => api.get<Loan[]>('/loans', { customerId: id }),
    enabled: Boolean(id),
  });
  const savingsQuery = useQuery({
    queryKey: ['savings-accounts', { customerId: id }],
    queryFn: () => api.get<SavingsAccount[]>('/savings', { customerId: id }),
    enabled: Boolean(id) && hasPermission('savings.view'),
  });
  const investmentsQuery = useQuery({
    queryKey: ['investments', { customerId: id }],
    queryFn: () => api.get<Investment[]>('/investments', { customerId: id }),
    enabled: Boolean(id),
  });

  const lookupMutation = useMutation({
    mutationFn: () => api.post(`/customers/${id}/credit-bureau-lookups`),
    onSuccess: invalidate360,
  });

  if (customer360.isLoading) {
    return <p className="p-4 text-[13px] text-text-secondary">Loading customer…</p>;
  }
  if (customer360.error || !customer360.data) {
    return (
      <ErrorState
        message={customer360.error instanceof ApiError ? customer360.error.message : 'Unable to load this customer'}
        onRetry={() => customer360.refetch()}
      />
    );
  }

  const { customer, documents, nextOfKin, creditBureauLookups, groupInfo } = customer360.data;
  const branchName = branches?.find((b) => b.id === customer.branch_id)?.name ?? customer.branch_id;
  const totalLoanPrincipal = (loansQuery.data ?? []).reduce((sum, l) => sum + Number(l.principal_pesewas), 0);
  const totalSavingsBalance = (savingsQuery.data ?? []).reduce((sum, a) => sum + Number(a.balance_pesewas), 0);
  const totalInvestmentPrincipal = (investmentsQuery.data ?? []).reduce((sum, i) => sum + Number(i.principal_pesewas), 0);

  const loanColumns: Column<Loan>[] = [
    { key: 'id', header: 'Loan', render: (l) => `#${l.id}` },
    { key: 'type', header: 'Type', render: (l) => <span className="capitalize">{l.loan_type}</span> },
    { key: 'principal', header: 'Principal', render: (l) => formatGhs(l.principal_pesewas), align: 'right' },
    { key: 'term', header: 'Term', render: (l) => `${l.term_months} mo` },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} /> },
  ];
  const savingsColumns: Column<SavingsAccount>[] = [
    { key: 'account', header: 'Account no.', render: (a) => a.account_no },
    { key: 'balance', header: 'Balance', render: (a) => formatGhs(a.balance_pesewas), align: 'right' },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} /> },
    { key: 'opened', header: 'Opened', render: (a) => formatDate(a.opened_at) },
  ];
  const investmentColumns: Column<Investment>[] = [
    { key: 'id', header: 'Investment', render: (i) => `#${i.id}` },
    { key: 'principal', header: 'Principal', render: (i) => formatGhs(i.principal_pesewas), align: 'right' },
    { key: 'tenor', header: 'Tenor', render: (i) => `${i.tenor_months} mo` },
    { key: 'maturity', header: 'Maturity', render: (i) => formatDate(i.maturity_date) },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
  ];
  const docColumns: Column<CustomerDocument>[] = [
    { key: 'type', header: 'Type', render: (d) => <span className="capitalize">{d.document_type.replace(/_/g, ' ')}</span> },
    {
      key: 'url',
      header: 'File',
      render: (d) => (
        <a href={d.file_url} target="_blank" rel="noreferrer" className="text-primary underline">
          Open
        </a>
      ),
    },
    { key: 'uploaded', header: 'Uploaded', render: (d) => formatDate(d.created_at) },
  ];
  const kinColumns: Column<NextOfKin>[] = kinColumnsBuilder();
  function kinColumnsBuilder(): Column<NextOfKin>[] {
    return [
      { key: 'name', header: 'Name', render: (k) => k.full_name },
      { key: 'relationship', header: 'Relationship', render: (k) => k.relationship ?? '—' },
      { key: 'phone', header: 'Phone', render: (k) => k.phone ?? '—' },
      { key: 'address', header: 'Address', render: (k) => k.address ?? '—' },
    ];
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => navigate('/app/customers')}
        className="flex w-fit items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft size={14} /> Back to customers
      </button>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-text-primary">{customer.full_name}</h1>
              <span className="rounded-pill border border-border bg-surface-alt px-2 py-0.5 text-[11.5px] font-medium capitalize text-text-secondary">
                {customer.customer_type}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={customer.status} />
              <StatusBadge status={customer.kyc_status} label={`KYC: ${customer.kyc_status}`} />
              {customer.classification && <StatusBadge status="neutral" tone="info" label={customer.classification} />}
            </div>
            <p className="mt-2 text-[13px] text-text-secondary">
              {branchName} · {customer.ghana_card_no ?? customer.business_registration_no ?? 'No ID on file'}
              {customer.contact_person_name && ` · Contact: ${customer.contact_person_name}`}
            </p>
            <p className="text-[13px] text-text-secondary">
              {customer.phone ?? '—'} · {customer.email ?? '—'} · {customer.address ?? '—'}
            </p>
            <p className="text-[12px] text-text-muted">Onboarded {formatDate(customer.created_at)}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {hasPermission('customer.update') && (
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            )}
            {hasPermission('customer.classify') && (
              <Button variant="secondary" size="sm" onClick={() => setClassifyOpen(true)}>
                <Tag size={14} /> Classify
              </Button>
            )}
            {hasPermission('customer.verify_kyc') && (
              <Button variant="secondary" size="sm" onClick={() => setKycOpen(true)}>
                <ShieldCheck size={14} /> KYC decision
              </Button>
            )}
            {hasPermission('customer.credit_bureau_lookup') && (
              <Button variant="secondary" size="sm" disabled={lookupMutation.isPending} onClick={() => lookupMutation.mutate()}>
                <Search size={14} /> Credit bureau lookup
              </Button>
            )}
            {hasPermission('customer.transfer_branch') && customer.status !== 'closed' && (
              <Button variant="secondary" size="sm" onClick={() => setTransferOpen(true)}>
                <ArrowLeftRight size={14} /> Transfer branch
              </Button>
            )}
            {hasPermission('customer.reactivate') && customer.status === 'active' && (
              <Button variant="secondary" size="sm" onClick={() => setStatusOpen('inactive')}>
                <UserX size={14} /> Deactivate
              </Button>
            )}
            {hasPermission('customer.reactivate') && customer.status === 'inactive' && (
              <Button variant="secondary" size="sm" onClick={() => setStatusOpen('active')}>
                <UserCheck size={14} /> Reactivate
              </Button>
            )}
            {hasPermission('customer.close') && customer.status !== 'closed' && (
              <Button variant="danger" size="sm" onClick={() => setCloseOpen(true)}>
                <DoorClosed size={14} /> Request closure
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Loans (principal)" value={formatGhs(totalLoanPrincipal)} />
        {hasPermission('savings.view') && <KpiCard label="Savings balance" value={formatGhs(totalSavingsBalance)} />}
        <KpiCard label="Investments (principal)" value={formatGhs(totalInvestmentPrincipal)} />
      </div>

      <Card title="Loans" padded={false}>
        <DataTable
          columns={loanColumns}
          rows={loansQuery.data ?? []}
          getRowKey={(l) => l.id}
          isLoading={loansQuery.isLoading}
          emptyTitle="No loans for this customer"
        />
      </Card>

      {hasPermission('savings.view') && (
        <Card title="Savings accounts" padded={false}>
          <DataTable
            columns={savingsColumns}
            rows={savingsQuery.data ?? []}
            getRowKey={(a) => a.id}
            isLoading={savingsQuery.isLoading}
            emptyTitle="No savings accounts for this customer"
          />
        </Card>
      )}

      <Card title="Investments" padded={false}>
        <DataTable
          columns={investmentColumns}
          rows={investmentsQuery.data ?? []}
          getRowKey={(i) => i.id}
          isLoading={investmentsQuery.isLoading}
          emptyTitle="No investments for this customer"
        />
      </Card>

      {customer.customer_type === 'group' && groupInfo && 'members' in groupInfo && (
        <Card title="Group members" padded={false}>
          <DataTable
            columns={[
              { key: 'name', header: 'Name', render: (m) => m.full_name },
              { key: 'kyc', header: 'KYC', render: (m) => <StatusBadge status={m.kyc_status} /> },
              { key: 'role', header: 'Role', render: (m) => (m.is_leader ? 'Leader' : 'Member') },
            ]}
            rows={groupInfo.members}
            getRowKey={(m) => m.id}
            emptyTitle="No group members yet"
          />
        </Card>
      )}
      {customer.customer_type !== 'group' && groupInfo && 'memberOfGroups' in groupInfo && groupInfo.memberOfGroups.length > 0 && (
        <Card title="Group membership">
          <ul className="flex flex-col gap-1 text-[13px] text-text-primary">
            {groupInfo.memberOfGroups.map((g) => (
              <li key={g.group_id}>
                {g.group_name} · joined {formatDate(g.joined_at)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Documents"
        actions={
          hasPermission('customer.manage_documents') && (
            <Button variant="secondary" size="sm" onClick={() => setAddDocOpen(true)}>
              <Plus size={14} /> Add document
            </Button>
          )
        }
        padded={false}
      >
        <DataTable columns={docColumns} rows={documents} getRowKey={(d) => d.id} emptyTitle="No documents on file" />
      </Card>

      <Card
        title="Next of kin"
        actions={
          hasPermission('customer.manage_next_of_kin') && (
            <Button variant="secondary" size="sm" onClick={() => setAddKinOpen(true)}>
              <Plus size={14} /> Add next of kin
            </Button>
          )
        }
        padded={false}
      >
        <DataTable columns={kinColumns} rows={nextOfKin} getRowKey={(k) => k.id} emptyTitle="No next-of-kin on file" />
      </Card>

      <Card title="Credit bureau lookups" padded={false}>
        <DataTable
          columns={[
            { key: 'status', header: 'Result', render: (l) => <StatusBadge status={l.status} /> },
            { key: 'requested', header: 'Requested', render: (l) => formatDateTime(l.requested_at) },
          ]}
          rows={creditBureauLookups}
          getRowKey={(l) => l.id}
          emptyTitle="No credit bureau lookups yet"
        />
      </Card>

      <EditCustomerModal open={editOpen} onClose={() => setEditOpen(false)} customer={customer} onSaved={invalidate360} />
      <ClassifyModal open={classifyOpen} onClose={() => setClassifyOpen(false)} customerId={customer.id} current={customer.classification} onSaved={invalidate360} />
      <KycModal open={kycOpen} onClose={() => setKycOpen(false)} customerId={customer.id} current={customer.kyc_status} onSaved={invalidate360} />
      <StatusModal
        open={statusOpen !== null}
        toStatus={statusOpen}
        onClose={() => setStatusOpen(null)}
        customerId={customer.id}
        onSaved={invalidate360}
      />
      <TransferBranchModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        customerId={customer.id}
        currentBranchId={customer.branch_id}
        branches={branches ?? []}
        onSaved={invalidate360}
      />
      <CloseRequestModal open={closeOpen} onClose={() => setCloseOpen(false)} customerId={customer.id} onSaved={invalidate360} />
      <AddDocumentModal open={addDocOpen} onClose={() => setAddDocOpen(false)} customerId={customer.id} onSaved={invalidate360} />
      <AddNextOfKinModal open={addKinOpen} onClose={() => setAddKinOpen(false)} customerId={customer.id} onSaved={invalidate360} />
    </div>
  );
}

// --- Action modals ---------------------------------------------------------

function EditCustomerModal({
  open,
  onClose,
  customer,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer360['customer'];
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(customer.full_name);
  const [phone, setPhone] = useState(customer.phone ?? '');
  const [email, setEmail] = useState(customer.email ?? '');
  const [address, setAddress] = useState(customer.address ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.patch(`/customers/${customer.id}`, { fullName, phone, email, address }),
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
      title="Edit customer"
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
      <div className="flex flex-col gap-3">
        <FormField label="Full name">{(id) => <input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Phone">{(id) => <input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Address">{(id) => <input id={id} value={address} onChange={(e) => setAddress(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ClassifyModal({
  open,
  onClose,
  customerId,
  current,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  current: string | null;
  onSaved: () => void;
}) {
  const [classification, setClassification] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/classification`, { classification }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to classify customer'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set classification"
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
      <FormField label="Classification tag" hint="Free-form segmentation/risk tag (e.g. VIP, high-risk, agribusiness).">
        {(id) => <input id={id} value={classification} onChange={(e) => setClassification(e.target.value)} className={inputClasses} />}
      </FormField>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function KycModal({
  open,
  onClose,
  customerId,
  current,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  current: string;
  onSaved: () => void;
}) {
  const [kycStatus, setKycStatus] = useState(current);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/kyc-status`, { kycStatus, notes: notes || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to record KYC decision'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="KYC decision"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Save decision
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="KYC status">
          {(id) => (
            <select id={id} value={kycStatus} onChange={(e) => setKycStatus(e.target.value)} className={selectClasses}>
              <option value="pending">Pending</option>
              <option value="verified">Verified</option>
              <option value="rejected">Rejected</option>
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

function StatusModal({
  open,
  toStatus,
  onClose,
  customerId,
  onSaved,
}: {
  open: boolean;
  toStatus: 'active' | 'inactive' | null;
  onClose: () => void;
  customerId: string;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/${toStatus === 'active' ? 'reactivate' : 'deactivate'}`, { reason }),
    onSuccess: () => {
      onSaved();
      onClose();
      setReason('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to update status'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={toStatus === 'active' ? 'Reactivate customer' : 'Deactivate customer'}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Confirm
          </Button>
        </>
      }
    >
      <FormField label="Reason">{(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClasses} />}</FormField>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function TransferBranchModal({
  open,
  onClose,
  customerId,
  currentBranchId,
  branches,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  currentBranchId: string;
  branches: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const [toBranchId, setToBranchId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/branch-transfer`, { toBranchId, reason }),
    onSuccess: () => {
      onSaved();
      onClose();
      setToBranchId('');
      setReason('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to transfer branch'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Transfer to another branch"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !toBranchId} onClick={() => mutation.mutate()}>
            Transfer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Destination branch">
          {(id) => (
            <select id={id} value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className={selectClasses}>
              <option value="">Select a branch…</option>
              {branches.filter((b) => b.id !== currentBranchId).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </FormField>
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

function CloseRequestModal({
  open,
  onClose,
  customerId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  onSaved: () => void;
}) {
  const [reasonCode, setReasonCode] = useState('');
  const [reasonNotes, setReasonNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/closure-requests`, { reasonCode, reasonNotes }),
    onSuccess: () => {
      onSaved();
      setSubmitted(true);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to submit closure request'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSubmitted(false);
        setReasonCode('');
        setReasonNotes('');
      }}
      title="Request account closure"
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
            <Button variant="danger" size="sm" disabled={mutation.isPending || !reasonCode} onClick={() => mutation.mutate()}>
              Submit for approval
            </Button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-[13px] text-text-secondary">
          Closure request submitted for maker-checker approval. It will be finalized once a second user approves it under Approvals.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-secondary">
            Closure is dual-control: this creates a pending request, not an immediate closure. Someone other than you must approve it.
          </p>
          <FormField label="Reason code">{(id) => <input id={id} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={inputClasses} />}</FormField>
          <FormField label="Notes">{(id) => <input id={id} value={reasonNotes} onChange={(e) => setReasonNotes(e.target.value)} className={inputClasses} />}</FormField>
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

function AddDocumentModal({
  open,
  onClose,
  customerId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  onSaved: () => void;
}) {
  const [documentType, setDocumentType] = useState(DOCUMENT_TYPES[0]);
  const [fileUrl, setFileUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/documents`, { documentType, fileUrl }),
    onSuccess: () => {
      onSaved();
      onClose();
      setFileUrl('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to add document'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add document"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !fileUrl} onClick={() => mutation.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Document type">
          {(id) => (
            <select id={id} value={documentType} onChange={(e) => setDocumentType(e.target.value)} className={selectClasses}>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField label="File URL" hint="No file upload storage yet — paste a link to an already-hosted scan.">
          {(id) => <input id={id} value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} className={inputClasses} />}
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

function AddNextOfKinModal({
  open,
  onClose,
  customerId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/next-of-kin`, { fullName, relationship, phone, address }),
    onSuccess: () => {
      onSaved();
      onClose();
      setFullName('');
      setRelationship('');
      setPhone('');
      setAddress('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to add next of kin'),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add next of kin"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending || !fullName} onClick={() => mutation.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Full name">{(id) => <input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Relationship">{(id) => <input id={id} value={relationship} onChange={(e) => setRelationship(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Phone">{(id) => <input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClasses} />}</FormField>
        <FormField label="Address">{(id) => <input id={id} value={address} onChange={(e) => setAddress(e.target.value)} className={inputClasses} />}</FormField>
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
