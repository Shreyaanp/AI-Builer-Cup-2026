"""Partner documents in and out: order create / change / forecast processed into the DB, the
goods receipt and shipping notice written in the partner's format, and Close the day."""

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import demo_supply_seed, supply_chain, supply_docs, supply_io, supply_outbound
from app.coordinator import MerchantContext, current
from app.merchant import MerchantStore
from app.supply_docs import DocLine, Party, SupplyDoc
from tests.test_photos import app, join  # noqa: F401 - shared app fixture
from tests.test_supply_chain import draft, kirana


@pytest.fixture
def shop(tmp_path: Path) -> Iterator[tuple[MerchantStore, str]]:
    store = MerchantStore(str(tmp_path / "merchant.sqlite3"))
    bid = kirana(store)
    token = current.set(MerchantContext(store, "alice", bid, []))
    try:
        yield store, bid
    finally:
        current.reset(token)


def context(store: MerchantStore, bid: str) -> dict:
    return store.context("alice", bid)


def partner_doc(
    kind: str,
    number: str,
    quantity: float,
    ref: str = "",
    item: str = "Sugar",
    delivery: str = "2026-10-21",
    buyer: str = "Harbour Café",
) -> SupplyDoc:
    return SupplyDoc(
        kind=kind,  # type: ignore[arg-type]
        number=number,
        ref=ref,
        issued="2026-10-18",
        delivery=delivery,
        currency="INR",
        buyer=Party(id="harbour", name=buyer, system="idoc"),
        supplier=Party(name="Lakshmi Kirana"),
        lines=[
            DocLine(
                line=10,
                item=item,
                buyer_code="HC-1",
                quantity=quantity,
                unit="kg",
                price=4000,
                total=4000 * round(quantity),
            )
        ],
    )


def receive(store: MerchantStore, bid: str, doc: SupplyDoc, fmt: str = "idoc") -> dict:
    raw = supply_docs.render(doc, fmt)  # type: ignore[arg-type]
    read, detected, _ = supply_docs.parse(raw, date(2026, 10, 18))
    return supply_io.process(store, bid, context(store, bid), read, detected, raw)


# --- Formats ----------------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", supply_docs.FORMATS)
@pytest.mark.parametrize("kind", supply_docs.IO_KINDS)
def test_new_kinds_round_trip_in_every_format(kind: str, fmt: str) -> None:
    doc = partner_doc(kind, "5500000301", 15, ref="4700001201")
    if kind == "RECEIPT":
        doc.lines[0].expected = 20
    text = supply_docs.render(doc, fmt)  # type: ignore[arg-type]
    back, detected, ambiguous = supply_docs.parse(text, date(2026, 10, 18))
    assert detected == fmt and not ambiguous
    assert back.kind == kind and back.number == doc.number
    assert [line.quantity for line in back.lines] == [15]
    assert back.delivery == doc.delivery
    if kind != "FORECAST" or fmt != "text":
        assert back.ref == doc.ref
    if kind == "RECEIPT":
        assert back.lines[0].expected == 20


def test_idocs_use_real_sap_message_and_basic_types() -> None:
    change = supply_docs.render(partner_doc("ORDER_CHANGE", "1", 15, ref="4700001201"), "idoc")
    assert "<IDOCTYP>ORDERS05</IDOCTYP>" in change and "<MESTYP>ORDCHG</MESTYP>" in change
    forecast = supply_docs.render(partner_doc("FORECAST", "2", 20), "idoc")
    assert "<DELFOR02>" in forecast and "<MESTYP>DELINS</MESTYP>" in forecast
    assert "E1EDK09" in forecast and "E1EDP10" in forecast and "E1EDP16" in forecast
    receipt = partner_doc("RECEIPT", "3", 15, ref="4700001201")
    receipt.lines[0].expected = 20
    pod = supply_docs.render(receipt, "idoc")
    assert "<DELVRY07>" in pod and "<MESTYP>STPPOD</MESTYP>" in pod
    assert "<GRUND>SHRT</GRUND>" in pod and "<PODMG>20</PODMG>" in pod
    asn = supply_docs.render(partner_doc("DESADV", "4", 15, ref="4700001201"), "idoc")
    assert "<DELVRY07>" in asn and "<MESTYP>DESADV</MESTYP>" in asn
    # Codes partners' systems use for the same documents.
    assert (
        supply_docs.kind_of("ordchg") == "ORDER_CHANGE"
        and supply_docs.kind_of("DELFOR") == "FORECAST"
    )


