"""Private, labelled tour shops with eight weeks of sales and linked feature records.

The owner gets their own copy (never shared publicly), so forecasts, the recap, Close the day
and sourcing all show real behaviour on filled data. It can be deleted like any shop.
"""

from __future__ import annotations

from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Query, Request

from .community_routes import customer
from .limits import enforce_limits
from .merchant_routes import consented_owner, store
from .sales import today_for
from .tour_catalogue import CENTRES, TOUR_SHOPS
from .tour_story import seed_customer, seed_story, seed_workspace, tour_id

router = APIRouter(prefix="/api/v1/demo")

# Phone timezone → the demo city whose currency and food feel local.
ZONE_CITY = {
    "Asia/Kolkata": "bengaluru",
    "Asia/Calcutta": "bengaluru",
    "Asia/Kuala_Lumpur": "kuala-lumpur",
    "Asia/Jakarta": "jakarta",
    "Asia/Tokyo": "tokyo",
    "Asia/Bangkok": "bangkok",
    "Asia/Singapore": "singapore",
}
TOUR_SUFFIX = " (Tour)"


@router.post("/workspace")
async def demo_workspace(
    request: Request, zone: str = Query(default="Asia/Singapore", max_length=64)
) -> dict[str, Any]:
    uid = await consented_owner(request)
    await enforce_limits(request, [("proposal", uid)])
    service = store(request)
    city = ZONE_CITY.get(zone, "singapore")
    city = city if city in {"bengaluru", "singapore"} else "singapore"

    def create() -> tuple[str, bool]:
        neighbours = request.app.state.community
        if request.app.state.v1_settings.app_env == "production":
            bid = tour_id(uid, city)
            if bid not in {b["id"] for b in service.list_businesses(uid)}:
                raise HTTPException(409, "The owner has not prepared this demo account yet.")
            return bid, False
        seed_story(service, neighbours)
        worlds = {
            world: seed_workspace(service, uid, world) for world in ("bengaluru", "singapore")
        }
        result = worlds[city]
        seed_customer(
            service,
            neighbours,
            uid,
            TOUR_SHOPS,
            today_for(next(s.fields.model_dump() for s in TOUR_SHOPS if s.city == city)),
        )
        return result

    bid, created = await anyio.to_thread.run_sync(create)
    return {"business_id": bid, "created": created}


@router.post("/customer")
async def demo_customer(
    request: Request,
    zone: str = Query(default=CENTRES["singapore"][3], max_length=64),
) -> dict[str, Any]:
    """Explicit opt-in; never run merely because somebody signs in or visits a shop."""
    principal = await customer(request)
    await enforce_limits(request, [("proposal", principal.uid)])
    neighbours = request.app.state.community

    def create() -> None:
        old = neighbours.docs.get("passport", principal.uid) or {}
        if old.get("points") or any(not s.get("demo") for s in old.get("stamps", [])):
            raise HTTPException(409, "Use a fresh demo account to load this story.")
        if request.app.state.v1_settings.app_env == "production":
            if not any(
                s.get("shop_id", "").startswith("demo-story-") for s in old.get("stamps", [])
            ):
                raise HTTPException(409, "The owner has not prepared this demo account yet.")
            return
        seed_story(store(request), neighbours, customer_uid=principal.uid)

    await anyio.to_thread.run_sync(create)
    city = "bengaluru" if ZONE_CITY.get(zone) == "bengaluru" else "singapore"
    lat, lng, _currency, _timezone, area = CENTRES[city]
    return {"ready": True, "place": {"lat": lat, "lng": lng, "label": area}}
