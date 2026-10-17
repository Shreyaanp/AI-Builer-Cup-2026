from fastapi.testclient import TestClient

from tests.test_photos import app, join  # noqa: F401


def test_private_demo_forecast_rules_idocs_and_reviewed_restock(app) -> None:  # noqa: F811
    with TestClient(app) as client:
        join(client)
        response = client.post("/api/v1/supply/demo")
        assert response.status_code == 200, response.text
        bid = response.json()["business_id"]
        base = f"/api/v1/businesses/{bid}/supply"
        overview = client.get(base).json()
        assert overview["needs"][0]["item"] == "Milk"
        assert overview["needs"][0]["stock"] == 15
        assert len(overview["orders"]) == 1
        assert overview["orders"][0]["status"] == "sent"
        assert overview["suppliers"][0]["rules"]["system_format"] == "idoc"
        shops = client.get("/api/v1/businesses").json()
        assert next(s for s in shops if s["id"] == bid)["public"] is False
        assert client.post("/api/v1/supply/demo").json()["business_id"] == bid
        assert len(client.get(base).json()["orders"]) == 1

        po = client.post(f"{base}/reorder", json={"item": "Milk"}).json()["order"]
        assert po["status"] == "draft" and not po["sent"]
        line = po["lines"][0]
        assert line["quantity"] >= 12 and line["quantity"] % 6 == 0
        assert line["price"] == 4500 and po["reason"]["moq"] == 12
        url = f"{base}/orders/{po['id']}"

        def advance(action: str) -> dict:
            response = client.post(f"{url}/{action}", json={"version": po["version"]})
            assert response.status_code == 200, response.text
            return response.json()

        po = advance("approve")
        assert "<IDOCTYP>ORDERS05</IDOCTYP>" in po["documents"][0]["translated"]
        for status, kind in [
            ("confirmed", "ORDRSP"),
            ("dispatched", "DESADV"),
            ("invoiced", "INVOIC"),
        ]:
            po = advance("simulate")
            assert po["status"] == status
            assert po["documents"][-1]["kind"] == kind
            assert po["documents"][-1]["at"] > 0
            assert po["documents"][-1]["raw_format"] == "idoc"
        receipt = advance("received")
        po = receipt["order"]
        assert po["received"] and po["received_at"] > 0
        assert po["received_stock"] == {"Milk": 15 + line["quantity"]}
        # Receipt proposes the stock update. Only the owner's exact approval applies it.
        inventory = f"/api/v1/businesses/{bid}/inventory"
        assert client.get(inventory).json()[0]["stock"] == 15
        proposal = receipt["proposal"]
        saved = client.post(
            f"/api/v1/proposals/{proposal['id']}/approve", json={"digest": proposal["digest"]}
        )
        assert saved.status_code == 200, saved.text
        assert client.get(inventory).json()[0]["stock"] == 15 + line["quantity"]
        assert client.get(base).json()["needs"] == []
