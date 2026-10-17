import os
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_env: Literal["local", "test", "production"] = "local"
    coach_mode: Literal["offline", "gemini"] = "offline"
    forecast_backend: Literal["weekday_average", "bigquery"] = "weekday_average"
    # Till receipts and supplier invoices: Document AI first, Gemini vision as the fallback.
    document_ai_enabled: bool = False
    document_ai_location: str = Field(default="us", pattern=r"^[a-z0-9-]+$")
    document_ai_receipt_processor: str = Field(default="", pattern=r"^[a-f0-9]*$")
    document_ai_invoice_processor: str = Field(default="", pattern=r"^[a-f0-9]*$")
    # Owner analytics: nightly per-shop daily aggregates in BigQuery; "live" reads the records.
    analytics_backend: Literal["live", "bigquery"] = "live"
    analytics_dataset: str = Field(default="chalkboard_analytics", pattern=r"^[A-Za-z0-9_]+$")
    analytics_location: str = "asia-south1"
    # The Cloud Scheduler service account allowed to run the export, and its OIDC audience.
    analytics_export_caller: str = ""
    analytics_export_audience: str = ""
    weather_backend: Literal["disabled", "offline", "open_meteo"] = "offline"
    auth_mode: Literal["local", "firebase"] = "local"
    session_database_url: str = "sqlite+aiosqlite:///./data/sessions.sqlite3"
    session_backend: Literal["sqlite", "firestore"] = "sqlite"
    firestore_database: str = "(default)"
    firestore_namespace: str = Field(default="ogoogle_ai_v1", pattern=r"^ogoogle_ai_[a-zA-Z0-9_]+$")
    frontend_dist: str = ""
    release_commit: str = "local"
    customer_origin: str = ""
    v1_enabled: bool = False
    guest_customer: bool = False
    feature_google_guide: bool = True
    merchant_backend: Literal["sqlite", "firestore"] = "sqlite"
    embedding_model: str = "gemini-embedding-2"
    # The shared search engine: Vertex embeddings when Gemini runs on Vertex ("auto"), or the
    # offline concept fixture; Gemini one-line reasons for the top personal picks.
    search_embeddings: Literal["auto", "fixture", "vertex"] = "auto"
    search_explanations: bool = True
    media_bucket: str = ""
    # Shop gallery photos when no bucket is configured (local development and tests).
    media_dir: str = "data/media"
    moderation_mode: Literal["vision", "fixture"] = "fixture"
    # Abuse protection; the local browser-test server turns it off (all tests share one IP).
    rate_limits_enabled: bool = True
    # Showcase mode: generate labelled demo shops around each new visitor area (production only).
    demo_world_enabled: bool = False
    # Recommendations AI (retail_recs.py). Both off by default; serving also waits for the model.
    recs_enabled: bool = False
    recs_events_enabled: bool = False
    # Modern phone photos are 4-15 MB; Cloud Run's request limit is 32 MB.
    max_photo_bytes: int = Field(default=20_000_000, ge=65_536, le=30_000_000)
    merchant_database: str = "data/merchant.sqlite3"
    recall_path: str = "data/conversation-vectors"
    face_worker_url: str = "http://127.0.0.1:3401"
    face_worker_token: SecretStr = SecretStr("")
    # "worker": the private face worker decides liveness and returns a template. "fixture"
    # (local preview and tests only): every capture passes and the face is the owner's own,
    # or the X-Face-Fixture name a browser test sends, so duplicate detection can be shown.
    face_mode: Literal["worker", "fixture"] = "worker"
    # Encrypts stored face templates (AES-256-GCM). Empty: derived from the worker token.
    face_template_key: SecretStr = SecretStr("")
    # Firebase UIDs who see the trust review queue (duplicate faces, listing flags).
    # ["*"] (everyone) is for the local preview only.
    trust_admins: list[str] = []
    firebase_web_api_key: str = ""
    firebase_web_app_id: str = ""
    firebase_auth_domain: str = ""
    session_signing_secret: SecretStr = SecretStr("")
    allowed_origins: list[str] = ["http://127.0.0.1:3200", "http://localhost:3200"]
    google_api_key: SecretStr = SecretStr("")
    maps_server_key: SecretStr | None = None
    maps_browser_key: SecretStr | None = None
    google_text_model: str = ""
    google_live_model: str = ""
    # One voice for the whole app (owner choice, 16 Oct): Gemini Live and Cloud TTS (Chirp 3 HD)
    # share these names; other TTS tiers fall back to a female voice.
    voice_name: str = "Achernar"
    google_cloud_project: str = ""
    gemini_backend: Literal["vertex", "api_key"] = "vertex"
    google_cloud_location: str = "global"
    # Gemini Live (voice) models are regional on Vertex; `global` returns "model not found".
    google_live_location: str = "us-central1"
    google_embedding_location: str = "global"
    # Instant path: common requests answered by rules before any model call; embeddings of known
    # intents (Vertex) catch paraphrases of read-only and navigation requests when enabled.
    instant_path_enabled: bool = True
    instant_embeddings: bool = False
    # Vertex context caching of the coach rules + tool schemas (text coach). Off by default
    # until measured in production; without it the coach runs exactly as before.
    context_cache_enabled: bool = False
    context_cache_ttl_seconds: int = Field(default=1800, ge=60, le=86_400)
    # Customer AI answers about the area with Gemini's Google Maps grounding tool (Vertex).
    # "off" keeps the honest fallback (our list + straight-line distances); "demo" returns
    # labelled sample answers for offline previews and browser tests; "live" calls Gemini.
    maps_grounding: Literal["off", "demo", "live"] = "off"
    maps_grounding_model: str = ""
    # Shop icon: "Make my icon" asks Gemini's image model for a square icon (about one small
    # image charge each). Off, or in offline modes, the owner uploads a photo or the app draws a
    # themed monogram. Each shop may generate this many icons per UTC day.
    shop_icon_ai: bool = False
    shop_icon_model: str = "gemini-3.1-flash-lite-image"
    shop_icon_location: str = "global"
    shop_icon_daily_limit: int = Field(default=3, ge=1, le=20)
    # GCP credit is limited: one grounded call per question per ~1 km area for this long.
    maps_grounding_cache_seconds: int = Field(default=3600, ge=60, le=86_400)
    max_turn_seconds: int = Field(default=30, ge=1, le=120)
    max_voice_seconds: int = Field(default=120, ge=1, le=600)
    max_active_runs: int = Field(default=8, ge=1, le=32)
    max_audio_bytes: int = Field(default=4_000_000, ge=32_768, le=20_000_000)

    @model_validator(mode="after")
    def reject_unsafe_configuration(self) -> "Settings":
        if self.customer_origin:
            origin = urlsplit(self.customer_origin)
            local = origin.hostname in {"127.0.0.1", "localhost"}
            if (
                not origin.hostname
                or origin.username
                or origin.password
                or origin.path not in {"", "/"}
                or origin.query
                or origin.fragment
                or not (
                    origin.scheme == "https"
                    or (local and origin.scheme == "http" and self.app_env != "production")
                )
            ):
                raise ValueError(
                    "Customer origin must be an HTTPS origin (HTTP only for local development)."
                )
        if self.session_backend == "firestore" and not self.google_cloud_project:
            raise ValueError("Firestore requires an explicit project.")
        if self.coach_mode == "gemini":
            if not (self.google_text_model and self.google_live_model):
                raise ValueError("Gemini mode requires explicit text/live model IDs.")
            if self.gemini_backend == "vertex" and not self.google_cloud_project:
                raise ValueError("Vertex Gemini requires an explicit project.")
            if self.gemini_backend == "api_key" and not self.google_api_key.get_secret_value():
                raise ValueError("API-key Gemini requires a server key.")
        if self.maps_grounding == "live":
            if not (self.maps_grounding_model or self.google_text_model):
                raise ValueError("Maps grounding requires an explicit model ID.")
            if self.gemini_backend == "vertex" and not self.google_cloud_project:
                raise ValueError("Maps grounding on Vertex requires an explicit project.")
            if self.gemini_backend == "api_key" and not self.google_api_key.get_secret_value():
                raise ValueError("API-key Maps grounding requires a server key.")
        if self.app_env == "production":
            if self.v1_enabled and self.merchant_backend != "firestore":
                raise ValueError("Production merchant records require the Firestore adapter.")
            if self.v1_enabled and (self.moderation_mode != "vision" or not self.media_bucket):
                raise ValueError(
                    "Production photos require Vision moderation and a private bucket."
                )
            if self.auth_mode != "firebase" or not self.google_cloud_project:
                raise ValueError("Production requires Firebase identity and an explicit project.")
            if self.session_backend != "firestore":
                raise ValueError("Production requires the durable Firestore session adapter.")
            if not all(
                (self.firebase_web_api_key, self.firebase_web_app_id, self.firebase_auth_domain)
            ):
                raise ValueError("Production requires dedicated Firebase browser configuration.")
            if os.getenv("FIRESTORE_EMULATOR_HOST") or os.getenv("FIREBASE_AUTH_EMULATOR_HOST"):
                raise ValueError("Production cannot use local identity or database emulators.")
            if self.face_mode == "fixture" or "*" in self.trust_admins:
                raise ValueError("Production cannot use the face fixture or open trust reviews.")
            if not self.allowed_origins or any(
                not url.startswith("https://") for url in self.allowed_origins
            ):
                raise ValueError("Production requires explicit HTTPS origins.")
        return self
