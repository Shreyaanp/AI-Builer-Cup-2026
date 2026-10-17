"""The supply-chain loop: forecast → purchase order → confirmation → dispatch → invoice.

A small shop (the buyer) and its suppliers trade through Chalkboard even when each side runs a
different system. The flow, per order:

1. **Draft.** The forecast (TimesFM or weekday average), current stock and the business rules of
   each supplier relationship propose a reorder to the best supplier: the quantity that covers
   demand until the next delivery plus a week, rounded up to the MOQ and whole packs, priced at
   the tier it reaches, from the supplier that arrives before the shop runs out and has credit
   left. Broken rules come with one-tap fixes. The owner approves; only when they enabled it,
   an order under their approval limit to a supplier they already use goes out by itself.
2. **ORDERS** goes out in the supplier's system format (SAP IDoc XML, CSV, a chat message or
   JSON), field-mapped from the canonical document.
3. **ORDRSP** (order confirmation), **DESADV** (dispatch notice) and **INVOIC** come back in the
   supplier's format. The translator reads each into the canonical model (Gemini when live,
   parsers offline) and flags uncertain fields for a human tap. Changes (partial quantities,
   back-orders, substitutions, prices) wait for the owner. The invoice is matched three ways
   against the confirmation and the delivery.

Demo suppliers are answered by a **simulator** that writes realistic documents in their format;
it always goes through the same translator, and everything it produces is labelled simulation.
No live SAP or EDI network is connected, and no money is handled: "approve the invoice" means
the owner agrees to pay it outside the app.

Records live in the store's feature documents (SQLite locally, Firestore hosted): one document
per relationship (`supply_rules`) and per order (`supply_po`), scoped to the shop.
"""

from __future__ import annotations

import math
import time
from datetime import date, timedelta
from typing import Any, Literal
from uuid import uuid4

import structlog
from fastapi import HTTPException
from pydantic import ValidationError

from .merchant import SUPPLY_KINDS, MerchantRepository, ProductFields
from .money import exponent, to_major
from .region import shop_currency
from .supply_docs import (
    MAPPING,
    DocLine,
    DocumentTranslator,
    Flag,
    Format,
    Party,
    SupplyDoc,
    render,
)
from .supply_rules import (
    Check,
    ItemRule,
    RuleChange,
    RuleSet,
    apply_change,
    arrival,
    blocking,
    default_rules,
    evaluate,
    item_rule,
    needs_approval,
    next_tier,
    round_quantity,
    tier_price,
)

log = structlog.get_logger()

RULES = "supply_rules"
ORDERS = "supply_po"
SEQUENCE = "supply_seq"
INBOX = "supply_inbox"  # partner documents (supply_io.py)
assert (RULES, ORDERS, SEQUENCE, INBOX) == SUPPLY_KINDS  # erased with the shop (merchant.py)
COVER_DAYS = 7
MAX_DOCUMENTS = 12
MAX_ORDERS = 100
CREDIT_OPEN = {"sent", "changed", "confirmed", "dispatched", "received", "invoiced"}
Status = Literal[
    "draft",
    "sent",
    "changed",
    "confirmed",
    "dispatched",
    "received",
    "invoiced",
    "closed",
    "cancelled",
]
# The document the supplier sends next, by order status.
NEXT_FROM_SUPPLIER = {
    "sent": "ORDRSP",
    "confirmed": "DESADV",
    "dispatched": "INVOIC",
    "received": "INVOIC",
}

translator: DocumentTranslator | None = None


def _translator() -> DocumentTranslator:
    global translator
    if translator is None:
        from .settings import Settings

        translator = DocumentTranslator(Settings(_env_file=None))  # type: ignore[call-arg]
    return translator


# ---------------------------------------------------------------------------------------------
# Storage helpers


def _key(bid: str, item: str) -> str:
    return f"{bid}/{item}"


def _owned(store: MerchantRepository, uid: str, bid: str) -> dict[str, Any]:
    """The owner's shop context; raises 404/403 for anyone else."""
    return store.context(uid, bid)


