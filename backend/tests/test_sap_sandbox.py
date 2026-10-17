"""SAP sandbox purchase orders: mapping, the live read, and fallbacks to the recorded sample."""

import asyncio
import json

import httpx
import pytest
from pydantic import SecretStr

from app import sap_sandbox
from app.sap_sandbox import SapSandbox, map_response, odata_date, recorded
from app.settings import Settings


def config(**update: object) -> Settings:
    base = {"coach_mode": "offline", "app_env": "test", "supply_sap_live": True}
    return Settings(_env_file=None, **{**base, **update})  # type: ignore[arg-type]


KEY = SecretStr("test-key-not-real")


def sample() -> dict:
    return json.loads(sap_sandbox.SAMPLE.read_text(encoding="utf-8"))


def transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def test_dates_read_both_odata_versions() -> None:
    assert odata_date("/Date(1491436800000)/") == "2017-04-06"
    assert odata_date("2017-04-06") == "2017-04-06"
    assert odata_date(None) == "" and odata_date("soon") == ""


def test_recorded_sample_maps_to_orders_with_idoc() -> None:
    docs = recorded()
    assert docs and all(doc.kind == "ORDERS" and doc.lines for doc in docs)
    assert all(doc.total == sum(line.total or 0 for line in doc.lines) for doc in docs)
    answer = SapSandbox(config(supply_sap_live=False))
    result = asyncio.run(answer.orders())
    assert result["source"] == "recorded" and result["reason"] == "off"
    assert "<IDOC" in result["orders"][0]["idoc"]


def test_bad_rows_are_skipped_not_fatal() -> None:
    payload = sample()
    payload["d"]["results"].insert(0, {"PurchaseOrder": "1", "DocumentCurrency": "??"})
    payload["d"]["results"].append("junk")
    assert len(map_response(payload)) == len(recorded())
    assert map_response({"unexpected": True}) == []


def test_v4_shape_is_read() -> None:
    row = sample()["d"]["results"][0]
    v4 = {
        **{k: v for k, v in row.items() if k != "to_PurchaseOrderItem"},
        "_PurchaseOrderItem": row["to_PurchaseOrderItem"]["results"],
    }
    assert map_response({"value": [v4]})[0].number == row["PurchaseOrder"]


def test_no_key_never_calls_sap() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not call SAP without a key")

    service = SapSandbox(config(), transport(refuse))
    assert asyncio.run(service.orders())["reason"] == "no_key"


def test_live_read_sends_the_key_once_and_caches() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=sample())

    service = SapSandbox(config(sap_sandbox_api_key=KEY), transport(handler))
    first = asyncio.run(service.orders())
    second = asyncio.run(service.orders())
    assert first["source"] == "live" and first["reason"] == "" and second is first
    assert len(seen) == 1
    assert seen[0].method == "GET" and seen[0].headers["APIKey"] == KEY.get_secret_value()
    assert seen[0].url.path.endswith("/A_PurchaseOrder")


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (httpx.Response(401), "rejected"),
        (httpx.Response(403), "rejected"),
        (httpx.Response(429), "error"),
        (httpx.Response(500), "error"),
        (httpx.Response(200, text="<html>not json</html>"), "error"),
        (httpx.Response(200, json={"d": {"results": []}}), "error"),
    ],
)
def test_sap_trouble_falls_back_to_recorded(response: httpx.Response, reason: str) -> None:
    service = SapSandbox(config(sap_sandbox_api_key=KEY), transport(lambda request: response))
    result = asyncio.run(service.orders())
    assert result["source"] == "recorded" and result["reason"] == reason and result["orders"]


def test_network_failure_falls_back() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    service = SapSandbox(config(sap_sandbox_api_key=KEY), transport(down))
    assert asyncio.run(service.orders())["reason"] == "error"


def test_key_is_never_in_settings_repr() -> None:
    assert KEY.get_secret_value() not in repr(config(sap_sandbox_api_key=KEY))
