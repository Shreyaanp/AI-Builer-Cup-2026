"""Neighbourhood passport routes: stamps, the passport view, merge, rescues, perks and the board.

Signed-in customers keep their passport on the server. Signed-out visitors get a signed visit
receipt per verified scan; the phone keeps those receipts ("on this phone"), the preview route
draws the same passport from them, and they merge once on sign-in.
"""

from __future__ import annotations

import contextlib
import hashlib
import time
from datetime import date, timedelta
from typing import Any, Literal

import anyio
import structlog
from fastapi import APIRouter, HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, ConfigDict, Field

from . import shop_today
from .auth import Principal
from .community_routes import community, customer, display_name, identity, signed_customer
from .customer_routes import shared
from .discover import distance
from .games import (
    COOP_BONUS,
    COOP_GOAL,
    COOP_GOAL_DEMO,
    PRIZE_POINTS,
    SET_POINTS,
    SETS,
    WELCOME_STAMPS,
    CoopStore,
    Odd,
    complete_sets,
    coop_key,
    demo_coop_visits,
    issue_scratch,
    odds,
    record_help,
    set_progress,
    shop_in_set,
)
from .limits import client_ip, enforce_limits
from .merchant_routes import owner, store
from .passport import (
    CO2_KG_PER_MEAL,
    LEVELS,
    MAX_RECEIPT_AGE,
    LevelKey,
    Outcome,
    PassportState,
    PassportStore,
    PrizeKind,
    Quest,
    QuestStop,
    Requirement,
    ScratchTicket,
    ShopProgress,
    StampRecord,
    Streak,
    Visit,
    WonPerk,
    apply_helpful,
    apply_rescue,
    apply_tip,
    apply_visit,
    area_name,
    claim_card,
    demo_residents,
    display,
    flagged,
    geohash,
    is_food,
    local_now,
    member_id,
    monday_of,
    next_level,
    qr_key,
    quest_definitions,
    quest_progress,
    requirements,
    shop_area,
    shop_country,
    shop_progress,
    streak,
    valid_qr_key,
    week_of,
)
from .region import shop_zone
from .rescue_feed import find_rescue, held

log = structlog.get_logger()
router = APIRouter(prefix="/api/v1")
MAX_RECEIPTS = 60
NEARBY_M = 1500


def passports(request: Request) -> PassportStore:
    service = getattr(request.app.state, "passport", None)
    if service is None:
        service = PassportStore(community(request).docs)
        request.app.state.passport = service
    return service


def coops(request: Request) -> CoopStore:
    service = getattr(request.app.state, "coop", None)
    if service is None:
        service = CoopStore(community(request).docs)
        request.app.state.coop = service
    return service


def secret(request: Request) -> bytes:
    key = identity(request).signer.secret_key
    return key if isinstance(key, bytes) else str(key).encode()


def receipt_signer(request: Request) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(secret(request), salt="passport-receipt")


async def is_owner(request: Request, uid: str, bid: str) -> bool:
    """An owner's own account earns no points at their shop."""
    try:
        await anyio.to_thread.run_sync(store(request).inquiries, uid, bid)
    except HTTPException:
        return False
    except Exception:
        return False
    return True


# --- Contracts ---


class StampInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shop_id: str = Field(min_length=1, max_length=80)
    key: str = Field(default="", max_length=40)
    lat: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    lng: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    accuracy: float | None = Field(default=None, ge=0, le=100_000, allow_inf_nan=False)


class PublicStampInput(StampInput):
    # This phone's earlier receipts: a signed-out scan is judged against them (already today,
    # first visit, daily cap, level), though nothing is stored.
    receipts: list[str] = Field(default_factory=list, max_length=MAX_RECEIPTS)


class RescueStampInput(StampInput):
    rescue_id: str = Field(min_length=1, max_length=160)


class MergeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receipts: list[str] = Field(default_factory=list, max_length=MAX_RECEIPTS)
    # Shop-card stamps kept on this phone without a receipt (location was off): card only.
    cards: dict[str, int] = Field(default_factory=dict, max_length=100)


class LevelView(BaseModel):
    key: LevelKey
    next: LevelKey | None
    # The single next thing to do ("2 more shops to Regular"), then the full list.
    next_requirement: Requirement | None
    requirements: list[Requirement]


class ShopStamp(BaseModel):
    id: str
    name: str
    area: str
    area_name: str
    category: str
    demo: bool
    visits: int
    days: int
    card: int
    claimed: int
    rescues: int
    last_day: str
    # The owner's card (stamps needed, reward) plus the welcome stamps printed on every card.
    needed: int = 8
    welcome: int = WELCOME_STAMPS
    reward: str = ""
    # The one count every screen shows for this card (shop button, card, passport): the welcome
    # stamps plus this customer's stamps, out of `slots` (needed + welcome). Both are 0 when the
    # shop has no stamp card (no reward set).
    stamps: int = 0
    slots: int = 0


class AreaView(BaseModel):
    id: str
    name: str
    shops: int
    stamps: int
    demo: bool


class Impact(BaseModel):
    meals: int
    co2_kg: float
    saved: dict[str, int]


