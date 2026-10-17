"""Local, private supply-chain demo using the existing forecast and document loop."""

from datetime import timedelta
from typing import Any

import anyio

from . import supply_chain
from .forecast import ForecastService
from .merchant import BusinessFields, MerchantRepository, ProductFields, ProposalRequest
from .settings import Settings
from .supply_rules import ItemRule, PriceTier, RuleSet

NAME = "Milk shop (Supply demo)"


async def create_showcase(store: MerchantRepository, uid: str) -> str:
    def seed() -> str:
        for business in store.list_businesses(uid):
            if business["fields"]["name"] == NAME:
                return str(business["id"])
        fields = BusinessFields(
            name=NAME,
            category="Grocery",
            location="Bengaluru (demo)",
            currency="INR",
            timezone="Asia/Kolkata",
            lat=12.97,
            lng=77.59,
        )
        proposal = store.propose(
            uid,
            ProposalRequest(
                kind="business",
                business=fields,
                products=[ProductFields(name="Milk", unit="l", price=6000, stock=15)],
            ),
        )
        bid = str(store.commit(uid, proposal["id"], proposal["digest"])["business_id"])
        today = supply_chain.shop_today(store.context(uid, bid))
        history = [
            {
                "date": (today - timedelta(days=i)).isoformat(),
                "item": "Milk",
                "quantity": 3,
                "revenue": 18000,
            }
            for i in range(1, 43)
        ]
        pending = store.prepare_sales(uid, bid, history)
        store.save_sales(uid, bid, pending["id"], pending["digest"])
        sid = "demo-supply-showcase-dairy"
        store.seed_demo_shop(
            "chalkboard-supply-demo",
            sid,
            fields.model_copy(
                update={
                    "name": "Fresh Dairy (Demo)",
                    "demo": True,
                    "supplier": True,
                }
            ),
            [ProductFields(name="Milk", unit="l", price=5000)],
        )
        supplier = store.public_shop(sid)
        assert supplier is not None
        row = supply_chain.ensure_relationship(store, bid, supplier, "INR", 0)
        rules = RuleSet(
            system_format="idoc",
            items=[
                ItemRule(
                    item="Milk",
                    unit="l",
                    moq=12,
                    pack=6,
                    lead_days=1,
                    tiers=[
                        PriceTier(min_quantity=0, price=5000),
                        PriceTier(min_quantity=12, price=4500),
                    ],
                )
            ],
        )
        supply_chain.save_rules(store, uid, bid, sid, rules, row["version"])
        return bid

    bid = await anyio.to_thread.run_sync(seed)
    # An existing demo is resumed; no duplicate orders or stock resets on another tap.
    if await anyio.to_thread.run_sync(supply_chain.all_orders, store, bid):
        return bid
    settings = Settings(_env_file=None, app_env="test", coach_mode="offline")  # type: ignore[call-arg]
    result: dict[str, Any] = await supply_chain.draft_reorder(
        store, uid, bid, "Milk", None, ForecastService(settings), None, "chalkboard-supply-demo"
    )
    po = result["order"]
    await anyio.to_thread.run_sync(supply_chain.approve, store, uid, bid, po["id"], po["version"])
    return bid
