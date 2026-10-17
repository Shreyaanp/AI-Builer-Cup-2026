"""Live POS pulls: the Square sandbox (Catalog + Orders) and Loyverse (items + receipts).

Each pull returns a table with the same headers as that POS's CSV export, so the built-in
preset (pos_presets.py), a saved mapping and the review step are exactly those of an upload.
With `pos_live=offline`, no token, or any vendor failure, the pull is answered from recorded
sample responses served through the same code, and the result says it is simulated.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

import httpx
import structlog

from .money import exponent
from .pos_connectors import ConnectorsError, GoogleConnectors, square_transport
from .settings import Settings

log = structlog.get_logger()

SAMPLES = Path(__file__).parent / "pos_samples"
SQUARE_URL = "https://connect.squareupsandbox.com"
SQUARE_VERSION = "2025-09-24"
LOYVERSE_URL = "https://api.loyverse.com/v1.0"
SALES_DAYS = 28
MAX_PAGES = 20
TIMEOUT = httpx.Timeout(15.0)

Table = tuple[list[str], list[list[str]]]
Provider = Literal["square", "loyverse"]
Kind = Literal["menu", "sales"]


class LiveError(Exception):
    """The vendor could not be reached or answered with something we cannot use."""


@dataclass(frozen=True)
class Pull:
    headers: list[str]
    rows: list[list[str]]
    simulated: bool
    fallback: str = ""
    via: str = "samples"  # google-connectors, direct or samples


def _money(amount: Any, currency: str) -> str:
    places = exponent(currency)
    return f"{(amount or 0) / 10**places:.{places}f}"


# ── Square ───────────────────────────────────────────────────────────────────
SQUARE_MENU_HEADERS = ["Token", "Item Name", "Variation Name", "SKU", "Reporting Category", "Price"]
SQUARE_SALES_HEADERS = ["Date", "Category", "Item", "Qty", "Price Point Name", "SKU", "Net Sales"]


async def _square_pages(
    client: httpx.AsyncClient, method: str, path: str, key: str, **kwargs: Any
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(MAX_PAGES):
        if method == "GET":
            params = {**kwargs.get("params", {}), **({"cursor": cursor} if cursor else {})}
            response = await client.get(path, params=params)
        else:
            body = {**kwargs["json"], **({"cursor": cursor} if cursor else {})}
            response = await client.post(path, json=body)
        if response.status_code != 200:
            raise LiveError(f"square {path} {response.status_code}")
        data = response.json()
        found.extend(data.get(key) or [])
        cursor = data.get("cursor") or ""
        if not cursor:
            break
    return found


async def _square_catalog(client: httpx.AsyncClient) -> tuple[list[dict[str, Any]], dict[str, str]]:
    objects = await _square_pages(
        client, "GET", "/v2/catalog/list", "objects", params={"types": "ITEM,CATEGORY"}
    )
    categories = {
        o["id"]: o.get("category_data", {}).get("name", "")
        for o in objects
        if o.get("type") == "CATEGORY"
    }
    return [o for o in objects if o.get("type") == "ITEM"], categories


def _square_category(item_data: dict[str, Any], categories: dict[str, str]) -> str:
    ids = [c.get("id") for c in item_data.get("categories") or []]
    ids.append(item_data.get("category_id"))
    ids.append((item_data.get("reporting_category") or {}).get("id"))
    return next((categories[i] for i in ids if i in categories), "")


async def square_menu(client: httpx.AsyncClient, settings: Settings) -> Table:
    items, categories = await _square_catalog(client)
    rows: list[list[str]] = []
    for item in items:
        data = item.get("item_data", {})
        category = _square_category(data, categories)
        for variation in data.get("variations") or []:
            v = variation.get("item_variation_data", {})
            money = v.get("price_money")
            if not money:  # open-price variations have no price to import
                continue
            rows.append(
                [
                    variation.get("id", ""),
                    data.get("name", ""),
                    v.get("name", ""),
                    v.get("sku", ""),
                    category,
                    _money(money.get("amount"), money.get("currency", "USD")),
                ]
            )
    return SQUARE_MENU_HEADERS, rows


async def square_sales(client: httpx.AsyncClient, settings: Settings) -> Table:
    locations = [
        loc
        for loc in await _square_pages(client, "GET", "/v2/locations", "locations")
        if loc.get("status", "ACTIVE") == "ACTIVE"
    ]
    if settings.square_sandbox_location_id:
        locations = [loc for loc in locations if loc["id"] == settings.square_sandbox_location_id]
    if not locations:
        raise LiveError("square has no active location")
    zones = {loc["id"]: loc.get("timezone") or "UTC" for loc in locations}
    items, categories = await _square_catalog(client)
    by_variation = {
        variation.get("id"): _square_category(item.get("item_data", {}), categories)
        for item in items
        for variation in item.get("item_data", {}).get("variations") or []
    }
    since = datetime.now(UTC) - timedelta(days=SALES_DAYS)
    orders = await _square_pages(
        client,
        "POST",
        "/v2/orders/search",
        "orders",
        json={
            "location_ids": list(zones)[:10],
            "limit": 500,
            "query": {
                "filter": {
                    "state_filter": {"states": ["COMPLETED"]},
                    "date_time_filter": {"created_at": {"start_at": since.isoformat()}},
                },
                "sort": {"sort_field": "CREATED_AT", "sort_order": "ASC"},
            },
        },
    )
    rows: list[list[str]] = []
    for order in orders:
        if order.get("state", "COMPLETED") != "COMPLETED":
            continue
        placed = datetime.fromisoformat(order["created_at"].replace("Z", "+00:00"))
        if placed < since:
            continue
        try:
            day = placed.astimezone(ZoneInfo(zones.get(order.get("location_id", ""), "UTC")))
        except Exception:
            day = placed
        for line in order.get("line_items") or []:
            gross = line.get("gross_sales_money") or line.get("total_money") or {}
            discount = line.get("total_discount_money") or {}
            currency = gross.get("currency", "USD")
            rows.append(
                [
                    day.date().isoformat(),
                    by_variation.get(line.get("catalog_object_id"), ""),
                    line.get("name", ""),
                    str(line.get("quantity", "1")),
                    line.get("variation_name", ""),
                    "",
                    _money((gross.get("amount") or 0) - (discount.get("amount") or 0), currency),
                ]
            )
    return SQUARE_SALES_HEADERS, rows


# ── Loyverse ─────────────────────────────────────────────────────────────────
LOYVERSE_MENU_HEADERS = [
    "Handle",
    "Name",
    "Category",
    "Sold by weight",
    "Option 1 value",
    "Price [API]",
    "In stock [API]",
]
LOYVERSE_SALES_HEADERS = [
    "Date",
    "Receipt number",
    "Category",
    "SKU",
    "Item",
    "Variant",
    "Quantity",
    "Net sales",
]


async def _loyverse_pages(
    client: httpx.AsyncClient, path: str, key: str, params: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(MAX_PAGES):
        query = {"limit": 250, **(params or {}), **({"cursor": cursor} if cursor else {})}
        response = await client.get(path, params=query)
        if response.status_code != 200:
            raise LiveError(f"loyverse {path} {response.status_code}")
        data = response.json()
        found.extend(data.get(key) or [])
        cursor = data.get("cursor") or ""
        if not cursor:
            break
    return found


async def _loyverse_catalog(
    client: httpx.AsyncClient,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    categories = {
        c["id"]: c.get("name", "")
        for c in await _loyverse_pages(client, "/categories", "categories")
    }
    return await _loyverse_pages(client, "/items", "items"), categories


async def loyverse_menu(client: httpx.AsyncClient, settings: Settings) -> Table:
    items, categories = await _loyverse_catalog(client)
    stock: dict[str, float] = {}
    if any(item.get("track_stock") for item in items):
        for level in await _loyverse_pages(client, "/inventory", "inventory_levels"):
            stock[level["variant_id"]] = stock.get(level["variant_id"], 0) + (
                level.get("in_stock") or 0
            )
    rows: list[list[str]] = []
    for item in items:
        for variant in item.get("variants") or []:
            price = variant.get("default_price")
            if price is None:
                price = next(
                    (s["price"] for s in variant.get("stores") or [] if s.get("price") is not None),
                    None,
                )
            if price is None:
                continue
            tracked = item.get("track_stock") and variant["variant_id"] in stock
            rows.append(
                [
                    item.get("handle") or item.get("id", ""),
                    item.get("item_name", ""),
                    categories.get(item.get("category_id") or "", ""),
                    "Y" if item.get("sold_by_weight") else "N",
                    variant.get("option1_value") or "",
                    f"{price:.2f}",
                    f"{stock[variant['variant_id']]:g}" if tracked else "",
                ]
            )
    return LOYVERSE_MENU_HEADERS, rows


async def loyverse_sales(client: httpx.AsyncClient, settings: Settings) -> Table:
    items, categories = await _loyverse_catalog(client)
    by_item = {item["id"]: categories.get(item.get("category_id") or "", "") for item in items}
    since = datetime.now(UTC) - timedelta(days=SALES_DAYS)
    receipts = await _loyverse_pages(
        client,
        "/receipts",
        "receipts",
        {"created_at_min": since.strftime("%Y-%m-%dT%H:%M:%S.000Z")},
    )
    rows: list[list[str]] = []
    for receipt in receipts:
        if receipt.get("receipt_type") != "SALE" or receipt.get("cancelled_at"):
            continue  # refunds and voided receipts are not sales
        for line in receipt.get("line_items") or []:
            rows.append(
                [
                    (receipt.get("receipt_date") or receipt.get("created_at") or "")[:10],
                    receipt.get("receipt_number", ""),
                    by_item.get(line.get("item_id"), ""),
                    line.get("sku") or "",
                    line.get("item_name", ""),
                    line.get("variant_name") or "",
                    f"{line.get('quantity', 1):g}",
                    f"{line.get('total_money', 0):.2f}",
                ]
            )
    return LOYVERSE_SALES_HEADERS, rows


# ── Providers, live and simulated ────────────────────────────────────────────
def _sample(name: str) -> Any:
    return json.loads((SAMPLES / name).read_text(encoding="utf-8"))


def _rebase(node: Any, shift: timedelta) -> None:
    """Move every recorded timestamp forward so the newest sale is today."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"created_at", "receipt_date"} and isinstance(value, str) and value:
                moved = datetime.fromisoformat(value.replace("Z", "+00:00")) + shift
                node[key] = moved.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            else:
                _rebase(value, shift)
    elif isinstance(node, list):
        for value in node:
            _rebase(value, shift)


