"""SAP delivery schedule (DELFOR02, message DELINS): a partner's forecast of what it will need,
per item and day. Written and read like the other IDocs in supply_docs.py (a simulation: real
segment names, no live SAP)."""

from __future__ import annotations

from xml.etree import ElementTree as ET  # noqa: S405 - only our own output and sizes are bounded

from .supply_docs import (
    DocLine,
    Party,
    SupplyDoc,
    _segment,
    _text,
    from_sap_date,
    number,
    qty_text,
    sap_date,
    unit_code,
)


def write_forecast(idoc: ET.Element, doc: SupplyDoc) -> None:
    """E1EDK09 header with the partners, then per item E1EDP10 and its schedule line E1EDP16."""
    cur = doc.currency
    head = _segment(
        idoc,
        "E1EDK09",
        [
            ("VTRNR", doc.number),
            ("BSTDK", sap_date(doc.issued)),
            ("LABNK", doc.ref),
            ("CURCY", cur),
        ],
    )
    for role, party in (("AG", doc.buyer), ("LF", doc.supplier)):
        _segment(
            head,
            "E1EDKA1",
            [
                ("PARVW", role),
                ("PARTN", (party.id or "")[:17].upper()),
                ("NAME1", party.name[:35]),
            ],
        )
    for line in doc.lines:
        item = _segment(
            head,
            "E1EDP10",
            [
                ("POSEX", str(line.line).zfill(5)),
                ("IDNKD", line.buyer_code),
                ("IDNLF", line.supplier_code),
                ("ARKTX", line.item[:40]),
                ("VRKME", unit_code(line.unit)),
            ],
        )
        # One schedule line per item: the quantity expected by that day (D = daily bucket).
        _segment(
            item,
            "E1EDP16",
            [
                ("ETTYP", "1"),
                ("PRGRS", "D"),
                ("EDATUV", sap_date(doc.delivery)),
                ("WMENG", qty_text(line.quantity)),
            ],
        )
    if doc.note:
        _segment(head, "E1EDKT1", [("TDLINE", doc.note[:70])])


def read_forecast(idoc: ET.Element, control: ET.Element) -> SupplyDoc:
    """DELFOR02 (message DELINS): the partner's expected quantities per item and day."""
    head = idoc.find("E1EDK09")
    if head is None:
        raise ValueError("forecast without E1EDK09")
    partners = {_text(p, "PARVW"): p for p in head.findall("E1EDKA1")}
    lines: list[DocLine] = []
    first = ""
    for item in head.findall("E1EDP10"):
        schedule = item.find("E1EDP16")
        day = from_sap_date(_text(schedule, "EDATUV"))
        first = first or day
        lines.append(
            DocLine(
                line=int(_text(item, "POSEX") or len(lines) * 10 + 10),
                item=_text(item, "ARKTX") or _text(item, "IDNKD") or "?",
                buyer_code=_text(item, "IDNKD"),
                supplier_code=_text(item, "IDNLF"),
                quantity=number(_text(schedule, "WMENG")) or 0,
                unit=_text(item, "VRKME"),
            )
        )
    note = " ".join(_text(t, "TDLINE") for t in head.findall("E1EDKT1"))
    return SupplyDoc(
        kind="FORECAST",
        number=_text(head, "VTRNR") or "?",
        ref=_text(head, "LABNK"),
        issued=from_sap_date(_text(head, "BSTDK") or _text(control, "CREDAT")),
        delivery=first,
        currency=_text(head, "CURCY") or "XXX",
        buyer=Party(
            id=_text(partners.get("AG"), "PARTN").lower(), name=_text(partners.get("AG"), "NAME1")
        ),
        supplier=Party(
            id=_text(partners.get("LF"), "PARTN").lower(),
            name=_text(partners.get("LF"), "NAME1"),
            system="idoc",
        ),
        lines=lines or [DocLine(line=10, item="?", quantity=0, unit="")],
        note=note.strip(),
    )
