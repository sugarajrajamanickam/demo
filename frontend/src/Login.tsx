import { FormEvent, useState } from "react";
import { Role, login } from "./api";
import { USERNAME_HTML_PATTERN, USERNAME_MSG } from "./validation";

interface Props {
  onLogin: (token: string, role: Role) => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token, role } = await login(username, password);
      onLogin(token, role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Sign in</h2>
      <label>
        <span className="field-label-text">Username<span className="required-star" aria-hidden="true">*</span></span>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          pattern={USERNAME_HTML_PATTERN}
          title={USERNAME_MSG}
          maxLength={64}
        />
      </label>
      <label>
        <span className="field-label-text">Password<span className="required-star" aria-hidden="true">*</span></span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
