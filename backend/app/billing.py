"""GST-compliant tax-invoice PDF generation for SVLS Rig Service.

Follows the mandatory-field requirements of CGST Rule 46:

* Supplier name, address, GSTIN, state + state code
* Sequential invoice number + issue date
* Recipient name, phone (+ optional GSTIN for registered buyers)
* HSN/SAC code of the service
* Itemised taxable value, rate, amount
* Rate and amount of CGST / SGST (intra-state) or IGST (inter-state)
* Total invoice value in figures and words
* Place of supply, signature of authorised signatory
* Explicit "Tax Invoice" title

Supplier identity is hard-coded in :data:`SUPPLIER` as a placeholder; the
admin UI to edit these details is a follow-up task.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


# ---------------------------------------------------------------------------
# Font registration — reportlab's built-in Helvetica/Type 1 fonts do not
# contain the ₹ (U+20B9) glyph, so rupee amounts render as black boxes in
# the PDF. We register DejaVu Sans (shipped via `fonts-dejavu-core` in the
# Docker image) as the invoice font, and fall back to Helvetica if DejaVu
# is unavailable (e.g. local dev without the apt package installed) so
# development doesn't crash — in that fallback case ₹ will be missing from
# the PDF but all other text still renders.
# ---------------------------------------------------------------------------


def _register_invoice_fonts() -> tuple[str, str]:
    candidates = (
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/TTF/DejaVuSans.ttf",
         "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"),
    )
    for regular_path, bold_path in candidates:
        if Path(regular_path).exists() and Path(bold_path).exists():
            try:
                pdfmetrics.registerFont(TTFont("InvoiceSans", regular_path))
                pdfmetrics.registerFont(TTFont("InvoiceSans-Bold", bold_path))
                return "InvoiceSans", "InvoiceSans-Bold"
            except Exception:  # pragma: no cover - font file corrupt
                break
    return "Helvetica", "Helvetica-Bold"


FONT_REGULAR, FONT_BOLD = _register_invoice_fonts()

# When DejaVu is unavailable we fall back to Helvetica, which lacks the ₹
# glyph. In that case render rupees as the ASCII "Rs " prefix so amounts are
# still readable (no black boxes in the PDF).
_RUPEE_PREFIX = "\u20B9" if FONT_REGULAR == "InvoiceSans" else "Rs "

from sqlmodel import Session, select

from .auth import get_current_user
from .db import get_session
from .models import Bill, Customer, JobType, User
from .rates import (
    CostBreakdown,
    MAX_DEPTH_FT,
    _get_casing_prices,
    _get_rebore_price,
    _list_ranges,
    compute_cost,
)

router = APIRouter(tags=["billing"])


# ---------------------------------------------------------------------------
# Hard-coded supplier + tax config (editable in a future admin UI)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Supplier:
    name: str
    address_lines: tuple[str, ...]
    state: str
    state_code: str
    gstin: str
    phone: str
    email: str


SUPPLIER = Supplier(
    name="SVLS Rig Service",
    address_lines=(
        "Demo Address Line 1",
        "Demo City, Demo District",
        "PIN 000000",
    ),
    state="Chhattisgarh",
    state_code="22",
    gstin="22AAAAA0000A1Z5",
    phone="+91 00000 00000",
    email="contact@svls.example",
)

# Water-well / borewell drilling services.
HSN_SAC_CODE = "995434"
SERVICE_DESCRIPTION = "Borewell drilling services"

# 18% intra-state GST split into 9% CGST + 9% SGST. When the recipient is
# outside the supplier's state a single 18% IGST line is used instead.
GST_RATE_PERCENT = 18.0
CGST_PERCENT = GST_RATE_PERCENT / 2.0
SGST_PERCENT = GST_RATE_PERCENT / 2.0
IGST_PERCENT = GST_RATE_PERCENT


# ---------------------------------------------------------------------------
# Pydantic request model
# ---------------------------------------------------------------------------


_PHONE_RE = re.compile(r"^\+?[0-9\- ]{7,20}$")


class BillRequest(BaseModel):
    """Payload the UI sends to generate a bill PDF."""

    depth: float = Field(..., ge=0, le=MAX_DEPTH_FT)
    job_type: JobType = Field(default=JobType.NEW_BORE)
    casing_7_pieces: int = Field(default=0, ge=0, le=10_000)
    casing_10_pieces: int = Field(default=0, ge=0, le=10_000)
    customer_name: str = Field(..., min_length=1, max_length=120)
    customer_phone: str = Field(..., min_length=7, max_length=20)
    customer_address: str | None = Field(default=None, max_length=240)
    customer_state: str | None = Field(default=None, max_length=60)
    customer_state_code: str | None = Field(default=None, max_length=4)
    customer_gstin: str | None = Field(default=None, max_length=15)

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


class BillLineItem(BaseModel):
    """One row of the tax-invoice items table.

    Unified across drilling slices (per 100-ft sub-slice) and casing
    rows (per-piece), so the PDF/preview can render them in a single
    table with consistent columns. ``is_taxable`` is ``True`` for
    drilling/re-bore rows (GST applies) and ``False`` for casing
    (added after tax).
    """

    description: str
    hsn_sac: str  # empty string if not applicable (e.g. casing)
    qty: float
    qty_unit: str  # "ft" for drilling, "pc" for casing
    rate: float  # per-foot or per-piece
    amount: float
    is_taxable: bool


class BillPreview(BaseModel):
    """JSON preview of the invoice, consumed by the frontend before download."""

    invoice_number: str
    invoice_date: str  # ISO yyyy-mm-dd
    supplier_name: str
    supplier_address_lines: List[str]
    supplier_state: str
    supplier_state_code: str
    supplier_gstin: str
    supplier_phone: str
    supplier_email: str

    customer_name: str
    customer_phone: str
    customer_address: str | None
    customer_state: str | None
    customer_state_code: str | None
    customer_gstin: str | None

    job_type: JobType
    hsn_sac: str
    description: str
    depth: float

    # Casing add-ons (non-taxable; rendered as their own line items).
    casing_7_pieces: int
    casing_7_price_per_piece: float
    casing_7_amount: float
    casing_10_pieces: int
    casing_10_price_per_piece: float
    casing_10_amount: float
    casing_fee: float

    line_items: List[BillLineItem]
    taxable_value: float  # = drilling (or re-bore) amount — excludes casing
    non_taxable_total: float  # = casing_fee (post-tax addition)
    is_interstate: bool
    cgst_percent: float
    sgst_percent: float
    igst_percent: float
    cgst_amount: float
    sgst_amount: float
    igst_amount: float
    total_tax: float
    grand_total: float
    amount_in_words: str


# ---------------------------------------------------------------------------
# Amount in words — Indian numbering system (lakh / crore)
# ---------------------------------------------------------------------------


_ONES = (
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
)
_TENS = (
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
)


def _two_digits_to_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return _TENS[tens] + (" " + _ONES[ones] if ones else "")


def _three_digits_to_words(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts: List[str] = []
    if hundreds:
        parts.append(f"{_ONES[hundreds]} Hundred")
    if rest:
        parts.append(_two_digits_to_words(rest))
    return " ".join(parts)


def _integer_to_indian_words(n: int) -> str:
    if n == 0:
        return "Zero"
    parts: List[str] = []
    crore, rest = divmod(n, 10_000_000)
    if crore:
        parts.append(f"{_integer_to_indian_words(crore)} Crore")
    lakh, rest = divmod(rest, 100_000)
    if lakh:
        parts.append(f"{_two_digits_to_words(lakh)} Lakh")
    thousand, rest = divmod(rest, 1000)
    if thousand:
        parts.append(f"{_two_digits_to_words(thousand)} Thousand")
    if rest:
        parts.append(_three_digits_to_words(rest))
    return " ".join(p for p in parts if p)


def amount_in_words_inr(amount: float) -> str:
    """Convert a rupee amount into Indian-numbering-system words.

    Paise (two decimals) are included only if non-zero.
    """
    if amount < 0:
        return "Minus " + amount_in_words_inr(-amount)
    rupees = int(amount)
    paise = int(round((amount - rupees) * 100))
    if paise == 100:
        rupees += 1
        paise = 0
    text = f"Rupees {_integer_to_indian_words(rupees)}"
    if paise:
        text += f" and {_two_digits_to_words(paise)} Paise"
    return text + " only"


# ---------------------------------------------------------------------------
# Invoice assembly (pure)
# ---------------------------------------------------------------------------


def _format_inr(amount: float) -> str:
    """Format a number as INR (`1,23,456.78`) using the Indian grouping."""
    sign = "-" if amount < 0 else ""
    abs_amount = abs(amount)
    rupees, paise = divmod(round(abs_amount * 100), 100)
    rupees_str = f"{int(rupees):,}"
    # Convert western grouping to Indian grouping (last 3 digits, then 2s).
    if len(rupees_str.replace(",", "")) > 3:
        plain = rupees_str.replace(",", "")
        last3 = plain[-3:]
        rest = plain[:-3]
        grouped_rest = ",".join(
            rest[max(0, i - 2) : i] for i in range(len(rest), 0, -2)
        )
        grouped_rest = ",".join(reversed(grouped_rest.split(",")))
        rupees_str = f"{grouped_rest},{last3}"
    return f"{sign}{_RUPEE_PREFIX}{rupees_str}.{int(paise):02d}"


def _make_invoice_number(now: datetime) -> str:
    # `SVLS/YYYYMMDD/HHMMSS` — unique enough for a demo; swap for a DB
    # counter once invoices are persisted.
    return f"SVLS/{now.strftime('%Y%m%d')}/{now.strftime('%H%M%S')}"


def build_preview(
    breakdown: CostBreakdown,
    req: BillRequest,
    *,
    now: datetime | None = None,
) -> BillPreview:
    now = now or datetime.now(timezone.utc).astimezone()

    is_interstate = bool(
        req.customer_state_code
        and req.customer_state_code.strip()
        and req.customer_state_code.strip() != SUPPLIER.state_code
    )

    taxable_value = round(breakdown.amount, 2)
    if is_interstate:
        cgst_amount = 0.0
        sgst_amount = 0.0
        igst_amount = round(taxable_value * IGST_PERCENT / 100.0, 2)
    else:
        cgst_amount = round(taxable_value * CGST_PERCENT / 100.0, 2)
        sgst_amount = round(taxable_value * SGST_PERCENT / 100.0, 2)
        igst_amount = 0.0
    total_tax = round(cgst_amount + sgst_amount + igst_amount, 2)
    non_taxable_total = round(breakdown.casing_fee, 2)
    grand_total = round(taxable_value + total_tax + non_taxable_total, 2)

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

    return BillPreview(
        invoice_number=_make_invoice_number(now),
        invoice_date=now.date().isoformat(),
        supplier_name=SUPPLIER.name,
        supplier_address_lines=list(SUPPLIER.address_lines),
        supplier_state=SUPPLIER.state,
        supplier_state_code=SUPPLIER.state_code,
        supplier_gstin=SUPPLIER.gstin,
        supplier_phone=SUPPLIER.phone,
        supplier_email=SUPPLIER.email,
        customer_name=req.customer_name,
        customer_phone=req.customer_phone,
        customer_address=req.customer_address,
        customer_state=req.customer_state,
        customer_state_code=req.customer_state_code,
        customer_gstin=req.customer_gstin,
        job_type=breakdown.job_type,
        hsn_sac=HSN_SAC_CODE,
        description=service_desc,
        depth=breakdown.depth,
        casing_7_pieces=breakdown.casing_7_pieces,
        casing_7_price_per_piece=breakdown.casing_7_price_per_piece,
        casing_7_amount=breakdown.casing_7_amount,
        casing_10_pieces=breakdown.casing_10_pieces,
        casing_10_price_per_piece=breakdown.casing_10_price_per_piece,
        casing_10_amount=breakdown.casing_10_amount,
        casing_fee=breakdown.casing_fee,
        line_items=line_items,
        taxable_value=taxable_value,
        non_taxable_total=non_taxable_total,
        is_interstate=is_interstate,
        cgst_percent=CGST_PERCENT,
        sgst_percent=SGST_PERCENT,
        igst_percent=IGST_PERCENT,
        cgst_amount=cgst_amount,
        sgst_amount=sgst_amount,
        igst_amount=igst_amount,
        total_tax=total_tax,
        grand_total=grand_total,
        amount_in_words=amount_in_words_inr(grand_total),
    )


# ---------------------------------------------------------------------------
# PDF rendering
# ---------------------------------------------------------------------------


def render_invoice_pdf(preview: BillPreview) -> bytes:
    """Render ``preview`` into a single-page A4 tax-invoice PDF."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
        title=f"Tax Invoice {preview.invoice_number}",
        author=preview.supplier_name,
    )

    styles = getSampleStyleSheet()
    base = styles["BodyText"]
    title_style = ParagraphStyle(
        "InvoiceTitle",
        parent=base,
        fontName=FONT_BOLD,
        fontSize=16,
        alignment=1,  # center
        spaceAfter=4,
    )
    subtitle_style = ParagraphStyle(
        "InvoiceSubtitle",
        parent=base,
        fontName=FONT_REGULAR,
        fontSize=9,
        alignment=1,
        textColor=colors.grey,
        spaceAfter=8,
    )
    small = ParagraphStyle(
        "Small", parent=base, fontName=FONT_REGULAR, fontSize=9, leading=11
    )
    small_bold = ParagraphStyle(
        "SmallBold", parent=small, fontName=FONT_BOLD
    )

    # ReportLab's Paragraph parses its input as XML, so every user-provided
    # string that ends up inside a Paragraph must be XML-escaped first. Stray
    # `<`, `>`, or `&` characters in names, addresses, states, etc. would
    # otherwise crash PDF generation.
    def esc(value: str | None) -> str:
        return _xml_escape(value) if value else ""

    story: List = []
    story.append(Paragraph("TAX INVOICE", title_style))
    story.append(
        Paragraph(
            "Issued under Rule 46 of the CGST Rules, 2017",
            subtitle_style,
        )
    )

    # Supplier + invoice meta (two-column header)
    supplier_block = [
        Paragraph(f"<b>{preview.supplier_name}</b>", small_bold),
        *[Paragraph(line, small) for line in preview.supplier_address_lines],
        Paragraph(
            f"State: {preview.supplier_state} (Code {preview.supplier_state_code})",
            small,
        ),
        Paragraph(f"GSTIN: <b>{preview.supplier_gstin}</b>", small),
        Paragraph(
            f"Phone: {preview.supplier_phone} · Email: {preview.supplier_email}",
            small,
        ),
    ]
    place_of_supply_state = (
        esc(preview.customer_state) if preview.customer_state else preview.supplier_state
    )
    place_of_supply_code = (
        esc(preview.customer_state_code)
        if preview.customer_state_code
        else preview.supplier_state_code
    )
    meta_block = [
        Paragraph(f"<b>Invoice No:</b> {preview.invoice_number}", small),
        Paragraph(f"<b>Invoice Date:</b> {preview.invoice_date}", small),
        Paragraph(
            f"<b>Place of Supply:</b> {place_of_supply_state} "
            f"({place_of_supply_code})",
            small,
        ),
        Paragraph(
            "<b>Reverse Charge:</b> No",
            small,
        ),
    ]
    header = Table(
        [[supplier_block, meta_block]],
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

    # Bill-to block (user-provided fields escaped via esc() defined above).
    billto_rows: List = [[Paragraph("<b>Bill To</b>", small_bold)]]
    billto_rows.append([Paragraph(esc(preview.customer_name), small_bold)])
    billto_rows.append([Paragraph(f"Phone: {esc(preview.customer_phone)}", small)])
    if preview.customer_address:
        billto_rows.append([Paragraph(esc(preview.customer_address), small)])
    if preview.customer_state:
        state_code = esc(preview.customer_state_code) or "—"
        billto_rows.append(
            [
                Paragraph(
                    f"State: {esc(preview.customer_state)} (Code {state_code})",
                    small,
                )
            ]
        )
    if preview.customer_gstin:
        billto_rows.append(
            [Paragraph(f"GSTIN: <b>{esc(preview.customer_gstin)}</b>", small)]
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

    # Line-item table. Unified rows across drilling sub-slices and casing
    # pieces, with casing shown in the main items table (not as a GST-footer
    # add-on). The footer holds only Taxable Value, GST lines, and Grand
    # Total. Casing rows carry is_taxable=False so they're excluded from
    # the taxable-value subtotal.
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
            Paragraph("<b>Taxable Value</b>", small),
            Paragraph(f"<b>{_format_inr(preview.taxable_value)}</b>", small),
        ]
    )
    if preview.is_interstate:
        data.append(
            [
                "",
                "",
                "",
                "",
                f"IGST @ {preview.igst_percent:g}%",
                _format_inr(preview.igst_amount),
            ]
        )
    else:
        data.append(
            [
                "",
                "",
                "",
                "",
                f"CGST @ {preview.cgst_percent:g}%",
                _format_inr(preview.cgst_amount),
            ]
        )
        data.append(
            [
                "",
                "",
                "",
                "",
                f"SGST @ {preview.sgst_percent:g}%",
                _format_inr(preview.sgst_amount),
            ]
        )
    data.append(
        [
            "",
            "",
            "",
            "",
            Paragraph("<b>Grand Total</b>", small_bold),
            Paragraph(f"<b>{_format_inr(preview.grand_total)}</b>", small_bold),
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
                ("LINEABOVE", (4, item_row_count + 1), (-1, item_row_count + 1), 0.5, colors.black),
                ("LINEABOVE", (4, last_row_index), (-1, last_row_index), 0.75, colors.black),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(items_table)
    story.append(Spacer(1, 8))

    # Amount in words
    words = Paragraph(
        f"<b>Amount in words:</b> {preview.amount_in_words}", small
    )
    words_table = Table([[words]], colWidths=[180 * mm])
    words_table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.black),
                ("BACKGROUND", (0, 0), (-1, -1), colors.whitesmoke),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(words_table)
    story.append(Spacer(1, 14))

    # Declarations + signature
    declaration = Paragraph(
        "We declare that this invoice shows the actual price of the service "
        "described and that all particulars are true and correct.",
        small,
    )
    signature_block = [
        Paragraph(f"For <b>{preview.supplier_name}</b>", small),
        Spacer(1, 28),
        Paragraph("Authorised Signatory", small_bold),
    ]
    footer = Table(
        [[declaration, signature_block]],
        colWidths=[110 * mm, 70 * mm],
    )
    footer.setStyle(
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
    story.append(footer)
    story.append(Spacer(1, 10))
    story.append(
        Paragraph(
            "<i>This is a computer-generated invoice and does not require a "
            "physical signature.</i>",
            ParagraphStyle(
                "footnote", parent=small, fontSize=8, textColor=colors.grey
            ),
        )
    )

    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _build_preview_for_request(
    req: BillRequest, session: Session
) -> BillPreview:
    prices = _get_casing_prices(session)
    rebore = _get_rebore_price(session)
    try:
        breakdown = compute_cost(
            _list_ranges(session),
            req.depth,
            req.casing_7_pieces,
            req.casing_10_pieces,
            prices.price_7in,
            prices.price_10in,
            job_type=req.job_type,
            rebore_price_per_foot=rebore.price_per_foot,
        )
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(err)
        ) from err
    return build_preview(breakdown, req)


@router.post("/api/bill/preview", response_model=BillPreview)
def preview_bill(
    payload: BillRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> BillPreview:
    """Return the fully-computed invoice in JSON form so the UI can preview it."""
    return _build_preview_for_request(payload, session)


@router.post("/api/bill/pdf")
def download_bill(
    payload: BillRequest,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> Response:
    """Render the invoice PDF **and** persist the bill against the customer.

    The customer must already exist (looked up by phone number). This is
    a deliberate guard: payments can only be recorded against a known
    customer, so we reject the download until one is created via the
    Payments page.
    """
    customer = session.exec(
        select(Customer).where(Customer.phone == payload.customer_phone)
    ).first()
    if customer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"No customer found with phone {payload.customer_phone}. "
                "Create the customer on the Payments page before issuing a bill."
            ),
        )

    preview = _build_preview_for_request(payload, session)
    pdf_bytes = render_invoice_pdf(preview)
    safe_invoice_id = preview.invoice_number.replace("/", "-")
    filename = f"{safe_invoice_id}.pdf"

    bill = Bill(
        customer_id=customer.id,  # type: ignore[arg-type]
        invoice_number=preview.invoice_number,
        invoice_date=preview.invoice_date,
        job_type=preview.job_type.value,
        depth=preview.depth,
        casing_7_pieces=preview.casing_7_pieces,
        casing_10_pieces=preview.casing_10_pieces,
        taxable_value=preview.taxable_value,
        total_tax=preview.total_tax,
        non_taxable_total=preview.non_taxable_total,
        grand_total=preview.grand_total,
    )
    session.add(bill)
    session.commit()

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Invoice-Number": preview.invoice_number,
        },
    )
