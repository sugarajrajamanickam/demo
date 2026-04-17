const TOKEN_KEY = "demo_access_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(username: string, password: string): Promise<string> {
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
  const data = (await res.json()) as { access_token: string };
  setToken(data.access_token);
  return data.access_token;
}

export interface AddResponse {
  depth: number;
  casing: number;
  sum: number;
}

export async function addValues(depth: number, casing: number): Promise<AddResponse> {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch("/api/add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ depth, casing }),
  });

  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as AddResponse;
}
