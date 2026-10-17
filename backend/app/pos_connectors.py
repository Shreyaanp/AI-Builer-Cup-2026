"""Square through Google Cloud Integration Connectors (connector client only).

With `POS_SOURCE=google-connectors` the Square pull reads items and orders from a Connectors
connection (default `square-sandbox`) instead of calling Square directly. This module only
reads existing connections: it never creates, resumes or deletes one, because connections are
billed per node. The owner creates them (docs/integrations/google-connectors.md).

The connection's entity lists are put back into the shapes of the Square API, so the same row
builders in pos_live.py serve the direct, the Connectors and the recorded-sample paths.
Authentication is Google default credentials; no token is stored here.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import anyio
import httpx

from .settings import Settings

API = "https://connectors.googleapis.com/v1"
PAGE = 200
MAX_PAGES = 25
# The Square API path a pull asks for -> (Connectors entity type, key of the list in the reply).
SQUARE_ENTITIES = {
    "/v2/locations": ("Location", "locations"),
    "/v2/catalog/list": ("CatalogObject", "objects"),
    "/v2/orders/search": ("Order", "orders"),
}


class ConnectorsError(Exception):
    """The Connectors API could not be reached or refused the call."""


class GoogleConnectors:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport
        self._credentials: Any = None

    async def _token(self) -> str:
        if self.transport is not None:
            return "test-token"

        def refresh() -> str:
            from google.auth import default
            from google.auth.transport.requests import Request as AuthRequest

            if self._credentials is None:
                self._credentials, _ = default(
                    scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
            if not self._credentials.valid:
                self._credentials.refresh(AuthRequest())
            return str(self._credentials.token)

        return await anyio.to_thread.run_sync(refresh)

    def entities_url(self, connection: str, entity_type: str) -> str:
        s = self.settings
        return (
            f"{API}/projects/{quote(s.google_cloud_project, safe='')}"
            f"/locations/{quote(s.connectors_location, safe='')}"
            f"/connections/{quote(connection, safe='')}"
            f"/entityTypes/{quote(entity_type, safe='')}/entities"
        )

    async def entities(
        self, connection: str, entity_type: str, filter: str = ""
    ) -> list[dict[str, Any]]:
        """Every entity of one type as plain dicts (the `fields` struct of each)."""
        if not self.settings.google_cloud_project:
            raise ConnectorsError("no Google Cloud project")
        headers = {"Authorization": f"Bearer {await self._token()}"}
        found: list[dict[str, Any]] = []
        token = ""
        async with httpx.AsyncClient(timeout=20.0, transport=self.transport) as client:
            for _ in range(MAX_PAGES):
                params = {"pageSize": str(PAGE)}
                if token:
                    params["pageToken"] = token
                if filter:
                    params["filter"] = filter
                reply = await client.get(
                    self.entities_url(connection, entity_type), params=params, headers=headers
                )
                if reply.status_code != 200:
                    raise ConnectorsError(f"connectors {entity_type} {reply.status_code}")
                data = reply.json()
                found.extend(e.get("fields", e) for e in data.get("entities") or [])
                token = data.get("nextPageToken") or ""
                if not token:
                    break
        return found


def _decode(value: Any) -> Any:
    """Connectors may return nested objects as JSON strings."""
    if isinstance(value, str) and value[:1] in "{[":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def square_transport(connectors: GoogleConnectors) -> httpx.MockTransport:
    """Answers the Square API paths a pull uses from the Connectors entity lists."""

    async def handle(request: httpx.Request) -> httpx.Response:
        route = SQUARE_ENTITIES.get(request.url.path)
        if route is None:
            return httpx.Response(404, json={})
        entity_type, key = route
        rows = await connectors.entities(connectors.settings.square_connection, entity_type)
        decoded = [{k: _decode(v) for k, v in row.items()} for row in rows]
        return httpx.Response(200, json={key: decoded})

    return httpx.MockTransport(handle)