def _versioned(
    store: MerchantRepository,
    kind: str,
    bid: str,
    key: str,
    data: dict[str, Any],
    expected: int,
) -> dict[str, Any]:
    """Write `data` as version expected+1, refusing when someone changed it meanwhile."""

    def change(old: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
        stored = (old or {}).get("version", 0)
        if stored != expected:
            raise HTTPException(409, "STALE")
        saved = {**data, "version": expected + 1, "updated": time.time()}
        return float(saved.get("created", time.time())), saved

    store.feature_docs.update(kind, _key(bid, key), bid, change)
    return {**data, "version": expected + 1}


def _next_number(store: MerchantRepository, bid: str, series: str) -> int:
    holder: dict[str, int] = {}

    def change(old: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
        data = dict(old or {})
        data[series] = int(data.get(series, 0)) + 1
        holder["n"] = data[series]
        return 0.0, data

    store.feature_docs.update(SEQUENCE, bid, bid, change)
    return holder["n"]


def po_number(n: int) -> str:
    return str(4500012344 + n)  # SAP purchasing number range 45…


SUPPLIER_SERIES = {"ORDRSP": 7100000000, "DESADV": 8000000000, "INVOIC": 9000000000}


# ---------------------------------------------------------------------------------------------
# Relationships and rules


def relationship(store: MerchantRepository, bid: str, sid: str) -> dict[str, Any] | None:
    return store.feature_docs.get(RULES, _key(bid, sid))


def relationships(store: MerchantRepository, uid: str, bid: str) -> list[dict[str, Any]]:
    _owned(store, uid, bid)
    found = store.feature_docs.scoped(RULES, bid, 50)
    for row in found:
        row["open_balance"] = open_balance(store, bid, row["supplier"]["id"])
    return found


def ensure_relationship(
    store: MerchantRepository,
    bid: str,
    supplier: dict[str, Any],
    currency: str,
    index: int,
) -> dict[str, Any]:
    """The stored relationship, or one with sensible starting rules (the owner edits them)."""
    existing = relationship(store, bid, supplier["id"])
    if existing:
        return existing
    rules = default_rules(supplier, currency, index, 10 ** exponent(currency))
    now = time.time()
    data = {
        "supplier": {
            "id": supplier["id"],
            "name": supplier["name"],
            "demo": bool(supplier.get("demo")),
        },
        "currency": currency,
        "rules": rules.model_dump(mode="json"),
        "suggested": True,
        "pending": None,
        "created": now,
    }
    try:
        return _versioned(store, RULES, bid, supplier["id"], data, 0)
    except HTTPException:
        # Created by a concurrent request: use theirs.
        return relationship(store, bid, supplier["id"]) or data


def rules_of(row: dict[str, Any]) -> RuleSet:
    return RuleSet.model_validate(row["rules"])


def save_rules(
    store: MerchantRepository, uid: str, bid: str, sid: str, rules: RuleSet, version: int
) -> dict[str, Any]:
    _owned(store, uid, bid)
    row = relationship(store, bid, sid)
    if not row:
        raise HTTPException(404, "Supplier not found.")
    if row["version"] != version:
        raise HTTPException(409, "STALE")
    row = {**row, "rules": rules.model_dump(mode="json"), "suggested": False, "pending": None}
    return _versioned(store, RULES, bid, sid, row, version)


def propose_rules(
    store: MerchantRepository, uid: str, bid: str, sid: str, change: RuleChange
) -> dict[str, Any]:
    """A rule change the coach prepared; nothing applies until the owner confirms it."""
    context = _owned(store, uid, bid)
    row = relationship(store, bid, sid)
    if not row:
        raise HTTPException(404, "Supplier not found.")
    currency = context["business"]["fields"].get("currency") or row["currency"]
    updated = apply_change(rules_of(row), change, currency)
    row = {
        **row,
        "pending": {
            "rules": updated.model_dump(mode="json"),
            "change": change.model_dump(mode="json", exclude_none=True),
            "created": time.time(),
        },
    }
    return _versioned(store, RULES, bid, sid, row, row["version"])


def confirm_rules(
    store: MerchantRepository, uid: str, bid: str, sid: str, version: int, apply: bool
) -> dict[str, Any]:
    _owned(store, uid, bid)
    row = relationship(store, bid, sid)
    if not row:
        raise HTTPException(404, "Supplier not found.")
    if row["version"] != version:
        raise HTTPException(409, "STALE")
    if not row.get("pending"):
        raise HTTPException(409, "Nothing is waiting to be confirmed.")
    rules = row["pending"]["rules"] if apply else row["rules"]
    row = {**row, "rules": rules, "pending": None, "suggested": row["suggested"] and not apply}
    return _versioned(store, RULES, bid, sid, row, version)


# ---------------------------------------------------------------------------------------------
# Orders


def all_orders(store: MerchantRepository, bid: str) -> list[dict[str, Any]]:
    return store.feature_docs.scoped(ORDERS, bid, MAX_ORDERS)


def orders(store: MerchantRepository, uid: str, bid: str) -> list[dict[str, Any]]:
    _owned(store, uid, bid)
    return [po for po in all_orders(store, bid) if po["status"] != "cancelled" or po["sent"]]


def get_po(store: MerchantRepository, uid: str, bid: str, po_id: str) -> dict[str, Any]:
    _owned(store, uid, bid)
    po = store.feature_docs.get(ORDERS, _key(bid, po_id))
    if not po:
        raise HTTPException(404, "Order not found.")
    return po


def open_balance(store: MerchantRepository, bid: str, sid: str, skip: str = "") -> int:
    """What the shop owes or has committed to this supplier on credit (minor units)."""
    total = 0
    for po in all_orders(store, bid):
        if po["supplier"]["id"] != sid or po["id"] == skip or po["status"] not in CREDIT_OPEN:
            continue
        if not po.get("terms_days"):
            continue
        total += po.get("invoice_total") or po["total"]
    return total


def known_supplier(store: MerchantRepository, bid: str, sid: str, skip: str = "") -> bool:
    return any(
        po["supplier"]["id"] == sid and po["id"] != skip and po.get("sent")
        for po in all_orders(store, bid)
    )


def _save(store: MerchantRepository, bid: str, po: dict[str, Any]) -> dict[str, Any]:
    return _versioned(store, ORDERS, bid, po["id"], po, po["version"])


def _check_version(po: dict[str, Any], version: int) -> None:
    if po["version"] != version:
        raise HTTPException(409, "STALE")


def price_line(line: dict[str, Any], rule: ItemRule | None) -> None:
    line["price"] = tier_price(rule, line["quantity"], line.get("list_price"))
    line["total"] = round(line["price"] * line["quantity"]) if line["price"] is not None else None
    tier = next_tier(rule, line["quantity"])
    line["next_tier"] = tier.model_dump() if tier else None


def recheck(store: MerchantRepository, bid: str, po: dict[str, Any], today: date) -> None:
    """Totals, broken rules and approval reasons, after any change to a draft."""
    row = relationship(store, bid, po["supplier"]["id"])
    rules = rules_of(row) if row else RuleSet()
    for line in po["lines"]:
        price_line(line, item_rule(rules, line["item"]))
    po["total"] = sum(line["total"] or 0 for line in po["lines"])
    rule = item_rule(rules, po["lines"][0]["item"]) if po["lines"] else None
    po["delivery"] = arrival(today, rule.lead_days if rule else 1).isoformat()
    po["checks"] = [
        check.model_dump(mode="json")
        for check in evaluate(
            po,
            rules,
            open_balance(store, bid, po["supplier"]["id"], skip=po["id"]),
            known_supplier(store, bid, po["supplier"]["id"], skip=po["id"]),
            today,
        )
    ]
    po["approval_required"] = needs_approval([Check.model_validate(c) for c in po["checks"]])
    po["blocked"] = bool(blocking([Check.model_validate(c) for c in po["checks"]]))
    po["auto_send_allowed"] = rules.auto_send and not po["approval_required"] and not po["blocked"]


# ---------------------------------------------------------------------------------------------
# Drafting a reorder from the forecast


def shop_today(context: dict[str, Any]) -> date:
    from .sales import today_for

    return today_for(context["business"]["fields"])


def need_from_forecast(
    product: dict[str, Any] | None, forecast: dict[str, Any], item: str, today: date
) -> dict[str, Any]:
    """Stock, run-out day and demand for one item from the forecast rows."""
    from .sourcing import matches

    rows = [
        row
        for row in forecast.get("predictions") or []
        if isinstance(row, dict)
        and row.get("item")
        and row.get("date")
        and row.get("quantity") is not None
        and (matches(row["item"], item) or matches(item, row["item"]))
    ]
    rows.sort(key=lambda row: row["date"])
    stock = (product or {}).get("stock")
    known = stock is not None
    left = float(stock or 0)
    runs_out = ""
    for row in rows:
        left -= float(row["upper"] if row.get("upper") is not None else row["quantity"])
        if left < 0 and not runs_out:
            runs_out = str(row["date"])
    daily = (sum(float(row["quantity"]) for row in rows) / len(rows)) if rows else 0.0
    return {
        "stock": float(stock or 0),
        "stock_known": known,
        "runs_out": runs_out,
        "daily": round(daily, 2),
        "method": forecast.get("method") if rows else "none",
        "rows": len(rows),
        "horizon_end": (today + timedelta(days=len(rows) or 7)).isoformat(),
    }


async def draft_reorder(
    store: MerchantRepository,
    uid: str,
    bid: str,
    item: str,
    quantity: float | None,
    forecaster: Any,
    generator: Any,
    demo_owner: str,
    supplier_id: str = "",
) -> dict[str, Any]:
    """Draft the purchase order the forecast and rules call for (nothing is sent)."""
    import anyio

    from . import sourcing

    context = await anyio.to_thread.run_sync(_owned, store, uid, bid)
    fields = context["business"]["fields"]
    currency = shop_currency(fields)
    today = shop_today(context)
    rows = await anyio.to_thread.run_sync(store.sales_history, uid, bid)
    forecast = (await forecaster.forecast(rows, today, context["inventory"])).model_dump(
        mode="json"
    )
    inventory = context["inventory"]
    target = pick_item(item, inventory, forecast, today)
    if not target:
        return {"status": "needs_item"}
    product = next(
        (p for p in inventory if p["name"].casefold() == target.casefold()),
        next((p for p in inventory if sourcing.matches(p["name"], target)), None),
    )
    unit = (product or {}).get("unit") or "kg"
    need = need_from_forecast(product, forecast, target, today)
    need_by = need["runs_out"] or ""
    if quantity:
        wanted = float(quantity)
    elif need["daily"]:
        # Demand until the delivery lands, plus a week of cover, minus what is on the shelf.
        wanted = max(0.0, need["daily"] * (COVER_DAYS + 2) - need["stock"])
    else:
        wanted = 0.0
    candidates = await anyio.to_thread.run_sync(supplier_candidates, store, bid, target, currency)
    if not candidates:
        found = await sourcing.find(
            store, uid, bid, target, wanted or None, unit, generator, demo_owner
        )
        for index, card in enumerate(found["suppliers"][:4]):
            shop = await anyio.to_thread.run_sync(store.public_shop, card["id"])
            if shop:
                await anyio.to_thread.run_sync(
                    ensure_relationship, store, bid, shop, currency, index
                )
        candidates = await anyio.to_thread.run_sync(
            supplier_candidates, store, bid, target, currency
        )
    if not candidates:
        return {"status": "no_supplier", "item": target}
    options = [
        option
        for option in (
            quote(store, bid, candidate, target, unit, wanted, need_by, today)
            for candidate in candidates
        )
        if option
    ]
    if not options:
        return {"status": "no_supplier", "item": target}
    options.sort(
        key=lambda o: (
            not o["on_time"],
            not o["fits_credit"],
            o["total"] / max(o["quantity_in_unit"], 0.001),
        )
    )
    best = (
        next((o for o in options if o["supplier"]["id"] == supplier_id), options[0])
        if supplier_id
        else options[0]
    )
    faster = next((o for o in options if o["on_time"] and o is not best), None)
    number = await anyio.to_thread.run_sync(_next_number, store, bid, "po")
    now = time.time()
    po: dict[str, Any] = {
        "id": uuid4().hex[:16],
        "number": po_number(number),
        "status": "draft",
        "sent": False,
        "auto_sent": False,
        "created": now,
        "currency": currency,
        "buyer": {"id": bid, "name": fields.get("name", ""), "system": "json"},
        "supplier": best["supplier"],
        "terms_days": best["terms_days"],
        "lines": [best["line"]],
        "total": 0,
        "need_by": need_by,
        "delivery": "",
        "reason": {
            "item": target,
            "unit": unit,
            "stock": need["stock"],
            "stock_known": need["stock_known"],
            "runs_out": need["runs_out"],
            "daily": need["daily"],
            "method": need["method"],
            "wanted": round(wanted, 2),
            "owner_quantity": bool(quantity),
            "tier_min": best["tier_min"],
            "moq": best["moq"],
            "on_time": best["on_time"],
            "headroom": best["headroom"],
            "options": len(options),
        },
        "alternatives": [
            {
                "supplier_id": o["supplier"]["id"],
                "name": o["supplier"]["name"],
                "demo": o["supplier"]["demo"],
                "total": o["total"],
                "price": o["line"]["price"],
                "unit": o["line"]["unit"],
                "quantity": o["line"]["quantity"],
                "arrives": o["arrives"],
                "on_time": o["on_time"],
                "system": o["supplier"]["system"],
            }
            for o in options
            if o is not best
        ][:3],
        "faster_supplier": faster["supplier"]["id"] if faster and not best["on_time"] else None,
        "documents": [],
        "backorders": [],
        "received": False,
        "simulated": bool(best["supplier"]["demo"]),
        "version": 0,
    }
    await anyio.to_thread.run_sync(recheck, store, bid, po, today)
    po = await anyio.to_thread.run_sync(_save, store, bid, po)
    if po["auto_send_allowed"]:
        po = await anyio.to_thread.run_sync(_send, store, bid, po, True)
    return {"status": "drafted", "order": po}


def pick_item(
    item: str, inventory: list[dict[str, Any]], forecast: dict[str, Any], today: date
) -> str:
    """The named item, else the stocked item that runs out first."""
    from .sourcing import matches

    if item.strip():
        named = next(
            (p["name"] for p in inventory if p["name"].casefold() == item.strip().casefold()),
            None,
        )
        return named or next(
            (p["name"] for p in inventory if matches(p["name"], item)), item.strip()[:80]
        )
    soonest: tuple[str, str] | None = None
    for product in inventory:
        if product.get("stock") is None:
            continue
        need = need_from_forecast(product, forecast, product["name"], today)
        if need["runs_out"] and (soonest is None or need["runs_out"] < soonest[0]):
            soonest = (need["runs_out"], product["name"])
    return soonest[1] if soonest else ""


def supplier_candidates(
    store: MerchantRepository, bid: str, item: str, currency: str
) -> list[dict[str, Any]]:
    """Suppliers the shop has a relationship with that stock this item."""
    from .sourcing import matches

    found = []
    for row in store.feature_docs.scoped(RULES, bid, 50):
        shop = store.public_shop(row["supplier"]["id"])
        if not shop or (shop.get("currency") or currency) != currency:
            continue
        products = [p for p in shop.get("products", []) if matches(p["name"], item)]
        if products:
            found.append({"row": row, "shop": shop, "product": products[0]})
    return found


def quote(
    store: MerchantRepository,
    bid: str,
    candidate: dict[str, Any],
    item: str,
    unit: str,
    wanted: float,
    need_by: str,
    today: date,
) -> dict[str, Any] | None:
    from .sourcing import convert

    row, product = candidate["row"], candidate["product"]
    rules = rules_of(row)
    rule = item_rule(rules, product["name"]) or item_rule(rules, item)
    supplier_unit = product["unit"]
    amount = convert(wanted, unit, supplier_unit) if wanted else 0.0
    if amount is None:
        return None
    quantity = round_quantity(rule, amount) if rule else max(1.0, math.ceil(amount))
    if not quantity:
        quantity = rule.moq if rule and rule.moq else 1.0
    price = tier_price(rule, quantity, int(product["price"]))
    total = round((price or 0) * quantity)
    arrives = arrival(today, rule.lead_days if rule else 1).isoformat()
    balance = open_balance(store, bid, row["supplier"]["id"])
    headroom = rules.credit_limit - balance if rules.terms_days and rules.credit_limit else None
    tier_min = 0.0
    for tier in rule.tiers if rule else []:
        if quantity >= tier.min_quantity:
            tier_min = tier.min_quantity
    back = convert(quantity, supplier_unit, unit)
    return {
        "supplier": {
            "id": row["supplier"]["id"],
            "name": row["supplier"]["name"],
            "demo": row["supplier"]["demo"],
            "system": rules.system_format,
        },
        "terms_days": rules.terms_days,
        "line": {
            "line": 10,
            "item": product["name"],
            "buyer_code": f"CB-{product['name'][:3].upper()}-01",
            "supplier_code": rule.supplier_code if rule else "",
            "quantity": quantity,
            "unit": supplier_unit,
            "list_price": int(product["price"]),
            "price": price,
            "total": total,
        },
        "quantity_in_unit": back if back is not None else quantity,
        "total": total,
        "arrives": arrives,
        "on_time": not need_by or arrives <= need_by,
        "fits_credit": headroom is None or headroom >= total,
        "headroom": headroom,
        "tier_min": tier_min,
        "moq": rule.moq if rule else 0,
    }


# ---------------------------------------------------------------------------------------------
# Owner actions on a draft


def apply_fix(
    store: MerchantRepository,
    uid: str,
    bid: str,
    po_id: str,
    version: int,
    fix: dict[str, Any],
) -> dict[str, Any]:
    """One-tap fixes: a quantity (round up to the MOQ, fit the credit), pay cash this time."""
    context = _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    if po["status"] != "draft":
        raise HTTPException(409, "Only a draft can be changed.")
    kind = fix.get("kind")
    if kind == "quantity":
        line = next((x for x in po["lines"] if x["line"] == fix.get("line")), None)
        value = float(fix.get("value") or 0)
        if line is None or not 0 < value <= 1_000_000:
            raise HTTPException(422, "Pick a line and a quantity above zero.")
        line["quantity"] = round(value, 3)
    elif kind == "cash":
        po["terms_days"] = 0
        po["cash_this_time"] = True
    else:
        raise HTTPException(422, "Unknown fix.")
    recheck(store, bid, po, shop_today(context))
    if po.get("cash_this_time"):
        po["checks"] = [c for c in po["checks"] if c["code"] != "over_credit"]
        po["blocked"] = any(c["blocking"] for c in po["checks"])
    return _save(store, bid, po)


def approve(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int
) -> dict[str, Any]:
    """The owner's tap: the purchase order goes out in the supplier's format."""
    _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    if po["status"] != "draft":
        raise HTTPException(409, "This order was already sent.")
    if po.get("blocked"):
        raise HTTPException(409, "RULES_BROKEN")
    return _send(store, bid, po, False)


def _send(store: MerchantRepository, bid: str, po: dict[str, Any], auto: bool) -> dict[str, Any]:
    doc = po_document(po)
    system: Format = po["supplier"]["system"]
    po["documents"].append(
        document_entry(
            doc,
            sender="buyer",
            raw=render(doc, "json"),
            raw_format="json",
            translated=render(doc, system),
            translated_format=system,
            flags=[],
            reader="template",
        )
    )
    po["status"] = "sent"
    po["sent"] = True
    po["auto_sent"] = auto
    po["sent_at"] = time.time()
    return _save(store, bid, po)


def cancel(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int
) -> dict[str, Any]:
    _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    if po["status"] not in {"draft", "sent", "changed"}:
        raise HTTPException(409, "This order can no longer be cancelled here.")
    po["status"] = "cancelled"
    return _save(store, bid, po)


# ---------------------------------------------------------------------------------------------
# Documents


def po_document(po: dict[str, Any]) -> SupplyDoc:
    return SupplyDoc(
        kind="ORDERS",
        number=po["number"],
        issued=date.fromtimestamp(po["created"]).isoformat(),
        delivery=po["delivery"],
        currency=po["currency"],
        buyer=Party(**po["buyer"]),
        supplier=Party(**po["supplier"]),
        terms_days=po["terms_days"],
        lines=[
            DocLine(
                line=line["line"],
                item=line["item"],
                buyer_code=line.get("buyer_code", ""),
                supplier_code=line.get("supplier_code", ""),
                quantity=line["quantity"],
                unit=line["unit"],
                price=line["price"],
                total=line["total"],
            )
            for line in po["lines"]
        ],
        total=po["total"],
    )


def document_entry(
    doc: SupplyDoc,
    sender: str,
    raw: str,
    raw_format: Format,
    translated: str,
    translated_format: Format,
    flags: list[Flag],
    reader: str,
) -> dict[str, Any]:
    return {
        "id": uuid4().hex[:10],
        "kind": doc.kind,
        "number": doc.number,
        "at": time.time(),
        "from": sender,
        "raw": raw,
        "raw_format": raw_format,
        "translated": translated,
        "translated_format": translated_format,
        "mapping": [
            # Objects, not pairs: Firestore refuses arrays inside arrays.
            {"field": canonical, "source": source}
            for canonical, source in MAPPING[
                raw_format if sender == "supplier" else translated_format
            ]
        ],
        "canonical": doc.model_dump(mode="json"),
        "flags": [f.model_dump(mode="json") for f in flags],
        "reader": reader,
    }


def supplier_document(
    store: MerchantRepository,
    bid: str,
    po: dict[str, Any],
    kind: str,
    variant: str,
    today: date,
) -> SupplyDoc:
    """What the (simulated) supplier's system issues next. Realistic, deterministic."""
    row = relationship(store, bid, po["supplier"]["id"])
    rules = rules_of(row) if row else RuleSet()
    n = _next_number(store, bid, kind.lower())
    number = str(SUPPLIER_SERIES[kind] + 4500 + n)
    lead = max(
        [rule.lead_days for line in po["lines"] if (rule := item_rule(rules, line["item"]))] or [1]
    )
    delivery = po.get("delivery") or arrival(today, lead).isoformat()
    lines: list[DocLine] = []
    for index, line in enumerate(po["lines"]):
        rule = item_rule(rules, line["item"])
        quantity = float(line.get("confirmed", line["quantity"]))
        price = line.get("confirmed_price", line["price"])
        doc_line = DocLine(
            line=line["line"],
            item=line.get("substitute") or line["item"],
            supplier_code=line.get("supplier_code", ""),
            buyer_code="" if po["supplier"]["system"] == "text" else line.get("buyer_code", ""),
            quantity=quantity,
            unit=line["unit"],
            price=price,
            total=round(price * quantity) if price is not None else None,
        )
        if kind == "ORDRSP" and index == 0 and variant == "partial" and line["quantity"] >= 2:
            step = rule.pack if rule and rule.pack else 1
            now_qty = max(step, math.floor(line["quantity"] * 0.75 / step) * step)
            if now_qty < line["quantity"]:
                doc_line.quantity = now_qty
                doc_line.total = round((price or 0) * now_qty)
                doc_line.status = "backordered"
                doc_line.backorder_quantity = round(line["quantity"] - now_qty, 3)
                doc_line.backorder_date = (
                    date.fromisoformat(delivery) + timedelta(days=3)
                ).isoformat()
        if kind == "ORDRSP" and index == 0 and variant == "substitute":
            name = (
                rule.substitutes[0]
                if rule and rule.substitutes
                else f"{line['item']} (other brand)"
            )
            doc_line.status = "substituted"
            doc_line.substitute_for = line["item"]
            doc_line.item = name[:120]
            doc_line.supplier_code = f"{line.get('supplier_code') or 'MAT'}-S"
        if kind == "INVOIC" and index == 0 and variant == "price_mismatch":
            # A classic three-way-match failure: the list price instead of the agreed tier.
            listed = line.get("list_price") or price
            if listed is not None and listed != price:
                doc_line.price = listed
            elif price is not None:
                doc_line.price = round(price * 1.05)
            doc_line.total = round((doc_line.price or 0) * quantity)
        if kind in {"DESADV", "INVOIC"}:
            if not quantity:
                continue  # Nothing confirmed on this line (rejected): not shipped or billed.
            doc_line.quantity = float(line.get("shipped", quantity))
            if doc_line.price is not None:
                doc_line.total = round(doc_line.price * doc_line.quantity)
        lines.append(doc_line)
    total = sum(line.total or 0 for line in lines)
    return SupplyDoc(
        kind=kind,  # type: ignore[arg-type]
        number=number,
        ref=po["number"],
        issued=today.isoformat(),
        delivery=delivery,
        currency=po["currency"],
        buyer=Party(**po["buyer"]),
        supplier=Party(**po["supplier"]),
        terms_days=po["terms_days"] if kind in {"ORDRSP", "INVOIC"} else None,
        lines=lines,
        total=total if kind != "DESADV" else None,
        note="Simulated supplier document (demo)" if po["supplier"]["demo"] else "",
    )


async def simulate(
    store: MerchantRepository,
    uid: str,
    bid: str,
    po_id: str,
    version: int,
    variant: str,
) -> dict[str, Any]:
    """The supplier simulator: the next document, in the supplier's own format, read back
    through the same translator a real document would go through."""
    import anyio

    context = await anyio.to_thread.run_sync(_owned, store, uid, bid)
    po = await anyio.to_thread.run_sync(get_po, store, uid, bid, po_id)
    _check_version(po, version)
    kind = NEXT_FROM_SUPPLIER.get(po["status"])
    if kind is None:
        raise HTTPException(409, "The supplier has nothing to send right now.")
    today = shop_today(context)
    doc = await anyio.to_thread.run_sync(supplier_document, store, bid, po, kind, variant, today)
    raw = render(doc, po["supplier"]["system"])
    return await ingest(store, bid, po, raw, today, simulated=True)


async def inbound(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int, text: str
) -> dict[str, Any]:
    """A document the supplier sent outside the simulator (pasted or uploaded)."""
    import anyio

    context = await anyio.to_thread.run_sync(_owned, store, uid, bid)
    po = await anyio.to_thread.run_sync(get_po, store, uid, bid, po_id)
    _check_version(po, version)
    if po["status"] not in NEXT_FROM_SUPPLIER:
        raise HTTPException(409, "The supplier has nothing to send right now.")
    return await ingest(store, bid, po, text, shop_today(context), simulated=False)


async def ingest(
    store: MerchantRepository,
    bid: str,
    po: dict[str, Any],
    raw: str,
    today: date,
    simulated: bool,
) -> dict[str, Any]:
    import anyio

    if len(po["documents"]) >= MAX_DOCUMENTS:
        raise HTTPException(409, "This order has too many documents.")
    try:
        doc, flags, reader, fmt = await _translator().read(raw, po, today)
    except (ValueError, ValidationError) as error:
        log.info("supply_document_unreadable", reason=str(error)[:120])
        raise HTTPException(422, "UNREADABLE_DOCUMENT") from error
    expected = NEXT_FROM_SUPPLIER.get(po["status"])
    if doc.kind != expected:
        raise HTTPException(409, f"EXPECTED_{expected}")
    if doc.ref and doc.ref != po["number"]:
        flags.append(
            Flag(
                id=uuid4().hex[:8],
                field="ref",
                reason="reference",
                value=doc.ref,
                options=[po["number"]],
            )
        )
    if doc.currency in {"", "XXX"}:
        doc.currency = po["currency"]
    entry = document_entry(
        doc,
        sender="supplier",
        raw=raw,
        raw_format=fmt,
        translated=render(doc, "json"),
        translated_format="json",
        flags=flags,
        reader=reader,
    )
    entry["simulated"] = simulated
    po["documents"].append(entry)
    apply_document(store, bid, po, doc, flags)
    return await anyio.to_thread.run_sync(_save, store, bid, po)


def line_for(po: dict[str, Any], number: int) -> dict[str, Any] | None:
    return next((line for line in po["lines"] if line["line"] == number), None)


def apply_document(
    store: MerchantRepository,
    bid: str,
    po: dict[str, Any],
    doc: SupplyDoc,
    flags: list[Flag],
) -> None:
    """Move the order to the state this document puts it in."""
    row = relationship(store, bid, po["supplier"]["id"])
    rules = rules_of(row) if row else RuleSet()
    if doc.kind == "ORDRSP":
        changes = []
        for got in doc.lines:
            line = line_for(po, got.line)
            if line is None:
                continue
            line["confirmed"] = got.quantity
            line["confirmed_price"] = got.price if got.price is not None else line["price"]
            line["line_status"] = got.status
            line["backorder_quantity"] = got.backorder_quantity
            line["backorder_date"] = got.backorder_date
            line["substitute"] = got.item if got.status == "substituted" else ""
            rule = item_rule(rules, line["item"])
            if got.status == "backordered" or (got.quantity < line["quantity"]):
                if rule and not rule.partial_ok:
                    changes.append({"code": "partial_not_allowed", "line": line["line"]})
                if got.backorder_quantity and rule and not rule.backorder_ok:
                    changes.append({"code": "backorder_not_allowed", "line": line["line"]})
                changes.append(
                    {
                        "code": "partial",
                        "line": line["line"],
                        "now": got.quantity,
                        "later": got.backorder_quantity,
                        "date": got.backorder_date,
                    }
                )
            if got.status == "substituted":
                allowed = bool(
                    rule
                    and any(
                        name.casefold() in got.item.casefold()
                        or got.item.casefold() in name.casefold()
                        for name in rule.substitutes
                    )
                )
                changes.append(
                    {
                        "code": "substitute" if allowed else "substitute_not_allowed",
                        "line": line["line"],
                        "name": got.item,
                    }
                )
            if got.status == "rejected":
                changes.append({"code": "rejected", "line": line["line"]})
            if got.price is not None and line["price"] is not None and got.price != line["price"]:
                changes.append(
                    {
                        "code": "price_changed",
                        "line": line["line"],
                        "was": line["price"],
                        "now": got.price,
                    }
                )
        po["changes"] = changes
        po["confirmation"] = doc.number
        if doc.delivery:
            po["delivery"] = doc.delivery
        po["status"] = "changed" if changes or flags else "confirmed"
        if po["status"] == "confirmed":
            settle_confirmation(po)
    elif doc.kind == "DESADV":
        for got in doc.lines:
            line = line_for(po, got.line)
            if line is not None:
                line["shipped"] = got.quantity
                if abs(got.quantity - float(line.get("confirmed", line["quantity"]))) > 1e-6:
                    flags.append(
                        Flag(
                            id=uuid4().hex[:8],
                            field=f"line:{line['line']}:quantity",
                            reason="quantity",
                            value=f"{got.quantity:g}",
                            options=[
                                f"{got.quantity:g}",
                                f"{line.get('confirmed', line['quantity']):g}",
                            ],
                            line=line["line"],
                        )
                    )
                    po["documents"][-1]["flags"] = [f.model_dump(mode="json") for f in flags]
        po["dispatch"] = doc.number
        if doc.delivery:
            po["delivery"] = doc.delivery
        po["status"] = "dispatched" if not po.get("received") else "received"
    elif doc.kind == "INVOIC":
        match = []
        for got in doc.lines:
            line = line_for(po, got.line)
            if line is None:
                continue
            agreed = line.get("confirmed_price", line["price"])
            delivered = float(line.get("shipped", line.get("confirmed", line["quantity"])))
            line["invoiced_quantity"] = got.quantity
            line["invoiced_price"] = got.price
            if got.price is not None and agreed is not None and got.price != agreed:
                flags.append(
                    Flag(
                        id=uuid4().hex[:8],
                        field=f"line:{line['line']}:price",
                        reason="price",
                        value=str(got.price),
                        options=[str(agreed), str(got.price)],
                        line=line["line"],
                    )
                )
                match.append(
                    {"code": "price", "line": line["line"], "agreed": agreed, "billed": got.price}
                )
            if abs(got.quantity - delivered) > 1e-6:
                flags.append(
                    Flag(
                        id=uuid4().hex[:8],
                        field=f"line:{line['line']}:quantity",
                        reason="quantity",
                        value=f"{got.quantity:g}",
                        options=[f"{delivered:g}", f"{got.quantity:g}"],
                        line=line["line"],
                    )
                )
                match.append(
                    {
                        "code": "quantity",
                        "line": line["line"],
                        "delivered": delivered,
                        "billed": got.quantity,
                    }
                )
        po["documents"][-1]["flags"] = [f.model_dump(mode="json") for f in flags]
        po["invoice"] = doc.number
        po["invoiced"] = True
        po["invoice_total"] = doc.total
        po["match"] = match
        po["status"] = "invoiced"
    po["open_flags"] = open_flags(po)


def settle_confirmation(po: dict[str, Any]) -> None:
    """Accepted confirmation: quantities, back-orders and substitutes become the order."""
    po["backorders"] = [
        {
            "item": line["item"],
            "quantity": line["backorder_quantity"],
            "unit": line["unit"],
            "date": line.get("backorder_date", ""),
        }
        for line in po["lines"]
        if line.get("backorder_quantity")
    ]
    for line in po["lines"]:
        if line.get("line_status") == "rejected":
            line["confirmed"] = 0
    po["confirmed_total"] = sum(
        round((line.get("confirmed_price") or 0) * float(line.get("confirmed", line["quantity"])))
        for line in po["lines"]
    )


def open_flags(po: dict[str, Any]) -> int:
    return sum(
        1
        for document in po["documents"]
        for item in document["flags"]
        if item.get("resolved") is None
    )


def resolve_flag(
    store: MerchantRepository,
    uid: str,
    bid: str,
    po_id: str,
    version: int,
    flag_id: str,
    value: str,
) -> dict[str, Any]:
    """The owner settles one uncertain field (taps one of the options, or types the value)."""
    _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    value = value.strip()[:80]
    for document in po["documents"]:
        for item in document["flags"]:
            if item["id"] != flag_id:
                continue
            if item.get("resolved") is not None:
                raise HTTPException(409, "Already settled.")
            if not value:
                raise HTTPException(422, "Pick a value.")
            item["resolved"] = value
            apply_resolution(po, document, item, value)
            po["open_flags"] = open_flags(po)
            return _save(store, bid, po)
    raise HTTPException(404, "Flag not found.")


def apply_resolution(
    po: dict[str, Any], document: dict[str, Any], item: dict[str, Any], value: str
) -> None:
    line = line_for(po, item["line"]) if item.get("line") is not None else None
    field = item["field"]
    if field.endswith(":price") and line is not None:
        try:
            price = int(value)
        except ValueError as error:
            raise HTTPException(422, "Pick one of the prices.") from error
        line["invoiced_price"] = price
        po["invoice_total"] = sum(
            round(
                (x.get("invoiced_price") or x.get("confirmed_price") or 0)
                * float(x.get("invoiced_quantity", x["quantity"]))
            )
            for x in po["lines"]
        )
        if price != item["value"]:
            po["disputed"] = True
    elif field.endswith(":quantity") and line is not None:
        try:
            amount = float(value)
        except ValueError as error:
            raise HTTPException(422, "Pick one of the quantities.") from error
        if document["kind"] == "INVOIC":
            line["invoiced_quantity"] = amount
        else:
            line["shipped"] = amount
    elif field == "delivery":
        po["delivery"] = value[:10]
    elif field.endswith(":backorder_date") and line is not None:
        line["backorder_date"] = value[:10]
    elif field.endswith(":unit") and line is not None:
        document["canonical"]["lines"] = [
            {**x, "unit": value} if x["line"] == item["line"] else x
            for x in document["canonical"]["lines"]
        ]
    elif field.endswith(":item_code"):
        if line is None:
            line = next((x for x in po["lines"] if x["item"] == value), None)
        if value not in {x["item"] for x in po["lines"]} and line is not None:
            line["line_status"] = "rejected"


def accept(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int
) -> dict[str, Any]:
    """The owner accepts the supplier's changes (ORDRSP), or approves the invoice to pay."""
    _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    if open_flags(po):
        raise HTTPException(409, "RESOLVE_FLAGS")
    if po["status"] == "changed":
        settle_confirmation(po)
        po["status"] = "confirmed"
        po["changes_accepted"] = True
    elif po["status"] == "invoiced":
        if not po.get("received"):
            raise HTTPException(409, "RECEIVE_FIRST")
        po["status"] = "closed"
        po["closed_at"] = time.time()
    else:
        raise HTTPException(409, "Nothing to accept.")
    return _save(store, bid, po)


def receive(
    store: MerchantRepository, uid: str, bid: str, po_id: str, version: int
) -> dict[str, Any]:
    """Goods arrived: the order is marked received and the stock update goes to the usual
    review (the owner confirms it before the menu changes)."""
    context = _owned(store, uid, bid)
    po = get_po(store, uid, bid, po_id)
    _check_version(po, version)
    if po["status"] not in {"dispatched", "invoiced"} or po.get("received"):
        raise HTTPException(409, "Nothing is on its way.")
    if open_flags(po):
        raise HTTPException(409, "RESOLVE_FLAGS")
    amounts = {
        line["line"]: float(line.get("shipped", line.get("confirmed", line["quantity"])))
        for line in po["lines"]
    }
    changed, proposal = restock(store, uid, bid, context, po, amounts)
    po["received"] = True
    po["received_at"] = time.time()
    po["received_stock"] = {name: product.stock for name, product in changed.items()}
    if po["status"] == "dispatched":
        po["status"] = "received"
    saved = _save(store, bid, po)
    return {"order": saved, "proposal": proposal}


def restock(
    store: MerchantRepository,
    uid: str,
    bid: str,
    context: dict[str, Any],
    po: dict[str, Any],
    amounts: dict[int, float],
) -> tuple[dict[str, ProductFields], dict[str, Any] | None]:
    """The stock update for goods that came in, prepared for the owner's usual review (the
    menu changes only when they confirm it). amounts: received quantity per order line."""
    from .merchant import ProposalRequest
    from .sourcing import convert, matches

    changed: dict[str, ProductFields] = {}
    for line in po["lines"]:
        amount_in = float(amounts.get(line["line"], 0))
        if not amount_in:
            continue
        for product in context["inventory"]:
            name = line.get("substitute") or line["item"]
            if not (
                matches(product["name"], name)
                or matches(name, product["name"])
                or matches(product["name"], line["item"])
            ):
                continue
            amount = convert(amount_in, line["unit"], product["unit"])
            if amount is None:
                continue
            base = product.get("stock") or 0
            changed[product["name"]] = ProductFields(
                name=product["name"],
                category=product.get("category", ""),
                price=product["price"],
                unit=product["unit"],
                stock=min(1_000_000, int(base + round(amount))),
                available=True,
            )
            break
    proposal = None
    if changed:
        proposal = store.propose(
            uid,
            ProposalRequest(
                kind="inventory",
                business_id=bid,
                revision=context["business"]["revision"],
                products=list(changed.values()),
            ),
        )
    return changed, proposal


# ---------------------------------------------------------------------------------------------
# What the coach sees


def money(minor: int | None, currency: str) -> float | None:
    return None if minor is None else to_major(minor, currency)


def summary(po: dict[str, Any]) -> dict[str, Any]:
    currency = po["currency"]
    return {
        "order_id": po["id"],
        "po_number": po["number"],
        "status": po["status"],
        "supplier": po["supplier"]["name"],
        "demo_supplier": po["supplier"]["demo"],
        "supplier_system": po["supplier"]["system"],
        "lines": [
            {
                "item": line["item"],
                "quantity": line["quantity"],
                "unit": line["unit"],
                "price": money(line["price"], currency),
                **({"confirmed": line["confirmed"]} if "confirmed" in line else {}),
                **(
                    {
                        "backorder": line["backorder_quantity"],
                        "backorder_date": line["backorder_date"],
                    }
                    if line.get("backorder_quantity")
                    else {}
                ),
                **({"substitute": line["substitute"]} if line.get("substitute") else {}),
            }
            for line in po["lines"]
        ],
        "total": money(po["total"], currency),
        "currency": currency,
        "deliver_on": po["delivery"],
        "need_by": po.get("need_by") or None,
        "credit_days": po["terms_days"],
        "reason": po.get("reason"),
        "broken_rules": [c for c in po.get("checks", []) if c["blocking"]]
        if po["status"] == "draft"
        else [],
        "needs_owner_tap": po["status"] == "draft"
        or po["status"] == "changed"
        or po["status"] == "invoiced",
        "open_flags": po.get("open_flags", 0),
        "auto_sent": po.get("auto_sent", False),
        "documents": [d["kind"] for d in po["documents"]],
    }


def rules_summary(row: dict[str, Any]) -> dict[str, Any]:
    currency = row["currency"]
    rules = rules_of(row)
    return {
        "supplier_id": row["supplier"]["id"],
        "supplier": row["supplier"]["name"],
        "demo_supplier": row["supplier"]["demo"],
        "credit_days": rules.terms_days,
        "credit_limit": money(rules.credit_limit, currency),
        "approval_over": money(rules.approval_over, currency),
        "auto_send": rules.auto_send,
        "system": rules.system_format,
        "items": [
            {
                "item": rule.item,
                "moq": rule.moq,
                "pack": rule.pack,
                "unit": rule.unit,
                "lead_days": rule.lead_days,
                "tiers": [
                    {"from": tier.min_quantity, "price": money(tier.price, currency)}
                    for tier in rule.tiers
                ],
                "substitutes": rule.substitutes,
                "partial_ok": rule.partial_ok,
                "backorder_ok": rule.backorder_ok,
            }
            for rule in rules.items[:8]
        ],
        **({"pending_change": row["pending"]["change"]} if row.get("pending") else {}),
    }
