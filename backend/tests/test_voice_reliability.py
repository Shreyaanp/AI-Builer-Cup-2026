"""Voice onboarding never drops, repeats or gets stuck (owner report, 17 Oct, Hindi).

Covers the Live call budget and server-side rotation, resume from the saved draft (no re-asked
fields), reconnect takeover instead of 409, idempotent saves and a long onboarding on one socket.
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.adk.events import Event
from google.adk.live.live_request_queue import LiveRequestQueue
from google.adk.sessions import InMemorySessionService
from google.genai import types
from structlog.testing import capture_logs

from app.agent import turn_instruction, ui_language
from app.auth import Principal
from app.coordinator import (
    MerchantContext,
    ProductInput,
    current,
    propose_business,
    propose_products,
)
from app.limits import RunRegistry, lease_lost
from app.main import create_app
from app.merchant import BusinessFields, MerchantStore, NewShopDraft, ProductFields
from app.new_shop_resume import (
    DRAFT_STATE,
    known_and_missing,
    last_question,
    merge_drafts,
    progress_note,
)
from app.reply_language import reply_language
from app.settings import Settings
from app.streaming import APP_NAME
from app.voice import AudioBudget, VoiceStats, gemini_voice
from tests.test_discover import settings
from tests.test_photos import join

ORIGIN = {"origin": "http://127.0.0.1:3200"}


def chai_draft(**business: Any) -> NewShopDraft:
    return NewShopDraft(
        business=BusinessFields(name="Sharma Chai", category="Tea stall", **business),
        products=[ProductFields(name="Masala chai", price=1500, unit="cup", category="Tea")],
    )


# --- Resume = continue: the instruction says what is known, what is next, what was asked ---


def test_resume_prompt_lists_known_fields_and_continues_from_the_next_missing_one(
    tmp_path: Path,
) -> None:
    context = MerchantContext(
        MerchantStore(str(tmp_path / "shops.sqlite")),
        "alice",
        None,
        [],
        new_shop=True,
        new_shop_draft=chai_draft(),
        resumed=True,
        last_question="आपकी दुकान कहाँ है?",
    )
    token = current.set(context)
    language = ui_language.set("hi")
    try:
        text = turn_instruction()
    finally:
        ui_language.reset(language)
        current.reset(token)
    assert 'NEVER ask for these again: name "Sharma Chai"; sells "Tea stall"' in text
    # Name and kind are known: never listed as missing; the menu is never asked at all.
    parts = text.split("Still missing (ask ONE, the first in this list; nothing outside it):")
    missing = parts[1].split("\n")[0]
    assert missing.strip().startswith("where the shop is")
    assert "real name" not in missing and "what they sell" not in missing
    assert "menu" not in missing
    assert 'Your last question was: "आपकी दुकान कहाँ है?"' in text
    assert "Do not greet" in text and "wait for the owner" in text


def test_progress_order_and_a_complete_draft() -> None:
    _, missing = known_and_missing(None)
    # The three basics, the hours as a follow-up, the photo last (#112): never the menu.
    assert [item.split(" (")[0].split(",")[0] for item in missing] == [
        "the shop's real name",
        "what they sell or do",
        "where the shop is",
        "opening hours",
        "a photo of the shop",
    ]
    full = chai_draft(location="Lajpat Nagar", hours="7am-9pm").model_copy(update={"photo": True})
    known, missing = known_and_missing(full)
    assert missing == []
    assert "shop photo taken" in known
    note = progress_note(full, "", resumed=False)
    assert "Everything is gathered" in note and "face check" in note
    # Skipped hours and photo count as done: never asked again, never invented.
    skipped = chai_draft(location="Lajpat Nagar").model_copy(update={"skipped": ["hours", "photo"]})
    known, missing = known_and_missing(skipped)
    assert missing == [] and any("hours: skipped" in item for item in known)


def test_last_question_is_read_from_the_saved_turns() -> None:
    events = [
        Event(author="user", input_transcription=types.Transcription(text="नमस्ते")),
        Event(
            author="business_coach",
            output_transcription=types.Transcription(text="नमस्ते! चाय की दुकान, बढ़िया। "),
        ),
        Event(
            author="business_coach",
            output_transcription=types.Transcription(text="आपकी दुकान का नाम क्या है?"),
        ),
    ]
    assert last_question(events) == "आपकी दुकान का नाम क्या है?"
    answered = [*events, Event(author="user", input_transcription=types.Transcription(text="x"))]
    # The owner spoke after it: still the coach's last question.
    assert last_question(answered) == "आपकी दुकान का नाम क्या है?"
    assert last_question([]) == ""


def test_merge_never_erases_and_the_overlay_wins() -> None:
    saved = chai_draft(location="Lajpat Nagar")
    app_copy = NewShopDraft(
        business=BusinessFields(name="Sharma Chai", category="", hours="7am-9pm"),
        products=[ProductFields(name="Samosa", price=2000, unit="piece", category="Snacks")],
    )
    merged = merge_drafts(saved, app_copy)
    assert merged and merged.business
    assert merged.business.category == "Tea stall"  # empty never erases
    assert merged.business.location == "Lajpat Nagar"
    assert merged.business.hours == "7am-9pm"
    assert {p.name for p in merged.products} == {"Masala chai", "Samosa"}
    assert merge_drafts(None, app_copy) == app_copy
    assert merge_drafts(saved, None) == saved


# --- Idempotent saves: the same answer twice, or a replayed tool call, changes nothing ---


def test_same_answer_twice_and_replayed_tool_calls_are_no_ops(tmp_path: Path) -> None:
    store = MerchantStore(str(tmp_path / "shops.sqlite"))
    context = MerchantContext(store, "alice", None, [], new_shop=True, new_shop_draft=None)
    token = current.set(context)
    try:
        first = propose_business("Sharma Chai", category="Tea stall")
        draft = context.new_shop_draft
        again = propose_business("Sharma Chai", category="Tea stall")
        assert again["proposal_id"] == first["proposal_id"] and again["changes"] == []
        assert context.new_shop_draft == draft and len(context.proposals) == 1
        items = [ProductInput(name="Masala chai", price=15, unit="cup")]
        menu = propose_products(items)
        replay = propose_products(items)
        assert replay["proposal_id"] == menu["proposal_id"] and replay["changes"] == []
        assert len(context.proposals) == 2
        # A real change still records.
        hours = propose_business("", hours="7am-9pm")
        assert hours["proposal_id"] not in {first["proposal_id"], menu["proposal_id"]}
        assert context.new_shop_draft and context.new_shop_draft.business
        assert context.new_shop_draft.business.hours == "7am-9pm"
        assert store.list_businesses("alice") == []
    finally:
        current.reset(token)


# --- Stream lock: a reconnect takes over, never 409 ---


def test_voice_reconnect_takes_over_instead_of_409() -> None:
    registry = RunRegistry(4)
    old = registry.acquire("alice", "s1", "voice")
    lost = lease_lost(old)
    new = registry.acquire("alice", "s1", "voice")
    assert lost.is_set() and not registry.holds(old) and registry.holds(new)
    # The old socket's late release never frees the new one.
    registry.release(old)
    assert registry.holds(new)
    # Typing while a voice socket is open takes it over too; two text turns stay exclusive.
    text = registry.acquire("alice", "s1", "text")
    with pytest.raises(HTTPException) as busy:
        registry.acquire("alice", "s1", "text")
    assert busy.value.status_code == 409
    registry.release(text)
    registry.release(new)
    assert not registry.active


def test_second_socket_for_the_same_conversation_takes_it_over(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        join(client)
        with client.websocket_connect("/api/v1/voice?new_shop=true", headers=ORIGIN) as first:
            first.send_json({"kind": "new_shop", "draft": None})
            sid = first.receive_json()["session_id"]
            with client.websocket_connect(
                f"/api/v1/voice?new_shop=true&session_id={sid}", headers=ORIGIN
            ) as second:
                second.send_json({"kind": "new_shop", "draft": None})
                ready = second.receive_json()
                assert ready["kind"] == "ready" and ready["session_id"] == sid
                # The old socket is told and closed: a dropped phone never blocks the new one.
                assert first.receive_json() == {"kind": "error", "code": "TAKEN_OVER"}
                second.send_json({"kind": "text", "text": "name: Sharma Chai"})
                while second.receive_json()["kind"] != "turn_complete":
                    pass
                second.send_json({"kind": "close"})
        assert not app.state.services.registry.active


# --- Resume from the saved draft over real sockets (offline coach) ---


def answer(socket: Any, text: str) -> list[dict[str, Any]]:
    socket.send_json({"kind": "text", "text": text})
    events = []
    while (event := socket.receive_json())["kind"] != "turn_complete":
        assert event["kind"] != "error", event
        events.append(event)
    return events


def coach_said(events: list[dict[str, Any]]) -> str:
    return " ".join(e.get("text") or "" for e in events if e["kind"] in {"reply", "delta"})


def test_reconnect_with_a_stale_app_draft_continues_from_the_next_missing_field(
    tmp_path: Path,
) -> None:
    """The socket dropped right after the name was saved, before the app heard about it: the
    reconnect brings the saved draft back and the coach asks the next thing, not the name."""
    app = create_app(settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        join(client)
        with client.websocket_connect(
            "/api/v1/voice?new_shop=true&lang=hi", headers=ORIGIN
        ) as socket:
            socket.send_json({"kind": "new_shop", "draft": None})
            sid = socket.receive_json()["session_id"]
            answer(socket, "Hello! I want to open a new shop.")
            saved = answer(socket, "name: Sharma Chai; category: Tea stall")
            assert any(e["kind"] == "proposal" for e in saved)
        session = asyncio.run(
            app.state.services.runtime.sessions.get_session(
                app_name=APP_NAME, user_id=_uid(app), session_id=sid
            )
        )
        assert session is not None
        assert session.state[DRAFT_STATE]["business"]["name"] == "Sharma Chai"
        # The app lost the last proposal: it reconnects with an empty draft.
        with client.websocket_connect(
            f"/api/v1/voice?new_shop=true&lang=hi&session_id={sid}", headers=ORIGIN
        ) as socket:
            socket.send_json({"kind": "new_shop", "draft": None})
            assert socket.receive_json()["session_id"] == sid
            restored = socket.receive_json()
            assert restored["kind"] == "draft"
            assert restored["data"]["business"]["name"] == "Sharma Chai"
            reply = coach_said(answer(socket, "I'm not sure."))
            assert "What is your business called?" not in reply
            assert "What kind of business do you run?" not in reply
            socket.send_json({"kind": "close"})


def test_fresh_start_with_an_unfinished_draft_continues_it(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        join(client)
        with client.websocket_connect("/api/v1/voice?new_shop=true", headers=ORIGIN) as socket:
            socket.send_json({"kind": "new_shop", "draft": None})
            sid = socket.receive_json()["session_id"]
            answer(socket, "name: Sharma Chai; category: Tea stall")
            socket.send_json({"kind": "close"})
        # The page reloaded: the flow starts with no draft and no session id.
        with client.websocket_connect("/api/v1/voice?new_shop=true", headers=ORIGIN) as socket:
            socket.send_json({"kind": "new_shop", "draft": None})
            ready = socket.receive_json()
            assert ready["session_id"] == sid and "code" not in ready
            assert socket.receive_json()["data"]["business"]["name"] == "Sharma Chai"
            socket.send_json({"kind": "close"})
        # An app that holds its own draft is a separate flow and never adopts.
        with client.websocket_connect("/api/v1/voice?new_shop=true", headers=ORIGIN) as socket:
            socket.send_json({"kind": "new_shop", "draft": {"business": {"name": "Other"}}})
            assert socket.receive_json()["session_id"] != sid
            socket.send_json({"kind": "close"})


def _uid(app: Any) -> str:
    sessions = app.state.services.runtime.sessions.sessions[APP_NAME]
    return next(iter(sessions))


def test_long_hindi_onboarding_stays_on_one_socket_and_logs_why_it_ended(
    tmp_path: Path,
) -> None:
    """20 turns (more than the old 40-call budget allowed) on one socket, never an error."""
    app = create_app(settings(tmp_path), InMemorySessionService())
    turns = [
        "Hello! I want to open a new shop.",
        "name: Sharma Chai",
        "category: Tea stall",
        "location: Lajpat Nagar",
        "hours: 7am-9pm",
        "payment: UPI, cash",
        "delivery: none",
    ] + ["मुझे नहीं पता।"] * 13
    with capture_logs() as logs, TestClient(app) as client:
        join(client)
        with client.websocket_connect(
            "/api/v1/voice?new_shop=true&lang=hi", headers=ORIGIN
        ) as socket:
            socket.send_json({"kind": "new_shop", "draft": None})
            assert socket.receive_json()["kind"] == "ready"
            asked: list[str] = []
            for text in turns:
                reply = coach_said(answer(socket, text))
                asked.append(reply)
            socket.send_json({"kind": "close"})
    # Every question the coach asked about a saved field came before the answer, never after.
    after_name = " ".join(asked[2:])
    assert "What is your business called?" not in after_name
    closed = [entry for entry in logs if entry["event"] == "voice_closed"]
    assert closed and closed[-1]["reason"] == "client_close"
    assert closed[-1]["turns"] == len(turns)


def test_microphone_budget_grows_with_the_conversation() -> None:
    conversation = AudioBudget(Settings(app_env="test", _env_file=None), new_shop=True)
    conversation.started = time.monotonic() - 600
    chunk = b"\x00\x00" * 8000
    for _ in range(1200):  # 19 MB: ten minutes of always-on microphone
        conversation.take(chunk)
    press = AudioBudget(Settings(app_env="test", _env_file=None), new_shop=False)
    with pytest.raises(ValueError, match="Audio budget"):
        for _ in range(1200):
            press.take(chunk)


# --- The Live call budget and server-side rotation (Gemini Live, faked) ---


class FakeSocket:
    def __init__(self) -> None:
        self.frames: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.sent: list[Any] = []

    def push(self, payload: dict[str, Any]) -> None:
        self.frames.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    async def receive(self) -> dict[str, Any]:
        return await self.frames.get()

    async def send_json(self, payload: Any) -> None:
        self.sent.append(payload)

    async def send_bytes(self, payload: bytes) -> None:
        self.sent.append(payload)


class FakeLive:
    """One scripted Live connection per run_live call."""

    def __init__(self, scripts: list[Any]) -> None:
        self.scripts = scripts
        self.queues: list[LiveRequestQueue] = []
        self.instructions: list[str] = []

    def run_live(self, *, live_request_queue: LiveRequestQueue, **_: Any) -> AsyncIterator[Event]:
        self.queues.append(live_request_queue)
        self.instructions.append(turn_instruction())
        script = self.scripts[min(len(self.queues), len(self.scripts)) - 1]
        return script(live_request_queue)


class FakeRuntime:
    def __init__(self, live: FakeLive) -> None:
        self.settings = Settings(app_env="test", _env_file=None)
        self.live_runner = live


def turn(question: str, tools: int = 1) -> list[Event]:
    calls = [
        Event(
            author="business_coach",
            content=types.Content(
                role="model",
                parts=[types.Part(function_call=types.FunctionCall(name="propose_business"))],
            ),
        )
        for _ in range(tools)
    ]
    return [
        *calls,
        Event(author="business_coach", output_transcription=types.Transcription(text=question)),
        Event(author="business_coach", turn_complete=True),
    ]


async def forever(queue: LiveRequestQueue) -> AsyncIterator[Event]:
    for event in turn("आपकी दुकान का नाम क्या है?"):
        yield event
    await asyncio.Event().wait()
    yield Event(author="business_coach")  # pragma: no cover


async def run_voice(live: FakeLive, socket: FakeSocket, context: MerchantContext) -> VoiceStats:
    stats = VoiceStats()
    token = current.set(context)
    try:
        async with asyncio.timeout(10):
            await gemini_voice(
                socket,  # type: ignore[arg-type]
                FakeRuntime(live),  # type: ignore[arg-type]
                Principal("alice", "test"),
                "sid",
                reply_language("hi"),
                stats,
            )
    finally:
        current.reset(token)
    return stats


def new_shop_context(tmp_path: Path) -> MerchantContext:
    return MerchantContext(
        MerchantStore(str(tmp_path / "shops.sqlite")),
        "alice",
        None,
        [],
        new_shop=True,
        new_shop_draft=chai_draft(),
    )


def test_live_run_config_has_no_call_cap_and_the_tuned_voice() -> None:
    """The old 40-call cap is gone from the Live conversation (ADK never counted Live calls; the
    provider's close ended it); the new-shop session keeps resumption and a sliding window, with
    VAD that waits for owners who pause, barge-in, affective dialog and proactive audio."""
    from app.voice import END_OF_TURN_SILENCE_MS, VOICE_LLM_CALLS, live_run_config

    hindi = reply_language("hi")
    config = live_run_config(Settings(app_env="test", _env_file=None), hindi, new_shop=True)
    assert config.max_llm_calls != VOICE_LLM_CALLS and config.max_llm_calls > 100
    assert config.session_resumption is not None
    assert config.context_window_compression
    assert config.context_window_compression.sliding_window
    vad = config.realtime_input_config
    assert vad and vad.automatic_activity_detection
    assert vad.automatic_activity_detection.silence_duration_ms == END_OF_TURN_SILENCE_MS
    assert END_OF_TURN_SILENCE_MS >= 1000
    assert (
        vad.automatic_activity_detection.end_of_speech_sensitivity
        == types.EndSensitivity.END_SENSITIVITY_LOW
    )
    assert vad.activity_handling == types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
    assert config.enable_affective_dialog is True
    assert config.proactivity and config.proactivity.proactive_audio is True
    plain = live_run_config(
        Settings(app_env="test", _env_file=None), hindi, new_shop=True, extras=False
    )
    assert plain.realtime_input_config is None and plain.enable_affective_dialog is None
    assert plain.speech_config and plain.speech_config.language_code == "hi-IN"


async def test_a_tool_turn_is_not_the_reply_press_to_talk_waits_for_the_words(
    tmp_path: Path,
) -> None:
    """#137: after a tool ran, ADK completes a turn before the coach says anything (seen live,
    17 Oct). The shop chat's press-to-talk took that turn_complete as the reply's end and hung up,
    so the owner's turn showed nothing. Only the spoken reply's turn_complete reaches the app."""
    socket = FakeSocket()

    async def tool_then_reply(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        yield Event(author="user", input_transcription=types.Transcription(text="Add masala chai"))
        yield Event(
            author="business_coach",
            content=types.Content(
                role="model",
                parts=[types.Part(function_call=types.FunctionCall(name="propose_products"))],
            ),
        )
        yield Event(
            author="business_coach",
            content=types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            name="propose_products", response={"status": "proposed"}
                        )
                    )
                ],
            ),
        )
        yield Event(author="business_coach", turn_complete=True)
        for event in turn("Added masala chai at 15 rupees. Anything else?", tools=0):
            yield event

    shop = MerchantContext(MerchantStore(str(tmp_path / "shops.sqlite")), "alice", None, [])
    stats = await run_voice(FakeLive([tool_then_reply]), socket, shop)
    kinds = [e.get("kind") for e in socket.sent if isinstance(e, dict)]
    assert kinds.count("turn_complete") == 1
    assert kinds.index("input_transcript") < kinds.index("output_transcript")
    assert kinds.index("output_transcript") < kinds.index("turn_complete")
    assert stats.turns == 1 and stats.tool_calls == 1


async def test_many_tool_calls_never_end_or_rotate_the_live_connection(tmp_path: Path) -> None:
    """A long onboarding (20 turns, two tool calls each) stays on one Live connection."""
    socket = FakeSocket()

    async def busy(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        for index in range(20):
            for event in turn(f"सवाल {index}?", tools=2):
                yield event
        socket.push({"kind": "close"})
        await asyncio.Event().wait()

    stats = await run_voice(FakeLive([busy]), socket, new_shop_context(tmp_path))
    assert stats.reason == "client_close"
    assert stats.rotations == 0 and stats.turns == 20 and stats.tool_calls == 40
    assert not any(isinstance(e, dict) and e.get("kind") == "error" for e in socket.sent)


async def test_rejected_voice_options_fall_back_to_a_plain_session(tmp_path: Path) -> None:
    """A model that refuses an option (affective dialog, proactivity, VAD) never ends the
    conversation: the same socket reconnects without them and the turn is answered."""
    socket = FakeSocket()
    socket.push({"kind": "text", "text": "name: Lakshmi Tea Stall"})
    configs: list[Any] = []

    async def refuses(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        raise RuntimeError("1007 invalid argument: enable_affective_dialog is not supported")
        yield  # pragma: no cover

    async def answers(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        request = await queue.get()
        assert request.content and request.content.parts
        for event in turn("आप क्या बेचते हैं?"):
            yield event
        socket.push({"kind": "close"})
        await asyncio.Event().wait()

    live = FakeLive([refuses, answers])
    original = live.run_live

    def recording(**kwargs: Any) -> AsyncIterator[Event]:
        configs.append(kwargs["run_config"])
        return original(**kwargs)

    live.run_live = recording  # type: ignore[method-assign]
    with capture_logs() as logs:
        stats = await run_voice(live, socket, new_shop_context(tmp_path))
    assert stats.reason == "client_close" and stats.turns == 1
    assert configs[0].enable_affective_dialog is True
    assert configs[1].enable_affective_dialog is None
    assert any(entry["event"] == "voice_options_rejected" for entry in logs)
    # Not a rotation: the owner's first words were never answered, so no "resumed" note.
    assert stats.rotations == 0


async def test_provider_close_rotates_and_replays_the_unanswered_turn(tmp_path: Path) -> None:
    async def closes_after_text(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        await queue.get()
        # The provider ended the connection (a normal close; ADK ends the run quietly).
        return
        yield  # pragma: no cover

    async def answers(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        request = await queue.get()
        assert request.content and request.content.parts
        yield Event(
            author="business_coach",
            output_transcription=types.Transcription(text=f"echo {request.content.parts[0].text}"),
        )
        yield Event(author="business_coach", turn_complete=True)
        socket.push({"kind": "close"})
        await asyncio.Event().wait()

    live = FakeLive([closes_after_text, answers])
    socket = FakeSocket()
    socket.push({"kind": "text", "text": "location: Lajpat Nagar"})
    with capture_logs() as logs:
        stats = await run_voice(live, socket, new_shop_context(tmp_path))
    assert stats.reason == "client_close" and stats.rotations == 1
    assert {"kind": "output_transcript", "text": "echo location: Lajpat Nagar"} in socket.sent
    rotated = [entry for entry in logs if entry["event"] == "voice_rotated"]
    assert rotated and rotated[0]["reason"] == "provider_closed"


async def test_a_provider_that_keeps_closing_ends_with_a_reason(tmp_path: Path) -> None:
    async def closes(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        return
        yield  # pragma: no cover

    with pytest.raises(RuntimeError, match="keeps ending"):
        await run_voice(FakeLive([closes]), FakeSocket(), new_shop_context(tmp_path))


# --- "bas" always ends the conversation, whatever the model made of it ---


@pytest.mark.parametrize("spoken", [False, True])
async def test_a_stop_word_ends_live_voice_even_when_the_model_asks_on(
    tmp_path: Path, spoken: bool
) -> None:
    """Live once took "हो गया" after the face-check offer as a yes and asked on. Typed or
    spoken, the app ends the conversation after the coach's turn, like end_conversation."""
    socket = FakeSocket()
    if not spoken:
        socket.push({"kind": "text", "text": "हो गया"})

    async def asks_on(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        if spoken:
            yield Event(author="user", input_transcription=types.Transcription(text="हो गया"))
        else:
            await queue.get()
        for event in turn("ठीक है! क्या आप चेहरा जाँच करना चाहेंगे?", tools=0):
            yield event
        await asyncio.Event().wait()

    context = new_shop_context(tmp_path)
    stats = await run_voice(FakeLive([asks_on]), socket, context)
    assert stats.reason == "owner_ended" and context.ended
    assert {"kind": "action", "data": {"target": "end_conversation"}} in socket.sent
    assert not any(isinstance(e, dict) and e.get("kind") == "error" for e in socket.sent)


async def test_an_ordinary_answer_never_ends_live_voice(tmp_path: Path) -> None:
    socket = FakeSocket()
    socket.push({"kind": "text", "text": "subah 7 se raat 9, bas Sunday band"})

    async def answers(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        await queue.get()
        for event in turn("क्या आप दुकान की फ़ोटो ले सकते हैं?", tools=0):
            yield event
        socket.push({"kind": "close"})
        await asyncio.Event().wait()

    context = new_shop_context(tmp_path)
    stats = await run_voice(FakeLive([answers]), socket, context)
    assert stats.reason == "client_close" and not context.ended


def test_the_text_coach_ends_on_a_stop_word_before_the_model_decides(tmp_path: Path) -> None:
    from types import SimpleNamespace

    from google.adk.models.llm_request import LlmRequest

    from app.agent import end_on_request

    context = new_shop_context(tmp_path)
    text_turn = SimpleNamespace(_invocation_context=SimpleNamespace(live_request_queue=None))
    owner = types.Content(role="user", parts=[types.Part(text="हो गया")])
    request = LlmRequest(contents=[owner])
    token = current.set(context)
    try:
        context.message = "हो गया"
        response = end_on_request(text_turn, request)
        assert response and response.content and response.content.parts
        call = response.content.parts[0].function_call
        assert call and call.name == "end_conversation"
        # Gemini 3 refuses a history call without a signature (every later turn would fail).
        assert response.content.parts[0].thought_signature
        # After the tool ran, the model writes the goodbye itself.
        answered = types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        name="end_conversation", response={"status": "ended"}
                    )
                )
            ],
        )
        assert end_on_request(text_turn, LlmRequest(contents=[owner, answered])) is None
        # Live voice is handled in voice.py; an ordinary answer goes to the model.
        live_turn = SimpleNamespace(
            _invocation_context=SimpleNamespace(live_request_queue=LiveRequestQueue())
        )
        assert end_on_request(live_turn, request) is None
        context.message = "Lakshmi Tea Stall, bas itna hi naam hai"
        assert end_on_request(text_turn, request) is None
        context.message = "bas"
        context.ended = True
        assert end_on_request(text_turn, request) is None
    finally:
        current.reset(token)


