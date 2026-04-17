import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AdminUser,
  AdminUserCreate,
  AdminUserUpdate,
  Role,
  createUser,
  deleteUser,
  listUsers,
  updateUser,
} from "./api";
import {
  FULL_NAME_HTML_PATTERN,
  FULL_NAME_MSG,
  MOBILE_HTML_PATTERN,
  MOBILE_MSG,
  PASSWORD_HTML_PATTERN,
  PASSWORD_MSG,
  USERNAME_HTML_PATTERN,
  USERNAME_MSG,
  validateUserFields,
} from "./validation";

interface Props {
  onUnauthorized: () => void;
  currentUsername: string;
}

const emptyCreate: AdminUserCreate = {
  username: "",
  mobile: "",
  password: "",
  role: "manager",
  full_name: "",
};

const Star = () => (
  <span className="required-star" aria-hidden="true">*</span>
);

const FieldLabel = ({ text, required }: { text: string; required?: boolean }) => (
  <span className="field-label-text">
    {text}
    {required && <Star />}
  </span>
);

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export default function Admin({ onUnauthorized, currentUsername }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AdminUserCreate>(emptyCreate);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<AdminUserUpdate & { password?: string }>({});

  // Pagination + filter state.
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState<number>(0); // zero-indexed page
  const [filterInput, setFilterInput] = useState<string>("");
  const [filterQ, setFilterQ] = useState<string>(""); // debounced value sent to API
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");

  // Debounce filter input so we don't hammer the API on every keystroke.
  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setFilterQ(filterInput);
      setPage(0);
    }, 250);
    return () => {
      if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current);
    };
  }, [filterInput]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listUsers({
        limit: pageSize,
        offset: page * pageSize,
        q: filterQ,
        role: roleFilter,
      });
      setUsers(data.items);
      setTotal(data.total);
      // If a delete / filter change leaves us past the last page, step back.
      const maxPage = Math.max(0, Math.ceil(data.total / pageSize) - 1);
      if (page > maxPage) setPage(maxPage);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load users";
      setError(message);
      if (message.toLowerCase().includes("session expired")) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, page, pageSize, filterQ, roleFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, (page + 1) * pageSize);

  const handlePageSizeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setPageSize(Number(e.target.value));
    setPage(0);
  };

  const handleRoleFilterChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setRoleFilter(e.target.value as "" | Role);
    setPage(0);
  };

  const clearFilters = () => {
    setFilterInput("");
    setFilterQ("");
    setRoleFilter("");
    setPage(0);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const validationError = validateUserFields(
      {
        username: form.username,
        mobile: form.mobile,
        password: form.password,
        full_name: form.full_name ?? "",
      },
      { requirePassword: true }
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      await createUser(form);
      setForm(emptyCreate);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (u: AdminUser) => {
    setEditingId(u.id);
    setEditDraft({
      username: u.username,
      mobile: u.mobile,
      role: u.role,
      full_name: u.full_name ?? "",
      password: "",
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft({});
  };

  const saveEdit = async (id: number) => {
    setError(null);
    const validationError = validateUserFields(
      {
        username: editDraft.username ?? "",
        mobile: editDraft.mobile ?? "",
        password: editDraft.password ?? "",
        full_name: editDraft.full_name ?? "",
      },
      { requirePassword: false }
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      await updateUser(id, editDraft);
      cancelEdit();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  };

  const handleDelete = async (u: AdminUser) => {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteUser(u.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="admin">
      <section className="card admin-card">
        <h2>Add user</h2>
        <form className="admin-form" onSubmit={handleCreate}>
          <label>
            <FieldLabel text="Username" required />
            <input
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              pattern={USERNAME_HTML_PATTERN}
              title={USERNAME_MSG}
              maxLength={64}
              autoComplete="off"
            />
          </label>
          <label>
            <FieldLabel text="Mobile number" required />
            <input
              required
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              inputMode="numeric"
              pattern={MOBILE_HTML_PATTERN}
              title={MOBILE_MSG}
              maxLength={10}
              minLength={10}
            />
          </label>
          <label>
            <FieldLabel text="Password" required />
            <input
              required
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
              pattern={PASSWORD_HTML_PATTERN}
              title={PASSWORD_MSG}
              maxLength={128}
            />
          </label>
          <label>
            <FieldLabel text="Role" />
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>
            <FieldLabel text="Full name" required />
            <input
              required
              value={form.full_name ?? ""}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              pattern={FULL_NAME_HTML_PATTERN}
              title={FULL_NAME_MSG}
              maxLength={128}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create user"}
          </button>
        </form>
      </section>

      <section className="card admin-card admin-list">
        <div className="admin-list-header">
          <h2>Users</h2>
          <div className="admin-list-meta">
            {total === 0 ? "No users" : `Showing ${rangeStart}-${rangeEnd} of ${total}`}
          </div>
        </div>

        <div className="admin-list-controls">
          <input
            type="search"
            placeholder="Filter by username, mobile, or full name…"
            value={filterInput}
            onChange={(e) => setFilterInput(e.target.value)}
            className="filter-input"
            aria-label="Filter users"
          />
          <select
            value={roleFilter}
            onChange={handleRoleFilterChange}
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            <option value="admin">admin</option>
            <option value="manager">manager</option>
          </select>
          <label className="page-size">
            Rows per page:
            <select value={pageSize} onChange={handlePageSizeChange} aria-label="Rows per page">
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {(filterInput || roleFilter) && (
            <button type="button" className="secondary" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="table-wrap table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Mobile</th>
                  <th>Role</th>
                  <th>Full name</th>
                  <th>New password</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isEditing = editingId === u.id;
                  const isSelf = u.username === currentUsername;
                  return (
                    <tr key={u.id}>
                      <td>
                        {isEditing ? (
                          <input
                            value={editDraft.username ?? ""}
                            onChange={(e) => setEditDraft({ ...editDraft, username: e.target.value })}
                            pattern={USERNAME_HTML_PATTERN}
                            title={USERNAME_MSG}
                            maxLength={64}
                          />
                        ) : (
                          <>
                            {u.username}
                            {isSelf && <span className="self-badge">you</span>}
                          </>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            value={editDraft.mobile ?? ""}
                            onChange={(e) => setEditDraft({ ...editDraft, mobile: e.target.value })}
                            inputMode="numeric"
                            pattern={MOBILE_HTML_PATTERN}
                            title={MOBILE_MSG}
                            maxLength={10}
                            minLength={10}
                          />
                        ) : (
                          u.mobile
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <select
                            value={editDraft.role ?? u.role}
                            onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as Role })}
                          >
                            <option value="manager">manager</option>
                            <option value="admin">admin</option>
                          </select>
                        ) : (
                          <span className={`role-pill role-${u.role}`}>{u.role}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            value={editDraft.full_name ?? ""}
                            onChange={(e) => setEditDraft({ ...editDraft, full_name: e.target.value })}
                            pattern={FULL_NAME_HTML_PATTERN}
                            title={FULL_NAME_MSG}
                            maxLength={128}
                          />
                        ) : (
                          u.full_name ?? <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            type="password"
                            placeholder="leave blank to keep"
                            value={editDraft.password ?? ""}
                            onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })}
                            autoComplete="new-password"
                            pattern={PASSWORD_HTML_PATTERN}
                            title={PASSWORD_MSG}
                            maxLength={128}
                          />
                        ) : (
                          <span className="muted">•••••</span>
                        )}
                      </td>
                      <td className="row-actions">
                        {isEditing ? (
                          <>
                            <button type="button" onClick={() => saveEdit(u.id)}>
                              Save
                            </button>
                            <button type="button" className="secondary" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startEdit(u)}>
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={isSelf}
                              title={isSelf ? "Can't delete yourself" : "Delete user"}
                              onClick={() => handleDelete(u)}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && total === 0 && (
          <p className="muted">
            {filterQ || roleFilter ? "No users match your filters." : "No users yet."}
          </p>
        )}

        <div className="pagination">
          <button
            type="button"
            className="secondary"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ‹ Prev
          </button>
          <span className="muted">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={page + 1 >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next ›
          </button>
        </div>
      </section>
    </div>
  );
}
