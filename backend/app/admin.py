"""Admin router: user CRUD. All endpoints require role=admin."""
from __future__ import annotations

from typing import List, Optional

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, func, select

from .auth import hash_password, hash_security_answer, require_admin
from .db import get_session
from .models import Role, User

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


class UserOut(BaseModel):
    id: int
    username: str
    mobile: str
    role: Role
    full_name: Optional[str] = None
    # Plain question is fine to expose to other admins so they can see which
    # users can self-serve reset. The answer hash stays server-side only.
    security_question: Optional[str] = None
    has_security_question: bool = False

    @classmethod
    def from_user(cls, u: User) -> "UserOut":
        assert u.id is not None
        return cls(
            id=u.id,
            username=u.username,
            mobile=u.mobile,
            role=u.role,
            full_name=u.full_name,
            security_question=u.security_question,
            has_security_question=bool(
                u.security_question and u.security_answer_hash
            ),
        )


# Input validation patterns.
# - Usernames are alphabetic only (no spaces, digits, or symbols).
# - Mobile numbers must be exactly 10 digits.
# - Passwords allow letters, digits, '@' and '.' only.
# - Full names allow letters and spaces (so e.g. "Alice Manager" works).
USERNAME_PATTERN = r"^[A-Za-z]+$"
MOBILE_PATTERN = r"^\d{10}$"
PASSWORD_PATTERN = r"^[A-Za-z0-9@.]+$"
FULL_NAME_PATTERN = r"^[A-Za-z ]+$"

USERNAME_MSG = "Username must contain letters only (A-Z, a-z)."
MOBILE_MSG = "Mobile number must be exactly 10 digits."
PASSWORD_MSG = "Password may contain only letters, digits, '@' and '.'."
FULL_NAME_MSG = "Full name must contain letters and spaces only."

# Security question / answer are free-form but bounded. We also require that
# admins always have both set so they can self-serve a password reset.
SECURITY_QUESTION_MAX = 255
SECURITY_ANSWER_MAX = 128


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64, pattern=USERNAME_PATTERN)
    mobile: str = Field(..., pattern=MOBILE_PATTERN)
    password: str = Field(..., min_length=1, max_length=128, pattern=PASSWORD_PATTERN)
    role: Role
    # Full name is mandatory at registration.
    full_name: str = Field(..., min_length=1, max_length=128, pattern=FULL_NAME_PATTERN)
    # Security Q/A optional for managers; an admin-level create requires them
    # (enforced below in `_validate_admin_has_security`).
    security_question: Optional[str] = Field(default=None, max_length=SECURITY_QUESTION_MAX)
    security_answer: Optional[str] = Field(default=None, max_length=SECURITY_ANSWER_MAX)

    @field_validator("security_question", "security_answer")
    @classmethod
    def _strip_blank_to_none(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v or None


class UserUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=64, pattern=USERNAME_PATTERN)
    mobile: Optional[str] = Field(default=None, pattern=MOBILE_PATTERN)
    password: Optional[str] = Field(default=None, min_length=1, max_length=128, pattern=PASSWORD_PATTERN)
    role: Optional[Role] = None
    # full_name is optional on update; empty string is allowed (clears the field).
    full_name: Optional[str] = Field(default=None, max_length=128)
    # Security Q/A are update-only-if-provided. Sending an empty string clears
    # both (only allowed on manager accounts — see update_user logic).
    security_question: Optional[str] = Field(default=None, max_length=SECURITY_QUESTION_MAX)
    security_answer: Optional[str] = Field(default=None, max_length=SECURITY_ANSWER_MAX)

    @field_validator("full_name")
    @classmethod
    def _validate_full_name(cls, v: Optional[str]) -> Optional[str]:
        # Allow None and empty string (explicit clear). Otherwise enforce the
        # letters-and-spaces rule so updates match create-time validation.
        if v is None or v == "":
            return v
        if not re.fullmatch(FULL_NAME_PATTERN, v):
            raise ValueError(FULL_NAME_MSG)
        return v

    @field_validator("security_question", "security_answer")
    @classmethod
    def _strip_security_field(cls, v: Optional[str]) -> Optional[str]:
        # Sentinel semantics on update: ``None`` means 'unchanged', ``""``
        # means 'clear both' (only allowed for managers — see update_user).
        # Whitespace-only input would otherwise sneak past these checks and
        # hit ``hash_security_answer`` (which strips+casefolds), producing a
        # hash of the empty string and a trivially-bypassable answer.
        # Normalise whitespace-only -> "" so the clearing branch is taken
        # (which admins are blocked from) instead of persisting a hash of "".
        if v is None:
            return None
        stripped = v.strip()
        if stripped == "":
            return ""
        return stripped


