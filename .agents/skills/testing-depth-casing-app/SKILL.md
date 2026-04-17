# Testing the Depth/Casing FastAPI + React app

Use this when verifying the full-stack Depth/Casing demo app (JWT-protected FastAPI backend + React SPA served from `/static`).

## Quick local run
```bash
docker build -t demo-app:test .
docker run -d --name demo-app-test -p 8000:8000 \
  -e APP_USERNAME=admin -e APP_PASSWORD=admin demo-app:test
curl -sS http://127.0.0.1:8000/api/health   # -> {"status":"ok"}
```
The React SPA is served from the same port as the API. SPA routes fall back to `index.html`.

## Auth flow
- Seed creds come from env vars `APP_USERNAME` / `APP_PASSWORD` (defaults `admin`/`admin`; safe only for local).
- `POST /token` with form-encoded `username`/`password` (OAuth2 password grant) returns `{access_token, token_type}`.
- `POST /api/add` expects `Authorization: Bearer <token>` and JSON body `{"depth": number, "casing": number}`; returns `{depth, casing, sum}`.
- Other routes: `GET /api/health` (public), `GET /api/me` (protected).
- Frontend stores the token in `localStorage` under `demo_auth_token`. Logout clears it.

## Minimal adversarial UI test
Use a **non-integer, non-symmetric pair** so a broken impl is visible:
- Depth `12.5`, Casing `7.25` → UI must show exactly `Sum 19.75`.
- A hard-coded value, int truncation (`19`), or wrong operator (sub `5.25`, mul `90.625`) would all show a different number.

Recommended flow (single continuous recording):
1. Bad password (`admin`/`wrongpassword`) → inline `Invalid username or password`, no Calculate form.
2. Good password (`admin`/`admin`) → Calculate form + Log out button render.
3. Enter `12.5` / `7.25`, click Compute → result card `Depth 12.5`, `Casing 7.25`, `Sum 19.75`.
4. Click Log out, refresh (F5) → Sign-in form persists (token cleared).

## Backend-only smoke (no browser needed)
```bash
curl -X POST :8000/api/add -H 'Content-Type: application/json' -d '{"depth":1,"casing":2}'   # 401 Not authenticated
curl -X POST :8000/token -d 'username=admin&password=wrong'                                  # 401
TOKEN=$(curl -sS -X POST :8000/token -d 'username=admin&password=admin' | jq -r .access_token)
curl -X POST :8000/api/add -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"depth":12.5,"casing":7.25}'                     # 200 {"sum":19.75}
```

## Gotchas / workarounds
- **`passlib` + `bcrypt>=4` is broken** (`AttributeError: module 'bcrypt' has no attribute '__about__'`). This repo bypasses it by calling `bcrypt.hashpw` / `bcrypt.checkpw` directly in `backend/app/auth.py`. If you add password-hashing code elsewhere, do the same — don't re-introduce `passlib`.
- Bcrypt silently truncates passwords at 72 bytes; explicit `password.encode('utf-8')[:72]` avoids version-dependent errors.
- Default `APP_SECRET_KEY` and `APP_CORS_ORIGINS=*` are dev-only; override before internet exposure.
- `xdotool` is not always installed on the testing VM — don't rely on it to resize Chrome for responsive regression tests; use Chrome DevTools device mode instead.
- Frontend dev server (Vite on `:5173`) proxies `/token` + `/api/*` to `:8000`; when testing the built artifact, hit port `8000` directly.

## Devin Secrets Needed
None. All credentials for local testing are set via `-e APP_USERNAME` / `-e APP_PASSWORD` on `docker run` (defaults to `admin`/`admin`).
