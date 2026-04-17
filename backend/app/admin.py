"""Admin router: user CRUD. All endpoints require role=admin."""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .auth import hash_password, require_admin
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

    @classmethod
    def from_user(cls, u: User) -> "UserOut":
        assert u.id is not None
        return cls(
            id=u.id,
            username=u.username,
            mobile=u.mobile,
            role=u.role,
            full_name=u.full_name,
        )


class UserCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    mobile: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=128)
    role: Role
    full_name: Optional[str] = Field(default=None, max_length=128)


class UserUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=64)
    mobile: Optional[str] = Field(default=None, min_length=1, max_length=32)
    password: Optional[str] = Field(default=None, min_length=1, max_length=128)
    role: Optional[Role] = None
    full_name: Optional[str] = Field(default=None, max_length=128)


def _get_user_or_404(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


@router.get("/users", response_model=List[UserOut])
def list_users(session: Session = Depends(get_session)) -> List[UserOut]:
    users = session.exec(select(User).order_by(User.id)).all()
    return [UserOut.from_user(u) for u in users]


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, session: Session = Depends(get_session)) -> UserOut:
    existing = session.exec(select(User).where(User.username == payload.username)).first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Username already exists"
        )
    user = User(
        username=payload.username,
        mobile=payload.mobile,
        password_hash=hash_password(payload.password),
        role=payload.role,
        full_name=payload.full_name,
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
        user.full_name = payload.full_name

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
