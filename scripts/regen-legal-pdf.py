"""Regenera Textos_Legales_Inmobiliarias_ACTUALIZADO.pdf desde el Markdown."""
from pathlib import Path
import re
from html import escape

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY

ROOT = Path(__file__).resolve().parents[1]
MD = ROOT / "Textos-Legales-Inmobiliarias-ACTUALIZADO.md"
OUT = ROOT / "Textos_Legales_Inmobiliarias_ACTUALIZADO.pdf"


def md_inline(s: str) -> str:
    s = escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`([^`]+)`", r"<font face='Courier' size='7'>\1</font>", s)
    return s


def main() -> None:
    text = MD.read_text(encoding="utf-8")
    text = text.split("# Nota operativa")[0].strip()

    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        topMargin=1.5 * cm,
        bottomMargin=1.5 * cm,
    )
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="H1",
            fontSize=12,
            leading=15,
            spaceBefore=11,
            spaceAfter=6,
            fontName="Helvetica-Bold",
            textColor=colors.HexColor("#1a365d"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="H2",
            fontSize=10,
            leading=13,
            spaceBefore=8,
            spaceAfter=4,
            fontName="Helvetica-Bold",
            textColor=colors.HexColor("#2c5282"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="H3",
            fontSize=9,
            leading=11,
            spaceBefore=5,
            spaceAfter=3,
            fontName="Helvetica-Bold",
        )
    )
    styles.add(
        ParagraphStyle(
            name="Body",
            fontSize=8.5,
            leading=11,
            alignment=TA_JUSTIFY,
            spaceAfter=3,
            fontName="Helvetica",
        )
    )
    styles.add(
        ParagraphStyle(
            name="Foot",
            fontSize=8,
            leading=10,
            alignment=TA_CENTER,
            textColor=colors.grey,
            spaceBefore=10,
        )
    )

    story = []
    for line in text.splitlines():
        raw = line.rstrip()
        if not raw:
            story.append(Spacer(1, 0.1 * cm))
            continue
        if raw.startswith("# ANEXO"):
            story.append(PageBreak())
        if raw.startswith("# "):
            story.append(Paragraph(md_inline(raw[2:]), styles["H1"]))
        elif raw.startswith("## "):
            story.append(Paragraph(md_inline(raw[3:]), styles["H2"]))
        elif raw.startswith("### "):
            story.append(Paragraph(md_inline(raw[4:]), styles["H3"]))
        elif raw.startswith("> "):
            story.append(Paragraph(f"<i>{md_inline(raw[2:])}</i>", styles["Body"]))
        elif raw.startswith("|") or raw.startswith("---"):
            continue
        elif raw.startswith("- "):
            story.append(Paragraph("• " + md_inline(raw[2:]), styles["Body"]))
        else:
            story.append(Paragraph(md_inline(raw), styles["Body"]))

    story.append(
        Paragraph(
            "Alertas VIP Inmobiliarias © 2026 | Florian Serb · florianserb.com",
            styles["Foot"],
        )
    )
    doc.build(story)
    print(f"OK {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
