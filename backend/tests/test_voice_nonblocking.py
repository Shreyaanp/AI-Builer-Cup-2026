"""Voice tools never hold up the coach's first words (owner decision, 17 Oct: first audio was
1.5-2.5 s, target under 800 ms), and their results still reach the model with full context.

A real ADK Live run (Runner, the coach agent, its tools and callbacks) against a scripted Live
model: the model calls update_shop and speaks at once, as Gemini Live does. The draft save is
slowed to a Firestore-like 0.8 s.
"""

import asyncio
import time
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.base_llm_connection import BaseLlmConnection
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from structlog.testing import capture_logs

import app.new_shop_tools as new_shop_tools
from app.agent import BACKGROUND_TOOLS, BackgroundTool, background_tools, make_agent
from app.auth import Principal
from app.coordinator import MerchantContext, current
from app.merchant import MerchantStore, NewShopDraft
from app.reply_language import reply_language
from app.settings import Settings
from app.streaming import APP_NAME
from app.voice import VoiceStats, gemini_voice
from tests.test_voice_reliability import FakeSocket

SAVE_SECONDS = 0.8
AUDIO = b"\x00\x00" * 480


class ScriptedConnection(BaseLlmConnection):
    """The Live model: calls update_shop, then speaks at once; records what it is sent."""

    def __init__(self, socket: FakeSocket) -> None:
        self.socket = socket
        self.received: list[types.Content] = []

    async def send_history(self, history: list[types.Content]) -> None:
        pass

    async def send_content(self, content: types.Content) -> None:
        self.received.append(content)
        if any(part.function_response for part in content.parts or []):
            # The result is in the model's context: the owner ends the test conversation.
            self.socket.push({"kind": "close"})

    async def send_realtime(self, blob: types.Blob) -> None:
        pass

    async def receive(self) -> AsyncGenerator[LlmResponse]:
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            id="call-1",
                            name="update_shop",
                            args={"name": "Lakshmi Tea Stall", "category": "chai aur samosa"},
                        )
                    )
                ],
            )
        )
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(inline_data=types.Blob(data=AUDIO, mime_type="audio/pcm"))],
            )
        )
        yield LlmResponse(turn_complete=True)
        await asyncio.Event().wait()

    async def close(self) -> None:
        pass


class ScriptedLive(BaseLlm):
    model: str = "scripted-live"
    connection: Any = None

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse]:
        raise NotImplementedError
        yield  # pragma: no cover

    @asynccontextmanager
    async def connect(self, llm_request: LlmRequest) -> AsyncIterator[BaseLlmConnection]:
        yield self.connection


