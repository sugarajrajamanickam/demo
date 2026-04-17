# Depth & Casing Demo

A small internet-facing web app:

- **Frontend**: React (Vite + TypeScript) SPA with a login screen and a form that
  takes two inputs (`Depth` and `Casing`) and displays the sum returned by the
  backend. The layout is fluid and responsive for all screen sizes.
- **Backend**: FastAPI with JWT-based authentication. Exposes `/token` to sign
  in, `/api/add` to compute the sum (protected), `/api/me` and `/api/health`.
- **Packaging**: single multi-stage `Dockerfile` — the React build is copied
  into the Python image and served by FastAPI on port `8000`.

## Quick start (Docker)

```bash
docker build -t demo-app .
docker run --rm -p 8000:8000 \
  -e APP_USERNAME=admin \
  -e APP_PASSWORD=admin \
  -e APP_SECRET_KEY="$(openssl rand -hex 32)" \
  demo-app
```

Open http://localhost:8000 and sign in with the credentials above.

Or with Compose:

```bash
APP_PASSWORD=changeme APP_SECRET_KEY=$(openssl rand -hex 32) docker compose up --build
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `APP_USERNAME` | `admin` | Seed user name |
| `APP_PASSWORD` | `admin` | Seed user password (change for production) |
| `APP_SECRET_KEY` | `dev-secret-change-me` | HMAC secret for JWT signing (**must** be overridden in prod) |
| `APP_TOKEN_EXPIRE_MINUTES` | `60` | Access token lifetime |
| `APP_CORS_ORIGINS` | `*` | Comma-separated CORS allowlist |

## Deploying internet-facing

The container listens on `0.0.0.0:8000`. Put it behind an HTTPS-terminating
reverse proxy (e.g. nginx, Caddy, ALB, Cloud Run, Fly.io, Render). Make sure to
override `APP_SECRET_KEY` and `APP_PASSWORD`, and tighten `APP_CORS_ORIGINS`
to your domain.

## Local development (without Docker)

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Frontend (in a separate shell):

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server (http://localhost:5173) proxies `/token` and `/api/*` to
the backend at `http://localhost:8000`.

## API

`POST /token` — form-encoded `username` + `password`, returns `{access_token, token_type}`.

`POST /api/add` — JSON body `{"depth": <num>, "casing": <num>}`, Bearer auth required.
Response:

```json
{ "depth": 10, "casing": 5, "sum": 15 }
```

---

## Legacy: my-json-server demo

The original `db.json` lived here for [my-json-server](https://my-json-server.typicode.com/typicode/demo).
To reuse this repo as a mock JSON server, restore `db.json` to an array/object
shape (a bare scalar is not a valid my-json-server resource).
