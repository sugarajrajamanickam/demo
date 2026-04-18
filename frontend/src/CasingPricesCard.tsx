import { FormEvent, useEffect, useState } from "react";
import {
  CasingPrices,
  fetchCasingPrices,
  updateCasingPrices,
} from "./api";

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

export default function CasingPricesCard({ onUnauthorized }: Props) {
  const [price7, setPrice7] = useState("");
  const [price10, setPrice10] = useState("");
  const [current, setCurrent] = useState<CasingPrices | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCasingPrices()
      .then((p) => {
        if (cancelled) return;
        setCurrent(p);
        setPrice7(String(p.price_7in));
        setPrice10(String(p.price_10in));
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

    const p7 = Number(price7);
    const p10 = Number(price10);
    if (!Number.isFinite(p7) || p7 < 0) {
      setError("Casing 7\" price must be a non-negative number");
      return;
    }
    if (!Number.isFinite(p10) || p10 < 0) {
      setError("Casing 10\" price must be a non-negative number");
      return;
    }

    setBusy(true);
    try {
      const updated = await updateCasingPrices({
        price_7in: p7,
        price_10in: p10,
      });
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
      <h2>Casing prices</h2>
      <p className="muted">
        Per-piece price charged for each casing size. The user enters the
        number of pieces on the Calculate page; both amounts are added to the
        grand total <em>after</em> GST (no tax applied).
      </p>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="casing-prices-form" onSubmit={handleSubmit}>
          <label>
            <span className="field-label-text">Casing 7" (per piece)</span>
            <input
              type="number"
              step="any"
              min="0"
              value={price7}
              onChange={(e) => {
                setPrice7(e.target.value);
                setSaved(false);
              }}
              required
            />
            {current && (
              <span className="muted small">
                Current: {fmtINR(current.price_7in)}
              </span>
            )}
          </label>
          <label>
            <span className="field-label-text">Casing 10" (per piece)</span>
            <input
              type="number"
              step="any"
              min="0"
              value={price10}
              onChange={(e) => {
                setPrice10(e.target.value);
                setSaved(false);
              }}
              required
            />
            {current && (
              <span className="muted small">
                Current: {fmtINR(current.price_10in)}
              </span>
            )}
          </label>
          {error && <p className="error">{error}</p>}
          {saved && !error && (
            <p className="muted small">Saved.</p>
          )}
          <div>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save casing prices"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
