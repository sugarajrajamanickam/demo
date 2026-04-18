import { FormEvent, useState } from "react";
import {
  JobType,
  QuotationPreview,
  QuotationRequest,
  downloadQuotationPdf,
  previewQuotation,
} from "./api";

interface Props {
  depth: number;
  jobType: JobType;
  casing7Pieces: number;
  casing10Pieces: number;
  onBack: () => void;
  onUnauthorized: () => void;
}

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

const fmtNum = (n: number): string =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—";

/**
 * Lightweight quotation flow: minimal customer form (name + phone only) →
 * server-computed pre-tax preview → PDF download.
 *
 * Not a tax invoice: amounts are shown before GST with a "GST extra at 18%"
 * footnote, and the document does not include Rule 46 compliance fields or
 * an authorised-signatory block.
 */
export default function Quotation({
  depth,
  jobType,
  casing7Pieces,
  casing10Pieces,
  onBack,
  onUnauthorized,
}: Props) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");

  const [preview, setPreview] = useState<QuotationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const buildRequest = (): QuotationRequest => ({
    depth,
    job_type: jobType,
    casing_7_pieces: jobType === "new_bore" ? casing7Pieces : 0,
    casing_10_pieces: jobType === "new_bore" ? casing10Pieces : 0,
    customer_name: customerName.trim(),
    customer_phone: customerPhone.trim(),
  });

  const handlePreview = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPreview(null);

    if (!customerName.trim()) {
      setError("Customer name is required");
      return;
    }
    if (!customerPhone.trim()) {
      setError("Customer phone number is required");
      return;
    }
    if (!/^\+?[0-9\- ]{7,20}$/.test(customerPhone.trim())) {
      setError("Phone must be 7–20 digits; + / spaces / dashes allowed");
      return;
    }

    setBusy(true);
    try {
      const data = await previewQuotation(buildRequest());
      setPreview(data);
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

  const handleDownload = async () => {
    setError(null);
    setDownloading(true);
    try {
      await downloadQuotationPdf(buildRequest());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Download failed";
      setError(message);
      if (message.toLowerCase().includes("session expired")) {
        onUnauthorized();
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="bill-page">
      <div className="bill-header-row">
        <button type="button" className="btn-link" onClick={onBack}>
          ← Back to Calculate
        </button>
      </div>

      <form className="card bill-form" onSubmit={handlePreview}>
        <h2>Generate quotation</h2>
        <p className="muted small">
          Draft estimate for an enquiring customer. Prices are pre-tax;
          <strong> GST extra at 18%</strong>. Only name and phone are required.
        </p>
        <p className="muted small">
          Job: <strong>{jobType === "re_bore" ? "Re-Bore" : "New Bore"}</strong>
          {" · "}Depth <strong>{fmtNum(depth)} ft</strong>
          {jobType === "new_bore" && casing7Pieces > 0 && (
            <>
              {" · "}Casing 7" <strong>{casing7Pieces} pcs</strong>
            </>
          )}
          {jobType === "new_bore" && casing10Pieces > 0 && (
            <>
              {" · "}Casing 10" <strong>{casing10Pieces} pcs</strong>
            </>
          )}
        </p>

        <label>
          <span className="field-label-text">
            Customer name
            <span className="required-star" aria-hidden="true">*</span>
          </span>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="e.g. Ravi Kumar"
            required
            maxLength={120}
          />
        </label>
        <label>
          <span className="field-label-text">
            Phone number
            <span className="required-star" aria-hidden="true">*</span>
          </span>
          <input
            type="tel"
            value={customerPhone}
            onChange={(e) => setCustomerPhone(e.target.value)}
            placeholder="e.g. 9876543210"
            required
            maxLength={20}
            inputMode="tel"
            pattern="^\+?[0-9\- ]{7,20}$"
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="bill-actions">
          <button type="submit" disabled={busy || downloading}>
            {busy ? "Generating preview…" : preview ? "Refresh preview" : "Generate preview"}
          </button>
        </div>
      </form>

      {preview && (
        <div className="card bill-preview" data-testid="quotation-preview">
          <div className="bill-preview-title">
            <h2>QUOTATION</h2>
            <p className="muted small">
              Not a tax invoice — prices are estimates for enquiry purposes.
            </p>
          </div>

          <div className="bill-grid">
            <div>
              <strong>{preview.supplier_name}</strong>
              {preview.supplier_address_lines.map((l) => (
                <div key={l}>{l}</div>
              ))}
              <div>
                State: {preview.supplier_state} (Code {preview.supplier_state_code})
              </div>
              <div className="small muted">
                {preview.supplier_phone} · {preview.supplier_email}
              </div>
            </div>
            <div className="bill-meta">
              <div>
                <span className="muted">Quotation No</span>
                <strong>{preview.quotation_number}</strong>
              </div>
              <div>
                <span className="muted">Quotation Date</span>
                <strong>{preview.quotation_date}</strong>
              </div>
              <div>
                <span className="muted">Valid Until</span>
                <strong>
                  {preview.valid_until} ({preview.validity_days} days)
                </strong>
              </div>
            </div>
          </div>

          <div className="bill-section">
            <h3>Quotation For</h3>
            <div>
              <strong>{preview.customer_name}</strong>
            </div>
            <div className="small muted">Phone: {preview.customer_phone}</div>
          </div>

          <div className="table-wrap">
            <table className="bill-items">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th>HSN/SAC</th>
                  <th>Qty</th>
                  <th>Rate</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.line_items.map((li, idx) => (
                  <tr key={idx}>
                    <td>{idx + 1}</td>
                    <td>{li.description}</td>
                    <td>{li.hsn_sac || "—"}</td>
                    <td>
                      {fmtNum(li.qty)} {li.qty_unit}
                    </td>
                    <td>{fmtINR(li.rate)}</td>
                    <td>{fmtINR(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} />
                  <td>
                    <strong>Subtotal (pre-tax)</strong>
                  </td>
                  <td>
                    <strong>{fmtINR(preview.subtotal)}</strong>
                  </td>
                </tr>
                <tr>
                  <td colSpan={4} />
                  <td>
                    <em>{preview.gst_note}</em>
                  </td>
                  <td>
                    <em>Extra</em>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="muted small">
            This quotation is valid for {preview.validity_days} days from the
            quotation date. Final invoice details and taxes will be confirmed
            before work commences.
          </p>

          <div className="bill-actions">
            <button
              type="button"
              className="primary"
              onClick={handleDownload}
              disabled={downloading}
            >
              {downloading ? "Downloading…" : "Confirm & download PDF"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
