import json
from datetime import date, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import analytics
from app.analytics import BigQuery, Day, build_days, export, shop_key, summarize
from app.rescue import local_now
from app.settings import Settings
from tests.test_photo_location import located_jpeg
from tests.test_photos import app, join, upload  # noqa: F401

FIELDS = {"timezone": "Asia/Singapore", "currency": "SGD"}


def history(end: date, days: int = 40) -> list[dict[str, Any]]:
    """Chai every day: 10 on weekdays, 20 on Saturdays, $1.50 each."""
    rows = []
    for back in range(days):
        day = end - timedelta(days=back)
        quantity = 20 if day.weekday() == 5 else 10
        rows.append(
            {
                "date": day.isoformat(),
                "item": "Chai",
                "quantity": quantity,
                "revenue": quantity * 150,
            }
        )
    return rows


def test_days_count_records_and_backtest_the_forecast() -> None:
    end = date(2026, 10, 15)
    sales = history(end)
    questions = [{"created": 1792044000.0}, {"created": 1792044100.0}]  # 2026-10-15 13:20 SGT
    counters = {"2026-10-15": {"views": 7, "stamps": 3, "returning": 1}}
    days = build_days(FIELDS, sales, questions, counters, [end, end + timedelta(days=1)])
    today, empty = days
    assert (today.sales, today.items, today.questions) == (1500, 10, 2)
    assert (today.views, today.stamps, today.returning) == (7, 3, 1)
    # The weekday average trained on the 39 earlier days predicts the Thursday exactly.
    assert today.forecast == 10 and today.actual == 10
    # No record is "unknown", never zero.
    assert empty == Day(date=end + timedelta(days=1))


def test_week_and_last_week_and_forecast_error() -> None:
    end = date(2026, 10, 15)
    days = [
        Day(date=end - timedelta(days=i), sales=100, items=2, forecast=4, actual=5)
        for i in range(14)
    ]
    days[0] = Day(date=end, views=9)
    result = summarize(days, "live", FIELDS)
    assert result.yesterday.date == end and result.yesterday.views == 9
    assert result.week.sales == 600 and result.last_week.sales == 700
    assert result.week.views == 9 and result.last_week.views is None
    assert result.forecast_error == 0.2  # |4 - 5| / 5 on each scored day


def owned_shop(client: TestClient, app_: Any) -> tuple[str, str]:
    join(client)
    first = upload(client, located_jpeg(None)).json()["proposal"]
    bid = client.post(
        f"/api/v1/proposals/{first['id']}/approve", json={"digest": first["digest"]}
    ).json()["business_id"]
    [(uid, found)] = app_.state.merchant.analytics_shops(10)
    assert found == bid
    return uid, bid


def save_sales(app_: Any, uid: str, bid: str, rows: list[dict[str, Any]]) -> None:
    proposal = app_.state.merchant.prepare_sales(uid, bid, rows)
    app_.state.merchant.save_sales(uid, bid, proposal["id"], proposal["digest"])


def test_owner_analytics_live_from_records(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        uid, bid = owned_shop(client, app)
        yesterday = local_now(FIELDS).date() - timedelta(days=1)
        save_sales(app, uid, bid, history(yesterday))
        body = client.get(f"/api/v1/businesses/{bid}/analytics")
        assert body.status_code == 200, body.text
        result = body.json()
        assert result["source"] == "live" and result["currency"] == "SGD"
        assert len(result["days"]) == 14 and result["yesterday"]["date"] == yesterday.isoformat()
        assert result["yesterday"]["views"] is None  # page views only come from BigQuery
        assert result["week"]["items"] == 80  # six weekdays and one Saturday
        assert result["forecast_error"] == 0
        assert client.get("/api/v1/businesses/nope/analytics").status_code == 404


def bigquery_settings(**extra: Any) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        google_cloud_project="demo",
        analytics_backend="bigquery",
        **extra,
    )


