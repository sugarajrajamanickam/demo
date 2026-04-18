import { FormEvent, useState } from "react";
import {
  BillPreview,
  BillRequest,
  downloadBillPdf,
  previewBill,
} from "./api";

interface Props {
  depth: number;
  casing: number;
  onBack: () => void;
  onUnauthorized: () => void;
}

const fmtINR = (n: number): string =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);

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
export default function Bill({ depth, casing, onBack, onUnauthorized }: Props) {
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
    casing,
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
          Depth <strong>{fmtNum(depth)} ft</strong>
          {casing > 0 && (
            <>
              {" · "}Casing fee <strong>{fmtINR(casing)}</strong>
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
              <thead>
                <tr>
                  <th>#</th>
                  <th>Description</th>
                  <th>HSN/SAC</th>
                  <th>Range</th>
                  <th>Qty (ft)</th>
                  <th>Rate / ft</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.line_items.map((item, i) => (
                  <tr key={`${item.start_ft}-${item.end_ft}`}>
                    <td>{i + 1}</td>
                    <td>
                      {i === 0 ? (
                        <>
                          {preview.description} — depth {fmtNum(preview.depth)} ft
                        </>
                      ) : (
                        ""
                      )}
                    </td>
                    <td>{i === 0 ? preview.hsn_sac : ""}</td>
                    <td>
                      {item.start_ft} – {item.end_ft}
                    </td>
                    <td>{fmtNum(item.feet)}</td>
                    <td>{fmtINR(item.rate_per_ft)}</td>
                    <td>{fmtINR(item.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} />
                  <th>Taxable Value</th>
                  <td>
                    <strong>{fmtINR(preview.taxable_value)}</strong>
                  </td>
                </tr>
                {preview.is_interstate ? (
                  <tr>
                    <td colSpan={5} />
                    <th>IGST @ {preview.igst_percent}%</th>
                    <td>{fmtINR(preview.igst_amount)}</td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <td colSpan={5} />
                      <th>CGST @ {preview.cgst_percent}%</th>
                      <td>{fmtINR(preview.cgst_amount)}</td>
                    </tr>
                    <tr>
                      <td colSpan={5} />
                      <th>SGST @ {preview.sgst_percent}%</th>
                      <td>{fmtINR(preview.sgst_amount)}</td>
                    </tr>
                  </>
                )}
                {preview.casing_fee > 0 && (
                  <tr>
                    <td colSpan={5} />
                    <th>Casing fee</th>
                    <td>{fmtINR(preview.casing_fee)}</td>
                  </tr>
                )}
                <tr className="bill-total-row">
                  <td colSpan={5} />
                  <th>Grand Total</th>
                  <td>
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
