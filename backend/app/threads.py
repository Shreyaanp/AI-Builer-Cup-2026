"""Shared conversation mutations; adapters supply atomic, scoped persistence."""

import asyncio
import hashlib
import re
import secrets
import time
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request

from .customer import Inquiry, InquiryInput, ThreadMessage


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def contact_hash(contact: str) -> str:
    canonical = contact.strip().casefold() if "@" in contact else re.sub(r"\D", "", contact)
    return token_hash(canonical)


def new_thread(body: InquiryInput) -> tuple[dict[str, Any], str]:
    token = secrets.token_urlsafe(32)
    now = time.time()
    record = Inquiry(
        id=str(uuid4()),
        **body.model_dump(),
        created=now,
        messages=[
            ThreadMessage(id=str(uuid4()), author="customer", text=body.message, created=now)
        ],
    )
    return {**record.model_dump(), "token_hash": token_hash(token)}, token


def change_thread(
    data: dict[str, Any],
    uid: str | None,
    token: str,
    action: str,
    text: str = "",
    contact_blocked: bool = False,
) -> Inquiry:
    if uid is None and (
        not data.get("token_hash")
        or not secrets.compare_digest(data["token_hash"], token_hash(token))
    ):
        raise HTTPException(404, "Conversation not found.")
    record = Inquiry.model_validate(data)
    # Historical one-way inquiries remain visible to owners, with their original message.
    if not record.messages:
        record.messages = [
            ThreadMessage(
                id=record.id, author="customer", text=record.message, created=record.created
            )
        ]
    if action == "post":
        if record.done or record.blocked or contact_blocked:
            raise HTTPException(409, "This conversation is closed.")
        if len(record.messages) >= 400:
            raise HTTPException(409, "Conversation limit reached.")
        record.messages.append(
            ThreadMessage(
                id=str(uuid4()),
                author="owner" if uid else "customer",
                text=text,
                created=time.time(),
            )
        )
        record.unread = uid is None
    elif action in ("ai_answer", "demo_reply"):
        # Shop-side automatic messages on a customer's own thread; never from an owner token.
        if uid is not None or record.done or record.blocked or contact_blocked:
            raise HTTPException(409, "This conversation is closed.")
        if len(record.messages) >= 400:
            raise HTTPException(409, "Conversation limit reached.")
        record.messages.append(
            ThreadMessage(
                id=str(uuid4()),
                author="owner",
                text=text,
                created=time.time(),
                kind="ai" if action == "ai_answer" else "demo",
            )
        )
    elif action == "read":
        record.unread = False
    elif action == "unblock":
        if uid is None:
            raise HTTPException(404, "Conversation not found.")
        record.done = False
        record.blocked = False
    elif action in ("close", "block"):
        record.done = True
        record.unread = False
        record.blocked = action == "block" or record.blocked
    return record


class ThreadSignals:
    """Bounded app-local wakeups; durable snapshots remain the source of truth."""

    def __init__(self) -> None:
        self.watchers: dict[tuple[str, str], set[asyncio.Event]] = {}
        # Streams replaced by a newer connection from the same person; they end at once.
        self.evicted: set[asyncio.Event] = set()

    def subscribe(self, bid: str, principal: str) -> asyncio.Event:
        key = (bid, principal)
        mine = self.watchers.setdefault(key, set())
        # Phones drop connections without closing them; the newest connection always wins,
        # so a person is never locked out by their own stale streams ("Too many requests").
        while len(mine) >= 4:
            stale = mine.pop()
            self.evicted.add(stale)
            stale.set()
        if sum(len(events) for events in self.watchers.values()) >= 128:
            if not mine:
                del self.watchers[key]
            raise HTTPException(429, "Too many conversation streams.")
        event = asyncio.Event()
        mine.add(event)
        return event

    def is_evicted(self, event: asyncio.Event) -> bool:
        return event in self.evicted

    def release(self, bid: str, principal: str, event: asyncio.Event) -> None:
        key = (bid, principal)
        self.evicted.discard(event)
        events = self.watchers.get(key)
        if events is not None:
            events.discard(event)
            if not events:
                del self.watchers[key]

    def wake(self, bid: str) -> None:
        for (shop, _), events in self.watchers.items():
            if shop == bid:
                for event in events:
                    event.set()


def thread_signals(request: Request) -> ThreadSignals:
    if not hasattr(request.app.state, "thread_signals"):
        request.app.state.thread_signals = ThreadSignals()
    signals: ThreadSignals = request.app.state.thread_signals
    return signals
