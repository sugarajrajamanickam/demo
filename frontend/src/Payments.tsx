import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  BillSummary,
  BillWithPayments,
  Customer,
  CustomerCreate,
  CustomerWithBills,
  PAYMENT_MODES,
  PaymentCreate,
  PaymentMode,
  PaymentRecord,
  addPayment,
  createCustomer,
  deletePayment,
  fetchBillWithPayments,
  fetchCustomer,
  searchCustomers,
  updatePayment,
} from "./api";
import { fmtINR } from "./format";

interface Props {
  onUnauthorized: () => void;
}

type View =
  | { kind: "search" }
  | { kind: "customer"; customerId: number }
  | { kind: "bill"; customerId: number; billId: number };

const PHONE_RE = /^\+?[0-9\- ]{7,20}$/;

const emptyCustomerForm: CustomerCreate = {
  name: "",
  phone: "",
  address: "",
  state: "",
  state_code: "",
  gstin: "",
};

const emptyPaymentForm = (): PaymentCreate => ({
  amount: 0,
  paid_at: new Date().toISOString().slice(0, 10),
  mode: "cash",
  note: "",
});

function modeLabel(mode: PaymentMode): string {
  return PAYMENT_MODES.find((m) => m.value === mode)?.label ?? mode;
}

function jobTypeLabel(jt: string): string {
  if (jt === "new_bore") return "New Bore";
  if (jt === "re_bore") return "Re-Bore";
  return jt;
}

