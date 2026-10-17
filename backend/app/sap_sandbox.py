"""Real purchase orders from SAP: the SAP Business Accelerator Hub sandbox.

SAP publishes a sandbox of S/4HANA Cloud at https://sandbox.api.sap.com. With a free API key
(header `APIKey`) the Purchase Order API (`A_PurchaseOrder`, OData v2, or `PurchaseOrder`, OData
v4) returns real SAP purchase orders from SAP's shared demo tenant. This module reads them and
maps each into our canonical `SupplyDoc` (ORDERS), so the owner sees what an SAP buyer's system
holds and the same IDoc XML the simulated flow writes.

Read only: the sandbox never receives anything from the app. Behind `SUPPLY_SAP_LIVE`; switched
off, without `SAP_SANDBOX_API_KEY`, or when SAP does not answer, the recorded sandbox sample
(`supply_samples/sap-sandbox-a_purchaseorder.json`) is shown instead and labelled as recorded.
The key is read from the environment (Secret Manager in Cloud Run) and never logged.
"""

from __future__ import annotations

import json
import re
import time
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
import structlog
from pydantic import ValidationError

from .money import to_minor
from .settings import Settings
from .supply_docs import TERMS_DAYS, DocLine, Party, SupplyDoc, idoc_xml, number, unit_from_code

log = structlog.get_logger()

SAMPLE = Path(__file__).with_name("supply_samples") / "sap-sandbox-a_purchaseorder.json"
TOP = 10
TIMEOUT_SECONDS = 8
# The sandbox is shared and rate limited: one read per few minutes is plenty for a demo.
CACHE_SECONDS = 300
RETRY_SECONDS = 60
Source = Literal["live", "recorded"]
Reason = Literal["", "off", "no_key", "rejected", "error"]
QUERY = {
    "v2": {
        "path": "A_PurchaseOrder",
        "params": {
            "$top": str(TOP),
            "$expand": "to_PurchaseOrderItem/to_ScheduleLine",
            "$format": "json",
        },
    },
    "v4": {
        "path": "PurchaseOrder",
        "params": {
            "$top": str(TOP),
            "$expand": "_PurchaseOrderItem($expand=_PurchaseOrderScheduleLine)",
        },
    },
}
ODATA_DATE = re.compile(r"/Date\((-?\d+)(?:[+-]\d{4})?\)/")


def odata_date(value: Any) -> str:
    """`/Date(1491436800000)/` (v2) or `2017-04-06` (v4) as an ISO date; "" when unknown."""
    text = str(value or "").strip()
    if match := ODATA_DATE.fullmatch(text):
        return datetime.fromtimestamp(int(match.group(1)) / 1000, UTC).date().isoformat()
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return ""


def _results(value: Any) -> list[dict[str, Any]]:
    """v2 wraps collections in {"results": [...]}; v4 returns a plain list."""
    if isinstance(value, dict):
        value = value.get("results")
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _line(item: dict[str, Any], currency: str) -> tuple[DocLine, str] | None:
    """An item and its first scheduled delivery date."""
    try:
        line = int(str(item.get("PurchaseOrderItem") or "0"))
    except ValueError:
        return None
    quantity = number(item.get("OrderQuantity"))
    if not 1 <= line <= 99_990 or quantity is None or not 0 < quantity <= 1_000_000:
        return None
    code = str(item.get("PurchaseOrderQuantityUnit") or "")
    amount = number(item.get("NetPriceAmount"))
    per = number(item.get("NetPriceQuantity")) or 1
    price = None if amount is None else to_minor(amount / per, currency)
    schedule = _results(item.get("to_ScheduleLine")) or _results(
        item.get("_PurchaseOrderScheduleLine")
    )
    material = str(item.get("Material") or "")
    doc_line = DocLine(
        line=line,
        item=(str(item.get("PurchaseOrderItemText") or "") or material or f"Item {line}")[:120],
        buyer_code=material[:40],
        supplier_code=str(item.get("SupplierMaterialNumber") or "")[:40],
        quantity=quantity,
        unit=(unit_from_code(code) or code.lower() or "piece")[:20],
        price=price,
        total=None if price is None else round(price * quantity),
    )
    return doc_line, odata_date(schedule[0].get("ScheduleLineDeliveryDate")) if schedule else ""


