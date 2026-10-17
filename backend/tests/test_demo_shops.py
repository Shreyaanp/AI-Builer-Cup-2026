from collections import Counter
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService

from app.forecast import ForecastService
from app.main import create_app
from app.merchant import BusinessFields, MerchantRepository, MerchantStore, ProductFields
from app.product_units import UNITS
from app.sales import today_for
from app.settings import Settings
from scripts.seed_demo_shops import SHOPS, main, sales_history, seed
from tests.test_discover import settings as local_settings
from tests.test_merchant_store import create
from tests.test_photos import join

pytest_plugins = ("tests.test_merchant_store",)


def test_private_seed_is_never_shared_and_is_idempotent(store: MerchantRepository) -> None:
    demo = SHOPS[0]
    assert store.seed_demo_shop("owner", demo.id, demo.fields, demo.products, public=False)
    assert store.public_shop(demo.id) is None
    assert store.inventory("owner", demo.id)
    assert not store.seed_demo_shop("owner", demo.id, demo.fields, demo.products, public=False)
    assert store.public_shop(demo.id) is None


def test_demo_seed_is_idempotent_and_labelled(store: MerchantRepository) -> None:
    assert [changed for _, changed in seed(store, "demo-owner")] == [True] * len(SHOPS)
    first = {shop["id"]: shop for shop in store.shared_shops()}
    histories = {s.id: store.sales_history("demo-owner", s.id) for s in SHOPS}
    inquiries = {s.id: store.inquiries("demo-owner", s.id) for s in SHOPS}
    # A second run changes nothing: same shops, same menus, same revisions.
    assert [changed for _, changed in seed(store, "demo-owner")] == [False] * len(SHOPS)
    assert {shop["id"]: shop for shop in store.shared_shops()} == first
    assert sorted(first) == sorted(s.id for s in SHOPS)
    revisions = {b["id"]: b["revision"] for b in store.list_businesses("demo-owner")}
    assert set(revisions.values()) == {2}  # Catalogue creation + normal sales import approval.
    for demo in SHOPS:
        shop = store.public_shop(demo.id)
        assert shop is not None
        assert shop["demo"] is True
        assert shop["name"].endswith("(Demo)")
        assert shop["currency"] == demo.fields.currency
        assert shop["stamps_enabled"] is True
        assert shop["stamps_needed"] == 8
        assert shop["reward_text"] == "Free item after 8 visits"
        assert shop["timezone"] == demo.fields.timezone
        assert shop["lat"] is not None and shop["lng"] is not None
        assert shop["facts"]["payment_methods"]
        assert "delivery" in shop["facts"]
        assert 6 <= len(shop["products"]) <= 12
        assert 1 <= sum(not p["available"] for p in shop["products"]) <= 2
        # Menu order is the seed order.
        assert [p["name"] for p in shop["products"]] == [p.name for p in demo.products]
        assert all(p["category"] and p["unit"] in UNITS for p in shop["products"])
        assert len(shop["weekly_hours"]) == 7
        history = store.sales_history("demo-owner", demo.id)
        assert history == histories[demo.id]
        assert len(history) == 42 * len(demo.products)
        assert len({r["date"] for r in history}) == 42
        assert store.inquiries("demo-owner", demo.id) == inquiries[demo.id]
        assert len(inquiries[demo.id]) == 3
        assert all(
            i.name.startswith("Demo") and i.message.startswith("[Demo]") for i in inquiries[demo.id]
        )


def test_demo_seed_resets_owner_changes_and_keeps_product_ids(store: MerchantRepository) -> None:
    seed(store, "demo-owner")
    bid = SHOPS[0].id
    before = {p["name"]: p["id"] for p in store.inventory("demo-owner", bid)}
    first = next(iter(before.values()))
    store.set_availability("demo-owner", bid, first, False)
    assert dict(seed(store, "demo-owner"))[bid] is True
    after = store.inventory("demo-owner", bid)
    assert {p["name"]: p["id"] for p in after} == before
    assert all(p["available"] == q.available for p, q in zip(after, SHOPS[0].products, strict=True))


def test_demo_seed_refuses_other_owners_and_unlabelled_shops(store: MerchantRepository) -> None:
    seed(store, "demo-owner")
    with pytest.raises(HTTPException):
        store.seed_demo_shop("someone-else", SHOPS[0].id, SHOPS[0].fields, SHOPS[0].products)
    with pytest.raises(ValueError):
        store.seed_demo_shop("demo-owner", "kopi", SHOPS[0].fields, SHOPS[0].products)
    with pytest.raises(ValueError):
        store.seed_demo_shop(
            "demo-owner",
            "demo-not-labelled",
            BusinessFields(name="Real-looking shop"),
            [ProductFields(name="Kopi", price=150)],
        )
    assert store.public_shop("demo-not-labelled") is None