def test_owner_analytics_from_bigquery_then_live_on_failure(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        uid, bid = owned_shop(client, app)
        yesterday = local_now(FIELDS).date() - timedelta(days=1)
        save_sales(app, uid, bid, history(yesterday))
        queries: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            queries.append(json.loads(request.content))
            names = ["date", "sales_minor", "items_sold", "questions", "page_views", "stamps"]
            names += ["returning", "forecast_units", "actual_units"]
            row = [yesterday.isoformat(), "1500", "10", None, "42", "3", None, "10", "10"]
            return httpx.Response(
                200,
                json={
                    "jobComplete": True,
                    "schema": {"fields": [{"name": n} for n in names]},
                    "rows": [{"f": [{"v": v} for v in row]}],
                },
            )

        settings = bigquery_settings()
        reader = analytics.AnalyticsReader(
            settings, BigQuery(settings, transport=httpx.MockTransport(handler))
        )
        app.state.analytics = reader
        first = client.get(f"/api/v1/businesses/{bid}/analytics").json()
        assert first["source"] == "bigquery" and first["yesterday"]["views"] == 42
        # Days before the export reached them come from the records.
        assert first["days"][0]["sales"] is not None and first["days"][0]["views"] is None
        params = {p["name"]: p["parameterValue"]["value"] for p in queries[0]["queryParameters"]}
        assert params["key"] == shop_key("demo", bid) and bid not in json.dumps(queries[0])
        client.get(f"/api/v1/businesses/{bid}/analytics")
        assert len(queries) == 1  # cached

        broken = analytics.AnalyticsReader(
            settings,
            BigQuery(settings, transport=httpx.MockTransport(lambda _: httpx.Response(503))),
        )
        app.state.analytics = broken
        fallback = client.get(f"/api/v1/businesses/{bid}/analytics").json()
        # Saturdays sell double in `history`, so the expected day total follows the calendar.
        expected = 20 * 150 if yesterday.weekday() == 5 else 10 * 150
        assert fallback["source"] == "live" and fallback["yesterday"]["sales"] == expected


async def test_export_loads_one_partition_per_day_without_names(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        uid, bid = owned_shop(client, app)
    end = date(2026, 10, 15)
    save_sales(app, uid, bid, history(end))
    loads: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    ddl: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/upload/" in request.url.path:
            parts = request.content.decode().split("--chalkboard-analytics")
            config = json.loads(parts[1].split("\r\n\r\n", 1)[1])
            data = parts[2].split("\r\n\r\n", 1)[1].strip()
            loads.append((config, [json.loads(line) for line in data.splitlines() if line]))
            return httpx.Response(
                200, json={"jobReference": {"jobId": "j1"}, "status": {"state": "DONE"}}
            )
        query = json.loads(request.content)["query"]
        if "REGEXP_EXTRACT(httpRequest.requestUrl, r'/api/v1/public/shops/" in query:
            hour = 1792040400  # 2026-10-15 12:00 SGT
            return httpx.Response(
                200,
                json={
                    "jobComplete": True,
                    "schema": {"fields": [{"name": "bid"}, {"name": "hour"}, {"name": "views"}]},
                    "rows": [{"f": [{"v": bid}, {"v": f"{hour:.3E}"}, {"v": "5"}]}],
                },
            )
        ddl.append(query)
        return httpx.Response(200, json={"jobComplete": True})

    settings = bigquery_settings()
    summary = await export(
        app.state.merchant,
        BigQuery(settings, transport=httpx.MockTransport(handler)),
        settings,
        [end - timedelta(days=1), end],
    )
    assert summary == {"shops": 1, "days": 2, "rows": 2}
    tables = [c["configuration"]["load"]["destinationTable"]["tableId"] for c, _ in loads]
    assert tables == ["shop_daily$20261014", "shop_daily$20261015"]
    assert all(c["configuration"]["load"]["writeDisposition"] == "WRITE_TRUNCATE" for c, _ in loads)
    row = loads[1][1][0]
    assert row["shop_key"] == shop_key("demo", bid) and row["page_views"] == 5
    assert (row["sales_minor"], row["items_sold"], row["forecast_units"]) == (1500, 10, 10)
    exported = json.dumps(loads)
    assert bid not in exported and uid not in exported and "Chai" not in exported
    assert len(ddl) == 3 and all("CREATE OR REPLACE VIEW" in q for q in ddl)
    assert "remoteIp" not in "".join(ddl) and "userAgent" not in "".join(ddl)


def test_export_endpoint_only_for_the_scheduler(app, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    with TestClient(app) as client:
        assert client.post("/api/v1/internal/analytics/export").status_code == 404  # not set up
        app.state.v1_settings = bigquery_settings(
            analytics_export_caller="scheduler@demo.iam.gserviceaccount.com",
            analytics_export_audience="https://example.run.app",
        )
        assert client.post("/api/v1/internal/analytics/export").status_code == 401

        from google.oauth2 import id_token

        def verify(token: str, request: Any, audience: str) -> dict[str, Any]:
            assert audience == "https://example.run.app"
            if token != "good":
                raise ValueError("bad token")
            return {"email": claims_email, "email_verified": True}

        monkeypatch.setattr(id_token, "verify_oauth2_token", verify)
        claims_email = "someone@example.com"
        bad = client.post(
            "/api/v1/internal/analytics/export", headers={"Authorization": "Bearer nope"}
        )
        assert bad.status_code == 401
        wrong = client.post(
            "/api/v1/internal/analytics/export", headers={"Authorization": "Bearer good"}
        )
        assert wrong.status_code == 403

        claims_email = "scheduler@demo.iam.gserviceaccount.com"
        ran: list[list[date]] = []

        async def fake_export(repository: Any, bigquery: Any, settings: Any, days: list[date]):
            ran.append(days)
            return {"shops": 0, "days": len(days), "rows": 0}

        monkeypatch.setattr(analytics, "export", fake_export)
        ok = client.post(
            "/api/v1/internal/analytics/export", headers={"Authorization": "Bearer good"}
        )
        assert ok.status_code == 200 and ok.json()["days"] == 2 and len(ran[0]) == 2


async def test_erasure_deletes_the_shops_rows_only_when_exported() -> None:
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"jobComplete": True})

    settings = bigquery_settings()
    reader = analytics.AnalyticsReader(
        settings, BigQuery(settings, transport=httpx.MockTransport(handler))
    )
    reader.cache["shop-1:2026-10-15"] = (1e12, [])
    await reader.forget(["shop-1", "shop-2"])
    assert reader.cache == {}
    [delete] = sent
    assert delete["query"].startswith("DELETE FROM `chalkboard_analytics.shop_daily`")
    keys = delete["queryParameters"][0]["parameterValue"]["value"]
    assert keys == f"{shop_key('demo', 'shop-1')},{shop_key('demo', 'shop-2')}"

    live = analytics.AnalyticsReader(
        Settings(_env_file=None),  # type: ignore[call-arg]
        BigQuery(settings, transport=httpx.MockTransport(handler)),
    )
    await live.forget(["shop-1"])
    assert len(sent) == 1  # nothing was exported, nothing to delete
