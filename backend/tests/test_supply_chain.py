"""Supply chain: rules, forecast-drafted POs, the document flow and the format translators."""

import asyncio
import json
import os
from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.adk.sessions import InMemorySessionService

from app import supply_chain, supply_docs
from app.coordinator import DEMO_OWNER_UID, MerchantContext, SupplierGenerator, current
from app.forecast import ForecastService
from app.gemini_schema import gemini_schema
from app.main import create_app
from app.merchant import BusinessFields, MerchantStore, ProductFields, ProposalRequest
from app.sales import today_for
from app.settings import Settings
from app.supply_docs import DocLine, Party, SupplyDoc
from app.supply_rules import (
    ItemRule,
    PriceTier,
    RuleChange,
    RuleSet,
    apply_change,
    evaluate,
    round_quantity,
    tier_price,
)
from tests.test_merchant_routes import approve, settings  # noqa: F401 - shared fixture
from tests.test_photos import join

SAMPLES = Path(__file__).resolve().parents[1] / "app" / "supply_samples"
BENGALURU = (12.9716, 77.5946)
EMULATOR = (os.getenv("FIRESTORE_EMULATOR_HOST") or "").split(":")[0] in {"127.0.0.1", "localhost"}


def offline() -> Settings:
    return Settings(_env_file=None, coach_mode="offline", app_env="test")  # type: ignore[call-arg]


def kirana(store: MerchantStore, uid: str = "alice") -> str:
    proposal = store.propose(
        uid,
        ProposalRequest(
            kind="business",
            business=BusinessFields(
                name="Lakshmi Kirana",
                category="Grocery",
                location="Indiranagar, Bengaluru",
                lat=BENGALURU[0],
                lng=BENGALURU[1],
                currency="INR",
                timezone="Asia/Kolkata",
                phone="+91 98450 00000",
            ),
            products=[
                ProductFields(name="Atta (wheat flour)", price=5500, unit="kg", stock=6),
                ProductFields(name="Sugar", price=4800, unit="kg", stock=60),
            ],
        ),
    )
    bid = store.commit(uid, proposal["id"], proposal["digest"])["business_id"]
    today = today_for(store.context(uid, bid)["business"]["fields"])
    rows = [
        {
            "date": (today - timedelta(days=i)).isoformat(),
            "item": item,
            "quantity": quantity,
            "revenue": quantity * price,
        }
        for i in range(1, 29)
        for item, quantity, price in (("Atta (wheat flour)", 3, 5500), ("Sugar", 2, 4800))
    ]
    prepared = store.prepare_sales(uid, bid, rows)
    store.save_sales(uid, bid, prepared["id"], prepared["digest"])
    return bid


@pytest.fixture
def shop(tmp_path: Path) -> Iterator[tuple[MerchantStore, str]]:
    store = MerchantStore(str(tmp_path / "merchant.sqlite3"))
    bid = kirana(store)
    token = current.set(MerchantContext(store, "alice", bid, []))
    try:
        yield store, bid
    finally:
        current.reset(token)


def draft(store: MerchantStore, bid: str, item: str = "", quantity: float | None = None) -> dict:
    return asyncio.run(
        supply_chain.draft_reorder(
            store,
            "alice",
            bid,
            item,
            quantity,
            ForecastService(offline()),
            SupplierGenerator(offline()),
            DEMO_OWNER_UID,
        )
    )


def sample_doc(kind: str) -> SupplyDoc:
    back = kind == "ORDRSP"
    return SupplyDoc(
        kind=kind,  # type: ignore[arg-type]
        number="4500012345" if kind == "ORDERS" else "7100004501",
        ref="" if kind == "ORDERS" else "4500012345",
        issued="2026-10-16",
        delivery="2026-10-18",
        currency="INR",
        buyer=Party(id="shop1", name="Lakshmi Kirana", system="json"),
        supplier=Party(id="sup1", name="Shree Ganesh Wholesale", system="idoc"),
        terms_days=7 if kind in {"ORDERS", "ORDRSP", "INVOIC"} else None,
        lines=[
            DocLine(
                line=10,
                item="Wheat flour",
                buyer_code="CB-ATT-01",
                supplier_code="MAT-100234",
                quantity=15 if back else 20,
                unit="kg",
                price=6200,
                total=6200 * (15 if back else 20),
                status="backordered" if back else "accepted",
                backorder_quantity=5 if back else 0,
                backorder_date="2026-10-21" if back else "",
            ),
            DocLine(
                line=20,
                item="Sugar",
                supplier_code="MAT-100877",
                quantity=10,
                unit="kg",
                price=4400,
                total=44000,
            ),
        ],
        total=(15 if back else 20) * 6200 + 44000 if kind != "DESADV" else None,
    )


