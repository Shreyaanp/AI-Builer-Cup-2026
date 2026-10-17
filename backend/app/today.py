"""Today's 7: a finite, hand-picked set of neighbourhood finds that changes at 7 am local.

Card types, ranking and assembly follow docs/research/customer.md §3. Cards carry structured
facts (kind + params), never finished sentences, so every language words them itself. Every card
built on demo data says so. If fewer than 7 finds qualify, fewer are shown: weak cards never pad.
"""

from __future__ import annotations

import hashlib
import math
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

import anyio
import structlog
from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from .community import Community
from .community_routes import community, identity
from .demo_world import WorldGenerator, WorldRequest, ensure_world
from .discover import distance, open_now
from .discover_ask import search_engine
from .limits import client_ip, enforce_limits
from .merchant_routes import store
from .passport import (
    PassportState,
    active_festivals,
    area_name,
    geohash,
    is_food,
    local_now,
    shop_country,
)
from .passport_routes import passports
from .rescue_feed import RescueDeal, closing_today, live_rescues
from .search_engine import Taste
from .shop_time import valid_timezone

log = structlog.get_logger()
router = APIRouter(prefix="/api/v1")

FEED_SIZE = 7
DROP_HOUR = 7
RADIUS_M = 2000
GEM_RADIUS_M = 1500
WALK_M_PER_MIN = 80
MAX_PER_KIND = 2
MIN_SCORE = 0.05
SEEN_DAYS = 3
WORLD_MIN_SHOPS = 4

Kind = Literal[
    "only_one", "rescue", "hidden_gem", "new_this_week", "locally_made", "festival", "tip"
]
SURPRISE_LEADS = ("only_one", "hidden_gem")


class FindShop(BaseModel):
    id: str
    name: str
    category: str = ""
    demo: bool = False
    distance_m: int
    walk_min: int
    open_now: bool | None = None
    photo_url: str | None = None


class Find(BaseModel):
    id: str
    kind: Kind
    shop: FindShop | None = None
    params: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    source: Literal["chalkboard", "demo"]
    demo: bool
    action: Literal["go", "hold", "save", "trail"]
    score: float
    ends_at: float | None = None


class TodayArea(BaseModel):
    id: str
    name: str
    demo: bool


class TodayFeed(BaseModel):
    day: str  # the feed day (it starts at 07:00 local)
    next_drop: float  # epoch seconds of the next 07:00
    area: TodayArea
    finds: list[Find]
    candidates: int
    demo: bool
    signed_in: bool


# --- Time ---


def feed_day(local: datetime) -> date:
    return (local - timedelta(hours=DROP_HOUR)).date()


def next_drop(local: datetime) -> float:
    drop = local.replace(hour=DROP_HOUR, minute=0, second=0, microsecond=0)
    if local >= drop:
        drop += timedelta(days=1)
    return drop.astimezone(UTC).timestamp()


# --- Candidates ---


class Context(BaseModel):
    lat: float
    lng: float
    now: float
    follows: list[str] = Field(default_factory=list)
    vegetarian: bool = False
    halal: bool = False
    stamped_categories: list[str] = Field(default_factory=list)
    visited: list[str] = Field(default_factory=list)
    # Shop id → 0..1 likeness to this customer's own stamps, follows and searches (search engine).
    affinity: dict[str, float] = Field(default_factory=dict)


def shop_view(shop: dict[str, Any], ctx: Context) -> FindShop:
    gap = distance(ctx.lat, ctx.lng, shop["lat"], shop["lng"])
    gallery = shop.get("gallery") or []
    return FindShop(
        id=shop["id"],
        name=shop["name"],
        category=shop.get("category", ""),
        demo=bool(shop.get("demo")),
        distance_m=gap,
        walk_min=max(1, math.ceil(gap / WALK_M_PER_MIN)),
        open_now=open_now(
            shop.get("hours", ""),
            shop.get("timezone", "UTC"),
            datetime.fromtimestamp(ctx.now, UTC),
            shop.get("weekly_hours"),
            shop.get("closed_on"),
        ),
        photo_url=(
            f"/api/v1/public/shops/{shop['id']}/photos/{gallery[0]}.jpg" if gallery else None
        ),
    )