PerkTrigger = Literal[
    "regular",
    "full_card",
    "quest_finale",
    "rescue_hero",
    # Reciprocity: small thank-yous the owner sets (docs/research/gamification.md §7).
    "third_visit",
    "tip",
    "follow",
    # Won, not unlocked: the shop's scratch-card prize and its collection-set finisher.
    "scratch",
    "set_complete",
]
EARNED_TRIGGERS = ("regular", "full_card", "quest_finale", "rescue_hero", "third_visit", "tip")


class PerkView(BaseModel):
    shop_id: str
    shop_name: str
    id: str
    trigger: PerkTrigger
    text: str
    demo: bool


class ScratchView(BaseModel):
    """A scratch card. Before it is scratched, the prize stays on the server; the odds that
    apply to this card are always shown."""

    id: str
    shop_id: str
    shop_name: str
    demo: bool
    first: bool
    odds: list[Odd]
    revealed: bool
    prize: PrizeKind | None = None
    points: int = 0
    perk_text: str = ""


class SetStop(BaseModel):
    shop_id: str
    name: str
    done: bool = False
    demo: bool = False


class SetView(BaseModel):
    id: str  # chai_trail, locally_made, night_market, or festival:<id>
    art: str
    have: int
    need: int
    done: bool
    stops: list[SetStop] = Field(default_factory=list)
    festival: str | None = None
    ends: str | None = None
    approximate: bool = False
    points: int = 0


class CoopView(BaseModel):
    area: str
    area_name: str
    week: str
    ends: str  # the week's Sunday (shop-local date)
    goal: int
    total: int
    demo_visits: int  # generated neighbours' visits included in total (demo areas only)
    you: int
    helpers: int
    reached: bool
    claimed: bool
    bonus: int
    demo: bool


class NextReward(BaseModel):
    """The single next named reward ("2 more stamps → free bun maska")."""

    kind: Literal["card", "set", "level"]
    left: int
    reward: str  # card: the owner's reward text; set: set id; level: level key
    shop_id: str = ""
    shop_name: str = ""


class GamesView(BaseModel):
    scratch: list[ScratchView]  # waiting to be scratched, newest first
    sets: list[SetView]
    coop: CoopView | None
    won_perks: list[WonPerk]
    next_reward: NextReward | None
    nudge: bool  # a gentle "keep your streak" line (Friday on, no visit yet, streak running)
    welcome_stamps: int = WELCOME_STAMPS


class PassportView(BaseModel):
    signed_in: bool
    device_only: bool = False
    points: int
    demo_points: int
    total: int
    level: LevelView
    streak: Streak
    stamps: list[StampRecord]
    shops: list[ShopStamp]
    areas: list[AreaView]
    quests: list[Quest]
    impact: Impact
    perks: list[PerkView]
    leaderboard: bool
    flagged: bool = False
    games: GamesView | None = None


class StampResult(BaseModel):
    outcome: Outcome
    passport: PassportView | None = None
    # Signed-out visitors keep this on the phone; it merges on sign-in.
    receipt: str | None = None
    # Signed in: the scratch card this stamp earned, and any collection sets it completed.
    scratch: ScratchView | None = None
    sets_completed: list[str] = Field(default_factory=list)


class QrKey(BaseModel):
    key: str
    demo: bool = False


class BoardRow(BaseModel):
    rank: int
    name: str
    level: LevelKey
    points: int
    stamps: int
    demo: bool = False
    you: bool = False


class Board(BaseModel):
    area: str
    week: str
    joined: bool
    rows: list[BoardRow]
    you: BoardRow | None = None


class Perk(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=40, pattern=r"^[a-z0-9-]+$")
    trigger: PerkTrigger
    text: str = Field(min_length=3, max_length=80)
    active: bool = True


class PerkList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    perks: list[Perk] = Field(default_factory=list, max_length=12)


# --- View ---


def demo_perks(shop: dict[str, Any]) -> list[dict[str, Any]]:
    """Demo shops offer fixed demo perks so every unlock can be shown; labelled demo."""
    return [
        {"id": "demo-regular", "trigger": "regular", "text": "Free upgrade on your next order"},
        {
            "id": "demo-card",
            "trigger": "full_card",
            "text": str(shop.get("reward_text") or "A small treat on the house")[:80],
        },
        {"id": "demo-rescue", "trigger": "rescue_hero", "text": "First pick of tomorrow's bake"},
        {"id": "demo-third", "trigger": "third_visit", "text": "Your third visit: a free refill"},
        {"id": "demo-tip", "trigger": "tip", "text": "Thanks for the tip: a free taster"},
        {"id": "demo-scratch", "trigger": "scratch", "text": "A free biscuit with any drink"},
        {"id": "demo-set", "trigger": "set_complete", "text": "Set finisher: pick any pastry"},
    ]


async def shop_perks(request: Request, bid: str, shop: dict[str, Any]) -> list[dict[str, Any]]:
    """The shop's active perks (or the demo set for a demo shop without its own)."""
    perks = await anyio.to_thread.run_sync(passports(request).perks, bid)
    if not perks and shop.get("demo"):
        perks = demo_perks(shop)
    return [p for p in perks if p.get("active", True)]


def perk_text(perks: list[dict[str, Any]], trigger: str) -> str:
    return next((str(p["text"]) for p in perks if p.get("trigger") == trigger), "")


