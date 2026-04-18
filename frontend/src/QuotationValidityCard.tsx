import { FormEvent, useEffect, useState } from "react";
import {
  QuotationSettings,
  fetchQuotationSettings,
  updateQuotationSettings,
} from "./api";

interface Props {
  onUnauthorized: () => void;
}

export default function QuotationValidityCard({ onUnauthorized }: Props) {
  const [validityDays, setValidityDays] = useState("");
  const [current, setCurrent] = useState<QuotationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchQuotationSettings()
      .then((s) => {
        if (cancelled) return;
        setCurrent(s);
        setValidityDays(String(s.validity_days));
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Request failed";
        setError(message);
        if (message.toLowerCase().includes("session expired")) onUnauthorized();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const n = Number(validityDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) {
      setError("Validity must be a whole number between 1 and 3650 days");
      return;
    }

    setBusy(true);
    try {
      const updated = await updateQuotationSettings({ validity_days: n });
      setCurrent(updated);
      setSaved(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      setError(message);
      if (message.toLowerCase().includes("session expired")) onUnauthorized();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card admin-card">
      <h2>Quotation validity</h2>
      <p className="muted">
        Number of days a downloaded quotation is valid for. Rendered on every
        quotation as <em>Valid Until = quotation date + validity days</em>.
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="casing-prices-form" onSubmit={handleSubmit}>
          <label>
            <span className="field-label-text">Validity (days)</span>
            <input
              type="number"
              step="1"
              min="1"
              max="3650"
              value={validityDays}
              onChange={(e) => {
                setValidityDays(e.target.value);
                setSaved(false);
              }}
              required
            />
            {current && (
              <span className="muted small">
                Current: {current.validity_days} day
                {current.validity_days === 1 ? "" : "s"}
              </span>
            )}
          </label>
          {error && <p className="error">{error}</p>}
          {saved && !error && <p className="muted small">Saved.</p>}
          <div>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save quotation validity"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