@pytest.fixture
def slow_save(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    original = new_shop_tools.go_live

    def go_live(ctx: MerchantContext) -> bool:
        time.sleep(SAVE_SECONDS)
        return original(ctx)

    monkeypatch.setattr(new_shop_tools, "go_live", go_live)
    yield


class Runtime:
    def __init__(self, settings: Settings, runner: Runner) -> None:
        self.settings = settings
        self.live_runner = runner


async def first_audio(tmp_path: Path, background: bool) -> tuple[float, ScriptedConnection, Any]:
    """Seconds from the start of the turn to the first coach audio on the owner's socket."""
    settings = Settings(app_env="test", v1_enabled=True, _env_file=None)
    socket = FakeSocket()
    connection = ScriptedConnection(socket)
    agent = make_agent(settings, live=True)
    agent.model = ScriptedLive(connection=connection)
    if not background:
        # The old coach: every tool blocks the model until it returns.
        agent.tools = [t.func if isinstance(t, BackgroundTool) else t for t in agent.tools]
    sessions = InMemorySessionService()
    await sessions.create_session(app_name=APP_NAME, user_id="alice", session_id="sid")
    runner = Runner(app_name=APP_NAME, agent=agent, session_service=sessions)
    merchant = MerchantContext(
        MerchantStore(str(tmp_path / f"shops-{background}.sqlite")),
        "alice",
        None,
        [],
        new_shop=True,
        new_shop_draft=NewShopDraft(),
    )
    token = current.set(merchant)
    started = time.perf_counter()
    heard: list[float] = []
    sent = socket.sent

    class Timed(list[Any]):
        def append(self, item: Any) -> None:
            if isinstance(item, bytes) and not heard:
                heard.append(time.perf_counter() - started)
            super().append(item)

    socket.sent = Timed(sent)
    stats = VoiceStats()
    try:
        async with asyncio.timeout(10):
            await gemini_voice(
                socket,  # type: ignore[arg-type]
                Runtime(settings, runner),  # type: ignore[arg-type]
                Principal("alice", "test"),
                "sid",
                reply_language("hi"),
                stats,
            )
    finally:
        current.reset(token)
    assert stats.reason == "client_close" and heard
    return heard[0], connection, merchant


def tool_results(connection: ScriptedConnection) -> list[types.FunctionResponse]:
    return [
        part.function_response
        for content in connection.received
        for part in content.parts or []
        if part.function_response
    ]


def test_live_agent_runs_profile_draft_location_and_photo_tools_in_the_background() -> None:
    settings = Settings(app_env="test", v1_enabled=True, _env_file=None)
    live = {
        t.name: t for t in make_agent(settings, live=True).tools if isinstance(t, BackgroundTool)
    }
    assert set(live) == set(BACKGROUND_TOOLS)
    assert live["update_shop"].behavior == types.Behavior.NON_BLOCKING
    assert live["show_step"].response_scheduling == types.FunctionResponseScheduling.SILENT
    assert (
        live["get_business_context"].response_scheduling
        == types.FunctionResponseScheduling.WHEN_IDLE
    )
    # end_conversation must finish before the goodbye: it stays blocking.
    assert "end_conversation" not in live
    # The text coach keeps plain tools.
    assert not any(isinstance(t, BackgroundTool) for t in make_agent(settings).tools)
    # A Live model that refused the tuned setup gets blocking tools on that connection.
    token = background_tools.set(False)
    try:
        assert live["update_shop"].behavior is None
        assert live["update_shop"].response_scheduling is None
    finally:
        background_tools.reset(token)


async def test_first_audio_does_not_wait_for_the_draft_save(
    tmp_path: Path, slow_save: None, capsys: pytest.CaptureFixture[str]
) -> None:
    blocking, old, _ = await first_audio(tmp_path, background=False)
    with capture_logs() as logs:
        background, connection, merchant = await first_audio(tmp_path, background=True)
    with capsys.disabled():
        print(
            f"\nfirst audio: blocking {blocking * 1000:.0f} ms,"
            f" background {background * 1000:.0f} ms"
        )
    # Before: the coach was silent until the save finished. Now it speaks at once.
    assert blocking >= SAVE_SECONDS
    assert background < 0.3

    # The result still reaches the model, complete, as a silent background result.
    [result] = tool_results(connection)
    assert result.name == "update_shop" and result.id == "call-1"
    assert result.scheduling == types.FunctionResponseScheduling.SILENT
    body = result.response or {}
    assert body["status"] == "saved"
    assert "name" in str(body["known_never_ask_again"])
    assert "location" in str(body["still_missing"])
    assert body["speak"]
    # The same content a blocking call returns (only the scheduling differs).
    [before] = tool_results(old)
    assert before.scheduling is None
    assert set(before.response or {}) == set(body)
    # The draft is saved on the conversation.
    assert merchant.new_shop_draft and merchant.new_shop_draft.business
    assert merchant.new_shop_draft.business.name == "Lakshmi Tea Stall"
    # Logged with what it carried, and timed.
    [logged] = [entry for entry in logs if entry["event"] == "voice_tool_result"]
    assert logged["tool"] == "update_shop" and logged["scheduling"] == "SILENT"
    assert logged["ms"] >= SAVE_SECONDS * 1000 and logged["missing"]
    assert "still_missing" in logged["fields"]
    assert any(
        entry["event"] == "coach_latency" and entry["flow"] == "voice_tool:update_shop"
        for entry in logs
    )
