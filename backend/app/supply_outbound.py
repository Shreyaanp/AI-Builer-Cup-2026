"""Outbound documents and the owner's view: goods receipt, shipping notice, Close the day.

Goods that came in get a goods receipt (RECEIPT; SAP proof of delivery STPPOD on DELVRY07),
pre-filled from the shipping notice or the order: the owner fixes only differences. Goods going
out get a shipping notice (DESADV on DELVRY07). Both are written in the partner's format and wait
as pending until sent; Close the day lists what is unsent and sends it in one tap (send_all).

The phone screens read one board: five statuses (new, needs_you, sent, done, problem), one
timeline per order and the tasks that need the owner. Inbound processing is in supply_io.py.
"""

from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException

from . import supply_chain
from .merchant import MerchantRepository
from .supply_docs import DocLine, Format, Party, SupplyDoc, render
from .supply_io import (
    CLOSED,
    SHOWN_INBOX,
    _sent,
    direction_of,
    inbox,
    known_partners,
    partner_of,
    shop_party,
)

RECEIPT_SERIES = 5000000000  # SAP material documents (goods movements) start with 50…
ASN_SERIES = 8000090000


def _pending(po: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        d for d in po["documents"] if d.get("direction") == "out" and d.get("status") == "pending"
    ]


def expected(po: dict[str, Any]) -> dict[int, float]:
    """Per line, what should arrive: the shipping notice, else the confirmation, else the order."""
    return {
        line["line"]: float(line.get("shipped", line.get("confirmed", line["quantity"])))
        for line in po["lines"]
    }


def _party(row: dict[str, Any]) -> Party:
    return Party(id=row.get("id", ""), name=row.get("name", ""), system=row.get("system", "json"))


def _outbound(po: dict[str, Any], doc: SupplyDoc) -> dict[str, Any]:
    system: Format = partner_of(po).get("system") or "json"
    entry = supply_chain.document_entry(
        doc,
        sender="buyer",
        raw=render(doc, "json"),
        raw_format="json",
        translated=render(doc, system),
        translated_format=system,
        flags=[],
        reader="template",
    )
    entry["from"] = "buyer" if doc.kind == "RECEIPT" else "supplier"
    entry["direction"] = "out"
    entry["status"] = "pending"
    return entry


def _receipt_entry(
    store: MerchantRepository,
    bid: str,
    context: dict[str, Any],
    po: dict[str, Any],
    amounts: dict[int, float],
    note: str = "",
) -> dict[str, Any]:
    want = expected(po)
    today = supply_chain.shop_today(context)
    n = supply_chain._next_number(store, bid, "receipt")
    doc = SupplyDoc(
        kind="RECEIPT",
        number=str(RECEIPT_SERIES + n),
        ref=po["number"],
        issued=today.isoformat(),
        delivery=today.isoformat(),
        currency=po["currency"],
        buyer=_party(shop_party(context)),
        supplier=_party(partner_of(po)),
        lines=[
            DocLine(
                line=line["line"],
                item=(line.get("partner_item") or line["item"])[:120],
                buyer_code=line.get("buyer_code", ""),
                supplier_code=line.get("supplier_code", ""),
                quantity=amounts.get(line["line"], want[line["line"]]),
                unit=line["unit"],
                expected=want[line["line"]],
            )
            for line in po["lines"]
            if want[line["line"]] or amounts.get(line["line"])
        ]
        or [DocLine(line=10, item="?", quantity=0, unit="piece")],
        note=note[:300],
    )
    entry = _outbound(po, doc)
    entry["short"] = [
        {
            "item": line["item"],
            "quantity": round(
                want[line["line"]] - amounts.get(line["line"], want[line["line"]]), 3
            ),
            "unit": line["unit"],
        }
        for line in po["lines"]
        if amounts.get(line["line"], want[line["line"]]) < want[line["line"]] - 1e-6
    ]
    return entry


