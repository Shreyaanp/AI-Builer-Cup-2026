import json
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService

from app import retail_recs
from app.main import create_app
from app.retail_recs import (
    AppEvent,
    EventPipeline,
    Recommender,
    RetailClient,
    SimilarShops,
    catalog_products,
    map_event,
    product_id,
    scrub_query,
    shape_product,
    visitor_key,
)
from tests.test_discover import settings

VISITOR = "3f1c2a4e-9b7d-4c1e-8f00-1234567890ab"
SHOP = {
    "id": "demo-bangkok-coffee",
    "name": "Cloud Cup Corner (Demo)",
    "category": "Café > Coffee",
    "lat": 13.756331,
    "lng": 100.501765,
    "currency": "THB",
    "demo": True,
    "phone": "+66 2 000 0000",
    "facts": {"custom": [{"label": "Owner", "value": "private"}]},
    "products": [
        {"name": "Iced americano", "category": "Coffee", "price": 7000, "unit": "cup"},
        {"name": "Kaya toast", "price": 4500, "unit": "plate", "available": False},
    ],
}


class FakeRetail(RetailClient):
    """Records calls; answers model/predict from canned responses."""

    def __init__(self, model: dict[str, Any] | None = None, fail: bool = False) -> None:
        super().__init__("test-project", token=lambda: "token")
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []
        self.model_state = model
        self.fail = fail

    def call(
        self, method: str, path: str, body: dict[str, Any] | None = None, **params: Any
    ) -> Any:
        self.calls.append((method, path, body))
        if self.fail:
            raise httpx.ConnectError("offline")
        if path.endswith("/models/similar_items"):
            if self.model_state is None:
                request = httpx.Request(method, path)
                raise httpx.HTTPStatusError(
                    "missing", request=request, response=httpx.Response(404, request=request)
                )
            return self.model_state
        if path.endswith(":predict"):
            return {
                "results": [
                    {"id": "a"},
                    {"id": body["userEvent"]["productDetails"][0]["product"]["id"]},
                    {"id": "b"},
                ]
            }  # type: ignore[index]
        return {}


# --- catalog shaping -----------------------------------------------------------------------


def test_product_ids_are_stable_and_retail_safe() -> None:
    first = product_id("demo-w-abc/1 x", "Kaya toast", "plate")
    assert first == product_id("demo-w-abc/1 x", "Kaya toast", "plate")
    assert first != product_id("demo-w-abc/1 x", "Kaya toast", "piece")
    assert len(first) <= 128 and all(c.isalnum() or c in "-_" for c in first)
    assert product_id("x" * 300, "a", "b").startswith("x" * 80 + "--")


def test_products_carry_only_public_item_fields() -> None:
    product = shape_product(SHOP, SHOP["products"][0])  # type: ignore[index]
    assert product["id"] == product_id("demo-bangkok-coffee", "Iced americano", "cup")
    assert product["title"] == "Iced americano"
    # ">" in owner text never creates a fake category level.
    assert product["categories"] == ["Café Coffee > Coffee"]
    assert product["priceInfo"] == {"price": 70.0, "currencyCode": "THB"}
    assert product["availability"] == "IN_STOCK"
    attributes = product["attributes"]
    assert attributes["shop_id"] == {"text": ["demo-bangkok-coffee"]}
    assert attributes["demo"] == {"text": ["true"]}
    assert attributes["lat"] == {"numbers": [13.7563]}
    text = json.dumps(product)
    assert "+66" not in text and "private" not in text and "Owner" not in text

    sold_out = shape_product({**SHOP, "category": ""}, SHOP["products"][1])  # type: ignore[index]
    assert sold_out["availability"] == "OUT_OF_STOCK"
    assert sold_out["categories"] == ["Shop"]


def test_catalog_includes_every_shop_item_once() -> None:
    other = {**SHOP, "id": "real-shop", "demo": False, "lat": None}
    products = catalog_products([SHOP, other, SHOP, {"id": "empty", "products": [{"name": ""}]}])
    assert len(products) == 4
    real = [p for p in products if p["attributes"]["shop_id"]["text"] == ["real-shop"]]
    assert (
        real[0]["attributes"]["demo"] == {"text": ["false"]} and "lat" not in real[0]["attributes"]
    )


def test_import_batches_at_most_one_hundred_products() -> None:
    client = FakeRetail()
    products = [{"id": str(i)} for i in range(250)]
    client.import_products(products)
    sizes = [
        len(body["inputConfig"]["productInlineSource"]["products"]) for _, _, body in client.calls
    ]  # type: ignore[index]
    assert sizes == [100, 100, 50]
    assert all(body["reconciliationMode"] == "INCREMENTAL" for _, _, body in client.calls)  # type: ignore[index]


# --- privacy and event mapping -------------------------------------------------------------


