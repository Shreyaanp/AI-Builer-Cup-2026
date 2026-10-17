import asyncio
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService
from pydantic import ValidationError

from app.discover import MapsService
from app.main import create_app
from app.place_photos import MAX_BYTES, PlacesPhotos
from app.settings import Settings

NAME = "places/fixture-place/photos/fixture-photo"
PHOTO = {
    "id": "fixture-place",
    "photos": [{"name": NAME, "authorAttributions": [{"displayName": "Fixture photographer"}]}],
}


def test_photo_media_is_bounded_cached_and_key_stays_server_side() -> None:
    calls: list[httpx.Request] = []

    def mock(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "places.googleapis.com":
            assert request.headers["X-Goog-Api-Key"] == "offline-fixture"
            assert request.url.params["maxWidthPx"] == "800"
            assert request.url.params["skipHttpRedirect"] == "true"
            return httpx.Response(
                200, json={"photoUri": "https://lh3.googleusercontent.com/fixture"}
            )
        assert "X-Goog-Api-Key" not in request.headers
        return httpx.Response(200, content=b"fixture-webp", headers={"Content-Type": "image/webp"})

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
            photos = PlacesPhotos(client, "offline-fixture", True)
            url, authors = photos.describe(PHOTO)
            assert url and "offline-fixture" not in url and "width=800" in url
            assert authors == ["Fixture photographer"]
            first, second = await asyncio.gather(photos.media(NAME, 800), photos.media(NAME, 800))
            assert first == second == (b"fixture-webp", "image/webp")
            assert len(calls) == 2
            with pytest.raises(HTTPException) as unknown:
                await photos.media("places/other/photos/arbitrary", 800)
            assert unknown.value.status_code == 404
            assert len(calls) == 2

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["host", "mime", "bytes", "redirect", "provider"])
def test_untrusted_or_failed_media_is_not_cached(failure: str) -> None:
    def mock(request: httpx.Request) -> httpx.Response:
        if request.url.host == "places.googleapis.com":
            if failure == "provider":
                return httpx.Response(403)
            uri = (
                "https://attacker.invalid/fixture"
                if failure == "host"
                else "https://lh3.googleusercontent.com/fixture"
            )
            return httpx.Response(200, json={"photoUri": uri})
        if failure == "redirect":
            return httpx.Response(302, headers={"Location": "https://attacker.invalid"})
        return httpx.Response(
            200,
            content=b"x" * (MAX_BYTES + 1) if failure == "bytes" else b"image",
            headers={"Content-Type": "image/svg+xml" if failure == "mime" else "image/jpeg"},
        )

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
            photos = PlacesPhotos(client, "offline-fixture", True)
            photos.describe(PHOTO)
            with pytest.raises(HTTPException) as failed:
                await photos.media(NAME, 800)
            assert failed.value.status_code == 503
            assert not photos.cache

    asyncio.run(scenario())


def test_cancelled_media_releases_single_flight_lock() -> None:
    entered = asyncio.Event()

    async def mock(request: httpx.Request) -> httpx.Response:
        entered.set()
        await asyncio.Event().wait()
        return httpx.Response(200)

    async def scenario() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as client:
            photos = PlacesPhotos(client, "offline-fixture", True)
            photos.describe(PHOTO)
            pending = asyncio.create_task(photos.media(NAME, 800))
            await entered.wait()
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert not photos.lock.locked() and not photos.cache

    asyncio.run(scenario())


def test_photo_route_validation_demo_and_public_origin(tmp_path: Path) -> None:
    settings = Settings(
        app_env="test",
        v1_enabled=True,
        customer_origin="https://customer.example",
        ga_measurement_id="G-ABC123",
        merchant_database=str(tmp_path / "merchant.sqlite"),
        recall_path=str(tmp_path / "recall"),
        rate_limits_enabled=False,
        _env_file=None,
    )
    app = create_app(settings, InMemorySessionService())
    with TestClient(app) as client:
        assert (
            client.get("/api/v1/bootstrap").json()["customer_origin"] == "https://customer.example"
        )
        assert client.get("/api/v1/bootstrap").json()["ga_measurement_id"] == "G-ABC123"
        assert (
            client.get("/api/v1/place-photo", params={"name": NAME, "width": 801}).status_code
            == 422
        )
        assert client.get("/api/v1/place-photo", params={"name": NAME}).status_code == 404
        maps: MapsService = app.state.maps
        assert maps.photos.describe(PHOTO) == (None, [])


@pytest.mark.parametrize(
    "origin",
    [
        "javascript:alert(1)",
        "https://user:password@customer.example",
        "https://customer.example/path",
        "http://customer.example",
        "https://customer.example?app=business",
    ],
)
def test_customer_origin_rejects_non_origins(origin: str) -> None:
    with pytest.raises(ValidationError):
        Settings(customer_origin=origin, _env_file=None)