async def recent_shops(request: Request, state: PassportState) -> dict[str, dict[str, Any]]:
    """The 30 most recently stamped shops that are still shared (one read each)."""
    recent = sorted(state.shops.items(), key=lambda kv: kv[1].days[-1:] or [""], reverse=True)
    found: dict[str, dict[str, Any]] = {}
    for bid, _ in recent[:30]:
        shop = await anyio.to_thread.run_sync(store(request).public_shop, bid)
        if shop is not None:
            found[bid] = shop
    return found


async def followed_shops(request: Request, uid: str | None) -> set[str]:
    if not uid:
        return set()
    try:
        profile = await anyio.to_thread.run_sync(community(request).profile, uid)
    except Exception:
        return set()
    return set(profile.follows)


async def perk_views(
    request: Request,
    state: PassportState,
    shops: dict[str, dict[str, Any]],
    followed: set[str],
) -> list[PerkView]:
    views: list[PerkView] = []
    regular = LEVELS.index(state.level) >= 1
    for bid, shop in shops.items():
        progress = state.shops[bid]
        needed = int(shop.get("stamps_needed") or 8)
        stamps_enabled = bool(
            shop.get("stamps_enabled") if "stamps_enabled" in shop else shop.get("reward_text")
        )
        for perk in await shop_perks(request, bid, shop):
            trigger = perk["trigger"]
            unlocked = (
                (trigger == "regular" and regular and len(progress.days) >= 2)
                or (trigger == "full_card" and stamps_enabled and progress.card >= needed)
                or (trigger == "quest_finale" and bid in state.finale_shops)
                or (trigger == "rescue_hero" and progress.rescues >= 3)
                or (trigger == "third_visit" and len(progress.days) >= 3)
                or (trigger == "tip" and progress.tipped)
                # A follow counts once the customer has also been to the shop.
                or (trigger == "follow" and bid in followed and bool(progress.days))
            )
            if unlocked:
                views.append(
                    PerkView(
                        shop_id=bid,
                        shop_name=progress.name,
                        id=perk["id"],
                        trigger=trigger,
                        text=perk["text"],
                        demo=bool(shop.get("demo")),
                    )
                )
    return views


async def nearby_shops(request: Request, lat: float | None, lng: float | None) -> list[dict]:
    if lat is None or lng is None:
        return []
    shops = await anyio.to_thread.run_sync(store(request).shared_shops)
    near = [
        (distance(lat, lng, s["lat"], s["lng"]), s)
        for s in shops
        if s.get("lat") is not None and s.get("lng") is not None and not s.get("supplier")
    ]
    return [s for d, s in sorted(near, key=lambda pair: pair[0]) if d <= NEARBY_M]


def quest_views(state: PassportState, today: date, nearby: list[dict[str, Any]]) -> list[Quest]:
    countries = {c for s in nearby if (c := shop_country(s))} | {
        s.country for s in state.shops.values() if s.country
    }
    views = []
    for quest in quest_definitions(today, countries):
        have, done_shops = quest_progress(state, quest)
        kind = quest["kind"]
        if kind == "crawl":
            pool = [s for s in nearby if is_food(str(s.get("category") or ""))]
        elif kind == "makers":
            pool = [s for s in nearby if not is_food(str(s.get("category") or ""))]
        elif kind == "festival":
            themes = quest.get("themes", ())
            local = [s for s in nearby if shop_country(s) == quest["country"]]
            pool = sorted(
                local,
                key=lambda s: not any(t in str(s.get("category", "")).casefold() for t in themes),
            )
        else:
            pool = []
        stops = [
            QuestStop(
                shop_id=s["id"],
                name=s["name"],
                done=s["id"] in done_shops,
                demo=bool(s.get("demo")),
            )
            for s in pool[: max(quest["need"] + 1, 4)]
        ]
        views.append(
            Quest(
                id=quest["id"],
                kind=kind,
                festival=quest.get("festival"),
                art=quest.get("art"),
                have=min(have, quest["need"]),
                need=quest["need"],
                points=quest["points"],
                ends=quest["end"].isoformat(),
                done=quest["id"] in state.quests_done,
                approximate=kind == "festival",
                stops=stops,
            )
        )
    return views


def scratch_view(ticket: ScratchTicket) -> ScratchView:
    return ScratchView(
        id=ticket.id,
        shop_id=ticket.shop_id,
        shop_name=ticket.shop_name,
        demo=ticket.demo,
        first=ticket.first,
        odds=odds(ticket.has_perk),
        revealed=ticket.revealed,
        prize=ticket.prize if ticket.revealed else None,
        points=PRIZE_POINTS.get(ticket.prize, 0) if ticket.revealed else 0,
        perk_text=ticket.perk_text if ticket.revealed else "",
    )


