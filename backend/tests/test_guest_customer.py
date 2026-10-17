"""Guest journeys on both stores. Provider claims below are fixtures, never live OAuth."""

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService

from app.auth import COOKIE
from app.main import create_app
from app.settings import Settings
from scripts.seed_demo_shops import seed
from tests.test_community import requires_emulator
from tests.test_customer import create_shop
from tests.test_photos import join

DEMO = "demo-tiong-bahru-bakery"


@pytest.fixture(params=["sqlite", "firestore"])
def client(request: pytest.FixtureRequest, tmp_path: Path):
    hosted = {}
    if request.param == "firestore":
        requires_emulator()
        hosted = dict(
            merchant_backend="firestore",
            google_cloud_project="demo-ogoogle-local",
            firestore_namespace="ogoogle_ai_test_" + uuid4().hex,
        )
    app = create_app(
        Settings(
            app_env="test",
            coach_mode="offline",
            v1_enabled=True,
            guest_customer=True,
            merchant_database=str(tmp_path / "merchant.sqlite3"),
            recall_path=str(tmp_path / "recall"),
            rate_limits_enabled=False,
            _env_file=None,
            **hosted,
        ),
        InMemorySessionService(),
    )
    with TestClient(app) as browser:
        seed(app.state.merchant, "demo-owner", city="singapore")
        app.state.demo_reply_delay = 0.05
        assert browser.post("/api/v1/customer/guest").status_code == 200
        yield browser


def stamp_body(client: TestClient) -> dict:
    key = client.get(f"/api/v1/public/shops/{DEMO}/demo-qr").json()["key"]
    return {"shop_id": DEMO, "key": key}


def start(client: TestClient, shop: str = DEMO) -> dict:
    response = client.post(
        f"/api/v1/customer/shops/{shop}/threads", json={"text": "Hello", "instant_answer": False}
    )
    assert response.status_code == 200, response.text
    return response.json()["thread"]


def test_guest_round_trip_is_owned_and_survives_reload(client: TestClient) -> None:
    me = client.get("/api/v1/customer/me").json()
    assert me["guest"] and not me["signed_in"] and me["name"].startswith("Guest ")
    iid = start(client)["id"]
    path = f"/api/v1/customer/shops/{DEMO}/threads/{iid}"
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        thread = client.get(path).json()["thread"]
        if thread["messages"][-1]["author"] == "owner":
            break
        time.sleep(0.05)
    assert thread["messages"][-1]["kind"] == "demo"
    assert client.get("/api/v1/customer/threads").json()[0]["unread"] == 1
    stranger = TestClient(client.app)
    stranger.post("/api/v1/customer/guest")
    assert stranger.get(path).status_code == 404
    assert stranger.post(path + "/messages", json={"text": "Stolen"}).status_code == 404
    assert client.post("/api/v1/customer/guest").is_success
    assert client.get(path).json()["thread"]["id"] == iid


def test_guest_daily_cap_atomic_and_upgrade_keeps_everything(client: TestClient) -> None:
    body = stamp_body(client)
    assert (
        client.post("/api/v1/customer/passport/stamps", json={**body, "key": "bad"}).status_code
        == 403
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda _: client.post("/api/v1/customer/passport/stamps", json=body).json(),
                range(2),
            )
        )
    assert sorted(r["outcome"]["verdict"] for r in results) == ["already_today", "stamped"]
    won = next(r for r in results if r["outcome"]["verdict"] == "stamped")
    ticket = won["scratch"]["id"]
    assert client.post(f"/api/v1/customer/games/scratch/{ticket}/reveal").is_success
    frozen = client.post("/api/v1/customer/games/freeze", json={"week": "next"})
    assert frozen.is_success and frozen.json()["verdict"] == "frozen"
    assert client.put(f"/api/v1/customer/follows/{DEMO}").is_success
    iid = start(client)["id"]
    before = client.get("/api/v1/customer/passport").json()
    assert not before["signed_in"] and not before["device_only"]
    # Omitting prior receipts cannot bypass the server's day cap.
    assert (
        client.post("/api/v1/public/passport/check", json=body).json()["outcome"]["verdict"]
        == "already_today"
    )
    assert client.post("/api/v1/customer/session", json={"name": "Asha"}).is_success
    after = client.get("/api/v1/customer/passport").json()
    assert after == {**before, "signed_in": True}
    me = client.get("/api/v1/customer/me").json()
    assert me["signed_in"] and not me["guest"] and DEMO in me["profile"]["follows"]
    assert client.get("/api/v1/customer/threads").json()[0]["thread"]["id"] == iid
    forged = client.post(
        "/api/v1/customer/passport/merge", json={"receipts": [], "cards": {DEMO: 100}}
    )
    assert forged.is_success and forged.json()["shops"] == after["shops"]
    assert (
        client.post("/api/v1/customer/passport/stamps", json=body).json()["outcome"]["verdict"]
        == "already_today"
    )


