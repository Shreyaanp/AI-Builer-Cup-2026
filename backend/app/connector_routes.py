"""Private, owner-scoped external system connector routes.

Provides endpoints to:
1. Analyze external system exports/samples (CSV, XLSX, JSON, XML) and produce an AI mapping.
2. Save confirmed mappings per shop + source system.
3. List saved mappings with last synced timestamps.
4. Sync data using saved mappings, producing reviewable proposals (never silent writes).
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .connector import (
    TARGET_FIELDS,
    ConnectorMapping,
    ConnectorResult,
    ai_map_fields,
    apply_mapping,
    compute_diff,
    parse_any,
    preview_mapped,
)
from .imports import (
    MAX_BYTES as MAX_IMPORT_BYTES,
)
from .imports import (
    ImportRejected,
    menu_items,
    sales_summary,
)
from .limits import enforce_limits
from .merchant import ProductFields, ProposalRequest
from .merchant_routes import consented_owner, owner, store
from .money import to_minor
from .pos_presets import detect_preset, prepare_rows, preset_mapping
from .product_categories import suggest_category
from .region import shop_currency
from .sales import daily_sales

router = APIRouter(prefix="/api/v1/businesses/{business_id}/connect")


def validate_mapping(mapping: ConnectorMapping, headers: list[str] | None = None) -> None:
    """Reject incomplete or ambiguous owner-confirmed mappings before an import is prepared."""
    targets = [field.target_field for field in mapping.fields]
    sources = [field.source_field for field in mapping.fields]
    if any(not source.strip() or len(source) > 180 for source in sources):
        raise HTTPException(422, "INVALID_MAPPING")
    if any(target not in (*TARGET_FIELDS, "none") for target in targets):
        raise HTTPException(422, "INVALID_MAPPING")
    active_targets = [target for target in targets if target != "none"]
    if len(set(active_targets)) != len(active_targets) or len(set(sources)) != len(sources):
        raise HTTPException(422, "INVALID_MAPPING")
    roles = set(active_targets)
    required = {"name", "price"} if mapping.kind == "menu" else {"name", "date"}
    if mapping.kind == "sales" and not ("total" in roles or "price" in roles):
        raise HTTPException(422, "INVALID_MAPPING")
    if not required.issubset(roles):
        raise HTTPException(422, "INVALID_MAPPING")
    if headers is not None and any(source not in headers for source in sources):
        raise HTTPException(422, "INVALID_MAPPING")


class SampleAnalyzeRequest(BaseModel):
    source_label: str = Field(default="Custom POS", description="Name of external system")
    content: str = Field(description="Raw text content of the export or pasted sample")
    content_type: str = Field(default="text/csv", description="MIME type or format hint")


class SyncRequest(BaseModel):
    source_label: str = Field(default="Custom POS")
    content: str | None = None
    content_type: str = "text/csv"
    mapping: ConnectorMapping | None = None


@router.get("/mappings")
async def list_mappings(business_id: str, request: Request) -> list[dict[str, Any]]:
    """List all saved connector mappings for this business."""
    uid = await owner(request)
    service = store(request)
    return await anyio.to_thread.run_sync(service.list_connector_mappings, uid, business_id)


@router.post("/mapping")
async def save_mapping(
    business_id: str, body: ConnectorMapping, request: Request
) -> dict[str, Any]:
    """Save or update a confirmed column mapping for this business and source system."""
    uid = await consented_owner(request)
    await enforce_limits(request, [("import", uid)])
    validate_mapping(body)
    service = store(request)
    confirmed_data = body.model_dump()
    confirmed_data["confirmed"] = True
    return await anyio.to_thread.run_sync(
        service.save_connector_mapping, uid, business_id, confirmed_data
    )


async def _read_payload(request: Request) -> tuple[bytes, str, str]:
    """Extract raw bytes, content_type, and source_label from request."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    source_label = request.headers.get("x-source-label") or request.query_params.get(
        "source_label", ""
    )

    buffer = bytearray()
    async with asyncio.timeout(120):
        async for chunk in request.stream():
            if len(buffer) + len(chunk) > MAX_IMPORT_BYTES:
                raise HTTPException(413, "FILE_TOO_LARGE")
            buffer.extend(chunk)
    data = bytes(buffer)

    if content_type == "application/json":
        try:
            body = json.loads(data)
            if isinstance(body, dict) and "content" in body:
                raw_text = str(body["content"])
                payload_type = str(body.get("content_type", "text/csv")).lower()
                label = str(body.get("source_label") or source_label or "Custom POS")
                return raw_text.encode("utf-8"), payload_type, label
            if isinstance(body, dict) and not source_label and "source_label" in body:
                source_label = str(body["source_label"])
        except Exception:
            pass

    return data, content_type or "text/csv", source_label or "Custom POS"