def test_shops_without_the_flag_keep_their_shape() -> None:
    assert "demo" not in BusinessFields(name="Tea").model_dump()
    assert BusinessFields(name="Tea", demo=True).model_dump()["demo"] is True


def test_script_refuses_production_without_explicit_project(monkeypatch, capsys) -> None:
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    assert main(["--owner-uid", "demo-owner"]) == 2
    assert "Refusing" in capsys.readouterr().err
    assert main(["--owner-uid", "demo-owner", "--dry-run", "--project", "p"]) == 0


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    database = tmp_path / "merchant.sqlite3"
    assert main(["--owner-uid", "demo-owner", "--dry-run", "--sqlite", str(database)]) == 0
    assert not database.exists()
    assert main(["--owner-uid", "demo-owner", "--sqlite", str(database)]) == 0
    assert MerchantStore(str(database)).public_shop(SHOPS[0].id) is not None


def test_city_filter_and_owner_attachment_preserve_real_shops(store: MerchantRepository) -> None:
    real = create(store, "real-owner", "Real shop")
    seed(store, owner_uid="real-owner", city="bengaluru")
    assert len(store.shared_shops()) == 4
    owned = store.list_businesses("real-owner")
    assert {s["id"] for s in owned} == {real, "demo-bengaluru-indiranagar-coffee"}
    seed(store, owner_uid="real-owner")
    owned = store.list_businesses("real-owner")
    assert len(owned) == 9  # One real shop plus one demo per city, Singapore included.
    assert all(not changed for _, changed in seed(store, owner_uid="real-owner"))
    assert store.context("real-owner", real)["business"]["fields"]["name"] == "Real shop"
    assert len(store.list_businesses("demo-world-owner")) == len(SHOPS)
    demo_id = "demo-bengaluru-indiranagar-coffee"
    thread = store.inquiries("real-owner", demo_id)[0]
    store.complete_inquiry("real-owner", demo_id, thread.id)
    seed(store, owner_uid="real-owner", city="bengaluru")
    assert next(i for i in store.inquiries("real-owner", demo_id) if i.id == thread.id).done
    with pytest.raises(HTTPException):
        store.attach_demo_owner("intruder", demo_id, "intruder")
    for action in (
        lambda: store.attach_demo_owner("real-owner", real, "intruder"),
        lambda: store.seed_demo_inquiries("real-owner", real, []),
    ):
        with pytest.raises(ValueError):
            action()


def test_city_dry_run_and_invalid_city(tmp_path: Path, capsys) -> None:
    database = tmp_path / "city.sqlite"
    assert main(["--sqlite", str(database), "--city", "Bengaluru", "--dry-run"]) == 0
    output = capsys.readouterr().out
    assert "demo-bengaluru-indiranagar-coffee" in output
    assert "demo-katong" not in output
    assert not database.exists()
    with pytest.raises(SystemExit):
        main(["--city", "unknown", "--dry-run"])


def test_city_counts_and_minor_units() -> None:
    assert Counter(s.city for s in SHOPS) == {
        "singapore": 6,
        "bengaluru": 4,
        "delhi": 3,
        "mumbai": 3,
        "kuala-lumpur": 3,
        "jakarta": 3,
        "tokyo": 3,
        "bangkok": 3,
    }
    first = {s.city: s for s in reversed(SHOPS)}
    assert first["bengaluru"].products[0].price == 6000  # INR 60
    assert first["jakarta"].products[0].price == 28000  # IDR 28,000
    assert first["tokyo"].products[0].price == 480  # JPY 480
    assert first["kuala-lumpur"].products[0].price == 500  # MYR 5


def test_sales_are_seasonal_and_stable_on_overlapping_days() -> None:
    demo, today = SHOPS[6], date(2026, 10, 15)
    rows = sales_history(demo, today)
    tomorrow = sales_history(demo, today + timedelta(days=1))
    overlap = set(r["date"] for r in rows) & set(r["date"] for r in tomorrow)
    assert [r for r in rows if r["date"] in overlap] == [
        r for r in tomorrow if r["date"] in overlap
    ]
    assert len({r["quantity"] for r in rows}) > 10
    weekday = [r["quantity"] for r in rows if date.fromisoformat(r["date"]).weekday() < 5]
    weekend = [r["quantity"] for r in rows if date.fromisoformat(r["date"]).weekday() >= 5]
    assert sum(weekend) / len(weekend) > sum(weekday) / len(weekday)
    prices = {p.name: p.price for p in demo.products}
    assert all(r["revenue"] == r["quantity"] * prices[r["item"]] for r in rows)