def test_visitor_ids_are_hashed_and_validated() -> None:
    key = visitor_key(VISITOR)
    assert key and len(key) == 32 and VISITOR not in key and key == visitor_key(VISITOR)
    assert visitor_key("") is None
    assert visitor_key("me@example.com") is None


def test_search_queries_lose_contact_details() -> None:
    assert (
        scrub_query("call me on +65 9123 4567 or me@x.com about  cake")
        == "call me on or about cake"
    )
    assert len(scrub_query("a" * 500)) == 80


def test_events_map_to_retail_types() -> None:
    item = ("Iced americano", "cup")
    pid = product_id(SHOP["id"], *item)  # type: ignore[arg-type]
    view = map_event(AppEvent("item_open", VISITOR, SHOP["id"], item=item, at=0))  # type: ignore[arg-type]
    assert view == {
        "visitorId": visitor_key(VISITOR),
        "eventTime": "1970-01-01T00:00:00Z",
        "eventType": "detail-page-view",
        "productDetails": [{"product": {"id": pid}}],
    }
    shop = map_event(AppEvent("shop_open", VISITOR, SHOP["id"], category="Bakery"))
    assert (
        shop and shop["eventType"] == "category-page-view" and shop["pageCategories"] == ["Bakery"]
    )
    ask = map_event(AppEvent("ask", VISITOR, query="halal noodles"))
    assert ask and ask["eventType"] == "search" and ask["searchQuery"] == "halal noodles"
    remind = map_event(AppEvent("remind", VISITOR, SHOP["id"], item=item))  # type: ignore[arg-type]
    assert remind and remind["eventType"] == "add-to-cart"
    # Shop-level actions without an item, empty queries and bad visitor ids are not sent.
    assert map_event(AppEvent("follow", VISITOR, SHOP["id"])) is None
    assert map_event(AppEvent("ask", VISITOR, query="  ")) is None
    assert map_event(AppEvent("item_open", "bad id!", SHOP["id"], item=item)) is None  # type: ignore[arg-type]


def test_mapped_events_hold_no_personal_data() -> None:
    event = map_event(AppEvent("ask", VISITOR, query="cake for priya@example.com 98765 43210"))
    text = json.dumps(event)
    assert VISITOR not in text and "@" not in text and "98765" not in text
    assert set(event or {}) == {"visitorId", "eventTime", "eventType", "searchQuery"}


# --- batching --------------------------------------------------------------------------------


def test_pipeline_batches_and_flushes() -> None:
    now = [0.0]
    client = FakeRetail()
    pipeline = EventPipeline(client, True, batch=3, interval=30, clock=lambda: now[0])
    for _ in range(2):
        assert pipeline.record(AppEvent("ask", VISITOR, query="coffee"))
    assert not pipeline.due()
    assert pipeline.record(AppEvent("ask", VISITOR, query="tea"))
    assert pipeline.due()
    assert pipeline.flush() == 3
    method, path, body = client.calls[-1]
    assert path.endswith("/userEvents:import")
    assert len(body["inputConfig"]["userEventInlineSource"]["userEvents"]) == 3  # type: ignore[index]
    assert pipeline.flush() == 0
    pipeline.record(AppEvent("ask", VISITOR, query="tea"))
    now[0] = 31
    assert pipeline.due()


def test_pipeline_is_off_by_default_and_drops_on_errors() -> None:
    assert not EventPipeline(FakeRetail(), False).record(AppEvent("ask", VISITOR, query="x"))
    assert not EventPipeline(None, True).enabled
    failing = EventPipeline(FakeRetail(fail=True), True)
    failing.record(AppEvent("ask", VISITOR, query="x"))
    assert failing.flush() == 0
    assert failing.flush() == 0  # dropped, not retried forever


# --- serving switch and fallback -----------------------------------------------------------

READY = {"servingState": "ACTIVE", "trainingState": "TRAINING"}


def test_similar_items_when_switch_on_and_model_ready() -> None:
    client = FakeRetail(model=READY)
    recommender = Recommender(client, enabled=True)
    assert recommender.similar_items("p1", VISITOR) == ["a", "b"]
    predict = [body for _, path, body in client.calls if path.endswith(":predict")][0]
    assert predict["userEvent"]["visitorId"] == visitor_key(VISITOR)  # type: ignore[index]
    # Readiness is cached: one model check for many lookups.
    recommender.similar_items("p2")
    assert sum(path.endswith("/models/similar_items") for _, path, _ in client.calls) == 1