def set_views(
    state: PassportState, quests: list[Quest], nearby: list[dict[str, Any]]
) -> list[SetView]:
    views: list[SetView] = []
    for definition in SETS:
        collected = set_progress(state, definition.id)
        stops = [
            SetStop(
                shop_id=s["id"],
                name=s["name"],
                done=s["id"] in collected,
                demo=bool(s.get("demo")),
            )
            for s in nearby
            if shop_in_set(definition.id, s)
        ][:5]
        views.append(
            SetView(
                id=definition.id,
                art=definition.art,
                have=min(len(collected), definition.need),
                need=definition.need,
                done=definition.id in state.sets_done,
                stops=stops,
                points=SET_POINTS,
            )
        )
    # Festival trails are the festival quests, shown as limited-time sets.
    for quest in quests:
        if quest.kind != "festival":
            continue
        views.append(
            SetView(
                id=f"festival:{quest.festival}",
                art=quest.art or "",
                have=quest.have,
                need=quest.need,
                done=quest.done,
                stops=[SetStop(**stop.model_dump()) for stop in quest.stops],
                festival=quest.festival,
                ends=quest.ends,
                approximate=True,
                points=quest.points,
            )
        )
    return views


async def coop_view(
    request: Request,
    state: PassportState,
    today: date,
    nearby: list[dict[str, Any]],
    lat: float | None,
    lng: float | None,
) -> CoopView | None:
    """This week's shared goal for the customer's own area (their latest stamp, else here)."""
    latest = next((s for s in state.stamps if s.area), None)
    if latest:
        area, name, demo = latest.area, latest.area_name, latest.demo
    elif lat is not None and lng is not None:
        area = geohash(lat, lng)
        local = [s for s in nearby if shop_area(s) == area]
        if not local:
            return None
        name = next((n for s in local if (n := area_name(s))), "")
        demo = all(s.get("demo") for s in local)
    else:
        return None
    week = week_of(today)
    data = await anyio.to_thread.run_sync(coops(request).get, area, week)
    real = int(data.get("visits", 0))
    generated = demo_coop_visits(area, week, today) if demo else 0
    goal = COOP_GOAL_DEMO if demo else COOP_GOAL
    total = real + generated
    key = coop_key(area, week)
    return CoopView(
        area=area,
        area_name=name,
        week=week,
        ends=(monday_of(week) + timedelta(days=6)).isoformat(),
        goal=goal,
        total=total,
        demo_visits=generated,
        you=state.coop_helped.get(key, 0),
        helpers=len(data.get("helpers", {})),
        reached=total >= goal,
        claimed=key in state.coop_claimed,
        bonus=COOP_BONUS,
        demo=demo,
    )


def next_reward(
    state: PassportState,
    shops: dict[str, dict[str, Any]],
    sets: list[SetView],
    level: LevelView,
) -> NextReward | None:
    """The closest named reward: a shop card, then a collection set, else the next level."""
    cards: list[NextReward] = []
    for bid, shop in shops.items():
        stamps_enabled = bool(
            shop.get("stamps_enabled") if "stamps_enabled" in shop else shop.get("reward_text")
        )
        reward = str(shop.get("reward_text") or "")
        progress = state.shops[bid]
        if not stamps_enabled or not reward or not progress.card:
            continue
        left = max(0, int(shop.get("stamps_needed") or 8) - progress.card)
        card = NextReward(
            kind="card", left=left, reward=reward[:120], shop_id=bid, shop_name=progress.name
        )
        cards.append(card)
    if cards:
        # A shop's stamp card always outranks a set: it is the reward the owner promised.
        return min(cards, key=lambda card: card.left)
    options = [
        NextReward(kind="set", left=view.need - view.have, reward=view.id)
        for view in sets
        if not view.done and view.have and not view.festival
    ]
    if options:
        return min(options, key=lambda option: option.left)
    requirement = level.next_requirement
    if level.next and requirement:
        left = max(0, requirement.need - requirement.have)
        return NextReward(kind="level", left=left, reward=level.next)
    return None


def shop_stamp(bid: str, p: ShopProgress, shop: dict[str, Any]) -> ShopStamp:
    """One shop in the passport, with the card count every screen shows (welcome included)."""
    needed = int(shop.get("stamps_needed") or 8)
    enabled = bool(
        shop.get("stamps_enabled") if "stamps_enabled" in shop else shop.get("reward_text")
    )
    return ShopStamp(
        id=bid,
        name=p.name,
        area=p.area,
        area_name=p.area_name,
        category=p.category,
        demo=p.demo,
        visits=p.visits,
        days=len(p.days),
        card=p.card,
        claimed=p.claimed,
        rescues=p.rescues,
        last_day=(p.days or [""])[-1],
        needed=needed,
        reward=str(shop.get("reward_text") or "")[:120] if enabled else "",
        stamps=WELCOME_STAMPS + min(p.card, needed) if enabled else 0,
        slots=WELCOME_STAMPS + needed if enabled else 0,
    )