async def test_every_seeded_shop_has_a_truthful_ready_forecast(store: MerchantRepository) -> None:
    seed(store)
    service = ForecastService(Settings(_env_file=None, forecast_backend="weekday_average"))
    for demo in SHOPS:
        result = await service.forecast(
            store.sales_history("demo-world-owner", demo.id),
            today_for(demo.fields.model_dump()),
            store.inventory("demo-world-owner", demo.id),
        )
        assert result.status == "ready"
        assert result.method == "weekday_average"
        assert result.fallback_reason is None
        assert not result.insufficient_items
        assert len(result.predictions) == 7 * len(demo.products)


def test_discovery_forecast_prep_and_recap_use_seeded_records(
    store: MerchantRepository,
    tmp_path: Path,
) -> None:
    app = create_app(local_settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        app.state.merchant = store
        join(client)
        uid = app.state.services.identity.local_principal(
            client.cookies.get("ogoogle_preview_session")
        ).uid
        seed(store, owner_uid=uid, city="bengaluru")
        bid = "demo-bengaluru-indiranagar-coffee"
        result = client.get("/api/v1/discover", params={"lat": 12.9718, "lng": 77.6412})
        assert result.status_code == 200
        places = result.json()["places"]
        assert {p["id"] for p in places if p["source"] == "chalkboard"} == {
            "demo-bengaluru-indiranagar-coffee",
            "demo-bengaluru-indiranagar-kirana",
        }
        wider = client.get(
            "/api/v1/discover",
            params={
                "lat": 12.9718,
                "lng": 77.6412,
                "radius": 10000,
            },
        ).json()["places"]
        assert {p["id"] for p in wider} == {s.id for s in SHOPS if s.city == "bengaluru"}
        assert all(p["demo_shop"] and p["currency"] == "INR" for p in wider)
        response = client.get(f"/api/v1/businesses/{bid}/forecast")
        assert response.status_code == 200
        assert response.json()["status"] == "ready"
        assert response.json()["method"] == "weekday_average"
        pid = store.inventory(uid, bid)[0]["id"]
        prep = client.post(
            f"/api/v1/businesses/{bid}/planning/{pid}/forecast",
            json={
                "source": "owner",
                "ready_stock": 3,
                "capacity": 100,
            },
        )
        assert prep.status_code == 200
        assert prep.json()["status"] == "ready"
        assert prep.json()["method"] == "same_weekday_four_weeks"
        assert prep.json()["source"] == "sales"
        today = today_for(SHOPS[6].fields.model_dump())
        recap = client.get(
            f"/api/v1/businesses/{bid}/recap",
            params={
                "week": (today - timedelta(days=7)).strftime("%G-W%V"),
            },
        )
        assert recap.status_code == 200
        data = recap.json()
        assert data["sales_days"] == data["previous_sales_days"] == 7
        assert data["revenue"] > 0 and data["top_sellers"]
        assert data["customer_questions_count"] == 2
        assert data["mode"] == "offline"


def test_owners_cannot_set_or_clear_the_demo_label(tmp_path: Path) -> None:
    settings = Settings(
        app_env="test",
        v1_enabled=True,
        coach_mode="offline",
        auth_mode="local",
        session_backend="sqlite",
        merchant_backend="sqlite",
        moderation_mode="fixture",
        media_bucket="",
        face_worker_token="",
        merchant_database=str(tmp_path / "merchant.sqlite3"),
        recall_path=str(tmp_path / "recall"),
        _env_file=None,
    )
    with TestClient(create_app(settings, InMemorySessionService())) as client:
        join(client)
        proposal = client.post(
            "/api/v1/proposals",
            json={"kind": "business", "business": {"name": "Sneaky Kopi", "demo": True}},
        ).json()
        assert "demo" not in proposal["snapshot"]["business"]
        client.post(
            f"/api/v1/proposals/{proposal['id']}/approve", json={"digest": proposal["digest"]}
        )
        bid = client.get("/api/v1/businesses").json()[0]["id"]
        client.post(f"/api/v1/businesses/{bid}/share", json={"public": True})
        assert "demo" not in client.get(f"/api/v1/public/shops/{bid}").json()
        discovered = client.get("/api/v1/discover", params={"lat": 1.3, "lng": 103.85}).json()
        assert not any(place["demo_shop"] for place in discovered["places"])
