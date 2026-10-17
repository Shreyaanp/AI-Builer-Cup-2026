"""Coach tools for the supply chain: supplier rules, forecast-drafted purchase orders, and the
documents exchanged with partners (inbound orders, changes, forecasts; outbound goods receipts
and shipping notices).

Rule changes and drafted orders wait for the owner's tap on their card (supply_chain.py does
the work). The partner-document tools act only when the owner asks for that action itself
("send the shipping notice", "received everything except 5 milk"), and their card shows what
went out (supply_io.py does the work).
"""

import re
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from . import coordinator
from .coordinator import DEMO_OWNER_UID, MerchantContext, _card, _generator, _invalid, current


def _supplier_row(ctx: MerchantContext, supplier: str) -> dict[str, Any] | None:
    """A relationship by id, by name ("Shree Ganesh"), or the only one there is."""
    from . import supply_chain

    rows = supply_chain.relationships(ctx.store, ctx.uid, ctx.business_id or "")
    wanted = (supplier or "").strip().casefold()
    if not wanted and len(rows) == 1:
        return rows[0]
    for row in rows:
        if row["supplier"]["id"] == supplier or (
            wanted and wanted in row["supplier"]["name"].casefold()
        ):
            return row
    return None


def get_supplier_rules(supplier: str = "") -> dict[str, Any]:
    """The business rules agreed with each supplier: credit terms (cash, 7 or 30 days) and
    credit limit, the approval limit, auto-send, the supplier's system format, and per item the
    MOQ, pack size, lead time, price tiers, allowed substitutes, partial deliveries and
    back-orders. supplier: a name or id to see one supplier; empty for all."""
    from . import supply_chain

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    if supplier:
        row = _supplier_row(ctx, supplier)
        if not row:
            return {"status": "unknown_supplier", "instruction": "Ask which supplier they mean."}
        return {"suppliers": [supply_chain.rules_summary(row)]}
    rows = supply_chain.relationships(ctx.store, ctx.uid, ctx.business_id)
    if not rows:
        return {
            "status": "no_suppliers",
            "instruction": "No supplier is set up yet. Offer to draft a reorder (draft_reorder), "
            "which finds suppliers and sets up starting rules the owner can change.",
        }
    return {"suppliers": [supply_chain.rules_summary(row) for row in rows]}


def set_supplier_rules(
    supplier: str,
    credit_days: int | None = None,
    credit_limit: float | None = None,
    approval_over: float | None = None,
    auto_send: bool | None = None,
    system_format: str = "",
    item: str = "",
    moq: float | None = None,
    pack: float | None = None,
    lead_days: int | None = None,
    tier_quantity: float | None = None,
    tier_price: float | None = None,
    substitutes: list[str] | None = None,
    partial_ok: bool | None = None,
    backorder_ok: bool | None = None,
) -> dict[str, Any]:
    """Prepare a change to the rules with one supplier, for the owner to confirm with a tap.
    Pass only what the owner said. supplier: name or id from get_supplier_rules. credit_days: 0
    (cash), 7 or 30. credit_limit and approval_over: amounts in the shop currency ("orders
    above 2000 need my OK"). auto_send: send orders under the approval limit by themselves.
    Item rules need item: moq (minimum order quantity), pack (sold in multiples of), lead_days,
    a price tier (tier_quantity + tier_price per unit: "50 kg or more at 58"), substitutes
    (allowed replacements), partial_ok (accept part deliveries), backorder_ok (accept the rest
    later). system_format: idoc (SAP), csv, text or json."""
    from . import supply_chain
    from .supply_rules import RuleChange

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    row = _supplier_row(ctx, supplier)
    if not row:
        return {
            "status": "unknown_supplier",
            "instruction": "Call get_supplier_rules and ask which supplier they mean.",
        }
    values = {
        "terms_days": credit_days,
        "credit_limit": credit_limit,
        "approval_over": approval_over,
        "auto_send": auto_send,
        "system_format": system_format or None,
        "item": item,
        "moq": moq,
        "pack": pack,
        "lead_days": lead_days,
        "tier_quantity": tier_quantity,
        "tier_price": tier_price,
        "substitutes": substitutes,
        "partial_ok": partial_ok,
        "backorder_ok": backorder_ok,
    }
    try:
        change = RuleChange.model_validate({k: v for k, v in values.items() if v is not None})
        saved = supply_chain.propose_rules(
            ctx.store, ctx.uid, ctx.business_id, row["supplier"]["id"], change
        )
    except (ValidationError, ValueError) as error:
        return _invalid(error, ctx)
    return {
        "status": "needs_owner_tap",
        "card_id": _card(ctx, "supply_rules", saved),
        "supplier": row["supplier"]["name"],
        "change": change.model_dump(exclude_none=True, exclude_defaults=True),
        "instruction": "Say what will change in one line and ask them to confirm on the card.",
    }


