import json
import time
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService
from starlette.websockets import WebSocketDisconnect

from app.limits import JSON_BODY_BYTES, LIMITS, Bucket, RateLimiter
from app.main import create_app
from app.settings import Settings
from tests.test_customer import create_shop
from tests.test_photos import join, jpeg, upload


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    # Keep fixed-window assertions independent of the wall clock's minute boundary.
    now = time.time()
    monkeypatch.setattr("app.limits.time.time", lambda: now)
    return create_app(
        Settings(
            app_env="test",
            v1_enabled=True,
            merchant_database=str(tmp_path / "merchant.sqlite3"),
            recall_path=str(tmp_path / "recall"),
            _env_file=None,
        ),
        InMemorySessionService(),
    )


def fill(app: FastAPI, action: str, subject: str, remaining: int = 0) -> None:
    maximum, seconds = LIMITS[action][0]
    now = time.time()
    bucket = Bucket(action, subject, maximum, seconds)
    for _ in range(maximum - remaining):
        assert app.state.rate_limiter.take([bucket], now) == 0


def assert_limited(response, maximum: int = 60) -> None:
    assert response.status_code == 429
    assert response.json() == {"detail": "RATE_LIMITED"}
    assert 1 <= int(response.headers["retry-after"]) <= maximum


@pytest.mark.parametrize("action", ["coach", "photo", "proposal"])
def test_owner_routes_reject_and_another_owner_still_works(app: FastAPI, action: str) -> None:
    with TestClient(app) as client:
        join(client)
        uid = app.state.services.identity.local_principal(
            client.cookies.get("ogoogle_preview_session")
        ).uid
        fill(app, action, uid, remaining=1)

        def send():
            if action == "coach":
                return client.post("/api/v1/coach/stream", json={"message": "Hello"})
            if action == "photo":
                return upload(client, jpeg())
            return client.post(
                "/api/v1/proposals", json={"kind": "business", "business": {"name": "Kopi"}}
            )

        assert send().status_code == 200
        assert_limited(send())
        client.cookies.clear()
        join(client)
        assert send().status_code == 200


def test_public_ask_ip_is_shared_between_shops_and_daily_shop_limit(app: FastAPI) -> None:
    with TestClient(app) as client:
        first = create_shop(app.state.merchant)
        second = create_shop(app.state.merchant, "bob", "Jurong Bakery")
        app.state.merchant.share("alice", first, True)
        app.state.merchant.share("bob", second, True)
        headers = {"X-Forwarded-For": "192.0.2.1, 192.0.2.2"}
        fill(app, "ask:ip", "192.0.2.1", remaining=1)
        assert (
            client.post(
                f"/api/v1/public/shops/{first}/ask", json={"question": "Hours?"}, headers=headers
            ).status_code
            == 200
        )
        assert_limited(
            client.post(
                f"/api/v1/public/shops/{second}/ask", json={"question": "Hours?"}, headers=headers
            )
        )
        fill(app, "ask:shop", first, remaining=1)
        assert_limited(
            client.post(
                f"/api/v1/public/shops/{first}/ask",
                json={"question": "Hours?"},
                headers={"X-Forwarded-For": "192.0.2.3"},
            ),
            86_400,
        )
        assert (
            client.post(
                f"/api/v1/public/shops/{second}/ask",
                json={"question": "Hours?"},
                headers={"X-Forwarded-For": "192.0.2.3"},
            ).status_code
            == 200
        )


def test_voice_limit_and_disconnect_cleanup(app: FastAPI) -> None:
    with TestClient(app) as client:
        join(client)
        uid = app.state.services.identity.local_principal(
            client.cookies.get("ogoogle_preview_session")
        ).uid
        fill(app, "voice", uid, remaining=1)
        headers = {"origin": "http://127.0.0.1:3200"}
        with client.websocket_connect("/api/v1/voice", headers=headers) as socket:
            assert socket.receive_json()["kind"] == "ready"
            socket.send_json({"kind": "close"})
        assert not app.state.services.registry.active
        with client.websocket_connect("/api/v1/voice", headers=headers) as socket:
            event = socket.receive_json()
            assert event["kind"] == "error" and event["code"] == "RATE_LIMITED"
            assert 1 <= event["data"]["retry_after"] <= 600
            with pytest.raises(WebSocketDisconnect) as closed:
                socket.receive_json()
            assert closed.value.code == 1008
        assert not app.state.services.registry.active
        client.cookies.clear()
        join(client)
        with client.websocket_connect("/api/v1/voice", headers=headers) as socket:
            assert socket.receive_json()["kind"] == "ready"
            socket.send_json({"kind": "close"})
        assert not app.state.services.registry.active


