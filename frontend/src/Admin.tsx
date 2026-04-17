import { FormEvent, useCallback, useEffect, useState } from "react";
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

export default function Admin({ onUnauthorized, currentUsername }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AdminUserCreate>(emptyCreate);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<AdminUserUpdate & { password?: string }>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listUsers();
      setUsers(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load users";
      setError(message);
      if (message.toLowerCase().includes("session expired")) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
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
            Username
            <input
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
          <label>
            Mobile number
            <input
              required
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              inputMode="tel"
            />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </label>
          <label>
            Role
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>
            Full name (optional)
            <input
              value={form.full_name ?? ""}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create user"}
          </button>
        </form>
      </section>

      <section className="card admin-card admin-list">
        <h2>Users</h2>
        {error && <p className="error">{error}</p>}
        {loading ? (
          <p>Loading…</p>
        ) : (
          <div className="table-wrap">
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
      </section>
    </div>
  );
}