def record_receipt(
    store: MerchantRepository,
    uid: str,
    bid: str,
    po_id: str,
    version: int,
    received: dict[int, float] | None = None,
    note: str = "",
) -> dict[str, Any]:
    """Goods came in. received: the quantity per line that actually arrived (lines left out
    arrived in full). The goods receipt waits as pending until sent; the stock update goes to
    the owner's usual review the first time."""
    context = supply_chain._owned(store, uid, bid)
    po = supply_chain.get_po(store, uid, bid, po_id)
    supply_chain._check_version(po, version)
    if direction_of(po) != "in":
        raise HTTPException(409, "NOT_INCOMING")
    if po["status"] in CLOSED | {"draft"}:
        raise HTTPException(409, "NOTHING_TO_RECEIVE")
    if _sent(po, "RECEIPT"):
        raise HTTPException(409, "ALREADY_SENT")
    want = expected(po)
    amounts = {
        line: max(0.0, min(1_000_000.0, float((received or {}).get(line, qty))))
        for line, qty in want.items()
    }
    entry = _receipt_entry(store, bid, context, po, amounts, note)
    po["documents"] = [
        d for d in po["documents"] if not (d["kind"] == "RECEIPT" and d.get("status") == "pending")
    ] + [entry]
    proposal = None
    if not po.get("received"):
        changed, proposal = supply_chain.restock(store, uid, bid, context, po, amounts)
        po["received_stock"] = {name: product.stock for name, product in changed.items()}
        po["received_at"] = time.time()
    po["received"] = True
    po["received_lines"] = {str(line): qty for line, qty in amounts.items()}
    po["shortage"] = entry["short"]
    if po["status"] in {"sent", "changed", "confirmed", "dispatched"}:
        po["status"] = "received"
    saved = supply_chain._save(store, bid, po)
    return {"order": saved, "proposal": proposal, "document": entry}


def prepare_asn(
    store: MerchantRepository,
    uid: str,
    bid: str,
    po_id: str,
    version: int,
    shipped: dict[int, float] | None = None,
) -> dict[str, Any]:
    """The shipping notice for goods the shop sends the partner, pre-filled from the order."""
    context = supply_chain._owned(store, uid, bid)
    po = supply_chain.get_po(store, uid, bid, po_id)
    supply_chain._check_version(po, version)
    if direction_of(po) != "out":
        raise HTTPException(409, "NOT_OUTGOING")
    if po["status"] in CLOSED:
        raise HTTPException(409, "NOTHING_TO_SHIP")
    if po.get("pending_change"):
        raise HTTPException(409, "ACCEPT_CHANGE_FIRST")
    if _sent(po, "DESADV"):
        raise HTTPException(409, "ALREADY_SENT")
    today = supply_chain.shop_today(context)
    n = supply_chain._next_number(store, bid, "asn")
    amounts = {
        line["line"]: max(0.0, float((shipped or {}).get(line["line"], line["quantity"])))
        for line in po["lines"]
    }
    doc = SupplyDoc(
        kind="DESADV",
        number=str(ASN_SERIES + n),
        ref=po["number"],
        issued=today.isoformat(),
        delivery=po.get("delivery") or today.isoformat(),
        currency=po["currency"],
        buyer=_party(partner_of(po)),
        supplier=_party(shop_party(context)),
        lines=[
            DocLine(
                line=line["line"],
                item=(line.get("partner_item") or line["item"])[:120],
                buyer_code=line.get("buyer_code", ""),
                supplier_code=line.get("supplier_code", ""),
                quantity=amounts[line["line"]],
                unit=line["unit"],
            )
            for line in po["lines"]
            if amounts[line["line"]]
        ]
        or [DocLine(line=10, item="?", quantity=0, unit="piece")],
    )
    entry = _outbound(po, doc)
    po["documents"] = [
        d for d in po["documents"] if not (d["kind"] == "DESADV" and d.get("status") == "pending")
    ] + [entry]
    saved = supply_chain._save(store, bid, po)
    return {"order": saved, "document": entry}


def send(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int, doc_id: str
) -> dict[str, Any]:
    """The document goes to the partner; for a demo partner the delivery is simulated."""
    po = supply_chain.get_po(store, uid, bid, po_id)
    supply_chain._check_version(po, version)
    return supply_chain._save(store, bid, _mark_sent(po, doc_id))


def _mark_sent(po: dict[str, Any], doc_id: str) -> dict[str, Any]:
    document = next(
        (d for d in po["documents"] if d["id"] == doc_id and d.get("direction") == "out"), None
    )
    if document is None:
        raise HTTPException(404, "Document not found.")
    if document.get("status") == "sent":
        raise HTTPException(409, "ALREADY_SENT")
    now = time.time()
    document["status"] = "sent"
    document["sent_at"] = now
    if document["kind"] == "DESADV":
        po["shipped_at"] = now
        po["status"] = "closed"
        po["closed_at"] = now
    elif po.get("origin") == "partner":
        po["status"] = "closed"  # no invoice loop for a partner's own order
        po["closed_at"] = now
    return po