async def build_view(
    request: Request,
    state: PassportState,
    *,
    signed_in: bool,
    lat: float | None = None,
    lng: float | None = None,
    timezone: str = "UTC",
    device_only: bool = False,
    uid: str | None = None,
) -> PassportView:
    now = time.time()
    today = local_now(timezone, now).date()
    level = state.level
    upcoming = next_level(level)
    reqs = requirements(state, upcoming) if upcoming else []
    nearby = await nearby_shops(request, lat, lng)
    data = await recent_shops(request, state)
    shops = [
        shop_stamp(bid, p, data.get(bid) or {})
        for bid, p in sorted(state.shops.items(), key=lambda kv: kv[1].days[-1:], reverse=True)
    ]
    areas: dict[str, AreaView] = {}
    for shop in shops:
        if not shop.area:
            continue
        area = areas.setdefault(
            shop.area,
            AreaView(id=shop.area, name=shop.area_name, shops=0, stamps=0, demo=True),
        )
        area.shops += 1
        area.stamps += shop.days
        area.demo = area.demo and shop.demo
        area.name = area.name or shop.area_name
    meals = sum(p.rescues for p in state.shops.values())
    level_view = LevelView(
        key=level,
        next=upcoming,
        next_requirement=next((r for r in reqs if not r.met), None),
        requirements=reqs,
    )
    this_week = week_of(today)
    run = streak(state, this_week)
    quests = quest_views(state, today, nearby)
    sets = set_views(state, quests, nearby)
    games = GamesView(
        scratch=[scratch_view(t) for t in state.scratch if not t.revealed][:5],
        sets=sets,
        coop=await coop_view(request, state, today, nearby, lat, lng),
        won_perks=state.won_perks[:20],
        next_reward=next_reward(state, data, sets, level_view),
        # Gentle and rare: from Friday, only while a streak runs and this week has no visit.
        nudge=bool(
            run.weeks
            and not run.this_week
            and this_week not in run.planned
            and today.weekday() >= 4
        ),
    )
    return PassportView(
        signed_in=signed_in,
        device_only=device_only,
        points=state.points,
        demo_points=state.demo_points,
        total=state.points + state.demo_points,
        level=level_view,
        streak=run,
        stamps=state.stamps[:60],
        shops=shops,
        areas=list(areas.values()),
        quests=quests,
        impact=Impact(
            meals=meals, co2_kg=round(meals * CO2_KG_PER_MEAL, 1), saved=state.rescue_saved
        ),
        perks=await perk_views(request, state, data, await followed_shops(request, uid)),
        leaderboard=state.leaderboard,
        flagged=flagged(state, now),
        games=games,
    )


# --- Board helpers ---


async def post_board(request: Request, principal: Principal, state: PassportState) -> None:
    if principal.guest or not state.leaderboard or flagged(state, time.time()):
        return
    service = passports(request)
    week = week_of(local_now("UTC", time.time()).date())
    stamps_by_area: dict[str, int] = {}
    for record in state.stamps:
        if record.week == week and record.area:
            stamps_by_area[record.area] = stamps_by_area.get(record.area, 0) + 1
    for area, weeks in state.week_points.items():
        points = weeks.get(week, 0)
        if not points:
            continue
        row = {
            "name": display(display_name(principal)),
            "points": points,
            "level": state.level,
            "stamps": stamps_by_area.get(area, 0),
            "demo": False,
            "at": time.time(),
        }
        await anyio.to_thread.run_sync(service.post_board, principal.uid, area, week, row)


# --- QR keys ---


@router.get("/businesses/{business_id}/qr-key", response_model=QrKey)
async def owner_qr_key(business_id: str, request: Request) -> QrKey:
    uid = await owner(request)
    await anyio.to_thread.run_sync(store(request).inquiries, uid, business_id)
    return QrKey(key=qr_key(secret(request), business_id))


@router.get("/public/shops/{business_id}/demo-qr", response_model=QrKey)
async def demo_qr_key(business_id: str, request: Request) -> QrKey:
    """Demo shops show their QR on screen for the demo, so their key is public."""
    shop = await shared(request, business_id)
    if not shop.get("demo"):
        raise HTTPException(404, "Only demo shops show a demo QR.")
    return QrKey(key=qr_key(secret(request), business_id), demo=True)


# --- Stamps ---


async def verified_visit(
    request: Request, body: StampInput, uid: str | None
) -> tuple[dict[str, Any], Visit]:
    shop = await shared(request, body.shop_id)
    if not valid_qr_key(secret(request), body.shop_id, body.key):
        raise HTTPException(403, "BAD_QR_KEY")
    own = bool(uid) and await is_owner(request, uid or "", body.shop_id)
    return shop, Visit(
        shop_id=body.shop_id,
        shop=shop,
        at=time.time(),
        lat=body.lat,
        lng=body.lng,
        accuracy=body.accuracy,
        own_shop=own,
    )


@router.post("/customer/passport/stamps", response_model=StampResult)
async def stamp(body: StampInput, request: Request) -> StampResult:
    principal = await customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    shop, visit = await verified_visit(request, body, principal.uid)
    service = passports(request)
    perks = await shop_perks(request, body.shop_id, shop)

    def edit(state: PassportState) -> tuple[Outcome, ScratchTicket | None, list[str]]:
        outcome = apply_visit(state, visit)
        record = outcome.stamp
        if outcome.verdict != "stamped" or record is None or flagged(state, visit.at):
            return outcome, None, []
        # The game layer: a scratch card, collection sets, and this visit's co-op share.
        ticket = issue_scratch(state, record, perk_text(perks, "scratch"))
        sets = complete_sets(state, record, perk_text(perks, "set_complete"))
        outcome.points += SET_POINTS * len(sets)
        if record.area:
            record_help(state, record.area, record.week)
        return outcome, ticket, sets

    state, (outcome, ticket, sets) = await anyio.to_thread.run_sync(
        service.edit, principal.uid, edit
    )
    if ticket and outcome.stamp:
        record = outcome.stamp
        if record.area:
            await anyio.to_thread.run_sync(
                coops(request).add, record.area, record.week, principal.uid
            )
        await anyio.to_thread.run_sync(
            coops(request).add_tried, body.shop_id, principal.uid, record.day
        )
    await post_board(request, principal, state)
    log.info("passport_stamp", verdict=outcome.verdict, demo=outcome.demo, sets=len(sets))
    if outcome.verdict in ("stamped", "card_only"):
        # Daily totals for the owner's Today page; no customer is identified.
        zone = shop_zone(shop)
        returning = outcome.verdict == "stamped" and not outcome.first
        metrics: list[shop_today.Metric] = ["stamps", "returning"] if returning else ["stamps"]
        with contextlib.suppress(Exception):
            for metric in metrics:
                await anyio.to_thread.run_sync(
                    shop_today.count, store(request), body.shop_id, metric, zone
                )
    return StampResult(
        outcome=outcome,
        passport=await build_view(
            request,
            state,
            signed_in=not principal.guest,
            lat=body.lat,
            lng=body.lng,
            timezone=str(shop.get("timezone") or "UTC"),
            uid=principal.uid,
        ),
        scratch=scratch_view(ticket) if ticket else None,
        sets_completed=sets,
    )


