import { FormEvent, useState } from "react";
import { forgotPassword, resetPassword } from "./api";
import { PASSWORD_HTML_PATTERN, PASSWORD_MSG } from "./validation";

interface Props {
  initialUsername?: string;
  onClose: () => void;
}

/**
 * Self-serve password reset via security question.
 *
 * Two-step flow rendered as a modal on top of the Login form:
 *   1. Enter username -> server returns the user's security question.
 *   2. Answer the question + choose a new password -> server verifies
 *      and resets the password; the modal shows a success state and
 *      the user can close it and log in with the new password.
 */
export default function ForgotPassword({ initialUsername = "", onClose }: Props) {
  const [username, setUsername] = useState(initialUsername);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const handleLookup = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await forgotPassword(username.trim());
      setQuestion(res.security_question);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resetPassword(username.trim(), answer, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Reset password"
      onClick={onClose}
    >
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Reset password</h3>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {done ? (
          <div>
            <p className="success">
              Password updated. You can now sign in with the new password.
            </p>
            <button type="button" onClick={onClose}>
              Back to sign in
            </button>
          </div>
        ) : question === null ? (
          <form onSubmit={handleLookup}>
            <label>
              <span className="field-label-text">
                Username<span className="required-star" aria-hidden="true">*</span>
              </span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                maxLength={64}
                autoComplete="username"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? "Looking up…" : "Next"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset}>
            <p className="muted">
              Security question for <strong>{username}</strong>:
            </p>
            <p>
              <em>{question}</em>
            </p>
            <label>
              <span className="field-label-text">
                Your answer<span className="required-star" aria-hidden="true">*</span>
              </span>
              <input
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                required
                maxLength={128}
                autoComplete="off"
              />
            </label>
            <label>
              <span className="field-label-text">
                New password<span className="required-star" aria-hidden="true">*</span>
              </span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                maxLength={128}
                pattern={PASSWORD_HTML_PATTERN}
                title={PASSWORD_MSG}
                autoComplete="new-password"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
