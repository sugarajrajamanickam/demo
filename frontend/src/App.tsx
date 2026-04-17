import { useState } from "react";
import Login from "./Login";
import Calculator from "./Calculator";
import { clearToken, getToken } from "./api";

export default function App() {
  const [token, setLocalToken] = useState<string | null>(getToken());

  const handleLogin = (t: string) => setLocalToken(t);
  const handleLogout = () => {
    clearToken();
    setLocalToken(null);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Depth &amp; Casing</h1>
        {token && (
          <button className="btn-link" onClick={handleLogout}>
            Log out
          </button>
        )}
      </header>
      <main className="app-main">
        {token ? <Calculator onUnauthorized={handleLogout} /> : <Login onLogin={handleLogin} />}
      </main>
    </div>
  );
}
