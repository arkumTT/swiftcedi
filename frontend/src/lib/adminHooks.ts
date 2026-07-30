import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import type { Role, Permission, Branch, StaffMember, PaymentMode } from '../types/api';

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/rbac/roles') });
}

export function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/rbac/permissions') });
}

export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });
}

// Minimal staff directory for dropdowns (e.g. the repayment "Receiver"
// picker) — GET /rbac/staff is deliberately not gated behind
// rbac.manage_users like the admin Users & Roles table is.
export function useStaff(branchId?: string) {
  return useQuery({
    queryKey: ['staff', branchId],
    queryFn: () => api.get<StaffMember[]>('/rbac/staff', branchId ? { branchId } : undefined),
  });
}

export function usePaymentModes() {
  return useQuery({ queryKey: ['payment-modes'], queryFn: () => api.get<PaymentMode[]>('/loans/payment-modes') });
}