# --- Inbound: forecast → order create → order change ------------------------------------------


def test_forecast_order_and_change_are_validated_linked_and_saved(shop) -> None:
    store, bid = shop
    forecast = receive(store, bid, partner_doc("FORECAST", "FC-1", 20))
    entry = forecast["entry"]
    assert entry["kind"] == "FORECAST" and entry["status"] == "new"
    assert entry["partner"]["id"] == "harbour" and entry["partner"]["system"] == "idoc"
    assert entry["changes"][0] == {
        "code": "forecast",
        "item": "Sugar",
        "quantity": 20,
        "unit": "kg",
        "date": "2026-10-21",
    }

    created = receive(store, bid, partner_doc("ORDERS", "4700001201", 20))
    order = created["order"]
    assert created["entry"]["status"] == "new" and created["entry"]["order_id"] == order["id"]
    assert order["direction"] == "out" and order["partner"]["name"] == "Harbour Café"
    assert order["buyer"]["id"] == "harbour" and order["supplier"]["name"] == "Lakshmi Kirana"
    assert order["lines"][0]["product"] == "Sugar" and order["forecast"] == entry["id"]
    linked = store.feature_docs.get(supply_io.INBOX, f"{bid}/{entry['id']}")
    assert linked["order_id"] == order["id"]
    assert supply_outbound.chip(order, date(2026, 10, 18)) == "new"
    # Partner orders are not the shop's suppliers: no supplier rules for a buyer.
    assert supply_chain.relationship(store, bid, "harbour") is None

    changed = receive(
        store, bid, partner_doc("ORDER_CHANGE", "CH-1", 15, ref="4700001201", delivery="2026-10-22")
    )
    assert changed["entry"]["status"] == "needs_you"
    assert changed["entry"]["changes"] == [
        {"code": "quantity", "item": "Sugar", "was": 20, "now": 15, "unit": "kg"},
        {"code": "date", "was": "2026-10-21", "now": "2026-10-22"},
    ]
    order = changed["order"]
    assert order["lines"][0]["quantity"] == 20  # nothing applies before the owner accepts
    assert supply_outbound.chip(order, date(2026, 10, 18)) == "needs_you"
    board = supply_outbound.board(store, "alice", bid)
    assert [t["code"] for t in board["tasks"]] == ["accept_change"]

    order = supply_io.accept_change(store, "alice", bid, order["id"], order["version"])
    assert order["lines"][0]["quantity"] == 15 and order["delivery"] == "2026-10-22"
    assert order["total"] == 15 * 4000 and order["pending_change"] is None
    steps = [step["step"] for step in supply_outbound.timeline(order)]
    assert steps == ["created", "changed", "shipped", "closed"]
    # The same document again is recognised, not applied twice.
    again = receive(store, bid, partner_doc("ORDER_CHANGE", "CH-1", 15, ref="4700001201"))
    assert again["duplicate"]


def test_bad_documents_become_problems_not_silent_changes(shop) -> None:
    store, bid = shop
    orphan = receive(store, bid, partner_doc("ORDER_CHANGE", "CH-9", 5, ref="999"))
    assert orphan["entry"]["status"] == "problem" and orphan["entry"]["problem"] == "unknown_order"
    unknown = receive(store, bid, partner_doc("ORDERS", "4700001300", 5, item="Saffron"))
    assert unknown["entry"]["problem"] == "unknown_item"
    assert supply_outbound.chip(unknown["order"], date(2026, 10, 18)) == "problem"
    tasks = supply_outbound.board(store, "alice", bid)["tasks"]
    assert {t["problem"] for t in tasks if t["code"] == "problem"} == {
        "unknown_order",
        "unknown_item",
    }
    supply_io.dismiss(store, "alice", bid, orphan["entry"]["id"])
    tasks = supply_outbound.board(store, "alice", bid)["tasks"]
    assert [t["problem"] for t in tasks if t["code"] == "problem"] == ["unknown_item"]
    with pytest.raises(ValueError):
        supply_docs.parse("Hello, are you open today?")
    nobody = partner_doc("ORDERS", "1", 5)
    nobody.buyer = Party()
    nobody.supplier = Party()
    with pytest.raises(HTTPException) as error:
        supply_io.process(store, bid, context(store, bid), nobody, "json", "{}")
    assert error.value.detail == "UNKNOWN_PARTNER"


