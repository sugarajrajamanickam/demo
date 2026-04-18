"""Quotation (draft estimate) generation for SVLS Rig Service.

A quotation is a lightweight, non-binding price estimate shared with
customers during the enquiry stage — deliberately simpler than a tax
invoice:

* Only ``customer_name`` and ``customer_phone`` are required.
* Amounts are shown **pre-tax**; a note reads ``GST extra at 18%``.
* No CGST/SGST/IGST split, no Rule 46 compliance block, no authorised
  signatory.
* A validity window (days, admin-configurable via ``QuotationSettings``)
  is rendered as an explicit "Valid until" date.

The drilling/re-bore/casing breakdown itself reuses the same cost
computation pipeline as the tax invoice so quotes and invoices stay
consistent for the same inputs.
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime, timedelta, timezone
from typing import List
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
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
from sqlmodel import Session

from .auth import get_current_user
from .billing import (
    FONT_BOLD,
    FONT_REGULAR,
    GST_RATE_PERCENT,
    HSN_SAC_CODE,
    SUPPLIER,
    BillLineItem,
    _format_inr,
)
from .db import get_session
from .models import JobType, User
from .rates import (
    MAX_DEPTH_FT,
    _get_casing_prices,
    _get_quotation_settings,
    _get_rebore_price,
    _list_ranges,
    compute_cost,
)


router = APIRouter(tags=["quotation"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


_PHONE_RE = re.compile(r"^\+?[0-9\- ]{7,20}$")


class QuotationRequest(BaseModel):
    """Payload the UI sends to generate a quotation preview or PDF."""

    depth: float = Field(..., ge=0, le=MAX_DEPTH_FT)
    job_type: JobType = Field(default=JobType.NEW_BORE)
    casing_7_pieces: int = Field(default=0, ge=0, le=10_000)
    casing_10_pieces: int = Field(default=0, ge=0, le=10_000)
    customer_name: str = Field(..., min_length=1, max_length=120)
    customer_phone: str = Field(..., min_length=7, max_length=20)

    @field_validator("customer_name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Customer name is required")
        return v

    @field_validator("customer_phone")
    @classmethod
    def _validate_phone(cls, v: str) -> str:
        v = v.strip()
        if not _PHONE_RE.match(v):
            raise ValueError(
                "Phone must be 7–20 digits; optional leading + and spaces/dashes allowed"
            )
        return v


class QuotationPreview(BaseModel):
    """JSON preview of a quotation, consumed by the frontend."""

    quotation_number: str
    quotation_date: str  # ISO yyyy-mm-dd
    valid_until: str  # ISO yyyy-mm-dd
    validity_days: int

    supplier_name: str
    supplier_address_lines: List[str]
    supplier_state: str
    supplier_state_code: str
    supplier_phone: str
    supplier_email: str

    customer_name: str
    customer_phone: str

    job_type: JobType
    depth: float

    line_items: List[BillLineItem]
    subtotal: float  # pre-tax total across all line items (drilling + casing)
    gst_rate_percent: float
    gst_note: str  # e.g. "GST extra at 18%"


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _make_quotation_number(now: datetime) -> str:
    return f"SVLS-Q/{now.strftime('%Y%m%d')}/{now.strftime('%H%M%S')}"


def build_quotation_preview(
    req: QuotationRequest, session: Session, *, now: datetime | None = None
) -> QuotationPreview:
    now = now or datetime.now(timezone.utc).astimezone()

    prices = _get_casing_prices(session)
    rebore = _get_rebore_price(session)
    settings = _get_quotation_settings(session)

    try:
        breakdown = compute_cost(
            _list_ranges(session),
            req.depth,
            req.casing_7_pieces if req.job_type == JobType.NEW_BORE else 0,
            req.casing_10_pieces if req.job_type == JobType.NEW_BORE else 0,
            prices.price_7in,
            prices.price_10in,
            job_type=req.job_type,
            rebore_price_per_foot=rebore.price_per_foot,
        )
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)
        ) from err

    service_desc = (
        "Borewell drilling services"
        if breakdown.job_type == JobType.NEW_BORE
        else "Borewell re-bore services"
    )

    line_items: List[BillLineItem] = []
    if breakdown.job_type == JobType.RE_BORE:
        if breakdown.amount > 0:
            line_items.append(
                BillLineItem(
                    description=(
                        f"{service_desc} \u2014 depth {breakdown.depth:g} ft "
                        f"(flat rate)"
                    ),
                    hsn_sac=HSN_SAC_CODE,
                    qty=float(breakdown.depth),
                    qty_unit="ft",
                    rate=float(breakdown.rebore_price_per_foot),
                    amount=round(breakdown.amount, 2),
                    is_taxable=True,
                )
            )
    else:
        for s in breakdown.slices:
            line_items.append(
                BillLineItem(
                    description=(
                        f"{service_desc} \u2014 {s.start_ft}\u2013{s.end_ft} ft"
                    ),
                    hsn_sac=HSN_SAC_CODE,
                    qty=float(s.feet),
                    qty_unit="ft",
                    rate=float(s.rate_per_ft),
                    amount=round(float(s.cost), 2),
                    is_taxable=True,
                )
            )
        if breakdown.casing_7_pieces > 0 and breakdown.casing_7_amount > 0:
            line_items.append(
                BillLineItem(
                    description='Casing 7" (per piece)',
                    hsn_sac="",
                    qty=float(breakdown.casing_7_pieces),
                    qty_unit="pc",
                    rate=float(breakdown.casing_7_price_per_piece),
                    amount=round(breakdown.casing_7_amount, 2),
                    is_taxable=False,
                )
            )
        if breakdown.casing_10_pieces > 0 and breakdown.casing_10_amount > 0:
            line_items.append(
                BillLineItem(
                    description='Casing 10" (per piece)',
                    hsn_sac="",
                    qty=float(breakdown.casing_10_pieces),
                    qty_unit="pc",
                    rate=float(breakdown.casing_10_price_per_piece),
                    amount=round(breakdown.casing_10_amount, 2),
                    is_taxable=False,
                )
            )

    subtotal = round(sum(item.amount for item in line_items), 2)
    quotation_date: date = now.date()
    valid_until: date = quotation_date + timedelta(days=settings.validity_days)

    return QuotationPreview(
        quotation_number=_make_quotation_number(now),
        quotation_date=quotation_date.isoformat(),
        valid_until=valid_until.isoformat(),
        validity_days=settings.validity_days,
        supplier_name=SUPPLIER.name,
        supplier_address_lines=list(SUPPLIER.address_lines),
        supplier_state=SUPPLIER.state,
        supplier_state_code=SUPPLIER.state_code,
        supplier_phone=SUPPLIER.phone,
        supplier_email=SUPPLIER.email,
        customer_name=req.customer_name,
        customer_phone=req.customer_phone,
        job_type=breakdown.job_type,
        depth=breakdown.depth,
        line_items=line_items,
        subtotal=subtotal,
        gst_rate_percent=GST_RATE_PERCENT,
        gst_note=f"GST extra at {GST_RATE_PERCENT:g}%",
    )


# ---------------------------------------------------------------------------
# PDF rendering
# ---------------------------------------------------------------------------


def render_quotation_pdf(preview: QuotationPreview) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=f"Quotation {preview.quotation_number}",
        author=preview.supplier_name,
    )

    styles = getSampleStyleSheet()
    base = styles["BodyText"]
    title_style = ParagraphStyle(
        "QuoteTitle",
        parent=base,
        fontName=FONT_BOLD,
        fontSize=16,
        alignment=1,  # centre
        spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        "QuoteSubtitle",
        parent=base,
        fontName=FONT_REGULAR,
        fontSize=9,
        textColor=colors.grey,
        alignment=1,
        spaceAfter=8,
    )
    small = ParagraphStyle(
        "Small", parent=base, fontName=FONT_REGULAR, fontSize=9, leading=11
    )
    small_bold = ParagraphStyle("SmallBold", parent=small, fontName=FONT_BOLD)

    def esc(value: str | None) -> str:
        return _xml_escape(value) if value else ""

    story: List = []
    story.append(Paragraph("QUOTATION", title_style))
    story.append(
        Paragraph(
            "This is not a tax invoice — prices shown are estimates for enquiry purposes.",
            subtitle_style,
        )
    )

    # Supplier + quotation meta (two-column header)
    supplier_block = [
        Paragraph(f"<b>{preview.supplier_name}</b>", small_bold),
        *[Paragraph(line, small) for line in preview.supplier_address_lines],
        Paragraph(
            f"State: {preview.supplier_state} (Code {preview.supplier_state_code})",
            small,
        ),
        Paragraph(
            f"Phone: {preview.supplier_phone} · Email: {preview.supplier_email}",
            small,
        ),
    ]
    meta_block = [
        Paragraph(f"<b>Quotation No:</b> {preview.quotation_number}", small),
        Paragraph(f"<b>Quotation Date:</b> {preview.quotation_date}", small),
        Paragraph(
            f"<b>Valid Until:</b> {preview.valid_until} "
            f"({preview.validity_days} days)",
            small,
        ),
    ]
    header = Table(
        [[supplier_block, meta_block]], colWidths=[110 * mm, 70 * mm]
    )
    header.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    story.append(header)
    story.append(Spacer(1, 6))

    # Bill-to block: minimal — only name + phone (quotation is lightweight).
    billto_rows: List = [[Paragraph("<b>Quotation For</b>", small_bold)]]
    billto_rows.append([Paragraph(esc(preview.customer_name), small_bold)])
    billto_rows.append(
        [Paragraph(f"Phone: {esc(preview.customer_phone)}", small)]
    )
    billto = Table(billto_rows, colWidths=[180 * mm])
    billto.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ("BACKGROUND", (0, 0), (0, 0), colors.whitesmoke),
            ]
        )
    )
    story.append(billto)
    story.append(Spacer(1, 8))

    header_row = [
        "#",
        "Description",
        "HSN/SAC",
        "Qty",
        "Rate",
        "Amount",
    ]
    data: List[List] = [header_row]
    for idx, item in enumerate(preview.line_items, start=1):
        data.append(
            [
                str(idx),
                Paragraph(_xml_escape(item.description), small),
                item.hsn_sac or "—",
                f"{item.qty:g} {item.qty_unit}",
                _format_inr(item.rate),
                _format_inr(item.amount),
            ]
        )

    item_row_count = len(preview.line_items)
    data.append(
        [
            "",
            "",
            "",
            "",
            Paragraph("<b>Subtotal (pre-tax)</b>", small),
            Paragraph(f"<b>{_format_inr(preview.subtotal)}</b>", small),
        ]
    )
    data.append(
        [
            "",
            "",
            "",
            "",
            Paragraph(f"<i>{preview.gst_note}</i>", small),
            Paragraph("<i>Extra</i>", small),
        ]
    )

    col_widths = [
        8 * mm,
        72 * mm,
        20 * mm,
        22 * mm,
        28 * mm,
        30 * mm,
    ]
    items_table = Table(data, colWidths=col_widths, repeatRows=1)
    last_row_index = len(data) - 1
    items_table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), FONT_BOLD, 9),
                ("FONT", (0, 1), (-1, -1), FONT_REGULAR, 9),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("FONTSIZE", (0, 1), (-1, -1), 9),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("ALIGN", (2, 0), (2, -1), "CENTER"),
                ("ALIGN", (3, 0), (5, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("GRID", (0, 0), (-1, item_row_count), 0.25, colors.grey),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                (
                    "LINEABOVE",
                    (4, item_row_count + 1),
                    (-1, item_row_count + 1),
                    0.75,
                    colors.black,
                ),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    _ = last_row_index  # explicit to make reviewers happy — kept for parity
    story.append(items_table)
    story.append(Spacer(1, 10))

    notes_lines = [
        f"• Prices shown are estimates in INR and are exclusive of GST. "
        f"{preview.gst_note} will be added on the final tax invoice.",
        f"• This quotation is valid for {preview.validity_days} days from the "
        f"quotation date (until {preview.valid_until}).",
        "• Final invoice details, taxes, and totals will be confirmed before "
        "work commences.",
        "• This document is for enquiry purposes only and does not constitute "
        "a tax invoice.",
    ]
    notes_block = [
        Paragraph("<b>Notes</b>", small_bold),
        *[Paragraph(line, small) for line in notes_lines],
    ]
    notes_table = Table([[blk] for blk in notes_block], colWidths=[180 * mm])
    notes_table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                ("BACKGROUND", (0, 0), (0, 0), colors.whitesmoke),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(notes_table)
    story.append(Spacer(1, 10))
    story.append(
        Paragraph(
            "<i>This is a computer-generated quotation.</i>",
            ParagraphStyle(
                "footnote",
                parent=small,
                fontSize=8,
                textColor=colors.grey,
            ),
        )
    )

    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/api/quotation/preview", response_model=QuotationPreview)
def preview_quotation(
    payload: QuotationRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> QuotationPreview:
    """Return the computed quotation in JSON form so the UI can preview it."""
    return build_quotation_preview(payload, session)


@router.post("/api/quotation/pdf")
def download_quotation(
    payload: QuotationRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Response:
    """Return the same quotation as a downloadable PDF."""
    preview = build_quotation_preview(payload, session)
    pdf_bytes = render_quotation_pdf(preview)
    safe_id = preview.quotation_number.replace("/", "-")
    filename = f"{safe_id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Quotation-Number": preview.quotation_number,
        },
    )
