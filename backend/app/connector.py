"""Connect any POS, ERP or billing system to Chalkboard.

Owners upload whatever their external system exports – CSV, XLSX, JSON (Shopify, Square, Petpooja)
or XML (Tally, SAP IDoc). Gemini maps source fields to the Chalkboard schema; offline mode falls
back to header heuristics. A confirmed mapping can be saved and re-applied on future imports.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from typing import Any, Literal

import structlog
from pydantic import BaseModel, Field

from .gemini_schema import gemini_schema, parse_reply
from .imports import (
    MAX_BYTES,
    MAX_ROWS,
    SAMPLE_ROWS,
    ColumnMap,
    ColumnMapper,
    ImportRejected,
    parse_table,
)
from .money import to_minor
from .settings import Settings  # noqa: F401 – re-exported for convenience

log = structlog.get_logger()

# ── Content-type sets ────────────────────────────────────────────────────────
JSON_TYPES = {"application/json", "text/json"}
XML_TYPES = {"application/xml", "text/xml"}

# ── Target schema roles ─────────────────────────────────────────────────────
TARGET_FIELDS = ("name", "price", "unit", "stock", "quantity", "date", "total", "category")

CONNECTOR_HEADER_HINTS: dict[str, tuple[str, ...]] = {
    "category": (
        "category",
        "categoryname",
        "custom product type",
        "standardized product type",
        "type",
        "group",
        "section",
        "department",
        "parent",
    ),
    "name": (
        "itemname",
        "item name",
        "stockitemname",
        "stockitem",
        "product name",
        "dish name",
        "item",
        "product",
        "title",
        "name",
        "description",
        "menu",
        "dish",
        "sku name",
        "article",
    ),
    "price": (
        "variant price",
        "unit price",
        "selling price",
        "price",
        "rate",
        "cost",
        "mrp",
        "amount",
    ),
    "unit": (
        "variant weight unit",
        "baseunits",
        "unit",
        "uom",
        "size",
        "per",
    ),
    "quantity": (
        "billedqty",
        "actualqty",
        "quantity",
        "qty",
        "sold",
        "count",
        "units sold",
    ),
    "total": (
        "net amount",
        "total",
        "net sales",
        "gross sales",
        "revenue",
        "line total",
        "subtotal",
        "amount",
    ),
    "date": (
        "vchdate",
        "voucher date",
        "date",
        "time",
        "created",
        "receipt date",
        "day",
    ),
    "stock": (
        "variant inventory qty",
        "closingbalance",
        "openingbalance",
        "stock",
        "inventory",
        "on hand",
        "in stock",
        "available",
        "qty on hand",
    ),
}


# ── Pydantic models ─────────────────────────────────────────────────────────
class FieldMapping(BaseModel):
    """One source → target column mapping produced by Gemini or confirmed by the owner."""

    source_field: str = Field(description="Original column/field name from the export")
    target_field: str = Field(description="Our schema field: " + ", ".join(TARGET_FIELDS))
    confidence: float = Field(ge=0, le=1, description="Mapping confidence 0–1")
    sample_values: list[str] = Field(
        default_factory=list, max_length=5, description="Sample values from that column"
    )


class ConnectorMapping(BaseModel):
    """Complete mapping from an external system export to the Chalkboard schema."""

    source_label: str = Field(description="E.g. Petpooja, Tally, Square, Shopify, SAP, Other")
    kind: Literal["menu", "sales"]
    fields: list[FieldMapping]
    confirmed: bool = False


class ConnectorResult(BaseModel):
    """What we return to the frontend after parsing + AI mapping."""

    mapping: ConnectorMapping
    preview_rows: list[dict[str, Any]] = Field(description="First 5 rows mapped to our schema")
    total_rows: int
    reused: bool = False
    last_synced: float | None = None
    diff: dict[str, list[dict[str, Any]]] | None = None
    warnings: list[str] = Field(default_factory=list)
    preset: str | None = Field(default=None, description="Built-in mapping used, e.g. Square")


# ── JSON parser ──────────────────────────────────────────────────────────────
def _flatten(obj: Any, prefix: str = "") -> dict[str, str]:
    """Flatten a nested dict into dot-notation keys with string values."""
    out: dict[str, str] = {}
    if isinstance(obj, dict):
        for key, value in obj.items():
            full = f"{prefix}{key}" if not prefix else f"{prefix}.{key}"
            if isinstance(value, dict):
                out.update(_flatten(value, full + "."))
            elif isinstance(value, list):
                out[full] = str(value)
            else:
                out[full] = "" if value is None else str(value)
    else:
        out[prefix.rstrip(".")] = str(obj)
    return out


def parse_json_export(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Flatten a JSON array-of-objects or single-object-with-array into tabular rows."""
    if len(data) > MAX_BYTES:
        raise ImportRejected(413, "FILE_TOO_LARGE")
    try:
        parsed = json.loads(data)
    except (json.JSONDecodeError, ValueError):
        raise ImportRejected(415, "UNREADABLE_FILE") from None

    records: list[dict[str, Any]] = []
    if isinstance(parsed, list):
        records = [r for r in parsed if isinstance(r, dict)]
    elif isinstance(parsed, dict):
        candidates = (
            "items",
            "products",
            "menu",
            "vouchers",
            "orders",
            "sales",
            "records",
            "rows",
            "data",
        )
        for candidate_key in candidates:
            val = parsed.get(candidate_key)
            if isinstance(val, list) and val and isinstance(val[0], dict):
                records = [r for r in val if isinstance(r, dict)]
                break
            if isinstance(val, dict):
                for sub_val in val.values():
                    if isinstance(sub_val, list) and sub_val and isinstance(sub_val[0], dict):
                        records = [r for r in sub_val if isinstance(r, dict)]
                        break
                if records:
                    break

        if not records:
            for value in parsed.values():
                if isinstance(value, list) and value and isinstance(value[0], dict):
                    records = [r for r in value if isinstance(r, dict)]
                    break

        if not records:
            records = [parsed]
    else:
        raise ImportRejected(422, "EMPTY_FILE")

    if not records:
        raise ImportRejected(422, "EMPTY_FILE")
    if len(records) > MAX_ROWS:
        raise ImportRejected(413, "TOO_MANY_ROWS")

    flat_rows = [_flatten(r) for r in records]
    all_keys: list[str] = []
    seen: set[str] = set()
    for row in flat_rows:
        for key in row:
            if key not in seen:
                all_keys.append(key)
                seen.add(key)
    rows = [[row.get(k, "") for k in all_keys] for row in flat_rows]
    return all_keys, rows


