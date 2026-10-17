"""Owner demand, rescue and morning brief; public rescue discovery and owned-chat holds."""

import time
from typing import Annotated, Any

import anyio
from fastapi import APIRouter, HTTPException, Query, Request

from . import brief, demand, rescue
from .community_routes import act, owned, signed_customer
from .customer_routes import shared
from .limits import client_ip, enforce_limits
from .merchant import Approval
from .merchant_routes import consented_owner, owner, store
from .rescue_feed import PublicRescue, nearby

router = APIRouter(prefix="/api/v1", tags=["owner features"])


@router.get("/businesses/{business_id}/radar", response_model=demand.Radar)
async def get_radar(business_id: str, request: Request) -> demand.Radar:
    uid = await owner(request)
    await enforce_limits(request, [("owner:read", uid)])
    return await anyio.to_thread.run_sync(demand.radar, store(request), uid, business_id)


@router.get("/businesses/{business_id}/rescue/suggestions", response_model=rescue.Suggestions)
async def rescue_suggestions(business_id: str, request: Request) -> rescue.Suggestions:
    uid = await owner(request)
    await enforce_limits(request, [("owner:read", uid)])
    service = store(request)
    context = await anyio.to_thread.run_sync(service.context, uid, business_id)
    sales, forecast = await brief.today_forecast(
        service, uid, business_id, request.app.state.forecaster, context
    )
    return rescue.suggestions(context, sales, forecast)


@router.post("/businesses/{business_id}/rescue", response_model=rescue.RescueProposal)
async def propose_rescue(
    business_id: str, body: rescue.RescueInput, request: Request
) -> rescue.RescueProposal:
    uid = await consented_owner(request)
    await enforce_limits(request, [("rescue:write", uid)])
    return await anyio.to_thread.run_sync(rescue.prepare, store(request), uid, business_id, body)


@router.post("/businesses/{business_id}/rescue/{rescue_id}/approve", response_model=rescue.Deal)
async def approve_rescue(
    business_id: str, rescue_id: str, body: Approval, request: Request
) -> rescue.Deal:
    uid = await consented_owner(request)
    await enforce_limits(request, [("rescue:write", uid)])
    return await anyio.to_thread.run_sync(
        rescue.approve, store(request), uid, business_id, rescue_id, body.digest
    )


@router.get("/businesses/{business_id}/rescue", response_model=list[rescue.Deal])
async def list_rescue(business_id: str, request: Request) -> list[rescue.Deal]:
    uid = await owner(request)
    await enforce_limits(request, [("owner:read", uid)])
    await anyio.to_thread.run_sync(store(request).context, uid, business_id)
    return await anyio.to_thread.run_sync(rescue.deals, store(request), business_id)


@router.delete("/businesses/{business_id}/rescue/{rescue_id}", response_model=rescue.Deal)
async def end_rescue(business_id: str, rescue_id: str, request: Request) -> rescue.Deal:
    uid = await consented_owner(request)
    await enforce_limits(request, [("rescue:write", uid)])
    return await anyio.to_thread.run_sync(rescue.end, store(request), uid, business_id, rescue_id)


@router.get("/public/rescue", response_model=list[PublicRescue])
async def public_rescue(
    request: Request,
    lat: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False)],
    lng: Annotated[float, Query(ge=-180, le=180, allow_inf_nan=False)],
    radius: Annotated[int, Query(ge=200, le=10000)] = 2000,
) -> list[PublicRescue]:
    await enforce_limits(request, [("rescue:public", client_ip(request))], anonymous=True)
    service = store(request)

    def load() -> list[PublicRescue]:
        return nearby(service, service.shared_shops(), lat, lng, radius, time.time())[:50]

    return await anyio.to_thread.run_sync(load)


@router.post("/customer/shops/{business_id}/rescue/{rescue_id}/hold", response_model=rescue.Deal)
async def reserve_rescue(
    business_id: str, rescue_id: str, body: rescue.HoldInput, request: Request
) -> rescue.Deal:
    principal = await signed_customer(request)
    await enforce_limits(request, [("rescue:hold", principal.uid)], anonymous=True)
    await shared(request, business_id)
    entry = await owned(request, principal, business_id, body.thread_id)
    # Check that the thread is still usable before changing the reservation ledger.
    record = await act(request, business_id, entry, "get")
    if record.done or record.blocked or len(record.messages) >= 400:
        raise HTTPException(409, "This conversation cannot take a reservation.")
    # A stable marker in chat makes retries safe if the response was lost after reserving.
    with anyio.CancelScope(shield=True):
        result = await anyio.to_thread.run_sync(
            rescue.hold, store(request), business_id, rescue_id, body
        )
        name = next(p.name for p in result.items if p.name.casefold() == body.name.casefold())
        marker = f"[rescue {rescue_id}] Hold {body.qty} {name}"
        try:
            record = await act(request, business_id, entry, "get")
            if not any(m.text == marker for m in record.messages):
                await act(request, business_id, entry, "post", marker)
        except BaseException:
            await anyio.to_thread.run_sync(
                rescue.release_hold, store(request), business_id, rescue_id, body
            )
            raise
    return result


@router.get("/businesses/{business_id}/brief", response_model=brief.Brief)
async def morning_brief(business_id: str, request: Request) -> brief.Brief:
    uid = await owner(request)
    await enforce_limits(request, [("owner:read", uid)])
    service = store(request)
    context = await anyio.to_thread.run_sync(service.context, uid, business_id)
    _, forecast = await brief.today_forecast(
        service, uid, business_id, request.app.state.forecaster, context
    )
    radar = await anyio.to_thread.run_sync(demand.radar, service, uid, business_id)
    result = await anyio.to_thread.run_sync(
        brief.facts, service, uid, business_id, context, forecast, radar
    )
    result.weather = await request.app.state.weather.get(context["business"]["fields"], result.date)
    result.demo = result.demo or bool(result.weather and result.weather.demo)
    key = brief.cache_key(result)
    cache = await anyio.to_thread.run_sync(service.feature_docs.get, "brief", business_id)
    if cache and cache.get("key") == key:
        return brief.Brief.model_validate(cache["value"])
    claimed = False

    def claim(old: dict[str, Any] | None) -> tuple[float, dict[str, Any]]:
        nonlocal claimed
        claimed = not old or old.get("date") != result.date.isoformat()
        return time.time(), {"date": result.date.isoformat()} if claimed else old or {}

    await anyio.to_thread.run_sync(
        service.feature_docs.update, "brief_wording", business_id, business_id, claim
    )
    writer = (
        request.app.state.brief_writer
        if claimed
        else brief.BriefWriter(
            request.app.state.v1_settings.model_copy(update={"coach_mode": "offline"})
        )
    )
    result = await writer.write(result)
    await anyio.to_thread.run_sync(
        service.feature_docs.put,
        "brief",
        business_id,
        business_id,
        time.time(),
        {"key": key, "value": result.model_dump(mode="json")},
    )
    return result
