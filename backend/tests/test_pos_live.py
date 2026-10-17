"""POS export presets and live pulls (Square sandbox, Loyverse) with the simulated fallback."""

from __future__ import annotations

import asyncio
import csv
from datetime import date
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app import pos_connectors, pos_live
from app.pos_presets import detect_preset, parse_day, prepare_rows, preset_mapping
from app.settings import Settings
from tests.test_imports import make_shop
from tests.test_photos import app, join  # noqa: F401 (fixture + consent helper)

PRESETS = Path(__file__).parent / "fixtures" / "connect" / "presets"
TOKEN = SecretStr("not-a-real-token")


def config(**update: object) -> Settings:
    return Settings(_env_file=None, coach_mode="offline", app_env="test", **update)  # type: ignore[arg-type]


def table(name: str) -> tuple[list[str], list[list[str]]]:
    with (PRESETS / name).open(encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle))
    return rows[0], rows[1:]


@pytest.mark.parametrize(
    ("file", "label", "kind"),
    [
        ("petpooja_items.csv", "Petpooja", "menu"),
        ("petpooja_sales.csv", "Petpooja", "sales"),
        ("loyverse_items.csv", "Loyverse", "menu"),
        ("loyverse_sales.csv", "Loyverse", "sales"),
        ("square_items.csv", "Square", "menu"),
        ("square_sales.csv", "Square", "sales"),
    ],
)
def test_each_export_is_recognised_and_mapped(file: str, label: str, kind: str) -> None:
    headers, rows = table(file)
    preset = detect_preset(headers)
    assert preset is not None and (preset.label, preset.kind) == (label, kind)
    mapping = preset_mapping(preset, headers, prepare_rows(preset, headers, rows))
    roles = {field.target_field for field in mapping.fields}
    assert {"name", "price"} <= roles if kind == "menu" else {"name", "date", "total"} <= roles
    assert all(field.source_field in headers for field in mapping.fields)


def test_unknown_headers_get_no_preset() -> None:
    assert detect_preset(["Foo", "Bar"]) is None


def test_dates_become_iso_days_and_variations_join_the_name() -> None:
    assert parse_day("15-10-2026", day_first=True) == "2026-10-15"
    assert parse_day("10/15/2026 9:05 AM", day_first=False) == "2026-10-15"
    assert parse_day("tomorrow", day_first=True) is None
    headers, rows = table("loyverse_sales.csv")
    preset = detect_preset(headers)
    assert preset
    prepared = prepare_rows(preset, headers, rows)
    assert prepared[0][0] == "2026-10-15"
    assert any(row[headers.index("Item")] == "Cold Coffee (Large)" for row in prepared)


@pytest.mark.parametrize("provider", ["square", "loyverse"])
@pytest.mark.parametrize("kind", ["menu", "sales"])
def test_offline_pulls_use_recorded_samples_through_the_same_code(provider: str, kind: str) -> None:
    pulled = asyncio.run(pos_live.pull(provider, kind, config(), today=date(2026, 10, 18)))  # type: ignore[arg-type]
    assert pulled.simulated and pulled.fallback == "" and pulled.rows
    preset = detect_preset(pulled.headers)
    assert preset is not None and preset.kind == kind
    assert all(len(row) == len(pulled.headers) for row in pulled.rows)
    if kind == "sales":
        days = {row[0] for row in pulled.rows}
        assert max(days) == "2026-10-18"


def test_live_mode_without_a_token_falls_back_and_says_so() -> None:
    pulled = asyncio.run(pos_live.pull("square", "menu", config(pos_live="live")))
    assert pulled.simulated and pulled.fallback == "NO_TOKEN"


def test_status_reports_modes_and_never_a_token() -> None:
    settings = config(pos_live="live", loyverse_token=TOKEN)
    modes = {row["provider"]: row["mode"] for row in pos_live.status(settings)}
    assert modes == {"square": "simulated", "loyverse": "live"}
    assert TOKEN.get_secret_value() not in repr(pos_live.status(settings))
    assert TOKEN.get_secret_value() not in repr(settings)


def test_live_loyverse_sends_bearer_token_and_maps_the_reply(monkeypatch) -> None:
    seen: list[httpx.Request] = []
    handler = pos_live._simulated_transport("loyverse", date(2026, 10, 18)).handler

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    real = pos_live._live_client

    def client(provider, settings):  # noqa: ANN001, ANN202
        built = real(provider, settings)
        assert built is not None
        return httpx.AsyncClient(
            base_url=str(built.base_url),
            headers=built.headers,
            transport=httpx.MockTransport(record),
        )

    monkeypatch.setattr(pos_live, "_live_client", client)
    pulled = asyncio.run(
        pos_live.pull("loyverse", "menu", config(pos_live="live", loyverse_token=TOKEN))
    )
    assert not pulled.simulated and pulled.rows
    assert seen and all(
        r.headers["Authorization"] == f"Bearer {TOKEN.get_secret_value()}" for r in seen
    )
    assert all(r.method == "GET" for r in seen)