def unsent(store: MerchantRepository, bid: str) -> list[dict[str, Any]]:
    """What must still go out: pending documents, and goods received without a receipt."""
    found = []
    for po in supply_chain.all_orders(store, bid):
        if po["status"] == "cancelled":
            continue
        for document in _pending(po):
            found.append(_unsent_row(po, document["kind"], document))
        missing = (
            direction_of(po) == "in"
            and po.get("received")
            and not any(
                d["kind"] == "RECEIPT" and d.get("direction") == "out" for d in po["documents"]
            )
        )
        if missing:
            found.append(_unsent_row(po, "RECEIPT", None))
    return found


def _unsent_row(po: dict[str, Any], kind: str, document: dict[str, Any] | None) -> dict[str, Any]:
    lines = (document or {}).get("canonical", {}).get("lines") or [
        {"item": line["item"], "quantity": line["quantity"], "unit": line["unit"]}
        for line in po["lines"]
    ]
    return {
        "order_id": po["id"],
        "number": po["number"],
        "kind": kind,
        "doc_id": document["id"] if document else None,
        "partner": partner_of(po)["name"],
        "demo": bool(partner_of(po).get("demo")),
        "lines": [{"item": x["item"], "quantity": x["quantity"], "unit": x["unit"]} for x in lines],
        "short": (document or {}).get("short", []),
    }


def send_all(store: MerchantRepository, uid: str, bid: str) -> dict[str, Any]:
    """Close the day: every pending receipt and shipping notice goes out in one tap; goods
    received without a receipt get one (as received) first."""
    context = supply_chain._owned(store, uid, bid)
    sent = []
    for row in unsent(store, bid):
        po = store.feature_docs.get(supply_chain.ORDERS, f"{bid}/{row['order_id']}")
        if po is None:
            continue
        doc_id = row["doc_id"]
        if doc_id is None:
            amounts = {
                int(line): float(qty) for line, qty in (po.get("received_lines") or {}).items()
            } or expected(po)
            entry = _receipt_entry(store, bid, context, po, amounts)
            po["documents"].append(entry)
            doc_id = entry["id"]
        po = supply_chain._save(store, bid, _mark_sent(po, doc_id))
        sent.append({**row, "doc_id": doc_id})
    return {"sent": sent, "unsent": unsent(store, bid)}


# ---------------------------------------------------------------------------------------------
# What the phone shows: five statuses, one timeline per order, tasks that need the owner


def tasks(
    orders: list[dict[str, Any]], entries: list[dict[str, Any]], today: date
) -> list[dict[str, Any]]:
    """Everything that needs the owner now, most urgent first. Normal, on-time documents
    stay quiet."""
    found: list[dict[str, Any]] = []
    iso = today.isoformat()
    for po in orders:
        if po["status"] == "cancelled":
            continue
        base = {"order_id": po["id"], "number": po["number"], "partner": partner_of(po)["name"]}
        if po["status"] == "draft" and not po.get("blocked"):
            found.append({**base, "code": "approve_po", "status": "needs_you"})
        if po.get("pending_change"):
            found.append(
                {
                    **base,
                    "code": "accept_change",
                    "status": "needs_you",
                    "changes": po["pending_change"]["changes"],
                }
            )
        elif po["status"] == "changed":
            found.append(
                {
                    **base,
                    "code": "accept_change",
                    "status": "needs_you",
                    "changes": po.get("changes") or [],
                }
            )
        for document in _pending(po):
            code = "send_receipt" if document["kind"] == "RECEIPT" else "send_asn"
            found.append(
                {
                    **base,
                    "code": code,
                    "status": "problem" if document.get("short") else "needs_you",
                    "doc_id": document["id"],
                    "short": document.get("short", []),
                }
            )
        if po["status"] in CLOSED:
            continue
        pending = {d["kind"] for d in _pending(po)}
        if direction_of(po) == "in":
            receipt = any(
                d["kind"] == "RECEIPT" and d.get("direction") == "out" for d in po["documents"]
            )
            if po.get("received") and not receipt:
                found.append(
                    {
                        **base,
                        "code": "send_receipt",
                        "status": "needs_you",
                        "doc_id": None,
                        "short": [],
                    }
                )
            elif not po.get("received") and po["status"] in {
                "sent",
                "confirmed",
                "dispatched",
                "changed",
            }:
                if po.get("delivery") and po["delivery"] < iso:
                    found.append(
                        {**base, "code": "late", "status": "problem", "date": po["delivery"]}
                    )
                elif po["status"] == "dispatched" or (
                    po.get("origin") == "partner" and po.get("delivery", "") <= iso
                ):
                    found.append({**base, "code": "receive", "status": "needs_you"})
        elif "DESADV" not in pending and not po.get("pending_change"):
            due = (today + timedelta(days=1)).isoformat()
            if po.get("delivery") and po["delivery"] < iso:
                found.append({**base, "code": "late", "status": "problem", "date": po["delivery"]})
            elif po.get("delivery", "") <= due:
                found.append(
                    {**base, "code": "ship", "status": "needs_you", "date": po.get("delivery", "")}
                )
    for entry in entries:
        if entry.get("status") == "problem":
            found.append(
                {
                    "code": "problem",
                    "status": "problem",
                    "entry_id": entry["id"],
                    "order_id": entry.get("order_id") or None,
                    "number": entry["number"],
                    "partner": (entry.get("partner") or {}).get("name", ""),
                    "problem": entry.get("problem", ""),
                    "kind": entry["kind"],
                }
            )
    found.sort(key=lambda task: task["status"] != "problem")
    return found


