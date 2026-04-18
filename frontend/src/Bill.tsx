import { FormEvent, useState } from "react";
import {
  BillPreview,
  BillRequest,
  JobType,
  downloadBillPdf,
  previewBill,
} from "./api";

interface Props {
  depth: number;
  jobType: JobType;
  casing7Pieces: number;
  casing10Pieces: number;
  onBack: () => void;
  onUnauthorized: () => void;
}

/**
 * Format a rupee amount with a literal `₹` symbol + Indian digit grouping
 * (`₹1,23,456.78`). We roll our own so the symbol is consistent across
 * browsers — some locales render `Intl.NumberFormat(currency:"INR")` as
 * `INR 1,23,456.78` with no actual rupee glyph.
 */
const fmtINR = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const [rupeesStr, paiseRaw = "00"] = abs.toFixed(2).split(".");
  const paise = paiseRaw.padEnd(2, "0").slice(0, 2);
  // Indian grouping: last 3 digits, then groups of 2.
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
 * Customer form → server-computed tax-invoice preview → PDF download.
 *
 * The invoice number, line items, GST split, and amount-in-words are all
 * computed by the backend so the preview the user sees matches the PDF
 * byte-for-byte (except for the timestamp inside the invoice number, which
 * is re-generated on the PDF call — acceptable for a demo).
 */
