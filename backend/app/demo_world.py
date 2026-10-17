"""Demo world: believable, clearly labelled demo shops around wherever the visitor is.

Real local data is thin during the hackathon, so the first visit to an area asks Gemini for a
neighbourhood of invented independent shops (local names, menus in the local currency, hours,
customer facts) and seeds them as labelled demo shops. One set per ~2 km cell, reused by every
visitor in that cell. Offline, in tests, or when the model fails, a deterministic fixture is used.
"""

from __future__ import annotations

import hashlib
from typing import Any

import anyio
import structlog
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from .community import Community
from .demand import seed_demo_signals
from .limits import client_ip, enforce_limits
from .merchant import BusinessFields, CustomFact, DayHours, MerchantRepository, ProductFields
from .money import to_minor
from .product_units import UNITS, normalize_unit
from .rescue import seed_demo_deals
from .settings import Settings
from .sourcing import area_currency, offset, region, seed_number

log = structlog.get_logger()
router = APIRouter(prefix="/api/v1/demo")

# Owner of every generated demo shop; no person signs in as this account.
WORLD_OWNER_UID = "chalkboard-demo-world-owner"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
# (km, bearing) for up to eight shops: a walkable spread around the visitor.
SPREAD = [
    (0.25, 20.0),
    (0.45, 95.0),
    (0.6, 170.0),
    (0.8, 240.0),
    (0.35, 300.0),
    (1.1, 50.0),
    (1.4, 130.0),
    (1.7, 210.0),
]


