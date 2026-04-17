"""Simple JWT auth for the demo app.

A single user is configured via the APP_USERNAME and APP_PASSWORD environment
variables (defaults: admin / admin). In production you MUST override
APP_SECRET_KEY and the credentials.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel

SECRET_KEY = os.getenv("APP_SECRET_KEY", "dev-secret-change-me")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("APP_TOKEN_EXPIRE_MINUTES", "60"))

APP_USERNAME = os.getenv("APP_USERNAME", "admin")
APP_PASSWORD = os.getenv("APP_PASSWORD", "admin")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


def _truncate_for_bcrypt(password: str) -> bytes:
    # bcrypt silently truncates at 72 bytes; be explicit to avoid library errors.
    return password.encode("utf-8")[:72]


_PASSWORD_HASH = bcrypt.hashpw(_truncate_for_bcrypt(APP_PASSWORD), bcrypt.gensalt())


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: Optional[str] = None


def verify_credentials(username: str, password: str) -> bool:
    if username != APP_USERNAME:
        return False
    return bcrypt.checkpw(_truncate_for_bcrypt(password), _PASSWORD_HASH)


def create_access_token(subject: str, expires_delta: Optional[timedelta] = None) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode = {"sub": subject, "exp": expire}
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: Optional[str] = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError as exc:
        raise credentials_exception from exc
    return username
