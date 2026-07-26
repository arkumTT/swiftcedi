import { useQuery } from '@tanstack/react-query';
import { api } from './apiClient';
import type { Role, Permission, Branch } from '../types/api';

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/rbac/roles') });
}

export function usePermissions() {
  return useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/rbac/permissions') });
}

export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });
}
