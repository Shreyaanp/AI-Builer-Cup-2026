"""The coach speaks the owner's chosen app language (voice and text).

Regression: the Live voice session never received the app language, so the model guessed it
from the audio and drifted (a Hindi owner was answered in Bhojpuri). Offline only.
"""

import re

import pytest
from fastapi.testclient import TestClient
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.agent import make_agent, turn_instruction, ui_language
from app.main import create_app
from app.reply_language import LANGUAGES, find_language, reply_language
from app.settings import Settings
from app.streaming import public_events
from app.voice import live_run_config
from app.voice_tools import set_reply_language
from tests.test_voice_continuity import ORIGIN

DEVANAGARI = re.compile(r"[ऀ-ॿ]")


@pytest.mark.parametrize(
    ("tag", "code", "name"),
    [
        ("hi", "hi-IN", "Hindi"),
        ("hi-IN", "hi-IN", "Hindi"),
        ("ta", "ta-IN", "Tamil"),
        ("kn-in", "kn-IN", "Kannada"),
        ("en", "en-US", "English"),
    ],
)
def test_live_run_config_and_instruction_carry_the_locale(tag: str, code: str, name: str) -> None:
    language = reply_language(tag)
    config = live_run_config(Settings(_env_file=None), language, new_shop=False)
    assert config.speech_config is not None
    assert config.speech_config.language_code == code
    assert config.speech_config.voice_config is not None  # the chosen voice is kept
    assert config.input_audio_transcription is not None
    assert config.input_audio_transcription.language_codes == [code]
    token = ui_language.set(language.locale)
    try:
        rule = turn_instruction()
    finally:
        ui_language.reset(token)
    assert f"Always speak and write in {name} ({code})." in rule
    assert f"understand it and still reply only in {name}" in rule
    assert "never a mix" in rule
    assert "Never switch to another language or dialect (e.g. Bhojpuri, Maithili, Urdu)" in rule


def test_languages_without_live_speech_are_pinned_by_the_instruction_only() -> None:
    config = live_run_config(Settings(_env_file=None), reply_language("ms"), new_shop=True)
    assert config.speech_config is not None and config.speech_config.language_code is None
    assert config.input_audio_transcription is not None
    assert config.input_audio_transcription.language_codes is None


def test_all_fifteen_app_locales_and_unknown_tags() -> None:
    assert len(LANGUAGES) == 15
    assert all(reply_language(locale).locale == locale for locale in LANGUAGES)
    assert reply_language("zh-CN").locale == "zh-Hans"
    assert reply_language("in").locale == "id"
    assert reply_language(None).locale == "en"
    assert reply_language("es-MX").locale == "en"  # not an app language
    assert reply_language("x" * 500).locale == "en"
    assert find_language("bho") is None  # Bhojpuri is never a reply language


def test_explicit_switch_tool_updates_the_app_setting() -> None:
    assert set_reply_language("English")["language"] == "en"
    result = set_reply_language("ta")
    assert result["status"] == "changed" and "Tamil (ta-IN)" in result["instruction"]
    assert set_reply_language("Bhojpuri")["status"] == "unsupported"
    event = Event(
        author="business_coach",
        content=types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        name="set_reply_language", response=result
                    )
                )
            ],
        ),
    )
    [action] = public_events(event)
    assert action.kind == "action"
    assert action.data == {"target": "language", "language": "ta"}
    voice = make_agent(Settings(_env_file=None, v1_enabled=True), live=True)
    assert "set_reply_language" in [getattr(tool, "name", None) or tool.__name__ for tool in voice.tools]  # type: ignore[union-attr]


@pytest.mark.parametrize(("lang", "hindi"), [("hi-IN", True), ("en", False), (None, False)])
def test_voice_socket_reads_the_lang_query(lang: str | None, hindi: bool) -> None:
    app = create_app(Settings(app_env="test", _env_file=None), InMemorySessionService())
    query = f"?lang={lang}" if lang else ""
    with TestClient(app) as client:
        client.get("/api/v1/bootstrap")
        with client.websocket_connect(f"/api/v1/voice{query}", headers=ORIGIN) as ws:
            assert ws.receive_json()["kind"] == "ready"
            ws.send_json({"kind": "text", "text": "namaste"})
            replies = []
            while (event := ws.receive_json())["kind"] != "turn_complete":
                if event["kind"] == "reply":
                    replies.append(event["text"])
    assert bool(DEVANAGARI.search(" ".join(replies))) is hindi


def test_hindi_is_written_in_devanagari_never_romanized() -> None:
    """Live eval (plumber): a Hindi onboarding asked "kya aap abhi apni dukan par hain?"."""
    from app.reply_language import language_rule

    assert "Devanagari script, never in Roman letters" in language_rule(reply_language("hi"))
    assert "Tamil script" in language_rule(reply_language("ta"))
    assert "Roman letters" not in language_rule(reply_language("en"))
    assert "Roman letters" not in language_rule(reply_language("ms"))