# --- Translators ------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", supply_docs.KINDS)
def test_idoc_has_real_segment_structure_and_round_trips(kind: str) -> None:
    doc = sample_doc(kind)
    xml = supply_docs.render(doc, "idoc")
    basic = {"ORDERS": "ORDERS05", "ORDRSP": "ORDERS05", "DESADV": "DELVRY07"}.get(kind, "INVOIC02")
    assert xml.startswith('<?xml version="1.0"') and f"<{basic}>" in xml
    assert '<EDI_DC40 SEGMENT="1">' in xml and f"<MESTYP>{kind}</MESTYP>" in xml
    expected = {
        "ORDERS": ["E1EDK01", "E1EDK03", "E1EDKA1", "E1EDP01", "E1EDP19", "E1EDP20", "E1EDS01"],
        "ORDRSP": ["E1EDK02", "<ACTION>002</ACTION>", "E1EDP20"],
        "DESADV": ["E1EDL20", "E1EDT13", "E1EDL24", "E1EDL41", "<VRKME>KGM</VRKME>"],
        "INVOIC": ["E1EDK18", "E1EDP26", "<SUMID>011</SUMID>", "<ZTERM>NT07</ZTERM>"],
    }[kind]
    for segment in expected:
        assert segment in xml
    back, fmt, ambiguous = supply_docs.parse(xml)
    assert fmt == "idoc" and not ambiguous
    assert back.kind == kind and back.number == doc.number and back.ref == doc.ref
    assert back.delivery == doc.delivery
    assert [line.quantity for line in back.lines] == [line.quantity for line in doc.lines]
    assert {supply_docs.unit_from_code(line.unit) for line in back.lines} == {"kg"}
    if kind != "DESADV":
        assert [line.price for line in back.lines] == [6200, 4400]
        assert back.total == doc.total and back.terms_days == 7
    if kind == "ORDRSP":
        assert back.lines[0].status == "backordered"
        assert (back.lines[0].backorder_quantity, back.lines[0].backorder_date) == (
            5,
            "2026-10-21",
        )


@pytest.mark.parametrize("fmt", ["csv", "text", "json"])
@pytest.mark.parametrize("kind", supply_docs.KINDS)
def test_other_formats_round_trip(kind: str, fmt: str) -> None:
    doc = sample_doc(kind)
    text = supply_docs.render(doc, fmt)  # type: ignore[arg-type]
    back, detected, ambiguous = supply_docs.parse(text, date(2026, 10, 16))
    assert detected == fmt and not ambiguous
    assert back.kind == kind and back.number == doc.number
    assert [line.quantity for line in back.lines] == [line.quantity for line in doc.lines]
    assert back.delivery == doc.delivery
    if kind == "ORDRSP":
        assert back.lines[0].status == "backordered"
        assert back.lines[0].backorder_quantity == 5
        assert back.lines[0].backorder_date == "2026-10-21"
    if kind != "DESADV":
        assert [line.price for line in back.lines] == [6200, 4400]


def test_review_flags_units_dates_codes_and_totals() -> None:
    message = (
        "*Order confirmation OC-5521*\nRef PO 4500012345\n"
        "1) Atta chakki fresh 15 BAG @ INR 62.00\n2) Sugar [MAT-100877] 10 kg @ INR 44.00\n"
        "Delivery: 05/11\nTotal INR 9,999.00\nPayment: 7 days"
    )
    doc, fmt, ambiguous = supply_docs.parse(message, date(2026, 10, 16))
    assert fmt == "text" and ambiguous == ["delivery"]
    po = {
        "lines": [
            {"line": 10, "item": "Wheat flour", "supplier_code": "MAT-100234", "unit": "kg"},
            {"line": 20, "item": "Sugar", "supplier_code": "MAT-100877", "unit": "kg"},
        ]
    }
    doc, flags = supply_docs.review(doc, po, ambiguous)
    reasons = {flag.field: flag for flag in flags}
    assert reasons["line:10:unit"].value == "BAG" and "kg" in reasons["line:10:unit"].options
    assert reasons["line:10:item_code"].options[0] == "Wheat flour"
    assert set(reasons["delivery"].options) == {"2026-11-05", "2026-05-11"}
    assert reasons["total"].reason == "total"
    assert "line:20:item_code" not in reasons  # the supplier code is certain
    assert doc.lines[1].unit == "kg" and doc.terms_days == 7


