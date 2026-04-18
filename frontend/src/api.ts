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

export interface CostSlice {
  start_ft: number;
  end_ft: number;
  feet: number;
  rate_per_ft: number;
  cost: number;
}

export interface CostBreakdown {
  depth: number;
  casing: number;
  slices: CostSlice[];
  amount: number;
  casing_fee: number;
  total: number;
}

export async function calculateCost(
  depth: number,
  casing: number
): Promise<CostBreakdown> {
  const res = await fetch("/api/cost", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ depth, casing }),
  });
  return handle<CostBreakdown>(res);
}

export interface BillRequest {
  depth: number;
  casing: number;
  customer_name: string;
  customer_phone: string;
  customer_address?: string | null;
  customer_state?: string | null;
  customer_state_code?: string | null;
  customer_gstin?: string | null;
}

export interface BillLineItem {
  start_ft: number;
  end_ft: number;
  feet: number;
  rate_per_ft: number;
  amount: number;
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

  hsn_sac: string;
  description: string;
  depth: number;
  casing_fee: number;

  line_items: BillLineItem[];
  taxable_value: number;
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