def to_supply_doc(row: dict[str, Any]) -> SupplyDoc | None:
    """One A_PurchaseOrder (v2) or PurchaseOrder (v4) entity as our ORDERS document."""
    currency = str(row.get("DocumentCurrency") or "").upper()
    if not re.fullmatch(r"[A-Z]{3}", currency) or not row.get("PurchaseOrder"):
        return None
    items = _results(row.get("to_PurchaseOrderItem")) or _results(row.get("_PurchaseOrderItem"))
    read = [pair for item in items[:60] if (pair := _line(item, currency))]
    if not read:
        return None
    lines = [line for line, _ in read]
    delivery = min((day for _, day in read if day), default="")
    company = str(row.get("CompanyCode") or "")
    supplier = str(row.get("Supplier") or "")
    terms = TERMS_DAYS.get(str(row.get("PaymentTerms") or ""))
    note = f"SAP {row.get('PurchaseOrderType') or 'PO'} · plant {items[0].get('Plant') or '–'}"
    try:
        return SupplyDoc(
            kind="ORDERS",
            number=str(row["PurchaseOrder"])[:40],
            issued=odata_date(row.get("PurchaseOrderDate") or row.get("CreationDate")),
            delivery=delivery,
            currency=currency,
            buyer=Party(id=company[:80], name=f"SAP company code {company}"[:120], system="idoc"),
            supplier=Party(id=supplier[:80], name=f"SAP supplier {supplier}"[:120], system="idoc"),
            terms_days=terms,
            lines=lines,
            total=sum(line.total or 0 for line in lines),
            note=note[:300],
        )
    except ValidationError as error:
        log.info("sap_sandbox_row_skipped", reason=str(error)[:120])
        return None


def map_response(payload: Any) -> list[SupplyDoc]:
    """An OData v2 (`d.results`) or v4 (`value`) collection as ORDERS documents."""
    rows: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        rows = _results(payload.get("d")) or _results(payload.get("value"))
    return [doc for row in rows[:TOP] if (doc := to_supply_doc(row))]


def recorded() -> list[SupplyDoc]:
    return map_response(json.loads(SAMPLE.read_text(encoding="utf-8")))


def view(doc: SupplyDoc) -> dict[str, Any]:
    return {**doc.model_dump(mode="json"), "idoc": idoc_xml(doc)}


class SapSandbox:
    """Reads the sandbox once per few minutes; the recorded sample covers every other case."""

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport
        self.cache: tuple[float, dict[str, Any]] | None = None

    def status(self) -> Reason:
        if not self.settings.supply_sap_live:
            return "off"
        if not self.settings.sap_sandbox_api_key.get_secret_value():
            return "no_key"
        return ""

    async def orders(self) -> dict[str, Any]:
        reason = self.status()
        if reason:
            return self._answer("recorded", reason, recorded())
        if self.cache and self.cache[0] > time.monotonic():
            return self.cache[1]
        try:
            docs = await self._fetch()
            answer = self._answer("live", "", docs)
            self.cache = (time.monotonic() + CACHE_SECONDS, answer)
        except _Rejected:
            answer = self._answer("recorded", "rejected", recorded())
            self.cache = (time.monotonic() + RETRY_SECONDS, answer)
        except (httpx.HTTPError, ValueError) as error:
            log.warning("sap_sandbox_unavailable", error=type(error).__name__)
            answer = self._answer("recorded", "error", recorded())
            self.cache = (time.monotonic() + RETRY_SECONDS, answer)
        return answer

    async def _fetch(self) -> list[SupplyDoc]:
        query = QUERY[self.settings.sap_sandbox_odata]
        url = f"{self.settings.sap_sandbox_url.rstrip('/')}/{query['path']}"
        headers = {
            "APIKey": self.settings.sap_sandbox_api_key.get_secret_value(),
            "Accept": "application/json",
        }
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS, trust_env=False, transport=self.transport
        ) as client:
            reply = await client.get(url, params=query["params"], headers=headers)
        log.info("sap_sandbox_read", status=reply.status_code)
        if reply.status_code in {401, 403}:
            raise _Rejected
        reply.raise_for_status()
        docs = map_response(reply.json())
        if not docs:
            raise ValueError("No purchase orders in the sandbox reply.")
        return docs

    @staticmethod
    def _answer(source: Source, reason: Reason, docs: list[SupplyDoc]) -> dict[str, Any]:
        return {
            "source": source,
            "reason": reason,
            "fetched_at": time.time(),
            "orders": [view(doc) for doc in docs],
        }


class _Rejected(Exception):
    """SAP refused the key (401/403)."""
