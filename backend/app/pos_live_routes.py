"""Pull a menu or sales from a live POS (Square sandbox, Loyverse) into the same review step
as an uploaded export. The pull never writes: the owner confirms the proposal as usual."""

from __future__ import annotations

from typing import Any, Literal

import anyio
from fastapi import APIRouter, HTTPException, Request

from .connector import ConnectorMapping
from .connector_routes import build_import, validate_mapping
from .limits import enforce_limits
from .merchant_routes import consented_owner, owner, store
from .pos_live import LABELS, Provider, pull, status
from .pos_presets import detect_preset, prepare_rows, preset_mapping

router = APIRouter(prefix="/api/v1/businesses/{business_id}/connect/live")


@router.get("")
async def live_status(business_id: str, request: Request) -> list[dict[str, Any]]:
    await owner(request)
    return status(request.app.state.column_mapper.settings)


@router.post("/{provider}/{kind}")
async def live_sync(
    business_id: str,
    provider: Provider,
    kind: Literal["menu", "sales"],
    request: Request,
) -> dict[str, Any]:
    uid = await consented_owner(request)
    await enforce_limits(request, [("import", uid)])
    service = store(request)
    context = await anyio.to_thread.run_sync(service.context, uid, business_id)
    if not context["business"]:
        raise HTTPException(404, "Business not found.")

    pulled = await pull(provider, kind, request.app.state.column_mapper.settings)
    if not pulled.rows:
        raise HTTPException(422, "EMPTY_FILE")
    label = LABELS[provider]
    preset = detect_preset(pulled.headers)
    if preset is None or preset.kind != kind:
        raise HTTPException(422, "INVALID_MAPPING")
    rows = prepare_rows(preset, pulled.headers, pulled.rows)

    # The owner's saved mapping for this system wins, exactly as for an upload; the built-in
    # preset covers the first pull.
    mapping = preset_mapping(preset, pulled.headers, rows)
    saved = await anyio.to_thread.run_sync(service.get_connector_mapping, uid, business_id, label)
    if saved and saved.get("fields"):
        try:
            candidate = ConnectorMapping(**saved["fields"])
            validate_mapping(candidate, pulled.headers)
            if candidate.kind == kind:
                mapping = candidate
        except Exception:  # an old or other-kind mapping: use the preset
            pass
    validate_mapping(mapping, pulled.headers)

    result = await build_import(
        request, uid, business_id, context, mapping, pulled.headers, rows, label
    )
    return {
        **result,
        "provider": provider,
        "simulated": pulled.simulated,
        "fallback": pulled.fallback,
        "via": pulled.via,
    }
