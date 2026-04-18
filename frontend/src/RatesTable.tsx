import { FormEvent, useEffect, useState } from "react";
import {
  DerivedSlice,
  RateRange,
  RateRangeMode,
  listRates,
  updateRates,
} from "./api";

interface Props {
  /** Admin editor + derived ranges if true; read-only derived ranges only otherwise. */
  editable: boolean;
  onUnauthorized?: () => void;
}

type DraftRow = {
  start_ft: string;
  end_ft: string;
  mode: RateRangeMode;
  rate: string;
};

const toDraft = (r: RateRange): DraftRow => ({
  start_ft: String(r.start_ft),
  end_ft: String(r.end_ft),
  mode: r.mode,
  rate: String(r.rate),
});

const modeLabel = (m: RateRangeMode): string =>
  m === "fixed" ? "Fixed rate" : "Step up (+rate / ft)";

const formatSlice = (s: DerivedSlice): string =>
  `${s.start_ft} – ${s.end_ft} ft`;

export default function RatesTable({ editable, onUnauthorized }: Props) {
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [derived, setDerived] = useState<DerivedSlice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRates();
      setDraft(data.ranges.map(toDraft));
      setDerived(data.derived);
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

  const updateRow = (idx: number, patch: Partial<DraftRow>) => {
    setDraft((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))
    );
  };

  const addRow = () => {
    setDraft((prev) => {
      const lastEnd = prev.length > 0 ? Number(prev[prev.length - 1].end_ft) : 0;
      const nextStart =
        prev.length === 0
          ? 0
          : Number.isFinite(lastEnd)
            ? lastEnd + 1
            : 0;
      return [
        ...prev,
        {
          start_ft: String(nextStart),
          end_ft: String(nextStart + 100),
          mode: "fixed",
          rate: "0",
        },
      ];
    });
  };

  const removeRow = (idx: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== idx));
  };

  const parseRanges = (): RateRange[] | null => {
    const parsed: RateRange[] = [];
    for (let i = 0; i < draft.length; i++) {
      const row = draft[i];
      const start = Number(row.start_ft);
      const end = Number(row.end_ft);
      const rate = Number(row.rate);
      if (
        !Number.isFinite(start) ||
        start < 0 ||
        !Number.isFinite(end) ||
        end <= start
      ) {
        setError(
          `Range ${i + 1}: start/end must be non-negative numbers and end > start`
        );
        return null;
      }
      if (!Number.isFinite(rate) || rate < 0) {
        setError(`Range ${i + 1}: rate must be a non-negative number`);
        return null;
      }
      parsed.push({
        start_ft: start,
        end_ft: end,
        mode: row.mode,
        rate,
      });
    }
    return parsed;
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = parseRanges();
    if (!parsed) return;
    if (parsed.length === 0) {
      setError("At least one range is required");
      return;
    }
    if (parsed[0].start_ft !== 0) {
      setError("First range must start at 0 ft");
      return;
    }
    for (let i = 1; i < parsed.length; i++) {
      const expected = parsed[i - 1].end_ft + 1;
      if (parsed[i].start_ft !== expected) {
        setError(
          `Range ${i + 1} must start at ${expected} ft (one past range ${i}'s end of ${parsed[i - 1].end_ft} ft)`
        );
        return;
      }
    }

    setSaving(true);
    try {
      const data = await updateRates(parsed);
      setDraft(data.ranges.map(toDraft));
      setDerived(data.derived);
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading rates…</p>;
  if (!editable && draft.length === 0) {
    return <p className="muted">No rate ranges configured yet.</p>;
  }

  return (
    <div className="rates">
      {editable ? (
        <form className="rate-ranges-form" onSubmit={handleSave}>
          <div className="table-wrap rates-table-wrap">
            <table className="rates-table rate-ranges-editor">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Start (ft)</th>
                  <th>End (ft)</th>
                  <th>Mode</th>
                  <th>Rate <small className="muted">(per ft; step up adds to previous range's per-ft rate)</small></th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {draft.map((row, idx) => (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={row.start_ft}
                        onChange={(e) =>
                          updateRow(idx, { start_ft: e.target.value })
                        }
                        required
                        aria-label={`Range ${idx + 1} start`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={row.end_ft}
                        onChange={(e) =>
                          updateRow(idx, { end_ft: e.target.value })
                        }
                        required
                        aria-label={`Range ${idx + 1} end`}
                      />
                    </td>
                    <td>
                      <select
                        value={row.mode}
                        onChange={(e) =>
                          updateRow(idx, {
                            mode: e.target.value as RateRangeMode,
                          })
                        }
                        aria-label={`Range ${idx + 1} mode`}
                      >
                        <option value="fixed">Fixed rate</option>
                        <option value="step_up">Step up (+rate / ft)</option>
                      </select>
                    </td>
                    <td>
                      <div className="rate-input-cell">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={row.rate}
                          onChange={(e) =>
                            updateRow(idx, { rate: e.target.value })
                          }
                          required
                          aria-label={`Range ${idx + 1} rate`}
                        />
                        <span className="muted rate-unit">/ ft</span>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => removeRow(idx)}
                        disabled={draft.length === 1}
                        title={
                          draft.length === 1
                            ? "At least one range is required"
                            : "Remove range"
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="rates-actions">
            <button type="button" className="secondary" onClick={addRow}>
              + Add range
            </button>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save rates"}
            </button>
            {savedAt && !saving && (
              <span className="muted">
                Saved {savedAt.toLocaleTimeString()}
              </span>
            )}
          </div>
          <p className="muted rates-hint">
            First range starts at <code>0</code> ft; each subsequent range
            must start at <code>prev.end + 1</code> (no gaps, no overlaps).
            In both modes the rate is charged <strong>per foot</strong>
            drilled. <em>Fixed</em> sets an absolute per-foot rate for the
            whole range. <em>Step up</em> partitions the range into 100-ft
            sub-slices; the Nth sub charges{" "}
            <code>R_prev + rate × N</code> per foot, where{" "}
            <code>R_prev</code> is the per-foot rate at the last foot of
            the previous range (0 for the first range).
          </p>
        </form>
      ) : null}
      <div className="table-wrap rates-table-wrap">
        <table className="rates-table">
          <thead>
            <tr>
              <th>Range</th>
              <th>Mode</th>
              <th>Rate (per ft)</th>
            </tr>
          </thead>
          <tbody>
            {derived.length === 0 ? (
              <tr>
                <td colSpan={3} className="muted">
                  No derived slices — admin must add at least one range.
                </td>
              </tr>
            ) : (
              derived.map((s) => (
                <tr key={s.start_ft}>
                  <td>{formatSlice(s)}</td>
                  <td>{modeLabel(s.mode)}</td>
                  <td>{s.rate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
