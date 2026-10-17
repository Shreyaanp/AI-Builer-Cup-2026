import asyncio
from collections.abc import AsyncIterator
from uuid import uuid4

import anyio
import structlog
from fastapi import HTTPException
from google.adk.agents.context_cache_config import ContextCacheConfig
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.apps.app import App
from google.adk.events import Event
from google.adk.runners import Runner
from google.adk.sessions import BaseSessionService
from google.genai import types

from .agent import make_agent, ui_language
from .auth import Principal
from .charts import CHART_TOOLS, chart_card
from .contracts import StreamEvent
from .coordinator import current, ui_currency
from .instant import InstantResult, IntentIndex, route
from .latency import FirstOutput
from .merchant import NewShopDraft
from .new_shop_resume import adoptable, last_question, saved_draft
from .settings import Settings
from .supply_tools import SUPPLY_CARD_TOOLS

log = structlog.get_logger()

APP_NAME = "ogoogle_ai"
# Tools whose results reach the chat as supplier or order cards.
SOURCING_TOOLS = {"find_suppliers", "prepare_order", "message_supplier", "cancel_order"}
# Tools whose result is an app action card: open a screen, or a prepared customer reply.
ACTION_TOOLS = {
    "open_screen",
    "prepare_customer_reply",
    "show_step",
    "end_conversation",
    "make_my_icon",
    "use_photo_as_icon",
}
# Tools that prepare a sealed proposal for the review dialog.
PROPOSAL_TOOLS = {
    "update_shop",
    "propose_business",
    "propose_customer_facts",
    "propose_products",
    "request_registration",
    "set_open_today",
    "propose_stamp_card",
    # Goods received: the stock update waits for the owner's review.
    "record_goods_received",
}


def public_events(event: Event) -> list[StreamEvent]:
    """Expose allowed UI fields, excluding thoughts, tool arguments and provider error details."""
    output: list[StreamEvent] = []
    if event.error_code:
        return [StreamEvent(kind="error", code="PROVIDER_ERROR")]
    if event.interrupted:
        output.append(StreamEvent(kind="interrupted"))
    for name in ["input_transcription", "output_transcription"]:
        transcription = getattr(event, name, None)
        if transcription and transcription.text:
            output.append(
                StreamEvent(
                    kind="input_transcript"
                    if name == "input_transcription"
                    else "output_transcript",
                    text=transcription.text[:4000],
                )
            )
    if event.content and event.content.role == "model":
        text = "".join(part.text or "" for part in event.content.parts or [] if not part.thought)
        if text:
            output.append(StreamEvent(kind="delta" if event.partial else "reply", text=text[:4000]))
    if event.turn_complete:
        output.append(StreamEvent(kind="turn_complete"))
    if event.content:
        for part in event.content.parts or []:
            call = part.function_call
            if call and call.name == "find_suppliers":
                # Shown at once, while the search runs, as "Searching nearby suppliers…".
                item = str((call.args or {}).get("item") or "")[:80]
                output.append(
                    StreamEvent(kind="sourcing", data={"stage": "searching", "item": item})
                )
            response = part.function_response
            if response and response.name == "prepare_payment_link":
                merchant = current.get()
                card = (
                    merchant.cards.get(str((response.response or {}).get("card_id")))
                    if merchant
                    else None
                )
                if card:
                    output.append(StreamEvent(kind="payment_link", data=card[1]))
            if response and response.name in CHART_TOOLS:
                chart = chart_card(response.name, response.response)
                if chart:
                    output.append(StreamEvent(kind="chart", data=chart))
            if response and response.name == "propose_rescue_deal":
                merchant = current.get()
                card = (
                    merchant.cards.get(str((response.response or {}).get("card_id")))
                    if merchant
                    else None
                )
                if card:
                    output.append(StreamEvent(kind="rescue_proposal", data=card[1]))
            if response and response.name in SOURCING_TOOLS:
                merchant = current.get()
                card = (
                    merchant.cards.get(str((response.response or {}).get("card_id")))
                    if merchant
                    else None
                )
                if card:
                    output.append(
                        StreamEvent(
                            kind="suppliers" if card[0] == "suppliers" else "order", data=card[1]
                        )
                    )
            if response and response.name in ACTION_TOOLS:
                merchant = current.get()
                card = (
                    merchant.cards.get(str((response.response or {}).get("card_id")))
                    if merchant
                    else None
                )
                if card:
                    output.append(StreamEvent(kind="action", data=card[1]))
            if response and response.name in SUPPLY_CARD_TOOLS:
                merchant = current.get()
                card = (
                    merchant.cards.get(str((response.response or {}).get("card_id")))
                    if merchant
                    else None
                )
                if card:
                    output.append(StreamEvent(kind=card[0], data=card[1]))  # type: ignore[arg-type]
            if response and response.name == "set_reply_language":
                # The owner asked for another language: the app switches its own setting too.
                changed = response.response or {}
                if changed.get("status") == "changed":
                    output.append(
                        StreamEvent(
                            kind="action",
                            data={"target": "language", "language": str(changed["language"])},
                        )
                    )
            if response and response.name in PROPOSAL_TOOLS:
                payload = response.response or {}
                # The model sees only the id; the exact sealed proposal goes to the review UI.
                merchant = current.get()
                proposal = (
                    merchant.proposals.get(str(payload.get("proposal_id"))) if merchant else None
                )
                if proposal:
                    output.append(StreamEvent(kind="proposal", data=proposal))
                if response.name == "update_shop" and merchant and merchant.new_shop_draft:
                    # The whole draft, with what the owner skipped: the shop card follows it.
                    output.append(
                        StreamEvent(
                            kind="draft", data=merchant.new_shop_draft.model_dump(mode="json")
                        )
                    )
                if payload.get("status") in {"verification_required", "save_business_first"}:
                    output.append(StreamEvent(kind="workflow", data={"status": payload["status"]}))
    return output