def test_end_conversation_twice_changes_nothing(tmp_path: Path) -> None:
    from app.new_shop_tools import end_conversation

    context = new_shop_context(tmp_path)
    token = current.set(context)
    try:
        first = end_conversation()
        second = end_conversation()
    finally:
        current.reset(token)
    assert first["status"] == second["status"] == "ended"
    assert "card_id" in first and "card_id" not in second
    assert len(context.cards) == 1


def test_a_gps_pin_before_the_name_is_merged_not_refused() -> None:
    """Live check (17 Oct): "haan, main dukaan par hoon" before the name; the phone's pin draft
    (empty name) closed the socket with INVALID_FRAME."""
    saved = NewShopDraft(skipped=["hours"])
    pin = NewShopDraft(
        business=BusinessFields(name="", lat=12.9352, lng=77.6245, pin_source="device")
    )
    merged = merge_drafts(saved, pin)
    assert merged and merged.business and merged.business.lat == 12.9352
    assert merged.business.name == "" and merged.skipped == ["hours"]


def test_the_voice_socket_takes_a_pin_before_the_name(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), InMemorySessionService())
    with TestClient(app) as client:
        join(client)
        with client.websocket_connect("/api/v1/voice?new_shop=true&lang=hi", headers=ORIGIN) as ws:
            ws.send_json({"kind": "new_shop", "draft": None})
            assert ws.receive_json()["kind"] == "ready"
            ws.send_json({"kind": "text", "text": "हाँ, मैं अभी दुकान पर हूँ।"})
            while ws.receive_json()["kind"] != "turn_complete":
                pass
            pin = {"name": "", "lat": 12.9352, "lng": 77.6245, "pin_source": "device"}
            ws.send_json({"kind": "new_shop", "draft": {"business": pin, "products": []}})
            ws.send_json({"kind": "text", "text": "name: Kaveri Tiffin; category: idli dosa"})
            seen = []
            while (event := ws.receive_json())["kind"] != "turn_complete":
                seen.append(event)
        assert not any(event["kind"] == "error" for event in seen)
        drafts = [event["data"] for event in seen if event["kind"] == "draft"]
        assert drafts and drafts[-1]["business"]["lat"] == 12.9352
        assert drafts[-1]["business"]["name"] == "Kaveri Tiffin"