def test_change_after_shipping_is_too_late(shop) -> None:
    store, bid = shop
    order = receive(store, bid, partner_doc("ORDERS", "4700001201", 20))["order"]
    asn = supply_outbound.prepare_asn(store, "alice", bid, order["id"], order["version"])
    supply_outbound.send(
        store, "alice", bid, order["id"], asn["order"]["version"], asn["document"]["id"]
    )
    late = receive(store, bid, partner_doc("ORDER_CHANGE", "CH-2", 10, ref="4700001201"))
    assert late["entry"]["status"] == "problem" and late["entry"]["problem"] == "too_late"
    assert late["order"]["pending_change"] is None


# --- Outbound: shipping notice, goods receipt, Close the day -----------------------------------


def test_shipping_notice_goes_out_in_the_partners_format(shop) -> None:
    store, bid = shop
    order = receive(store, bid, partner_doc("ORDERS", "4700001201", 20))["order"]
    prepared = supply_outbound.prepare_asn(store, "alice", bid, order["id"], order["version"])
    document = prepared["document"]
    assert document["kind"] == "DESADV" and document["status"] == "pending"
    assert document["translated_format"] == "idoc"
    assert "<IDOCTYP>DELVRY07</IDOCTYP>" in document["translated"]
    assert "<BSTNR>4700001201</BSTNR>" in document["translated"]
    assert [row["kind"] for row in supply_outbound.unsent(store, bid)] == ["DESADV"]
    order = prepared["order"]
    assert supply_outbound.chip(order, date(2026, 10, 18)) == "needs_you"
    result = supply_outbound.send_all(store, "alice", bid)
    assert [row["kind"] for row in result["sent"]] == ["DESADV"] and result["unsent"] == []
    order = supply_chain.get_po(store, "alice", bid, order["id"])
    assert order["status"] == "closed" and order["shipped_at"]
    assert supply_outbound.chip(order, date(2026, 10, 18)) == "done"


def test_goods_receipt_prefills_records_shortage_and_waits_until_sent(shop) -> None:
    store, bid = shop
    incoming = partner_doc("ORDERS", "SO-1", 12, item="Sugar")
    incoming.buyer = Party(name="Lakshmi Kirana")
    incoming.supplier = Party(id="sunrise", name="Sunrise Supply", system="json")
    order = receive(store, bid, incoming, "json")["order"]
    assert order["direction"] == "in" and order["partner"]["id"] == "sunrise"
    assert supply_chain.relationship(store, bid, "sunrise")  # a supplier of the shop
    assert supply_outbound.expected(order) == {10: 12}
    result = supply_outbound.record_receipt(
        store, "alice", bid, order["id"], order["version"], {10: 7}
    )
    document = result["document"]
    assert document["kind"] == "RECEIPT" and document["status"] == "pending"
    assert document["short"] == [{"item": "Sugar", "quantity": 5, "unit": "kg"}]
    assert document["canonical"]["lines"][0]["expected"] == 12
    assert document["canonical"]["lines"][0]["quantity"] == 7
    assert result["proposal"] and result["order"]["received_stock"] == {"Sugar": 60 + 7}
    order = result["order"]
    assert order["received"] and order["status"] == "received"
    assert supply_outbound.chip(order, date(2026, 10, 18)) == "problem"  # a shortage to send
    tasks = supply_outbound.board(store, "alice", bid)["tasks"]
    assert tasks[0]["code"] == "send_receipt" and tasks[0]["short"][0]["quantity"] == 5
    # The owner corrects it: the pending receipt is replaced, not duplicated.
    result = supply_outbound.record_receipt(store, "alice", bid, order["id"], order["version"], {})
    order = result["order"]
    assert sum(d["kind"] == "RECEIPT" for d in order["documents"]) == 1
    assert result["proposal"] is None  # the stock review was prepared the first time
    order = supply_outbound.send(
        store, "alice", bid, order["id"], order["version"], result["document"]["id"]
    )
    assert order["status"] == "closed"
    assert [s["step"] for s in supply_outbound.timeline(order) if s["at"]] == [
        "created",
        "received",
        "closed",
    ]
    with pytest.raises(HTTPException):
        supply_outbound.record_receipt(store, "alice", bid, order["id"], order["version"], {})