class WorldItem(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    price: float = Field(ge=0, description="Price in the given currency, major units")
    unit: str = Field(max_length=20, description="cup, plate, piece, set, kg, bunch, item…")
    category: str = Field(max_length=40, description="Menu section, e.g. Drinks, Breakfast")


class WorldShop(BaseModel):
    name: str = Field(min_length=2, max_length=60, description="Invented local shop name")
    category: str = Field(max_length=40, description="e.g. Bakery, Kopitiam, Florist, Tailor")
    opens: str = Field(pattern=r"^\d{2}:\d{2}$")
    closes: str = Field(pattern=r"^\d{2}:\d{2}$")
    halal: bool = False
    vegetarian_options: bool = False
    locally_made: bool = Field(description="Makes its own goods or sells local makers' goods")
    story: str = Field(max_length=120, description="One surprising, specific line about it")
    items: list[WorldItem] = Field(min_length=4, max_length=8)


class DemoWorld(BaseModel):
    shops: list[WorldShop] = Field(min_length=4, max_length=8)


class _ItemSpec(BaseModel):
    name: str
    price: float = Field(description="Price in the given currency, major units")
    unit: str = Field(description="cup, plate, piece, set, kg, bunch, item…")
    category: str = Field(description="Menu section, e.g. Drinks, Breakfast")


class _ShopSpec(BaseModel):
    name: str = Field(description="Invented local shop name, under 40 characters")
    category: str = Field(description="e.g. Bakery, Kopitiam, Florist, Tailor")
    opens: str = Field(description="HH:MM, 24h")
    closes: str = Field(description="HH:MM, 24h")
    halal: bool
    vegetarian_options: bool
    locally_made: bool = Field(description="Makes its own goods or sells local makers' goods")
    story: str = Field(description="One surprising, specific line, under 110 characters")
    items: list[_ItemSpec] = Field(description="4 to 8 menu items")


class _WorldSpec(BaseModel):
    """Gemini's schema: plain types only (it rejects some JSON Schema limits); validated after."""

    shops: list[_ShopSpec]


def from_spec(spec: _WorldSpec) -> DemoWorld:
    shops = []
    for shop in spec.shops[:8]:
        items = [
            WorldItem(
                name=item.name.strip()[:60] or "Item",
                price=max(0.0, item.price),
                unit=item.unit.strip()[:20] or "item",
                category=item.category.strip()[:40],
            )
            for item in shop.items[:8]
            if len(item.name.strip()) >= 2 and item.price > 0
        ]
        if len(items) < 4:
            continue
        shops.append(
            WorldShop(
                name=shop.name.strip()[:60],
                category=shop.category.strip()[:40],
                opens=shop.opens.strip()[:5],
                closes=shop.closes.strip()[:5],
                halal=shop.halal,
                vegetarian_options=shop.vegetarian_options,
                locally_made=shop.locally_made,
                story=shop.story.strip()[:120],
                items=items,
            )
        )
    return DemoWorld(shops=shops)


PROMPT = """You create clearly labelled DEMO shops for a hackathon demo of a local-shops app.
Invent 8 independent small shops a resident would love in the given neighbourhood: invented,
local-sounding names (never real businesses, brands or chains), a lively mix (cafe or tea stall,
bakery, street food, grocer, a maker such as a florist, potter or tailor, a salon or repair
shop), menus in the given currency with realistic local prices (major units) and the local
dishes or goods people there actually buy. Hours HH:MM in 24h. "story" is one specific,
surprising detail that makes someone want to visit (e.g. "Grinds its filter coffee at 6am in
front of you"). English names are fine; keep local food words as they are."""


class WorldRequest(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    timezone: str = Field(default="UTC", max_length=64)
    place: str = Field(default="", max_length=120, description="Neighbourhood label if known")


class WorldReceipt(BaseModel):
    shop_ids: list[str]
    created: bool
    source: str  # "gemini", "fixture" or "existing"


def cell_of(lat: float, lng: float) -> str:
    return f"{round(lat * 50) / 50:.2f},{round(lng * 50) / 50:.2f}"


def world_id(lat: float, lng: float, index: int) -> str:
    """One set per ~2 km cell, so visitors in the same area share the same demo shops."""
    digest = hashlib.sha256(cell_of(lat, lng).encode()).hexdigest()[:10]
    return f"demo-w-{digest}-{index}"


# Offline fixture: base prices in US dollars, scaled to the region's price level.
FIXTURE: list[dict[str, Any]] = [
    {
        "name": "Corner Cup",
        "category": "Cafe",
        "hours": ("07:00", "19:00"),
        "facts": {"vegetarian_options": True},
        "story": "Roasts beans on Tuesdays; the whole street smells of it.",
        "items": [
            ("Coffee", 1.5, "cup", "Drinks"),
            ("Tea", 1.0, "cup", "Drinks"),
            ("Butter toast", 1.8, "plate", "Breakfast"),
            ("Banana cake", 1.6, "piece", "Bakes"),
        ],
    },
    {
        "name": "Sunrise Bakehouse",
        "category": "Bakery",
        "hours": ("06:30", "18:00"),
        "facts": {"vegetarian_options": True, "locally_made": True},
        "story": "First tray out at 6:30; the croissants are gone by nine.",
        "items": [
            ("Croissant", 1.4, "piece", "Bakes"),
            ("Sourdough loaf", 4.5, "piece", "Bread"),
            ("Cinnamon roll", 1.9, "piece", "Bakes"),
            ("Iced coffee", 2.2, "cup", "Drinks"),
        ],
    },
    {
        "name": "Lane 4 Street Kitchen",
        "category": "Street food",
        "hours": ("11:00", "22:00"),
        "facts": {"halal": True},
        "story": "One wok, one cook, a queue every evening at seven.",
        "items": [
            ("Fried noodles", 3.0, "plate", "Mains"),
            ("Fried rice", 2.8, "plate", "Mains"),
            ("Chicken skewers", 2.5, "set", "Snacks"),
            ("Lime soda", 1.0, "cup", "Drinks"),
        ],
    },
    {
        "name": "Green Basket Grocer",
        "category": "Grocer",
        "hours": ("08:00", "21:00"),
        "facts": {"vegetarian_options": True},
        "story": "Vegetables arrive from one farm, picked the same morning.",
        "items": [
            ("Tomatoes", 1.8, "kg", "Vegetables"),
            ("Bananas", 1.2, "bunch", "Fruit"),
            ("Free-range eggs", 3.0, "set", "Dairy & eggs"),
            ("Fresh herbs", 0.8, "bunch", "Vegetables"),
        ],
    },
    {
        "name": "Petal & Stem",
        "category": "Florist",
        "hours": ("09:00", "19:00"),
        "facts": {"locally_made": True},
        "story": "Wraps every bouquet in yesterday's newspaper, on purpose.",
        "items": [
            ("Seasonal bouquet", 12.0, "item", "Bouquets"),
            ("Single rose", 1.5, "piece", "Stems"),
            ("Potted herb", 4.0, "item", "Plants"),
            ("Dried flower jar", 9.0, "item", "Gifts"),
        ],
    },
    {
        "name": "Stitch Corner",
        "category": "Tailor",
        "hours": ("10:00", "20:00"),
        "facts": {"locally_made": True},
        "story": "Hems trousers while you wait; forty years at the same table.",
        "items": [
            ("Trouser hem", 4.0, "item", "Alterations"),
            ("Shirt fitting", 6.0, "item", "Alterations"),
            ("Zip replacement", 5.0, "item", "Repairs"),
            ("Custom tote bag", 15.0, "item", "Made here"),
        ],
    },
    {
        "name": "Fade & Co",
        "category": "Salon",
        "hours": ("10:00", "21:00"),
        "facts": {},
        "story": "Walk-ins welcome; the barber remembers every regular's cut.",
        "items": [
            ("Haircut", 8.0, "item", "Hair"),
            ("Beard trim", 4.0, "item", "Hair"),
            ("Kids haircut", 6.0, "item", "Hair"),
            ("Head massage", 5.0, "item", "Care"),
        ],
    },
    {
        "name": "Fix-It Depot",
        "category": "Hardware",
        "hours": ("09:00", "19:30"),
        "facts": {},
        "story": "Has the one screw nobody else stocks, and will show you how to fit it.",
        "items": [
            ("Light bulb", 2.0, "piece", "Electrical"),
            ("Extension cord", 6.0, "item", "Electrical"),
            ("Key cutting", 2.5, "item", "Services"),
            ("Paint brush", 3.0, "piece", "Paint"),
        ],
    },
]


def nice_price(amount: float) -> float:
    """Prices a shop would actually write: 1.90, not 1.89; 45, not 44.7; 600, not 612."""
    if amount < 20:
        return round(amount * 10) / 10
    if amount < 200:
        return float(round(amount / 5) * 5)
    return float(round(amount / 50) * 50)


def fixture_world(currency: str) -> DemoWorld:
    place = region(currency)
    scale = place.rate * max(0.35, place.level)
    shops = []
    for spec in FIXTURE:
        shops.append(
            WorldShop(
                name=spec["name"],
                category=spec["category"],
                opens=spec["hours"][0],
                closes=spec["hours"][1],
                halal=bool(spec["facts"].get("halal")),
                vegetarian_options=bool(spec["facts"].get("vegetarian_options")),
                locally_made=bool(spec["facts"].get("locally_made")),
                story=spec["story"],
                items=[
                    WorldItem(name=n, price=nice_price(p * scale), unit=u, category=c)
                    for n, p, u, c in spec["items"]
                ],
            )
        )
    return DemoWorld(shops=shops)


class WorldGenerator:
    """Gemini-written demo neighbourhoods; the deterministic fixture offline or on failure."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._client: Any = None

    async def generate(self, place: str, currency: str) -> tuple[DemoWorld, str]:
        if self.settings.coach_mode != "gemini":
            return fixture_world(currency), "fixture"
        try:
            from google import genai
            from google.genai import types

            if self._client is None:
                self._client = (
                    genai.Client(
                        vertexai=True,
                        project=self.settings.google_cloud_project,
                        location=self.settings.google_cloud_location,
                    )
                    if self.settings.gemini_backend == "vertex"
                    else genai.Client(api_key=self.settings.google_api_key.get_secret_value())
                )
            with anyio.fail_after(25):
                response = await self._client.aio.models.generate_content(
                    model=self.settings.google_text_model,
                    contents=f"neighbourhood: {place or 'unknown'}\ncurrency: {currency}",
                    config=types.GenerateContentConfig(
                        system_instruction=PROMPT,
                        response_mime_type="application/json",
                        response_schema=_WorldSpec,
                        temperature=0.8,
                        max_output_tokens=6000,
                    ),
                )
            if isinstance(response.parsed, _WorldSpec):
                return from_spec(response.parsed), "gemini"
        except Exception:
            log.warning("demo_world_generation_failed", exc_info=True)
        return fixture_world(currency), "fixture"

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aio.aclose()


def world_records(
    world: DemoWorld, lat: float, lng: float, currency: str, timezone: str, place: str
) -> list[tuple[str, BusinessFields, list[ProductFields]]]:
    records = []
    turn = seed_number(cell_of(lat, lng)) % 60
    for index, shop in enumerate(world.shops[: len(SPREAD)]):
        km, bearing = SPREAD[index]
        plat, plng = offset(lat, lng, km, bearing + turn)
        products = []
        seen: set[str] = set()
        for item in shop.items:
            if item.name.casefold() in seen:
                continue
            seen.add(item.name.casefold())
            unit = normalize_unit(item.unit)
            products.append(
                ProductFields(
                    name=item.name,
                    price=to_minor(item.price, currency),
                    unit=unit if unit in UNITS else "item",
                    category=item.category or shop.category,
                )
            )
        hours = f"{shop.opens}–{shop.closes}"
        try:
            weekly = [
                DayHours(day=day, open=shop.opens, close=shop.closes)  # type: ignore[arg-type]
                for day in DAYS
            ]
        except ValueError:
            weekly = []
        fields = BusinessFields(
            name=f"{shop.name} (Demo)",
            category=shop.category,
            location=f"Near {place or 'you'} (generated demo address)",
            lat=plat,
            lng=plng,
            pin_label=f"Near {place or 'you'} (approximate) · Demo",
            pin_demo=True,
            demo=True,
            timezone=timezone,
            currency=currency,
            stamps_enabled=True,
            reward_text="Free item after 8 visits",
            stamps_needed=8,
            hours=hours,
            weekly_hours=weekly,
            halal="yes" if shop.halal else "not_stated",
            vegetarian_options=shop.vegetarian_options or None,
            locally_made=shop.locally_made or None,
            payment_methods=["cash", "card"],
            custom_facts=[
                CustomFact(key="story", label="Why go", value=shop.story[:120]),
                CustomFact(
                    key="demo_data",
                    label="Demo data",
                    value="Generated demo shop, menu and activity for this prototype.",
                ),
            ],
        )
        records.append((world_id(lat, lng, index), fields, products))
    return records


def is_india(lat: float, lng: float) -> bool:
    return 6.5 <= lat <= 37.5 and 68.0 <= lng <= 97.5


def is_singapore(lat: float, lng: float) -> bool:
    return 1.15 <= lat <= 1.48 and 103.6 <= lng <= 104.1


def resolve_currency(lat: float, lng: float, place: str, requested: str) -> str:
    p = place.lower()
    if is_india(lat, lng) or any(
        k in p
        for k in (
            "india",
            "bengaluru",
            "bangalore",
            "delhi",
            "mumbai",
            "pune",
            "koramangala",
            "indiranagar",
            "chennai",
            "kolkata",
            "hyderabad",
        )
    ):
        return "INR"
    if is_singapore(lat, lng) or "singapore" in p:
        return "SGD"
    return requested or "USD"


async def ensure_world(
    store: MerchantRepository,
    generator: WorldGenerator,
    body: WorldRequest,
    community: Community | None = None,
) -> WorldReceipt:
    from .tour_catalogue import CENTRES, TOUR_SHOPS
    from .tour_story import seed_story

    # The two filmed areas use one authored story, independent of the phone's currency or
    # model mode. Other areas retain the existing generated-neighbourhood behaviour.
    for city, (lat, lng, *_rest) in CENTRES.items():
        if abs(body.lat - lat) < 0.02 and abs(body.lng - lng) < 0.02:
            ids = [s.id for s in TOUR_SHOPS if s.city == city]
            existed = await anyio.to_thread.run_sync(store.public_shop, ids[0])
            if community is not None:
                if generator.settings.app_env == "production":
                    return WorldReceipt(
                        shop_ids=ids if existed else [],
                        created=False,
                        source="existing" if existed else "disabled",
                    )
                await anyio.to_thread.run_sync(lambda: seed_story(store, community))
                return WorldReceipt(
                    shop_ids=ids,
                    created=not bool(existed),
                    source="existing" if existed else "fixture",
                )
    body = body.model_copy(update={"currency": area_currency(body.lat, body.lng, body.currency)})
    first = world_id(body.lat, body.lng, 0)
    stored = await anyio.to_thread.run_sync(store.public_shop, first)
    currency = resolve_currency(body.lat, body.lng, body.place, body.currency)
    # An area filled from the offline set is regenerated once the model is available,
    # or if the stored shop had the wrong currency for this country (e.g. SGD in India).
    offline_names = {f"{spec['name']} (Demo)" for spec in FIXTURE}
    wrong_currency = stored is not None and stored.get("currency") != currency
    upgrade = (
        stored is not None
        and stored.get("name") in offline_names
        and generator.settings.coach_mode == "gemini"
    ) or wrong_currency
    if stored and not upgrade:
        ids = [world_id(body.lat, body.lng, i) for i in range(len(SPREAD))]
        existing = [bid for bid in ids if await anyio.to_thread.run_sync(store.public_shop, bid)]
        await anyio.to_thread.run_sync(seed_demo_signals, store, body.lat, body.lng)
        await anyio.to_thread.run_sync(seed_demo_deals, store, WORLD_OWNER_UID, existing)
        return WorldReceipt(shop_ids=existing, created=False, source="existing")
    world, source = await generator.generate(body.place, currency)
    if upgrade and source != "gemini" and not wrong_currency:
        ids = [world_id(body.lat, body.lng, i) for i in range(len(SPREAD))]
        return WorldReceipt(shop_ids=ids, created=False, source="existing")
    timezone = "Asia/Kolkata" if currency == "INR" else body.timezone
    records = world_records(world, body.lat, body.lng, currency, timezone, body.place)
    for bid, fields, products in records:
        await anyio.to_thread.run_sync(store.seed_demo_shop, WORLD_OWNER_UID, bid, fields, products)
    await anyio.to_thread.run_sync(seed_demo_signals, store, body.lat, body.lng)
    await anyio.to_thread.run_sync(seed_demo_deals, store, WORLD_OWNER_UID, [r[0] for r in records])
    log.info("demo_world_created", source=source, shops=len(records))
    return WorldReceipt(shop_ids=[r[0] for r in records], created=True, source=source)


@router.post("/world", response_model=WorldReceipt)
async def demo_world(body: WorldRequest, request: Request) -> WorldReceipt:
    """Make sure the visitor's ~2 km area has labelled demo shops (anonymous; rate limited)."""
    if not request.app.state.v1_settings.demo_world_enabled:
        return WorldReceipt(shop_ids=[], created=False, source="disabled")
    await enforce_limits(request, [("demo:world", client_ip(request))], anonymous=True)
    store: MerchantRepository = request.app.state.merchant
    generator: WorldGenerator = request.app.state.world_generator
    return await ensure_world(store, generator, body, request.app.state.community)
