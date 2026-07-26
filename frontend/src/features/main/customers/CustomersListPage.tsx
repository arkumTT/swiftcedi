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
import { formatDate } from '../../../lib/format';
import type { Customer } from '../../../types/api';

const CUSTOMER_TYPES = [
  { value: '', label: 'All types' },
  { value: 'individual', label: 'Individual' },
  { value: 'sme', label: 'SME' },
  { value: 'group', label: 'Group' },
];

export function CustomersListPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const crossBranch = isCrossBranchRole(user!.roleName);
  const { data: branches } = useBranches();

  const [branchId, setBranchId] = useState(crossBranch ? '' : user!.homeBranchId);
  const [customerType, setCustomerType] = useState('');
  const [status, setStatus] = useState('');
  const [classification, setClassification] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const customersQuery = useQuery({
    queryKey: ['customers', { branchId, customerType, status, classification }],
    queryFn: () =>
      api.get<Customer[]>('/customers', {
        branchId: crossBranch ? branchId : user!.homeBranchId,
        customerType,
        status,
        classification,
      }),
  });

  const columns: Column<Customer>[] = [
    {
      key: 'name',
      header: 'Customer',
      render: (c) => (
        <div>
          <p className="font-medium">{c.full_name}</p>
          <p className="text-[12px] text-text-secondary">{c.ghana_card_no ?? c.business_registration_no ?? '—'}</p>
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (c) => <span className="capitalize">{c.customer_type}</span> },
    { key: 'branch', header: 'Branch', render: (c) => branches?.find((b) => b.id === c.branch_id)?.name ?? c.branch_id },
    { key: 'kyc', header: 'KYC', render: (c) => <StatusBadge status={c.kyc_status} /> },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'classification', header: 'Classification', render: (c) => c.classification ?? '—' },
    { key: 'created', header: 'Onboarded', render: (c) => formatDate(c.created_at) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Customers & CRM"
        actions={
          hasPermission('customer.create') && (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New customer
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
          <select value={customerType} onChange={(e) => setCustomerType(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClasses + ' h-8 text-[12.5px]'}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="closed">Closed</option>
          </select>
          <input
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
            placeholder="Classification tag…"
            className="h-8 w-40 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-text-primary focus-visible:border-accent"
          />
        </FilterToolbar>
        <DataTable
          columns={columns}
          rows={customersQuery.data ?? []}
          getRowKey={(c) => c.id}
          isLoading={customersQuery.isLoading}
          error={customersQuery.error instanceof ApiError ? customersQuery.error.message : null}
          onRetry={() => customersQuery.refetch()}
          onRowClick={(c) => navigate(`/app/customers/${c.id}`)}
          emptyTitle="No customers match these filters"
          emptyDescription="Note: there is no cross-entity text search yet — use the filters above, or open a specific customer by ID."
        />
      </Card>

      <CreateCustomerModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        branches={branches ?? []}
        defaultBranchId={crossBranch ? '' : user!.homeBranchId}
        onCreated={(id) => {
          queryClient.invalidateQueries({ queryKey: ['customers'] });
          navigate(`/app/customers/${id}`);
        }}
      />
    </div>
  );
}

interface CreateCustomerModalProps {
  open: boolean;
  onClose: () => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  onCreated: (customerId: string) => void;
}

function CreateCustomerModal({ open, onClose, branches, defaultBranchId, onCreated }: CreateCustomerModalProps) {
  const [customerType, setCustomerType] = useState<'individual' | 'sme'>('individual');
  const [fullName, setFullName] = useState('');
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [ghanaCardNo, setGhanaCardNo] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState('');
  const [businessRegistrationNo, setBusinessRegistrationNo] = useState('');
  const [contactPersonName, setContactPersonName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCustomerType('individual');
    setFullName('');
    setBranchId(defaultBranchId);
    setGhanaCardNo('');
    setDateOfBirth('');
    setGender('');
    setBusinessRegistrationNo('');
    setContactPersonName('');
    setPhone('');
    setEmail('');
    setAddress('');
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/customers', {
        customerType,
        fullName,
        branchId,
        ghanaCardNo: customerType === 'individual' ? ghanaCardNo : undefined,
        dateOfBirth: dateOfBirth || undefined,
        gender: gender || undefined,
        businessRegistrationNo: customerType === 'sme' ? businessRegistrationNo : undefined,
        contactPersonName: customerType === 'sme' ? contactPersonName : undefined,
        phone: phone || undefined,
        email: email || undefined,
        address: address || undefined,
      }),
    onSuccess: (customer) => {
      onCreated(customer.id);
      onClose();
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Unable to create customer'),
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        reset();
      }}
      title="New customer"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Create customer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Groups are a distinct backend flow (createGroup, not createCustomer)
            with their own membership lifecycle — this modal only covers
            individual/sme onboarding; groups are formed from the Customer
            360 page of an existing customer once members are onboarded. */}
        <FormField label="Customer type">
          {(id) => (
            <select id={id} value={customerType} onChange={(e) => setCustomerType(e.target.value as 'individual' | 'sme')} className={selectClasses}>
              <option value="individual">Individual</option>
              <option value="sme">SME</option>
            </select>
          )}
        </FormField>
        <FormField label="Full name">{(id) => <input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClasses} />}</FormField>
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
        {customerType === 'individual' ? (
          <>
            <FormField label="Ghana Card number" hint="Format: GHA-XXXXXXXXX-X">
              {(id) => <input id={id} value={ghanaCardNo} onChange={(e) => setGhanaCardNo(e.target.value)} placeholder="GHA-123456789-0" className={inputClasses} />}
            </FormField>
            <FormField label="Date of birth">
              {(id) => <input id={id} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className={inputClasses} />}
            </FormField>
            <FormField label="Gender">
              {(id) => (
                <select id={id} value={gender} onChange={(e) => setGender(e.target.value)} className={selectClasses}>
                  <option value="">Not specified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              )}
            </FormField>
          </>
        ) : (
          <>
            <FormField label="Business registration number">
              {(id) => <input id={id} value={businessRegistrationNo} onChange={(e) => setBusinessRegistrationNo(e.target.value)} className={inputClasses} />}
            </FormField>
            <FormField label="Contact person">
              {(id) => <input id={id} value={contactPersonName} onChange={(e) => setContactPersonName(e.target.value)} className={inputClasses} />}
            </FormField>
          </>
        )}
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