def test_unsafe_or_foreign_documents_are_refused() -> None:
    with pytest.raises(ValueError):
        supply_docs.parse('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')
    with pytest.raises(ValueError):
        supply_docs.parse(
            "<ORDERS05><IDOC><EDI_DC40><MESTYP>MATMAS</MESTYP></EDI_DC40></IDOC></ORDERS05>"
        )
    with pytest.raises(ValueError):
        supply_docs.parse("Hello, are you open today?")
    with pytest.raises(ValueError):
        supply_docs.parse("x" * (supply_docs.MAX_TEXT + 1))


def test_shipped_samples_parse_with_flags_where_real_files_are_messy() -> None:
    files = sorted(SAMPLES.iterdir())
    assert {f.suffix for f in files} >= {".xml", ".csv", ".txt"}
    for path in files:
        doc, _, _ = supply_docs.parse(path.read_text(encoding="utf-8"), date(2026, 10, 16))
        assert doc.lines and doc.kind in supply_docs.KINDS, path.name
    messy, _, ambiguous = supply_docs.parse(
        (SAMPLES / "ordrsp-whatsapp-messy.txt").read_text(encoding="utf-8"), date(2026, 10, 16)
    )
    _, flags = supply_docs.review(
        messy, {"lines": [{"line": 10, "item": "Wheat flour", "unit": "kg"}]}, ambiguous
    )
    assert {flag.reason for flag in flags} >= {"date", "unit"}


def test_ai_reader_schema_is_accepted_by_gemini_and_flags_are_merged(monkeypatch) -> None:
    schema = json.dumps(gemini_schema(supply_docs.Reading))
    assert "minItems" not in schema and "maxItems" not in schema
    translator = supply_docs.DocumentTranslator(
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            coach_mode="gemini",
            app_env="test",
            google_text_model="gemini-test",
            google_live_model="gemini-live-test",
            google_cloud_project="demo-ogoogle-local",
        )
    )

    async def fake(text, po, today):
        doc = sample_doc("ORDRSP")
        return doc, [
            supply_docs.flag("line:20:quantity", "quantity", "10", ["10", "8"], 20),
            supply_docs.flag("line:10:unit", "unit", "KGM", ["kg"], 10),
            supply_docs.flag("terms_days", "terms", "NT07", ["7"], None),
        ]

    monkeypatch.setattr(translator, "_gemini", fake)
    po = {"lines": [{"line": 10, "item": "Wheat flour", "supplier_code": "MAT-100234"}]}
    doc, flags, reader, _ = asyncio.run(translator.read("anything at all", po, date.today()))
    assert reader == "gemini" and any(f.field == "line:20:quantity" for f in flags)
    # KGM is certainly kg and NT07 seven days net: no tap needed.
    assert not any(f.field in {"line:10:unit", "terms_days"} for f in flags)

    async def broken(text, po, today):
        raise RuntimeError("provider down")

    monkeypatch.setattr(translator, "_gemini", broken)
    xml = supply_docs.render(sample_doc("ORDRSP"), "idoc")
    doc, flags, reader, fmt = asyncio.run(translator.read(xml, po, date.today()))
    assert (reader, fmt) == ("parser", "idoc") and doc.kind == "ORDRSP"

    async def slow(text, po, today):
        await asyncio.sleep(5)

    monkeypatch.setattr(translator, "_gemini", slow)
    monkeypatch.setattr(supply_docs, "AI_READ_SECONDS", 0.05)
    doc, flags, reader, fmt = asyncio.run(translator.read(xml, po, date.today()))
    assert (reader, fmt) == ("parser", "idoc") and doc.kind == "ORDRSP"


# --- Rules ------------------------------------------------------------------------------------


def flour_rule(**changes) -> ItemRule:
    return ItemRule(
        item="Wheat flour",
        moq=10,
        pack=5,
        lead_days=2,
        tiers=[PriceTier(min_quantity=25, price=6000), PriceTier(min_quantity=50, price=5700)],
        **changes,
    )


