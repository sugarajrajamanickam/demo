import { Fragment, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  DashboardCustomerRow,
  DashboardFilters,
  DashboardRowStatus,
  DashboardStatus,
  downloadCustomerStatementPdf,
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

function jobTypeLabel(jt: string): string {
  if (jt === "new_bore") return "New Bore";
  if (jt === "re_bore") return "Re-Bore";
  return jt;
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

  const [rows, setRows] = useState<DashboardCustomerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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
    void fetchDashboardCustomers(applied)
      .then((res) => {
        if (!cancelled) setRows(res.customers);
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
  }, [applied, handleError]);

  const handleApply = (e: FormEvent) => {
    e.preventDefault();
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
          <strong>{rows.length}</strong> customer{rows.length === 1 ? "" : "s"}
        </span>
        <span>Billed: <strong>{fmtINR(totals.billed)}</strong></span>
        <span>Paid: <strong>{fmtINR(totals.paid)}</strong></span>
        <span>Outstanding: <strong>{fmtINR(totals.outstanding)}</strong></span>
      </div>

      {loading ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">No customers match the selected filters.</div>
      ) : (
        <div className="dashboard-results">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Phone</th>
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
                      <td>{row.name}</td>
                      <td>{row.phone}</td>
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
                        <td colSpan={8}>
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
      )}
    </section>
  );
}