def score(find: Find, ctx: Context, surprise: float, age_hours: float = 0.0) -> float:
    shop = find.shop
    relevance = 1.0
    reach = 1.0
    if shop is not None:
        if shop.id in ctx.follows:
            relevance += 0.2
        if shop.category and shop.category in ctx.stamped_categories:
            relevance += 0.2
        relevance += 0.5 * ctx.affinity.get(shop.id, 0.0)
        reach = math.exp(-shop.distance_m / 1200) * (0.4 if shop.open_now is False else 1.0)
    freshness = 1.0 if find.kind == "rescue" else math.exp(-age_hours / 48)
    return round(surprise * relevance * freshness * reach, 4)


def matches_preferences(shop: dict[str, Any], ctx: Context) -> bool:
    facts = shop.get("facts") or {}
    return (ctx.vegetarian and bool(facts.get("vegetarian_options"))) or (
        ctx.halal and facts.get("halal") == "yes"
    )


# Everyday items are never "the only one", even when the data says so.
GENERIC = {
    "tea",
    "coffee",
    "kopi",
    "water",
    "bread",
    "rice",
    "eggs",
    "milk",
    "juice",
    "soda",
    "bananas",
    "tomatoes",
    "haircut",
    "light bulb",
    "fried rice",
    "fried noodles",
}


def norm(name: str) -> str:
    return " ".join(name.casefold().split())


def only_one_cards(shops: list[dict[str, Any]], ctx: Context, day: date) -> list[Find]:
    """An item sold by exactly one shop within 2 km."""
    sellers: dict[str, set[str]] = {}
    for shop in shops:
        for product in shop.get("products", []):
            if product.get("available", True):
                sellers.setdefault(norm(product["name"]), set()).add(shop["id"])
    if len(shops) < 3:
        return []  # "The only one" means nothing without others to compare.
    cards = []
    for shop in shops:
        unique = [
            p
            for p in shop.get("products", [])
            if p.get("available", True) and sellers.get(norm(p["name"])) == {shop["id"]}
        ]
        closed_today = bool(shop.get("weekly_hours")) and closing_today(shop, ctx.now) is None
        if not unique or closed_today:
            continue
        # Distinctive names make the surprise ("kouign-amann", not "tea"): prefer multi-word
        # names, and rotate between the two best each day so the card stays fresh.
        unique = [p for p in unique if norm(p["name"]) not in GENERIC] or []
        if not unique:
            continue
        unique.sort(key=lambda p: (-len(p["name"].split()), -len(p["name"])))
        top = unique[:2]
        pick = top[int(hashlib.sha256(f"{shop['id']}{day}".encode()).hexdigest(), 16) % len(top)]
        find = Find(
            id=f"only_one:{shop['id']}:{norm(pick['name'])[:40]}",
            kind="only_one",
            shop=shop_view(shop, ctx),
            params={
                "item": pick["name"],
                "price": pick["price"],
                "unit": pick["unit"],
                "currency": shop.get("currency", ""),
                "shops": len(shops),
                "radius_km": RADIUS_M // 1000,
            },
            source="demo" if shop.get("demo") else "chalkboard",
            demo=bool(shop.get("demo")),
            action="go",
            score=0,
        )
        surprise = (
            0.75 + (0.15 if matches_preferences(shop, ctx) else 0) + min(len(shops), 10) / 100
        )
        find.score = score(find, ctx, surprise)
        cards.append(find)
    return cards


def rescue_cards(
    deals: list[RescueDeal], by_id: dict[str, dict[str, Any]], ctx: Context
) -> list[Find]:
    """Live rescues ending within 60 min that you can still walk to in time."""
    cards = []
    for deal in deals:
        shop = by_id.get(deal.shop_id)
        if shop is None or deal.portions <= 0:
            continue
        left = (deal.pickup_end - ctx.now) / 60
        if not 0 < left <= 60 or deal.pickup_start > ctx.now + 15 * 60:
            continue
        view = shop_view(shop, ctx)
        if view.walk_min >= left:
            continue
        discount = 1 - deal.price / deal.was_price if deal.was_price else 0
        find = Find(
            id=f"rescue:{deal.id}",
            kind="rescue",
            shop=view,
            params={
                "rescue_id": deal.id,
                "item": deal.item,
                "portions": deal.portions,
                "price": deal.price,
                "was_price": deal.was_price,
                "currency": deal.currency,
                "discount_pct": round(discount * 100),
                "minutes_left": math.floor(left),
            },
            source="demo" if deal.demo or shop.get("demo") else "chalkboard",
            demo=deal.demo or bool(shop.get("demo")),
            action="hold",
            score=0,
            ends_at=deal.pickup_end,
        )
        find.score = score(find, ctx, 0.5 * (1 - left / 60) + 0.5 * min(1.0, discount + 0.3))
        cards.append(find)
    return cards


