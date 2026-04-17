import { FormEvent, useState } from "react";
import { AddResponse, addValues } from "./api";

interface Props {
  onUnauthorized: () => void;
}

export default function Calculator({ onUnauthorized }: Props) {
  const [depth, setDepth] = useState("");
  const [casing, setCasing] = useState("");
  const [result, setResult] = useState<AddResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    const depthNum = Number(depth);
    const casingNum = Number(casing);
    if (Number.isNaN(depthNum) || Number.isNaN(casingNum)) {
      setError("Depth and Casing must be numbers");
      return;
    }

    setBusy(true);
    try {
      const data = await addValues(depthNum, casingNum);
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
    <form className="card" onSubmit={handleSubmit}>
      <h2>Calculate</h2>
      <label>
        Depth
        <input
          type="number"
          step="any"
          value={depth}
          onChange={(e) => setDepth(e.target.value)}
          required
        />
      </label>
      <label>
        Casing
        <input
          type="number"
          step="any"
          value={casing}
          onChange={(e) => setCasing(e.target.value)}
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Computing…" : "Compute"}
      </button>
      {result && (
        <div className="result" data-testid="result">
          <div>
            <span>Depth</span>
            <strong>{result.depth}</strong>
          </div>
          <div>
            <span>Casing</span>
            <strong>{result.casing}</strong>
          </div>
          <div className="sum">
            <span>Sum</span>
            <strong>{result.sum}</strong>
          </div>
        </div>
      )}
    </form>
  );
}
