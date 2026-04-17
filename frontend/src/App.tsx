import { useEffect, useState } from "react";
import Login from "./Login";
import Calculator from "./Calculator";
import Admin from "./Admin";
import { Role, clearToken, fetchMe, getRole, getToken } from "./api";

type View = "calculate" | "admin";

interface Session {
  username: string;
  role: Role;
}

export default function App() {
  const [token, setLocalToken] = useState<string | null>(getToken());
  const [role, setRole] = useState<Role | null>(getRole());
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("calculate");

  const handleLogout = () => {
    clearToken();
    setLocalToken(null);
    setRole(null);
    setSession(null);
    setView("calculate");
  };

  const handleLogin = (t: string, r: Role) => {
    setLocalToken(t);
    setRole(r);
  };

  // After login / on refresh, hydrate the signed-in user's profile so we can
  // show their name and enforce self-aware UI (e.g. "can't delete yourself").
  useEffect(() => {
    if (!token) {
      setSession(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (!cancelled) setSession({ username: me.username, role: me.role });
      } catch {
        if (!cancelled) handleLogout();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const isAdmin = role === "admin";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <h1>Depth &amp; Casing</h1>
          {token && (
            <nav className="header-nav">
              <button
                type="button"
                className={`nav-btn ${view === "calculate" ? "active" : ""}`}
                onClick={() => setView("calculate")}
              >
                Calculate
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className={`nav-btn ${view === "admin" ? "active" : ""}`}
                  onClick={() => setView("admin")}
                >
                  Admin
                </button>
              )}
            </nav>
          )}
        </div>
        {token && (
          <div className="header-right">
            {session && (
              <span className="session-info">
                {session.username} <span className={`role-pill role-${session.role}`}>{session.role}</span>
              </span>
            )}
            <button className="btn-link" onClick={handleLogout}>
              Log out
            </button>
          </div>
        )}
      </header>
      <main className="app-main">
        {!token && <Login onLogin={handleLogin} />}
        {token && view === "calculate" && <Calculator onUnauthorized={handleLogout} />}
        {token && view === "admin" && isAdmin && (
          <Admin onUnauthorized={handleLogout} currentUsername={session?.username ?? ""} />
        )}
      </main>
    </div>
  );
}
