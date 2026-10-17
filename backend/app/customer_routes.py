"""Anonymous shop questions, signed-in customer contact and owner-only inquiry handling."""

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Request
from sse_starlette import EventSourceResponse, ServerSentEvent
from starlette.background import BackgroundTask

from .customer import (
    Answer,
    CustomerThread,
    Inquiry,
    InquiryInput,
    InquiryReceipt,
    MessageInput,
    Question,
    Translation,
    TranslationInput,
)
from .limits import client_ip, enforce_limits
from .merchant_routes import consented_owner, owner, store
from .threads import thread_signals, token_hash

router = APIRouter(prefix="/api/v1")


async def shared(request: Request, bid: str) -> dict:
    shop = await anyio.to_thread.run_sync(store(request).public_shop, bid)
    if shop is None:
        raise HTTPException(404, "This shop page is not available.")
    return shop


@router.post("/public/shops/{business_id}/ask", response_model=Answer)
async def ask(business_id: str, body: Question, request: Request) -> Answer:
    shop = await shared(request, business_id)
    await enforce_limits(
        request, [("ask:ip", client_ip(request)), ("ask:shop", business_id)], anonymous=True
    )
    answer = await request.app.state.customer_answers.answer(shop, body)
    # An in-flight answer must not survive unsharing or a changed menu.
    if await shared(request, business_id) != shop:
        raise HTTPException(409, "The shop details changed. Please ask again.")
    return answer


@router.post("/public/shops/{business_id}/inquiries", response_model=InquiryReceipt)
async def inquire(business_id: str, body: InquiryInput, request: Request) -> InquiryReceipt:
    # Owners talk to real people only: a new conversation needs a signed-in customer (Q8).
    # Browsing and instant answers stay anonymous; the app starts threads via /customer/....
    from .community_routes import customer_contact, display_name

    principal = await request.app.state.services.identity.require_customer(request)
    if request.app.state.v1_settings.guest_customer:
        body = body.model_copy(
            update={
                "name": display_name(principal),
                "contact": await customer_contact(request, principal),
            }
        )
    await shared(request, business_id)
    await enforce_limits(
        request, [("inquire:ip", business_id + ":" + client_ip(request))], anonymous=True
    )
    receipt = await anyio.to_thread.run_sync(store(request).add_inquiry, business_id, body)
    await enforce_limits(request, [("thread:token", token_hash(receipt.token))], anonymous=True)
    thread_signals(request).wake(business_id)
    return receipt


@router.get("/businesses/{business_id}/inquiries", response_model=list[Inquiry])
async def inquiries(business_id: str, request: Request) -> list[Inquiry]:
    uid = await owner(request)
    return await anyio.to_thread.run_sync(store(request).inquiries, uid, business_id)


@router.post("/businesses/{business_id}/inquiries/{inquiry_id}/done", response_model=Inquiry)
async def done(business_id: str, inquiry_id: str, request: Request) -> Inquiry:
    # Explicit handling action, separate from saving shop facts or accepting an order.
    uid = await consented_owner(request)
    result = await anyio.to_thread.run_sync(
        store(request).complete_inquiry, uid, business_id, inquiry_id
    )
    thread_signals(request).wake(business_id)
    return result


# Capability tokens are headers, never URLs (so they cannot leak into access logs/referrers).
def capability(request: Request) -> str:
    value = request.headers.get("x-thread-token", "")
    if not 32 <= len(value) <= 128:
        raise HTTPException(404, "Conversation not found.")
    return value


async def customer_record(
    request: Request, bid: str, iid: str, action: str = "get", text: str = ""
) -> Inquiry:
    record = await anyio.to_thread.run_sync(
        store(request).thread_action, None, bid, iid, capability(request), action, text
    )
    if action != "get":
        thread_signals(request).wake(bid)
    return record


def public_thread(record: Inquiry) -> CustomerThread:
    return CustomerThread.model_validate(record.model_dump())


@router.get("/public/shops/{business_id}/inquiries/{inquiry_id}", response_model=CustomerThread)
async def conversation(business_id: str, inquiry_id: str, request: Request) -> CustomerThread:
    return public_thread(await customer_record(request, business_id, inquiry_id))


@router.post(
    "/public/shops/{business_id}/inquiries/{inquiry_id}/messages", response_model=CustomerThread
)
async def customer_message(
    business_id: str, inquiry_id: str, body: MessageInput, request: Request
) -> CustomerThread:
    await customer_record(request, business_id, inquiry_id)
    await enforce_limits(
        request,
        [
            ("thread:token", token_hash(capability(request))),
            ("inquire:ip", business_id + ":" + client_ip(request)),
        ],
        anonymous=True,
    )
    return public_thread(await customer_record(request, business_id, inquiry_id, "post", body.text))


@router.delete("/public/shops/{business_id}/inquiries/{inquiry_id}")
async def delete_conversation(
    business_id: str, inquiry_id: str, request: Request
) -> dict[str, bool]:
    await customer_record(request, business_id, inquiry_id, "delete")
    return {"deleted": True}


@router.post("/businesses/{business_id}/inquiries/{inquiry_id}/read", response_model=Inquiry)
async def read_conversation(business_id: str, inquiry_id: str, request: Request) -> Inquiry:
    uid = await consented_owner(request)
    result = await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "read"
    )
    thread_signals(request).wake(business_id)
    return result


