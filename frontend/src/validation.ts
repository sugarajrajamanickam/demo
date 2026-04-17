// Shared client-side input validators. These mirror the backend rules in
// `backend/app/admin.py` so users get inline feedback before hitting the API
// (server-side validation is still authoritative — never rely on client rules
// alone).

export const USERNAME_PATTERN = /^[A-Za-z]+$/;
export const MOBILE_PATTERN = /^\d{10}$/;
export const PASSWORD_PATTERN = /^[A-Za-z0-9@.]+$/;
export const FULL_NAME_PATTERN = /^[A-Za-z ]+$/;

// Raw strings (no anchors) for the HTML5 `pattern` attribute, which implicitly
// anchors to the whole value.
export const USERNAME_HTML_PATTERN = "[A-Za-z]+";
export const MOBILE_HTML_PATTERN = "\\d{10}";
export const PASSWORD_HTML_PATTERN = "[A-Za-z0-9@.]+";
export const FULL_NAME_HTML_PATTERN = "[A-Za-z ]+";

export const USERNAME_MSG = "Username must contain letters only (A-Z, a-z).";
export const MOBILE_MSG = "Mobile number must be exactly 10 digits.";
export const PASSWORD_MSG =
  "Password may contain only letters, digits, '@' and '.'.";
export const FULL_NAME_MSG = "Full name must contain letters and spaces only.";

export interface UserFormValues {
  username: string;
  mobile: string;
  password: string;
  full_name?: string | null;
}

/**
 * Validate a full user create/update payload. Returns the first error message,
 * or null when the payload is acceptable. `password` is validated only when
 * non-empty so that admins can edit a user without resetting their password.
 */
export function validateUserFields(
  values: UserFormValues,
  opts: { requirePassword: boolean }
): string | null {
  if (!USERNAME_PATTERN.test(values.username)) return USERNAME_MSG;
  if (!MOBILE_PATTERN.test(values.mobile)) return MOBILE_MSG;
  if (opts.requirePassword || values.password.length > 0) {
    if (!PASSWORD_PATTERN.test(values.password)) return PASSWORD_MSG;
  }
  const fn = values.full_name ?? "";
  if (fn.length > 0 && !FULL_NAME_PATTERN.test(fn)) return FULL_NAME_MSG;
  return null;
}