async def draft_reorder(item: str = "", quantity: float | None = None) -> dict[str, Any]:
    """Draft a purchase order from the forecast, stock and the supplier rules: how much to
    order (covering demand until delivery plus a week, rounded to the MOQ and packs), from the
    best supplier (price tier, arrives before the shop runs out, credit left). Use it for
    "reorder flour", "what should I order?", "plan my purchase order" or when a forecast shows
    an item running out. item: only if the owner named one (else the item that runs out
    first); quantity only if they said it. Nothing is sent: the owner approves the card.
    Explain the choice in one line from reason (stock, runs_out, supplier, price tier, arrival,
    credit) and name any broken rule. If the supplier is demo, say it is a simulated supplier."""
    from . import supply_chain
    from .forecast import ForecastService

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    service = coordinator.forecaster
    if service is None:
        from .settings import Settings

        service = ForecastService(Settings(_env_file=None))  # type: ignore[call-arg]
    try:
        result = await supply_chain.draft_reorder(
            ctx.store,
            ctx.uid,
            ctx.business_id,
            (item or "").strip()[:80],
            quantity if quantity and quantity > 0 else None,
            service,
            _generator(),
            DEMO_OWNER_UID,
        )
    except HTTPException as error:
        return _invalid(error, ctx)
    if result["status"] == "needs_item":
        return {
            "status": "needs_item",
            "instruction": "No stocked item is forecast to run out. Ask which item to reorder.",
        }
    if result["status"] == "no_supplier":
        return {
            "status": "no_supplier",
            "instruction": "Say no supplier near them stocks this item; ask for another name.",
        }
    order = result["order"]
    return {
        **supply_chain.summary(order),
        "card_id": _card(ctx, "purchase_order", order),
        "status": "sent_automatically" if order.get("auto_sent") else "needs_owner_tap",
    }


def get_purchase_orders() -> dict[str, Any]:
    """The shop's purchase orders, newest first, with their documents so far (ORDERS sent,
    ORDRSP confirmation, DESADV dispatch, INVOIC invoice), status, back-orders and fields
    waiting for the owner's check (open_flags). Use it for "where is my flour order?", "did
    they confirm?" or "has the invoice come?"."""
    from . import supply_chain

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    found = supply_chain.orders(ctx.store, ctx.uid, ctx.business_id)
    return {"orders": [supply_chain.summary(po) for po in found[:8]]}


# ---------------------------------------------------------------------------------------------
# Inbound and outbound with partners (supply_io.py)

KIND_WORDS = {
    "FORECAST": "forecast",
    "ORDERS": "new order",
    "ORDER_CHANGE": "order change",
    "ORDRSP": "order confirmation",
    "DESADV": "shipping notice",
    "INVOIC": "invoice",
    "RECEIPT": "goods receipt",
}
DOCUMENT_WORDS = {
    "forecast": "FORECAST",
    "order": "ORDERS",
    "new order": "ORDERS",
    "purchase order": "ORDERS",
    "po": "ORDERS",
    "change": "ORDER_CHANGE",
    "order change": "ORDER_CHANGE",
    "confirmation": "ORDRSP",
    "shipping notice": "DESADV",
    "asn": "DESADV",
    "dispatch": "DESADV",
    "invoice": "INVOIC",
    "receipt": "RECEIPT",
    "goods receipt": "RECEIPT",
}
# Spoken quantities ("five milk", "paanch doodh"); the model usually sends digits.
NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "twelve": 12,
    "fifteen": 15,
    "twenty": 20,
    "ek": 1,
    "teen": 3,
    "char": 4,
    "paanch": 5,
    "panch": 5,
    "das": 10,
}
UNIT_NOISE = re.compile(
    r"\d+(?:[.,]\d+)?|\b(?:kg|kgs|g|l|litres?|liters?|ltr|pcs?|pieces?|packs?|of)\b"
)
RECEIVABLE = {"sent", "changed", "confirmed", "dispatched", "invoiced", "received"}