@pytest.mark.parametrize("status_code", [401, 429, 500])
def test_vendor_failure_falls_back_to_samples(monkeypatch, status_code: int) -> None:
    def client(provider, settings):  # noqa: ANN001, ANN202
        return httpx.AsyncClient(
            base_url="https://connect.squareupsandbox.com",
            transport=httpx.MockTransport(lambda request: httpx.Response(status_code, json={})),
        )

    monkeypatch.setattr(pos_live, "_live_client", client)
    pulled = asyncio.run(pos_live.pull("square", "sales", config(pos_live="live")))
    assert pulled.simulated and pulled.fallback == "LIVE_UNAVAILABLE" and pulled.rows


def test_routes_pull_into_review_without_saving(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        join(client)
        bid = make_shop(client, currency="SGD")
        base = f"/api/v1/businesses/{bid}/connect/live"
        modes = client.get(base).json()
        assert {row["mode"] for row in modes} == {"simulated"}

        menu = client.post(f"{base}/square/menu")
        assert menu.status_code == 200, menu.text
        body = menu.json()
        assert body["status"] == "needs_review" and body["simulated"] is True
        assert body["provider"] == "square" and body["items"] > 0
        assert client.get(f"/api/v1/businesses/{bid}/inventory").json() == []

        sales = client.post(f"{base}/loyverse/sales")
        assert sales.status_code == 200, sales.text
        assert sales.json()["kind"] == "sales"

        assert client.post(f"{base}/shopify/menu").status_code == 422


def _entity_pages(seen: list[httpx.Request], fail: int = 0) -> httpx.MockTransport:
    """A Connectors API that serves the recorded Square samples as entity lists."""
    sample = {
        "Location": ("square_locations.json", "locations"),
        "CatalogObject": ("square_catalog.json", "objects"),
        "Order": ("square_orders.json", "orders"),
    }
    transport = pos_live._simulated_transport("square", date(2026, 10, 18))

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if fail:
            return httpx.Response(fail, json={})
        kind = request.url.path.split("/entityTypes/")[1].split("/")[0]
        path = {
            "Location": "/v2/locations",
            "CatalogObject": "/v2/catalog/list",
            "Order": "/v2/orders/search",
        }[kind]
        body = transport.handler(httpx.Request("GET", f"https://x{path}")).json()  # type: ignore[attr-defined]
        return httpx.Response(
            200, json={"entities": [{"fields": row} for row in body[sample[kind][1]]]}
        )

    return httpx.MockTransport(handle)


def test_square_pull_through_google_connectors(monkeypatch) -> None:
    seen: list[httpx.Request] = []
    real = pos_connectors.GoogleConnectors.__init__

    def init(self, settings, transport=None):  # noqa: ANN001, ANN202
        real(self, settings, _entity_pages(seen))

    monkeypatch.setattr(pos_connectors.GoogleConnectors, "__init__", init)
    settings = config(pos_live="live", pos_source="google-connectors", google_cloud_project="demo")
    pulled = asyncio.run(pos_live.pull("square", "sales", settings))
    assert not pulled.simulated and pulled.via == "google-connectors" and pulled.rows
    assert detect_preset(pulled.headers) is not None
    assert all("/connections/square-sandbox/" in r.url.path and r.method == "GET" for r in seen)
    assert all(r.headers["Authorization"] == "Bearer test-token" for r in seen)


def test_connectors_failure_falls_back_to_samples(monkeypatch) -> None:
    real = pos_connectors.GoogleConnectors.__init__

    def init(self, settings, transport=None):  # noqa: ANN001, ANN202
        real(self, settings, _entity_pages([], fail=403))

    monkeypatch.setattr(pos_connectors.GoogleConnectors, "__init__", init)
    settings = config(pos_live="live", pos_source="google-connectors", google_cloud_project="demo")
    pulled = asyncio.run(pos_live.pull("square", "menu", settings))
    assert pulled.simulated and pulled.fallback == "CONNECTORS_UNAVAILABLE" and pulled.rows


def test_connectors_without_a_project_never_calls_google() -> None:
    settings = config(pos_live="live", pos_source="google-connectors")
    pulled = asyncio.run(pos_live.pull("square", "menu", settings))
    assert pulled.simulated and pulled.fallback == "CONNECTORS_UNAVAILABLE"
