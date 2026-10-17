import asyncio
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from uuid import UUID

import anyio
import structlog
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.adk.sessions import BaseSessionService, DatabaseSessionService
from google.cloud import firestore
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool
from sse_starlette import EventSourceResponse, ServerSentEvent

from . import business_understanding, coordinator, supply_chain
from .analytics import AnalyticsReader
from .analytics import router as analytics_router
from .auth import IdentityService, Principal
from .boundary import RequestBoundary
from .brief import BriefWriter, WeatherService
from .business_profile import QuestionPlanner
from .business_understanding import BusinessUnderstander
from .community import community_service
from .community_routes import router as community_router
from .connector_routes import router as connector_router
from .contracts import CoachTurn, NewShopVoiceContext, StreamEvent
from .coordinator import MerchantContext, current
from .customer import CustomerAnswers
from .customer_routes import router as customer_router
from .day_close import router as day_close_router
from .demo_workspace import router as demo_workspace_router
from .demo_world import WorldGenerator
from .demo_world import router as demo_world_router
from .discover import MapsService
from .discover import router as discover_router
from .discover_ask import router as discover_ask_router
from .document_ai import DocumentAIReader
from .features import FeatureFlags
from .firestore_memory import FirestoreRunRegistry, FirestoreSessionService
from .forecast import ForecastService
from .forecast_routes import router as forecast_router
from .fraud import FraudReviewer
from .frontend import serve_frontend
from .games_routes import router as games_router
from .google_profile import BusinessProfileAdapter, SimulatedBusinessProfile
from .google_sim_routes import router as google_sim_router
from .icon_routes import router as icon_router
from .imports import ColumnMapper
from .limits import (
    LEASE_TTL_SECONDS,
    Lease,
    RunRegistry,
    client_ip,
    enforce_limits,
    lease_lost,
    rate_limiter,
)
from .maps_grounding import AreaGrounding
from .memory_vectors import (
    ConversationRecall,
    FirestoreRecall,
    Recall,
    gemini_embedder,
    padded_lexical,
)
from .merchant import MerchantRepository, MerchantStore, NewShopDraft
from .merchant_firestore import FirestoreMerchantStore
from .merchant_routes import router as merchant_router
from .new_shop_resume import is_empty, merge_drafts
from .new_shop_tools import go_live
from .owner_routes import router as owner_router
from .passport_routes import router as passport_router
from .photos import PhotoPipeline
from .planning_routes import router as planning_router
from .playbook import PlaybookWriter
from .playbook_routes import router as playbook_router
from .recap import RecapWriter
from .recs_routes import router as recs_router
from .replay import FirestoreTurns, RemoteTurn, ReplayStore, TurnReplay
from .reply_language import reply_language
from .retail_recs import (
    EventPipeline,
    Recommender,
    RetailClient,
    SimilarShops,
    configure_recommender,
)
from .sales_routes import router as sales_router
from .search_engine import build_engine
from .settings import Settings
from .shop_language import ShopTranslator
from .shop_today import router as shop_today_router
from .sourcing import SupplierGenerator
from .sourcing_routes import router as sourcing_router
from .streaming import CoachRuntime
from .supply_docs import DocumentTranslator
from .supply_routes import router as supply_router
from .today import router as today_router
from .trust_routes import router as trust_router
from .tts import Speech
from .voice import serve_voice

log = structlog.get_logger()
SSE_HEARTBEAT_SECONDS = 15


@dataclass
class Services:
    identity: IdentityService
    runtime: CoachRuntime
    registry: RunRegistry | FirestoreRunRegistry
    replay: ReplayStore


def get_services(connection: Request | WebSocket) -> Services:
    return cast(Services, connection.app.state.services)


def merchant_services(settings: Settings) -> tuple[MerchantRepository | None, Recall | None]:
    if not settings.v1_enabled:
        return None, None
    if settings.merchant_backend == "sqlite":
        return MerchantStore(settings.merchant_database), ConversationRecall(settings.recall_path)
    client = firestore.Client(
        project=settings.google_cloud_project, database=settings.firestore_database
    )
    embed = (
        gemini_embedder(
            settings.google_cloud_project,
            settings.google_embedding_location,
            settings.embedding_model,
        )
        if settings.coach_mode == "gemini" and settings.gemini_backend == "vertex"
        else padded_lexical
    )
    return (
        FirestoreMerchantStore(client, settings.firestore_namespace),
        FirestoreRecall(client, settings.firestore_namespace, embed),
    )