# Conversations kept per account (oldest cleared first) and events per conversation.
MAX_CONVERSATIONS = 20
MAX_EVENTS = 400


def uses_context_cache(settings: Settings) -> bool:
    # Explicit caches are a Vertex feature; the API-key backend and the offline fixture skip it.
    return (
        settings.context_cache_enabled
        and settings.coach_mode == "gemini"
        and settings.gemini_backend == "vertex"
    )


def text_runner(settings: Settings, sessions: BaseSessionService) -> Runner:
    """The text coach. With context caching on, the coach rules + tool schemas are cached on
    Vertex (ADK creates, reuses and refreshes the cache; a failed cache call falls back to an
    ordinary request)."""
    if not uses_context_cache(settings):
        return Runner(app_name=APP_NAME, agent=make_agent(settings), session_service=sessions)
    try:
        app = App(
            name=APP_NAME,
            root_agent=make_agent(settings, cached=True),
            context_cache_config=ContextCacheConfig(
                cache_intervals=20, ttl_seconds=settings.context_cache_ttl_seconds
            ),
        )
        return Runner(app=app, session_service=sessions)
    except Exception:  # noqa: BLE001 - caching is an optimisation; never block the coach
        log.warning("context_cache_unavailable")
        return Runner(app_name=APP_NAME, agent=make_agent(settings), session_service=sessions)


def intent_index(settings: Settings) -> IntentIndex | None:
    """Vertex embeddings of known intents for the instant path, when switched on."""
    if not (
        settings.instant_path_enabled
        and settings.instant_embeddings
        and settings.coach_mode == "gemini"
        and settings.gemini_backend == "vertex"
    ):
        return None
    from .memory_vectors import gemini_embedder

    return IntentIndex(
        gemini_embedder(
            settings.google_cloud_project,
            settings.google_embedding_location,
            settings.embedding_model,
        )
    )


