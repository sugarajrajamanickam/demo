import { Fragment, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardCustomerRow,
  DashboardFilters,
  DashboardRowStatus,
  DashboardStatus,
  StatementResponse,
  downloadCustomerStatementPdf,
  fetchCustomerStatementJson,
  fetchDashboardCustomers,
} from "./api";
import { fmtINR } from "./format";

interface Props {
  onUnauthorized: () => void;
}

const STATUS_OPTIONS: { value: DashboardStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "paid", label: "Fully paid" },
  { value: "partial", label: "Partially paid" },
  { value: "unpaid", label: "Unpaid" },
];

const STATUS_BADGE: Record<DashboardRowStatus, { label: string; className: string }> = {
  paid: { label: "Fully paid", className: "status-pill status-paid" },
  partial: { label: "Partially paid", className: "status-pill status-partial" },
  unpaid: { label: "Unpaid", className: "status-pill status-unpaid" },
  no_bills: { label: "No bills", className: "status-pill status-empty" },
};

const PAGE_SIZE = 10;

function jobTypeLabel(jt: string): string {
  if (jt === "new_bore") return "New Bore";
  if (jt === "re_bore") return "Re-Bore";
  return jt;
}

function paymentModeLabel(mode: string): string {
  switch (mode) {
    case "cash":
      return "Cash";
    case "upi":
      return "UPI";
    case "card":
      return "Card";
    case "bank_transfer":
      return "Bank transfer";
    case "cheque":
      return "Cheque";
    case "other":
      return "Other";
    default:
      return mode;
  }
}

