"""Synthetic supply-chain partners and documents for the demo (fictional businesses only).

Two demo partners per shop: a buyer that runs SAP (it sends a forecast, an order and an order
change as IDocs, and gets a shipping notice back) and a supplier that sends JSON (its order is
received with a goods receipt). Every document goes through the same pipeline a real partner's
document would (supply_io.py), so the demo shows real processing, not canned screens.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import HTTPException

from . import supply_chain, supply_io, supply_outbound
from .demo_data import SHOPS
from .merchant import MerchantRepository
from .supply_docs import DocLine, Party, SupplyDoc, parse, render


def buyer(tag: str) -> dict[str, Any]:
    return {
        "id": f"demo-{tag}-buyer",
        "name": "Harbour Café (Demo)",
        "system": "idoc",
        "demo": True,
    }


def supplier(tag: str) -> dict[str, Any]:
    return {
        "id": f"demo-{tag}-supplier",
        "name": "Sunrise Supply (Demo)",
        "system": "json",
        "demo": True,
    }


def _item(context: dict[str, Any]) -> dict[str, Any]:
    stocked = [p for p in context["inventory"] if p.get("stock") is not None]
    return (stocked or context["inventory"])[0]


def _tag(context: dict[str, Any]) -> str:
    # One demo shop per area currency: the currency keeps partner ids apart.
    return str(supply_chain.shop_currency(context["business"]["fields"])).casefold()


def script(context: dict[str, Any], today: date) -> list[SupplyDoc]:
    """The buyer's story: forecast → order create → order change (fewer, a day later)."""
    tag = _tag(context)
    product = _item(context)
    shop = supply_io.shop_party(context)
    partner = buyer(tag)
    price = round(product["price"] * 0.8)  # the trade price a regular buyer gets
    currency = supply_chain.shop_currency(context["business"]["fields"])

    def doc(
        kind: str, number: str, quantity: float, day: date, ref: str = "", note: str = ""
    ) -> SupplyDoc:
        return SupplyDoc(
            kind=kind,  # type: ignore[arg-type]
            number=number,
            ref=ref,
            issued=today.isoformat(),
            delivery=day.isoformat(),
            currency=currency,
            buyer=Party(id=partner["id"], name=partner["name"], system="idoc"),
            supplier=Party(id=shop["id"], name=shop["name"]),
            lines=[
                DocLine(
                    line=10,
                    item=product["name"],
                    buyer_code="HC-0001",
                    quantity=quantity,
                    unit=product["unit"],
                    price=price,
                    total=price * round(quantity),
                )
            ],
            total=price * round(quantity),
            note=note,
        )

    number = "4700001201"
    return [
        doc("FORECAST", "5500000301", 20, today + timedelta(days=2), note="Next week's need"),
        doc("ORDERS", number, 20, today + timedelta(days=2)),
        doc("ORDER_CHANGE", "4700001202", 15, today + timedelta(days=3), ref=number),
    ]


def next_document(store: MerchantRepository, uid: str, bid: str) -> dict[str, Any]:
    """The demo buyer sends its next document (as an SAP IDoc) through the real pipeline."""
    context = store.context(uid, bid)
    if not context["inventory"]:
        raise HTTPException(409, "NO_ITEMS")
    today = supply_chain.shop_today(context)
    seen = {(row["kind"], row["number"]) for row in supply_io.inbox(store, bid)}
    for doc in script(context, today):
        if (doc.kind, doc.number) in seen:
            continue
        raw = render(doc, "idoc")
        read, fmt, _ = parse(raw, today)
        return supply_io.process(store, bid, context, read, fmt, raw, "parser")
    raise HTTPException(409, "DEMO_DONE")


def _supplier_order(context: dict[str, Any], today: date) -> SupplyDoc:
    """The supplier's order create: a standing order it books for the shop (JSON)."""
    tag = _tag(context)
    product = _item(context)
    partner = supplier(tag)
    shop = supply_io.shop_party(context)
    price = round(product["price"] * 0.6)
    return SupplyDoc(
        kind="ORDERS",
        number=f"SO-{tag.upper()}-2210",
        issued=today.isoformat(),
        delivery=today.isoformat(),
        currency=supply_chain.shop_currency(context["business"]["fields"]),
        buyer=Party(id=shop["id"], name=shop["name"]),
        supplier=Party(id=partner["id"], name=partner["name"], system="json"),
        lines=[
            DocLine(
                line=10,
                item=product["name"],
                supplier_code="SUP-001",
                quantity=12,
                unit=product["unit"],
                price=price,
                total=price * 12,
            )
        ],
        total=price * 12,
        note="Standing order (demo)",
    )


def seed_shop(store: MerchantRepository, uid: str, bid: str) -> None:
    """Preload one shop: a sent goods receipt and a shipping notice still to send.
    Idempotent: documents already processed are not processed again."""
    context = store.context(uid, bid)
    if not context["inventory"]:
        return
    today = supply_chain.shop_today(context)
    order = _supplier_order(context, today)
    result = supply_io.process(store, bid, context, order, "json", render(order, "json"), "parser")
    po = result["order"]
    if po and not po.get("received"):
        saved = supply_outbound.record_receipt(store, uid, bid, po["id"], po["version"])
        supply_outbound.send(
            store, uid, bid, po["id"], saved["order"]["version"], saved["document"]["id"]
        )
    for _ in range(3):
        try:
            result = next_document(store, uid, bid)
        except HTTPException:
            break
    sold = next(
        (
            po
            for po in supply_chain.all_orders(store, bid)
            if supply_io.direction_of(po) == "out" and po["status"] not in supply_io.CLOSED
        ),
        None,
    )
    if sold and sold.get("pending_change"):
        sold = supply_io.accept_change(store, uid, bid, sold["id"], sold["version"])
    if sold and not any(d["kind"] == "DESADV" for d in sold["documents"]):
        supply_outbound.prepare_asn(store, uid, bid, sold["id"], sold["version"])


def seed(store: MerchantRepository, uid: str = "demo-world-owner") -> None:
    """The first demo shop of each area currency (owned by the seed owner)."""
    seen: set[str] = set()
    for demo in SHOPS:
        if demo.fields.currency not in seen:
            seen.add(demo.fields.currency)
            seed_shop(store, uid, demo.id)
