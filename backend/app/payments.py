"""Customer + Bill ledger + Payment tracking API.

Supports the Payments page in the SPA: search for a customer by name
or phone, view their bills with running balance, and record/edit/delete
partial payments against each bill.

Bills are persisted by :mod:`.billing` at *Confirm & download PDF* time;
this module only reads bills and writes payments. It also owns the
Customer CRUD endpoints that the Payments page uses to create a
customer record before a bill can be issued to them.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlmodel import Session, select

from .auth import get_current_user
from .db import get_session
from .models import Bill, Customer, JobType, Payment, PaymentMode, User

router = APIRouter(tags=["payments"])


_PHONE_RE = re.compile(r"^\+?[0-9\- ]{7,20}$")
_GSTIN_RE = re.compile(r"^[0-9A-Z]{15}$")


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------


class CustomerCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    phone: str = Field(..., min_length=7, max_length=20)
    address: Optional[str] = Field(default=None, max_length=240)
    state: Optional[str] = Field(default=None, max_length=60)
    state_code: Optional[str] = Field(default=None, max_length=4)
    gstin: Optional[str] = Field(default=None, max_length=15)
    # ISO yyyy-mm-dd. Required for new customers; defaults to today if
    # the client omits it so the field never lands empty.
    date_of_request: Optional[str] = Field(default=None, max_length=10)
    # ISO yyyy-mm-dd or empty — "not yet performed".
    actual_date_of_bore: Optional[str] = Field(default=None, max_length=10)
    bore_type: JobType = Field(default=JobType.NEW_BORE)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Customer name is required")
        return v

    @field_validator("phone")
    @classmethod
    def _validate_phone(cls, v: str) -> str:
        v = v.strip()
        if not _PHONE_RE.match(v):
            raise ValueError(
                "Phone must be 7–20 digits; optional leading + and spaces/dashes allowed"
            )
        return v

    @field_validator("gstin")
    @classmethod
    def _validate_gstin(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        v = v.strip().upper()
        if not _GSTIN_RE.match(v):
            raise ValueError("GSTIN must be 15 alphanumeric characters")
        return v

    @field_validator("date_of_request", "actual_date_of_bore")
    @classmethod
    def _validate_iso_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        try:
            date.fromisoformat(v)
        except ValueError as err:
            raise ValueError("Dates must be ISO yyyy-mm-dd") from err
        return v


class CustomerUpdate(CustomerCreate):
    pass


class CustomerOut(BaseModel):
    id: int
    name: str
    phone: str
    address: Optional[str]
    state: Optional[str]
    state_code: Optional[str]
    gstin: Optional[str]
    date_of_request: str
    actual_date_of_bore: str
    bore_type: JobType
    created_at: datetime


class BillSummary(BaseModel):
    id: int
    invoice_number: str
    invoice_date: str
    job_type: str
    depth: float
    grand_total: float
    paid_total: float
    outstanding: float


class CustomerWithBills(BaseModel):
    customer: CustomerOut
    bills: List[BillSummary]
    total_billed: float
    total_paid: float
    total_outstanding: float


class PaymentCreate(BaseModel):
    amount: float = Field(..., gt=0)
    paid_at: Optional[str] = Field(default=None, max_length=10)
    mode: PaymentMode = Field(default=PaymentMode.CASH)
    note: Optional[str] = Field(default=None, max_length=240)

    @field_validator("paid_at")
    @classmethod
    def _validate_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        try:
            date.fromisoformat(v)
        except ValueError as err:
            raise ValueError("paid_at must be an ISO date (yyyy-mm-dd)") from err
        return v


class PaymentUpdate(PaymentCreate):
    pass


class PaymentOut(BaseModel):
    id: int
    bill_id: int
    amount: float
    paid_at: str
    mode: PaymentMode
    note: Optional[str]
    created_at: datetime
    updated_at: datetime


class BillWithPayments(BaseModel):
    bill: BillSummary
    customer: CustomerOut
    payments: List[PaymentOut]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _customer_out(c: Customer) -> CustomerOut:
    assert c.id is not None
    return CustomerOut(
        id=c.id,
        name=c.name,
        phone=c.phone,
        address=c.address,
        state=c.state,
        state_code=c.state_code,
        gstin=c.gstin,
        date_of_request=c.date_of_request or "",
        actual_date_of_bore=c.actual_date_of_bore or "",
        bore_type=c.bore_type,
        created_at=c.created_at,
    )


def _payment_out(p: Payment) -> PaymentOut:
    assert p.id is not None
    return PaymentOut(
        id=p.id,
        bill_id=p.bill_id,
        amount=p.amount,
        paid_at=p.paid_at,
        mode=p.mode,
        note=p.note,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _paid_total_for_bill(session: Session, bill_id: int) -> float:
    total = session.exec(
        select(func.coalesce(func.sum(Payment.amount), 0.0)).where(
            Payment.bill_id == bill_id
        )
    ).one()
    # sqlmodel returns raw scalar for aggregates; be defensive.
    if isinstance(total, tuple):
        total = total[0]
    return float(total or 0.0)


def _bill_summary(session: Session, bill: Bill) -> BillSummary:
    assert bill.id is not None
    paid = _paid_total_for_bill(session, bill.id)
    return BillSummary(
        id=bill.id,
        invoice_number=bill.invoice_number,
        invoice_date=bill.invoice_date,
        job_type=bill.job_type,
        depth=bill.depth,
        grand_total=round(bill.grand_total, 2),
        paid_total=round(paid, 2),
        outstanding=round(bill.grand_total - paid, 2),
    )


def _get_customer_or_404(session: Session, customer_id: int) -> Customer:
    customer = session.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    return customer


def _get_bill_or_404(session: Session, bill_id: int) -> Bill:
    bill = session.get(Bill, bill_id)
    if bill is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Bill not found"
        )
    return bill


def _get_payment_or_404(session: Session, payment_id: int) -> Payment:
    payment = session.get(Payment, payment_id)
    if payment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Payment not found"
        )
    return payment


# ---------------------------------------------------------------------------
# Customer endpoints
# ---------------------------------------------------------------------------


@router.get("/api/customers/search", response_model=List[CustomerOut])
def search_customers(
    q: str = "",
    limit: int = 20,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> List[CustomerOut]:
    """Search customers by name or phone substring.

    Blank ``q`` lists the most recent customers (up to ``limit``).
    """
    limit = max(1, min(limit, 100))
    stmt = select(Customer)
    q = q.strip()
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Customer.name.like(like)) | (Customer.phone.like(like)))  # type: ignore[attr-defined]
    stmt = stmt.order_by(Customer.created_at.desc()).limit(limit)  # type: ignore[attr-defined]
    return [_customer_out(c) for c in session.exec(stmt).all()]


@router.get("/api/customers", response_model=List[CustomerOut])
def list_customers(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> List[CustomerOut]:
    """List all customers ordered by most recent request first.

    Powers the Customers management page (CRUD list view).
    """
    stmt = select(Customer).order_by(Customer.date_of_request.desc(), Customer.created_at.desc())  # type: ignore[attr-defined]
    return [_customer_out(c) for c in session.exec(stmt).all()]


@router.post(
    "/api/customers",
    response_model=CustomerOut,
    status_code=status.HTTP_201_CREATED,
)
def create_customer(
    payload: CustomerCreate,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CustomerOut:
    existing = session.exec(
        select(Customer).where(Customer.phone == payload.phone)
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Customer with phone {payload.phone} already exists",
        )
    customer = Customer(
        name=payload.name,
        phone=payload.phone,
        address=payload.address,
        state=payload.state,
        state_code=payload.state_code,
        gstin=payload.gstin,
        date_of_request=payload.date_of_request or date.today().isoformat(),
        actual_date_of_bore=payload.actual_date_of_bore or "",
        bore_type=payload.bore_type,
    )
    session.add(customer)
    session.commit()
    session.refresh(customer)
    return _customer_out(customer)


@router.get("/api/customers/{customer_id}", response_model=CustomerWithBills)
def get_customer(
    customer_id: int,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CustomerWithBills:
    customer = _get_customer_or_404(session, customer_id)
    bills = session.exec(
        select(Bill)
        .where(Bill.customer_id == customer_id)
        .order_by(Bill.created_at.desc())  # type: ignore[attr-defined]
    ).all()
    summaries = [_bill_summary(session, b) for b in bills]
    total_billed = round(sum(s.grand_total for s in summaries), 2)
    total_paid = round(sum(s.paid_total for s in summaries), 2)
    total_outstanding = round(total_billed - total_paid, 2)
    return CustomerWithBills(
        customer=_customer_out(customer),
        bills=summaries,
        total_billed=total_billed,
        total_paid=total_paid,
        total_outstanding=total_outstanding,
    )


@router.put("/api/customers/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> CustomerOut:
    customer = _get_customer_or_404(session, customer_id)
    if payload.phone != customer.phone:
        clash = session.exec(
            select(Customer).where(Customer.phone == payload.phone)
        ).first()
        if clash is not None and clash.id != customer.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Another customer already uses phone {payload.phone}",
            )
    customer.name = payload.name
    customer.phone = payload.phone
    customer.address = payload.address
    customer.state = payload.state
    customer.state_code = payload.state_code
    customer.gstin = payload.gstin
    customer.date_of_request = payload.date_of_request or customer.date_of_request or date.today().isoformat()
    customer.actual_date_of_bore = payload.actual_date_of_bore or ""
    customer.bore_type = payload.bore_type
    session.add(customer)
    session.commit()
    session.refresh(customer)
    return _customer_out(customer)


# ---------------------------------------------------------------------------
# Bill + payment endpoints
# ---------------------------------------------------------------------------


@router.get("/api/bills/{bill_id}", response_model=BillWithPayments)
def get_bill(
    bill_id: int,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> BillWithPayments:
    bill = _get_bill_or_404(session, bill_id)
    customer = _get_customer_or_404(session, bill.customer_id)
    payments = session.exec(
        select(Payment)
        .where(Payment.bill_id == bill_id)
        .order_by(Payment.paid_at.desc(), Payment.created_at.desc())  # type: ignore[attr-defined]
    ).all()
    return BillWithPayments(
        bill=_bill_summary(session, bill),
        customer=_customer_out(customer),
        payments=[_payment_out(p) for p in payments],
    )


@router.post(
    "/api/bills/{bill_id}/payments",
    response_model=PaymentOut,
    status_code=status.HTTP_201_CREATED,
)
def add_payment(
    bill_id: int,
    payload: PaymentCreate,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> PaymentOut:
    bill = _get_bill_or_404(session, bill_id)
    paid_so_far = _paid_total_for_bill(session, bill_id)
    outstanding = round(bill.grand_total - paid_so_far, 2)
    if payload.amount > outstanding + 0.01:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Payment amount ₹{payload.amount:.2f} exceeds outstanding "
                f"balance ₹{outstanding:.2f} for this bill"
            ),
        )
    paid_at = payload.paid_at or date.today().isoformat()
    payment = Payment(
        bill_id=bill_id,
        amount=payload.amount,
        paid_at=paid_at,
        mode=payload.mode,
        note=(payload.note.strip() if payload.note else None) or None,
    )
    session.add(payment)
    session.commit()
    session.refresh(payment)
    return _payment_out(payment)


@router.put("/api/payments/{payment_id}", response_model=PaymentOut)
def update_payment(
    payment_id: int,
    payload: PaymentUpdate,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> PaymentOut:
    payment = _get_payment_or_404(session, payment_id)
    bill = _get_bill_or_404(session, payment.bill_id)
    other_paid = _paid_total_for_bill(session, bill.id) - payment.amount  # type: ignore[arg-type]
    outstanding_excluding_self = round(bill.grand_total - other_paid, 2)
    if payload.amount > outstanding_excluding_self + 0.01:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Updated amount ₹{payload.amount:.2f} would exceed the bill's "
                f"outstanding balance ₹{outstanding_excluding_self:.2f}"
            ),
        )
    payment.amount = payload.amount
    payment.paid_at = payload.paid_at or date.today().isoformat()
    payment.mode = payload.mode
    payment.note = (payload.note.strip() if payload.note else None) or None
    payment.updated_at = datetime.now(timezone.utc)
    session.add(payment)
    session.commit()
    session.refresh(payment)
    return _payment_out(payment)


@router.delete("/api/payments/{payment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment(
    payment_id: int,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Response:
    payment = _get_payment_or_404(session, payment_id)
    session.delete(payment)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
