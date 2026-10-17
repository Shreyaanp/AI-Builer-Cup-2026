from __future__ import annotations

from pathlib import Path

from app import supply_chain, supply_io
from app.demo_data import SHOPS
from app.merchant import MerchantStore
from scripts.seed_demo_shops import seed


def test_demo_supply_seed_is_deterministic_idempotent_and_linked(tmp_path: Path) -> None:
    store = MerchantStore(str(tmp_path / "merchant.sqlite3"))
    seed(store)
    shops = tuple(
        next(shop.id for shop in SHOPS if shop.fields.currency == currency)
        for currency in ("SGD", "INR")
    )
    before = {bid: store.feature_docs.scoped(supply_chain.ORDERS, bid, 20) for bid in shops}
    assert all(len(rows) == 2 for rows in before.values())
    seed(store)
    after = {bid: store.feature_docs.scoped(supply_chain.ORDERS, bid, 20) for bid in shops}
    assert after == before
    assert {row["currency"] for rows in after.values() for row in rows} == {"SGD", "INR"}
    for bid, rows in after.items():
        assert {row["direction"] for row in rows} == {"in", "out"}
        for order in rows:
            assert order["partner"]["demo"] and order["partner"]["id"].startswith("demo-")
            assert order["documents"]
        entries = supply_io.inbox(store, bid)
        assert all(entry["partner"]["id"].startswith("demo-") for entry in entries)
        assert all(entry["order_id"] in {row["id"] for row in rows} for entry in entries)
        kinds = {doc["kind"] for row in rows for doc in row["documents"]} | {
            entry["kind"] for entry in entries
        }
        assert {"FORECAST", "ORDERS", "ORDER_CHANGE", "RECEIPT", "DESADV"} <= kinds
        outbound = [
            doc for row in rows for doc in row["documents"] if doc.get("direction") == "out"
        ]
        assert {(doc["kind"], doc["status"]) for doc in outbound} == {
            ("RECEIPT", "sent"),
            ("DESADV", "pending"),
        }