def _supply_card(
    ctx: MerchantContext, view: str, order: dict[str, Any] | None = None, **extra: Any
) -> str:
    from . import supply_chain, supply_outbound

    context = supply_chain._owned(ctx.store, ctx.uid, ctx.business_id or "")
    data = {
        "view": view,
        "order": supply_outbound.view(order, supply_chain.shop_today(context)) if order else None,
        **extra,
    }
    return _card(ctx, "supply", data)


def _plain_order(po: dict[str, Any]) -> dict[str, Any]:
    from . import supply_io

    partner = supply_io.partner_of(po)
    return {
        "order_id": po["id"],
        "number": po["number"],
        "partner": partner["name"],
        "demo_partner": bool(partner.get("demo")),
        "goods": "coming in to the shop"
        if supply_io.direction_of(po) == "in"
        else "the shop ships them to the partner",
        "lines": [
            {"item": line["item"], "quantity": line["quantity"], "unit": line["unit"]}
            for line in po["lines"]
        ],
        "deliver_on": po.get("delivery", ""),
        "status": po["status"],
    }


def _find_order(
    ctx: MerchantContext,
    order: str,
    fits: Callable[[dict[str, Any]], bool],
    item: str = "",
) -> dict[str, Any] | None:
    """An order by id, number, partner or item; else the newest one that fits."""
    from . import supply_chain, supply_io
    from .sourcing import matches

    rows = [po for po in supply_chain.orders(ctx.store, ctx.uid, ctx.business_id or "") if fits(po)]
    wanted = (order or "").strip()
    if wanted:
        lowered = wanted.casefold()
        for po in rows:
            if (
                po["id"] == wanted
                or po["number"] == wanted
                or lowered in supply_io.partner_of(po)["name"].casefold()
                or any(matches(line["item"], lowered) for line in po["lines"])
            ):
                return po
        return None
    if item:
        for po in rows:
            if any(matches(x["item"], item) or matches(item, x["item"]) for x in po["lines"]):
                return po
    return rows[0] if rows else None


def _amounts(phrases: list[str] | None, po: dict[str, Any]) -> dict[int, float]:
    """'5 milk', '5 l milk', 'milk 5', 'five milk' → {line: 5} for the matching order line."""
    from .sourcing import matches

    found: dict[int, float] = {}
    for phrase in phrases or []:
        text = phrase.strip().casefold()
        for word, value in NUMBER_WORDS.items():
            text = re.sub(rf"\b{word}\b", str(value), text)
        amount = re.search(r"\d+(?:[.,]\d+)?", text)
        if not amount:
            continue
        name = " ".join(UNIT_NOISE.sub(" ", text).split())
        for line in po["lines"]:
            names = [line["item"], line.get("partner_item") or "", line.get("product") or ""]
            if not name or any(n and (matches(n, name) or matches(name, n)) for n in names):
                found[line["line"]] = float(amount.group(0).replace(",", "."))
                break
    return found


def show_inbound(kind: str = "") -> dict[str, Any]:
    """What partners sent the shop, newest first: forecasts, new orders, order changes,
    confirmations, shipping notices and invoices, with what each changed and its status (new,
    needs_you, done, problem), plus what needs the owner now. Use it for "show me today's
    inbound", "what came in?", "any order changes?" or "what needs me?". kind: forecast, order,
    change or empty for all. Say the first two or three in plain words (never IDoc codes) and
    name what needs the owner; the app shows them as cards."""
    from . import supply_outbound

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    board = supply_outbound.board(ctx.store, ctx.uid, ctx.business_id)
    want = DOCUMENT_WORDS.get((kind or "").strip().casefold(), "")
    entries = [e for e in board["inbox"] if not want or e["kind"] == want][:6]
    return {
        "documents": [
            {
                "what": KIND_WORDS.get(e["kind"], e["kind"]),
                "from": (e.get("partner") or {}).get("name", "unknown partner"),
                "demo_partner": bool((e.get("partner") or {}).get("demo")),
                "number": e["number"],
                "status": e["status"],
                "problem": e.get("problem") or None,
                "changes": e.get("changes", [])[:4],
                "lines": e.get("lines", [])[:3],
            }
            for e in entries
        ],
        "needs_you": [
            {
                k: v
                for k, v in task.items()
                if k in {"code", "partner", "number", "short", "problem"}
            }
            for task in board["tasks"][:5]
        ],
        "card_id": _supply_card(ctx, "coming" if entries else "needs"),
    }