def _simulated_transport(provider: Provider, today: date) -> httpx.MockTransport:
    files = {
        "square": {
            "/v2/locations": "square_locations.json",
            "/v2/catalog/list": "square_catalog.json",
            "/v2/orders/search": "square_orders.json",
        },
        "loyverse": {
            "/v1.0/categories": "loyverse_categories.json",
            "/v1.0/items": "loyverse_items.json",
            "/v1.0/inventory": "loyverse_inventory.json",
            "/v1.0/receipts": "loyverse_receipts.json",
        },
    }[provider]
    newest = date.fromisoformat("2026-10-16")  # the latest day in the recorded sales

    def handle(request: httpx.Request) -> httpx.Response:
        name = files.get(request.url.path)
        if name is None:
            return httpx.Response(404, json={})
        body = _sample(name)
        _rebase(body, timedelta(days=(today - newest).days))
        return httpx.Response(200, json=body)

    return httpx.MockTransport(handle)


def _live_client(provider: Provider, settings: Settings) -> httpx.AsyncClient | None:
    if settings.pos_live != "live":
        return None
    if provider == "square":
        token = settings.square_sandbox_token.get_secret_value()
        headers = {"Square-Version": SQUARE_VERSION}
        base = SQUARE_URL
    else:
        token = settings.loyverse_token.get_secret_value()
        headers = {}
        base = LOYVERSE_URL + "/"
    if not token:
        return None
    headers["Authorization"] = f"Bearer {token}"
    return httpx.AsyncClient(base_url=base, headers=headers, timeout=TIMEOUT)