export default function Payments({ onUnauthorized }: Props) {
  const [view, setView] = useState<View>({ kind: "search" });

  const handleError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Request failed";
      if (msg.toLowerCase().includes("session expired")) onUnauthorized();
      return msg;
    },
    [onUnauthorized],
  );

  return (
    <section className="payments-page">
      <h2>Customer payments</h2>
      {view.kind === "search" && (
        <SearchAndCreate
          onPick={(id) => setView({ kind: "customer", customerId: id })}
          onError={handleError}
        />
      )}
      {view.kind === "customer" && (
        <CustomerDetail
          customerId={view.customerId}
          onBack={() => setView({ kind: "search" })}
          onOpenBill={(billId) =>
            setView({ kind: "bill", customerId: view.customerId, billId })
          }
          onError={handleError}
        />
      )}
      {view.kind === "bill" && (
        <BillPayments
          billId={view.billId}
          onBack={() =>
            setView({ kind: "customer", customerId: view.customerId })
          }
          onError={handleError}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Search + Create
// ---------------------------------------------------------------------------

function SearchAndCreate({
  onPick,
  onError,
}: {
  onPick: (id: number) => void;
  onError: (err: unknown) => string;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebouncedQ(query), 250);
    return () => {
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void searchCustomers(debouncedQ)
      .then((data) => {
        if (!cancelled) setResults(data);
      })
      .catch((err) => {
        if (!cancelled) setError(onError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQ, onError]);

  return (
    <div className="payments-search">
      <div className="payments-search-row">
        <input
          type="search"
          placeholder="Search by name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          data-testid="customer-search"
        />
        <button
          type="button"
          className="btn-primary"
          onClick={() => setShowCreate((s) => !s)}
        >
          {showCreate ? "Cancel" : "Create customer"}
        </button>
      </div>

      {showCreate && (
        <CreateCustomerForm
          onCreated={(c) => {
            setShowCreate(false);
            setQuery("");
            onPick(c.id);
          }}
          onError={onError}
        />
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
      {loading && <div className="muted">Searching…</div>}

      {!loading && results.length === 0 && (
        <div className="muted">
          {debouncedQ
            ? "No customers match. Click Create customer to add one."
            : "No customers yet. Click Create customer to add one."}
        </div>
      )}

      {results.length > 0 && (
        <ul className="customer-results">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="customer-result-btn"
                onClick={() => onPick(c.id)}
                data-testid={`customer-${c.id}`}
              >
                <span className="customer-result-name">{c.name}</span>
                <span className="customer-result-phone">{c.phone}</span>
                {c.address && (
                  <span className="customer-result-address muted">{c.address}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateCustomerForm({
  onCreated,
  onError,
}: {
  onCreated: (c: Customer) => void;
  onError: (err: unknown) => string;
}) {
  const [form, setForm] = useState<CustomerCreate>(emptyCustomerForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const name = form.name.trim();
    const phone = form.phone.trim();
    if (!name) return setError("Customer name is required");
    if (!PHONE_RE.test(phone)) {
      return setError(
        "Phone must be 7–20 digits; optional leading + and spaces/dashes allowed",
      );
    }
    setBusy(true);
    try {
      const created = await createCustomer({
        name,
        phone,
        address: form.address?.trim() || null,
        state: form.state?.trim() || null,
        state_code: form.state_code?.trim() || null,
        gstin: form.gstin?.trim() || null,
      });
      onCreated(created);
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="customer-create-form" onSubmit={handleSubmit}>
      <h3>New customer</h3>
      {error && <div className="form-error" role="alert">{error}</div>}
      <label>
        Name<span className="required-star">*</span>
        <input
          type="text"
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          maxLength={120}
        />
      </label>
      <label>
        Phone<span className="required-star">*</span>
        <input
          type="tel"
          required
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
          pattern="^\+?[0-9\- ]{7,20}$"
          maxLength={20}
        />
      </label>
      <label>
        Address
        <input
          type="text"
          value={form.address ?? ""}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          maxLength={240}
        />
      </label>
      <div className="form-row">
        <label>
          State
          <input
            type="text"
            value={form.state ?? ""}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
            maxLength={60}
          />
        </label>
        <label>
          State code
          <input
            type="text"
            value={form.state_code ?? ""}
            onChange={(e) => setForm({ ...form, state_code: e.target.value })}
            maxLength={4}
          />
        </label>
      </div>
      <label>
        GSTIN
        <input
          type="text"
          value={form.gstin ?? ""}
          onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
          maxLength={15}
        />
      </label>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Create customer"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Customer detail (list bills, running balance)
// ---------------------------------------------------------------------------

function CustomerDetail({
  customerId,
  onBack,
  onOpenBill,
  onError,
}: {
  customerId: number;
  onBack: () => void;
  onOpenBill: (billId: number) => void;
  onError: (err: unknown) => string;
}) {
  const [data, setData] = useState<CustomerWithBills | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchCustomer(customerId));
    } catch (err) {
      setError(onError(err));
    } finally {
      setLoading(false);
    }
  }, [customerId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="muted">Loading customer…</div>;
  if (error)
    return (
      <div>
        <button type="button" className="btn-link" onClick={onBack}>
          ← Back to search
        </button>
        <div className="form-error" role="alert">{error}</div>
      </div>
    );
  if (!data) return null;

  const { customer, bills, total_billed, total_paid, total_outstanding } = data;

  return (
    <div className="customer-detail">
      <button type="button" className="btn-link" onClick={onBack}>
        ← Back to search
      </button>

      <div className="customer-card">
        <h3>{customer.name}</h3>
        <div className="customer-meta">
          <span>📞 {customer.phone}</span>
          {customer.address && <span>{customer.address}</span>}
          {customer.gstin && <span>GSTIN: {customer.gstin}</span>}
        </div>
        <div className="customer-totals">
          <div>
            <span className="label">Billed</span>
            <span className="value">{fmtINR(total_billed)}</span>
          </div>
          <div>
            <span className="label">Paid</span>
            <span className="value paid">{fmtINR(total_paid)}</span>
          </div>
          <div>
            <span className="label">Outstanding</span>
            <span
              className={`value ${total_outstanding > 0 ? "outstanding" : "paid"}`}
              data-testid="customer-outstanding"
            >
              {fmtINR(total_outstanding)}
            </span>
          </div>
        </div>
      </div>

      <h4>Bills</h4>
      {bills.length === 0 ? (
        <div className="muted">
          No bills yet for this customer. Issue a bill from the Calculate page
          to start tracking payments.
        </div>
      ) : (
        <table className="bills-table">
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Job</th>
              <th>Depth</th>
              <th className="num">Total</th>
              <th className="num">Paid</th>
              <th className="num">Outstanding</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <BillRow key={b.id} bill={b} onOpen={() => onOpenBill(b.id)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BillRow({ bill, onOpen }: { bill: BillSummary; onOpen: () => void }) {
  return (
    <tr>
      <td>{bill.invoice_number}</td>
      <td>{bill.invoice_date}</td>
      <td>{jobTypeLabel(bill.job_type)}</td>
      <td>{bill.depth} ft</td>
      <td className="num">{fmtINR(bill.grand_total)}</td>
      <td className="num">{fmtINR(bill.paid_total)}</td>
      <td
        className={`num ${bill.outstanding > 0 ? "outstanding" : "paid"}`}
        data-testid={`bill-outstanding-${bill.id}`}
      >
        {fmtINR(bill.outstanding)}
      </td>
      <td>
        <button type="button" className="btn-secondary" onClick={onOpen}>
          Manage payments
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Bill detail: payments list + add/edit/delete
// ---------------------------------------------------------------------------

function BillPayments({
  billId,
  onBack,
  onError,
}: {
  billId: number;
  onBack: () => void;
  onError: (err: unknown) => string;
}) {
  const [data, setData] = useState<BillWithPayments | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchBillWithPayments(billId));
    } catch (err) {
      setError(onError(err));
    } finally {
      setLoading(false);
    }
  }, [billId, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="muted">Loading bill…</div>;
  if (error)
    return (
      <div>
        <button type="button" className="btn-link" onClick={onBack}>
          ← Back to customer
        </button>
        <div className="form-error" role="alert">{error}</div>
      </div>
    );
  if (!data) return null;

  const { bill, customer, payments } = data;

  return (
    <div className="bill-payments">
      <button type="button" className="btn-link" onClick={onBack}>
        ← Back to {customer.name}
      </button>

      <div className="bill-summary-card">
        <div>
          <h3>Invoice {bill.invoice_number}</h3>
          <div className="muted">
            {jobTypeLabel(bill.job_type)} · {bill.depth} ft · {bill.invoice_date}
          </div>
        </div>
        <div className="bill-amounts">
          <div>
            <span className="label">Total</span>
            <span className="value">{fmtINR(bill.grand_total)}</span>
          </div>
          <div>
            <span className="label">Paid</span>
            <span className="value paid">{fmtINR(bill.paid_total)}</span>
          </div>
          <div>
            <span className="label">Outstanding</span>
            <span
              className={`value ${bill.outstanding > 0 ? "outstanding" : "paid"}`}
              data-testid="bill-remaining"
            >
              {fmtINR(bill.outstanding)}
            </span>
          </div>
        </div>
      </div>

      <AddPaymentForm
        billId={billId}
        outstanding={bill.outstanding}
        onAdded={refresh}
        onError={onError}
      />

      <h4>Transactions</h4>
      {payments.length === 0 ? (
        <div className="muted">No payments recorded yet.</div>
      ) : (
        <table className="payments-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Mode</th>
              <th>Note</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <PaymentRow
                key={p.id}
                payment={p}
                outstanding={bill.outstanding}
                onChanged={refresh}
                onError={onError}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AddPaymentForm({
  billId,
  outstanding,
  onAdded,
  onError,
}: {
  billId: number;
  outstanding: number;
  onAdded: () => void | Promise<void>;
  onError: (err: unknown) => string;
}) {
  const [form, setForm] = useState<PaymentCreate>(emptyPaymentForm());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return setError("Enter an amount greater than zero");
    }
    setBusy(true);
    try {
      await addPayment(billId, {
        amount,
        paid_at: form.paid_at ?? null,
        mode: form.mode,
        note: form.note?.trim() || null,
      });
      setForm(emptyPaymentForm());
      await onAdded();
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = outstanding <= 0;

  return (
    <form className="payment-form" onSubmit={handleSubmit}>
      <h4>Record a payment</h4>
      {disabled && (
        <div className="muted">This bill is fully paid. No further payments needed.</div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-row">
        <label>
          Amount<span className="required-star">*</span>
          <input
            type="number"
            min={0}
            step="0.01"
            required
            disabled={disabled || busy}
            value={form.amount || ""}
            onChange={(e) =>
              setForm({ ...form, amount: Number(e.target.value) })
            }
            data-testid="payment-amount"
          />
        </label>
        <label>
          Date
          <input
            type="date"
            required
            disabled={disabled || busy}
            value={form.paid_at ?? ""}
            onChange={(e) => setForm({ ...form, paid_at: e.target.value })}
          />
        </label>
        <label>
          Mode
          <select
            disabled={disabled || busy}
            value={form.mode}
            onChange={(e) =>
              setForm({ ...form, mode: e.target.value as PaymentMode })
            }
          >
            {PAYMENT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Note
        <input
          type="text"
          disabled={disabled || busy}
          value={form.note ?? ""}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          maxLength={240}
          placeholder="Reference / receipt no. / remark"
        />
      </label>
      <button
        type="submit"
        className="btn-primary"
        disabled={disabled || busy}
        data-testid="payment-submit"
      >
        {busy ? "Saving…" : "Add payment"}
      </button>
    </form>
  );
}

function PaymentRow({
  payment,
  outstanding,
  onChanged,
  onError,
}: {
  payment: PaymentRecord;
  outstanding: number;
  onChanged: () => void | Promise<void>;
  onError: (err: unknown) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PaymentCreate>({
    amount: payment.amount,
    paid_at: payment.paid_at,
    mode: payment.mode,
    note: payment.note ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return setError("Enter an amount greater than zero");
    }
    setBusy(true);
    try {
      await updatePayment(payment.id, {
        amount,
        paid_at: draft.paid_at ?? null,
        mode: draft.mode,
        note: draft.note?.trim() || null,
      });
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete payment of ${fmtINR(payment.amount)} on ${payment.paid_at}?`)) return;
    setBusy(true);
    try {
      await deletePayment(payment.id);
      await onChanged();
    } catch (err) {
      setError(onError(err));
      setBusy(false);
    }
  };

  const maxAllowed = outstanding + payment.amount;

  if (!editing) {
    return (
      <tr>
        <td>{payment.paid_at}</td>
        <td className="num">{fmtINR(payment.amount)}</td>
        <td>{modeLabel(payment.mode)}</td>
        <td>{payment.note ?? ""}</td>
        <td className="row-actions">
          <button type="button" className="btn-link" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="btn-link btn-danger"
            onClick={remove}
            disabled={busy}
          >
            Delete
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="editing">
      <td>
        <input
          type="date"
          value={draft.paid_at ?? ""}
          onChange={(e) => setDraft({ ...draft, paid_at: e.target.value })}
        />
      </td>
      <td className="num">
        <input
          type="number"
          min={0}
          max={maxAllowed}
          step="0.01"
          value={draft.amount || ""}
          onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
        />
      </td>
      <td>
        <select
          value={draft.mode}
          onChange={(e) =>
            setDraft({ ...draft, mode: e.target.value as PaymentMode })
          }
        >
          {PAYMENT_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="text"
          value={draft.note ?? ""}
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          maxLength={240}
        />
        {error && <div className="form-error">{error}</div>}
      </td>
      <td className="row-actions">
        <button type="button" className="btn-primary" onClick={save} disabled={busy}>
          Save
        </button>
        <button
          type="button"
          className="btn-link"
          onClick={() => {
            setEditing(false);
            setDraft({
              amount: payment.amount,
              paid_at: payment.paid_at,
              mode: payment.mode,
              note: payment.note ?? "",
            });
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}
