"""Partner documents in and out: what came in, what needs the owner, and what must go out.

INBOUND. A partner's order create (ORDERS), order change (ORDER_CHANGE) or forecast (FORECAST)
arrives in the partner's system format (SAP IDoc XML, CSV, JSON or a typed message). It is read
(the deterministic parsers; Gemini only for a format they cannot read, when live), validated,
linked to the order, the shop's item and the partner, and saved. Every document lands in the
shop's inbox with what it changed and a status (new, needs_you, done, problem). A supplier's
confirmation, shipping notice or invoice for one of the shop's purchase orders goes through the
purchase-order loop (supply_chain.py) and is listed in the inbox too.

OUTBOUND. Goods that came in get a goods receipt (RECEIPT; SAP proof of delivery STPPOD on
DELVRY07), pre-filled from the shipping notice or the order: the owner fixes only differences.
Goods going out get a shipping notice (DESADV on DELVRY07). Both are written in the partner's
format and wait as pending until sent; Close the day lists what is unsent and sends it in one tap.

Direction, per order: "in" when goods come to the shop (the partner is its supplier), "out" when
the shop ships to the partner (the partner is its buyer). No live EDI network is connected:
"sent" means the document is final and shared with the partner (simulated for demo partners).
"""

from __future__ import annotations

import re
import time
from datetime import date, timedelta
from typing import Any

import structlog
from fastapi import HTTPException
from pydantic import ValidationError

from . import supply_chain
from .merchant import MerchantRepository
from .region import shop_currency
from .supply_docs import MAPPING, Format, Party, SupplyDoc, map_line, parse, render
from .supply_docs import unit_from_code as unit_of

log = structlog.get_logger()

INBOX = supply_chain.INBOX
MAX_INBOX = 60
SHOWN_INBOX = 30
CLOSED = {"closed", "cancelled"}
# Documents a supplier sends about one of the shop's purchase orders (supply_chain.ingest).
LOOP_KINDS = {"ORDRSP", "DESADV", "INVOIC"}


# ---------------------------------------------------------------------------------------------
# Parties and lookups


def shop_party(context: dict[str, Any]) -> dict[str, Any]:
    business = context["business"]
    return {
        "id": business["id"],
        "name": business["fields"]["name"],
        "system": "json",
        "demo": False,
    }


def partner_of(po: dict[str, Any]) -> dict[str, Any]:
    """The other side of the order: its supplier for goods coming in, its buyer otherwise."""
    return po.get("partner") or po["supplier"]


def direction_of(po: dict[str, Any]) -> str:
    return str(po.get("direction") or "in")


def _same(a: str, b: str) -> bool:
    return bool(a.strip()) and a.strip().casefold() == b.strip().casefold()


def _is_shop(party: Party, shop: dict[str, Any]) -> bool:
    return _same(party.id, shop["id"]) or _same(party.name, shop["name"])


def _slug(name: str) -> str:
    return "partner-" + re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")[:40]


def known_partners(store: MerchantRepository, bid: str) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for po in supply_chain.all_orders(store, bid):
        seen.setdefault(partner_of(po)["id"], partner_of(po))
    for entry in inbox(store, bid):
        if entry.get("partner"):
            seen.setdefault(entry["partner"]["id"], entry["partner"])
    return list(seen.values())


def resolve_partner(
    party: Party, fmt: Format, known: list[dict[str, Any]], hint: str = ""
) -> dict[str, Any] | None:
    """The partner a document is from: a known one by id or name, else a new record. Its system
    is the format it writes, so what we send back is in that format too."""
    if hint:
        found = next((row for row in known if row["id"] == hint), None)
        if found:
            return {**found, "system": fmt}
    pid = party.id.strip().casefold() or (_slug(party.name) if party.name.strip() else "")
    if not pid:
        return None
    for row in known:
        if row["id"] == pid or _same(row.get("name", ""), party.name):
            return {**row, "system": fmt}
    name = (party.name or party.id).strip()[:120]
    demo = pid.startswith("demo-") or "(demo)" in name.casefold()
    return {"id": pid[:80], "name": name, "system": fmt, "demo": demo}


def _product(name: str, inventory: list[dict[str, Any]]) -> dict[str, Any] | None:
    from .sourcing import matches

    return next(
        (p for p in inventory if _same(p["name"], name)),
        next(
            (p for p in inventory if matches(p["name"], name) or matches(name, p["name"])),
            None,
        ),
    )