@router.post("/public/passport/check", response_model=StampResult)
async def check(body: PublicStampInput, request: Request) -> StampResult:
    """Signed-out scan: the same checks, a signed receipt for the phone, nothing stored. The
    phone's earlier receipts are replayed first, so a second scan today is not a first visit."""
    await enforce_limits(request, [("passport", client_ip(request))], anonymous=True)
    if request.app.state.v1_settings.guest_customer:
        return await stamp(StampInput(**body.model_dump(exclude={"receipts"})), request)
    shop, visit = await verified_visit(request, body, None)
    state = PassportState()
    for _, earlier in await receipt_visits(request, body.receipts):
        apply_visit(state, earlier)
    outcome = apply_visit(state, visit)
    receipt = None
    if outcome.verdict == "stamped":
        receipt = receipt_signer(request).dumps(
            {"b": body.shop_id, "t": visit.at, "la": body.lat, "ln": body.lng, "a": body.accuracy}
        )
    return StampResult(outcome=outcome, receipt=receipt)


async def receipt_visits(request: Request, receipts: list[str]) -> list[tuple[str, Visit]]:
    signer = receipt_signer(request)
    found: list[tuple[str, Visit]] = []
    shops: dict[str, dict[str, Any] | None] = {}
    for receipt in list(dict.fromkeys(receipts))[:MAX_RECEIPTS]:
        try:
            data = signer.loads(receipt, max_age=MAX_RECEIPT_AGE)
        except BadSignature:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("b"), str):
            continue
        bid = data["b"]
        if bid not in shops:
            shops[bid] = await anyio.to_thread.run_sync(store(request).public_shop, bid)
        shop = shops[bid]
        if shop is None:
            continue
        found.append(
            (
                hashlib.sha256(receipt.encode()).hexdigest(),
                Visit(
                    shop_id=bid,
                    shop=shop,
                    at=float(data.get("t", 0)),
                    lat=data.get("la"),
                    lng=data.get("ln"),
                    accuracy=data.get("a"),
                ),
            )
        )
    found.sort(key=lambda pair: pair[1].at)
    return found


def apply_cards(
    state: PassportState, cards: dict[str, int], shops: dict[str, Any], *, exact: bool = False
) -> None:
    """This phone's stamp cards. On merge they only ever raise the account's card; signed out
    (`exact`) the phone's card is the card, so a reward claimed on the phone resets it here too
    and every screen shows the same count."""
    for bid, count in cards.items():
        shop = shops.get(bid)
        if shop is None or not isinstance(count, int) or count < 0:
            continue
        if count == 0 and not (exact and bid in state.shops):
            continue
        progress = shop_progress(state, bid, shop)
        count = min(count, int(shop.get("stamps_needed") or 8))
        progress.card = count if exact else max(progress.card, count)


@router.post("/public/passport/preview", response_model=PassportView)
async def preview(
    body: MergeInput,
    request: Request,
    lat: float | None = None,
    lng: float | None = None,
    tz: str = "UTC",
) -> PassportView:
    """The passport drawn from this phone's receipts (signed out: "on this phone")."""
    await enforce_limits(request, [("discover", client_ip(request))], anonymous=True)
    state = PassportState()
    shops: dict[str, Any] = {}
    for _, visit in await receipt_visits(request, body.receipts):
        apply_visit(state, visit)
        shops[visit.shop_id] = visit.shop
    for bid in list(body.cards)[:100]:
        if bid not in shops:
            shops[bid] = await anyio.to_thread.run_sync(store(request).public_shop, bid)
    apply_cards(state, body.cards, {k: v for k, v in shops.items() if v}, exact=True)
    return await build_view(
        request, state, signed_in=False, device_only=True, lat=lat, lng=lng, timezone=tz
    )