export default function Dashboard({ onUnauthorized }: Props) {
  // Draft (form) state — only applied to the query on Apply / Clear.
  const [draftQ, setDraftQ] = useState("");
  const [draftStatus, setDraftStatus] = useState<DashboardStatus>("all");
  const [draftBillFrom, setDraftBillFrom] = useState("");
  const [draftBillTo, setDraftBillTo] = useState("");
  const [draftPayFrom, setDraftPayFrom] = useState("");
  const [draftPayTo, setDraftPayTo] = useState("");

  const [applied, setApplied] = useState<DashboardFilters>({ status: "all" });
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<DashboardCustomerRow[]>([]);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Statement modal state
  const [statementOpen, setStatementOpen] = useState(false);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [statementLoading, setStatementLoading] = useState(false);
  const [statementError, setStatementError] = useState<string | null>(null);
  const [statementPdfLoading, setStatementPdfLoading] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Request failed";
      if (msg.toLowerCase().includes("session expired")) onUnauthorized();
      return msg;
    },
    [onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const offset = (page - 1) * PAGE_SIZE;
    void fetchDashboardCustomers({ ...applied, limit: PAGE_SIZE, offset })
      .then((res) => {
        if (!cancelled) {
          setRows(res.customers);
          setTotalCustomers(res.total_customers);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(handleError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applied, page, handleError]);

  const handleApply = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied({
      q: draftQ,
      status: draftStatus,
      bill_from: draftBillFrom || undefined,
      bill_to: draftBillTo || undefined,
      payment_from: draftPayFrom || undefined,
      payment_to: draftPayTo || undefined,
    });
  };

  const handleClear = () => {
    setDraftQ("");
    setDraftStatus("all");
    setDraftBillFrom("");
    setDraftBillTo("");
    setDraftPayFrom("");
    setDraftPayTo("");
    setPage(1);
    setApplied({ status: "all" });
  };

  const toggleExpand = (customerId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };

  const handleDownload = async (row: DashboardCustomerRow) => {
    setDownloadError(null);
    setDownloadingId(row.customer_id);
    try {
      await downloadCustomerStatementPdf(
        row.customer_id,
        {
          bill_from: applied.bill_from,
          bill_to: applied.bill_to,
          payment_from: applied.payment_from,
          payment_to: applied.payment_to,
        },
        row.name,
      );
    } catch (err) {
      setDownloadError(handleError(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const openStatement = async (row: DashboardCustomerRow) => {
    setStatementOpen(true);
    setStatement(null);
    setStatementError(null);
    setStatementLoading(true);
    try {
      const res = await fetchCustomerStatementJson(row.customer_id, {
        bill_from: applied.bill_from,
        bill_to: applied.bill_to,
        payment_from: applied.payment_from,
        payment_to: applied.payment_to,
      });
      setStatement(res);
    } catch (err) {
      setStatementError(handleError(err));
    } finally {
      setStatementLoading(false);
    }
  };

  const closeStatement = () => {
    setStatementOpen(false);
    setStatement(null);
    setStatementError(null);
  };

  const handleModalPdfDownload = async () => {
    if (!statement) return;
    setStatementPdfLoading(true);
    try {
      await downloadCustomerStatementPdf(
        statement.customer.id,
        {
          bill_from: applied.bill_from,
          bill_to: applied.bill_to,
          payment_from: applied.payment_from,
          payment_to: applied.payment_to,
        },
        statement.customer.name,
      );
    } catch (err) {
      setStatementError(handleError(err));
    } finally {
      setStatementPdfLoading(false);
    }
  };

  const totals = useMemo(() => {
    let billed = 0;
    let paid = 0;
    let outstanding = 0;
    for (const r of rows) {
      billed += r.total_billed;
      paid += r.total_paid;
      outstanding += r.outstanding;
    }
    return { billed, paid, outstanding };
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(totalCustomers / PAGE_SIZE));
  const firstIndex = totalCustomers === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastIndex = Math.min(totalCustomers, page * PAGE_SIZE);

  return (
    <section className="dashboard-page">
      <h2>Dashboard</h2>

      <form className="dashboard-filters" onSubmit={handleApply}>
        <div className="dashboard-filter-row">
          <label className="dashboard-field dashboard-field-search">
            <span>Search</span>
            <input
              type="search"
              placeholder="Name, phone, or invoice number"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              data-testid="dashboard-search"
            />
          </label>
          <label className="dashboard-field">
            <span>Payment status</span>
            <select
              value={draftStatus}
              onChange={(e) => setDraftStatus(e.target.value as DashboardStatus)}
              data-testid="dashboard-status"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="dashboard-filter-row">
          <fieldset className="dashboard-fieldset">
            <legend>Bill date range</legend>
            <label className="dashboard-field dashboard-field-date">
              <span>From</span>
              <input
                type="date"
                value={draftBillFrom}
                onChange={(e) => setDraftBillFrom(e.target.value)}
                data-testid="dashboard-bill-from"
              />
            </label>
            <label className="dashboard-field dashboard-field-date">
              <span>To</span>
              <input
                type="date"
                value={draftBillTo}
                onChange={(e) => setDraftBillTo(e.target.value)}
                data-testid="dashboard-bill-to"
              />
            </label>
          </fieldset>

          <fieldset className="dashboard-fieldset">
            <legend>Payment date range</legend>
            <label className="dashboard-field dashboard-field-date">
              <span>From</span>
              <input
                type="date"
                value={draftPayFrom}
                onChange={(e) => setDraftPayFrom(e.target.value)}
                data-testid="dashboard-pay-from"
              />
            </label>
            <label className="dashboard-field dashboard-field-date">
              <span>To</span>
              <input
                type="date"
                value={draftPayTo}
                onChange={(e) => setDraftPayTo(e.target.value)}
                data-testid="dashboard-pay-to"
              />
            </label>
          </fieldset>
        </div>

        <div className="dashboard-filter-actions">
          <button type="submit" className="btn-primary">
            Apply filters
          </button>
          <button type="button" className="btn-secondary" onClick={handleClear}>
            Clear
          </button>
        </div>
      </form>

      {error && <div className="form-error" role="alert">{error}</div>}
      {downloadError && <div className="form-error" role="alert">{downloadError}</div>}

      <div className="dashboard-summary">
        <span>
          <strong>{totalCustomers}</strong> customer{totalCustomers === 1 ? "" : "s"}
        </span>
        <span>Billed: <strong>{fmtINR(totals.billed)}</strong></span>
        <span>Paid: <strong>{fmtINR(totals.paid)}</strong></span>
        <span>Outstanding: <strong>{fmtINR(totals.outstanding)}</strong></span>
        <span className="muted">Sorted oldest activity first</span>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : totalCustomers === 0 ? (
        <div className="muted">No customers match the selected filters.</div>
      ) : (
        <>
          <div className="dashboard-results">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Last updated</th>
                  <th>Bills</th>
                  <th className="num">Billed</th>
                  <th className="num">Paid</th>
                  <th className="num">Outstanding</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isOpen = expanded.has(row.customer_id);
                  const badge = STATUS_BADGE[row.status];
                  return (
                    <Fragment key={row.customer_id}>
                      <tr data-testid={`dashboard-row-${row.customer_id}`}>
                        <td>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => toggleExpand(row.customer_id)}
                            aria-label={isOpen ? "Collapse bills" : "Expand bills"}
                          >
                            {isOpen ? "▾" : "▸"}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openStatement(row)}
                            data-testid={`dashboard-name-link-${row.customer_id}`}
                          >
                            {row.name}
                          </button>
                        </td>
                        <td>{row.phone}</td>
                        <td data-testid={`last-updated-${row.customer_id}`}>
                          {row.last_activity_at}
                        </td>
                        <td>{row.bill_count}</td>
                        <td className="num">{fmtINR(row.total_billed)}</td>
                        <td className="num">{fmtINR(row.total_paid)}</td>
                        <td className="num">{fmtINR(row.outstanding)}</td>
                        <td>
                          <span className={badge.className}>{badge.label}</span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-primary btn-small"
                            onClick={() => handleDownload(row)}
                            disabled={downloadingId === row.customer_id}
                            data-testid={`download-statement-${row.customer_id}`}
                          >
                            {downloadingId === row.customer_id
                              ? "Downloading…"
                              : "Download statement"}
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="dashboard-detail-row">
                          <td></td>
                          <td colSpan={9}>
                            {row.bills.length === 0 ? (
                              <div className="muted">No bills in the selected window.</div>
                            ) : (
                              <table className="dashboard-bills-table">
                                <thead>
                                  <tr>
                                    <th>Invoice #</th>
                                    <th>Date</th>
                                    <th>Job</th>
                                    <th className="num">Depth (ft)</th>
                                    <th className="num">Total</th>
                                    <th className="num">Paid</th>
                                    <th className="num">Outstanding</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {row.bills.map((b) => (
                                    <tr key={b.id}>
                                      <td>{b.invoice_number}</td>
                                      <td>{b.invoice_date}</td>
                                      <td>{jobTypeLabel(b.job_type)}</td>
                                      <td className="num">{b.depth}</td>
                                      <td className="num">{fmtINR(b.grand_total)}</td>
                                      <td className="num">{fmtINR(b.paid_total)}</td>
                                      <td className="num">{fmtINR(b.outstanding)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="dashboard-pagination" data-testid="dashboard-pagination">
            <span className="dashboard-pagination-indicator">
              {firstIndex}–{lastIndex} of {totalCustomers}
            </span>
            <div className="dashboard-pagination-controls">
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                data-testid="dashboard-prev-page"
              >
                ← Prev
              </button>
              <span className="dashboard-pagination-page">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                data-testid="dashboard-next-page"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}

      {statementOpen && (
        <div
          className="modal-backdrop"
          onClick={closeStatement}
          data-testid="statement-modal-backdrop"
        >
          <div
            className="modal-content modal-wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="statement-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="statement-modal-title">Customer statement</h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeStatement}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {statementLoading && <div className="muted">Loading statement…</div>}
              {statementError && (
                <div className="form-error" role="alert">
                  {statementError}
                </div>
              )}
              {statement && (
                <StatementView statement={statement} />
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeStatement}
              >
                Close
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!statement || statementPdfLoading}
                onClick={handleModalPdfDownload}
                data-testid="statement-modal-pdf"
              >
                {statementPdfLoading ? "Downloading…" : "Download PDF"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StatementView({ statement }: { statement: StatementResponse }) {
  const { customer, bills, payments } = statement;
  return (
    <div className="statement-view">
      <header className="statement-header">
        <div>
          <div className="statement-customer-name">{customer.name}</div>
          <div className="statement-customer-meta">Phone: {customer.phone}</div>
          {customer.address && (
            <div className="statement-customer-meta">{customer.address}</div>
          )}
          {customer.gstin && (
            <div className="statement-customer-meta">GSTIN: {customer.gstin}</div>
          )}
        </div>
        <div className="statement-totals">
          <div>
            <span className="muted">Billed</span>
            <strong>{fmtINR(statement.total_billed)}</strong>
          </div>
          <div>
            <span className="muted">Paid</span>
            <strong>{fmtINR(statement.total_paid)}</strong>
          </div>
          <div>
            <span className="muted">Outstanding</span>
            <strong>{fmtINR(statement.outstanding)}</strong>
          </div>
          <div className="statement-generated">
            <span className="muted">Generated {statement.generated_at}</span>
          </div>
        </div>
      </header>

      <section>
        <h4>Bills</h4>
        {bills.length === 0 ? (
          <div className="muted">No bills in the selected window.</div>
        ) : (
          <table className="statement-table">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Date</th>
                <th>Job</th>
                <th className="num">Depth (ft)</th>
                <th className="num">Taxable</th>
                <th className="num">Tax</th>
                <th className="num">Non-tax</th>
                <th className="num">Total</th>
                <th className="num">Paid</th>
                <th className="num">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td>{b.invoice_number}</td>
                  <td>{b.invoice_date}</td>
                  <td>{jobTypeLabel(b.job_type)}</td>
                  <td className="num">{b.depth}</td>
                  <td className="num">{fmtINR(b.taxable_value)}</td>
                  <td className="num">{fmtINR(b.total_tax)}</td>
                  <td className="num">{fmtINR(b.non_taxable_total)}</td>
                  <td className="num">{fmtINR(b.grand_total)}</td>
                  <td className="num">{fmtINR(b.paid_total)}</td>
                  <td className="num">{fmtINR(b.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>Payments</h4>
        {payments.length === 0 ? (
          <div className="muted">No payments in the selected window.</div>
        ) : (
          <table className="statement-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice #</th>
                <th>Mode</th>
                <th>Note</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.paid_at}</td>
                  <td>{p.invoice_number}</td>
                  <td>{paymentModeLabel(p.mode)}</td>
                  <td>{p.note || ""}</td>
                  <td className="num">{fmtINR(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