def test_guest_value_actions_require_google(client: TestClient) -> None:
    for path, method, body in (
        (f"/customer/passport/shops/{DEMO}/claim", "POST", None),
        ("/customer/games/perks/anything/use", "POST", None),
        ("/customer/games/coop/claim", "POST", {"area": "w21z", "week": "2026-W42"}),
        ("/customer/passport/leaderboard", "PUT", {"on": True}),
        ("/customer/passport/board?area=w21z", "GET", None),
        (
            f"/customer/shops/{DEMO}/rescue/anything/hold",
            "POST",
            {"thread_id": "anything", "name": "Bread", "qty": 1},
        ),
    ):
        response = client.request(method, "/api/v1" + path, json=body)
        assert response.status_code == 401, (path, response.text)
    assert client.get("/api/v1/businesses").status_code == 401


def test_full_guest_card_can_only_be_claimed_after_upgrade(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = stamp_body(client)
    now = [time.time()]
    monkeypatch.setattr("app.passport_routes.time.time", lambda: now[0])
    needed = client.get(f"/api/v1/public/shops/{DEMO}").json()["stamps_needed"]
    for _ in range(needed):
        result = client.post("/api/v1/customer/passport/stamps", json=body)
        assert result.json()["outcome"]["verdict"] == "stamped"
        now[0] += 86400
    before = client.get("/api/v1/customer/passport").json()
    claim = f"/api/v1/customer/passport/shops/{DEMO}/claim"
    assert client.post(claim).status_code == 401
    assert client.post("/api/v1/customer/session", json={"name": "Asha"}).is_success
    response = client.post(claim)
    assert response.is_success, response.text
    after = response.json()
    assert after["stamps"] == before["stamps"]
    card = next(shop for shop in after["shops"] if shop["id"] == DEMO)
    assert card["claimed"] == 1 and card["card"] == 0
    assert client.post(claim).status_code == 409


def test_owner_reply_block_and_unblock_guest(client: TestClient) -> None:
    owner = TestClient(client.app)
    join(owner)
    uid = client.app.state.services.identity.signer.loads(owner.cookies.get(COOKIE))
    shop = create_shop(client.app.state.merchant, uid)
    client.app.state.merchant.share(uid, shop, True)
    iid = start(client, shop)["id"]
    inbox = f"/api/v1/businesses/{shop}/inquiries"
    owned = f"/api/v1/customer/shops/{shop}/threads/{iid}"
    record = owner.get(inbox).json()[0]
    assert record["name"].startswith("Guest ") and record["contact"].endswith("@guest.invalid")
    assert "customer@example.test" not in str(record)
    assert owner.post(inbox + f"/{iid}/messages", json={"text": "Welcome!"}).is_success
    assert client.get(owned).json()["thread"]["messages"][-1]["text"] == "Welcome!"
    assert client.post(inbox + f"/{iid}/unblock").status_code in (401, 404)
    assert owner.post(inbox + f"/{iid}/block").json()["blocked"]
    assert client.post(owned + "/messages", json={"text": "Blocked"}).status_code == 409
    # Deleting and recreating the thread must not bypass the shop's identity block.
    assert client.delete(owned).is_success
    assert (
        client.post(f"/api/v1/customer/shops/{shop}/threads", json={"text": "Again"}).status_code
        == 409
    )
    # Linking the same identity must not evade its shop block by changing contact details.
    assert client.post("/api/v1/customer/session", json={"name": "Asha"}).is_success
    assert (
        client.post(f"/api/v1/customer/shops/{shop}/threads", json={"text": "Upgraded"}).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/v1/public/shops/{shop}/inquiries",
            json={"name": "Changed", "contact": "another@example.test", "message": "Bypass"},
        ).status_code
        == 409
    )
    assert owner.post(inbox + f"/{iid}/unblock").is_success
    assert client.post(
        f"/api/v1/customer/shops/{shop}/threads", json={"text": "Allowed"}
    ).is_success


def test_unblock_reopens_existing_guest_conversation(client: TestClient) -> None:
    owner = TestClient(client.app)
    join(owner)
    uid = client.app.state.services.identity.signer.loads(owner.cookies.get(COOKIE))
    shop = create_shop(client.app.state.merchant, uid)
    client.app.state.merchant.share(uid, shop, True)
    iid = start(client, shop)["id"]
    path = f"/api/v1/businesses/{shop}/inquiries/{iid}"
    assert owner.post(path + "/block").is_success
    unblocked = owner.post(path + "/unblock").json()
    assert not unblocked["blocked"] and not unblocked["done"]
    assert client.post(
        f"/api/v1/customer/shops/{shop}/threads/{iid}/messages", json={"text": "Thanks"}
    ).is_success