@router.post("/analyze")
async def analyze_export(
    business_id: str,
    request: Request,
    source_label: str = Query(default=""),
) -> ConnectorResult:
    """Analyze an uploaded export or pasted sample.

    If a confirmed mapping already exists for this source system, it is reused.
    Otherwise, Gemini (or heuristic fallback) generates a proposed mapping.
    Shows preview rows and diff against existing inventory.
    """
    uid = await consented_owner(request)
    await enforce_limits(request, [("import", uid)])
    service = store(request)
    context = await anyio.to_thread.run_sync(service.context, uid, business_id)
    business = context["business"]
    if not business:
        raise HTTPException(404, "Business not found.")

    data, content_type, resolved_source = await _read_payload(request)
    if source_label:
        resolved_source = source_label

    try:
        headers, rows = parse_any(data, content_type)
    except ImportRejected as rejected:
        raise HTTPException(rejected.status, rejected.code) from None

    if not rows:
        raise HTTPException(422, "EMPTY_FILE")

    # Check for saved mapping for this source
    saved_record = await anyio.to_thread.run_sync(
        service.get_connector_mapping, uid, business_id, resolved_source
    )
    reused = False
    last_synced = None
    mapping: ConnectorMapping | None = None
    if saved_record and saved_record.get("fields"):
        try:
            mapping = ConnectorMapping(**saved_record["fields"])
            validate_mapping(mapping, headers)
            reused = True
            last_synced = saved_record.get("last_synced")
        except Exception:
            mapping = None
    preset = detect_preset(headers)
    if preset:
        rows = prepare_rows(preset, headers, rows)
    if mapping is None:
        mapping = (
            preset_mapping(preset, headers, rows)
            if preset
            else await ai_map_fields(
                request.app.state.column_mapper, headers, rows[:15], resolved_source
            )
        )

    validate_mapping(mapping, headers)

    previews = preview_mapped(mapping, headers, rows)

    # Compute diff for menu exports
    diff = None
    if mapping.kind == "menu":
        currency = shop_currency(business["fields"])
        _, _, col_map = apply_mapping(mapping, headers, rows)
        mapped_items, _ = menu_items(rows, col_map)
        diff = compute_diff(context["inventory"], mapped_items, currency=currency)

    return ConnectorResult(
        mapping=mapping,
        preview_rows=previews,
        total_rows=len(rows),
        reused=reused,
        last_synced=last_synced,
        diff=diff,
        warnings=[],
        preset=preset.label if preset and not reused else None,
    )


@router.post("/sync")
async def sync_export(
    business_id: str,
    request: Request,
    source_label: str = Query(default=""),
) -> dict[str, Any]:
    """Sync data using a saved or provided mapping.

    Produces a standard review proposal (menu or sales). NEVER writes silently.
    Updates the last_synced timestamp for this source.
    """
    uid = await consented_owner(request)
    await enforce_limits(request, [("import", uid)])
    service = store(request)
    context = await anyio.to_thread.run_sync(service.context, uid, business_id)
    business = context["business"]
    if not business:
        raise HTTPException(404, "Business not found.")

    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    mapping: ConnectorMapping | None = None
    resolved_source = source_label or request.headers.get("x-source-label", "")

    buffer = bytearray()
    async with asyncio.timeout(120):
        async for chunk in request.stream():
            if len(buffer) + len(chunk) > MAX_IMPORT_BYTES:
                raise HTTPException(413, "FILE_TOO_LARGE")
            buffer.extend(chunk)
    data = bytes(buffer)

    if content_type == "application/json":
        try:
            body_json = json.loads(data)
            if isinstance(body_json, dict):
                if "mapping" in body_json and body_json["mapping"]:
                    mapping = ConnectorMapping(**body_json["mapping"])
                if "content" in body_json:
                    data = str(body_json["content"]).encode("utf-8")
                    content_type = str(body_json.get("content_type", "text/csv"))
                if not resolved_source and "source_label" in body_json:
                    resolved_source = str(body_json["source_label"])
        except Exception:
            pass

    if not resolved_source:
        resolved_source = mapping.source_label if mapping else "Custom POS"

    # If mapping was not provided in request, load from store
    if mapping is None:
        saved_record = await anyio.to_thread.run_sync(
            service.get_connector_mapping, uid, business_id, resolved_source
        )
        if saved_record and saved_record.get("fields"):
            mapping = ConnectorMapping(**saved_record["fields"])
        else:
            raise HTTPException(400, "NO_MAPPING_FOUND")

    try:
        headers, rows = parse_any(data, content_type)
    except ImportRejected as rejected:
        raise HTTPException(rejected.status, rejected.code) from None

    if not rows:
        raise HTTPException(422, "EMPTY_FILE")

    if preset := detect_preset(headers):
        rows = prepare_rows(preset, headers, rows)
    validate_mapping(mapping, headers)
    return await build_import(
        request, uid, business_id, context, mapping, headers, rows, resolved_source
    )