# ── XML parser ───────────────────────────────────────────────────────────────
def parse_xml_export(data: bytes) -> tuple[list[str], list[list[str]]]:
    """Parse XML (Tally, SAP IDoc, generic) into tabular rows."""
    if len(data) > MAX_BYTES:
        raise ImportRejected(413, "FILE_TOO_LARGE")
    try:
        root = ET.fromstring(data)  # noqa: S314 – trusted owner uploads only
    except ET.ParseError:
        raise ImportRejected(415, "UNREADABLE_FILE") from None

    flat_records: list[dict[str, str]] = []

    # 1. Tally vouchers with inventory entries
    vouchers = root.findall(".//VOUCHER")
    if vouchers:
        for v in vouchers:
            v_data: dict[str, str] = {}
            for child in v:
                if len(child) == 0 and child.text and child.text.strip():
                    v_data[child.tag] = child.text.strip()
            inv_entries = v.findall(".//ALLINVENTORYENTRIES.LIST") or v.findall(
                ".//INVENTORYENTRIES.LIST"
            )
            if inv_entries:
                for entry in inv_entries:
                    record = dict(v_data)
                    for item_child in entry:
                        if item_child.text and item_child.text.strip():
                            record[item_child.tag] = item_child.text.strip()
                    flat_records.append(record)
            else:
                flat_records.append(v_data)

    # 2. Stock items (Tally or generic)
    if not flat_records:
        stock_items = root.findall(".//STOCKITEM")
        if stock_items:
            for item in stock_items:
                record = {}
                for child in item:
                    if len(child) == 0 and child.text and child.text.strip():
                        record[child.tag] = child.text.strip()
                    for attr, val in item.attrib.items():
                        record[attr] = val
                if record:
                    flat_records.append(record)

    # 3. Generic XML elements
    if not flat_records:
        tag_counts: dict[str, int] = {}
        for child in root:
            for grandchild in child:
                tag_counts[grandchild.tag] = tag_counts.get(grandchild.tag, 0) + 1
            tag_counts[child.tag] = tag_counts.get(child.tag, 0) + 1
        if tag_counts:
            row_tag = max(tag_counts, key=lambda t: tag_counts[t])
            elements = root.findall(f".//{row_tag}")
            for elem in elements:
                rec: dict[str, str] = {}
                for child in elem:
                    if len(child) == 0:
                        rec[child.tag] = (child.text or "").strip()
                for attr, val in elem.attrib.items():
                    rec[attr] = val
                if rec:
                    flat_records.append(rec)

    if not flat_records:
        raise ImportRejected(422, "EMPTY_FILE")
    if len(flat_records) > MAX_ROWS:
        raise ImportRejected(413, "TOO_MANY_ROWS")

    all_keys: list[str] = []
    seen: set[str] = set()
    for rec in flat_records:
        for k in rec:
            if k not in seen:
                all_keys.append(k)
                seen.add(k)

    if not all_keys:
        raise ImportRejected(422, "EMPTY_FILE")

    rows = [[rec.get(k, "") for k in all_keys] for rec in flat_records]
    return all_keys, rows


