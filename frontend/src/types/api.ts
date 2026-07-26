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

export interface Region {
  id: string;
  name: string;
}

export interface Cluster {
  id: string;
  name: string;
  region_id: string;
}

export interface BranchStaffAssignment {
  id: string;
  user_id: string;
  branch_id: string;
  start_date: string;
  end_date: string | null;
}

export interface BranchPerformance {
  branchId: number;
  asOfDate: string | null;
  cashInHandPesewas: number;
  vaultPesewas: number;
  cashPositionPesewas: number;
  incomePesewas: number;
  expensePesewas: number;
  netIncomePesewas: number;
  costToIncomeRatio: number | null;
  headcount: number;
  pendingMetrics: string[];
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

export interface JournalEntry {
  id: string;
  branch_id: string;
  reference: string;
  entry_type: 'standard' | 'prior_period_adjustment';
  description: string | null;
  entry_date: string;
  source_module: string;
  status: 'posted' | 'reversed';
  created_at: string;
}

export interface JournalEntryLine {
  id: string;
  journal_entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit_pesewas: number;
  credit_pesewas: number;
  branch_id: string;
}

export interface JournalEntryDetail {
  entry: JournalEntry;
  lines: JournalEntryLine[];
}

export interface CashierTill {
  id: string;
  branch_id: string;
  cashier_id: string;
  business_date: string;
  opening_balance_pesewas: number;
  closing_balance_pesewas: number | null;
  expected_closing_balance_pesewas: number | null;
  variance_pesewas: number | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
}

export interface CashBackRequest {
  id: string;
  till_id: string;
  amount_pesewas: number;
  threshold_flag: boolean;
  status: 'pending' | 'paid' | 'rejected';
  created_at: string;
}

export interface TransactionReversal {
  id: string;
  branch_id: string;
  original_journal_entry_id: string;
  reason_code: string;
  notes: string | null;
  status: 'pending' | 'approved' | 'reversed' | 'rejected';
  reversal_journal_entry_id: string | null;
  created_at: string;
}

export interface DayCloseSnapshot {
  id: string;
  branch_id: string;
  period_type: 'day' | 'month' | 'year';
  period_start: string;
  period_end: string;
  cash_in_hand_balance_pesewas: number;
  vault_balance_pesewas: number;
  tills_closed_count: number;
  closed_at: string;
}

export interface BranchCashPosition {
  branchId: number;
  cashInHandBalancePesewas: number;
  vaultBalancePesewas: number;
  totalCashPositionPesewas: number;
  openTillCount: number;
  totalOpenTillFloatPesewas: number;
  openTills: CashierTill[];
}

export interface ConsolidatedCashPosition {
  branches: BranchCashPosition[];
  totals: {
    cashInHandBalancePesewas: number;
    vaultBalancePesewas: number;
    totalCashPositionPesewas: number;
    openTillCount: number;
  };
}

export interface SavingsProduct {
  id: string;
  name: string;
  code: string;
  min_balance_pesewas: number;
  maintenance_fee_pesewas: number;
  withdrawal_fee_pesewas: number;
  min_balance_charge_pesewas: number;
  withdrawal_approval_threshold_pesewas: number;
  allows_overdraft: boolean;
  status: 'active' | 'inactive';
}

export interface SavingsTransaction {
  id: string;
  account_id: string;
  txn_type: 'deposit' | 'withdrawal' | 'maintenance_fee' | 'withdrawal_fee' | 'min_balance_charge' | 'standing_order_out' | 'standing_order_in' | 'susu_payout';
  amount_pesewas: number;
  balance_after_pesewas: number;
  description: string | null;
  created_at: string;
}

export interface SavingsStatement {
  account: SavingsAccount;
  transactions: SavingsTransaction[];
}

export interface AccountReconciliation {
  accountId: number;
  storedBalancePesewas: number;
  ledgerSumPesewas: number;
  reconciled: boolean;
}

export interface SusuAccount {
  id: string;
  account_no: string;
  customer_id: string;
  branch_id: string;
  payout_savings_account_id: string | null;
  cycle_length_days: number;
  expected_collection_pesewas: number;
  target_amount_pesewas: number;
  collected_pesewas: number;
  commission_rate_bps: number;
  assigned_agent_id: string | null;
  cycle_start_date: string;
  cycle_end_date: string;
  status: 'active' | 'completed' | 'uncompleted' | 'paid_out';
}

export interface SusuCollection {
  id: string;
  susu_account_id: string;
  agent_id: string;
  amount_pesewas: number;
  collection_date: string;
  remittance_id: string | null;
}

export interface StandingOrder {
  id: string;
  source_account_id: string;
  destination_account_id: string;
  amount_pesewas: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  next_run_date: string;
  end_date: string | null;
  status: 'active' | 'paused' | 'suspended' | 'completed' | 'cancelled';
  consecutive_failures: number;
  last_error: string | null;
}

export interface LoanProduct {
  id: string;
  name: string;
  code: string;
  loan_type: 'individual' | 'group' | 'overdraft';
  interest_method: 'flat' | 'reducing_balance';
  annual_interest_rate_bps: number;
  min_term_months: number;
  max_term_months: number;
  min_principal_pesewas: number;
  max_principal_pesewas: number;
  fee_schedule: { code?: string; type: 'flat' | 'percent_of_principal'; amountPesewas?: number; rateBps?: number }[];
  par_bucket_days: number[];
  reason_codes: string[];
  status: 'active' | 'inactive';
}

export interface LoanAppraisal {
  id: string;
  loan_id: string;
  appraiser_id: string;
  checklist: Record<string, unknown>;
  recommendation: 'recommend' | 'decline';
  notes: string | null;
  created_at: string;
}

export interface LoanScheduleRow {
  id: string;
  loan_id: string;
  installment_number: number;
  due_date: string;
  principal_due_pesewas: number;
  interest_due_pesewas: number;
  fees_due_pesewas: number;
  principal_paid_pesewas: number;
  interest_paid_pesewas: number;
  fees_paid_pesewas: number;
  status: 'pending' | 'partially_paid' | 'paid';
}

export interface LoanRepayment {
  id: string;
  loan_id: string;
  amount_pesewas: number;
  principal_component_pesewas: number;
  interest_component_pesewas: number;
  fees_component_pesewas: number;
  payment_date: string;
  received_by: string;
}

export interface LoanCollateral {
  id: string;
  loan_id: string;
  description: string;
  estimated_value_pesewas: number | null;
  verification_status: 'pending' | 'verified' | 'rejected';
}

export interface LoanGuarantor {
  id: string;
  loan_id: string;
  customer_id: string | null;
  guarantor_name: string | null;
  guarantor_phone: string | null;
  guaranteed_amount_pesewas: number | null;
  verification_status: 'pending' | 'verified' | 'rejected';
}

export interface LoanCalculatorResult {
  productId: string;
  principalPesewas: number;
  termMonths: number;
  interestMethod: string;
  annualInterestRateBps: number;
  feesPesewas: number;
  netDisbursedPesewas: number;
  totalInterestPesewas: number;
  totalRepayablePesewas: number;
  schedule: { installmentNumber: number; dueDate: string; principalDuePesewas: number; interestDuePesewas: number }[];
}

export interface ArrearsReport {
  asOfDate: string;
  branchId: number | null;
  loans: { loanId: number; customerId: number; branchId: number; outstandingPrincipalPesewas: number; daysOverdue: number; bucket: string | null }[];
  totals: { totalOutstandingPesewas: number; totalAtRiskPesewas: number; buckets: Record<string, number>; parRatio: number };
}

export interface OverdraftStatus {
  loanId: number;
  status: string;
  savingsAccountId: string;
  limitPesewas: number;
  balancePesewas: number;
  drawnPesewas: number;
  availablePesewas: number;
}

export interface InvestmentProduct {
  id: string;
  name: string;
  code: string;
  tenor_months: number;
  annual_interest_rate_bps: number;
  min_principal_pesewas: number;
  max_principal_pesewas: number | null;
  payout_frequency: 'monthly' | 'at_maturity';
  early_withdrawal_penalty_bps: number;
  payout_approval_threshold_pesewas: number;
  status: 'active' | 'inactive';
}

export interface InvestmentAccrual {
  id: string;
  investment_id: string;
  accrual_date: string;
  principal_balance_pesewas: number;
  interest_pesewas: number;
}

export interface InvestmentPayout {
  id: string;
  investment_id: string;
  amount_pesewas: number;
  threshold_flag: boolean;
  status: 'pending' | 'paid' | 'rejected';
  payment_reference: string | null;
  created_at: string;
}

export interface InvestmentRedemption {
  id: string;
  investment_id: string;
  is_early: boolean;
  principal_pesewas: number;
  accrued_interest_pesewas: number;
  penalty_pesewas: number;
  interest_payable_pesewas: number;
  total_payout_pesewas: number;
  status: 'pending' | 'paid' | 'rejected';
  payment_reference: string | null;
}

export interface InvestorStatement {
  investment: Investment;
  accruals: InvestmentAccrual[];
  payouts: InvestmentPayout[];
  redemption: InvestmentRedemption | null;
  totalAccruedPesewas: number;
  totalPaidOutPesewas: number;
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