def test_similar_items_falls_back_to_none() -> None:
    assert Recommender(FakeRetail(model=READY), enabled=False).similar_items("p") is None
    assert Recommender(None, enabled=True).similar_items("p") is None
    assert Recommender(FakeRetail(model=None), enabled=True).similar_items("p") is None
    training = {"servingState": "INACTIVE", "trainingState": "TRAINING"}
    assert Recommender(FakeRetail(model=training), enabled=True).similar_items("p") is None
    assert Recommender(FakeRetail(fail=True), enabled=True).similar_items("p") is None

    class BrokenPredict(FakeRetail):
        def predict(self, product: str, visitor: str, page_size: int) -> list[str]:
            raise httpx.ReadTimeout("slow")

    assert Recommender(BrokenPredict(model=READY), enabled=True).similar_items("p") is None


def test_module_hook_is_none_until_configured() -> None:
    retail_recs.configure_recommender(None)
    assert retail_recs.similar_items("p") is None
    retail_recs.configure_recommender(Recommender(FakeRetail(model=READY), enabled=True))
    try:
        assert retail_recs.similar_items("p") == ["a", "b"]
    finally:
        retail_recs.configure_recommender(None)


def test_similar_shops_maps_recommended_items_to_other_shops() -> None:
    class Picks(Recommender):
        def __init__(self, ids: list[str] | None) -> None:
            self.ids = ids
            self.asked: list[str] = []

        def similar_items(
            self, product: str, visitor: str = "", page_size: int = 6
        ) -> list[str] | None:
            self.asked.append(product)
            return self.ids

    menu = [
        {"name": "Tea", "unit": "cup", "available": False},
        {"name": "Bun", "unit": "piece", "available": True},
    ]
    picks = Picks([product_id("cafe", "Bun", "piece"), "bakery--x", "bakery--y", "deli--z"])
    shops = SimilarShops(picks)
    # The viewed item when it is on the menu, else the first available item.
    assert shops.similar_items("cafe", None, 6, menu) == ["bakery", "deli"]
    assert picks.asked == [product_id("cafe", "Bun", "piece")]
    assert shops.similar_items("cafe", None, 1, menu) == ["bakery"]
    # Nothing to anchor on, or the model is not serving: the engine uses embeddings.
    assert shops.similar_items("cafe", None, 6, []) == []
    assert SimilarShops(Picks(None)).similar_items("cafe", "Bun", 6, menu) == []


# --- route -----------------------------------------------------------------------------------


def test_event_route_is_off_by_default(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/public/recs/events", json={"kind": "ask", "visitor": VISITOR, "query": "tea"}
        )
        assert response.status_code == 202
        assert response.json() == {"accepted": False, "enabled": False}
    # The serving hook is not configured by a default app either.
    assert retail_recs.similar_items("p") is None


def test_event_route_accepts_only_real_shops_and_items(tmp_path: Path) -> None:
    config = settings(tmp_path).model_copy(
        update={"rate_limits_enabled": False, "demo_world_enabled": True}
    )
    app = create_app(config, InMemorySessionService())
    fake = FakeRetail()
    with TestClient(app) as client:
        made = client.post(
            "/api/v1/demo/world",
            json={"lat": 12.9719, "lng": 77.6412, "currency": "INR", "timezone": "Asia/Kolkata"},
        )
        assert made.status_code == 200, made.text
        bid = made.json()["shop_ids"][0]
        shop = client.get(f"/api/v1/public/shops/{bid}").json()
        item = {"name": shop["products"][0]["name"], "unit": shop["products"][0]["unit"]}
        pipeline = EventPipeline(fake, True, batch=100)
        app.state.recs_events = pipeline

        def post(body: dict[str, Any]) -> dict[str, Any]:
            response = client.post("/api/v1/public/recs/events", json={"visitor": VISITOR, **body})
            assert response.status_code == 202, response.text
            return dict(response.json())

        assert post({"kind": "shop_open", "shop_id": bid})["accepted"] is True
        assert post({"kind": "remind", "shop_id": bid, "item": item})["accepted"] is True
        assert post({"kind": "ask", "query": "masala chai"})["accepted"] is True
        # Unknown shops and invented items are refused (no synthetic events).
        assert post({"kind": "shop_open", "shop_id": "nope"})["accepted"] is False
        fake_item = {"name": "Not on the menu", "unit": "cup"}
        assert post({"kind": "item_open", "shop_id": bid, "item": fake_item})["accepted"] is False
        assert (
            client.post(
                "/api/v1/public/recs/events", json={"kind": "ask", "visitor": "a b", "query": "x"}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/public/recs/events", json={"kind": "stamp", "visitor": VISITOR}
            ).status_code
            == 422
        )
    # Shutdown flushes what is buffered.
    events = fake.calls[-1][2]["inputConfig"]["userEventInlineSource"]["userEvents"]  # type: ignore[index]
    assert [e["eventType"] for e in events] == ["category-page-view", "add-to-cart", "search"]
    assert all(e["visitorId"] == visitor_key(VISITOR) for e in events)
