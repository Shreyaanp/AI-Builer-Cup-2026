"""Supply chain: supplier rules, purchase orders and the document flow (supply_chain.py)."""

from typing import Any, Literal

import anyio
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import coordinator, supply_chain, supply_io, supply_outbound
from .forecast import ForecastService
from .limits import enforce_limits
from .merchant_routes import consented_owner, owner, store
from .supply_rules import RuleSet

router = APIRouter(prefix="/api/v1")


class Version(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)


class RulesBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    rules: RuleSet


class ConfirmRules(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    apply: bool = True


class ReorderBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    item: str = Field(default="", max_length=80)
    quantity: float | None = Field(default=None, gt=0, le=100_000)
    supplier_id: str = Field(default="", max_length=120)


class Fix(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["quantity", "cash"]
    line: int | None = Field(default=None, ge=1)
    value: float | None = Field(default=None, gt=0, le=1_000_000)


class FixBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    fix: Fix


class SimulateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    variant: Literal["full", "partial", "substitute", "match", "price_mismatch"] = "full"


class InboundBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    text: str = Field(min_length=10, max_length=20_000)


class FlagBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1)
    value: str = Field(min_length=1, max_length=80)


def forecaster(request: Request) -> ForecastService:
    service = getattr(request.app.state, "forecaster", None)
    if service is None:
        raise HTTPException(503, "Forecasting is not available.")
    return service


@router.get("/businesses/{business_id}/supply")
async def overview(business_id: str, request: Request) -> dict[str, Any]:
    uid = await owner(request)
    rows = await anyio.to_thread.run_sync(
        supply_chain.relationships, store(request), uid, business_id
    )
    orders = await anyio.to_thread.run_sync(supply_chain.orders, store(request), uid, business_id)
    context = await anyio.to_thread.run_sync(store(request).context, uid, business_id)
    history = await anyio.to_thread.run_sync(store(request).sales_history, uid, business_id)
    today = supply_chain.shop_today(context)
    forecast = await forecaster(request).forecast(history, today, context["inventory"])
    needs = [
        {"item": product["name"], **need}
        for product in context["inventory"]
        if (
            need := supply_chain.need_from_forecast(
                product, forecast.model_dump(mode="json"), product["name"], today
            )
        )["runs_out"]
        and need["stock_known"]
    ]
    needs.sort(key=lambda need: need["runs_out"])
    return {"suppliers": rows, "orders": orders, "needs": needs}


@router.post("/supply/demo")
async def showcase(request: Request) -> dict[str, str]:
    """Explicit local demo; creates a private buyer and simulated supplier only."""
    uid = await consented_owner(request)
    if request.app.state.v1_settings.app_env not in {"local", "test"}:
        raise HTTPException(404, "Not found.")
    from .supply_showcase import create_showcase

    return {"business_id": await create_showcase(store(request), uid)}


@router.put("/businesses/{business_id}/supply/suppliers/{supplier_id}/rules")
async def save_rules(
    business_id: str, supplier_id: str, body: RulesBody, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.save_rules,
        store(request),
        uid,
        business_id,
        supplier_id,
        body.rules,
        body.version,
    )


@router.post("/businesses/{business_id}/supply/suppliers/{supplier_id}/rules/confirm")
async def confirm_rules(
    business_id: str, supplier_id: str, body: ConfirmRules, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.confirm_rules,
        store(request),
        uid,
        business_id,
        supplier_id,
        body.version,
        body.apply,
    )


@router.post("/businesses/{business_id}/supply/reorder")
async def reorder(business_id: str, body: ReorderBody, request: Request) -> dict[str, Any]:
    uid = await consented_owner(request)
    await enforce_limits(request, [("coach", uid)])
    return await supply_chain.draft_reorder(
        store(request),
        uid,
        business_id,
        body.item,
        body.quantity,
        forecaster(request),
        coordinator._generator(),
        coordinator.DEMO_OWNER_UID,
        body.supplier_id,
    )


@router.get("/businesses/{business_id}/supply/orders/{order_id}")
async def read_order(business_id: str, order_id: str, request: Request) -> dict[str, Any]:
    uid = await owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.get_po, store(request), uid, business_id, order_id
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/fix")
async def fix_order(
    business_id: str, order_id: str, body: FixBody, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.apply_fix,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        body.fix.model_dump(),
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/approve")
async def approve_order(
    business_id: str, order_id: str, body: Version, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.approve, store(request), uid, business_id, order_id, body.version
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/cancel")
async def cancel_order(
    business_id: str, order_id: str, body: Version, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.cancel, store(request), uid, business_id, order_id, body.version
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/simulate")
async def simulate(
    business_id: str, order_id: str, body: SimulateBody, request: Request
) -> dict[str, Any]:
    """Demo only: the simulated supplier sends its next document in its own format."""
    uid = await consented_owner(request)
    await enforce_limits(request, [("coach", uid)])
    return await supply_chain.simulate(
        store(request), uid, business_id, order_id, body.version, body.variant
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/inbound")
async def inbound(
    business_id: str, order_id: str, body: InboundBody, request: Request
) -> dict[str, Any]:
    """A document from the supplier in any format (IDoc XML, CSV, a message): translated."""
    uid = await consented_owner(request)
    await enforce_limits(request, [("coach", uid)])
    return await supply_chain.inbound(
        store(request), uid, business_id, order_id, body.version, body.text
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/flags/{flag_id}")
async def resolve_flag(
    business_id: str, order_id: str, flag_id: str, body: FlagBody, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.resolve_flag,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        flag_id,
        body.value,
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/accept")
async def accept(
    business_id: str, order_id: str, body: Version, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.accept, store(request), uid, business_id, order_id, body.version
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/received")
async def received(
    business_id: str, order_id: str, body: Version, request: Request
) -> dict[str, Any]:
    """Goods arrived; returns the order and, when menu items match, a stock review."""
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_chain.receive, store(request), uid, business_id, order_id, body.version
    )


# ---------------------------------------------------------------------------------------------
# Inbound and outbound with partners (supply_io.py)


class PartnerDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(min_length=10, max_length=20_000)
    partner_id: str = Field(default="", max_length=80)


class ChangeAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    accept: bool = True


class LineQuantity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line: int = Field(ge=1, le=99_990)
    quantity: float = Field(ge=0, le=1_000_000)


class ReceiptBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    version: int = Field(ge=1)
    received: list[LineQuantity] = Field(default_factory=list, max_length=60)
    note: str = Field(default="", max_length=300)


class AsnBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    shipped: list[LineQuantity] = Field(default_factory=list, max_length=60)


class SendBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1)
    doc_id: str = Field(min_length=1, max_length=40)


async def _shown(request: Request, uid: str, bid: str, action: Any, *args: Any) -> dict[str, Any]:
    """Run an order action and return the order as the board shows it (status, timeline)."""

    def run() -> dict[str, Any]:
        return supply_outbound.present(store(request), uid, bid, action(*args))

    return await anyio.to_thread.run_sync(run)


@router.get("/businesses/{business_id}/supply/board")
async def board(business_id: str, request: Request) -> dict[str, Any]:
    """What needs the owner, what came in, what was received and what must go out."""
    uid = await owner(request)
    return await anyio.to_thread.run_sync(supply_outbound.board, store(request), uid, business_id)


@router.post("/businesses/{business_id}/supply/inbound")
async def partner_document(
    business_id: str, body: PartnerDocument, request: Request
) -> dict[str, Any]:
    """A partner's order create, order change or forecast (IDoc XML, CSV, JSON, a message),
    or a supplier's confirmation / shipping notice / invoice for one of the shop's orders."""
    uid = await consented_owner(request)
    await enforce_limits(request, [("coach", uid)])
    return await supply_io.receive_document(
        store(request), uid, business_id, body.text, body.partner_id
    )


@router.post("/businesses/{business_id}/supply/demo/next")
async def demo_next(business_id: str, request: Request) -> dict[str, Any]:
    """Demo: the synthetic buyer sends its next document (forecast, order, change) as an IDoc."""
    uid = await consented_owner(request)
    from .demo_supply_seed import next_document

    return await anyio.to_thread.run_sync(next_document, store(request), uid, business_id)


@router.post("/businesses/{business_id}/supply/orders/{order_id}/change")
async def answer_change(
    business_id: str, order_id: str, body: ChangeAnswer, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await _shown(
        request,
        uid,
        business_id,
        supply_io.accept_change,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        body.accept,
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/receipt")
async def goods_receipt(
    business_id: str, order_id: str, body: ReceiptBody, request: Request
) -> dict[str, Any]:
    """Goods came in: lines left out arrived in full. The receipt waits until sent."""
    uid = await consented_owner(request)
    return await _shown(
        request,
        uid,
        business_id,
        supply_outbound.record_receipt,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        {row.line: row.quantity for row in body.received},
        body.note,
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/asn")
async def shipping_notice(
    business_id: str, order_id: str, body: AsnBody, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await _shown(
        request,
        uid,
        business_id,
        supply_outbound.prepare_asn,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        {row.line: row.quantity for row in body.shipped},
    )


@router.post("/businesses/{business_id}/supply/orders/{order_id}/send")
async def send_document(
    business_id: str, order_id: str, body: SendBody, request: Request
) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await _shown(
        request,
        uid,
        business_id,
        supply_outbound.send,
        store(request),
        uid,
        business_id,
        order_id,
        body.version,
        body.doc_id,
    )


@router.post("/businesses/{business_id}/supply/send-all")
async def send_all(business_id: str, request: Request) -> dict[str, Any]:
    """Close the day: everything still unsent goes out in one tap."""
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_outbound.send_all, store(request), uid, business_id
    )


@router.post("/businesses/{business_id}/supply/inbox/{entry_id}/dismiss")
async def dismiss(business_id: str, entry_id: str, request: Request) -> dict[str, Any]:
    uid = await consented_owner(request)
    return await anyio.to_thread.run_sync(
        supply_io.dismiss, store(request), uid, business_id, entry_id
    )