export default function Bill({
  depth,
  jobType,
  casing7Pieces,
  casing10Pieces,
  onBack,
  onUnauthorized,
}: Props) {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerState, setCustomerState] = useState("");
  const [customerStateCode, setCustomerStateCode] = useState("");
  const [customerGstin, setCustomerGstin] = useState("");

  const [preview, setPreview] = useState<BillPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const buildRequest = (): BillRequest => ({
    depth,
    job_type: jobType,
    casing_7_pieces: jobType === "new_bore" ? casing7Pieces : 0,
    casing_10_pieces: jobType === "new_bore" ? casing10Pieces : 0,
    customer_name: customerName.trim(),
    customer_phone: customerPhone.trim(),
    customer_address: customerAddress.trim() || null,
    customer_state: customerState.trim() || null,
    customer_state_code: customerStateCode.trim() || null,
    customer_gstin: customerGstin.trim() || null,
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
      const data = await previewBill(buildRequest());
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
      await downloadBillPdf(buildRequest());
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
        <h2>Generate tax invoice</h2>
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

        <details className="bill-optional">
          <summary>Optional: address, state, GSTIN</summary>
          <label>
            <span className="field-label-text">Billing address</span>
            <input
              type="text"
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              maxLength={240}
              placeholder="Street, city, PIN"
            />
          </label>
          <div className="bill-row">
            <label>
              <span className="field-label-text">State</span>
              <input
                type="text"
                value={customerState}
                onChange={(e) => setCustomerState(e.target.value)}
                maxLength={60}
                placeholder="e.g. Karnataka"
              />
            </label>
            <label>
              <span className="field-label-text">State code</span>
              <input
                type="text"
                value={customerStateCode}
                onChange={(e) => setCustomerStateCode(e.target.value)}
                maxLength={4}
                placeholder="e.g. 29"
                inputMode="numeric"
              />
            </label>
          </div>
          <label>
            <span className="field-label-text">GSTIN (if registered)</span>
            <input
              type="text"
              value={customerGstin}
              onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
              maxLength={15}
              placeholder="15-char GSTIN"
            />
          </label>
          <p className="muted small">
            Providing a state code different from the supplier's (22) switches
            the invoice to IGST (inter-state).
          </p>
        </details>

        {error && <p className="error">{error}</p>}

        <div className="bill-actions">
          <button type="submit" disabled={busy || downloading}>
            {busy ? "Generating preview…" : preview ? "Refresh preview" : "Generate preview"}
          </button>
        </div>
      </form>

      {preview && (
        <div className="card bill-preview" data-testid="bill-preview">
          <div className="bill-preview-title">
            <h2>TAX INVOICE</h2>
            <p className="muted small">Preview — confirm and download below</p>
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
              <div>
                GSTIN: <strong>{preview.supplier_gstin}</strong>
              </div>
              <div className="small muted">
                {preview.supplier_phone} · {preview.supplier_email}
              </div>
            </div>
            <div className="bill-meta">
              <div>
                <span className="muted">Invoice No</span>
                <strong>{preview.invoice_number}</strong>
              </div>
              <div>
                <span className="muted">Invoice Date</span>
                <strong>{preview.invoice_date}</strong>
              </div>
              <div>
                <span className="muted">Place of Supply</span>
                <strong>
                  {preview.customer_state || preview.supplier_state} (
                  {preview.customer_state_code || preview.supplier_state_code})
                </strong>
              </div>
              <div>
                <span className="muted">Tax Type</span>
                <strong>{preview.is_interstate ? "IGST (inter-state)" : "CGST + SGST (intra-state)"}</strong>
              </div>
            </div>
          </div>

          <div className="bill-section">
            <h3>Bill To</h3>
            <div>
              <strong>{preview.customer_name}</strong>
            </div>
            <div>Phone: {preview.customer_phone}</div>
            {preview.customer_address && <div>{preview.customer_address}</div>}
            {preview.customer_state && (
              <div>
                State: {preview.customer_state} (
                {preview.customer_state_code || "—"})
              </div>
            )}
            {preview.customer_gstin && (
              <div>
                GSTIN: <strong>{preview.customer_gstin}</strong>
              </div>
            )}
          </div>

          <div className="table-wrap">
            <table className="rates-table bill-items">
              <colgroup>
                <col className="col-num" />
                <col className="col-desc" />
                <col className="col-hsn" />
                <col className="col-qty" />
                <col className="col-rate" />
                <col className="col-amount" />
              </colgroup>
              <thead>
                <tr>
                  <th className="cell-num">#</th>
                  <th className="cell-left">Description</th>
                  <th className="cell-center">HSN/SAC</th>
                  <th className="cell-right">Qty</th>
                  <th className="cell-right">Rate</th>
                  <th className="cell-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.line_items.map((item, i) => (
                  <tr key={`${i}-${item.description}`}>
                    <td className="cell-num">{i + 1}</td>
                    <td className="cell-left">{item.description}</td>
                    <td className="cell-center">{item.hsn_sac || "—"}</td>
                    <td className="cell-right">
                      {fmtNum(item.qty)} {item.qty_unit}
                    </td>
                    <td className="cell-right">{fmtINR(item.rate)}</td>
                    <td className="cell-right">{fmtINR(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} />
                  <th className="cell-right">Taxable Value</th>
                  <td className="cell-right">
                    <strong>{fmtINR(preview.taxable_value)}</strong>
                  </td>
                </tr>
                {preview.is_interstate ? (
                  <tr>
                    <td colSpan={4} />
                    <th className="cell-right">IGST @ {preview.igst_percent}%</th>
                    <td className="cell-right">{fmtINR(preview.igst_amount)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td colSpan={4} />
                      <th className="cell-right">CGST @ {preview.cgst_percent}%</th>
                      <td className="cell-right">{fmtINR(preview.cgst_amount)}</td>
                    </tr>
                    <tr>
                      <td colSpan={4} />
                      <th className="cell-right">SGST @ {preview.sgst_percent}%</th>
                      <td className="cell-right">{fmtINR(preview.sgst_amount)}</td>
                    </tr>
                  </>
                )}
                <tr className="bill-total-row">
                  <td colSpan={4} />
                  <th className="cell-right">Grand Total</th>
                  <td className="cell-right">
                    <strong>{fmtINR(preview.grand_total)}</strong>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="bill-words">
            <strong>Amount in words:</strong> {preview.amount_in_words}
          </p>

          <div className="bill-actions bill-confirm">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="primary"
            >
              {downloading ? "Preparing PDF…" : "Confirm & download PDF"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