async def build_import(
    request: Request,
    uid: str,
    business_id: str,
    context: dict[str, Any],
    mapping: ConnectorMapping,
    headers: list[str],
    rows: list[list[str]],
    resolved_source: str,
) -> dict[str, Any]:
    """Turn a mapped table, uploaded or pulled live, into a review proposal. Never saves it."""
    service = store(request)
    business = context["business"]
    _, _, col_map = apply_mapping(mapping, headers, rows)
    now = time.time()

    currency = shop_currency(business["fields"])

    # Sales export path
    if mapping.kind == "sales":
        aggregates = daily_sales(rows, col_map, currency)
        proposal = await anyio.to_thread.run_sync(
            service.prepare_sales, uid, business_id, aggregates
        )
        await anyio.to_thread.run_sync(
            service.record_connector_sync, uid, business_id, resolved_source
        )
        return {
            "kind": "sales",
            "status": "needs_review",
            "source_label": resolved_source,
            "import_id": proposal["id"],
            "digest": proposal["digest"],
            "expires": proposal["expires"],
            "summary": sales_summary(rows, col_map),
            "sales": proposal["snapshot"]["sales"],
            "currency": currency,
            "last_synced": now,
        }

    # Menu export path
    items, skipped = menu_items(rows, col_map)
    if not items:
        raise HTTPException(422, "NO_PRICED_ITEMS")

    saved_items = {(p["name"].casefold(), p["unit"].casefold()): p for p in context["inventory"]}
    by_name: dict[str, list[dict[str, Any]]] = {}
    for saved in context["inventory"]:
        by_name.setdefault(saved["name"].casefold(), []).append(saved)

    matches = []
    for item in items:
        known = saved_items.get((item["name"].casefold(), item["unit"].casefold()))
        if not known and len(by_name.get(item["name"].casefold(), [])) == 1:
            known = by_name[item["name"].casefold()][0]
        matches.append(known)

    unsorted = [
        item["name"]
        for item, known in zip(items, matches, strict=True)
        if not item.get("category") and not known
    ]
    sections = dict(
        zip(
            unsorted,
            await request.app.state.column_mapper.categorise(
                unsorted, business["fields"].get("category", "")
            ),
            strict=True,
        )
    )

    products = []
    for item, known in zip(items, matches, strict=True):
        products.append(
            ProductFields(
                name=known["name"] if known else item["name"],
                price=to_minor(item["price"], currency),
                unit=known["unit"] if known else item["unit"],
                stock=item["stock"] if item["stock"] is not None else (known or {}).get("stock"),
                available=known.get("available", True) if known else True,
                category=item.get("category")
                or (
                    known.get("category", "")
                    if known
                    else sections.get(item["name"]) or suggest_category(item["name"])
                ),
            )
        )

    proposal = await anyio.to_thread.run_sync(
        service.propose,
        uid,
        ProposalRequest(
            kind="inventory",
            business_id=business_id,
            revision=business["revision"],
            products=products,
        ),
    )
    await anyio.to_thread.run_sync(service.record_connector_sync, uid, business_id, resolved_source)

    diff = compute_diff(context["inventory"], items, currency=currency)

    return {
        "kind": "menu",
        "status": "needs_review",
        "source_label": resolved_source,
        "proposal": proposal,
        "diff": diff,
        "items": len(products),
        "skipped": skipped,
        "last_synced": now,
    }
