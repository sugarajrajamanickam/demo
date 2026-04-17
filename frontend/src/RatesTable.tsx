import { FormEvent, useEffect, useState } from "react";
import { RateConfig, RateRange, listRates, updateRates } from "./api";

interface Props {
  /** When true the admin can edit + save the config; otherwise read-only. */
  editable: boolean;
  onUnauthorized?: () => void;
}

type Draft = { base_rate: string; step_mid: string; step_deep: string };

const formatRange = (r: RateRange): string =>
  `${r.start_ft} – ${r.end_ft} ft`;

/**
 * Rate ladder shared by Admin (config editor + derived ranges) and
 * Calculator (read-only derived ranges).
 *
 * The server stores just three numbers (base_rate, step_mid, step_deep);
 * the full per-100-ft ladder is derived from those on every read. Keeping
 * derivation on the server means the admin UI can't accidentally produce
 * a ladder that disagrees with the calculator.
 */
export default function RatesTable({ editable, onUnauthorized }: Props) {
  const [config, setConfig] = useState<RateConfig | null>(null);
  const [ranges, setRanges] = useState<RateRange[]>([]);
  const [draft, setDraft] = useState<Draft>({
    base_rate: "",
    step_mid: "",
    step_deep: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRates();
      setConfig(data.config);
      setRanges(data.ranges);
      setDraft({
        base_rate: String(data.config.base_rate),
        step_mid: String(data.config.step_mid),
        step_deep: String(data.config.step_deep),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load rates";
      setError(msg);
      if (msg.toLowerCase().includes("session expired")) onUnauthorized?.();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parseField = (label: string, raw: string): number | null => {
    const num = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(num) || num < 0) {
      setError(`${label} must be a non-negative number`);
      return null;
    }
    return num;
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const base_rate = parseField("Base rate", draft.base_rate);
    if (base_rate === null) return;
    const step_mid = parseField("Mid-band increment", draft.step_mid);
    if (step_mid === null) return;
    const step_deep = parseField("Deep-band increment", draft.step_deep);
    if (step_deep === null) return;

    setSaving(true);
    try {
      const data = await updateRates({ base_rate, step_mid, step_deep });
      setConfig(data.config);
      setRanges(data.ranges);
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading rates…</p>;
  if (!config) return <p className="error">{error ?? "Rates unavailable"}</p>;

  return (
    <div className="rates">
      {editable ? (
        <form className="rate-config-form" onSubmit={handleSave}>
          <label>
            <span className="field-label-text">
              Base rate (0–300 ft, per 100 ft)
              <span className="required-star" aria-hidden="true">*</span>
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={draft.base_rate}
              onChange={(e) =>
                setDraft({ ...draft, base_rate: e.target.value })
              }
              required
            />
          </label>
          <label>
            <span className="field-label-text">
              Mid-band increment (300–1000 ft, per 100 ft)
              <span className="required-star" aria-hidden="true">*</span>
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={draft.step_mid}
              onChange={(e) => setDraft({ ...draft, step_mid: e.target.value })}
              required
            />
          </label>
          <label>
            <span className="field-label-text">
              Deep-band increment (above 1000 ft, per 100 ft)
              <span className="required-star" aria-hidden="true">*</span>
            </span>
            <input
              type="number"
              step="any"
              min="0"
              value={draft.step_deep}
              onChange={(e) =>
                setDraft({ ...draft, step_deep: e.target.value })
              }
              required
            />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="rates-actions">
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save rates"}
            </button>
            {savedAt && !saving && (
              <span className="muted">
                Saved {savedAt.toLocaleTimeString()}
              </span>
            )}
          </div>
        </form>
      ) : (
        <p className="muted rates-summary">
          Base rate: <strong>{config.base_rate}</strong> · Mid-band step:{" "}
          <strong>{config.step_mid}</strong> · Deep-band step:{" "}
          <strong>{config.step_deep}</strong>
        </p>
      )}
      <div className="table-wrap rates-table-wrap">
        <table className="rates-table">
          <thead>
            <tr>
              <th>Range</th>
              <th>Rate (per 100 ft)</th>
            </tr>
          </thead>
          <tbody>
            {ranges.map((r) => (
              <tr key={r.start_ft}>
                <td>{formatRange(r)}</td>
                <td>{r.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