class CoachRuntime:
    def __init__(self, settings: Settings, sessions: BaseSessionService) -> None:
        self.settings = settings
        self.sessions = sessions
        self.text_runner = text_runner(settings, sessions)
        self.instant_index = intent_index(settings)
        self.live_runner = Runner(
            app_name=APP_NAME, agent=make_agent(settings, live=True), session_service=sessions
        )

    async def session(
        self,
        principal: Principal,
        requested: str | None,
        business_id: str | None = None,
        new_shop: bool = False,
    ) -> str:
        if requested:
            existing = await self.sessions.get_session(
                app_name=APP_NAME,
                user_id=principal.uid,
                session_id=requested,
            )
            if not existing:
                raise HTTPException(404, "Conversation not found in this workspace.")
            if existing.state.get("business_id") != business_id:
                raise HTTPException(404, "Conversation belongs to a different business.")
            if bool(existing.state.get("new_shop")) != new_shop:
                raise HTTPException(404, "Conversation belongs to a different coach mode.")
            if len(existing.events) < MAX_EVENTS:
                return requested
            # Ownership and shop scope were checked above. Keep the full history and start
            # a fresh thread; transports announce the changed id in their ready event.
        listing = await self.sessions.list_sessions(app_name=APP_NAME, user_id=principal.uid)
        # Keep the newest conversations and quietly clear the oldest, instead of refusing every
        # new chat and voice session once an account had 20 (owner report, 15 Oct: the mic said
        # "Too many requests" forever). Shop records live elsewhere; only old chat history goes.
        if len(listing.sessions) >= MAX_CONVERSATIONS:
            oldest = sorted(listing.sessions, key=lambda item: item.last_update_time or 0)
            for stale in oldest[: len(listing.sessions) - MAX_CONVERSATIONS + 1]:
                await self.sessions.delete_session(
                    app_name=APP_NAME, user_id=principal.uid, session_id=stale.id
                )
        session_id = str(uuid4())
        await self.sessions.create_session(
            app_name=APP_NAME,
            user_id=principal.uid,
            session_id=session_id,
            state={"business_id": business_id, "new_shop": new_shop},
        )
        return session_id

    async def new_shop_progress(
        self, principal: Principal, session_id: str
    ) -> tuple[NewShopDraft | None, str, bool]:
        """A new-shop conversation's saved draft, the coach's last question and whether it has
        turns already (a socket that comes back to it continues, never starts over)."""
        session = await self.sessions.get_session(
            app_name=APP_NAME, user_id=principal.uid, session_id=session_id
        )
        if not session:
            return None, "", False
        return saved_draft(session.state), last_question(session.events), bool(session.events)

    async def unfinished_new_shop(self, principal: Principal, finished: set[str]) -> str | None:
        """The owner's most recent new-shop conversation whose shop was never opened: a fresh
        start after the app lost its own draft (reload, a crash) continues it."""
        listing = await self.sessions.list_sessions(app_name=APP_NAME, user_id=principal.uid)
        for session in sorted(
            listing.sessions, key=lambda item: item.last_update_time or 0, reverse=True
        ):
            if not session.state.get("business_id") and adoptable(
                session.state, session.last_update_time or 0, finished
            ):
                return session.id
        return None

    async def text_events(
        self,
        principal: Principal,
        session_id: str,
        text: str,
        language: str,
        currency: str | None = None,
    ) -> AsyncIterator[StreamEvent]:
        # The app language reaches the instruction via a context variable, never the owner's
        # message (models echo bracketed prefixes back into replies).
        merchant = current.get()
        if merchant:
            # Socket text controls exercise the same offline tools as HTTP turns.
            merchant.message = text
        ui_language.set(language)
        timer = FirstOutput("text_agent")
        if self.settings.instant_path_enabled and merchant:
            instant = await self.instant(principal, session_id, text, currency)
            if instant:
                for event in instant.events:
                    yield event
                yield StreamEvent(kind="reply", text=instant.reply)
                timer.mark("text_instant")
                yield StreamEvent(kind="turn_complete", session_id=session_id)
                return
        run = self.text_runner.run_async(
            user_id=principal.uid,
            session_id=session_id,
            new_message=types.Content(role="user", parts=[types.Part(text=text)]),
            # Room for context → propose → self-repair → propose → reply.
            run_config=RunConfig(streaming_mode=StreamingMode.SSE, max_llm_calls=8),
        )
        queue: asyncio.Queue[StreamEvent | Exception | None] = asyncio.Queue(maxsize=8)

        async def produce() -> None:
            # A raw asyncio task isolates ADK/SQLAlchemy cleanup from the SSE
            # task group's repeated (level) cancellation on browser disconnect.
            currency_token = ui_currency.set(currency)
            try:
                try:
                    async for event in run:
                        for visible in public_events(event):
                            await queue.put(visible)
                            if visible.kind == "error":
                                return
                finally:
                    await run.aclose()
            except Exception as error:
                await queue.put(error)
            else:
                await queue.put(None)
            finally:
                ui_currency.reset(currency_token)

        task = asyncio.create_task(produce(), name="adk-text-producer")
        sent_draft = merchant.new_shop_draft if merchant else None
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                if item.kind in {"delta", "reply", "proposal", "chart", "action", "suppliers"}:
                    timer.mark()
                if item.kind == "draft" and merchant:
                    sent_draft = merchant.new_shop_draft
                yield item
                if item.kind == "error":
                    return
        finally:
            if not task.done():
                task.cancel()
            with anyio.CancelScope(shield=True):
                async with asyncio.timeout(5):
                    await asyncio.gather(task, return_exceptions=True)
        draft = merchant.new_shop_draft if merchant and merchant.new_shop else None
        if draft and draft != sent_draft:
            # Changed after the last draft event (a business profile that arrived late, "bas"):
            # the phone gets it now, not only with the next turn.
            yield StreamEvent(kind="draft", data=draft.model_dump(mode="json"))
        yield StreamEvent(kind="turn_complete", session_id=session_id)

    async def instant(
        self, principal: Principal, session_id: str, text: str, currency: str | None
    ) -> InstantResult | None:
        """Answer a common request without the model and keep it in the conversation history,
        so the coach sees it on the next turn. Any failure falls back to the model."""
        currency_token = ui_currency.set(currency)
        try:
            session = await self.sessions.get_session(
                app_name=APP_NAME, user_id=principal.uid, session_id=session_id
            )
            result = await route(text, current.get(), self.instant_index) if session else None
            if session is None or result is None:
                return None
            invocation = f"e-{uuid4()}"
            for author, role, words in (
                ("user", "user", text),
                ("business_coach", "model", result.reply),
            ):
                await self.sessions.append_event(
                    session,
                    Event(
                        invocation_id=invocation,
                        author=author,
                        content=types.Content(role=role, parts=[types.Part(text=words)]),
                    ),
                )
            log.info("instant_route", intent=result.intent)
            return result
        except Exception:  # noqa: BLE001 - the coach model is the fallback
            log.warning("instant_route_failed", exc_info=True)
            return None
        finally:
            ui_currency.reset(currency_token)
