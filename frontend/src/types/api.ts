// Mirrors backend/src/routes/auth.js GET /me and the users/roles/permissions
// shape from backend/src/middleware/auth.js — kept intentionally small and
// grown alongside each feature rather than modeling every backend column
// up front.

export interface CurrentUser {
  id: string;
  fullName: string;
  email: string;
  homeBranchId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  crossBranchAccessibleBranchIds: string[];
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  is_system_role: boolean;
}

export interface Permission {
  id: string;
  code: string;
  description: string | null;
}

export interface AdminUserRow {
  id: string;
  full_name: string;
  email: string;
  status: 'active' | 'suspended' | 'disabled';
  role_id: string;
  role_name: string;
  home_branch_id: string;
  home_branch_name: string;
  last_login_at: string | null;
  created_at: string;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'suspended' | 'under_review' | 'closed';
  region_id?: string | null;
  cluster_id?: string | null;
  created_at?: string;
}

export interface Customer {
  id: string;
  customer_type: 'individual' | 'sme' | 'group';
  branch_id: string;
  full_name: string;
  ghana_card_no: string | null;
  date_of_birth: string | null;
  gender: string | null;
  business_registration_no: string | null;
  contact_person_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: 'active' | 'inactive' | 'closed';
  classification: string | null;
  kyc_status: 'pending' | 'verified' | 'rejected';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerDocument {
  id: string;
  customer_id: string;
  document_type: string;
  file_url: string;
  uploaded_by: string;
  created_at: string;
}

export interface NextOfKin {
  id: string;
  customer_id: string;
  full_name: string;
  relationship: string | null;
  phone: string | null;
  address: string | null;
  created_at: string;
}

export interface CreditBureauLookup {
  id: string;
  customer_id: string;
  requested_by: string;
  response_payload: Record<string, unknown> | null;
  status: 'completed' | 'failed';
  requested_at: string;
}

export interface Customer360 {
  customer: Customer;
  documents: CustomerDocument[];
  nextOfKin: NextOfKin[];
  creditBureauLookups: CreditBureauLookup[];
  groupInfo:
    | { group: { id: string; customer_id: string }; members: { id: string; customer_id: string; full_name: string; kyc_status: string; is_leader?: boolean }[] }
    | { memberOfGroups: { group_id: string; group_name: string; joined_at: string }[] }
    | null;
  pendingModules: string[];
}

export interface Loan {
  id: string;
  loan_type: 'individual' | 'group' | 'overdraft';
  customer_id: string;
  branch_id: string;
  product_id: string;
  principal_pesewas: number;
  term_months: number;
  status: 'applied' | 'appraised' | 'pending_approval' | 'approved' | 'rejected' | 'disbursed' | 'closed' | 'written_off';
  disbursed_at: string | null;
  created_at: string;
}

export interface SavingsAccount {
  id: string;
  account_no: string;
  customer_id: string;
  branch_id: string;
  product_id: string;
  balance_pesewas: number;
  status: 'active' | 'dormant' | 'closed';
  opened_at: string;
}

export interface Investment {
  id: string;
  customer_id: string;
  branch_id: string;
  product_id: string;
  principal_pesewas: number;
  tenor_months: number;
  status: 'applied' | 'pending_approval' | 'rejected' | 'approved' | 'active' | 'matured' | 'redeemed';
  maturity_date: string | null;
  created_at: string;
}
