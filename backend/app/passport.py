"""Neighbourhood passport: verified stamps, points, levels, weekly streaks, quests and perks.

The server is the source of truth for signed-in customers. A stamp needs the shop's signed QR
key, a location fix inside the shop radius, and a new local day for that shop; everything else
earns no points (docs/research/customer.md §2.2). Signed-out visits get a signed receipt that
lives on the phone and merges once on sign-in. Demo shops earn "demo points", always kept apart
from real points. Levels never go down and points never expire.

All rules are pure functions over one PassportState document per customer, changed atomically
through the community Documents store (a Firestore transaction or BEGIN IMMEDIATE on SQLite).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import math
import re
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .discover import distance
from .shop_time import shop_timezone

# --- Rules (the doc's proposal, confirmed in PLAN-V2) ---

POINTS = {"visit": 20, "first": 30, "rescue": 40, "tip": 10, "helpful": 5}
VISIT_RADIUS_M = 150
MAX_ACCURACY_M = 100
MAX_STAMPS_PER_DAY = 6
MAX_RESCUES_PER_DAY = 2
MAX_TIP_POINTS_PER_DAY = 3
HELPFUL_CAP_PER_TIP = 25
MAX_SPEED_KMH = 150
# More rejected stamps than this in a day flags the account (kept off the leaderboard).
FLAG_REJECTS = 3
STREAK_MILESTONES = {4: 50, 8: 100, 12: 150, 26: 300}
# Streak freezes (docs/research/gamification.md §3): every passport starts with one, one more is
# earned every 4 active weeks or won on a scratch card, and at most 2 are banked. A freeze covers a
# missed week on its own, or the customer freezes a week ahead ("away next week").
RAIN_CHECK_EVERY = 4
WELCOME_FREEZES = 1
MAX_FREEZES = 2
QUEST_POINTS = {"trail": 100, "festival": 250}
MAX_STAMPS_KEPT = 300
MAX_RECEIPT_AGE = 30 * 86_400
CO2_KG_PER_MEAL = 2.7  # Too Good To Go's published life-cycle estimate (1 kg meal).
QR_KEY_VERSION = "v1"

LevelKey = Literal["newcomer", "regular", "local_hero"]
LEVELS: tuple[LevelKey, ...] = ("newcomer", "regular", "local_hero")
StampKind = Literal["visit", "first", "rescue", "tip"]
Verdict = Literal[
    "stamped",  # passport stamp + points
    "card_only",  # shop card stamp, no points (no location, or no shop pin)
    "already_today",
    "too_far",
    "low_accuracy",
    "too_fast",
    "daily_cap",
    "bad_key",
    "own_shop",
]

FOOD_WORDS = (
    "cafe",
    "café",
    "coffee",
    "kopi",
    "tea",
    "bakery",
    "bake",
    "food",
    "kitchen",
    "restaurant",
    "noodle",
    "hawker",
    "dessert",
    "sweet",
    "juice",
    "bar",
    "grocer",
    "mithai",
    "warung",
    "kissaten",
    "eatery",
    "dosa",
    "deli",
)


def makes_own(shop: dict[str, Any]) -> bool:
    """The owner said they make what they sell (a top-level field, or a public shop fact)."""
    return bool(shop.get("locally_made") or (shop.get("facts") or {}).get("locally_made"))


def is_food(category: str) -> bool:
    text = category.casefold()
    return any(word in text for word in FOOD_WORDS)


# --- QR keys and receipts ---


def qr_key(secret: str | bytes, bid: str) -> str:
    """The key printed into a shop's QR. It is stable per shop and key version, so a QR poster
    keeps working; a photo of it shared online still needs a location fix at the shop."""
    raw = secret.encode() if isinstance(secret, str) else secret
    digest = hmac.new(raw, f"qr:{QR_KEY_VERSION}:{bid}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode()[:16]


def valid_qr_key(secret: str | bytes, bid: str, key: str) -> bool:
    return bool(key) and hmac.compare_digest(qr_key(secret, bid), key)


# --- Geography ---

_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lng: float, precision: int = 5) -> str:
    """Area key: a 5-character geohash cell is about 4.9 × 4.9 km."""
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    bits, bit, even = 0, 0, True
    out: list[str] = []
    while len(out) < precision:
        rng, value = (lng_range, lng) if even else (lat_range, lat)
        mid = (rng[0] + rng[1]) / 2
        if value >= mid:
            bits = bits * 2 + 1
            rng[0] = mid
        else:
            bits *= 2
            rng[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(_BASE32[bits])
            bits, bit = 0, 0
    return "".join(out)


def area_name(shop: dict[str, Any]) -> str:
    """A readable neighbourhood from the shop's address ("Near Tiong Bahru (generated…)")."""
    text = re.sub(r"\(.*?\)", "", str(shop.get("location") or "")).strip()
    text = re.sub(r"^near\s+", "", text, flags=re.I)
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        return ""
    # "12 Seng Poh Rd, Tiong Bahru, Singapore": the neighbourhood is the part without digits.
    named = [p for p in parts if not re.search(r"\d", p)]
    name = (named or parts)[0]
    return "" if name.casefold() in {"you", "your area"} else name[:60]


