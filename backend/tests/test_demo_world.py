from pathlib import Path

from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService

from app.demo_world import fixture_world
from app.main import create_app
from app.tour_catalogue import TOUR_SHOPS
from tests.test_discover import settings

INDIRANAGAR = {"lat": 12.9719, "lng": 77.6412}


def test_fixture_prices_follow_the_local_currency() -> None:
    usd = fixture_world("USD").shops[0].items[0].price
    inr = fixture_world("INR").shops[0].items[0].price
    assert inr > usd * 10  # rupees, not dollars


def test_world_currency_comes_from_area_region_profile(tmp_path: Path) -> None:
    config = settings(tmp_path).model_copy(
        update={"rate_limits_enabled": False, "demo_world_enabled": True}
    )
    app = create_app(config, InMemorySessionService())
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/demo/world",
            json={
                "lat": 1.2853,
                "lng": 103.8318,
                "currency": "INR",
                "timezone": "Asia/Singapore",
                "place": "Tiong Bahru",
            },
        )
        assert response.status_code == 200, response.text
        shop = client.get(f"/api/v1/public/shops/{response.json()['shop_ids'][0]}").json()
        assert shop["currency"] == "SGD"
        assert shop["products"][0]["price"] == 200  # S$2.00 coffee


def test_world_seeds_labelled_demo_shops_once_per_area(tmp_path: Path) -> None:
    config = settings(tmp_path).model_copy(
        update={"rate_limits_enabled": False, "demo_world_enabled": True}
    )
    app = create_app(config, InMemorySessionService())
    with TestClient(app) as client:
        body = {
            **INDIRANAGAR,
            "currency": "INR",
            "timezone": "Asia/Kolkata",
            "place": "Indiranagar",
        }
        made = client.post("/api/v1/demo/world", json=body)
        assert made.status_code == 200, made.text
        receipt = made.json()
        assert receipt["created"] is True and receipt["source"] == "fixture"
        assert len(receipt["shop_ids"]) == 8
        assert receipt["shop_ids"] == [s.id for s in TOUR_SHOPS if s.city == "bengaluru"]

        shop = client.get(f"/api/v1/public/shops/{receipt['shop_ids'][1]}").json()
        assert shop["name"].endswith("(Demo)")
        assert shop["currency"] == "INR"
        labels = {fact["label"] for fact in shop["facts"]["custom"]}
        assert {"Demo data", "Why go"} <= labels

        # A neighbour a few hundred metres away shares the same area: nothing new is made.
        again = client.post(
            "/api/v1/demo/world", json={**body, "lat": 12.9725, "lng": 77.6418}
        ).json()
        assert again == {"shop_ids": receipt["shop_ids"], "created": False, "source": "existing"}

        # The shops are discoverable nearby and answer the AI ask.
        nearby = client.get("/api/v1/discover", params={**INDIRANAGAR, "radius": 3000}).json()
        found = {place["id"] for place in nearby["places"]}
        assert set(receipt["shop_ids"]) <= found
        ask = client.post("/api/v1/discover/ask", json={"q": "croissant", **INDIRANAGAR}).json()
        best = [p["id"] for g in ask["groups"] for p in g["places"]]
        assert any(bid in receipt["shop_ids"] for bid in best)


def test_model_output_is_trimmed_and_thin_shops_are_dropped() -> None:
    from app.demo_world import _ItemSpec, _ShopSpec, _WorldSpec, from_spec

    item = _ItemSpec(name="Filter coffee", price=60, unit="cup", category="Drinks")
    full = _ShopSpec(
        name="A" * 90,
        category="Cafe",
        opens="07:00",
        closes="21:00",
        halal=False,
        vegetarian_options=True,
        locally_made=True,
        story="S" * 300,
        items=[item] * 4,
    )
    thin = full.model_copy(update={"items": [item]})
    world = from_spec(_WorldSpec(shops=[full, thin, full, full, full]))
    assert len(world.shops) == 4
    assert len(world.shops[0].name) == 60 and len(world.shops[0].story) == 120


def test_rescue_deals_only_seed_for_food_and_perishable_shops() -> None:
    from app.rescue import is_food_or_perishable

    assert is_food_or_perishable("Bakery") is True
    assert is_food_or_perishable("Cafe") is True
    assert is_food_or_perishable("Street food") is True
    assert is_food_or_perishable("Grocer") is True
    assert is_food_or_perishable("Florist") is True
    assert is_food_or_perishable("Bicycle repair") is False
    assert is_food_or_perishable("Tailor") is False
    assert is_food_or_perishable("Salon") is False
    assert is_food_or_perishable("Hardware") is False
