"""Fixed, fictional supply-chain records for one demo shop per currency."""

from __future__ import annotations

from datetime import date
from typing import Any

from . import supply_chain
from .demo_data import SHOPS
from .merchant import MerchantRepository
from .supply_docs import DocLine, Party, SupplyDoc


def seed(store: MerchantRepository) -> None:
    """Insert the showcase once; fixed IDs and put semantics make reruns idempotent."""
    selections: list[tuple[Any, str, str, int]] = []
    # One demo shop per currency in the catalogue, so every region shown has its own showcase.
    for region, demo in enumerate({s.fields.currency: s for s in reversed(SHOPS)}.values()):
        selections.append((demo, demo.fields.currency, demo.fields.currency.lower(), region))
    for demo, currency, tag, region in selections:
        bid = demo.id
        buyer = Party(id=bid, name=demo.fields.name, system="json")
        partners: list[dict[str, Any]] = [
            {
                "id": f"demo-{tag}-partner-a",
                "name": "Sunrise Supply (Demo)",
                "demo": True,
                "system": "json",
            },
            {
                "id": f"demo-{tag}-partner-b",
                "name": "Harbour Trade (Demo)",
                "demo": True,
                "system": "idoc",
            },
        ]
        products = demo.products[:2]
        for index, partner in enumerate(partners):
            supply_chain.ensure_relationship(store, bid, partner, currency, index)
        for index, partner in enumerate(partners):
            po_id = f"demo-{tag}-order-{index + 1}"
            if store.feature_docs.get(supply_chain.ORDERS, f"{bid}/{po_id}"):
                continue
            product = products[index % len(products)]
            qty = 12 + index * 4
            number = str(4500091000 + index + region * 100)
            supplier = Party(id=partner["id"], name=partner["name"], system=partner["system"])
            line = DocLine(
                line=10,
                item=product.name,
                buyer_code=f"CB-{index + 1:03}",
                supplier_code=f"SUP-{index + 1:03}",
                quantity=qty,
                unit=product.unit,
                price=product.price,
                total=product.price * qty,
            )
            create = SupplyDoc(
                kind="ORDERS",
                number=number,
                issued="2026-10-17",
                delivery="2026-10-20",
                currency=currency,
                buyer=buyer,
                supplier=supplier,
                lines=[line],
                total=product.price * qty,
                note="Synthetic demo order create",
            )
            docs = [
                supply_chain.document_entry(
                    create,
                    "supplier",
                    create.model_dump_json(),
                    "json",
                    create.model_dump_json(),
                    "json",
                    [],
                    "demo_seed",
                )
            ]
            if index == 0:
                forecast = create.model_dump(mode="json")
                forecast.update(
                    kind="FORECAST",
                    number=f"FC-{tag}-01",
                    ref=number,
                    note="Synthetic partner forecast",
                )
                docs.insert(
                    0,
                    {
                        "id": f"demo-forecast-{tag}",
                        "kind": "FORECAST",
                        "number": forecast["number"],
                        "from": "supplier",
                        "status": "received",
                        "order_id": po_id,
                        "partner_id": partner["id"],
                        "canonical": forecast,
                    },
                )
                changed = create.model_copy(
                    update={
                        "number": f"CH-{tag}-01",
                        "ref": number,
                        "delivery": "2026-10-21",
                        "note": "Synthetic order change: quantity and date",
                    }
                )
                changed.lines[0].quantity = qty + 3
                changed.lines[0].total = product.price * (qty + 3)
                changed_data = changed.model_dump(mode="json")
                docs.append(
                    {
                        "id": f"demo-change-{tag}",
                        "kind": "ORDER_CHANGE",
                        "number": changed.number,
                        "from": "supplier",
                        "status": "processed",
                        "order_id": po_id,
                        "partner_id": partner["id"],
                        "canonical": changed_data,
                    }
                )
                docs.append(
                    {
                        "id": f"demo-receipt-{tag}",
                        "kind": "RECEIPT",
                        "number": f"GR-{tag}-01",
                        "from": "buyer",
                        "status": "sent",
                        "order_id": po_id,
                        "partner_id": partner["id"],
                        "canonical": {"quantity": qty, "shortage": 0},
                    }
                )
            else:
                docs.append(
                    {
                        "id": f"demo-asn-{tag}",
                        "kind": "DESADV",
                        "number": f"ASN-{tag}-01",
                        "from": "buyer",
                        "status": "pending",
                        "order_id": po_id,
                        "partner_id": partner["id"],
                        "canonical": {"quantity": qty},
                    }
                )
            for document in docs:
                document["order_id"] = po_id
                document["partner_id"] = partner["id"]
            data = {
                "id": po_id,
                "number": number,
                "created": date(2026, 10, 17).toordinal(),
                "updated": date(2026, 10, 17).toordinal(),
                "version": 1,
                "status": "received" if index == 0 else "confirmed",
                "sent": True,
                "received": index == 0,
                "simulated": True,
                "currency": currency,
                "buyer": buyer.model_dump(),
                "supplier": {**partner},
                "lines": [line.model_dump()],
                "delivery": "2026-10-20",
                "terms_days": 0,
                "total": product.price * qty,
                "documents": docs,
                "checks": [],
                "backorders": [],
                "reason": "Demo supply-chain story",
            }
            store.feature_docs.put(
                supply_chain.ORDERS, f"{bid}/{po_id}", bid, float(data["created"]), data
            )