def create_app(
    settings: Settings | None = None,
    sessions: BaseSessionService | None = None,
    *,
    google_profile: BusinessProfileAdapter | None = None,
    maps_service: MapsService | None = None,
) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = None
        engine = None
        session_service: BaseSessionService
        if sessions is None and settings.session_backend == "firestore":
            client = firestore.AsyncClient(
                project=settings.google_cloud_project, database=settings.firestore_database
            )
            await (
                client.collection(settings.firestore_namespace).document("readiness").get(timeout=5)
            )
            session_service = FirestoreSessionService(client, settings.firestore_namespace)
        elif sessions is None:
            await anyio.to_thread.run_sync(lambda: Path("data").mkdir(exist_ok=True))
            engine = create_async_engine(settings.session_database_url, poolclass=NullPool)
            async with engine.begin() as connection:
                await connection.exec_driver_sql("PRAGMA journal_mode=WAL")
            session_service = DatabaseSessionService(db_engine=engine)
        else:
            session_service = sessions
        identity = await anyio.to_thread.run_sync(IdentityService, settings)
        app.state.v1_settings = settings
        app.state.merchant, app.state.recall = await anyio.to_thread.run_sync(
            merchant_services, settings
        )
        app.state.photos = PhotoPipeline(settings) if settings.v1_enabled else None
        app.state.customer_answers = CustomerAnswers(settings)
        app.state.shop_translator = ShopTranslator(settings)
        app.state.community = (
            await anyio.to_thread.run_sync(community_service, settings)
            if settings.v1_enabled
            else None
        )
        coordinator.question_planner = QuestionPlanner(settings)
        business_understanding.understander = BusinessUnderstander(settings)
        coordinator.supplier_generator = SupplierGenerator(settings)
        supply_chain.translator = DocumentTranslator(settings)
        app.state.search = build_engine(
            settings, app.state.community.docs if app.state.community else None
        )
        coordinator.search_engine = app.state.search
        app.state.world_generator = WorldGenerator(settings)
        app.state.column_mapper = ColumnMapper(settings)
        app.state.fraud_reviewer = FraudReviewer(settings)
        app.state.forecaster = ForecastService(settings)
        app.state.document_ai = DocumentAIReader(settings)
        app.state.analytics = AnalyticsReader(settings)
        app.state.weather = WeatherService(settings)
        app.state.brief_writer = BriefWriter(settings)
        coordinator.forecaster = app.state.forecaster
        app.state.recap_writer = RecapWriter(settings)
        app.state.playbook_writer = PlaybookWriter(settings)
        app.state.speech = Speech(settings)
        app.state.maps = maps_service or MapsService(settings)
        app.state.grounding = AreaGrounding(settings)
        app.state.rate_limiter = await anyio.to_thread.run_sync(rate_limiter, settings)
        retail = (
            RetailClient(settings.google_cloud_project)
            if (settings.recs_enabled or settings.recs_events_enabled)
            and settings.google_cloud_project
            else None
        )
        app.state.recs_events = EventPipeline(retail, settings.recs_events_enabled)
        recommender = Recommender(retail, settings.recs_enabled)
        configure_recommender(recommender)
        # "Similar nearby": Recommendations AI while its switch is on, else embeddings.
        if settings.recs_enabled:
            app.state.search.similar_provider = SimilarShops(recommender)
        app.state.services = Services(
            identity,
            CoachRuntime(settings, session_service),
            FirestoreRunRegistry(
                client,
                settings.firestore_namespace,
                settings.max_active_runs,
                # Text turns end within their deadline; voice sockets renew on each heartbeat.
                max(LEASE_TTL_SECONDS, settings.max_turn_seconds + 30),
            )
            if client
            else RunRegistry(settings.max_active_runs),
            ReplayStore(FirestoreTurns(client, settings.firestore_namespace) if client else None),
        )
        maintenance = asyncio.create_task(app.state.services.replay.maintain())
        try:
            yield
        finally:
            maintenance.cancel()
            await anyio.to_thread.run_sync(app.state.recs_events.flush)
            configure_recommender(None)
            await asyncio.gather(maintenance, return_exceptions=True)
            await app.state.services.replay.close()
            await app.state.customer_answers.close()
            await app.state.shop_translator.close()
            await app.state.recap_writer.close()
            await app.state.playbook_writer.close()
            await app.state.brief_writer.close()
        await app.state.column_mapper.close()
        await app.state.fraud_reviewer.close()
        if coordinator.supplier_generator is not None:
            await coordinator.supplier_generator.close()
        if supply_chain.translator is not None:
            await supply_chain.translator.close()
        await app.state.world_generator.close()
        if coordinator.question_planner is not None:
            await coordinator.question_planner.close()
        if business_understanding.understander is not None:
            await business_understanding.understander.close()
            await app.state.maps.close()
            await anyio.to_thread.run_sync(app.state.rate_limiter.close)
            identity.close()
            if app.state.recall:
                await anyio.to_thread.run_sync(app.state.recall.close)
            if sessions is None and isinstance(session_service, DatabaseSessionService):
                await session_service.close()
            if engine:
                await engine.dispose()
            if client:
                await client._firestore_api.transport.close()
                client.close()

    app = FastAPI(title="oGoogle AI streaming API", version="0.1.0", lifespan=lifespan)
    app.state.google_profile = google_profile or SimulatedBusinessProfile()
    app.include_router(merchant_router)
    app.include_router(icon_router)
    app.include_router(connector_router)
    app.include_router(google_sim_router)
    app.include_router(planning_router)
    app.include_router(sales_router)
    app.include_router(forecast_router)
    app.include_router(customer_router)
    app.include_router(community_router)
    app.include_router(discover_router)
    app.include_router(discover_ask_router)
    app.include_router(day_close_router)
    app.include_router(demo_workspace_router)
    app.include_router(demo_world_router)
    app.include_router(recs_router)
    app.include_router(passport_router)
    app.include_router(games_router)
    app.include_router(today_router)
    app.include_router(shop_today_router)
    app.include_router(analytics_router)
    app.include_router(playbook_router)
    app.include_router(sourcing_router)
    app.include_router(supply_router)
    app.include_router(owner_router)
    app.include_router(trust_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "Last-Event-ID", "X-Thread-Token"],
    )

    app.add_middleware(RequestBoundary, allowed_origins=settings.allowed_origins)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {
                "code": "INVALID_REQUEST",
                "issues": [
                    {"field": list(item["loc"]), "message": item["msg"]} for item in error.errors()
                ],
            },
            status_code=422,
        )

    @app.get("/api/v1/latency")
    async def latency() -> dict[str, object]:
        """Time to first output per coach flow on this instance (p50/p95 of recent turns)."""
        from .latency import stats

        return {"flows": stats.summary(), "context_cache": settings.context_cache_enabled}

    @app.get("/api/v1/health")
    async def health() -> dict[str, object]:
        return {
            "product": "oGoogle AI",
            "status": "ok",
            "coach_mode": settings.coach_mode,
            "auth_mode": settings.auth_mode,
            "streaming": ["sse", "websocket"],
            "google_publishing": False,
            "native_google_connected": False,
            "live_provider_verified": False,
            "session_backend": settings.session_backend,
            "release_commit": settings.release_commit,
        }

    @app.get("/api/v1/bootstrap")
    async def bootstrap(request: Request, response: Response) -> dict[str, object]:
        await enforce_limits(request, [("bootstrap", client_ip(request))], anonymous=True)
        return {
            **get_services(request).identity.bootstrap(request, response),
            "v1_enabled": settings.v1_enabled,
            "features": FeatureFlags(google_guide=settings.feature_google_guide).model_dump(),
            "customer_origin": settings.customer_origin
            or (
                "https://chalkboard.shreyaan.work"
                if settings.app_env == "production"
                else "http://127.0.0.1:3200"
            ),
            "ga_measurement_id": settings.ga_measurement_id,
            "coach_mode": settings.coach_mode,
            "maps_browser_key": (
                settings.maps_browser_key.get_secret_value() if settings.maps_browser_key else ""
            ),
            "maps_mode": "demo" if app.state.maps.demo else "live",
        }

    @app.post(
        "/api/v1/coach/stream",
        response_class=EventSourceResponse,
        responses={
            200: {
                "description": "SSE frames containing StreamEvent JSON; not a JSON document.",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            }
        },
    )
    async def coach_stream(body: CoachTurn, request: Request) -> EventSourceResponse:
        services = get_services(request)
        principal = await services.identity.require(request)
        bid = str(body.business_id) if body.business_id else None
        if bid:
            if not app.state.merchant:
                raise HTTPException(503, "Local V1 is not enabled.")
            await anyio.to_thread.run_sync(app.state.merchant.context, principal.uid, bid)
        cursor = request.headers.get("last-event-id")
        if cursor is not None:
            # Resume only the owned, retained turn; never fall through to a new model call.
            if not body.session_id:
                raise HTTPException(409, "RESUME_UNAVAILABLE")
            turn, after = await services.replay.resume(
                principal.uid, str(body.session_id), bid, cursor
            )
            return stream_response(turn, after)
        await enforce_limits(request, [("coach", principal.uid)])
        sid, adopted = await new_shop_session(
            principal,
            str(body.session_id) if body.session_id else None,
            bid,
            body.new_shop,
            body.new_shop_draft,
        )
        lease = await services.registry.acquire_async(principal.uid, sid)

        async def produce(turn: TurnReplay) -> None:
            token = None
            merchant: MerchantContext | None = None
            continues = False
            try:
                async with asyncio.timeout(settings.max_turn_seconds):
                    if app.state.merchant:
                        recall = await anyio.to_thread.run_sync(
                            app.state.recall.search, principal.uid, bid, body.message
                        )
                        merchant = MerchantContext(
                            app.state.merchant,
                            principal.uid,
                            bid,
                            recall,
                            body.message,
                            new_shop=body.new_shop,
                            new_shop_draft=body.new_shop_draft,
                        )
                        token = current.set(merchant)
                        if body.new_shop:
                            continues = await resume_new_shop(
                                merchant, principal, sid, adopted, voice=False
                            )
                    turn.append(
                        StreamEvent(
                            kind="ready",
                            session_id=sid,
                            mode=settings.coach_mode,
                            code="CONVERSATION_ROLLED_OVER"
                            if body.session_id and str(body.session_id) != sid
                            else None,
                            data={"continues": True} if continues else None,
                        )
                    )
                    resumed_draft = merchant.new_shop_draft if merchant else None
                    if body.new_shop and resumed_draft and resumed_draft != body.new_shop_draft:
                        # The saved draft knows more than the app (answers saved before a drop).
                        turn.append(
                            StreamEvent(kind="draft", data=resumed_draft.model_dump(mode="json"))
                        )
                    async for event in services.runtime.text_events(
                        principal, sid, body.message, body.language, body.currency
                    ):
                        turn.append(event)
                        if event.kind == "error":
                            return
                    if app.state.recall:
                        await anyio.to_thread.run_sync(
                            app.state.recall.remember, principal.uid, bid, body.message
                        )
            except TimeoutError:
                turn.append(StreamEvent(kind="error", code="TURN_TIMEOUT"))
            except Exception:
                log.warning("coach_stream_failed", code="PROVIDER_UNAVAILABLE")
                turn.append(StreamEvent(kind="error", code="PROVIDER_UNAVAILABLE"))
            finally:
                if token is not None:
                    current.reset(token)
                await services.registry.release_async(lease)

        try:
            turn = services.replay.start(principal.uid, sid, bid, produce)
        except Exception:
            await services.registry.release_async(lease)
            raise
        return stream_response(turn)

    def stream_response(turn: TurnReplay | RemoteTurn, after: int = 0) -> EventSourceResponse:
        return EventSourceResponse(
            turn.follow(after),
            ping=SSE_HEARTBEAT_SECONDS,
            ping_message_factory=lambda: ServerSentEvent(comment="heartbeat"),
            send_timeout=5,
            headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
        )

    @app.get("/api/v1/conversations")
    async def conversations(request: Request) -> list[dict[str, object]]:
        services = get_services(request)
        principal = await services.identity.require(request)
        listing = await services.runtime.sessions.list_sessions(
            app_name="ogoogle_ai", user_id=principal.uid
        )
        return [
            {
                "session_id": item.id,
                "updated": item.last_update_time,
                "business_id": item.state.get("business_id"),
                "new_shop": bool(item.state.get("new_shop")),
            }
            for item in reversed(listing.sessions)
        ]

    @app.get("/api/v1/conversations/{session_id}")
    async def conversation(session_id: UUID, request: Request) -> dict[str, object]:
        services = get_services(request)
        principal = await services.identity.require(request)
        session = await services.runtime.sessions.get_session(
            app_name="ogoogle_ai", user_id=principal.uid, session_id=str(session_id)
        )
        if not session:
            raise HTTPException(404, "Conversation not found.")
        messages = []
        for event in session.events:
            for part in (event.content.parts or []) if event.content else []:
                response = part.function_response
                if response and response.name == "prepare_payment_link":
                    payment = (response.response or {}).get("payment")
                    if isinstance(payment, dict):
                        messages.append({"role": "payment", "payment": payment, "key": event.id})
            # Voice turns are stored as transcripts, not text parts: show the finished ones too.
            for name, role in (
                ("input_transcription", "user"),
                ("output_transcription", "assistant"),
            ):
                spoken = getattr(event, name, None)
                if spoken and spoken.finished and (spoken.text or "").strip():
                    messages.append({"role": role, "text": spoken.text.strip()[:4000]})
            if event.content and event.content.role in {"model", "user"}:
                text = "".join(
                    part.text or "" for part in event.content.parts or [] if not part.thought
                )
                if text:
                    messages.append(
                        {
                            "role": "assistant" if event.content.role == "model" else "user",
                            "text": re.sub(r"^\[language=(en|hi)\]\s*", "", text)[:4000],
                        }
                    )
        return {"session_id": session.id, "messages": messages}

    async def new_shop_session(
        principal: Principal,
        requested: str | None,
        bid: str | None,
        new_shop: bool,
        draft: NewShopDraft | None,
    ) -> tuple[str, bool]:
        """The conversation for this turn or socket. A new-shop flow that starts empty (the app
        lost its draft: a reload, a crash) continues the owner's unfinished one."""
        services = app.state.services
        adopted = None
        if new_shop and not requested and is_empty(draft) and app.state.merchant:
            shops = await anyio.to_thread.run_sync(
                app.state.merchant.list_businesses, principal.uid
            )
            finished = {
                str(shop.get("fields", {}).get("name", "")).strip().casefold() for shop in shops
            }
            adopted = await services.runtime.unfinished_new_shop(principal, finished)
        sid = await services.runtime.session(principal, requested or adopted, bid, new_shop)
        return sid, bool(adopted and adopted == sid)

    async def resume_new_shop(
        merchant: MerchantContext, principal: Principal, sid: str, adopted: bool, *, voice: bool
    ) -> bool:
        """The saved draft fills what the app's copy is missing (answers saved just before the
        socket dropped never reached it); what the app holds (a moved pin, a photo's items)
        stays. The coach learns where the conversation stood, and a shop whose name, kind and
        place are all known goes live now (the app's pin can complete it).

        Returns whether the conversation already has turns: the app then resumes SILENTLY (the
        shop card and the next step's card, no second greeting)."""
        saved, asked, has_turns = await app.state.services.runtime.new_shop_progress(principal, sid)
        merchant.new_shop_draft = merge_drafts(saved, merchant.new_shop_draft)
        merchant.last_question = asked
        # Only a socket that comes back is "resumed"; text turns read the whole history anyway.
        merchant.resumed = voice and has_turns
        await anyio.to_thread.run_sync(go_live, merchant)
        return has_turns or adopted

    @app.websocket("/api/v1/voice")
    async def voice(websocket: WebSocket) -> None:
        if websocket.headers.get("origin") not in settings.allowed_origins:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        services = get_services(websocket)
        lease: Lease | None = None
        context_token = None
        try:
            async with asyncio.timeout(5):
                principal = await services.identity.require_websocket(websocket)
            await enforce_limits(websocket, [("voice", principal.uid)])
            requested = websocket.query_params.get("session_id")
            if requested:
                requested = str(UUID(requested))
            bid = websocket.query_params.get("business_id")
            new_shop = websocket.query_params.get("new_shop") == "true"
            if new_shop and bid:
                raise ValueError("New shop mode cannot edit a business")
            draft = None
            if new_shop:
                async with asyncio.timeout(5):
                    raw_context = await websocket.receive_text()
                    if len(raw_context) > 32_000:
                        raise ValueError("Draft too large")
                    draft = NewShopVoiceContext.model_validate_json(raw_context).draft
            if bid:
                bid = str(UUID(bid))
                if not app.state.merchant:
                    raise HTTPException(503, "Local V1 is not enabled.")
                await anyio.to_thread.run_sync(app.state.merchant.context, principal.uid, bid)
            merchant = None
            if app.state.merchant:
                merchant = MerchantContext(
                    app.state.merchant,
                    principal.uid,
                    bid,
                    [],
                    new_shop=new_shop,
                    new_shop_draft=draft,
                )
                context_token = current.set(merchant)
            sid, adopted = await new_shop_session(principal, requested, bid, new_shop, draft)
            continues = False
            if merchant and new_shop:
                continues = await resume_new_shop(merchant, principal, sid, adopted, voice=True)
            # A reconnect takes the conversation over from its previous socket (never a 409).
            lease = await services.registry.acquire_async(principal.uid, sid, "voice")
            await websocket.send_json(
                StreamEvent(
                    kind="ready",
                    session_id=sid,
                    mode=settings.coach_mode,
                    code="CONVERSATION_ROLLED_OVER" if requested and requested != sid else None,
                    data={"continues": True} if continues else None,
                ).payload()
            )
            resumed_draft = merchant.new_shop_draft if merchant and new_shop else None
            if resumed_draft and resumed_draft != draft:
                # The saved draft knows more than the app (answers saved before the drop).
                await websocket.send_json(
                    StreamEvent(kind="draft", data=resumed_draft.model_dump(mode="json")).payload()
                )
            log.info(
                "voice_ready",
                business=bool(bid),
                resumed=bool(requested),
                adopted=adopted,
                continues=bool(merchant and merchant.resumed),
                language=reply_language(websocket.query_params.get("lang")).locale,
            )
            held = lease
            stats = await serve_voice(
                websocket,
                services.runtime,
                principal,
                sid,
                websocket.query_params.get("lang"),
                keep=lambda: services.registry.renew_async(held),
                lost=lease_lost(lease),
            )
            log.info("voice_closed", **stats.fields())
        except (HTTPException, ValueError, TimeoutError) as error:
            code = (
                "RATE_LIMITED"
                if isinstance(error, HTTPException) and error.status_code == 429
                else "AUTH_OR_SESSION_ERROR"
            )
            # Every rejected voice session says why in the logs (it was silent before).
            log.warning(
                "voice_rejected",
                code=code,
                error=type(error).__name__,
                status=getattr(error, "status_code", None),
                detail=str(getattr(error, "detail", error))[:200],
            )
            with suppress(RuntimeError, WebSocketDisconnect):
                await websocket.send_json(
                    StreamEvent(
                        kind="error",
                        code=code,
                        data={"retry_after": int((error.headers or {}).get("Retry-After", "60"))}
                        if code == "RATE_LIMITED" and isinstance(error, HTTPException)
                        else None,
                    ).payload()
                )
                await websocket.close(code=1008, reason=code)
        except WebSocketDisconnect:
            log.info("voice_disconnected")
        except Exception:
            log.exception("voice_failed")
            raise
        finally:
            if context_token is not None:
                current.reset(context_token)
            if lease:
                await services.registry.release_async(lease)
            with suppress(RuntimeError, WebSocketDisconnect):
                await websocket.close()

    if settings.frontend_dist:
        serve_frontend(app, settings.frontend_dist)
    return app


app = create_app()