# ── Unified parser ───────────────────────────────────────────────────────────
def parse_any(data: bytes, content_type: str) -> tuple[list[str], list[list[str]]]:
    """Route to the right parser based on content type or data sniff."""
    cleaned_type = (content_type or "").split(";")[0].strip().lower()
    stripped = data[:512].strip()
    if cleaned_type in JSON_TYPES or stripped.startswith(b"{") or stripped.startswith(b"["):
        return parse_json_export(data)
    if cleaned_type in XML_TYPES or stripped.startswith(b"<"):
        return parse_xml_export(data)
    return parse_table(data, cleaned_type)


# ── Heuristic mapping ────────────────────────────────────────────────────────
def _heuristic_connector_mapping(
    headers: list[str], sample: list[list[str]], source_label: str
) -> ConnectorMapping:
    """Build a ConnectorMapping using robust header hints with confidence scores."""
    lowered = [h.casefold().strip() for h in headers]
    used_indices: set[int] = set()
    fields: list[FieldMapping] = []

    # Map roles in priority order (stock before quantity so inventory counts map to stock)
    for role in ("name", "price", "unit", "stock", "category", "date", "quantity", "total"):
        hints = CONNECTOR_HEADER_HINTS.get(role, ())
        free = [(idx, h) for idx, h in enumerate(lowered) if idx not in used_indices]

        # Exact match first
        best_idx: int | None = None
        best_conf = 0.5
        for idx, h in free:
            if h in hints:
                best_idx = idx
                best_conf = 0.95
                break

        # Substring match if no exact match (hints are checked in priority order)
        if best_idx is None:
            for hint in hints:
                for idx, h in free:
                    if hint in h:
                        best_idx = idx
                        best_conf = 0.85
                        break
                if best_idx is not None:
                    break

        if best_idx is not None:
            used_indices.add(best_idx)
            samples = [
                row[best_idx] for row in sample[:5] if best_idx < len(row) and row[best_idx].strip()
            ]
            fields.append(
                FieldMapping(
                    source_field=headers[best_idx],
                    target_field=role,
                    confidence=best_conf,
                    sample_values=samples[:3],
                )
            )

    has_date = any(f.target_field == "date" for f in fields)
    has_qty = any(f.target_field == "quantity" for f in fields)
    has_total = any(f.target_field == "total" for f in fields)
    is_sales = has_date and (has_qty or has_total)

    return ConnectorMapping(
        source_label=source_label,
        kind="sales" if is_sales else "menu",
        fields=fields,
    )


# ── AI mapping ───────────────────────────────────────────────────────────────
CONNECTOR_PROMPT = (
    "You map columns from an external system export to the Chalkboard inventory schema. "
    "The source system is '{source_label}'. Given the column names and sample rows, decide "
    'whether the data is a menu/price list (kind "menu") or a sales/transactions export '
    '(kind "sales"), and map each source column to the best target field. Target fields: '
    + ", ".join(TARGET_FIELDS)
    + ". Set confidence 0–1 for each mapping. Omit columns that don't match any target field."
)


class _AIMappingResponse(BaseModel):
    """Schema sent to Gemini for structured output."""

    source_label: str
    kind: Literal["menu", "sales"]
    fields: list[FieldMapping]