def accept_order_change(order: str = "", accept: bool = True) -> dict[str, Any]:
    """Accept (or with accept=false decline) a partner's order change, or a supplier's changed
    confirmation, that waits for the owner: "accept the change", "OK, take 15". order: number,
    partner or item if the owner named one; empty for the one waiting."""
    from . import supply_io

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    po = _find_order(
        ctx, order, lambda p: bool(p.get("pending_change")) or p["status"] == "changed"
    )
    if po is None:
        return {"status": "nothing_waiting", "instruction": "Say no order change is waiting."}
    changes = (po.get("pending_change") or {}).get("changes") or po.get("changes") or []
    try:
        saved = supply_io.accept_change(
            ctx.store, ctx.uid, ctx.business_id, po["id"], po["version"], accept
        )
    except HTTPException as error:
        return _invalid(error, ctx)
    return {
        **_plain_order(saved),
        "status": "accepted" if accept else "declined",
        "changes": changes,
        "card_id": _supply_card(ctx, "order", saved),
    }


def approve_and_send_po(order: str = "") -> dict[str, Any]:
    """Approve a drafted purchase order and send it to the supplier in the supplier's format
    (SAP IDoc, CSV, chat text or JSON) when the owner says so: "approve it", "send the flour
    order". order: number, supplier or item; empty for the newest draft. If a rule is broken
    (below MOQ, over credit), name it and point to the fix on the card: nothing is sent."""
    from . import supply_chain

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    po = _find_order(ctx, order, lambda p: p["status"] == "draft")
    if po is None:
        return {"status": "no_draft", "instruction": "Say no order waits; offer draft_reorder."}
    if po.get("blocked"):
        return {
            **supply_chain.summary(po),
            "status": "rules_broken",
            "card_id": _card(ctx, "purchase_order", po),
        }
    try:
        saved = supply_chain.approve(ctx.store, ctx.uid, ctx.business_id, po["id"], po["version"])
    except HTTPException as error:
        return _invalid(error, ctx)
    return {
        **supply_chain.summary(saved),
        "status": "sent",
        "card_id": _card(ctx, "purchase_order", saved),
    }


def record_goods_received(
    order: str = "",
    missing: list[str] | None = None,
    received_only: list[str] | None = None,
    send: bool = True,
) -> dict[str, Any]:
    """Record a delivery that arrived and send the goods receipt to the supplier. Everything on
    the order counts as received except what the owner says: "received everything except 5
    milk" → missing=["5 milk"]; "only 10 kg flour came" → received_only=["10 flour"]; "all
    received" → neither. order: number, supplier or item if named. send=false only if the owner
    wants to check the receipt first. The stock update still waits for their tap on the review
    card. In one line: what came, what was short, that the receipt went to the supplier."""
    from . import supply_io, supply_outbound

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    named = " ".join(missing or received_only or [])
    po = _find_order(
        ctx,
        order,
        lambda p: (
            supply_io.direction_of(p) == "in"
            and p["status"] in RECEIVABLE
            and not supply_io._sent(p, "RECEIPT")
        ),
        " ".join(UNIT_NOISE.sub(" ", named.casefold()).split()),
    )
    if po is None:
        return {
            "status": "nothing_to_receive",
            "instruction": "Say no delivery is open; ask which order arrived.",
        }
    want = supply_outbound.expected(po)
    received = {line: max(0.0, want[line] - qty) for line, qty in _amounts(missing, po).items()}
    received.update(_amounts(received_only, po))
    try:
        result = supply_outbound.record_receipt(
            ctx.store, ctx.uid, ctx.business_id, po["id"], po["version"], received
        )
        saved = result["order"]
        if send:
            saved = supply_outbound.send(
                ctx.store,
                ctx.uid,
                ctx.business_id,
                saved["id"],
                saved["version"],
                result["document"]["id"],
            )
    except HTTPException as error:
        return _invalid(error, ctx)
    proposal = result.get("proposal")
    if proposal:
        ctx.proposals[proposal["id"]] = proposal
    return {
        **_plain_order(saved),
        "status": "receipt_sent" if send else "receipt_ready",
        "received": [
            {
                "item": line["item"],
                "quantity": received.get(line["line"], want[line["line"]]),
                "unit": line["unit"],
            }
            for line in saved["lines"]
        ],
        "short": result["document"]["short"],
        "receipt_number": result["document"]["number"],
        "receipt_format": result["document"]["translated_format"],
        **({"proposal_id": proposal["id"]} if proposal else {}),
        "card_id": _supply_card(ctx, "order", saved),
    }