def shop_area(shop: dict[str, Any]) -> str:
    lat, lng = shop.get("lat"), shop.get("lng")
    if lat is None or lng is None:
        return ""
    return geohash(float(lat), float(lng))


COUNTRY_BY_CURRENCY = {
    "SGD": "SG",
    "INR": "IN",
    "THB": "TH",
    "JPY": "JP",
    "IDR": "ID",
    "MYR": "MY",
    "PHP": "PH",
    "VND": "VN",
    "KRW": "KR",
    "AUD": "AU",
    "USD": "US",
    "GBP": "GB",
    "EUR": "EU",
}


def shop_country(shop: dict[str, Any]) -> str:
    return COUNTRY_BY_CURRENCY.get(str(shop.get("currency") or ""), "")


# --- Calendar ---


def local_now(timezone: str, now: float) -> datetime:
    try:
        tz = shop_timezone(timezone or "UTC")
    except Exception:
        tz = UTC
    return datetime.fromtimestamp(now, UTC).astimezone(tz)


def week_of(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{year}-W{week:02d}"


def monday_of(week: str) -> date:
    year, number = week.split("-W")
    return date.fromisocalendar(int(year), int(number), 1)


def weeks_between(first: str, last: str) -> list[str]:
    out: list[str] = []
    cursor, end = monday_of(first), monday_of(last)
    while cursor <= end and len(out) < 520:
        out.append(week_of(cursor))
        cursor += timedelta(days=7)
    return out


# --- Festival and seasonal trails (approximate windows, shown as approximate) ---


class Festival(BaseModel):
    id: str
    country: str
    # Visible from about 14 days before until 7 days after the festival.
    start: date
    end: date
    art: str
    themes: tuple[str, ...] = ()


FESTIVALS = [
    Festival(
        id="deepavali",
        country="SG",
        start=date(2026, 10, 10),
        end=date(2026, 11, 15),
        art="diya",
        themes=("sweet", "florist", "tailor", "bakery"),
    ),
    Festival(
        id="deepavali",
        country="MY",
        start=date(2026, 10, 10),
        end=date(2026, 11, 15),
        art="diya",
        themes=("sweet", "florist", "tailor"),
    ),
    Festival(
        id="diwali",
        country="IN",
        start=date(2026, 10, 10),
        end=date(2026, 11, 15),
        art="diya",
        themes=("sweet", "mithai", "florist", "grocer"),
    ),
    Festival(
        id="vegetarian_festival",
        country="TH",
        start=date(2026, 9, 28),
        end=date(2026, 10, 25),
        art="yellow_flag",
        themes=("street", "food", "noodle"),
    ),
    Festival(
        id="loy_krathong",
        country="TH",
        start=date(2026, 11, 10),
        end=date(2026, 12, 1),
        art="krathong",
        themes=("florist", "sweet"),
    ),
    Festival(
        id="momiji",
        country="JP",
        start=date(2026, 10, 18),
        end=date(2026, 12, 7),
        art="maple_leaf",
        themes=("cafe", "bakery", "florist", "stationer"),
    ),
    Festival(
        id="hatsumode",
        country="JP",
        start=date(2026, 12, 17),
        end=date(2027, 1, 10),
        art="kagami_mochi",
        themes=("sweet", "grocer"),
    ),
    Festival(
        id="chinese_new_year",
        country="SG",
        start=date(2027, 1, 23),
        end=date(2027, 2, 13),
        art="mandarin",
        themes=("bakery", "grocer", "florist"),
    ),
    Festival(
        id="pongal",
        country="IN",
        start=date(2026, 12, 31),
        end=date(2027, 1, 22),
        art="kite",
        themes=("sweet", "grocer"),
    ),
    Festival(
        id="ramadan",
        country="ID",
        start=date(2027, 1, 25),
        end=date(2027, 3, 17),
        art="bedug",
        themes=("food", "street", "sweet"),
    ),
]
FESTIVAL_STOPS = 4


def active_festivals(country: str, day: date) -> list[Festival]:
    return [f for f in FESTIVALS if f.country == country and f.start <= day <= f.end]


# --- State (one document per customer) ---


class StampRecord(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    shop_id: str
    shop_name: str = ""
    kind: StampKind
    day: str  # shop-local YYYY-MM-DD
    week: str  # ISO week of that day
    hour: int = 12  # shop-local hour, for the breakfast crawl
    at: float
    points: int = 0
    demo: bool = False
    area: str = ""
    area_name: str = ""
    category: str = ""
    country: str = ""
    made: bool = False  # the shop makes what it sells (collection set "Locally made")


class ShopProgress(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = ""
    area: str = ""
    area_name: str = ""
    category: str = ""
    country: str = ""
    demo: bool = False
    days: list[str] = Field(default_factory=list)  # distinct stamp days, newest last (max 60)
    visits: int = 0
    card: int = 0  # stamps on the shop's own card (reset when a reward is claimed)
    card_day: str = ""
    claimed: int = 0
    rescues: int = 0
    tipped: bool = False


# --- Game layer state (rules in games.py) ---

PrizeKind = Literal["points_10", "points_25", "perk", "freeze", "again"]


class ScratchTicket(BaseModel):
    """One scratch card, earned by a verified stamp. The server decides the prize when it issues
    the card and keeps it to itself until the customer scratches."""

    model_config = ConfigDict(extra="ignore")
    id: str
    shop_id: str
    shop_name: str = ""
    day: str
    at: float
    demo: bool = False
    first: bool = False
    has_perk: bool = False
    prize: PrizeKind
    perk_text: str = ""
    revealed: bool = False


class WonPerk(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    shop_id: str
    shop_name: str = ""
    text: str
    source: Literal["scratch", "set"]
    day: str
    demo: bool = False
    used: bool = False


class Fix(BaseModel):
    lat: float
    lng: float
    at: float


class PassportState(BaseModel):
    model_config = ConfigDict(extra="ignore")
    points: int = 0
    demo_points: int = 0
    level: LevelKey = "newcomer"  # the highest reached; never goes down
    stamps: list[StampRecord] = Field(default_factory=list)  # newest first
    shops: dict[str, ShopProgress] = Field(default_factory=dict)
    rescue_ids: list[str] = Field(default_factory=list)
    rescue_saved: dict[str, int] = Field(default_factory=dict)  # currency -> minor units
    helpful_tips: int = 0
    tip_helpful: dict[str, int] = Field(default_factory=dict)  # tip id -> points earned
    weeks: list[str] = Field(default_factory=list)  # ISO weeks with a verified stamp or rescue
    milestones: list[int] = Field(default_factory=list)
    quests_done: dict[str, float] = Field(default_factory=dict)
    week_points: dict[str, dict[str, int]] = Field(default_factory=dict)  # area -> week -> pts
    leaderboard: bool = False
    name: str = ""
    rejects: dict[str, int] = Field(default_factory=dict)  # day -> rejected stamp attempts
    last_fix: Fix | None = None
    finale_shops: list[str] = Field(default_factory=list)  # where a quest was completed
    # Game layer (games.py).
    scratch: list[ScratchTicket] = Field(default_factory=list)  # newest first
    scratches: int = 0  # cards ever issued (the first one always wins)
    freeze_wins: list[str] = Field(default_factory=list)  # ISO weeks a freeze was won
    frozen_weeks: list[str] = Field(default_factory=list)  # weeks frozen ahead by the customer
    won_perks: list[WonPerk] = Field(default_factory=list)
    sets_done: dict[str, float] = Field(default_factory=dict)
    coop_helped: dict[str, int] = Field(default_factory=dict)  # "area|week" -> visits given
    coop_claimed: list[str] = Field(default_factory=list)  # "area|week" bonuses collected


class Visit(BaseModel):
    """One verified (or attempted) action, already checked against the QR key."""

    shop_id: str
    shop: dict[str, Any]
    at: float
    lat: float | None = None
    lng: float | None = None
    accuracy: float | None = None
    own_shop: bool = False


class Outcome(BaseModel):
    verdict: Verdict
    points: int = 0
    demo: bool = False
    first: bool = False
    stamp: StampRecord | None = None
    level_before: LevelKey = "newcomer"
    level_after: LevelKey = "newcomer"
    quests_completed: list[str] = Field(default_factory=list)
    milestone: int | None = None
    distance_m: int | None = None
    card: int = 0


# --- Levels ---


class Requirement(BaseModel):
    key: Literal["points", "shops", "repeat", "areas", "rescues_or_tips"]
    have: int
    need: int
    alt_have: int | None = None
    alt_need: int | None = None

    @property
    def met(self) -> bool:
        return self.have >= self.need or (
            self.alt_need is not None and (self.alt_have or 0) >= self.alt_need
        )


def total_points(state: PassportState) -> int:
    return state.points + state.demo_points


def requirements(state: PassportState, level: LevelKey) -> list[Requirement]:
    stamped = [s for s in state.shops.values() if s.days]
    if level == "regular":
        return [
            Requirement(key="points", have=total_points(state), need=300),
            Requirement(key="shops", have=len(stamped), need=5),
            Requirement(key="repeat", have=min(1, sum(len(s.days) >= 2 for s in stamped)), need=1),
        ]
    if level == "local_hero":
        areas = len({s.area for s in stamped if s.area})
        return [
            Requirement(key="points", have=total_points(state), need=1200),
            Requirement(key="shops", have=len(stamped), need=15),
            Requirement(key="areas", have=areas, need=2),
            Requirement(
                key="rescues_or_tips",
                have=sum(s.rescues for s in state.shops.values()),
                need=5,
                alt_have=state.helpful_tips,
                alt_need=3,
            ),
        ]
    return []


def earned_level(state: PassportState) -> LevelKey:
    reached: LevelKey = "newcomer"
    for level in LEVELS[1:]:
        if all(r.met for r in requirements(state, level)):
            reached = level
        else:
            break
    # Levels never go down.
    return max(reached, state.level, key=LEVELS.index)


def next_level(level: LevelKey) -> LevelKey | None:
    index = LEVELS.index(level)
    return LEVELS[index + 1] if index + 1 < len(LEVELS) else None


# --- Weekly streak with an automatic rain check ---


Mark = Literal["done", "rain", "frozen", "missed", "current"]


class Streak(BaseModel):
    weeks: int
    # Freezes ready to use (also kept as rain_checks for older clients).
    rain_checks: int
    freezes: int = 0
    this_week: bool
    # The last 8 weeks, oldest first: done, rain (a freeze covered a missed week by itself),
    # frozen (the customer froze it ahead), missed, or current.
    row: list[Mark]
    # This week or next, when the customer froze it ahead.
    planned: list[str] = Field(default_factory=list)


def streak(state: PassportState, current_week: str) -> Streak:
    """Pure: replays every week since the first activity. Freezes are banked (one welcome, one
    every 4 active weeks, scratch wins; at most 2) and spent on a missed week only while a streak
    is running, so a freeze is never wasted."""
    active = set(state.weeks)
    planned = set(state.frozen_weeks)
    wins: dict[str, int] = {}
    for won in state.freeze_wins:
        wins[won] = wins.get(won, 0) + 1
    first = min(min(active | set(wins), default=current_week), current_week)
    timeline = weeks_between(first, current_week)
    length, held, earned_since = 0, WELCOME_FREEZES, 0
    marks: list[Mark] = []
    for week in timeline:
        held = min(MAX_FREEZES, held + wins.get(week, 0))
        if week in active:
            length += 1
            earned_since += 1
            if earned_since % RAIN_CHECK_EVERY == 0:
                held = min(MAX_FREEZES, held + 1)
            marks.append("done")
        elif week == current_week:
            # Still in progress: never breaks the streak.
            marks.append("frozen" if week in planned else "current")
        elif length and held:
            held -= 1
            marks.append("frozen" if week in planned else "rain")
        else:
            length, earned_since = 0, 0
            marks.append("missed")
    # A week frozen ahead holds its freeze until the week passes (a visit gives it back).
    ahead = sorted(
        w for w in planned if w > current_week or (w == current_week and w not in active)
    )
    ready = max(0, held - len(ahead))
    padding: list[Mark] = ["missed"] * 8
    return Streak(
        weeks=length,
        rain_checks=ready,
        freezes=ready,
        this_week=current_week in active,
        row=[*padding, *marks][-8:],
        planned=ahead,
    )


# --- Quests ---


class QuestStop(BaseModel):
    shop_id: str
    name: str
    done: bool = False
    demo: bool = False


class Quest(BaseModel):
    id: str
    kind: Literal["breakthrough", "crawl", "rescue", "makers", "festival"]
    festival: str | None = None
    art: str | None = None
    have: int
    need: int
    points: int
    ends: str  # shop-local date (inclusive)
    done: bool = False
    approximate: bool = False
    stops: list[QuestStop] = Field(default_factory=list)


def quest_definitions(day: date, countries: set[str]) -> list[dict[str, Any]]:
    week = week_of(day)
    monday = monday_of(week)
    sunday = monday + timedelta(days=6)
    month_end = (day.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    quests: list[dict[str, Any]] = [
        {"id": f"breakthrough:{week}", "kind": "breakthrough", "need": 3, "start": monday},
        {"id": f"crawl:{week}", "kind": "crawl", "need": 3, "start": monday},
        {"id": f"rescue:{week}", "kind": "rescue", "need": 3, "start": monday},
        {
            "id": f"makers:{day:%Y-%m}",
            "kind": "makers",
            "need": 3,
            "start": day.replace(day=1),
            "end": month_end,
        },
    ]
    for quest in quests:
        quest.setdefault("end", sunday)
        quest["points"] = QUEST_POINTS["trail"]
    for country in sorted(countries):
        for fest in active_festivals(country, day):
            quests.append(
                {
                    "id": f"festival:{fest.id}:{country}:{fest.start:%Y}",
                    "kind": "festival",
                    "festival": fest.id,
                    "art": fest.art,
                    "country": country,
                    "need": FESTIVAL_STOPS,
                    "start": fest.start,
                    "end": fest.end,
                    "points": QUEST_POINTS["festival"],
                    "themes": fest.themes,
                }
            )
    return quests


def quest_progress(state: PassportState, quest: dict[str, Any]) -> tuple[int, set[str]]:
    """How many qualifying steps are done, and at which shops."""
    start, end = quest["start"].isoformat(), quest["end"].isoformat()
    window = [s for s in state.stamps if start <= s.day <= end]
    kind = quest["kind"]
    if kind == "breakthrough":
        visits = [s for s in window if s.kind in ("visit", "first")]
        return len(visits), {s.shop_id for s in visits}
    if kind == "rescue":
        rescues = [s for s in window if s.kind == "rescue"]
        return len(rescues), {s.shop_id for s in rescues}
    if kind == "crawl":
        shops = {
            s.shop_id
            for s in window
            if s.kind in ("visit", "first") and s.hour < 10 and is_food(s.category)
        }
        return len(shops), shops
    if kind == "makers":
        shops = {
            s.shop_id
            for s in window
            if s.kind in ("visit", "first") and s.category and not is_food(s.category)
        }
        return len(shops), shops
    shops = {
        s.shop_id
        for s in window
        if s.kind in ("visit", "first", "rescue") and s.country == quest.get("country")
    }
    return len(shops), shops


# --- Applying actions ---


def _bump_counter(counter: dict[str, int], key: str, keep: int = 7) -> None:
    counter[key] = counter.get(key, 0) + 1
    for old in sorted(counter)[:-keep]:
        counter.pop(old, None)


def _award(
    state: PassportState,
    record: StampRecord,
    now_day: date,
    outcome: Outcome,
) -> None:
    """Adds a stamp's points, then the streak milestone and quests it completes."""
    state.stamps.insert(0, record)
    del state.stamps[MAX_STAMPS_KEPT:]
    if record.demo:
        state.demo_points += record.points
    else:
        state.points += record.points
    if record.kind in ("visit", "first", "rescue") and record.week not in state.weeks:
        state.weeks = sorted({*state.weeks, record.week})[-120:]
    extra = 0
    current = streak(state, record.week)
    for weeks, bonus in STREAK_MILESTONES.items():
        if current.weeks >= weeks and weeks not in state.milestones:
            state.milestones.append(weeks)
            outcome.milestone = weeks
            extra += bonus
    for quest in quest_definitions(now_day, {record.country} if record.country else set()):
        if quest["id"] in state.quests_done:
            continue
        have, _ = quest_progress(state, quest)
        if have >= quest["need"]:
            state.quests_done[quest["id"]] = record.at
            if record.shop_id not in state.finale_shops:
                state.finale_shops = [record.shop_id, *state.finale_shops][:50]
            outcome.quests_completed.append(quest["id"])
            extra += quest["points"]
    # Bonuses follow the stamp's own kind: demo actions earn demo points.
    if record.demo:
        state.demo_points += extra
    else:
        state.points += extra
    if record.area:
        area_weeks = state.week_points.setdefault(record.area, {})
        area_weeks[record.week] = area_weeks.get(record.week, 0) + record.points + extra
        for old in sorted(area_weeks)[:-4]:
            area_weeks.pop(old, None)
    outcome.points = record.points + extra
    outcome.demo = record.demo
    outcome.stamp = record


def shop_progress(state: PassportState, bid: str, shop: dict[str, Any]) -> ShopProgress:
    progress = state.shops.get(bid) or ShopProgress()
    progress.name = str(shop.get("name") or progress.name)[:80]
    progress.area = shop_area(shop) or progress.area
    progress.area_name = area_name(shop) or progress.area_name
    progress.category = str(shop.get("category") or progress.category)[:60]
    progress.country = shop_country(shop) or progress.country
    progress.demo = bool(shop.get("demo"))
    state.shops[bid] = progress
    return progress


def _record(
    kind: StampKind, bid: str, shop: dict[str, Any], local: datetime, at: float, points: int
) -> StampRecord:
    return StampRecord(
        id=hashlib.sha256(f"{kind}\0{bid}\0{at}".encode()).hexdigest()[:16],
        shop_id=bid,
        shop_name=str(shop.get("name") or "")[:80],
        kind=kind,
        day=local.date().isoformat(),
        week=week_of(local.date()),
        hour=local.hour,
        at=at,
        points=points,
        demo=bool(shop.get("demo")),
        area=shop_area(shop),
        area_name=area_name(shop),
        category=str(shop.get("category") or "")[:60],
        country=shop_country(shop),
        made=makes_own(shop),
    )


def _reject(state: PassportState, day: str, outcome: Outcome) -> Outcome:
    _bump_counter(state.rejects, day)
    return outcome


def apply_visit(state: PassportState, visit: Visit) -> Outcome:
    """A QR visit: passport stamp + points when every check passes, else a shop-card stamp only
    (no location) or nothing. Mutates state; the caller saves it atomically."""
    shop = visit.shop
    local = local_now(str(shop.get("timezone") or "UTC"), visit.at)
    day = local.date().isoformat()
    level_before = earned_level(state)
    outcome = Outcome(verdict="stamped", level_before=level_before, level_after=level_before)
    progress = state.shops.get(visit.shop_id)
    if progress and (progress.card_day == day or day in progress.days):
        outcome.verdict = "already_today"
        outcome.card = progress.card
        return outcome
    slat, slng = shop.get("lat"), shop.get("lng")
    located = visit.lat is not None and visit.lng is not None
    if visit.own_shop:
        outcome.verdict = "own_shop"
        return outcome
    # Demo shops are fictional and shown on screen in the demo, so their QR stamps without a
    # location fix. They only ever earn demo points; the day and daily-cap rules still apply.
    demo_shop = bool(shop.get("demo"))
    stamps_enabled = bool(
        shop.get("stamps_enabled")
        if "stamps_enabled" in shop
        else (shop.get("reward_text") or demo_shop)
    )
    if demo_shop:
        if located and slat is not None and slng is not None:
            assert visit.lat is not None and visit.lng is not None
            outcome.distance_m = distance(visit.lat, visit.lng, float(slat), float(slng))
    elif not located or slat is None or slng is None:
        # Location refused (or the shop has no pin): the shop card still counts if stamps are
        # enabled, the passport does not.
        if not stamps_enabled:
            outcome.verdict = "low_accuracy"
            return _reject(state, day, outcome)
        progress = shop_progress(state, visit.shop_id, shop)
        if progress.card_day != day:
            progress.card += 1
            progress.card_day = day
        outcome.verdict = "card_only"
        outcome.card = progress.card
        return outcome
    else:
        assert visit.lat is not None and visit.lng is not None
        assert slat is not None and slng is not None
        gap = distance(visit.lat, visit.lng, float(slat), float(slng))
        outcome.distance_m = gap
        if visit.accuracy is None or visit.accuracy > MAX_ACCURACY_M:
            outcome.verdict = "low_accuracy"
            return _reject(state, day, outcome)
        if gap > VISIT_RADIUS_M:
            outcome.verdict = "too_far"
            return _reject(state, day, outcome)
    last = state.last_fix
    if (
        not demo_shop
        and last
        and visit.lat is not None
        and visit.lng is not None
        and visit.at > last.at
    ):
        hours = (visit.at - last.at) / 3600
        km = distance(last.lat, last.lng, visit.lat, visit.lng) / 1000
        if km > 0.5 and km / max(hours, 1 / 3600) > MAX_SPEED_KMH:
            outcome.verdict = "too_fast"
            return _reject(state, day, outcome)
    today = [s for s in state.stamps if s.day == day and s.kind in ("visit", "first")]
    if len(today) >= MAX_STAMPS_PER_DAY:
        outcome.verdict = "daily_cap"
        return outcome
    first = progress is None or not progress.days
    points = POINTS["visit"] + (POINTS["first"] if first else 0)
    progress = shop_progress(state, visit.shop_id, shop)
    progress.days = [*progress.days, day][-60:]
    progress.visits += 1
    if stamps_enabled and progress.card_day != day:
        progress.card += 1
        progress.card_day = day
    if not demo_shop and visit.lat is not None and visit.lng is not None:
        state.last_fix = Fix(lat=visit.lat, lng=visit.lng, at=visit.at)
    record = _record("first" if first else "visit", visit.shop_id, shop, local, visit.at, points)
    _award(state, record, local.date(), outcome)
    outcome.first = first
    outcome.card = progress.card
    state.level = earned_level(state)
    outcome.level_after = state.level
    return outcome


def apply_rescue(
    state: PassportState,
    bid: str,
    shop: dict[str, Any],
    rescue_id: str,
    at: float,
    saved_minor: int = 0,
) -> Outcome:
    """A collected rescue: leaf stamp + 40 points, once per rescue, two a day."""
    local = local_now(str(shop.get("timezone") or "UTC"), at)
    day = local.date().isoformat()
    level_before = earned_level(state)
    outcome = Outcome(verdict="stamped", level_before=level_before, level_after=level_before)
    if rescue_id in state.rescue_ids:
        outcome.verdict = "already_today"
        return outcome
    if sum(1 for s in state.stamps if s.day == day and s.kind == "rescue") >= MAX_RESCUES_PER_DAY:
        outcome.verdict = "daily_cap"
        return outcome
    progress = shop_progress(state, bid, shop)
    progress.rescues += 1
    if not progress.days or progress.days[-1] != day:
        progress.days = [*progress.days, day][-60:]
    state.rescue_ids = [rescue_id, *state.rescue_ids][:200]
    currency = str(shop.get("currency") or "")
    if currency and saved_minor > 0:
        state.rescue_saved[currency] = state.rescue_saved.get(currency, 0) + saved_minor
    record = _record("rescue", bid, shop, local, at, POINTS["rescue"])
    _award(state, record, local.date(), outcome)
    state.level = earned_level(state)
    outcome.level_after = state.level
    return outcome


def apply_tip(state: PassportState, bid: str, shop: dict[str, Any], at: float) -> Outcome:
    """A tip that passed moderation: pencil stamp + 10 points, once per shop, three a day."""
    local = local_now(str(shop.get("timezone") or "UTC"), at)
    day = local.date().isoformat()
    level_before = earned_level(state)
    outcome = Outcome(verdict="stamped", level_before=level_before, level_after=level_before)
    progress = state.shops.get(bid)
    if progress and progress.tipped:
        outcome.verdict = "already_today"
        return outcome
    if sum(1 for s in state.stamps if s.day == day and s.kind == "tip") >= MAX_TIP_POINTS_PER_DAY:
        outcome.verdict = "daily_cap"
        return outcome
    progress = shop_progress(state, bid, shop)
    progress.tipped = True
    record = _record("tip", bid, shop, local, at, POINTS["tip"])
    _award(state, record, local.date(), outcome)
    state.level = earned_level(state)
    outcome.level_after = state.level
    return outcome


def apply_helpful(state: PassportState, tip_id: str, demo: bool) -> int:
    """A neighbour marked this customer's tip helpful: +5, up to 25 per tip."""
    earned = state.tip_helpful.get(tip_id, 0)
    if earned >= HELPFUL_CAP_PER_TIP:
        return 0
    if earned == 0:
        state.helpful_tips += 1
    state.tip_helpful[tip_id] = earned + POINTS["helpful"]
    if demo:
        state.demo_points += POINTS["helpful"]
    else:
        state.points += POINTS["helpful"]
    state.level = earned_level(state)
    return POINTS["helpful"]


def claim_card(state: PassportState, bid: str, needed: int) -> bool:
    """Counter staff saw a full card: it starts again (the day's stamp is kept, so no re-stamp)."""
    progress = state.shops.get(bid)
    if not progress or progress.card < needed:
        return False
    progress.card = 0
    progress.claimed += 1
    return True


def flagged(state: PassportState, now: float) -> bool:
    today = datetime.fromtimestamp(now, UTC).date()
    recent = {(today - timedelta(days=d)).isoformat() for d in range(-1, 2)}
    return any(count > FLAG_REJECTS for day, count in state.rejects.items() if day in recent)


# --- Storage ---


Edit = Callable[[PassportState], Any]


class PassportStore:
    """One passport document per customer, edited atomically (two devices never overwrite)."""

    def __init__(self, documents: Any) -> None:
        self.docs = documents

    def get(self, uid: str) -> PassportState:
        data = self.docs.get("passport", uid)
        return PassportState.model_validate(data) if data else PassportState()

    def edit(self, uid: str, edit: Edit) -> tuple[PassportState, Any]:
        state = PassportState()
        result: Any = None

        def change(data: dict[str, Any] | None) -> tuple[float, dict[str, Any]] | None:
            nonlocal state, result
            state = PassportState.model_validate(data) if data else PassportState()
            result = edit(state)
            return time.time(), state.model_dump(mode="json")

        self.docs.update("passport", uid, uid, change)
        return state, result

    def erase(self, uid: str) -> None:
        state = self.get(uid)
        for area in {s.area for s in state.shops.values() if s.area}:
            self.leave_board(uid, area)
        self.docs.delete("passport", uid)

    def use_receipt(self, digest: str, uid: str) -> bool:
        """A device receipt merges into one account only, once."""
        used = False

        def change(data: dict[str, Any] | None) -> tuple[float, dict[str, Any]] | None:
            nonlocal used
            if data is not None:
                used = True
                return None
            return time.time(), {"uid": hashlib.sha256(uid.encode()).hexdigest()[:16]}

        self.docs.update("receipt", digest, "receipts", change)
        return not used

    # Perks the owner funds (one small document per shop).

    def perks(self, bid: str) -> list[dict[str, Any]]:
        data = self.docs.get("perks", bid)
        return list((data or {}).get("perks", []))

    def save_perks(self, bid: str, perks: list[dict[str, Any]]) -> None:
        self.docs.put("perks", bid, bid, time.time(), {"perks": perks})

    def erase_shop(self, bid: str) -> None:
        self.docs.delete("perks", bid)

    # Opt-in weekly area board: display name, level and points; never where anyone went.

    def board_key(self, area: str, week: str) -> str:
        return f"{area}\0{week}"

    def board(self, area: str, week: str) -> dict[str, dict[str, Any]]:
        data = self.docs.get("board", self.board_key(area, week))
        return dict((data or {}).get("rows", {}))

    def post_board(self, uid: str, area: str, week: str, row: dict[str, Any] | None) -> None:
        member = hashlib.sha256(uid.encode()).hexdigest()[:16]

        def change(data: dict[str, Any] | None) -> tuple[float, dict[str, Any]] | None:
            rows = dict((data or {}).get("rows", {}))
            if row is None:
                if member not in rows:
                    return None
                rows.pop(member)
            else:
                rows[member] = row
            # Keep the board one small document: the top 200 this week.
            ranked = sorted(rows.items(), key=lambda kv: (-kv[1]["points"], kv[1]["at"]))
            return time.time(), {"rows": dict(ranked[:200])}

        self.docs.update("board", self.board_key(area, week), area, change)

    def leave_board(self, uid: str, area: str) -> None:
        week = week_of(datetime.now(UTC).date())
        self.post_board(uid, area, week, None)


def member_id(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:16]


def display(name: str) -> str:
    """First name and initial ("Mei L."), for the leaderboard."""
    parts = [p for p in re.split(r"\s+", name.strip()) if p]
    if not parts:
        return "Neighbour"
    first = parts[0][:20]
    return f"{first} {parts[1][0]}." if len(parts) > 1 else first


DEMO_NEIGHBOURS = (
    "Mei L.",
    "Arjun K.",
    "Siti N.",
    "Kenji T.",
    "Priya R.",
    "Ana S.",
    "Wei J.",
    "Nadia H.",
    "Tom B.",
    "Aiko M.",
    "Ravi P.",
    "Lina C.",
)


def demo_residents(area: str, week: str, count: int = 9) -> list[dict[str, Any]]:
    """Generated "neighbours" for a demo area, so the board never looks empty. Labelled demo."""
    seed = int(hashlib.sha256(f"{area}/{week}".encode()).hexdigest()[:8], 16)
    rows = []
    for index in range(count):
        name = DEMO_NEIGHBOURS[(seed + index * 5) % len(DEMO_NEIGHBOURS)]
        points = 40 + ((seed >> (index % 16)) % 260) - index * 12
        level: LevelKey = (
            "local_hero" if points > 240 else "regular" if points > 120 else "newcomer"
        )
        rows.append(
            {
                "name": name,
                "points": max(20, points),
                "level": level,
                "stamps": max(1, math.ceil(max(20, points) / 30)),
                "demo": True,
                "at": 0.0,
            }
        )
    return rows