@router.post("/customer/passport/merge", response_model=PassportView)
async def merge(
    body: MergeInput,
    request: Request,
    lat: float | None = None,
    lng: float | None = None,
    tz: str = "UTC",
) -> PassportView:
    """Once on sign-in: this phone's receipts are re-checked and each counts once, ever."""
    principal = await customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    service = passports(request)
    fresh: list[Visit] = []
    shops: dict[str, Any] = {}
    for digest, visit in await receipt_visits(request, body.receipts):
        if await anyio.to_thread.run_sync(service.use_receipt, digest, principal.uid):
            fresh.append(visit)
        shops[visit.shop_id] = visit.shop
    for bid in list(body.cards)[:100]:
        if bid not in shops:
            shops[bid] = await anyio.to_thread.run_sync(store(request).public_shop, bid)
    owned = {bid for bid in shops if await is_owner(request, principal.uid, bid)}

    def edit(state: PassportState) -> None:
        for visit in fresh:
            visit.own_shop = visit.shop_id in owned
            apply_visit(state, visit)
        if not request.app.state.v1_settings.guest_customer:
            apply_cards(state, body.cards, {k: v for k, v in shops.items() if v})

    state, _ = await anyio.to_thread.run_sync(service.edit, principal.uid, edit)
    await post_board(request, principal, state)
    return await build_view(
        request,
        state,
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )


@router.get("/customer/passport", response_model=PassportView)
async def passport(
    request: Request, lat: float | None = None, lng: float | None = None, tz: str = "UTC"
) -> PassportView:
    principal = await customer(request)
    state = await anyio.to_thread.run_sync(passports(request).get, principal.uid)
    return await build_view(
        request,
        state,
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )


@router.delete("/customer/passport")
async def erase_passport(request: Request) -> dict[str, bool]:
    principal = await customer(request)
    state = await anyio.to_thread.run_sync(passports(request).get, principal.uid)
    # The shared tallies forget this customer too (co-op help, "neighbours tried this").
    helped: dict[str, list[str]] = {}
    for key in state.coop_helped:
        area, _, week = key.partition("|")
        helped.setdefault(area, []).append(week)
    await anyio.to_thread.run_sync(
        coops(request).erase_member, principal.uid, helped, list(state.shops)
    )
    await anyio.to_thread.run_sync(passports(request).erase, principal.uid)
    return {"deleted": True}


@router.post("/customer/passport/shops/{business_id}/claim", response_model=PassportView)
async def claim(business_id: str, request: Request) -> PassportView:
    """Counter staff saw the full card: it starts again."""
    principal = await signed_customer(request)
    shop = await shared(request, business_id)
    needed = int(shop.get("stamps_needed") or 8)
    state, claimed = await anyio.to_thread.run_sync(
        passports(request).edit, principal.uid, lambda s: claim_card(s, business_id, needed)
    )
    if not claimed:
        raise HTTPException(409, "CARD_NOT_FULL")
    return await build_view(request, state, signed_in=not principal.guest, uid=principal.uid)


# --- Rescue collected (QR at pickup) ---


@router.post("/customer/passport/rescues", response_model=StampResult)
async def collect_rescue(body: RescueStampInput, request: Request) -> StampResult:
    """Scanning the shop QR during the pickup window collects what this customer held in chat:
    leaf stamp, a rescued meal and the money saved."""
    principal = await signed_customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    shop, visit = await verified_visit(request, body, principal.uid)
    now = time.time()
    deal = await find_rescue(request, shop, body.rescue_id, now)
    if deal is None or not deal.starts - 15 * 60 <= now <= deal.ends + 15 * 60:
        raise HTTPException(409, "RESCUE_NOT_ACTIVE")
    holds = await rescue_holds(request, principal.uid, body.shop_id, deal.id)
    if not holds:
        raise HTTPException(409, "NO_HOLD")
    probe = apply_visit(PassportState(), visit)
    if probe.verdict != "stamped" or visit.own_shop:
        return StampResult(outcome=probe)
    saved = sum(max(0, p.was - p.price) * holds.get(p.name, 0) for p in deal.items)
    state, outcome = await anyio.to_thread.run_sync(
        passports(request).edit,
        principal.uid,
        lambda s: apply_rescue(s, body.shop_id, shop, deal.id, now, saved),
    )
    await post_board(request, principal, state)
    return StampResult(
        outcome=outcome,
        passport=await build_view(
            request,
            state,
            signed_in=not principal.guest,
            lat=body.lat,
            lng=body.lng,
            uid=principal.uid,
        ),
    )


async def rescue_holds(
    request: Request, uid: str, business_id: str, rescue_id: str
) -> dict[str, int]:
    """What this customer's chat with the shop holds in the deal ("Hold one for me")."""
    entry = await anyio.to_thread.run_sync(community(request).thread_for_shop, uid, business_id)
    if entry is None:
        return {}
    return await anyio.to_thread.run_sync(
        held, store(request), business_id, rescue_id, entry["iid"]
    )


async def award_rescue(
    request: Request, uid: str, business_id: str, rescue_id: str, saved_minor: int = 0
) -> Outcome:
    """For the owner's "Collected" tap in chat (rescue feature): the customer gets the stamp."""
    shop = await shared(request, business_id)
    _, outcome = await anyio.to_thread.run_sync(
        passports(request).edit,
        uid,
        lambda s: apply_rescue(s, business_id, shop, rescue_id, time.time(), saved_minor),
    )
    return outcome


async def award_tip(request: Request, uid: str, business_id: str, shop: dict[str, Any]) -> None:
    """A tip that passed moderation earns a pencil stamp (called by the tip route)."""
    if await is_owner(request, uid, business_id):
        return
    await anyio.to_thread.run_sync(
        passports(request).edit, uid, lambda s: apply_tip(s, business_id, shop, time.time())
    )


