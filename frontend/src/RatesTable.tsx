import { FormEvent, useEffect, useState } from "react";
import { RateRow, listRates, updateRates } from "./api";

interface Props {
  /** When true the admin can edit + save rows; otherwise the table is read-only. */
  editable: boolean;
  onUnauthorized?: () => void;
}

/**
 * Rate-per-100-feet table shared by Admin (editable) and Calculator (read-only).
 *
 * The ladder is fixed on the server: 100..1000 ft in steps of 100. We
 * render whatever the server returns, which keeps the two views in sync.
 */
export default function RatesTable({ editable, onUnauthorized }: Props) {
  const [tiers, setTiers] = useState<RateRow[]>([]);
  // Draft holds the raw text the user types so decimals and trailing dots
  // aren't stripped while typing. Keyed by depth_ft.
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRates();
      setTiers(data.tiers);
      const nextDraft: Record<number, string> = {};
      for (const t of data.tiers) nextDraft[t.depth_ft] = String(t.rate);
      setDraft(nextDraft);
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

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Client-side parse: every cell must be a non-negative number.
    const parsed: RateRow[] = [];
    for (const t of tiers) {
      const raw = draft[t.depth_ft] ?? "";
      const num = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(num) || num < 0) {
        setError(`Invalid rate for ${t.depth_ft} ft — must be a non-negative number`);
        return;
      }
      parsed.push({ depth_ft: t.depth_ft, rate: num });
    }
    setSaving(true);
    try {
      const data = await updateRates(parsed);
      setTiers(data.tiers);
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p>Loading rates…</p>;

  return (
    <form className="rates" onSubmit={handleSave}>
      <div className="table-wrap rates-table-wrap">
        <table className="rates-table">
          <thead>
            <tr>
              <th>Depth (ft)</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.depth_ft}>
                <td>{t.depth_ft}</td>
                <td>
                  {editable ? (
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={draft[t.depth_ft] ?? ""}
                      onChange={(e) =>
                        setDraft({ ...draft, [t.depth_ft]: e.target.value })
                      }
                      required
                      aria-label={`Rate for ${t.depth_ft} feet`}
                    />
                  ) : (
                    <span>{t.rate}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="error">{error}</p>}
      {editable && (
        <div className="rates-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save rates"}
          </button>
          {savedAt && !saving && (
            <span className="muted">Saved {savedAt.toLocaleTimeString()}</span>
          )}
        </div>
      )}
    </form>
  );
}
