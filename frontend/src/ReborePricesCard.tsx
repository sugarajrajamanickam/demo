import { FormEvent, useEffect, useState } from "react";
import { ReborePrice, fetchReborePrice, updateReborePrice } from "./api";

interface Props {
  onUnauthorized: () => void;
}

const fmtINR = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [rupeesStr, paiseRaw = "00"] = abs.toFixed(2).split(".");
  const paise = paiseRaw.padEnd(2, "0").slice(0, 2);
  let grouped: string;
  if (rupeesStr.length <= 3) {
    grouped = rupeesStr;
  } else {
    const last3 = rupeesStr.slice(-3);
    const rest = rupeesStr.slice(0, -3);
    const chunks: string[] = [];
    let i = rest.length;
    while (i > 0) {
      chunks.unshift(rest.slice(Math.max(0, i - 2), i));
      i -= 2;
    }
    grouped = `${chunks.join(",")},${last3}`;
  }
  return `${sign}₹${grouped}.${paise}`;
};

export default function ReborePricesCard({ onUnauthorized }: Props) {
  const [pricePerFoot, setPricePerFoot] = useState("");
  const [current, setCurrent] = useState<ReborePrice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchReborePrice()
      .then((p) => {
        if (cancelled) return;
        setCurrent(p);
        setPricePerFoot(String(p.price_per_foot));
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

    const n = Number(pricePerFoot);
    if (!Number.isFinite(n) || n < 0) {
      setError("Re-bore rate must be a non-negative number");
      return;
    }

    setBusy(true);
    try {
      const updated = await updateReborePrice({ price_per_foot: n });
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
      <h2>Re-bore price</h2>
      <p className="muted">
        Flat per-foot rate used when the Calculate page is set to <em>Re-Bore</em>.
        The cost is <code>depth × rate</code>, with CGST 9% + SGST 9% (or IGST 18%
        inter-state) applied on top. No rate ladder and no casing.
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="casing-prices-form" onSubmit={handleSubmit}>
          <label>
            <span className="field-label-text">Re-bore rate (per ft)</span>
            <input
              type="number"
              step="any"
              min="0"
              value={pricePerFoot}
              onChange={(e) => {
                setPricePerFoot(e.target.value);
                setSaved(false);
              }}
              required
            />
            {current && (
              <span className="muted small">
                Current: {fmtINR(current.price_per_foot)} / ft
              </span>
            )}
          </label>
          {error && <p className="error">{error}</p>}
          {saved && !error && <p className="muted small">Saved.</p>}
          <div>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save re-bore price"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