def test_tiers_moq_and_pack_rounding() -> None:
    rule = flour_rule()
    assert round_quantity(rule, 3) == 10 and round_quantity(rule, 11) == 15
    assert round_quantity(rule, 25) == 25
    assert tier_price(rule, 20, 6200) == 6200
    assert tier_price(rule, 25, 6200) == 6000 and tier_price(rule, 80, 6200) == 5700


def test_evaluate_names_every_broken_rule_with_a_fix() -> None:
    rules = RuleSet(terms_days=7, credit_limit=100_000, approval_over=50_000, items=[flour_rule()])
    po = {
        "lines": [
            {"line": 10, "item": "Wheat flour", "quantity": 4, "price": 6200, "total": 24800}
        ],
        "total": 24800,
        "need_by": "2026-10-17",
        "faster_supplier": "sup-2",
    }
    checks = {c.code: c for c in evaluate(po, rules, 90_000, False, date(2026, 10, 16))}
    assert checks["below_moq"].fix == {"kind": "quantity", "line": 10, "value": 10}
    assert checks["late"].fix == {"kind": "supplier", "value": "sup-2"}
    assert checks["over_credit"].values["headroom"] == 10_000
    assert checks["over_credit"].fix == {"kind": "cash"}  # 10,000 buys less than the MOQ
    assert "new_supplier" in checks and not checks["new_supplier"].blocking
    assert "over_approval" not in checks
    cash = RuleSet(terms_days=0, credit_limit=1, approval_over=50_000, items=[flour_rule()])
    assert "over_credit" not in {c.code for c in evaluate(po, cash, 10**9, True, date.today())}


def test_rule_changes_validate_and_need_an_item_for_item_rules() -> None:
    rules = RuleSet(items=[flour_rule()])
    changed = apply_change(
        rules,
        RuleChange(terms_days=30, credit_limit=20000, item="atta", moq=20, substitutes=["Maida"]),
        "INR",
    )
    assert changed.terms_days == 30 and changed.credit_limit == 2_000_000
    assert changed.items[0].moq == 20 and changed.items[0].substitutes == ["Maida"]
    with pytest.raises(ValueError, match="item"):
        apply_change(rules, RuleChange(moq=5), "INR")
    with pytest.raises(ValueError, match="tier_price"):
        apply_change(rules, RuleChange(item="flour", tier_quantity=50), "INR")
    with pytest.raises(ValueError):
        RuleSet(items=[flour_rule(), flour_rule()])


# --- Forecast → PO → ORDRSP → DESADV → INVOIC ---------------------------------------------------


def test_forecast_drafts_a_po_to_the_best_supplier_with_the_reason(shop) -> None:
    store, bid = shop
    result = draft(store, bid)
    assert result["status"] == "drafted"
    po = result["order"]
    reason = po["reason"]
    assert reason["item"] == "Atta (wheat flour)" and reason["stock"] == 6
    assert reason["method"] == "weekday_average" and reason["runs_out"]
    line = po["lines"][0]
    rules = supply_chain.rules_of(supply_chain.relationship(store, bid, po["supplier"]["id"]))
    rule = next(r for r in rules.items if r.item == line["item"])
    assert line["quantity"] >= max(rule.moq, reason["wanted"]) and line["quantity"] % rule.pack == 0
    assert line["price"] == tier_price(rule, line["quantity"], line["list_price"])
    assert po["number"] == "4500012345" and po["status"] == "draft"
    assert po["approval_required"] and not po["auto_sent"]
    assert "new_supplier" in {c["code"] for c in po["checks"]}
    assert len(po["alternatives"]) >= 2
    assert po["supplier"]["demo"] and po["simulated"]
    # Every relationship got editable starting rules; demo suppliers run different systems.
    rows = supply_chain.relationships(store, "alice", bid)
    assert {row["rules"]["system_format"] for row in rows} >= {"idoc", "csv", "text"}
    assert draft(store, bid)["order"]["number"] == "4500012346"


