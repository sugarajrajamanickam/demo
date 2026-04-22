import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Customer,
  CustomerCreate,
  JobType,
  createCustomer,
  listCustomers,
  updateCustomer,
} from "./api";

interface Props {
  onUnauthorized: () => void;
}

const PHONE_RE = /^\+?[0-9\- ]{7,20}$/;

function jobTypeLabel(jt: JobType | string): string {
  if (jt === "new_bore") return "New Bore";
  if (jt === "re_bore") return "Re-Bore";
  return jt || "—";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): CustomerCreate {
  return {
    name: "",
    phone: "",
    address: "",
    state: "",
    state_code: "",
    gstin: "",
    date_of_request: todayIso(),
    actual_date_of_bore: "",
    bore_type: "new_bore",
  };
}

export default function Customers({ onUnauthorized }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Request failed";
      if (msg.toLowerCase().includes("session expired")) onUnauthorized();
      return msg;
    },
    [onUnauthorized],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await listCustomers());
    } catch (err) {
      setError(handleError(err));
    } finally {
      setLoading(false);
    }
  }, [handleError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q),
    );
  }, [customers, query]);

  const openCreate = () => {
    setEditing(null);
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setShowForm(true);
  };

  const closeForm = () => {
    setEditing(null);
    setShowForm(false);
  };

  const handleSaved = () => {
    closeForm();
    void refresh();
  };

  return (
    <section className="customers-page">
      <div className="customers-header">
        <h2>Customers</h2>
        <button
          type="button"
          className="btn-primary"
          onClick={openCreate}
          data-testid="customer-add"
        >
          Add customer
        </button>
      </div>

      <div className="customers-search-row">
        <input
          type="search"
          placeholder="Search by name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="customer-list-search"
        />
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {loading && <div className="muted">Loading customers…</div>}
      {!loading && filtered.length === 0 && (
        <div className="muted">
          {query
            ? "No customers match."
            : "No customers yet. Click Add customer to create one."}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="table-wrap">
          <table className="customers-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Address</th>
                <th>Date of request</th>
                <th>Actual date of bore</th>
                <th>Bore type</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} data-testid={`customer-row-${c.id}`}>
                  <td>{c.name}</td>
                  <td>{c.phone}</td>
                  <td>{c.address || "—"}</td>
                  <td>{c.date_of_request || "—"}</td>
                  <td>{c.actual_date_of_bore || "—"}</td>
                  <td>{jobTypeLabel(c.bore_type)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => openEdit(c)}
                      data-testid={`customer-edit-${c.id}`}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <CustomerFormModal
          initial={editing}
          onClose={closeForm}
          onSaved={handleSaved}
          onError={handleError}
        />
      )}
    </section>
  );
}

function CustomerFormModal({
  initial,
  onClose,
  onSaved,
  onError,
}: {
  initial: Customer | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => string;
}) {
  const [form, setForm] = useState<CustomerCreate>(() =>
    initial
      ? {
          name: initial.name,
          phone: initial.phone,
          address: initial.address ?? "",
          state: initial.state ?? "",
          state_code: initial.state_code ?? "",
          gstin: initial.gstin ?? "",
          date_of_request: initial.date_of_request || todayIso(),
          actual_date_of_bore: initial.actual_date_of_bore || "",
          bore_type: initial.bore_type || "new_bore",
        }
      : emptyForm(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = initial !== null;

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
    if (!form.date_of_request) {
      return setError("Date of request is required");
    }
    const payload: CustomerCreate = {
      name,
      phone,
      address: (form.address ?? "").trim() || null,
      state: (form.state ?? "").trim() || null,
      state_code: (form.state_code ?? "").trim() || null,
      gstin: (form.gstin ?? "").trim() || null,
      date_of_request: form.date_of_request,
      actual_date_of_bore: form.actual_date_of_bore || null,
      bore_type: form.bore_type,
    };
    setBusy(true);
    try {
      if (isEdit && initial) {
        await updateCustomer(initial.id, payload);
      } else {
        await createCustomer(payload);
      }
      onSaved();
    } catch (err) {
      setError(onError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      data-testid="customer-form-backdrop"
    >
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-form-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id="customer-form-title">
            {isEdit ? "Edit customer" : "New customer"}
          </h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form className="customer-create-form" onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <label>
              Name<span className="required-star">*</span>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={120}
                data-testid="customer-form-name"
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
                data-testid="customer-form-phone"
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
                  onChange={(e) =>
                    setForm({ ...form, state_code: e.target.value })
                  }
                  maxLength={4}
                />
              </label>
            </div>
            <label>
              GSTIN
              <input
                type="text"
                value={form.gstin ?? ""}
                onChange={(e) =>
                  setForm({ ...form, gstin: e.target.value.toUpperCase() })
                }
                maxLength={15}
              />
            </label>
            <div className="form-row">
              <label>
                Date of request<span className="required-star">*</span>
                <input
                  type="date"
                  required
                  value={form.date_of_request ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, date_of_request: e.target.value })
                  }
                  data-testid="customer-form-date-of-request"
                />
              </label>
              <label>
                Actual date of bore
                <input
                  type="date"
                  value={form.actual_date_of_bore ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, actual_date_of_bore: e.target.value })
                  }
                  data-testid="customer-form-actual-date-of-bore"
                />
              </label>
            </div>
            <fieldset className="job-type-group">
              <legend>
                Bore type<span className="required-star">*</span>
              </legend>
              <div className="job-type-options">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="bore_type"
                    value="new_bore"
                    checked={form.bore_type === "new_bore"}
                    onChange={() => setForm({ ...form, bore_type: "new_bore" })}
                  />
                  <span>New Bore</span>
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="bore_type"
                    value="re_bore"
                    checked={form.bore_type === "re_bore"}
                    onChange={() => setForm({ ...form, bore_type: "re_bore" })}
                  />
                  <span>Re-Bore</span>
                </label>
              </div>
            </fieldset>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={busy}
              data-testid="customer-form-save"
            >
              {busy ? "Saving…" : isEdit ? "Save changes" : "Create customer"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
