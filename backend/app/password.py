"""Self-serve password reset via security question.

Two unauthenticated endpoints so that locked-out users (especially admins)
can recover without another admin's help:

- POST /api/password/forgot  {username}
    -> {security_question}  if the user has one set
    -> 404 otherwise (including when the username doesn't exist). Returning
       404 for both unknown-username and no-Q-on-file is intentional: it
       prevents an attacker from enumerating who has Q/A configured.

- POST /api/password/reset  {username, security_answer, new_password}
    -> 200 with {id, username, role} on success (new password applied)
    -> 401 if the answer doesn't match
    -> 404 if the username doesn't exist or has no security question

Password format is enforced the same way admin-side creates are: letters,
digits, '@' and '.' only. Answer comparison is case-insensitive and
whitespace-trimmed (see auth.normalize_security_answer).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .admin import PASSWORD_PATTERN, USERNAME_PATTERN
from .auth import hash_password, verify_security_answer
from .db import get_session
from .models import User

router = APIRouter(prefix="/api/password", tags=["password-reset"])


class ForgotRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, pattern=USERNAME_PATTERN)


class ForgotResponse(BaseModel):
    security_question: str


class ResetRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, pattern=USERNAME_PATTERN)
    # Free-form answer, but bounded so clients can't send megabytes.
    security_answer: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(
        ..., min_length=1, max_length=128, pattern=PASSWORD_PATTERN
    )


class ResetResponse(BaseModel):
    id: int
    username: str
    role: str


def _find_recoverable_user(session: Session, username: str) -> User:
    """Return the user if it exists *and* has a security question + answer
    on file, otherwise raise 404. 404 (not 400) is used for both the
    'unknown user' and 'no Q/A configured' cases to avoid user enumeration.
    """
    user = session.exec(select(User).where(User.username == username)).first()
    if user is None or not (user.security_question and user.security_answer_hash):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No security question is configured for that account",
        )
    return user


@router.post("/forgot", response_model=ForgotResponse)
def forgot_password(
    payload: ForgotRequest, session: Session = Depends(get_session)
) -> ForgotResponse:
    user = _find_recoverable_user(session, payload.username)
    # Already checked in _find_recoverable_user, but mypy-friendly:
    assert user.security_question is not None
    return ForgotResponse(security_question=user.security_question)


@router.post("/reset", response_model=ResetResponse)
def reset_password(
    payload: ResetRequest, session: Session = Depends(get_session)
) -> ResetResponse:
    user = _find_recoverable_user(session, payload.username)
    assert user.security_answer_hash is not None
    if not verify_security_answer(payload.security_answer, user.security_answer_hash):
        # Generic 401 so wrong-answer vs wrong-user-but-has-Q are
        # indistinguishable to the client. (We already 404'd on truly
        # unknown/no-Q users above.)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Security answer is incorrect",
        )

    user.password_hash = hash_password(payload.new_password)
    session.add(user)
    session.commit()
    session.refresh(user)
    assert user.id is not None
    return ResetResponse(id=user.id, username=user.username, role=user.role.value)
