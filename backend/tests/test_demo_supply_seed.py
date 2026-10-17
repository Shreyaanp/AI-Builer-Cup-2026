from __future__ import annotations

from pathlib import Path

from app import supply_chain
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
    for rows in after.values():
        for order in rows:
            assert order["supplier"]["demo"]
            assert order["supplier"]["id"].startswith("demo-")
            assert order["documents"]
            for document in order["documents"]:
                assert document["order_id"] == order["id"]
                assert document["partner_id"] == order["supplier"]["id"]
        kinds = {doc["kind"] for row in rows for doc in row["documents"]}
        assert {"FORECAST", "ORDERS", "ORDER_CHANGE", "RECEIPT", "DESADV"} <= kinds
        outbound = [
            doc for row in rows for doc in row["documents"] if doc["kind"] in {"RECEIPT", "DESADV"}
        ]
        assert {doc["status"] for doc in outbound} == {"sent", "pending"}