def _get_user_or_404(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


class UserList(BaseModel):
    items: List[UserOut]
    total: int
    limit: int
    offset: int


@router.get("/users", response_model=UserList)
def list_users(
    session: Session = Depends(get_session),
    limit: int = Query(25, ge=1, le=100, description="Page size (1-100)."),
    offset: int = Query(0, ge=0, description="Number of records to skip."),
    q: Optional[str] = Query(
        None,
        description="Case-insensitive substring filter across username/mobile/full_name.",
        max_length=128,
    ),
    role: Optional[Role] = Query(None, description="Filter to a specific role."),
) -> UserList:
    base_conditions = []
    if q:
        # Escape SQL LIKE wildcards so a literal "%" or "_" in the query
        # doesn't degenerate into a match-everything pattern. We also
        # escape the escape character itself.
        escaped = (
            q.lower()
            .replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        like = f"%{escaped}%"
        base_conditions.append(
            func.lower(User.username).like(like, escape="\\")
            | func.lower(User.mobile).like(like, escape="\\")
            | func.lower(func.coalesce(User.full_name, "")).like(like, escape="\\")
        )
    if role is not None:
        base_conditions.append(User.role == role)

    count_stmt = select(func.count()).select_from(User)
    for cond in base_conditions:
        count_stmt = count_stmt.where(cond)
    total = session.exec(count_stmt).one()
    if isinstance(total, tuple):  # some SQLAlchemy versions return a row tuple
        total = total[0]

    list_stmt = select(User).order_by(User.id)
    for cond in base_conditions:
        list_stmt = list_stmt.where(cond)
    list_stmt = list_stmt.offset(offset).limit(limit)
    users = session.exec(list_stmt).all()

    return UserList(
        items=[UserOut.from_user(u) for u in users],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, session: Session = Depends(get_session)) -> UserOut:
    existing = session.exec(select(User).where(User.username == payload.username)).first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Username already exists"
        )
    # Admins must always have a security question + answer so they can
    # self-serve a password reset if they forget their password (prevents
    # lockout where the only admin can't log in).
    if payload.role is Role.ADMIN and not (
        payload.security_question and payload.security_answer
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Admins must set a security question and answer",
        )
    # Q + A come as a pair: reject half-configured security data.
    if bool(payload.security_question) != bool(payload.security_answer):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Security question and answer must be set together",
        )

    user = User(
        username=payload.username,
        mobile=payload.mobile,
        password_hash=hash_password(payload.password),
        role=payload.role,
        full_name=payload.full_name,
        security_question=payload.security_question,
        security_answer_hash=(
            hash_security_answer(payload.security_answer)
            if payload.security_answer
            else None
        ),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return UserOut.from_user(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    session: Session = Depends(get_session),
    current_admin: User = Depends(require_admin),
) -> UserOut:
    user = _get_user_or_404(session, user_id)

    # Guard: prevent an admin from demoting themselves if they'd become the
    # only way to lose admin access (simplifies recovery). Allowed to change
    # other fields on their own record.
    if payload.role is not None and user.id == current_admin.id and payload.role is not Role.ADMIN:
        other_admin = session.exec(
            select(User).where(User.role == Role.ADMIN, User.id != user.id)
        ).first()
        if other_admin is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot demote the only admin",
            )

    if payload.username is not None and payload.username != user.username:
        dup = session.exec(select(User).where(User.username == payload.username)).first()
        if dup is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Username already exists"
            )
        user.username = payload.username
    if payload.mobile is not None:
        user.mobile = payload.mobile
    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
    if payload.role is not None:
        user.role = payload.role
    if payload.full_name is not None:
        # Normalize empty-string to NULL so "cleared" names render as the
        # "—" placeholder in the UI (which uses `?? "—"` — nullish only).
        user.full_name = payload.full_name or None

    # --- Security Q/A updates -----------------------------------------------
    # Treat None as "don't touch". Treat empty string as "clear both" (only
    # valid for managers — admins must always have Q/A set).
    new_q = payload.security_question
    new_a = payload.security_answer
    clearing = (new_q == "" and new_a == "")
    effective_role = payload.role if payload.role is not None else user.role
    if clearing:
        if effective_role is Role.ADMIN:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Admins must keep a security question and answer",
            )
        user.security_question = None
        user.security_answer_hash = None
    else:
        if new_q is not None:
            user.security_question = new_q or None
        if new_a is not None and new_a != "":
            user.security_answer_hash = hash_security_answer(new_a)
    # After the update, an admin must have both question AND answer on file.
    if effective_role is Role.ADMIN and not (
        user.security_question and user.security_answer_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Admins must have a security question and answer",
        )

    session.add(user)
    session.commit()
    session.refresh(user)
    return UserOut.from_user(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    current_admin: User = Depends(require_admin),
) -> Response:
    user = _get_user_or_404(session, user_id)
    if user.id == current_admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot delete the currently signed-in admin",
        )
    if user.role is Role.ADMIN:
        other_admin = session.exec(
            select(User).where(User.role == Role.ADMIN, User.id != user.id)
        ).first()
        if other_admin is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot delete the only admin",
            )
    session.delete(user)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