def run_loop(store: MerchantStore, bid: str, system: str) -> dict:
    po = draft(store, bid, "atta")["order"]
    row = supply_chain.relationship(store, bid, po["supplier"]["id"])
    rules = supply_chain.rules_of(row).model_copy(update={"system_format": system})
    supply_chain.save_rules(store, "alice", bid, po["supplier"]["id"], rules, row["version"])
    po = supply_chain.cancel(store, "alice", bid, po["id"], po["version"])
    po = draft(store, bid, "atta")["order"]
    assert po["supplier"]["system"] == system
    if po["blocked"]:
        fix = next(c["fix"] for c in po["checks"] if c["blocking"] and c["fix"])
        po = supply_chain.apply_fix(store, "alice", bid, po["id"], po["version"], fix)
    po = supply_chain.approve(store, "alice", bid, po["id"], po["version"])
    sent = po["documents"][0]
    assert (sent["kind"], sent["from"], sent["translated_format"]) == ("ORDERS", "buyer", system)
    assert po["number"] in sent["translated"] and po["status"] == "sent"
    po = asyncio.run(supply_chain.simulate(store, "alice", bid, po["id"], po["version"], "partial"))
    ordrsp = po["documents"][-1]
    assert (ordrsp["kind"], ordrsp["raw_format"], ordrsp["reader"]) == ("ORDRSP", system, "parser")
    assert po["status"] == "changed" and po["changes"][0]["code"] == "partial"
    for open_flag in [f for f in ordrsp["flags"] if f["resolved"] is None]:
        po = supply_chain.resolve_flag(
            store, "alice", bid, po["id"], po["version"], open_flag["id"], open_flag["options"][0]
        )
    po = supply_chain.accept(store, "alice", bid, po["id"], po["version"])
    assert po["status"] == "confirmed" and po["backorders"][0]["quantity"] > 0
    line = po["lines"][0]
    assert line["confirmed"] + line["backorder_quantity"] == line["quantity"]
    po = asyncio.run(supply_chain.simulate(store, "alice", bid, po["id"], po["version"], "full"))
    assert po["status"] == "dispatched" and po["documents"][-1]["kind"] == "DESADV"
    assert po["lines"][0]["shipped"] == line["confirmed"]
    received = supply_chain.receive(store, "alice", bid, po["id"], po["version"])
    po = received["order"]
    assert po["status"] == "received" and received["proposal"]
    stock = {p["name"]: p["stock"] for p in received["proposal"]["snapshot"]["products"]}
    assert stock["Atta (wheat flour)"] == 6 + round(line["confirmed"])
    po = asyncio.run(
        supply_chain.simulate(store, "alice", bid, po["id"], po["version"], "price_mismatch")
    )
    assert po["status"] == "invoiced" and po["match"][0]["code"] == "price"
    with pytest.raises(HTTPException) as refused:
        supply_chain.accept(store, "alice", bid, po["id"], po["version"])
    assert refused.value.detail == "RESOLVE_FLAGS"
    price_flag = next(f for f in po["documents"][-1]["flags"] if f["reason"] == "price")
    agreed = price_flag["options"][0]
    po = supply_chain.resolve_flag(
        store, "alice", bid, po["id"], po["version"], price_flag["id"], agreed
    )
    assert po["disputed"] and po["lines"][0]["invoiced_price"] == int(agreed)
    po = supply_chain.accept(store, "alice", bid, po["id"], po["version"])
    assert po["status"] == "closed"
    assert [d["kind"] for d in po["documents"]] == ["ORDERS", "ORDRSP", "DESADV", "INVOIC"]
    return po


@pytest.mark.parametrize("system", ["idoc", "csv", "text", "json"])
def test_full_loop_translates_every_document_both_ways(shop, system: str) -> None:
    store, bid = shop
    po = run_loop(store, bid, system)
    if system == "idoc":
        assert "<MESTYP>ORDERS</MESTYP>" in po["documents"][0]["translated"]
        assert "<IDOCTYP>DELVRY07</IDOCTYP>" in po["documents"][2]["raw"]
        assert po["documents"][1]["translated"].lstrip().startswith("{")


def test_substitute_outside_the_rules_is_called_out(shop) -> None:
    store, bid = shop
    po = draft(store, bid, "atta")["order"]
    if po["blocked"]:
        fix = next(c["fix"] for c in po["checks"] if c["blocking"] and c["fix"])
        po = supply_chain.apply_fix(store, "alice", bid, po["id"], po["version"], fix)
    po = supply_chain.approve(store, "alice", bid, po["id"], po["version"])
    po = asyncio.run(
        supply_chain.simulate(store, "alice", bid, po["id"], po["version"], "substitute")
    )
    assert po["changes"][0]["code"] == "substitute_not_allowed"
    assert po["lines"][0]["substitute"].endswith("(other brand)")


