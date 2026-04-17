"""FastAPI application: login + protected /api/add endpoint + SPA static serving."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session

from .admin import router as admin_router
from .auth import (
    Token,
    authenticate_user,
    bootstrap_admin,
    create_access_token,
    get_current_user,
)
from .db import get_session, init_db
from .models import User

app = FastAPI(title="Depth & Casing Demo", version="2.0.0")

# CORS: permissive by default so the Vite dev server (5173) can hit the API.
# Override APP_CORS_ORIGINS in production with a comma-separated allowlist.
# Note: browsers reject `Access-Control-Allow-Origin: *` combined with
# `Access-Control-Allow-Credentials: true`, so we only enable credentials
# when an explicit allowlist is configured.
cors_origins_env = os.getenv("APP_CORS_ORIGINS", "*")
is_wildcard = cors_origins_env.strip() == "*"
allow_origins = (
    ["*"] if is_wildcard else [o.strip() for o in cors_origins_env.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=not is_wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _on_startup() -> None:
    init_db()
    bootstrap_admin()


class AddRequest(BaseModel):
    depth: float = Field(..., ge=0, description="Depth value (must be >= 0)")
    casing: float = Field(..., ge=0, description="Casing value (must be >= 0)")


class AddResponse(BaseModel):
    depth: float
    casing: float
    sum: float


class MeResponse(BaseModel):
    id: int
    username: str
    mobile: str
    role: str
    full_name: str | None = None


@app.post("/token", response_model=Token, tags=["auth"])
def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
) -> Token:
    user = authenticate_user(session, form_data.username, form_data.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Token(access_token=create_access_token(user), role=user.role)


@app.get("/api/me", response_model=MeResponse, tags=["auth"])
def read_me(current_user: User = Depends(get_current_user)) -> MeResponse:
    assert current_user.id is not None
    return MeResponse(
        id=current_user.id,
        username=current_user.username,
        mobile=current_user.mobile,
        role=current_user.role.value,
        full_name=current_user.full_name,
    )


@app.post("/api/add", response_model=AddResponse, tags=["compute"])
def add_values(
    payload: AddRequest,
    _: User = Depends(get_current_user),
) -> AddResponse:
    return AddResponse(
        depth=payload.depth,
        casing=payload.casing,
        sum=payload.depth + payload.casing,
    )


@app.get("/api/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(admin_router)


# ---------------------------------------------------------------------------
# Static SPA serving
# ---------------------------------------------------------------------------
# When the container is built, the React build is copied to /app/static.
# For local backend-only dev this directory may not exist; we guard for that.
STATIC_DIR = Path(os.getenv("APP_STATIC_DIR", "/app/static"))

if STATIC_DIR.is_dir():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/", include_in_schema=False)
    def spa_root() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    _STATIC_ROOT = STATIC_DIR.resolve()

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_catch_all(full_path: str) -> FileResponse:
        # Serve real files if they exist (e.g. favicon), otherwise fall back
        # to index.html so React Router can handle the route.
        # Resolve the candidate and ensure it stays inside STATIC_DIR to block
        # path traversal (e.g. `../../etc/passwd`, percent-encoded variants).
        candidate = (STATIC_DIR / full_path).resolve()
        try:
            candidate.relative_to(_STATIC_ROOT)
        except ValueError:
            return FileResponse(STATIC_DIR / "index.html")
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
