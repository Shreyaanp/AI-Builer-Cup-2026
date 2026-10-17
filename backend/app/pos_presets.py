"""Built-in column mappings for the CSV exports of popular POS systems.

A recognised export is mapped instantly from its header row, with no model call; any other
export still goes to Gemini (or the offline header heuristics). Live connectors emit tables
with the same headers (see pos_live.py), so one preset serves both an uploaded file and a pull.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from .connector import ConnectorMapping, FieldMapping

DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%d-%m-%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
    "%d-%m-%Y",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%d/%m/%Y",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y",
)


@dataclass(frozen=True)
class Preset:
    key: str
    label: str
    kind: Literal["menu", "sales"]
    # Every header here must be present (case-insensitive) for the export to be recognised.
    signature: tuple[str, ...]
    # Role -> header names, in order of preference. A trailing "*" matches a prefix, for
    # headers that carry the store name, such as Loyverse's "Price [Main store]".
    roles: dict[str, tuple[str, ...]]
    # A column naming the variation sold ("Large"), folded into the item name so that each
    # variation stays its own item. Values in `plain_variants` mean "no variation".
    variant: str = ""
    plain_variants: tuple[str, ...] = ("", "regular", "default", "standard")
    # Day-first exports (India) are read before month-first ones.
    day_first: bool = False


PRESETS: tuple[Preset, ...] = (
    Preset(
        key="square",
        label="Square",
        kind="sales",
        signature=("date", "item", "qty", "net sales", "price point name"),
        roles={
            "date": ("date",),
            "name": ("item",),
            "quantity": ("qty",),
            "total": ("net sales",),
            "category": ("category",),
        },
        variant="price point name",
    ),
    Preset(
        key="square",
        label="Square",
        kind="menu",
        signature=("token", "item name", "variation name", "price"),
        roles={
            "name": ("item name",),
            "price": ("price",),
            "category": ("reporting category", "categories"),
            "stock": ("current quantity*",),
        },
        variant="variation name",
    ),
    Preset(
        key="loyverse",
        label="Loyverse",
        kind="sales",
        signature=("date", "receipt number", "item", "quantity", "net sales"),
        roles={
            "date": ("date",),
            "name": ("item",),
            "quantity": ("quantity",),
            "total": ("net sales",),
            "category": ("category",),
        },
        variant="variant",
    ),
    Preset(
        key="loyverse",
        label="Loyverse",
        kind="menu",
        signature=("handle", "name", "category", "sold by weight"),
        roles={
            "name": ("name",),
            "price": ("price [*", "default price"),
            "category": ("category",),
            "stock": ("in stock [*",),
        },
        variant="option 1 value",
    ),
    Preset(
        key="petpooja",
        label="Petpooja",
        kind="sales",
        signature=("date", "item name", "qty", "total"),
        roles={
            "date": ("date",),
            "name": ("item name",),
            "quantity": ("qty",),
            "total": ("total", "net amount"),
            "category": ("category name", "category"),
        },
        variant="variation",
        day_first=True,
    ),
    Preset(
        key="petpooja",
        label="Petpooja",
        kind="menu",
        signature=("item name", "category", "price", "short code"),
        roles={
            "name": ("item name",),
            "price": ("price",),
            "category": ("category",),
        },
        variant="variation",
    ),
)


def _find(headers: list[str], names: tuple[str, ...]) -> int | None:
    lowered = [header.casefold().strip() for header in headers]
    for name in names:
        for index, header in enumerate(lowered):
            if header.startswith(name[:-1]) if name.endswith("*") else header == name:
                return index
    return None


def detect_preset(headers: list[str]) -> Preset | None:
    """The first preset whose signature headers are all present."""
    present = {header.casefold().strip() for header in headers}
    return next(
        (preset for preset in PRESETS if all(name in present for name in preset.signature)),
        None,
    )


def preset_mapping(preset: Preset, headers: list[str], rows: list[list[str]]) -> ConnectorMapping:
    fields: list[FieldMapping] = []
    used: set[int] = set()
    for role, names in preset.roles.items():
        index = _find(headers, names)
        if index is None or index in used:
            continue
        used.add(index)
        samples = [row[index] for row in rows[:5] if index < len(row) and row[index].strip()]
        fields.append(
            FieldMapping(
                source_field=headers[index],
                target_field=role,
                confidence=1.0,
                sample_values=samples[:3],
            )
        )
    return ConnectorMapping(source_label=preset.label, kind=preset.kind, fields=fields)


def parse_day(text: str, day_first: bool) -> str | None:
    """An ISO date for a POS timestamp, or None when it is in no format we know."""
    cleaned = text.strip()
    formats = DATE_FORMATS
    if not day_first:
        formats = tuple(f for f in DATE_FORMATS if not f.startswith(("%d-", "%d/"))) + tuple(
            f for f in DATE_FORMATS if f.startswith(("%d-", "%d/"))
        )
    for fmt in formats:
        try:
            return datetime.strptime(cleaned, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def prepare_rows(preset: Preset, headers: list[str], rows: list[list[str]]) -> list[list[str]]:
    """Fold variations into item names and write sale dates as ISO days. Returns new rows."""
    name_at = _find(headers, preset.roles["name"])
    variant_at = _find(headers, (preset.variant,)) if preset.variant else None
    date_at = _find(headers, preset.roles["date"]) if "date" in preset.roles else None
    prepared: list[list[str]] = []
    for row in rows:
        row = list(row)
        if name_at is not None and variant_at is not None and variant_at < len(row):
            variant = row[variant_at].strip()
            if variant.casefold() not in preset.plain_variants and name_at < len(row):
                row[name_at] = f"{row[name_at].strip()} ({variant})"
        if date_at is not None and date_at < len(row):
            day = parse_day(row[date_at], preset.day_first)
            if day:
                row[date_at] = day
        prepared.append(row)
    return prepared