def test_a_reconnect_on_a_flaky_network_is_not_refused_as_a_new_session(app: FastAPI) -> None:
    """New sessions are capped; reconnects of the owner's open conversation have their own,
    larger budget (a phone on bad data reconnects many times)."""
    with TestClient(app) as client:
        join(client)
        uid = app.state.services.identity.local_principal(
            client.cookies.get("ogoogle_preview_session")
        ).uid
        fill(app, "voice", uid, remaining=1)
        fill(app, "voice:resume", uid, remaining=3)
        headers = {"origin": "http://127.0.0.1:3200"}
        with client.websocket_connect("/api/v1/voice", headers=headers) as socket:
            ready = socket.receive_json()
            socket.send_json({"kind": "close"})
        with client.websocket_connect("/api/v1/voice", headers=headers) as socket:
            assert socket.receive_json()["code"] == "RATE_LIMITED"
        path = f"/api/v1/voice?session_id={ready['session_id']}"
        for _ in range(3):
            with client.websocket_connect(path, headers=headers) as socket:
                event = socket.receive_json()
                assert event["kind"] == "ready" and event["session_id"] == ready["session_id"]
                socket.send_json({"kind": "close"})
        with client.websocket_connect(path, headers=headers) as socket:
            assert socket.receive_json()["code"] == "RATE_LIMITED"


def test_public_inquiry_limits(app: FastAPI) -> None:
    with TestClient(app) as client:
        bid = create_shop(app.state.merchant)
        app.state.merchant.share("alice", bid, True)
        path = f"/api/v1/public/shops/{bid}/inquiries"
        body = {"contact": "customer@example.test", "message": "Hours?"}
        client.post("/api/v1/customer/session", json={"name": "Asha"})
        # Inquiries are limited per shop and IP (30/day); other IPs are unaffected.
        fill(app, "inquire:ip", f"{bid}:testclient", remaining=1)
        assert client.post(path, json=body).status_code == 200
        assert_limited(client.post(path, json=body), 86_400)
        other = client.post(path, json=body, headers={"X-Forwarded-For": "192.0.2.3"})
        assert other.status_code == 200


@pytest.mark.parametrize("action", ["bootstrap", "consent", "me"])
def test_identity_endpoint_ip_limits(app: FastAPI, action: str) -> None:
    with TestClient(app) as client:
        join(client)
        fill(app, action, "192.0.2.1")
        headers = {"X-Forwarded-For": "192.0.2.1, 192.0.2.2"}
        if action == "consent":
            response = client.post(
                "/api/v1/consent",
                json={"version": "2026-10-14", "terms": True, "privacy": True},
                headers=headers,
            )
        else:
            response = client.get(f"/api/v1/{action}", headers=headers)
        assert_limited(response)
        assert (
            client.get("/api/v1/bootstrap", headers={"X-Forwarded-For": "192.0.2.3"}).status_code
            == 200
        )


def test_request_body_and_existing_coach_character_cap(app: FastAPI) -> None:
    with TestClient(app) as client:
        join(client)
        path = "/api/v1/coach/stream"
        assert client.post(path, json={"message": "x" * 4001}).status_code == 422
        # JSON whitespace allows testing the transport limit independently of field validation.
        small = b'{"message":"Hello"}'
        headers = {"Content-Type": "application/json"}
        assert (
            client.post(
                path, content=small + b" " * (JSON_BODY_BYTES - len(small)), headers=headers
            ).status_code
            == 200
        )
        assert (
            client.post(
                path, content=small + b" " * (JSON_BODY_BYTES + 1 - len(small)), headers=headers
            ).status_code
            == 413
        )
        chunks = iter([small, b" " * 65_536])
        assert client.post(path, content=chunks, headers=headers).status_code == 413
        assert (
            client.request(
                "DELETE", "/api/v1/me/data", content=b" " * 65_537, headers=headers
            ).status_code
            == 413
        )


def test_sse_resume_does_not_consume_another_message_quota(app: FastAPI) -> None:
    with TestClient(app) as client:
        join(client)
        uid = app.state.services.identity.local_principal(
            client.cookies.get("ogoogle_preview_session")
        ).uid
        path = "/api/v1/coach/stream"
        response = client.post(path, json={"message": "Hello"})
        assert response.status_code == 200
        first = next(line[6:] for line in response.text.splitlines() if line.startswith("data: "))
        sid = json.loads(first)["session_id"]
        cursor = next(line[4:] for line in response.text.splitlines() if line.startswith("id: "))
        fill(app, "coach", uid, remaining=1)
        body = {"message": "Hello", "session_id": sid}
        assert_limited(client.post(path, json=body))
        resumed = client.post(path, json=body, headers={"Last-Event-ID": cursor})
        assert resumed.status_code == 200
        assert "turn_complete" in resumed.text


def test_store_outage_owner_open_public_closed(app: FastAPI) -> None:
    with TestClient(app) as client:
        join(client)
        bid = create_shop(app.state.merchant)
        app.state.merchant.share("alice", bid, True)
        failing = Mock(spec=RateLimiter)
        failing.take.side_effect = RuntimeError("Store unavailable")
        app.state.rate_limiter = failing
        assert client.post("/api/v1/coach/stream", json={"message": "Hello"}).status_code == 200
        assert_limited(client.post(f"/api/v1/public/shops/{bid}/ask", json={"question": "Hours?"}))
        assert_limited(client.get("/api/v1/bootstrap"))
