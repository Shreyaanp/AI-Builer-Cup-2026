"""Game routes: scratch a card, freeze a streak week, collect the co-op reward, use a won perk,
and a shop's game facts (odds, welcome stamps, reciprocity perks, "neighbours tried this").

Every outcome is decided on the server (docs/research/gamification.md). Each route returns the
whole passport, so the phone redraws from one source of truth.
"""

from __future__ import annotations

import time
from typing import Literal

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .community_routes import customer, signed_customer
from .customer_routes import shared
from .games import (
    FIRST_PRIZE,
    TRIED_MIN,
    WELCOME_STAMPS,
    Odd,
    claim_coop,
    demo_tried,
    odds,
    plan_freeze,
    reveal,
    use_perk,
)
from .limits import enforce_limits
from .passport import PrizeKind, local_now, week_of
from .passport_routes import (
    PassportView,
    Perk,
    ScratchView,
    build_view,
    coops,
    passports,
    scratch_view,
    shop_perks,
)

router = APIRouter(prefix="/api/v1")


class RevealResult(BaseModel):
    card: ScratchView
    passport: PassportView


class FreezeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    week: Literal["this", "next"]


class FreezeResult(BaseModel):
    verdict: Literal["frozen", "no_freezes", "already", "not_needed"]
    passport: PassportView


class CoopClaimInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    area: str = Field(min_length=1, max_length=12)
    week: str = Field(pattern=r"^\d{4}-W\d{2}$")


class ShopGames(BaseModel):
    """What a shop page shows about its games, signed in or not."""

    welcome: int
    needed: int
    reward: str
    # Distinct passports that stamped here in 30 days; hidden below 3 (never one person).
    tried: int | None
    demo: bool
    perks: list[Perk]
    odds: list[Odd]
    first_prize: PrizeKind


@router.post("/customer/games/scratch/{ticket_id}/reveal", response_model=RevealResult)
async def scratch(
    ticket_id: str,
    request: Request,
    lat: float | None = None,
    lng: float | None = None,
    tz: str = "UTC",
) -> RevealResult:
    principal = await customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    now = time.time()
    state, ticket = await anyio.to_thread.run_sync(
        passports(request).edit, principal.uid, lambda s: reveal(s, ticket_id[:40], now)
    )
    if ticket is None:
        raise HTTPException(404, "SCRATCH_NOT_FOUND")
    view = await build_view(
        request,
        state,
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )
    return RevealResult(card=scratch_view(ticket), passport=view)


@router.post("/customer/games/freeze", response_model=FreezeResult)
async def freeze(
    body: FreezeInput,
    request: Request,
    lat: float | None = None,
    lng: float | None = None,
    tz: str = "UTC",
) -> FreezeResult:
    principal = await customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    current = week_of(local_now(tz, time.time()).date())
    state, verdict = await anyio.to_thread.run_sync(
        passports(request).edit, principal.uid, lambda s: plan_freeze(s, current, body.week)
    )
    view = await build_view(
        request,
        state,
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )
    return FreezeResult(verdict=verdict, passport=view)


@router.post("/customer/games/coop/claim", response_model=PassportView)
async def claim_coop_reward(
    body: CoopClaimInput,
    request: Request,
    lat: float | None = None,
    lng: float | None = None,
    tz: str = "UTC",
) -> PassportView:
    """Everyone who helped this week's goal collects the shared reward, once."""
    principal = await signed_customer(request)
    await enforce_limits(request, [("passport", principal.uid)], anonymous=True)
    view = await build_view(
        request,
        await anyio.to_thread.run_sync(passports(request).get, principal.uid),
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )
    coop = view.games.coop if view.games else None
    if coop is None or (coop.area, coop.week) != (body.area, body.week) or not coop.reached:
        raise HTTPException(409, "COOP_NOT_REACHED")
    state, claimed = await anyio.to_thread.run_sync(
        passports(request).edit,
        principal.uid,
        lambda s: claim_coop(s, body.area, body.week, coop.demo),
    )
    if not claimed:
        raise HTTPException(409, "COOP_NOT_HELPED_OR_CLAIMED")
    return await build_view(
        request,
        state,
        signed_in=not principal.guest,
        lat=lat,
        lng=lng,
        timezone=tz,
        uid=principal.uid,
    )


@router.post("/customer/games/perks/{perk_id}/use", response_model=PassportView)
async def use_won_perk(perk_id: str, request: Request) -> PassportView:
    """Counter staff saw the won perk on the phone: it is marked used."""
    principal = await signed_customer(request)
    state, used = await anyio.to_thread.run_sync(
        passports(request).edit, principal.uid, lambda s: use_perk(s, perk_id[:60])
    )
    if not used:
        raise HTTPException(409, "PERK_NOT_AVAILABLE")
    return await build_view(request, state, signed_in=not principal.guest, uid=principal.uid)


@router.get("/public/shops/{business_id}/games", response_model=ShopGames)
async def shop_games(business_id: str, request: Request) -> ShopGames:
    shop = await shared(request, business_id)
    perks = await shop_perks(request, business_id, shop)
    demo = bool(shop.get("demo"))
    today = local_now(str(shop.get("timezone") or "UTC"), time.time()).date()
    count = (
        demo_tried(business_id)
        if demo
        else await anyio.to_thread.run_sync(coops(request).tried, business_id, today)
    )
    return ShopGames(
        welcome=WELCOME_STAMPS,
        needed=int(shop.get("stamps_needed") or 8),
        reward=str(shop.get("reward_text") or "")[:120],
        tried=count if count >= TRIED_MIN else None,
        demo=demo,
        perks=[Perk.model_validate(p) for p in perks],
        odds=odds(any(p["trigger"] == "scratch" for p in perks)),
        first_prize=FIRST_PRIZE,
    )