async def ai_map_fields(
    mapper: ColumnMapper,
    headers: list[str],
    sample: list[list[str]],
    source_label: str,
) -> ConnectorMapping:
    """Use Gemini to map source columns to the Chalkboard schema, with heuristic fallback."""
    if mapper.settings.coach_mode != "gemini":
        return _heuristic_connector_mapping(headers, sample, source_label)
    try:
        from google.genai import types

        table = "\n".join(" | ".join(row) for row in [headers, *sample[:SAMPLE_ROWS]])
        response = await mapper.client().aio.models.generate_content(
            model=mapper.settings.google_text_model,
            contents=table[:8000],
            config=types.GenerateContentConfig(
                system_instruction=CONNECTOR_PROMPT.format(source_label=source_label),
                response_mime_type="application/json",
                response_json_schema=gemini_schema(_AIMappingResponse),
                temperature=0,
                max_output_tokens=1000,
            ),
        )
        parsed = parse_reply(_AIMappingResponse, response)
        if isinstance(parsed, _AIMappingResponse) and parsed.fields:
            # Augment sample values if Gemini omitted them
            header_idx = {h: i for i, h in enumerate(headers)}
            for f in parsed.fields:
                if not f.sample_values:
                    idx = header_idx.get(f.source_field)
                    if idx is not None:
                        f.sample_values = [
                            row[idx] for row in sample[:3] if idx < len(row) and row[idx].strip()
                        ]
            return ConnectorMapping(
                source_label=parsed.source_label or source_label,
                kind=parsed.kind,
                fields=parsed.fields,
            )
    except Exception:
        log.warning("connector_ai_map_failed", source_label=source_label)
    return _heuristic_connector_mapping(headers, sample, source_label)


# ── Apply mapping ───────────────────────────────────────────────────────────
def apply_mapping(
    mapping: ConnectorMapping,
    headers: list[str],
    rows: list[list[str]],
) -> tuple[list[str], list[list[str]], ColumnMap]:
    """Convert a ConnectorMapping into the ColumnMap format used by the import pipeline."""
    header_index = {h: i for i, h in enumerate(headers)}
    col_kwargs: dict[str, int | None] = {role: None for role in TARGET_FIELDS}
    for fm in mapping.fields:
        idx = header_index.get(fm.source_field)
        if idx is not None and fm.target_field in col_kwargs:
            col_kwargs[fm.target_field] = idx
    col_map = ColumnMap(kind=mapping.kind, **col_kwargs)
    return headers, rows, col_map


# ── Preview mapped rows ─────────────────────────────────────────────────────
def preview_mapped(
    mapping: ConnectorMapping, headers: list[str], rows: list[list[str]], limit: int = 5
) -> list[dict[str, Any]]:
    """Return the first `limit` rows mapped with field names matching our schema."""
    header_index = {h: i for i, h in enumerate(headers)}
    active_fields = [
        (fm.target_field, header_index[fm.source_field])
        for fm in mapping.fields
        if fm.source_field in header_index
    ]
    previews: list[dict[str, Any]] = []
    for row in rows[:limit]:
        item: dict[str, Any] = {}
        for target, idx in active_fields:
            if idx < len(row) and row[idx].strip():
                item[target] = row[idx].strip()
        if item:
            previews.append(item)
    return previews


# ── Diff ─────────────────────────────────────────────────────────────────────
def compute_diff(
    current_items: list[dict[str, Any]],
    new_items: list[dict[str, Any]],
    currency: str,
) -> dict[str, list[dict[str, Any]]]:
    """Compare current inventory with newly mapped items; return added, updated, removed lists."""
    current_by_name: dict[str, dict[str, Any]] = {
        (item.get("name", "") or "").casefold(): item for item in current_items if item.get("name")
    }
    new_by_name: dict[str, dict[str, Any]] = {
        (item.get("name", "") or "").casefold(): item for item in new_items if item.get("name")
    }

    added: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []

    for key, new_item in new_by_name.items():
        if key not in current_by_name:
            added.append(
                {
                    "action": "added",
                    "name": new_item["name"],
                    "price": new_item.get("price"),
                    "unit": new_item.get("unit"),
                    "stock": new_item.get("stock"),
                    "category": new_item.get("category"),
                }
            )
        else:
            old_item = current_by_name[key]
            diffs: dict[str, Any] = {}
            # Normalize price if comparing major vs minor
            new_price = new_item.get("price")
            old_price = old_item.get("price")
            if new_price is not None and old_price is not None:
                # old_price is usually in minor units from repository
                new_minor = to_minor(new_price, currency)
                if new_minor != old_price and new_price != old_price:
                    diffs["price"] = {"old": old_price, "new": new_price}

            for field in ("unit", "stock", "category"):
                old_val = old_item.get(field)
                new_val = new_item.get(field)
                if old_val is not None and new_val is not None and old_val != new_val:
                    diffs[field] = {"old": old_val, "new": new_val}

            if diffs:
                updated.append(
                    {
                        "action": "updated",
                        "name": new_item["name"],
                        "fields": diffs,
                    }
                )

    for key, old_item in current_by_name.items():
        if key not in new_by_name:
            removed.append(
                {
                    "action": "removed",
                    "name": old_item["name"],
                }
            )

    return {"added": added, "updated": updated, "removed": removed}