def test_close_the_day_sends_a_receipt_for_goods_received_without_one(shop) -> None:
    store, bid = shop
    po = draft(store, bid, "Sugar", 20)["order"]
    po = supply_chain.approve(store, "alice", bid, po["id"], po["version"])
    result = supply_outbound.record_receipt(store, "alice", bid, po["id"], po["version"])
    po = result["order"]
    assert po["supplier"]["system"] in supply_docs.FORMATS
    # An order received through the older "Goods arrived" button has no receipt yet.
    po["documents"] = [d for d in po["documents"] if d["kind"] != "RECEIPT"]
    po = supply_chain._save(store, bid, po)
    assert [(r["kind"], r["doc_id"]) for r in supply_outbound.unsent(store, bid)] == [
        ("RECEIPT", None)
    ]
    sent = supply_outbound.send_all(store, "alice", bid)
    assert len(sent["sent"]) == 1 and sent["unsent"] == []
    po = supply_chain.get_po(store, "alice", bid, po["id"])
    receipt = next(d for d in po["documents"] if d["kind"] == "RECEIPT")
    assert receipt["status"] == "sent" and receipt["translated_format"] == po["supplier"]["system"]
    assert po["status"] == "received"  # the shop's own PO still waits for the invoice


def test_supplier_documents_for_a_po_go_through_the_po_loop_and_the_inbox(shop) -> None:
    import asyncio

    store, bid = shop
    po = draft(store, bid, "Sugar", 20)["order"]
    po = supply_chain.approve(store, "alice", bid, po["id"], po["version"])
    reply = supply_chain.supplier_document(store, bid, po, "ORDRSP", "full", date(2026, 10, 18))
    result = asyncio.run(
        supply_io.receive_document(store, "alice", bid, supply_docs.render(reply, "csv"))
    )
    assert result["order"]["status"] == "confirmed"
    assert result["entry"]["kind"] == "ORDRSP" and result["entry"]["order_id"] == po["id"]
    with pytest.raises(HTTPException) as error:
        asyncio.run(supply_io.receive_document(store, "alice", bid, "Hello there, any news?"))
    assert error.value.detail == "UNREADABLE_DOCUMENT"


def test_demo_partner_plays_the_story_through_the_real_pipeline(shop) -> None:
    store, bid = shop
    kinds = []
    for _ in range(3):
        kinds.append(demo_supply_seed.next_document(store, "alice", bid)["entry"]["kind"])
    assert kinds == ["FORECAST", "ORDERS", "ORDER_CHANGE"]
    with pytest.raises(HTTPException):
        demo_supply_seed.next_document(store, "alice", bid)
    board = supply_outbound.board(store, "alice", bid)
    assert board["demo"] and board["orders"][0]["partner"]["demo"]
    assert board["inbox"][0]["raw"].startswith("<?xml")


