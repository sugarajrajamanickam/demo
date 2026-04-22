const TOKEN_KEY = "demo_access_token";
const ROLE_KEY = "demo_role";

export type Role = "admin" | "manager";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRole(): Role | null {
  const r = localStorage.getItem(ROLE_KEY);
  return r === "admin" || r === "manager" ? r : null;
}

export function setSession(token: string, role: Role): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  role: Role;
}

export async function login(username: string, password: string): Promise<{ token: string; role: Role }> {
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);

  const res = await fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(res.status === 401 ? "Invalid username or password" : `Login failed (${res.status})`);
  }
  const data = (await res.json()) as TokenResponse;
  setSession(data.access_token, data.role);
  return { token: data.access_token, role: data.role };
}

function authHeader(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${token}` };
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired — please log in again");
  }
  if (res.status === 403) {
    throw new Error("Forbidden — admin role required");
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type JobType = "new_bore" | "re_bore";

export interface CostSlice {
  start_ft: number;
  end_ft: number;
  feet: number;
  rate_per_ft: number;
  cost: number;
}

export interface CostBreakdown {
  depth: number;
  job_type: JobType;
  slices: CostSlice[];
  amount: number;
  casing_7_pieces: number;
  casing_7_price_per_piece: number;
  casing_7_amount: number;
  casing_10_pieces: number;
  casing_10_price_per_piece: number;
  casing_10_amount: number;
  casing_fee: number;
  rebore_price_per_foot: number;
  total: number;
}

export async function calculateCost(
  depth: number,
  casing_7_pieces: number,
  casing_10_pieces: number,
  job_type: JobType = "new_bore",
): Promise<CostBreakdown> {
  const res = await fetch("/api/cost", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({
      depth,
      job_type,
      casing_7_pieces,
      casing_10_pieces,
    }),
  });
  return handle<CostBreakdown>(res);
}

export interface CasingPrices {
  price_7in: number;
  price_10in: number;
}

export interface ReborePrice {
  price_per_foot: number;
}

export async function fetchReborePrice(): Promise<ReborePrice> {
  const res = await fetch("/api/rebore-price", {
    headers: { ...authHeader() },
  });
  return handle<ReborePrice>(res);
}

export async function updateReborePrice(
  price: ReborePrice,
): Promise<ReborePrice> {
  const res = await fetch("/api/admin/rebore-price", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(price),
  });
  return handle<ReborePrice>(res);
}

export interface QuotationSettings {
  validity_days: number;
}

export async function fetchQuotationSettings(): Promise<QuotationSettings> {
  const res = await fetch("/api/quotation-settings", {
    headers: { ...authHeader() },
  });
  return handle<QuotationSettings>(res);
}

export async function updateQuotationSettings(
  payload: QuotationSettings,
): Promise<QuotationSettings> {
  const res = await fetch("/api/admin/quotation-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<QuotationSettings>(res);
}

export async function fetchCasingPrices(): Promise<CasingPrices> {
  const res = await fetch("/api/casing-prices", {
    headers: { ...authHeader() },
  });
  return handle<CasingPrices>(res);
}

export async function updateCasingPrices(
  prices: CasingPrices
): Promise<CasingPrices> {
  const res = await fetch("/api/admin/casing-prices", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(prices),
  });
  return handle<CasingPrices>(res);
}

export interface BillRequest {
  depth: number;
  job_type: JobType;
  casing_7_pieces: number;
  casing_10_pieces: number;
  /** Preferred linkage: the customer chosen on the Calculate page. */
  customer_id?: number | null;
  customer_name: string;
  customer_phone: string;
  customer_address?: string | null;
  customer_state?: string | null;
  customer_state_code?: string | null;
  customer_gstin?: string | null;
}

export interface BillLineItem {
  description: string;
  hsn_sac: string;
  qty: number;
  qty_unit: string;
  rate: number;
  amount: number;
  is_taxable: boolean;
}

export interface BillPreview {
  invoice_number: string;
  invoice_date: string;
  supplier_name: string;
  supplier_address_lines: string[];
  supplier_state: string;
  supplier_state_code: string;
  supplier_gstin: string;
  supplier_phone: string;
  supplier_email: string;

  customer_name: string;
  customer_phone: string;
  customer_address: string | null;
  customer_state: string | null;
  customer_state_code: string | null;
  customer_gstin: string | null;

  job_type: JobType;
  hsn_sac: string;
  description: string;
  depth: number;

  casing_7_pieces: number;
  casing_7_price_per_piece: number;
  casing_7_amount: number;
  casing_10_pieces: number;
  casing_10_price_per_piece: number;
  casing_10_amount: number;
  casing_fee: number;

  line_items: BillLineItem[];
  taxable_value: number;
  non_taxable_total: number;
  is_interstate: boolean;
  cgst_percent: number;
  sgst_percent: number;
  igst_percent: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_tax: number;
  grand_total: number;
  amount_in_words: string;
}

export async function previewBill(req: BillRequest): Promise<BillPreview> {
  const res = await fetch("/api/bill/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  return handle<BillPreview>(res);
}

/** Fetch the invoice PDF and trigger a browser download. */
export async function downloadBillPdf(req: BillRequest): Promise<string> {
  const res = await fetch("/api/bill/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    let detail = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  const invoiceNumber = res.headers.get("X-Invoice-Number") || "invoice";
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${invoiceNumber.replace(/\//g, "-")}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return invoiceNumber;
}

// --- Customers & payments ---------------------------------------------------

export type PaymentMode = "cash" | "upi" | "card" | "bank_transfer" | "cheque" | "other";

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

export interface Customer {
  id: number;
  name: string;
  phone: string;
  address: string | null;
  state: string | null;
  state_code: string | null;
  gstin: string | null;
  /** ISO yyyy-mm-dd; always set for customers created after the feature ship. */
  date_of_request: string;
  /** ISO yyyy-mm-dd or empty string when the bore hasn't been performed yet. */
  actual_date_of_bore: string;
  bore_type: JobType;
  created_at: string;
}

export interface CustomerCreate {
  name: string;
  phone: string;
  address?: string | null;
  state?: string | null;
  state_code?: string | null;
  gstin?: string | null;
  /** Omit or leave empty to default to today on the server. */
  date_of_request?: string | null;
  actual_date_of_bore?: string | null;
  bore_type: JobType;
}

export interface BillSummary {
  id: number;
  invoice_number: string;
  invoice_date: string;
  job_type: string;
  depth: number;
  grand_total: number;
  paid_total: number;
  outstanding: number;
}

export interface CustomerWithBills {
  customer: Customer;
  bills: BillSummary[];
  total_billed: number;
  total_paid: number;
  total_outstanding: number;
}

export interface PaymentRecord {
  id: number;
  bill_id: number;
  amount: number;
  paid_at: string;
  mode: PaymentMode;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillWithPayments {
  bill: BillSummary;
  customer: Customer;
  payments: PaymentRecord[];
}

export interface PaymentCreate {
  amount: number;
  paid_at?: string | null;
  mode: PaymentMode;
  note?: string | null;
}

export async function searchCustomers(q: string, limit = 20): Promise<Customer[]> {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  params.set("limit", String(limit));
  const res = await fetch(`/api/customers/search?${params.toString()}`, {
    headers: { ...authHeader() },
  });
  return handle<Customer[]>(res);
}

export async function listCustomers(): Promise<Customer[]> {
  const res = await fetch(`/api/customers`, { headers: { ...authHeader() } });
  return handle<Customer[]>(res);
}

export async function createCustomer(payload: CustomerCreate): Promise<Customer> {
  const res = await fetch("/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<Customer>(res);
}

export async function fetchCustomer(id: number): Promise<CustomerWithBills> {
  const res = await fetch(`/api/customers/${id}`, { headers: { ...authHeader() } });
  return handle<CustomerWithBills>(res);
}

export async function updateCustomer(id: number, payload: CustomerCreate): Promise<Customer> {
  const res = await fetch(`/api/customers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<Customer>(res);
}