def find_order(
    store: MerchantRepository, bid: str, number: str, partner_id: str = ""
) -> dict[str, Any] | None:
    found = [
        po
        for po in supply_chain.all_orders(store, bid)
        if number
        and po["number"] == number
        and (not partner_id or partner_of(po)["id"] == partner_id)
    ]
    return found[0] if found else None


# ---------------------------------------------------------------------------------------------
# The inbox


def inbox(store: MerchantRepository, bid: str) -> list[dict[str, Any]]:
    return store.feature_docs.scoped(INBOX, bid, MAX_INBOX)


def _put_entry(store: MerchantRepository, bid: str, entry: dict[str, Any]) -> dict[str, Any]:
    store.feature_docs.put(INBOX, f"{bid}/{entry['id']}", bid, float(entry["created"]), entry)
    return entry


def _set_entry(store: MerchantRepository, bid: str, entry_id: str, **fields: Any) -> None:
    def change(old: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
        if old is None:
            raise HTTPException(404, "Document not found.")
        return float(old.get("created", time.time())), {**old, **fields}

    store.feature_docs.update(INBOX, f"{bid}/{entry_id}", bid, change)


def _entry(
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    reader: str,
    partner: dict[str, Any] | None,
    direction: str,
    order_id: str,
    status: str,
    changes: list[dict[str, Any]],
    problem: str = "",
) -> dict[str, Any]:
    now = time.time()
    return {
        "id": _id(),
        "kind": doc.kind,
        "number": doc.number,
        "ref": doc.ref,
        "at": now,
        "created": now,
        "partner": partner,
        "direction": direction,
        "order_id": order_id,
        "status": status,
        "problem": problem,
        "changes": changes,
        "lines": [
            {
                "line": x.line,
                "item": x.item,
                "quantity": x.quantity,
                "unit": unit_of(x.unit) or x.unit,
            }
            for x in doc.lines
        ],
        "delivery": doc.delivery,
        "raw": raw[:20_000],
        "raw_format": fmt,
        "reader": reader,
    }


def _id() -> str:
    from uuid import uuid4

    return uuid4().hex[:12]


def _order_document(
    doc: SupplyDoc, fmt: Format, raw: str, reader: str, sender: str
) -> dict[str, Any]:
    """A partner's document on the order's timeline, mapped from the format it came in."""
    entry = supply_chain.document_entry(
        doc,
        sender="supplier",  # the mapping shown is the sender's format
        raw=raw,
        raw_format=fmt,
        translated=render(doc, "json"),
        translated_format="json",
        flags=[],
        reader=reader,
    )
    entry["from"] = sender
    entry["direction"] = "in"
    entry["mapping"] = [{"field": a, "source": b} for a, b in MAPPING[fmt]]
    return entry


# ---------------------------------------------------------------------------------------------
# Inbound: read, validate, link, save


async def receive_document(
    store: MerchantRepository, uid: str, bid: str, text: str, partner_id: str = ""
) -> dict[str, Any]:
    """A document from a partner in any format we read. Returns the inbox entry and the order
    it created or changed (if any)."""
    import anyio

    context = await anyio.to_thread.run_sync(store.context, uid, bid)
    today = supply_chain.shop_today(context)
    try:
        doc, fmt, _ = parse(text, today)
        reader = "parser"
    except ValueError as error:
        translator = supply_chain._translator()
        if not translator.live:
            log.info("supply_inbound_unreadable", reason=str(error)[:120])
            raise HTTPException(422, "UNREADABLE_DOCUMENT") from error
        try:
            doc, _flags, reader, fmt = await translator.read(text, None, today)
        except (ValueError, ValidationError) as failure:
            raise HTTPException(422, "UNREADABLE_DOCUMENT") from failure
    if doc.kind in LOOP_KINDS:
        return await _loop_document(store, bid, context, doc, fmt, text, today)
    return await anyio.to_thread.run_sync(
        process, store, bid, context, doc, fmt, text, reader, partner_id
    )


async def _loop_document(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    today: date,
) -> dict[str, Any]:
    """A supplier's confirmation, shipping notice or invoice for one of the shop's POs."""
    import anyio

    po = await anyio.to_thread.run_sync(find_order, store, bid, doc.ref)
    if po is None or direction_of(po) != "in":
        entry = _entry(doc, fmt, raw, "parser", None, "in", "", "problem", [], "unknown_order")
        await anyio.to_thread.run_sync(_put_entry, store, bid, entry)
        return {"entry": entry, "order": None}
    saved = await supply_chain.ingest(store, bid, po, raw, today, simulated=False)
    waiting = saved["status"] == "changed" or bool(saved.get("open_flags"))
    entry = _entry(
        doc,
        fmt,
        raw,
        saved["documents"][-1].get("reader", "parser"),
        partner_of(saved),
        "in",
        saved["id"],
        "needs_you" if waiting else "new",
        list(saved.get("changes") or []),
    )
    await anyio.to_thread.run_sync(_put_entry, store, bid, entry)
    return {"entry": entry, "order": saved}


def process(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    reader: str = "parser",
    partner_id: str = "",
) -> dict[str, Any]:
    """Validate an order create, order change or forecast and save what it means."""
    if doc.kind not in {"ORDERS", "ORDER_CHANGE", "FORECAST"}:
        raise HTTPException(422, "NOT_INBOUND")
    for entry in inbox(store, bid):
        if entry["kind"] == doc.kind and entry["number"] == doc.number:
            # The same document again (a resend): nothing changes twice.
            order = (
                store.feature_docs.get(supply_chain.ORDERS, f"{bid}/{entry['order_id']}")
                if entry.get("order_id")
                else None
            )
            return {"entry": entry, "order": order, "duplicate": True}
    if doc.currency in {"", "XXX"}:
        doc.currency = shop_currency(context["business"]["fields"])
    if doc.kind == "ORDER_CHANGE":
        return _order_change(store, bid, context, doc, fmt, raw, reader, partner_id)
    shop = shop_party(context)
    if _is_shop(doc.supplier, shop):
        direction, party = "out", doc.buyer
    elif _is_shop(doc.buyer, shop):
        direction, party = "in", doc.supplier
    elif doc.buyer.id or doc.buyer.name:
        # A partner's order or forecast, written by its buying side.
        direction, party = "out", doc.buyer
    else:
        direction, party = "in", doc.supplier
    partner = resolve_partner(party, fmt, known_partners(store, bid), partner_id)
    if partner is None:
        raise HTTPException(422, "UNKNOWN_PARTNER")
    if doc.kind == "FORECAST":
        return _forecast(store, bid, context, doc, fmt, raw, reader, partner, direction)
    return _order_create(store, bid, context, doc, fmt, raw, reader, partner, direction)


def _shop_unit(unit: str | None, product: dict[str, Any] | None) -> str | None:
    """The shop's own spelling of the same unit ("l" for litre), so quantities read alike."""
    if unit and product and unit_of(str(product.get("unit") or "")) == unit:
        return str(product["unit"])
    return unit


def _lines(doc: SupplyDoc, inventory: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    """Order lines linked to the shop's items, and the first problem found (or '')."""
    lines: list[dict[str, Any]] = []
    problem = ""
    for got in doc.lines:
        unit = unit_of(got.unit)
        product = _product(got.item, inventory)
        if unit is None:
            problem = problem or "unit"
        unit = _shop_unit(unit, product)
        if got.quantity <= 0:
            problem = problem or "quantity"
        lines.append(
            {
                "line": got.line,
                "item": product["name"] if product else got.item,
                "partner_item": got.item,
                "product": product["name"] if product else "",
                "buyer_code": got.buyer_code,
                "supplier_code": got.supplier_code,
                "quantity": got.quantity,
                "unit": unit or got.unit or "piece",
                "price": got.price,
                "total": got.total
                if got.total is not None
                else (round(got.price * got.quantity) if got.price is not None else None),
            }
        )
    return lines, problem


def _order_create(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    reader: str,
    partner: dict[str, Any],
    direction: str,
) -> dict[str, Any]:
    lines, problem = _lines(doc, context["inventory"])
    if direction == "out" and any(not line["product"] for line in lines):
        problem = problem or "unknown_item"  # they ordered something the shop does not sell
    shop = shop_party(context)
    today = supply_chain.shop_today(context)
    now = time.time()
    po: dict[str, Any] = {
        "id": _id(),
        "number": doc.number,
        "created": now,
        "status": "confirmed",
        "sent": True,
        "received": False,
        "simulated": bool(partner.get("demo")),
        "currency": doc.currency,
        "direction": direction,
        "origin": "partner",
        "partner": partner,
        "buyer": partner if direction == "out" else shop,
        "supplier": shop if direction == "out" else partner,
        "lines": lines,
        "delivery": doc.delivery or (today + timedelta(days=1)).isoformat(),
        "terms_days": doc.terms_days or 0,
        "total": sum(line["total"] or 0 for line in lines),
        "documents": [
            _order_document(doc, fmt, raw, reader, "buyer" if direction == "out" else "supplier")
        ],
        "checks": [],
        "backorders": [],
        "problem": problem,
        "pending_change": None,
        "reason": None,
    }
    entry = _entry(
        doc,
        fmt,
        raw,
        reader,
        partner,
        direction,
        po["id"],
        "problem" if problem else "new",
        [{"code": "created", "lines": len(lines)}],
        problem,
    )
    # A forecast from this partner for these items now belongs to this order.
    items = {line["item"].casefold() for line in lines}
    for earlier in inbox(store, bid):
        if (
            earlier["kind"] == "FORECAST"
            and not earlier.get("order_id")
            and (earlier.get("partner") or {}).get("id") == partner["id"]
            and items & {line["item"].casefold() for line in earlier.get("linked", [])}
        ):
            _set_entry(store, bid, earlier["id"], order_id=po["id"], status="done")
            po["forecast"] = earlier["id"]
    if direction == "in":
        try:
            supply_chain.ensure_relationship(
                store, bid, partner, doc.currency, len(known_partners(store, bid))
            )
        except HTTPException:
            pass
    saved = supply_chain._versioned(store, supply_chain.ORDERS, bid, po["id"], po, 0)
    _put_entry(store, bid, entry)
    return {"entry": entry, "order": saved}


def _forecast(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    reader: str,
    partner: dict[str, Any],
    direction: str,
) -> dict[str, Any]:
    lines, problem = _lines(doc, context["inventory"])
    if any(not line["product"] for line in lines):
        problem = problem or "unknown_item"
    order = next(
        (
            po
            for po in supply_chain.all_orders(store, bid)
            if partner_of(po)["id"] == partner["id"]
            and po["status"] not in CLOSED
            and {x["item"].casefold() for x in po["lines"]} & {x["item"].casefold() for x in lines}
        ),
        None,
    )
    entry = _entry(
        doc,
        fmt,
        raw,
        reader,
        partner,
        direction,
        order["id"] if order else "",
        "problem" if problem else "new",
        [
            {
                "code": "forecast",
                "item": line["item"],
                "quantity": line["quantity"],
                "unit": line["unit"],
                "date": doc.delivery,
            }
            for line in lines
        ],
        problem,
    )
    entry["linked"] = [{"item": line["item"], "product": line["product"]} for line in lines]
    _put_entry(store, bid, entry)
    return {"entry": entry, "order": order}


def _order_change(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    doc: SupplyDoc,
    fmt: Format,
    raw: str,
    reader: str,
    partner_id: str,
) -> dict[str, Any]:
    po = find_order(store, bid, doc.ref, partner_id) or find_order(store, bid, doc.ref)
    if po is None:
        entry = _entry(doc, fmt, raw, reader, None, "out", "", "problem", [], "unknown_order")
        _put_entry(store, bid, entry)
        return {"entry": entry, "order": None}
    partner = partner_of(po)
    late = po["status"] in CLOSED or po.get("received") or _sent(po, "DESADV")
    changes, lines, delivery = diff(po, doc, context["inventory"])
    status = "problem" if late else "needs_you" if changes else "done"
    entry = _entry(
        doc,
        fmt,
        raw,
        reader,
        partner,
        direction_of(po),
        po["id"],
        status,
        changes,
        "too_late" if late else "",
    )
    if changes and not late:
        po["pending_change"] = {
            "entry_id": entry["id"],
            "number": doc.number,
            "changes": changes,
            "lines": lines,
            "delivery": delivery,
            "at": entry["at"],
        }
    po["documents"].append(
        _order_document(doc, fmt, raw, reader, po["documents"][0].get("from", "buyer"))
        if po["documents"]
        else _order_document(doc, fmt, raw, reader, "buyer")
    )
    saved = supply_chain._save(store, bid, po)
    _put_entry(store, bid, entry)
    return {"entry": entry, "order": saved}


def diff(
    po: dict[str, Any], doc: SupplyDoc, inventory: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """What an order change changes: (changes in plain codes, the new lines, the new date).
    Lines the change does not mention stay as they are."""
    lines = [dict(line) for line in po["lines"]]
    by_partner = [{**line, "item": line.get("partner_item") or line["item"]} for line in lines]
    changes: list[dict[str, Any]] = []
    for got in doc.lines:
        match = map_line(got, lines) or map_line(got, by_partner)
        unit = unit_of(got.unit) or got.unit
        if match is None:
            if got.quantity <= 0:
                continue
            product = _product(got.item, inventory)
            unit = _shop_unit(unit, product) or unit
            line = {
                "line": max([x["line"] for x in lines] or [0]) + 10,
                "item": product["name"] if product else got.item,
                "partner_item": got.item,
                "product": product["name"] if product else "",
                "buyer_code": got.buyer_code,
                "supplier_code": got.supplier_code,
                "quantity": got.quantity,
                "unit": unit,
                "price": got.price,
                "total": round(got.price * got.quantity) if got.price is not None else None,
            }
            lines.append(line)
            changes.append(
                {"code": "added", "item": line["item"], "now": got.quantity, "unit": unit}
            )
            continue
        target = next(x for x in lines if x["line"] == match[0]["line"])
        if got.status == "rejected" or got.quantity <= 0:
            changes.append(
                {
                    "code": "removed",
                    "item": target["item"],
                    "was": target["quantity"],
                    "unit": target["unit"],
                }
            )
            target["quantity"] = 0
            target["total"] = 0
            continue
        if abs(got.quantity - float(target["quantity"])) > 1e-6:
            changes.append(
                {
                    "code": "quantity",
                    "item": target["item"],
                    "was": target["quantity"],
                    "now": got.quantity,
                    "unit": target["unit"],
                }
            )
            target["quantity"] = got.quantity
        if (
            got.price is not None
            and target.get("price") is not None
            and got.price != target["price"]
        ):
            changes.append(
                {"code": "price", "item": target["item"], "was": target["price"], "now": got.price}
            )
            target["price"] = got.price
        if target.get("price") is not None:
            target["total"] = round(target["price"] * float(target["quantity"]))
    delivery = po.get("delivery", "")
    if doc.delivery and doc.delivery != delivery:
        changes.append({"code": "date", "was": delivery, "now": doc.delivery})
        delivery = doc.delivery
    if "cancel" in doc.note.casefold() or (lines and all(not x["quantity"] for x in lines)):
        changes = [{"code": "cancelled"}]
    return changes, lines, delivery


def accept_change(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int, accept: bool = True
) -> dict[str, Any]:
    """The owner's answer to a partner's order change (or a supplier's changed confirmation)."""
    po = supply_chain.get_po(store, uid, bid, po_id)
    supply_chain._check_version(po, version)
    pending = po.get("pending_change")
    if not pending:
        if po["status"] == "changed" and accept:
            return supply_chain.accept(store, uid, bid, po_id, version)
        raise HTTPException(409, "NOTHING_TO_ACCEPT")
    if accept:
        po["lines"] = pending["lines"]
        po["delivery"] = pending["delivery"] or po["delivery"]
        po["total"] = sum(line.get("total") or 0 for line in po["lines"])
        if any(change["code"] == "cancelled" for change in pending["changes"]):
            po["status"] = "cancelled"
    po.setdefault("change_history", []).append(
        {
            "at": time.time(),
            "number": pending["number"],
            "changes": pending["changes"],
            "accepted": accept,
        }
    )
    po["pending_change"] = None
    saved = supply_chain._save(store, bid, po)
    _set_entry(store, bid, pending["entry_id"], status="done", accepted=accept)
    return saved


def dismiss(store: MerchantRepository, uid: str, bid: str, entry_id: str) -> dict[str, Any]:
    """The owner has seen a problem document (dealt with it outside the app)."""
    supply_chain._owned(store, uid, bid)
    _set_entry(store, bid, entry_id, status="done")
    found = store.feature_docs.get(INBOX, f"{bid}/{entry_id}")
    assert found is not None
    return found


def _sent(po: dict[str, Any], kind: str) -> bool:
    return any(
        d["kind"] == kind and d.get("direction") == "out" and d.get("status") == "sent"
        for d in po["documents"]
    )
