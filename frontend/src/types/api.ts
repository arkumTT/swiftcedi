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