export async function fetchBillWithPayments(billId: number): Promise<BillWithPayments> {
  const res = await fetch(`/api/bills/${billId}`, { headers: { ...authHeader() } });
  return handle<BillWithPayments>(res);
}

export async function addPayment(billId: number, payload: PaymentCreate): Promise<PaymentRecord> {
  const res = await fetch(`/api/bills/${billId}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<PaymentRecord>(res);
}

export async function updatePayment(paymentId: number, payload: PaymentCreate): Promise<PaymentRecord> {
  const res = await fetch(`/api/payments/${paymentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<PaymentRecord>(res);
}

export async function deletePayment(paymentId: number): Promise<void> {
  const res = await fetch(`/api/payments/${paymentId}`, {
    method: "DELETE",
    headers: { ...authHeader() },
  });
  await handle<void>(res);
}

// --- Dashboard --------------------------------------------------------------

export type DashboardStatus = "all" | "paid" | "partial" | "unpaid";
export type DashboardRowStatus = "paid" | "partial" | "unpaid" | "no_bills";

export interface DashboardBill {
  id: number;
  invoice_number: string;
  invoice_date: string;
  job_type: string;
  depth: number;
  grand_total: number;
  paid_total: number;
  outstanding: number;
}

export interface DashboardCustomerRow {
  customer_id: number;
  name: string;
  phone: string;
  /** ISO yyyy-mm-dd; empty for legacy rows that pre-date the feature. */
  date_of_request: string;
  /** ISO yyyy-mm-dd; empty when the bore hasn't been performed yet. */
  actual_date_of_bore: string;
  bore_type: string;
  total_billed: number;
  total_paid: number;
  outstanding: number;
  bill_count: number;
  payment_count: number;
  status: DashboardRowStatus;
  last_activity_at: string;
  bills: DashboardBill[];
}

export interface DashboardResponse {
  customers: DashboardCustomerRow[];
  total_customers: number;
  // Overall roll-ups across ALL filtered customers (not just the current page).
  total_billed: number;
  total_paid: number;
  total_outstanding: number;
  limit: number;
  offset: number;
}

export interface DashboardFilters {
  q?: string;
  status?: DashboardStatus;
  bill_from?: string;
  bill_to?: string;
  payment_from?: string;
  payment_to?: string;
  limit?: number;
  offset?: number;
}

function buildDashboardQuery(filters: DashboardFilters): string {
  const params = new URLSearchParams();
  if (filters.q && filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.status && filters.status !== "all") params.set("status", filters.status);
  if (filters.bill_from) params.set("bill_from", filters.bill_from);
  if (filters.bill_to) params.set("bill_to", filters.bill_to);
  if (filters.payment_from) params.set("payment_from", filters.payment_from);
  if (filters.payment_to) params.set("payment_to", filters.payment_to);
  if (filters.limit != null) params.set("limit", String(filters.limit));
  if (filters.offset != null) params.set("offset", String(filters.offset));
  return params.toString();
}

export interface StatementCustomer {
  id: number;
  name: string;
  phone: string;
  address?: string | null;
  state?: string | null;
  gstin?: string | null;
}

export interface StatementBill {
  id: number;
  invoice_number: string;
  invoice_date: string;
  job_type: string;
  depth: number;
  casing_7_pieces: number;
  casing_10_pieces: number;
  taxable_value: number;
  total_tax: number;
  non_taxable_total: number;
  grand_total: number;
  paid_total: number;
  outstanding: number;
}

export interface StatementPayment {
  id: number;
  bill_id: number;
  invoice_number: string;
  amount: number;
  paid_at: string;
  mode: string;
  note?: string | null;
}

export interface StatementResponse {
  customer: StatementCustomer;
  bills: StatementBill[];
  payments: StatementPayment[];
  total_billed: number;
  total_paid: number;
  outstanding: number;
  generated_at: string;
}

export async function fetchCustomerStatementJson(
  customerId: number,
  filters: Omit<DashboardFilters, "q" | "status" | "limit" | "offset">,
): Promise<StatementResponse> {
  const query = buildDashboardQuery(filters);
  const url = query
    ? `/api/dashboard/customers/${customerId}/statement?${query}`
    : `/api/dashboard/customers/${customerId}/statement`;
  const res = await fetch(url, { headers: { ...authHeader() } });
  return handle<StatementResponse>(res);
}

export async function fetchDashboardCustomers(
  filters: DashboardFilters,
): Promise<DashboardResponse> {
  const query = buildDashboardQuery(filters);
  const url = query
    ? `/api/dashboard/customers?${query}`
    : "/api/dashboard/customers";
  const res = await fetch(url, { headers: { ...authHeader() } });
  return handle<DashboardResponse>(res);
}

export async function downloadCustomerStatementPdf(
  customerId: number,
  filters: Omit<DashboardFilters, "q" | "status">,
  fallbackName: string,
): Promise<void> {
  const query = buildDashboardQuery(filters);
  const url = query
    ? `/api/dashboard/customers/${customerId}/statement.pdf?${query}`
    : `/api/dashboard/customers/${customerId}/statement.pdf`;
  const res = await fetch(url, { headers: { ...authHeader() } });
  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    let detail = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `statement-${fallbackName || "customer"}.pdf`;
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export interface QuotationRequest {
  depth: number;
  job_type: JobType;
  casing_7_pieces: number;
  casing_10_pieces: number;
  customer_name: string;
  customer_phone: string;
}

export interface QuotationPreview {
  quotation_number: string;
  quotation_date: string;
  valid_until: string;
  validity_days: number;

  supplier_name: string;
  supplier_address_lines: string[];
  supplier_state: string;
  supplier_state_code: string;
  supplier_phone: string;
  supplier_email: string;

  customer_name: string;
  customer_phone: string;

  job_type: JobType;
  depth: number;

  line_items: BillLineItem[];
  subtotal: number;
  gst_rate_percent: number;
  gst_note: string;
}

export async function previewQuotation(
  req: QuotationRequest,
): Promise<QuotationPreview> {
  const res = await fetch("/api/quotation/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  return handle<QuotationPreview>(res);
}

export async function downloadQuotationPdf(
  req: QuotationRequest,
): Promise<string> {
  const res = await fetch("/api/quotation/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    let detail = `Download failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  const quotationNumber =
    res.headers.get("X-Quotation-Number") || "quotation";
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${quotationNumber.replace(/\//g, "-")}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return quotationNumber;
}

export interface Me {
  id: number;
  username: string;
  mobile: string;
  role: Role;
  full_name: string | null;
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch("/api/me", { headers: { ...authHeader() } });
  return handle<Me>(res);
}

export interface AdminUser {
  id: number;
  username: string;
  mobile: string;
  role: Role;
  full_name: string | null;
  security_question: string | null;
  has_security_question: boolean;
}

export interface AdminUserCreate {
  username: string;
  mobile: string;
  password: string;
  role: Role;
  full_name: string;
  security_question?: string | null;
  security_answer?: string | null;
}

export type AdminUserUpdate = Partial<AdminUserCreate> & {
  security_answer?: string;
};

export interface AdminUserPage {
  items: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListUsersQuery {
  limit?: number;
  offset?: number;
  q?: string;
  role?: Role | "";
}

export async function listUsers(query: ListUsersQuery = {}): Promise<AdminUserPage> {
  const params = new URLSearchParams();
  params.set("limit", String(query.limit ?? 25));
  params.set("offset", String(query.offset ?? 0));
  if (query.q && query.q.trim().length > 0) params.set("q", query.q.trim());
  if (query.role) params.set("role", query.role);
  const res = await fetch(`/api/admin/users?${params.toString()}`, {
    headers: { ...authHeader() },
  });
  return handle<AdminUserPage>(res);
}

export async function createUser(payload: AdminUserCreate): Promise<AdminUser> {
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  return handle<AdminUser>(res);
}

// Fields where an empty string is meaningless and should be dropped rather
// than sent to the server (e.g. a blank "new password" input means "don't
// change"). `full_name` is excluded so admins can deliberately clear it.
const EMPTY_STRING_DROP_FIELDS = new Set(["username", "mobile", "password"]);

export async function updateUser(id: number, payload: AdminUserUpdate): Promise<AdminUser> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (v === "" && EMPTY_STRING_DROP_FIELDS.has(k)) continue;
    clean[k] = v;
  }
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(clean),
  });
  return handle<AdminUser>(res);
}

// --- Password reset (unauthenticated) ---------------------------------------

export async function forgotPassword(username: string): Promise<{ security_question: string }> {
  const res = await fetch("/api/password/forgot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return (await res.json()) as { security_question: string };
}

export async function resetPassword(
  username: string,
  security_answer: string,
  new_password: string,
): Promise<void> {
  const res = await fetch("/api/password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, security_answer, new_password }),
  });
  if (!res.ok) {
    let detail =
      res.status === 401
        ? "Security answer is incorrect"
        : `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
}

export async function deleteUser(id: number): Promise<void> {
  const res = await fetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: { ...authHeader() },
  });
  await handle<void>(res);
}

// --- Admin-defined rate ranges ---------------------------------------------

export type RateRangeMode = "fixed" | "step_up";

export interface RateRange {
  start_ft: number;
  end_ft: number;
  mode: RateRangeMode;
  rate: number;
}

export interface DerivedSlice {
  start_ft: number;
  end_ft: number;
  rate: number;
  mode: RateRangeMode;
}

export interface RatesResponse {
  ranges: RateRange[];
  derived: DerivedSlice[];
  max_depth_ft: number;
}

export async function listRates(): Promise<RatesResponse> {
  const res = await fetch("/api/rates", { headers: { ...authHeader() } });
  return handle<RatesResponse>(res);
}

export async function updateRates(ranges: RateRange[]): Promise<RatesResponse> {
  const res = await fetch("/api/admin/rates", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ ranges }),
  });
  return handle<RatesResponse>(res);
}