FETCHERS: dict[tuple[Provider, Kind], Callable[[httpx.AsyncClient, Settings], Any]] = {
    ("square", "menu"): square_menu,
    ("square", "sales"): square_sales,
    ("loyverse", "menu"): loyverse_menu,
    ("loyverse", "sales"): loyverse_sales,
}
LABELS: dict[Provider, str] = {"square": "Square", "loyverse": "Loyverse"}


def status(settings: Settings) -> list[dict[str, Any]]:
    """Which providers pull live and which answer from samples. Never reveals a token."""
    return [
        {
            "provider": provider,
            "label": LABELS[provider],
            "mode": "live" if _live_client(provider, settings) else "simulated",
        }
        for provider in ("square", "loyverse")
    ]


async def pull(
    provider: Provider, kind: Kind, settings: Settings, today: date | None = None
) -> Pull:
    fetch = FETCHERS[(provider, kind)]
    fallback = ""
    if (
        provider == "square"
        and settings.pos_live == "live"
        and settings.pos_source == "google-connectors"
    ):
        connectors = GoogleConnectors(settings)
        try:
            async with httpx.AsyncClient(
                transport=square_transport(connectors), base_url=SQUARE_URL + "/", timeout=TIMEOUT
            ) as through:
                headers, rows = await fetch(through, settings)
            return Pull(headers, rows, simulated=False, via="google-connectors")
        except (
            ConnectorsError,
            LiveError,
            httpx.HTTPError,
            KeyError,
            ValueError,
            TypeError,
        ) as error:
            log.warning("pos_connectors_failed", kind=kind, error=type(error).__name__)
            fallback = "CONNECTORS_UNAVAILABLE"
    client = _live_client(provider, settings)
    if client is not None:
        try:
            async with client:
                headers, rows = await fetch(client, settings)
            return Pull(headers, rows, simulated=False, via="direct")
        except (LiveError, httpx.HTTPError, KeyError, ValueError, TypeError) as error:
            log.warning("pos_live_failed", provider=provider, kind=kind, error=type(error).__name__)
            fallback = "LIVE_UNAVAILABLE"
    elif settings.pos_live == "live" and not fallback:
        fallback = "NO_TOKEN"
    transport = _simulated_transport(provider, today or datetime.now(UTC).date())
    base = (SQUARE_URL if provider == "square" else LOYVERSE_URL + "/").rstrip("/") + "/"
    async with httpx.AsyncClient(transport=transport, base_url=base) as simulated:
        headers, rows = await fetch(simulated, settings)
    return Pull(headers, rows, simulated=True, fallback=fallback)
