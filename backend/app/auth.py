"""JWT auth for the demo app with DB-backed users and role-based access.

A bootstrap admin user is seeded on first startup using APP_USERNAME /
APP_PASSWORD / APP_ADMIN_MOBILE env vars (defaults: admin / admin / 0000000000).
All further users are managed through the admin API. In production you MUST
override APP_SECRET_KEY and the bootstrap credentials.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlmodel import Session, select

from .db import engine, get_session
from .models import Role, User

logger = logging.getLogger(__name__)

_DEFAULT_SECRET_KEY = "dev-secret-change-me"
SECRET_KEY = os.getenv("APP_SECRET_KEY", _DEFAULT_SECRET_KEY)
if SECRET_KEY == _DEFAULT_SECRET_KEY:
    logger.warning(
        "APP_SECRET_KEY is unset; using the built-in development secret. "
        "Set APP_SECRET_KEY to a strong random value before deploying — "
        "anyone who knows the default secret can forge valid JWTs."
    )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("APP_TOKEN_EXPIRE_MINUTES", "60"))

BOOTSTRAP_USERNAME = os.getenv("APP_USERNAME", "admin")
BOOTSTRAP_PASSWORD = os.getenv("APP_PASSWORD", "admin")
BOOTSTRAP_MOBILE = os.getenv("APP_ADMIN_MOBILE", "0000000000")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: Role


class TokenData(BaseModel):
    username: Optional[str] = None
    role: Optional[Role] = None


def _truncate_for_bcrypt(password: str) -> bytes:
    # bcrypt silently truncates at 72 bytes; be explicit to avoid library errors.
    return password.encode("utf-8")[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_truncate_for_bcrypt(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(_truncate_for_bcrypt(password), password_hash.encode("utf-8"))
    except ValueError:
        return False


def authenticate_user(session: Session, username: str, password: str) -> Optional[User]:
    user = session.exec(select(User).where(User.username == username)).first()
    if user is None:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def create_access_token(user: User, expires_delta: Optional[timedelta] = None) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    assert user.id is not None, "Cannot issue a token for an unsaved user"
    # `sub` is the immutable user id so renames don't invalidate live sessions.
    to_encode = {"sub": str(user.id), "role": user.role.value, "exp": expire}
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def _credentials_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> User:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        sub: Optional[str] = payload.get("sub")
        if sub is None:
            raise _credentials_exception()
        try:
            user_id = int(sub)
        except (TypeError, ValueError) as exc:
            raise _credentials_exception() from exc
    except JWTError as exc:
        raise _credentials_exception() from exc

    user = session.get(User, user_id)
    if user is None:
        # Token is valid but the user has been deleted — treat as unauthenticated.
        raise _credentials_exception()
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role is not Role.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )
    return current_user


def bootstrap_admin() -> None:
    """Ensure at least one admin exists so operators can log in after a fresh deploy."""
    with Session(engine) as session:
        existing = session.exec(select(User)).first()
        if existing is not None:
            return
        admin = User(
            username=BOOTSTRAP_USERNAME,
            mobile=BOOTSTRAP_MOBILE,
            password_hash=hash_password(BOOTSTRAP_PASSWORD),
            role=Role.ADMIN,
            full_name="Bootstrap Admin",
        )
        session.add(admin)
        session.commit()
        logger.info(
            "Seeded bootstrap admin user username=%s — change the password via the admin API.",
            BOOTSTRAP_USERNAME,
        )