def story_of(shop: dict[str, Any]) -> str:
    custom = (shop.get("facts") or {}).get("custom") or []
    return next((str(c["value"]) for c in custom if c.get("key") == "story"), "")


def gem_cards(shops: list[dict[str, Any]], ctx: Context, tipped: set[str]) -> list[Find]:
    """A shop with a story nobody has written about yet."""
    cards = []
    for shop in shops:
        story = story_of(shop)
        if not story or shop["id"] in tipped:
            continue
        view = shop_view(shop, ctx)
        if view.distance_m > GEM_RADIUS_M:
            continue
        find = Find(
            id=f"hidden_gem:{shop['id']}",
            kind="hidden_gem",
            shop=view,
            params={"story": story[:120]},
            source="demo" if shop.get("demo") else "chalkboard",
            demo=bool(shop.get("demo")),
            action="go",
            score=0,
        )
        find.score = score(find, ctx, 0.7 + (0.1 if matches_preferences(shop, ctx) else 0))
        cards.append(find)
    return cards


def update_cards(service: Community, shops: list[dict[str, Any]], ctx: Context) -> list[Find]:
    """New on the menu, back in stock, cheaper: from the updates feed, under 7 days old."""
    by_id = {s["id"]: s for s in shops}
    surprise = {"new_item": 0.7, "price_change": 0.65, "back_in_stock": 0.5}
    cards = []
    for update in service.updates(list(by_id), limit=60):
        age = (ctx.now - update.created) / 3600
        if age > 7 * 24 or update.kind not in surprise:
            continue
        if update.kind == "price_change" and (update.old_price or 0) <= (update.price or 0):
            continue  # Only drops are good news.
        shop = by_id[update.shop_id]
        find = Find(
            id=f"new_this_week:{update.shop_id}:{update.kind}:{norm(update.item)[:40]}",
            kind="new_this_week",
            shop=shop_view(shop, ctx),
            params={
                "update": update.kind,
                "item": update.item,
                "price": update.price,
                "old_price": update.old_price,
                "unit": update.unit,
                "currency": update.currency,
                "days_ago": int(age // 24),
            },
            source="demo" if update.demo or shop.get("demo") else "chalkboard",
            demo=update.demo or bool(shop.get("demo")),
            action="go",
            score=0,
        )
        find.score = score(find, ctx, surprise[update.kind], age)
        cards.append(find)
    return cards


def made_here_cards(shops: list[dict[str, Any]], ctx: Context) -> list[Find]:
    cards = []
    for shop in shops:
        if not (shop.get("facts") or {}).get("locally_made") or shop["id"] in ctx.visited:
            continue
        find = Find(
            id=f"locally_made:{shop['id']}",
            kind="locally_made",
            shop=shop_view(shop, ctx),
            params={"category": shop.get("category", "")},
            source="demo" if shop.get("demo") else "chalkboard",
            demo=bool(shop.get("demo")),
            action="go",
            score=0,
        )
        variety = 0.1 if not is_food(shop.get("category", "")) else 0
        find.score = score(find, ctx, 0.6 + variety)
        cards.append(find)
    return cards


def festival_cards(shops: list[dict[str, Any]], ctx: Context, today: date) -> list[Find]:
    countries = {c for s in shops if (c := shop_country(s))}
    cards = []
    for country in sorted(countries):
        for fest in active_festivals(country, today):
            local = [s for s in shops if shop_country(s) == country]
            if len(local) < 4:
                continue
            days_left = (fest.end - today).days
            find = Find(
                id=f"festival:{fest.id}:{country}:{fest.start:%Y}",
                kind="festival",
                params={
                    "festival": fest.id,
                    "art": fest.art,
                    "stops": min(len(local), 5),
                    "ends": fest.end.isoformat(),
                    "days_left": days_left,
                    "quest_id": f"festival:{fest.id}:{country}:{fest.start:%Y}",
                    "approximate": True,
                },
                source="demo" if all(s.get("demo") for s in local) else "chalkboard",
                demo=all(s.get("demo") for s in local),
                action="trail",
                score=round(0.9 * (1.1 if days_left > 7 else 1.0), 4),
            )
            cards.append(find)
    return cards


def tip_cards(
    service: Community, shops: list[dict[str, Any]], ctx: Context
) -> tuple[list[Find], set[str]]:
    """The best neighbour tip nearby; also returns which shops have real tips."""
    cards = []
    tipped: set[str] = set()
    for shop in shops[:20]:
        if shop.get("demo"):
            service.seed_demo_tips(shop["id"], shop)
        for tip in service.tips(shop["id"]):
            if not tip.demo:
                tipped.add(shop["id"])
            if (tip.rating or 0) < 4 and tip.helpful < 2:
                continue
            age = (ctx.now - tip.created) / 3600
            find = Find(
                id=f"tip:{shop['id']}:{tip.id}",
                kind="tip",
                shop=shop_view(shop, ctx),
                params={
                    "text": tip.text,
                    "author": tip.name,
                    "rating": tip.rating,
                    "helpful": tip.helpful,
                    "days_ago": int(age // 24),
                    "tip_id": tip.id,
                },
                source="demo" if tip.demo else "chalkboard",
                demo=tip.demo,
                action="save",
                score=0,
            )
            # Tips age slowly: a good tip is still good next week.
            find.score = score(find, ctx, 0.55 + min(tip.helpful, 5) * 0.05, age / 4)
            cards.append(find)
    return cards, tipped


# --- Assembly ---


def assemble(candidates: list[Find], seen: set[str], keep: list[str]) -> list[Find]:
    """§3.3: the top of each type, then by score, ≤2 per type and ≤1 per shop, rescue first if
    it ends within 30 min, otherwise lead with a surprise card. Never pad with weak cards."""
    pool = [c for c in candidates if c.id not in seen and c.score >= MIN_SCORE]
    by_id = {c.id: c for c in candidates}
    if keep:
        # The same 7 all day: only cards that ended (a rescue) drop out.
        kept = [by_id[i] for i in keep if i in by_id]
        if kept:
            return kept
    pool.sort(key=lambda c: -c.score)
    chosen: list[Find] = []
    kinds: dict[str, int] = {}
    shops: set[str] = set()

    def take(card: Find) -> bool:
        shop = card.shop.id if card.shop else None
        if card in chosen or kinds.get(card.kind, 0) >= MAX_PER_KIND or (shop and shop in shops):
            return False
        chosen.append(card)
        kinds[card.kind] = kinds.get(card.kind, 0) + 1
        if shop:
            shops.add(shop)
        return True

    # Variety first: the best card of each type whose shop is not already on the list.
    for kind in dict.fromkeys(c.kind for c in pool):
        if len(chosen) >= FEED_SIZE:
            break
        next((c for c in pool if c.kind == kind and take(c)), None)
    for card in pool:
        if len(chosen) >= FEED_SIZE:
            break
        take(card)
    chosen.sort(key=lambda c: -c.score)
    urgent = next(
        (c for c in chosen if c.kind == "rescue" and c.ends_at and c.ends_at - time.time() <= 1800),
        None,
    )
    lead = urgent or next((c for c in chosen if c.kind in SURPRISE_LEADS), None)
    if lead is not None:
        chosen.remove(lead)
        chosen.insert(0, lead)
    return chosen


async def candidates_for(
    request: Request, shops: list[dict[str, Any]], ctx: Context, today: date
) -> list[Find]:
    service = community(request)
    by_id = {s["id"]: s for s in shops}
    for shop in shops[:20]:
        if shop.get("demo"):
            await anyio.to_thread.run_sync(service.seed_demo_updates, shop["id"], shop)
    deals = await live_rescues(request, shops, ctx.lat, ctx.lng, ctx.now)
    tips, tipped = await anyio.to_thread.run_sync(tip_cards, service, shops, ctx)
    updates = await anyio.to_thread.run_sync(update_cards, service, shops, ctx)
    return [
        *only_one_cards(shops, ctx, today),
        *rescue_cards(deals, by_id, ctx),
        *gem_cards(shops, ctx, tipped),
        *updates,
        *made_here_cards(shops, ctx),
        *festival_cards(shops, ctx, today),
        *tips,
    ]


async def nearby(request: Request, lat: float, lng: float) -> list[dict[str, Any]]:
    shops = await anyio.to_thread.run_sync(store(request).shared_shops)
    near = [
        (distance(lat, lng, s["lat"], s["lng"]), s)
        for s in shops
        if s.get("lat") is not None and s.get("lng") is not None and not s.get("supplier")
    ]
    return [s for d, s in sorted(near, key=lambda pair: pair[0]) if d <= RADIUS_M]


def seen_window(seen: dict[str, str], day: date) -> set[str]:
    """Finds shown on the previous 3 feed days (today's own set stays, for the whole day)."""
    earliest = (day - timedelta(days=SEEN_DAYS)).isoformat()
    return {i for i, d in seen.items() if earliest <= d < day.isoformat()}


@router.get("/public/today", response_model=TodayFeed)
async def today(
    request: Request,
    lat: float = Query(ge=-90, le=90),
    lng: float = Query(ge=-180, le=180),
    tz: str = Query(default="UTC", max_length=64),
    currency: str = Query(default="USD", pattern=r"^[A-Z]{3}$"),
    place: str = Query(default="", max_length=120),
    seen: str = Query(default="", max_length=4000, description="Finds shown on earlier days"),
    keep: str = Query(default="", max_length=2000, description="Today's finds, to keep them"),
    opened: str = Query(default="", max_length=1200, description="Shops opened on this device"),
) -> TodayFeed:
    """Anonymous; signed-in customers also get their follows, preferences and stamps applied,
    and the server remembers what they saw."""
    await enforce_limits(request, [("today", client_ip(request))], anonymous=True)
    timezone = valid_timezone(tz) or "UTC"
    now = time.time()
    local = local_now(timezone, now)
    day = feed_day(local)
    shops = await nearby(request, lat, lng)
    settings = request.app.state.v1_settings
    if len(shops) < WORLD_MIN_SHOPS and settings.demo_world_enabled:
        await enforce_limits(request, [("demo:world", client_ip(request))], anonymous=True)
        generator: WorldGenerator = request.app.state.world_generator
        await ensure_world(
            store(request),
            generator,
            WorldRequest(lat=lat, lng=lng, currency=currency, timezone=timezone, place=place),
            community(request),
        )
        shops = await nearby(request, lat, lng)
    principal = await identity(request).customer(request)
    ctx = Context(lat=lat, lng=lng, now=now)
    state = PassportState()
    memory: dict[str, Any] = {}
    asked: list[str] = []
    if principal is not None:
        profile = await anyio.to_thread.run_sync(community(request).profile, principal.uid)
        state = await anyio.to_thread.run_sync(passports(request).get, principal.uid)
        docs = community(request).docs
        memory = await anyio.to_thread.run_sync(lambda: docs.get("today", principal.uid) or {})
        ctx.follows = profile.follows
        ctx.vegetarian = profile.preferences.vegetarian
        ctx.halal = profile.preferences.halal
        asked = [s.q for s in profile.searches][:20]
    ctx.visited = list(state.shops)
    ctx.stamped_categories = sorted({s.category for s in state.shops.values() if s.category})
    taste = Taste(
        follows=ctx.follows[:200],
        stamped={bid: max(1, p.visits) for bid, p in state.shops.items()},
        asked=asked,
        opened=[i for i in opened.split(",") if i][:30],
    )
    if not taste.empty:
        # Zero data keeps the plain order (distance, open now, freshness); taste only reorders.
        try:
            engine = search_engine(request)
            known = await anyio.to_thread.run_sync(store(request).shared_shops)
            scores = await anyio.to_thread.run_sync(engine.personal, shops, taste, known)
            ctx.affinity = {bid: value for bid, (value, _) in scores.items()}
        except Exception:  # noqa: BLE001 - personal order is a refinement, never a blocker
            log.warning("today_affinity_unavailable")
    found = await candidates_for(request, shops, ctx, local.date())
    if principal is not None:
        history: dict[str, str] = dict(memory.get("seen", {}))
        kept = list(memory.get("ids", [])) if memory.get("day") == day.isoformat() else []
        finds = assemble(found, seen_window(history, day), kept)
        for find in finds:
            history.setdefault(find.id, day.isoformat())
        recent = dict(sorted(history.items(), key=lambda kv: kv[1])[-300:])
        await anyio.to_thread.run_sync(
            community(request).docs.put,
            "today",
            principal.uid,
            principal.uid,
            now,
            {"day": day.isoformat(), "ids": [f.id for f in finds], "seen": recent},
        )
    else:
        finds = assemble(
            found,
            {s for s in seen.split(",") if s},
            [k for k in keep.split(",") if k][:FEED_SIZE],
        )
    closest = shops[0] if shops else None
    return TodayFeed(
        day=day.isoformat(),
        next_drop=next_drop(local),
        area=TodayArea(
            id=geohash(lat, lng),
            name=(area_name(closest) if closest else "") or place[:60],
            demo=bool(shops) and all(s.get("demo") for s in shops),
        ),
        finds=finds,
        candidates=len(found),
        demo=any(f.demo for f in finds),
        signed_in=principal is not None,
    )