# --- Helpful tips ---


class Helpful(BaseModel):
    helpful: int


@router.post("/customer/shops/{business_id}/tips/{tip_id}/helpful", response_model=Helpful)
async def mark_helpful(business_id: str, tip_id: str, request: Request) -> Helpful:
    principal = await customer(request)
    shop = await shared(request, business_id)
    await enforce_limits(request, [("helpful", principal.uid)], anonymous=True)
    service = community(request)
    author, count = await anyio.to_thread.run_sync(
        service.mark_helpful, business_id, tip_id, principal.uid
    )
    if author:
        demo = bool(shop.get("demo"))
        await anyio.to_thread.run_sync(
            passports(request).edit, author, lambda s: apply_helpful(s, tip_id, demo)
        )
    return Helpful(helpful=count)


# --- Leaderboard (opt-in) ---


class BoardInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    on: bool


@router.put("/customer/passport/leaderboard", response_model=PassportView)
async def join_board(body: BoardInput, request: Request) -> PassportView:
    principal = await signed_customer(request)
    service = passports(request)

    def edit(state: PassportState) -> None:
        state.leaderboard = body.on

    state, _ = await anyio.to_thread.run_sync(service.edit, principal.uid, edit)
    if body.on:
        await post_board(request, principal, state)
    else:
        for area in state.week_points:
            await anyio.to_thread.run_sync(service.leave_board, principal.uid, area)
    return await build_view(request, state, signed_in=not principal.guest, uid=principal.uid)


@router.get("/customer/passport/board", response_model=Board)
async def board(
    request: Request, area: str = "", lat: float | None = None, lng: float | None = None
) -> Board:
    principal = await signed_customer(request)
    service = passports(request)
    state = await anyio.to_thread.run_sync(service.get, principal.uid)
    if not area and lat is not None and lng is not None:
        area = geohash(lat, lng)
    if not area:
        area = max(state.week_points, key=lambda a: sum(state.week_points[a].values()), default="")
    if not area:
        shop_areas = [p.area for p in state.shops.values() if p.area]
        if shop_areas:
            area = shop_areas[0]
    week = week_of(local_now("UTC", time.time()).date())
    if not area or len(area) > 12:
        return Board(area="", week=week, joined=state.leaderboard, rows=[], you=None)
    rows = await anyio.to_thread.run_sync(service.board, area, week)
    me = member_id(principal.uid)
    entries = [{**row, "you": key == me} for key, row in rows.items()]
    nearby = await nearby_shops(request, lat, lng)
    demo_area = any(s.get("demo") for s in nearby) or any(
        p.demo for p in state.shops.values() if p.area == area
    )
    if demo_area:
        entries += [{**r, "you": False} for r in demo_residents(area, week)]
    if state.leaderboard and not any(e["you"] for e in entries):
        points = state.week_points.get(area, {}).get(week, 0)
        entries.append(
            {
                "name": display(display_name(principal)),
                "points": points,
                "level": state.level,
                "stamps": 0,
                "demo": False,
                "at": time.time(),
                "you": True,
            }
        )
    entries.sort(key=lambda e: (-e["points"], e["at"]))
    ranked = [
        BoardRow(
            rank=index + 1,
            name=e["name"] if (state.leaderboard or e.get("demo")) else "•••",
            level=e["level"],
            points=e["points"],
            stamps=e["stamps"],
            demo=bool(e.get("demo")),
            you=e["you"],
        )
        for index, e in enumerate(entries)
    ]
    you = next((r for r in ranked if r.you), None)
    return Board(area=area, week=week, joined=state.leaderboard, rows=ranked[:30], you=you)


# --- Perks the owner funds ---


@router.get("/businesses/{business_id}/perks", response_model=PerkList)
async def owner_perks(business_id: str, request: Request) -> PerkList:
    uid = await owner(request)
    await anyio.to_thread.run_sync(store(request).inquiries, uid, business_id)
    perks = await anyio.to_thread.run_sync(passports(request).perks, business_id)
    return PerkList(perks=[Perk.model_validate(p) for p in perks])


@router.put("/businesses/{business_id}/perks", response_model=PerkList)
async def save_perks(business_id: str, body: PerkList, request: Request) -> PerkList:
    uid = await owner(request)
    await anyio.to_thread.run_sync(store(request).inquiries, uid, business_id)
    if len({p.id for p in body.perks}) != len(body.perks):
        raise HTTPException(422, "Each perk needs its own ID.")
    await anyio.to_thread.run_sync(
        passports(request).save_perks, business_id, [p.model_dump() for p in body.perks]
    )
    return body


@router.get("/public/shops/{business_id}/perks", response_model=PerkList)
async def public_perks(business_id: str, request: Request) -> PerkList:
    shop = await shared(request, business_id)
    perks = await anyio.to_thread.run_sync(passports(request).perks, business_id)
    if not perks and shop.get("demo"):
        perks = demo_perks(shop)
    return PerkList(perks=[Perk.model_validate(p) for p in perks if p.get("active", True)])


__all__ = ["award_rescue", "award_tip", "router", "shop_area"]