def test_routes_run_inbound_and_outbound_and_stay_owner_scoped(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        join(client)
        bid = client.post("/api/v1/supply/demo").json()["business_id"]
        base = f"/api/v1/businesses/{bid}/supply"
        for _ in range(3):
            assert client.post(f"{base}/demo/next").status_code == 200
        board = client.get(f"{base}/board").json()
        order = next(o for o in board["orders"] if o["direction"] == "out")
        assert order["chip"] == "needs_you" and board["tasks"][0]["code"] == "accept_change"
        url = f"{base}/orders/{order['id']}"
        order = client.post(f"{url}/change", json={"version": order["version"]}).json()
        assert order["chip"] == "sent" and order["timeline"][1]["step"] == "changed"
        asn = client.post(f"{url}/asn", json={"version": order["version"]}).json()
        assert asn["document"]["status"] == "pending"
        bought = next(o for o in board["orders"] if o["direction"] == "in")
        receipt = client.post(
            f"{base}/orders/{bought['id']}/receipt",
            json={"version": bought["version"], "received": [{"line": 10, "quantity": 5}]},
        )
        assert receipt.status_code == 200, receipt.text
        unsent = client.get(f"{base}/board").json()["unsent"]
        assert {row["kind"] for row in unsent} == {"DESADV", "RECEIPT"}
        sent = client.post(f"{base}/send-all").json()
        assert len(sent["sent"]) == 2 and sent["unsent"] == []
        pasted = client.post(f"{base}/inbound", json={"text": "hello there, any news?"})
        assert pasted.status_code == 422
        client.cookies.clear()
        join(client)  # another owner
        assert client.get(f"{base}/board").status_code in {403, 404}
        assert client.post(f"{base}/send-all").status_code in {403, 404}


# --- Coach chat tools (text and voice share them) -----------------------------------------------


@pytest.mark.parametrize(
    ("phrase", "amount"),
    [("5 milk", 5), ("5 l milk", 5), ("milk 5", 5), ("five milk", 5), ("paanch milk", 5)],
)
def test_spoken_quantities_find_the_order_line(phrase: str, amount: float) -> None:
    from app.supply_tools import _amounts

    po = {"lines": [{"line": 10, "item": "Sugar"}, {"line": 20, "item": "Milk", "unit": "l"}]}
    assert _amounts([phrase], po) == {20: amount}


def test_coach_runs_the_story_by_chat(app) -> None:  # noqa: F811
    import json

    from app.agent import INSTRUCTION
    from app.supply_tools import SUPPLY_TOOLS

    names = {tool.__name__ for tool in SUPPLY_TOOLS}
    assert {
        "show_inbound",
        "accept_order_change",
        "approve_and_send_po",
        "record_goods_received",
        "send_asn",
        "view_document_as_sap",
    } <= names
    assert "record_goods_received" in INSTRUCTION
    with TestClient(app) as client:
        join(client)
        bid = client.post("/api/v1/supply/demo").json()["business_id"]
        base = f"/api/v1/businesses/{bid}/supply"
        for _ in range(3):
            client.post(f"{base}/demo/next")

        def say(message: str) -> tuple[str, list[dict]]:
            response = client.post(
                "/api/v1/coach/stream", json={"message": message, "business_id": bid}
            )
            assert response.status_code == 200
            events = [
                json.loads(line.removeprefix("data: "))
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            reply = next((e["text"] for e in events if e["kind"] == "reply"), "")
            return reply, events

        reply, events = say("Show me today's inbound")
        assert "order change" in reply and "Harbour Café (Demo)" in reply
        assert any(e["kind"] == "supply" and e["data"]["view"] == "coming" for e in events)

        reply, events = say("Accept the change")
        card = next(e["data"] for e in events if e["kind"] == "supply")
        assert card["order"]["lines"][0]["quantity"] == 15 and "accepted" in reply

        milk = next(
            o for o in client.get(f"{base}/board").json()["orders"] if o["direction"] == "in"
        )
        ordered = milk["lines"][0]["quantity"]
        reply, events = say("Received everything except 5 milk")
        assert "Short: 5 litre Milk" in reply or "Short: 5 l Milk" in reply, reply
        assert "Goods receipt sent to Fresh Dairy (Demo)" in reply
        card = next(e["data"] for e in events if e["kind"] == "supply")
        receipt = next(d for d in card["order"]["documents"] if d["kind"] == "RECEIPT")
        assert receipt["status"] == "sent"
        assert receipt["canonical"]["lines"][0]["quantity"] == ordered - 5
        assert "<MESTYP>STPPOD</MESTYP>" in receipt["translated"]  # the supplier runs SAP
        assert any(e["kind"] == "proposal" for e in events)  # stock waits for the review

        reply, events = say("Send the shipping notice")
        assert "shipping notice" in reply and "sent to Harbour Café (Demo)" in reply

        reply, events = say("Show the shipping notice in SAP")
        card = next(e["data"] for e in events if e["kind"] == "supply")
        assert card["view"] == "sap" and "DELVRY07" in reply

        reply, _ = say("Send everything")
        assert "already sent" in reply
        assert client.get(f"{base}/board").json()["unsent"] == []