async def test_words_spoken_before_a_drop_reach_the_next_connection(tmp_path: Path) -> None:
    """#108: the owner said "my tea shop", the connection dropped before the coach's turn
    completed (so the words were never saved), and the reconnected coach asked again. The next
    connection now hears them first."""
    spoken = "मेरी चाय की दुकान है"

    async def drops_mid_turn(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        yield Event(author="user", input_transcription=types.Transcription(text=spoken))
        # The provider ended the connection before the coach's turn completed.

    heard: list[str] = []

    async def hears(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        request = await queue.get()
        assert request.content and request.content.parts
        heard.append(request.content.parts[0].text or "")
        for event in turn("आपकी दुकान का नाम क्या है?", tools=0):
            yield event
        socket.push({"kind": "close"})
        await asyncio.Event().wait()

    socket = FakeSocket()
    live = FakeLive([drops_mid_turn, hears])
    with capture_logs() as logs:
        stats = await run_voice(live, socket, new_shop_context(tmp_path))
    assert stats.reason == "client_close" and stats.rotations == 1
    assert heard == [spoken]
    assert any(entry["event"] == "voice_spoken_turn_carried" for entry in logs)
    # The reconnected coach is told it resumed, with the saved draft as the source of truth.
    assert "connection dropped" in live.instructions[1]


async def test_a_completed_spoken_turn_is_not_replayed_after_a_drop(tmp_path: Path) -> None:
    """Words the coach already answered are saved with the turn; a later drop replays nothing."""

    async def answers_then_drops(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        yield Event(author="user", input_transcription=types.Transcription(text="चाय की दुकान"))
        for event in turn("आपकी दुकान का नाम क्या है?", tools=0):
            yield event

    replayed: list[Any] = []

    async def listens(queue: LiveRequestQueue) -> AsyncIterator[Event]:
        replayed.append(queue._queue.qsize())
        socket.push({"kind": "close"})
        await asyncio.Event().wait()
        yield Event(author="business_coach")  # pragma: no cover

    socket = FakeSocket()
    stats = await run_voice(
        FakeLive([answers_then_drops, listens]), socket, new_shop_context(tmp_path)
    )
    assert stats.rotations == 1 and replayed == [0]


def test_a_stop_word_in_any_app_language_ends_the_chat() -> None:
    from app.agent import asks_to_end

    for word in (
        "stop",
        "That's all.",
        "bas",
        "ho gaya",
        "बस",
        "हो गया",
        "够了",
        "好了。",
        "cukup",
        "sudah",
        "sudah cukup",
        "போதும்",
        "நிறுத்து",
    ):
        assert asks_to_end(word), word
    for answer in (
        "Lakshmi Tea Stall, bas itna hi naam hai",
        "我的店叫好了茶铺",
        "cukup besar untuk lima orang",
    ):
        assert not asks_to_end(answer), answer