def chip(po: dict[str, Any], today: date) -> str:
    """One of five statuses, the same everywhere: new, needs_you, sent, done, problem."""
    if po["status"] == "cancelled":
        return "done"
    iso = today.isoformat()
    received = po.get("received")
    late = (
        po["status"] not in CLOSED
        and po.get("delivery")
        and po["delivery"] < iso
        and not (received if direction_of(po) == "in" else _sent(po, "DESADV"))
    )
    if (
        po.get("problem")
        or late
        or po.get("open_flags")
        or po.get("disputed")
        or any(d.get("short") for d in _pending(po))
    ):
        return "problem"
    if po["status"] == "closed":
        return "done"
    if (
        po["status"] in {"draft", "changed", "invoiced"}
        or po.get("pending_change")
        or _pending(po)
        or (direction_of(po) == "in" and received and not _sent(po, "RECEIPT"))
    ):
        return "needs_you"
    if direction_of(po) == "in" and received:
        return "done"
    if po.get("origin") == "partner" and len(po["documents"]) <= 1:
        return "new"
    return "sent"


def timeline(po: dict[str, Any]) -> list[dict[str, Any]]:
    """Created → Changed → Shipped → Received → Closed; Changed only when something changed,
    Received only for goods coming in (the partner confirms its own receipt)."""
    docs = po["documents"]
    first = docs[0]["at"] if docs else po.get("created")
    steps: list[dict[str, Any]] = [{"step": "created", "at": first}]
    changes = [d for d in docs if d["kind"] == "ORDER_CHANGE"] + [
        d for d in docs if d["kind"] == "ORDRSP" and po.get("changes")
    ]
    if changes or po.get("pending_change"):
        steps.append(
            {
                "step": "changed",
                "at": changes[-1]["at"] if changes else None,
                "waiting": bool(po.get("pending_change") or po["status"] == "changed"),
            }
        )
    if direction_of(po) == "in":
        shipped = next(
            (d for d in docs if d["kind"] == "DESADV" and d.get("direction") != "out"), None
        )
        steps.append({"step": "shipped", "at": shipped["at"] if shipped else None})
        steps.append({"step": "received", "at": po.get("received_at")})
    else:
        steps.append({"step": "shipped", "at": po.get("shipped_at")})
    steps.append({"step": "closed", "at": po.get("closed_at")})
    return steps


def view(po: dict[str, Any], today: date) -> dict[str, Any]:
    return {
        **po,
        "direction": direction_of(po),
        "partner": partner_of(po),
        "chip": chip(po, today),
        "timeline": timeline(po),
        "expected": {str(line): qty for line, qty in expected(po).items()},
    }


def present(
    store: MerchantRepository, uid: str, bid: str, result: dict[str, Any]
) -> dict[str, Any]:
    """An action's result as the screens show it: the order (alone or under "order") as a view."""
    po = result.get("order", result)
    if not isinstance(po, dict) or "lines" not in po:
        return result
    shown = view(po, supply_chain.shop_today(store.context(uid, bid)))
    return {**result, "order": shown} if "order" in result else shown


def board(store: MerchantRepository, uid: str, bid: str) -> dict[str, Any]:
    """Everything the four supply screens need, in one read."""
    context = supply_chain._owned(store, uid, bid)
    today = supply_chain.shop_today(context)
    orders = [view(po, today) for po in supply_chain.orders(store, uid, bid)]
    entries = inbox(store, bid)[:SHOWN_INBOX]
    partners = known_partners(store, bid)
    return {
        "today": today.isoformat(),
        "orders": orders,
        "inbox": entries,
        "tasks": tasks(orders, entries, today),
        "unsent": unsent(store, bid),
        "demo": any(p.get("demo") for p in partners)
        or bool(context["business"]["fields"].get("demo")),
    }