def send_asn(order: str = "") -> dict[str, Any]:
    """Send the shipping notice (advance ship notice, ASN) for goods the shop ships to a
    partner, written in the partner's format (SAP DELVRY07 for SAP partners): "send the
    shipping notice", "tell Harbour Café it is on its way". order: number, partner or item."""
    from . import supply_io, supply_outbound

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    po = _find_order(
        ctx,
        order,
        lambda p: (
            supply_io.direction_of(p) == "out"
            and p["status"] not in supply_io.CLOSED
            and not supply_io._sent(p, "DESADV")
        ),
    )
    if po is None:
        return {"status": "nothing_to_ship", "instruction": "Say no order is waiting to ship."}
    if po.get("pending_change"):
        return {
            **_plain_order(po),
            "status": "change_waiting",
            "instruction": "Say the partner changed this order: accept the change first.",
            "card_id": _supply_card(ctx, "order", po),
        }
    try:
        result = supply_outbound.prepare_asn(
            ctx.store, ctx.uid, ctx.business_id, po["id"], po["version"]
        )
        saved = supply_outbound.send(
            ctx.store,
            ctx.uid,
            ctx.business_id,
            po["id"],
            result["order"]["version"],
            result["document"]["id"],
        )
    except HTTPException as error:
        return _invalid(error, ctx)
    return {
        **_plain_order(saved),
        "status": "sent",
        "asn_number": result["document"]["number"],
        "format": result["document"]["translated_format"],
        "card_id": _supply_card(ctx, "order", saved),
    }


def send_pending_documents() -> dict[str, Any]:
    """Send every goods receipt and shipping notice that has not gone out yet (what Close the
    day reminds about): "send everything", "send the receipt", "send what's pending"."""
    from . import supply_outbound

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    try:
        result = supply_outbound.send_all(ctx.store, ctx.uid, ctx.business_id)
    except HTTPException as error:
        return _invalid(error, ctx)
    return {
        "status": "sent" if result["sent"] else "nothing_to_send",
        "sent": [
            {"what": KIND_WORDS[row["kind"]], "to": row["partner"], "order": row["number"]}
            for row in result["sent"]
        ],
        "card_id": _supply_card(ctx, "send"),
    }


def view_document_as_sap(order: str = "", document: str = "") -> dict[str, Any]:
    """Show a supply document as SAP sees it (the IDoc XML) beside plain words: "show the
    shipping notice in SAP", "view the order as IDoc". order: number, partner or item;
    document: order, change, forecast, confirmation, shipping notice, invoice or receipt."""

    ctx = current.get()
    if not ctx or not ctx.business_id:
        return {"status": "needs_business"}
    po = _find_order(ctx, order, lambda p: True)
    if po is None:
        return {"status": "unknown_order", "instruction": "Ask which order they mean."}
    want = DOCUMENT_WORDS.get((document or "").strip().casefold(), "")
    docs = [d for d in po["documents"] if not want or d["kind"] == want]
    if not docs:
        return {
            **_plain_order(po),
            "status": "no_document",
            "instruction": "Say that document does not exist for this order yet.",
        }
    chosen = docs[-1]
    sap = next((text for text in (chosen["translated"], chosen["raw"]) if "<IDOCTYP>" in text), "")
    basic = re.search(r"<IDOCTYP>(\w+)</IDOCTYP>", sap)
    return {
        **_plain_order(po),
        "status": "shown",
        "what": KIND_WORDS.get(chosen["kind"], chosen["kind"]),
        "idoc_type": basic.group(1) if basic else None,
        "card_id": _supply_card(ctx, "sap", po, document_id=chosen["id"]),
    }


SUPPLY_TOOLS: list[Callable[..., Any]] = [
    get_supplier_rules,
    set_supplier_rules,
    draft_reorder,
    get_purchase_orders,
    show_inbound,
    accept_order_change,
    approve_and_send_po,
    record_goods_received,
    send_asn,
    send_pending_documents,
    view_document_as_sap,
]
SUPPLY_CARD_TOOLS = {
    "set_supplier_rules",
    "draft_reorder",
    "show_inbound",
    "accept_order_change",
    "approve_and_send_po",
    "record_goods_received",
    "send_asn",
    "send_pending_documents",
    "view_document_as_sap",
}