@router.post("/businesses/{business_id}/inquiries/{inquiry_id}/messages", response_model=Inquiry)
async def owner_message(
    business_id: str, inquiry_id: str, body: MessageInput, request: Request
) -> Inquiry:
    uid = await consented_owner(request)
    await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "get"
    )
    await enforce_limits(request, [("thread:owner", uid)])
    result = await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "post", body.text
    )
    thread_signals(request).wake(business_id)
    return result


@router.post("/businesses/{business_id}/inquiries/{inquiry_id}/block", response_model=Inquiry)
async def block_conversation(business_id: str, inquiry_id: str, request: Request) -> Inquiry:
    uid = await consented_owner(request)
    result = await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "block"
    )
    thread_signals(request).wake(business_id)
    return result


@router.post("/businesses/{business_id}/inquiries/{inquiry_id}/unblock", response_model=Inquiry)
async def unblock_conversation(business_id: str, inquiry_id: str, request: Request) -> Inquiry:
    uid = await consented_owner(request)
    result = await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "unblock"
    )
    thread_signals(request).wake(business_id)
    return result


async def translate_record(
    request: Request, record: Inquiry, mid: str, body: TranslationInput, subject: str
) -> Translation:
    message = next((m for m in record.messages if m.id == mid), None)
    if message is None:
        raise HTTPException(404, "Message not found.")
    await enforce_limits(request, [("thread:translate", subject)], anonymous=True)
    return await request.app.state.customer_answers.translate(message.text, body.language)


@router.post(
    "/public/shops/{business_id}/inquiries/{inquiry_id}/messages/{message_id}/translation",
    response_model=Translation,
)
async def customer_translation(
    business_id: str, inquiry_id: str, message_id: str, body: TranslationInput, request: Request
) -> Translation:
    record = await customer_record(request, business_id, inquiry_id)
    return await translate_record(
        request, record, message_id, body, token_hash(capability(request))
    )


@router.post(
    "/businesses/{business_id}/inquiries/{inquiry_id}/messages/{message_id}/translation",
    response_model=Translation,
)
async def owner_translation(
    business_id: str, inquiry_id: str, message_id: str, body: TranslationInput, request: Request
) -> Translation:
    uid = await consented_owner(request)
    record = await anyio.to_thread.run_sync(
        store(request).thread_action, uid, business_id, inquiry_id, "", "get"
    )
    return await translate_record(request, record, message_id, body, uid)


async def follow_threads(
    request: Request, load: Callable[[], Awaitable[Any]], initial: Any, changed: asyncio.Event
) -> AsyncIterator[dict[str, str]]:
    # Full snapshots recover any older cursor without retaining process-local message bodies.
    cursor = request.headers.get("last-event-id", "")
    value = initial
    while not await request.is_disconnected():
        data = json.dumps(value, ensure_ascii=False, sort_keys=True)
        event_id = hashlib.sha256(data.encode()).hexdigest()
        if event_id != cursor:
            yield {"event": "inquiries", "id": event_id, "data": data}
            cursor = event_id
        try:
            await asyncio.wait_for(changed.wait(), timeout=15)
        except TimeoutError:
            pass
        if thread_signals(request).is_evicted(changed):
            return  # A newer stream from the same person replaced this one.
        # Clear before reading so a write during the read cannot lose its wakeup.
        changed.clear()
        try:
            value = await load()
        except HTTPException:
            yield {"event": "inquiries", "data": json.dumps({"unavailable": True})}
            return


def thread_stream(
    request: Request, load: Callable[[], Awaitable[Any]], initial: Any, bid: str, principal: str
) -> EventSourceResponse:
    signals = thread_signals(request)
    changed = signals.subscribe(bid, principal)
    # Cover the small interval between the route's initial read and subscribing.
    changed.set()

    async def release() -> None:
        signals.release(bid, principal, changed)

    async def frames() -> AsyncIterator[dict[str, str]]:
        try:
            async for frame in follow_threads(request, load, initial, changed):
                yield frame
        finally:
            await release()

    return EventSourceResponse(
        frames(),
        ping=15,
        ping_message_factory=lambda: ServerSentEvent(comment="heartbeat"),
        send_timeout=5,
        background=BackgroundTask(release),
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
    )


STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "Durable conversation snapshot SSE with heartbeat comments.",
        "content": {"text/event-stream": {"schema": {"type": "string"}}},
    }
}


@router.get(
    "/public/shops/{business_id}/inquiries/{inquiry_id}/stream",
    response_class=EventSourceResponse,
    responses=STREAM_RESPONSES,
)
async def customer_stream(
    business_id: str, inquiry_id: str, request: Request
) -> EventSourceResponse:
    async def load() -> dict:
        return public_thread(await customer_record(request, business_id, inquiry_id)).model_dump()

    return thread_stream(
        request, load, await load(), business_id, "customer:" + token_hash(capability(request))
    )


@router.get(
    "/businesses/{business_id}/inquiries/stream",
    response_class=EventSourceResponse,
    responses=STREAM_RESPONSES,
)
async def owner_stream(business_id: str, request: Request) -> EventSourceResponse:
    uid = await owner(request)

    async def load() -> list[dict]:
        records = await anyio.to_thread.run_sync(store(request).inquiries, uid, business_id)
        # Owner stream is an invalidation feed: no contacts or message bodies are broadcast.
        return [
            {
                "id": r.id,
                "unread": r.unread,
                "done": r.done,
                "blocked": r.blocked,
                "last": r.messages[-1].id if r.messages else r.id,
            }
            for r in records
        ]

    return thread_stream(request, load, await load(), business_id, "owner:" + uid)