def test_wrong_document_or_order_is_refused(shop) -> None:
    store, bid = shop
    po = draft(store, bid, "atta")["order"]
    with pytest.raises(HTTPException):
        asyncio.run(supply_chain.simulate(store, "alice", bid, po["id"], po["version"], "full"))
    if not po["blocked"]:
        po = supply_chain.approve(store, "alice", bid, po["id"], po["version"])
        invoice = supply_docs.render(sample_doc("INVOIC"), "idoc")
        with pytest.raises(HTTPException) as wrong:
            asyncio.run(supply_chain.inbound(store, "alice", bid, po["id"], po["version"], invoice))
        assert wrong.value.detail == "EXPECTED_ORDRSP"
        with pytest.raises(HTTPException) as stale:
            supply_chain.cancel(store, "alice", bid, po["id"], po["version"] - 1)
        assert stale.value.status_code == 409
    with pytest.raises(HTTPException):
        supply_chain.get_po(store, "mallory", bid, po["id"])


def test_auto_send_only_when_enabled_known_supplier_and_under_the_limit(shop) -> None:
    store, bid = shop
    first = draft(store, bid, "sugar", 10)["order"]
    sid = first["supplier"]["id"]
    if first["blocked"]:
        fix = next(c["fix"] for c in first["checks"] if c["blocking"] and c["fix"])
        first = supply_chain.apply_fix(store, "alice", bid, first["id"], first["version"], fix)
    supply_chain.approve(store, "alice", bid, first["id"], first["version"])
    row = supply_chain.relationship(store, bid, sid)
    rules = supply_chain.rules_of(row)
    assert not draft(store, bid, "sugar", 10)["order"]["auto_sent"]  # auto-send is off
    rules = rules.model_copy(update={"auto_send": True, "approval_over": 10**9, "credit_limit": 0})
    row = supply_chain.relationship(store, bid, sid)
    supply_chain.save_rules(store, "alice", bid, sid, rules, row["version"])
    second = draft(store, bid, "sugar", 10)["order"]
    assert second["supplier"]["id"] == sid and second["auto_sent"] and second["status"] == "sent"


def test_credit_fix_and_coach_rule_change_need_the_owners_tap(shop) -> None:
    store, bid = shop
    po = draft(store, bid, "atta", 400)["order"]
    credit = next((c for c in po["checks"] if c["code"] == "over_credit"), None)
    if credit:
        po = supply_chain.apply_fix(store, "alice", bid, po["id"], po["version"], credit["fix"])
        assert "over_credit" not in {c["code"] for c in po["checks"]}
    sid = po["supplier"]["id"]
    row = supply_chain.propose_rules(
        store, "alice", bid, sid, RuleChange(item="atta", moq=50, backorder_ok=False)
    )
    assert row["pending"] and supply_chain.rules_of(row).items[0].moq != 50
    row = supply_chain.confirm_rules(store, "alice", bid, sid, row["version"], True)
    rule = next(r for r in supply_chain.rules_of(row).items if "flour" in r.item.casefold())
    assert rule.moq == 50 and not rule.backorder_ok and row["pending"] is None


def test_erasure_removes_supply_records(shop) -> None:
    store, bid = shop
    draft(store, bid)
    assert store.feature_docs.scoped("supply_po", bid)
    store.erase_owner("alice")
    for kind in ("supply_po", "supply_rules", "supply_seq"):
        assert not store.feature_docs.scoped(kind, bid)


# --- HTTP and the coach ---------------------------------------------------------------------------


@pytest.fixture(params=["sqlite", "firestore"])
def client(request: pytest.FixtureRequest, settings):  # noqa: F811
    if request.param == "firestore":
        if not EMULATOR:
            pytest.skip("Requires the explicitly local Firestore emulator; never a cloud database.")
        settings = settings.model_copy(
            update={
                "merchant_backend": "firestore",
                "google_cloud_project": "demo-ogoogle-local",
                "firestore_namespace": "ogoogle_ai_test_" + uuid4().hex,
            }
        )
    with TestClient(create_app(settings, InMemorySessionService())) as test_client:
        join(test_client)
        yield test_client


