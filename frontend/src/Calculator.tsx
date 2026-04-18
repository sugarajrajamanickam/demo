import { FormEvent, useEffect, useState } from "react";
import {
  CasingPrices,
  CostBreakdown,
  calculateCost,
  fetchCasingPrices,
} from "./api";

interface Props {
  onUnauthorized: () => void;
  onDownloadBill: (
    depth: number,
    casing7Pieces: number,
    casing10Pieces: number,
  ) => void;
}

const fmt = (n: number): string =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—";

/** Rupee formatter with literal `₹` prefix and Indian digit grouping. */
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

export default function Calculator({ onUnauthorized, onDownloadBill }: Props) {
  const [depth, setDepth] = useState("");
  const [casing7, setCasing7] = useState("");
  const [casing10, setCasing10] = useState("");
  const [prices, setPrices] = useState<CasingPrices | null>(null);
  const [result, setResult] = useState<CostBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCasingPrices()
      .then((p) => {
        if (!cancelled) setPrices(p);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Request failed";
        if (message.toLowerCase().includes("session expired")) onUnauthorized();
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const parsePieces = (raw: string): number | null => {
    if (raw.trim() === "") return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    return n;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    const depthNum = Number(depth);
    if (!Number.isFinite(depthNum) || depthNum < 0) {
      setError("Depth must be a non-negative number");
      return;
    }
    const c7 = parsePieces(casing7);
    const c10 = parsePieces(casing10);
    if (c7 === null) {
      setError("Casing 7\" pieces must be a non-negative whole number");
      return;
    }
    if (c10 === null) {
      setError("Casing 10\" pieces must be a non-negative whole number");
      return;
    }

    setBusy(true);
    try {
      const data = await calculateCost(depthNum, c7, c10);
      setResult(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      if (message.toLowerCase().includes("session expired")) {
        onUnauthorized();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="calculator">
      <form className="card" onSubmit={handleSubmit}>
        <h2>Calculate</h2>
        <label>
          <span className="field-label-text">
            Depth (ft)
            <span className="required-star" aria-hidden="true">*</span>
          </span>
          <input
            type="number"
            step="any"
            min="0"
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            required
          />
        </label>
        <label>
          <span className="field-label-text">Casing 7" (pieces)</span>
          <input
            type="number"
            step="1"
            min="0"
            value={casing7}
            onChange={(e) => setCasing7(e.target.value)}
            placeholder="0"
          />
          {prices && (
            <span className="muted small">
              Admin rate: {fmtINR(prices.price_7in)} / piece
            </span>
          )}
        </label>
        <label>
          <span className="field-label-text">Casing 10" (pieces)</span>
          <input
            type="number"
            step="1"
            min="0"
            value={casing10}
            onChange={(e) => setCasing10(e.target.value)}
            placeholder="0"
          />
          {prices && (
            <span className="muted small">
              Admin rate: {fmtINR(prices.price_10in)} / piece
            </span>
          )}
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Computing…" : "Compute"}
        </button>

        {result && (
          <div className="cost-result" data-testid="result">
            <h3>Depth breakdown</h3>
            <div className="table-wrap rates-table-wrap">
              <table className="rates-table cost-breakdown">
                <thead>
                  <tr>
                    <th>Range</th>
                    <th>Feet</th>
                    <th>Rate (per ft)</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {result.slices.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        No depth entered.
                      </td>
                    </tr>
                  )}
                  {result.slices.map((s) => (
                    <tr key={s.start_ft}>
                      <td>
                        {s.start_ft} – {s.end_ft} ft
                      </td>
                      <td>{fmt(s.feet)}</td>
                      <td>{fmtINR(s.rate_per_ft)}</td>
                      <td>{fmtINR(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="cost-totals">
              <div>
                <dt>Amount (from depth)</dt>
                <dd>
                  <strong>{fmtINR(result.amount)}</strong>
                </dd>
              </div>
              {result.casing_7_pieces > 0 && (
                <div>
                  <dt>
                    Casing 7" ({result.casing_7_pieces} ×{" "}
                    {fmtINR(result.casing_7_price_per_piece)})
                  </dt>
                  <dd>
                    <strong>{fmtINR(result.casing_7_amount)}</strong>
                  </dd>
                </div>
              )}
              {result.casing_10_pieces > 0 && (
                <div>
                  <dt>
                    Casing 10" ({result.casing_10_pieces} ×{" "}
                    {fmtINR(result.casing_10_price_per_piece)})
                  </dt>
                  <dd>
                    <strong>{fmtINR(result.casing_10_amount)}</strong>
                  </dd>
                </div>
              )}
              <div className="sum">
                <dt>Total</dt>
                <dd>
                  <strong>{fmtINR(result.total)}</strong>
                </dd>
              </div>
            </dl>

            <div className="download-bill-row">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  onDownloadBill(
                    result.depth,
                    result.casing_7_pieces,
                    result.casing_10_pieces,
                  )
                }
              >
                Download bill
              </button>
              <p className="muted small">
                Generates a GST-compliant tax invoice PDF (CGST Rule 46).
              </p>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