def test_guest_chat_rate_limit_across_shops(client: TestClient) -> None:
    client.app.state.v1_settings.rate_limits_enabled = True
    iid = start(client)["id"]
    path = f"/api/v1/customer/shops/{DEMO}/threads/{iid}/messages"
    for _ in range(9):
        assert client.post(path, json={"text": "Hi", "instant_answer": False}).is_success
    denied = client.post(path, json={"text": "Too many"})
    assert denied.status_code == 429 and int(denied.headers["retry-after"]) > 0
    other = create_shop(client.app.state.merchant, "demo-owner", "Second shop")
    client.app.state.merchant.share("demo-owner", other, True)
    assert (
        client.post(
            f"/api/v1/customer/shops/{other}/threads", json={"text": "Another thread"}
        ).status_code
        == 429
    )


def test_guest_card_only_scan_cannot_earn_a_second_stamp_with_location(client: TestClient) -> None:
    owner = TestClient(client.app)
    join(owner)
    uid = client.app.state.services.identity.signer.loads(owner.cookies.get(COOKIE))
    shop = create_shop(client.app.state.merchant, uid)
    client.app.state.merchant.share(uid, shop, True)
    key = owner.get(f"/api/v1/businesses/{shop}/qr-key").json()["key"]
    body = {"shop_id": shop, "key": key}
    path = "/api/v1/customer/passport/stamps"
    service = client.app.state.merchant
    from app.merchant import BusinessFields, ProposalRequest

    context = service.context(uid, shop)
    proposal = service.propose(
        uid,
        ProposalRequest(
            kind="business",
            business_id=shop,
            revision=context["business"]["revision"],
            business=BusinessFields(
                name="Tiong Bahru Kopi", stamps_enabled=True, reward_text="Free kopi"
            ),
        ),
    )
    service.commit(uid, proposal["id"], proposal["digest"])
    first = client.post(path, json=body).json()
    assert first["outcome"]["verdict"] == "card_only"
    second = client.post(path, json={**body, "lat": 1.285, "lng": 103.827, "accuracy": 10})
    assert second.json()["outcome"]["verdict"] == "already_today"
    assert second.json()["outcome"]["card"] == first["outcome"]["card"]


def test_guest_switch_off_rejects_existing_guest(client: TestClient) -> None:
    client.app.state.v1_settings.guest_customer = False
    assert client.post("/api/v1/customer/guest").status_code == 404
    assert not client.get("/api/v1/customer/me").json()["guest"]
    assert client.get("/api/v1/customer/threads").status_code == 401
    assert client.get("/api/v1/customer/passport").status_code == 401


def test_firebase_anonymous_is_customer_only_and_link_preserves_uid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def verify(token: str, **kwargs: object):
        return {
            "uid": "fixture-same-person",
            "email_verified": token == "google",
            "email": "asha@example.test",
            "name": "Asha",
            "firebase": {"sign_in_provider": "anonymous" if token == "guest" else "google.com"},
        }

    monkeypatch.setattr("app.auth.firebase_auth.verify_id_token", verify)
    app = create_app(
        Settings(
            app_env="test",
            auth_mode="firebase",
            google_cloud_project="demo-ogoogle-local",
            v1_enabled=True,
            guest_customer=True,
            merchant_database=str(tmp_path / "merchant.sqlite3"),
            recall_path=str(tmp_path / "recall"),
            rate_limits_enabled=False,
            _env_file=None,
        ),
        InMemorySessionService(),
    )
    with TestClient(app) as browser:
        seed(app.state.merchant, "demo-owner", city="singapore")
        browser.headers["authorization"] = "Bearer guest"
        assert browser.get("/api/v1/customer/me").json()["guest"]
        assert browser.get("/api/v1/businesses").status_code == 403
        assert browser.post("/api/v1/coach/stream", json={"message": "Hi"}).status_code == 403
        stamp = browser.post("/api/v1/customer/passport/stamps", json=stamp_body(browser)).json()
        iid = start(browser)["id"]
        browser.headers["authorization"] = "Bearer google"
        assert browser.get("/api/v1/customer/me").json()["signed_in"]
        assert (
            browser.get("/api/v1/customer/passport").json()["stamps"] == stamp["passport"]["stamps"]
        )
        assert browser.get("/api/v1/customer/threads").json()[0]["thread"]["id"] == iid
        app.state.v1_settings.guest_customer = False
        browser.headers["authorization"] = "Bearer guest"
        assert browser.get("/api/v1/customer/me").status_code == 403