def http_shop(client: TestClient) -> str:
    proposal = client.post(
        "/api/v1/proposals",
        json={
            "kind": "business",
            "business": {
                "name": "Lakshmi Kirana",
                "category": "Grocery",
                "currency": "INR",
                "timezone": "Asia/Kolkata",
                "lat": BENGALURU[0],
                "lng": BENGALURU[1],
            },
            "products": [{"name": "Atta (wheat flour)", "price": 5500, "unit": "kg", "stock": 6}],
        },
    ).json()
    bid = approve(client, proposal)["business_id"]
    today = date.fromisoformat(client.get(f"/api/v1/businesses/{bid}/freshness").json()["today"])
    rows = "\n".join(
        f"{(today - timedelta(days=i)).isoformat()},Atta (wheat flour),3,165" for i in range(1, 29)
    )
    imported = client.post(
        f"/api/v1/businesses/{bid}/import",
        content=f"Date,Item,Qty,Revenue\n{rows}",
        headers={"Content-Type": "text/csv"},
    ).json()
    saved = client.post(
        f"/api/v1/businesses/{bid}/import/{imported['import_id']}/approve",
        json={"digest": imported["digest"]},
    )
    assert saved.status_code == 200
    return bid


def test_routes_run_the_loop_and_stay_owner_scoped(client) -> None:
    bid = http_shop(client)
    base = f"/api/v1/businesses/{bid}/supply"
    po = client.post(f"{base}/reorder", json={}).json()["order"]
    assert po["reason"]["item"] == "Atta (wheat flour)"
    url = f"{base}/orders/{po['id']}"
    for check in [c for c in po["checks"] if c["blocking"] and c["fix"]][:1]:
        po = client.post(f"{url}/fix", json={"version": po["version"], "fix": check["fix"]}).json()
    po = client.post(f"{url}/approve", json={"version": po["version"]}).json()
    assert po["status"] == "sent"
    stale = client.post(f"{url}/approve", json={"version": 1})
    assert stale.status_code == 409
    po = client.post(f"{url}/simulate", json={"version": po["version"], "variant": "full"}).json()
    assert po["status"] in {"confirmed", "changed"}
    overview = client.get(base).json()
    assert overview["orders"][0]["id"] == po["id"] and overview["suppliers"]
    row = next(s for s in overview["suppliers"] if s["supplier"]["id"] == po["supplier"]["id"])
    rules = {**row["rules"], "terms_days": 30}
    saved = client.put(
        f"{base}/suppliers/{row['supplier']['id']}/rules",
        json={"version": row["version"], "rules": rules},
    )
    assert saved.status_code == 200 and saved.json()["rules"]["terms_days"] == 30
    bad = client.put(
        f"{base}/suppliers/{row['supplier']['id']}/rules",
        json={"version": saved.json()["version"], "rules": {**rules, "terms_days": 45}},
    )
    assert bad.status_code == 422
    garbage = client.post(
        f"{url}/inbound", json={"version": po["version"], "text": "hello there, any news?"}
    )
    assert garbage.status_code in {409, 422}
    client.cookies.clear()
    join(client)  # a different local workspace (another owner)
    assert client.get(base).status_code in {403, 404}
    assert client.get(url).status_code in {403, 404}


def test_coach_drafts_reorders_and_rule_changes_as_cards(settings) -> None:  # noqa: F811
    with TestClient(create_app(settings, InMemorySessionService())) as client:
        join(client)
        bid = http_shop(client)

        def stream(message: str) -> list[dict]:
            response = client.post(
                "/api/v1/coach/stream", json={"message": message, "business_id": bid}
            )
            assert response.status_code == 200
            return [
                json.loads(line.removeprefix("data: "))
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]

        events = stream("Reorder atta")
        order = next(e["data"] for e in events if e["kind"] == "purchase_order")
        reply = next(e["text"] for e in events if e["kind"] == "reply")
        assert order["number"] in reply and "Approve" in reply
        events = stream("MOQ for atta is 20 kg and 30 days credit please")
        card = next(e["data"] for e in events if e["kind"] == "supply_rules")
        assert (
            card["pending"]["change"]["moq"] == 20 and card["pending"]["change"]["terms_days"] == 30
        )
        events = stream("Where is my flour order?")
        assert "PO 4500012345" in next(e["text"] for e in events if e["kind"] == "reply")


def test_sap_sandbox_route_shows_the_recorded_sample_when_off(client) -> None:
    bid = http_shop(client)
    answer = client.get(f"/api/v1/businesses/{bid}/supply/sap-sandbox").json()
    assert answer["source"] == "recorded" and answer["reason"] == "off"
    assert answer["orders"] and "<IDOC" in answer["orders"][0]["idoc"]
