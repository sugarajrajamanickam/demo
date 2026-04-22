"""Dashboard: customer payment status + per-customer statement PDF.

Powers the Dashboard page in the SPA. Provides:

* ``GET /api/dashboard/customers`` — filtered + searched list of
  customers with rolled-up billing and payment totals. Supports:

  - ``q``: single search term matched against customer name, phone,
    or invoice number (case-insensitive substring).
  - ``status``: ``all``, ``paid``, ``partial``, ``unpaid``.
  - ``bill_from``, ``bill_to``: restrict which bills are included.
  - ``payment_from``, ``payment_to``: restrict which payments are
    counted.

* ``GET /api/dashboard/customers/{id}/statement.pdf`` — A4 PDF
  statement listing a customer's bills + payments. Date ranges from
  the query string are honoured so the statement mirrors what the
  dashboard just showed.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import List, Optional
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy import func, or_
from sqlmodel import Session, select

from .auth import get_current_user
from .billing import (
    FONT_BOLD,
    FONT_REGULAR,
    SUPPLIER,
    _format_inr,
    amount_in_words_inr,
)
from .db import get_session
from .models import Bill, Customer, Payment, User


router = APIRouter(tags=["dashboard"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


PaymentStatus = str  # "paid" | "partial" | "unpaid" | "no_bills"


class DashboardBill(BaseModel):
    id: int
    invoice_number: str
    invoice_date: str
    job_type: str
    depth: float
    grand_total: float
    paid_total: float
    outstanding: float


class DashboardPayment(BaseModel):
    id: int
    bill_id: int
    invoice_number: str
    amount: float
    paid_at: str
    mode: str
    note: Optional[str]


class DashboardCustomerRow(BaseModel):
    customer_id: int
    name: str
    phone: str
    total_billed: float
    total_paid: float
    outstanding: float
    bill_count: int
    payment_count: int
    status: PaymentStatus
    # Latest activity — max of customer creation, any in-window bill date,
    # any in-window payment date. ISO yyyy-mm-dd. Drives the "oldest first"
    # sort and the "Last updated" column.
    last_activity_at: str
    # Bills that match the search/date filters (used to drive the details panel).
    bills: List[DashboardBill]


class DashboardResponse(BaseModel):
    customers: List[DashboardCustomerRow]
    total_customers: int
    # Overall roll-up across ALL filtered customers (not just the current page).
    total_billed: float
    total_paid: float
    total_outstanding: float
    limit: int
    offset: int


class StatementCustomer(BaseModel):
    id: int
    name: str
    phone: str
    address: Optional[str] = None
    state: Optional[str] = None
    gstin: Optional[str] = None


class StatementBill(BaseModel):
    id: int
    invoice_number: str
    invoice_date: str
    job_type: str
    depth: float
    casing_7_pieces: int
    casing_10_pieces: int
    taxable_value: float
    total_tax: float
    non_taxable_total: float
    grand_total: float
    paid_total: float
    outstanding: float


class StatementPayment(BaseModel):
    id: int
    bill_id: int
    invoice_number: str
    amount: float
    paid_at: str
    mode: str
    note: Optional[str] = None


class StatementResponse(BaseModel):
    customer: StatementCustomer
    bills: List[StatementBill]
    payments: List[StatementPayment]
    total_billed: float
    total_paid: float
    outstanding: float
    generated_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_date(value: Optional[str], field: str) -> Optional[str]:
    if value is None or value == "":
        return None
    try:
        date.fromisoformat(value)
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} must be an ISO date (yyyy-mm-dd)",
        ) from err
    return value


def _compute_status(total_billed: float, total_paid: float, bill_count: int) -> PaymentStatus:
    # Tolerate tiny float rounding (<= 1 paisa).
    eps = 0.01
    if bill_count == 0:
        return "no_bills"
    if total_paid <= eps:
        return "unpaid"
    if total_paid + eps >= total_billed:
        return "paid"
    return "partial"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/api/dashboard/customers", response_model=DashboardResponse)
def list_dashboard_customers(
    q: str = "",
    status_filter: str = Query("all", alias="status"),
    bill_from: Optional[str] = None,
    bill_to: Optional[str] = None,
    payment_from: Optional[str] = None,
    payment_to: Optional[str] = None,
    limit: int = Query(10, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> DashboardResponse:
    status_filter = (status_filter or "all").lower()
    if status_filter not in {"all", "paid", "partial", "unpaid"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="status must be one of all, paid, partial, unpaid",
        )

    bill_from = _parse_date(bill_from, "bill_from")
    bill_to = _parse_date(bill_to, "bill_to")
    payment_from = _parse_date(payment_from, "payment_from")
    payment_to = _parse_date(payment_to, "payment_to")

    q_clean = (q or "").strip()

    # Step 1: if the user typed a search, find matching customer IDs either
    # by customer name/phone OR by invoice number of a bill they own.
    matched_customer_ids: Optional[set[int]] = None
    if q_clean:
        like = f"%{q_clean}%"
        by_customer = session.exec(
            select(Customer.id).where(
                or_(
                    Customer.name.ilike(like),  # type: ignore[attr-defined]
                    Customer.phone.ilike(like),  # type: ignore[attr-defined]
                )
            )
        ).all()
        by_invoice = session.exec(
            select(Bill.customer_id).where(
                Bill.invoice_number.ilike(like)  # type: ignore[attr-defined]
            )
        ).all()
        matched_customer_ids = set(by_customer) | set(by_invoice)
        if not matched_customer_ids:
            return DashboardResponse(
                customers=[],
                total_customers=0,
                total_billed=0.0,
                total_paid=0.0,
                total_outstanding=0.0,
                limit=limit,
                offset=offset,
            )

    # Step 2: load all customers (optionally narrowed by search).
    cust_stmt = select(Customer)
    if matched_customer_ids is not None:
        cust_stmt = cust_stmt.where(Customer.id.in_(matched_customer_ids))  # type: ignore[attr-defined]
    cust_stmt = cust_stmt.order_by(Customer.name.asc())  # type: ignore[attr-defined]
    customers = session.exec(cust_stmt).all()
    if not customers:
        return DashboardResponse(
            customers=[],
            total_customers=0,
            total_billed=0.0,
            total_paid=0.0,
            total_outstanding=0.0,
            limit=limit,
            offset=offset,
        )

    customer_ids = [c.id for c in customers if c.id is not None]

    # Step 3: load bills for these customers within the bill-date range.
    bill_stmt = select(Bill).where(Bill.customer_id.in_(customer_ids))  # type: ignore[attr-defined]
    if bill_from:
        bill_stmt = bill_stmt.where(Bill.invoice_date >= bill_from)
    if bill_to:
        bill_stmt = bill_stmt.where(Bill.invoice_date <= bill_to)
    bill_stmt = bill_stmt.order_by(Bill.invoice_date.desc())  # type: ignore[attr-defined]
    bills = session.exec(bill_stmt).all()

    bills_by_customer: dict[int, list[Bill]] = {}
    bill_ids: list[int] = []
    for b in bills:
        if b.id is None:
            continue
        bills_by_customer.setdefault(b.customer_id, []).append(b)
        bill_ids.append(b.id)

    # Step 4: sum payments per bill within the payment-date range.
    paid_by_bill: dict[int, float] = {}
    max_payment_date_by_bill: dict[int, str] = {}
    if bill_ids:
        pay_stmt = select(Payment.bill_id, func.coalesce(func.sum(Payment.amount), 0.0)).where(
            Payment.bill_id.in_(bill_ids)  # type: ignore[attr-defined]
        )
        if payment_from:
            pay_stmt = pay_stmt.where(Payment.paid_at >= payment_from)
        if payment_to:
            pay_stmt = pay_stmt.where(Payment.paid_at <= payment_to)
        pay_stmt = pay_stmt.group_by(Payment.bill_id)
        for bill_id, total in session.exec(pay_stmt).all():
            paid_by_bill[bill_id] = float(total or 0.0)

        # Also count payments per bill for display.
        count_stmt = select(Payment.bill_id, func.count(Payment.id)).where(
            Payment.bill_id.in_(bill_ids)  # type: ignore[attr-defined]
        )
        if payment_from:
            count_stmt = count_stmt.where(Payment.paid_at >= payment_from)
        if payment_to:
            count_stmt = count_stmt.where(Payment.paid_at <= payment_to)
        count_stmt = count_stmt.group_by(Payment.bill_id)
        payment_count_by_bill: dict[int, int] = {
            bid: int(n or 0) for bid, n in session.exec(count_stmt).all()
        }

        # Latest in-window payment date per bill (drives last_activity_at).
        max_stmt = select(Payment.bill_id, func.max(Payment.paid_at)).where(
            Payment.bill_id.in_(bill_ids)  # type: ignore[attr-defined]
        )
        if payment_from:
            max_stmt = max_stmt.where(Payment.paid_at >= payment_from)
        if payment_to:
            max_stmt = max_stmt.where(Payment.paid_at <= payment_to)
        max_stmt = max_stmt.group_by(Payment.bill_id)
        for bid, max_paid_at in session.exec(max_stmt).all():
            if max_paid_at:
                max_payment_date_by_bill[bid] = str(max_paid_at)
    else:
        payment_count_by_bill = {}

    # Step 5: assemble rows + apply status filter.
    rows: List[DashboardCustomerRow] = []
    for c in customers:
        assert c.id is not None
        customer_bills = bills_by_customer.get(c.id, [])
        total_billed = 0.0
        total_paid = 0.0
        payment_count = 0
        dash_bills: List[DashboardBill] = []
        latest_bill_date: Optional[str] = None
        latest_payment_date: Optional[str] = None
        for b in customer_bills:
            assert b.id is not None
            paid = paid_by_bill.get(b.id, 0.0)
            outstanding = round(b.grand_total - paid, 2)
            total_billed += b.grand_total
            total_paid += paid
            payment_count += payment_count_by_bill.get(b.id, 0)
            if latest_bill_date is None or b.invoice_date > latest_bill_date:
                latest_bill_date = b.invoice_date
            max_pay = max_payment_date_by_bill.get(b.id)
            if max_pay and (latest_payment_date is None or max_pay > latest_payment_date):
                latest_payment_date = max_pay
            dash_bills.append(
                DashboardBill(
                    id=b.id,
                    invoice_number=b.invoice_number,
                    invoice_date=b.invoice_date,
                    job_type=b.job_type,
                    depth=b.depth,
                    grand_total=round(b.grand_total, 2),
                    paid_total=round(paid, 2),
                    outstanding=outstanding,
                )
            )

        total_billed = round(total_billed, 2)
        total_paid = round(total_paid, 2)
        outstanding = round(total_billed - total_paid, 2)
        row_status = _compute_status(total_billed, total_paid, len(customer_bills))

        # Hide customers with no bills in the selected bill-date window
        # unless the user is asking for "all" and there's also no search —
        # in that case still show them so empty customers are visible.
        if len(customer_bills) == 0 and (
            bill_from or bill_to or status_filter != "all"
        ):
            continue

        if status_filter != "all" and row_status != status_filter:
            continue

        # last_activity_at = latest of customer creation, in-window bill, in-window payment.
        candidates = [c.created_at.date().isoformat()]
        if latest_bill_date:
            candidates.append(latest_bill_date)
        if latest_payment_date:
            candidates.append(latest_payment_date)
        last_activity_at = max(candidates)

        rows.append(
            DashboardCustomerRow(
                customer_id=c.id,
                name=c.name,
                phone=c.phone,
                total_billed=total_billed,
                total_paid=total_paid,
                outstanding=outstanding,
                bill_count=len(customer_bills),
                payment_count=payment_count,
                status=row_status,
                last_activity_at=last_activity_at,
                bills=dash_bills,
            )
        )

    # Sort oldest-first by last_activity_at; ties broken by name for stability.
    rows.sort(key=lambda r: (r.last_activity_at, r.name.lower()))
    total_customers = len(rows)
    # Roll-ups across all filtered rows (not just the current page) so the
    # dashboard summary bar stays accurate as the user pages through results.
    overall_billed = round(sum(r.total_billed for r in rows), 2)
    overall_paid = round(sum(r.total_paid for r in rows), 2)
    overall_outstanding = round(sum(r.outstanding for r in rows), 2)
    paginated = rows[offset : offset + limit]

    return DashboardResponse(
        customers=paginated,
        total_customers=total_customers,
        total_billed=overall_billed,
        total_paid=overall_paid,
        total_outstanding=overall_outstanding,
        limit=limit,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# Statement PDF
# ---------------------------------------------------------------------------


@dataclass
class _StatementBillRow:
    bill: Bill
    paid: float
    payments: List[Payment]


def _load_statement(
    session: Session,
    customer_id: int,
    *,
    bill_from: Optional[str],
    bill_to: Optional[str],
    payment_from: Optional[str],
    payment_to: Optional[str],
) -> tuple[Customer, List[_StatementBillRow]]:
    customer = session.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found",
        )

    bill_stmt = select(Bill).where(Bill.customer_id == customer_id)
    if bill_from:
        bill_stmt = bill_stmt.where(Bill.invoice_date >= bill_from)
    if bill_to:
        bill_stmt = bill_stmt.where(Bill.invoice_date <= bill_to)
    bill_stmt = bill_stmt.order_by(Bill.invoice_date.asc(), Bill.id.asc())  # type: ignore[attr-defined]
    bills = session.exec(bill_stmt).all()

    rows: List[_StatementBillRow] = []
    for b in bills:
        assert b.id is not None
        pay_stmt = select(Payment).where(Payment.bill_id == b.id)
        if payment_from:
            pay_stmt = pay_stmt.where(Payment.paid_at >= payment_from)
        if payment_to:
            pay_stmt = pay_stmt.where(Payment.paid_at <= payment_to)
        pay_stmt = pay_stmt.order_by(Payment.paid_at.asc(), Payment.id.asc())  # type: ignore[attr-defined]
        payments = session.exec(pay_stmt).all()
        paid = sum(p.amount for p in payments)
        rows.append(_StatementBillRow(bill=b, paid=paid, payments=list(payments)))

    return customer, rows


def _render_statement_pdf(
    customer: Customer,
    rows: List[_StatementBillRow],
    *,
    bill_from: Optional[str],
    bill_to: Optional[str],
    payment_from: Optional[str],
    payment_to: Optional[str],
) -> bytes:
    buf = io.BytesIO()
    now = datetime.now(timezone.utc).astimezone()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=f"Statement — {customer.name}",
        author=SUPPLIER.name,
    )

    styles = getSampleStyleSheet()
    base = styles["BodyText"]
    title_style = ParagraphStyle(
        "StmtTitle", parent=base, fontName=FONT_BOLD, fontSize=16,
        alignment=1, spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        "StmtSubtitle", parent=base, fontName=FONT_REGULAR, fontSize=9,
        alignment=1, textColor=colors.grey, spaceAfter=8,
    )
    small = ParagraphStyle(
        "Small", parent=base, fontName=FONT_REGULAR, fontSize=9, leading=11,
    )
    small_bold = ParagraphStyle("SmallBold", parent=small, fontName=FONT_BOLD)
    section_heading = ParagraphStyle(
        "SectionHeading", parent=small_bold, fontSize=11, spaceBefore=6, spaceAfter=4,
    )

    def esc(value: str | None) -> str:
        return _xml_escape(value) if value else ""

    story: List = []
    story.append(Paragraph("CUSTOMER STATEMENT", title_style))
    story.append(
        Paragraph(
            f"Issued by {esc(SUPPLIER.name)} on {now.strftime('%Y-%m-%d %H:%M')}",
            subtitle_style,
        )
    )

    # Header: supplier vs customer block
    supplier_block = [
        Paragraph(f"<b>{esc(SUPPLIER.name)}</b>", small_bold),
        *[Paragraph(line, small) for line in SUPPLIER.address_lines],
        Paragraph(f"GSTIN: <b>{SUPPLIER.gstin}</b>", small),
        Paragraph(
            f"Phone: {SUPPLIER.phone} · Email: {SUPPLIER.email}", small,
        ),
    ]
    customer_lines = [
        Paragraph("<b>Customer</b>", small_bold),
        Paragraph(f"<b>{esc(customer.name)}</b>", small_bold),
        Paragraph(f"Phone: {esc(customer.phone)}", small),
    ]
    if customer.address:
        customer_lines.append(Paragraph(esc(customer.address), small))
    if customer.gstin:
        customer_lines.append(Paragraph(f"GSTIN: {esc(customer.gstin)}", small))
    header = Table(
        [[supplier_block, customer_lines]],
        colWidths=[110 * mm, 70 * mm],
    )
    header.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.grey),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(header)
    story.append(Spacer(1, 6))

    # Filters applied (if any)
    filter_bits: List[str] = []
    if bill_from or bill_to:
        filter_bits.append(
            f"Bill date: {bill_from or '—'} to {bill_to or '—'}"
        )
    if payment_from or payment_to:
        filter_bits.append(
            f"Payment date: {payment_from or '—'} to {payment_to or '—'}"
        )
    if filter_bits:
        story.append(
            Paragraph(
                "<b>Filters:</b> " + " · ".join(esc(f) for f in filter_bits),
                small,
            )
        )
        story.append(Spacer(1, 4))

    # Bills table
    story.append(Paragraph("Bills", section_heading))
    if rows:
        bill_header = [
            "#",
            "Invoice #",
            "Date",
            "Job",
            "Depth (ft)",
            "Total",
            "Paid",
            "Outstanding",
        ]
        bill_data = [bill_header]
        total_billed = 0.0
        total_paid = 0.0
        for idx, row in enumerate(rows, start=1):
            b = row.bill
            outstanding = round(b.grand_total - row.paid, 2)
            total_billed += b.grand_total
            total_paid += row.paid
            bill_data.append(
                [
                    str(idx),
                    b.invoice_number,
                    b.invoice_date,
                    "Re-Bore" if b.job_type == "re_bore" else "New Bore",
                    f"{b.depth:g}",
                    _format_inr(b.grand_total),
                    _format_inr(row.paid),
                    _format_inr(outstanding),
                ]
            )
        total_outstanding = round(total_billed - total_paid, 2)
        bill_data.append(
            [
                "",
                "",
                "",
                "",
                Paragraph("<b>Totals</b>", small_bold),
                Paragraph(f"<b>{_format_inr(total_billed)}</b>", small_bold),
                Paragraph(f"<b>{_format_inr(total_paid)}</b>", small_bold),
                Paragraph(f"<b>{_format_inr(total_outstanding)}</b>", small_bold),
            ]
        )
        bills_table = Table(
            bill_data,
            colWidths=[8 * mm, 34 * mm, 20 * mm, 20 * mm, 18 * mm, 26 * mm, 26 * mm, 28 * mm],
            repeatRows=1,
        )
        bills_table.setStyle(
            TableStyle(
                [
                    ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
                    ("FONTNAME", (0, 1), (-1, -1), FONT_REGULAR),
                    ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                    ("ALIGN", (4, 1), (-1, -1), "RIGHT"),
                    ("ALIGN", (0, 1), (0, -1), "CENTER"),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(bills_table)
        story.append(Spacer(1, 6))
        story.append(
            Paragraph(
                f"Total billed: <b>{_format_inr(total_billed)}</b> · "
                f"Total paid: <b>{_format_inr(total_paid)}</b> · "
                f"Outstanding: <b>{_format_inr(total_outstanding)}</b>",
                small,
            )
        )
        story.append(
            Paragraph(
                f"Outstanding in words: {amount_in_words_inr(total_outstanding)}",
                small,
            )
        )
    else:
        story.append(Paragraph("No bills match the selected filters.", small))

    # Payments table
    story.append(Spacer(1, 8))
    story.append(Paragraph("Payments", section_heading))
    payment_rows: List[tuple[Payment, str]] = []
    for row in rows:
        for p in row.payments:
            payment_rows.append((p, row.bill.invoice_number))
    payment_rows.sort(key=lambda t: (t[0].paid_at, t[0].id or 0))
    if payment_rows:
        pay_header = ["#", "Paid on", "Invoice #", "Mode", "Note", "Amount"]
        pay_data = [pay_header]
        total_paid = 0.0
        for idx, (p, inv) in enumerate(payment_rows, start=1):
            total_paid += p.amount
            pay_data.append(
                [
                    str(idx),
                    p.paid_at,
                    inv,
                    p.mode.value if hasattr(p.mode, "value") else str(p.mode),
                    p.note or "",
                    _format_inr(p.amount),
                ]
            )
        pay_data.append(
            [
                "",
                "",
                "",
                "",
                Paragraph("<b>Total paid</b>", small_bold),
                Paragraph(f"<b>{_format_inr(total_paid)}</b>", small_bold),
            ]
        )
        pay_table = Table(
            pay_data,
            colWidths=[8 * mm, 22 * mm, 34 * mm, 22 * mm, 60 * mm, 34 * mm],
            repeatRows=1,
        )
        pay_table.setStyle(
            TableStyle(
                [
                    ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
                    ("FONTNAME", (0, 1), (-1, -1), FONT_REGULAR),
                    ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                    ("ALIGN", (5, 1), (5, -1), "RIGHT"),
                    ("ALIGN", (0, 1), (0, -1), "CENTER"),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(pay_table)
    else:
        story.append(Paragraph("No payments recorded in the selected window.", small))

    doc.build(story)
    return buf.getvalue()


@router.get("/api/dashboard/customers/{customer_id}/statement.pdf")
def download_customer_statement(
    customer_id: int,
    bill_from: Optional[str] = None,
    bill_to: Optional[str] = None,
    payment_from: Optional[str] = None,
    payment_to: Optional[str] = None,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Response:
    bill_from = _parse_date(bill_from, "bill_from")
    bill_to = _parse_date(bill_to, "bill_to")
    payment_from = _parse_date(payment_from, "payment_from")
    payment_to = _parse_date(payment_to, "payment_to")

    customer, rows = _load_statement(
        session,
        customer_id,
        bill_from=bill_from,
        bill_to=bill_to,
        payment_from=payment_from,
        payment_to=payment_to,
    )
    pdf_bytes = _render_statement_pdf(
        customer,
        rows,
        bill_from=bill_from,
        bill_to=bill_to,
        payment_from=payment_from,
        payment_to=payment_to,
    )

    safe_name = "".join(c if c.isalnum() else "_" for c in customer.name).strip("_") or "customer"
    filename = f"statement-{safe_name}-{customer.phone}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Customer-Id": str(customer.id),
        },
    )


@router.get(
    "/api/dashboard/customers/{customer_id}/statement",
    response_model=StatementResponse,
)
def get_customer_statement_json(
    customer_id: int,
    bill_from: Optional[str] = None,
    bill_to: Optional[str] = None,
    payment_from: Optional[str] = None,
    payment_to: Optional[str] = None,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> StatementResponse:
    """JSON version of the statement, rendered in the Dashboard modal."""
    bill_from = _parse_date(bill_from, "bill_from")
    bill_to = _parse_date(bill_to, "bill_to")
    payment_from = _parse_date(payment_from, "payment_from")
    payment_to = _parse_date(payment_to, "payment_to")

    customer, rows = _load_statement(
        session,
        customer_id,
        bill_from=bill_from,
        bill_to=bill_to,
        payment_from=payment_from,
        payment_to=payment_to,
    )

    bills: List[StatementBill] = []
    payments: List[StatementPayment] = []
    total_billed = 0.0
    total_paid = 0.0
    for r in rows:
        b = r.bill
        assert b.id is not None
        outstanding = round(b.grand_total - r.paid, 2)
        total_billed += b.grand_total
        total_paid += r.paid
        bills.append(
            StatementBill(
                id=b.id,
                invoice_number=b.invoice_number,
                invoice_date=b.invoice_date,
                job_type=b.job_type,
                depth=b.depth,
                casing_7_pieces=b.casing_7_pieces,
                casing_10_pieces=b.casing_10_pieces,
                taxable_value=round(b.taxable_value, 2),
                total_tax=round(b.total_tax, 2),
                non_taxable_total=round(b.non_taxable_total, 2),
                grand_total=round(b.grand_total, 2),
                paid_total=round(r.paid, 2),
                outstanding=outstanding,
            )
        )
        for p in r.payments:
            assert p.id is not None
            payments.append(
                StatementPayment(
                    id=p.id,
                    bill_id=b.id,
                    invoice_number=b.invoice_number,
                    amount=p.amount,
                    paid_at=p.paid_at,
                    mode=str(p.mode.value if hasattr(p.mode, "value") else p.mode),
                    note=p.note,
                )
            )

    payments.sort(key=lambda p: (p.paid_at, p.id))
    total_billed = round(total_billed, 2)
    total_paid = round(total_paid, 2)
    outstanding = round(total_billed - total_paid, 2)
    assert customer.id is not None

    return StatementResponse(
        customer=StatementCustomer(
            id=customer.id,
            name=customer.name,
            phone=customer.phone,
            address=customer.address,
            state=customer.state,
            gstin=customer.gstin,
        ),
        bills=bills,
        payments=payments,
        total_billed=total_billed,
        total_paid=total_paid,
        outstanding=outstanding,
        generated_at=datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
    )
