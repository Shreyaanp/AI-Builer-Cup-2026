"""Generate an ephemeral Cloud Run environment file without printing its contents."""

import json
import os
from pathlib import Path

target = json.loads(Path("deployment/target.json").read_text())
required = ["FIREBASE_WEB_API_KEY", "FIREBASE_WEB_APP_ID", "FACE_WORKER_URL"]
if any(not os.getenv(name) for name in required):
    raise SystemExit("Required Firebase or private face worker configuration is missing.")
origin = f"https://{target['service']}-{target['projectNumber']}.{target['region']}.run.app"
config = {
    "APP_ENV": "production",
    "AUTH_MODE": "firebase",
    "SESSION_BACKEND": "firestore",
    "COACH_MODE": "gemini",
    "GEMINI_BACKEND": "vertex",
    # Chat + photo reading: the model the live coach evaluation passed with.
    "GOOGLE_CLOUD_LOCATION": "global",
    "GOOGLE_TEXT_MODEL": "gemini-3.5-flash",
    # Live voice models are regional (not served at `global`).
    "GOOGLE_LIVE_LOCATION": "us-central1",
    "GOOGLE_LIVE_MODEL": "gemini-3.8-live",
    "GOOGLE_EMBEDDING_LOCATION": "global",
    "V1_ENABLED": "true",
    "FEATURE_GOOGLE_GUIDE": os.environ.get("FEATURE_GOOGLE_GUIDE", "true"),
    "MERCHANT_BACKEND": "firestore",
    "MODERATION_MODE": "vision",
    # Make my icon: Gemini image model, at most 3 AI icons per shop per day.
    "SHOP_ICON_AI": "true",
    # Demand forecast with TimesFM in BigQuery (AI.FORECAST); owner approved, budget alert set.
    "FORECAST_BACKEND": "bigquery",
    # Till receipts (Expense parser) and supplier invoices (Invoice parser), Gemini as fallback.
    # Processors live in `us`: the Expense parser is not offered in asia-south1.
    "DOCUMENT_AI_ENABLED": "true",
    "DOCUMENT_AI_LOCATION": "us",
    "DOCUMENT_AI_RECEIPT_PROCESSOR": "c55114827549fb20",
    "DOCUMENT_AI_INVOICE_PROCESSOR": "cb3082fc49117ceb",
    # Owner analytics from BigQuery (chalkboard_analytics.shop_daily), exported nightly by
    # Cloud Scheduler job chalkboard-analytics-export with this service account's OIDC token.
    "ANALYTICS_BACKEND": "bigquery",
    "ANALYTICS_EXPORT_CALLER": f"ogoogle-analytics-scheduler@{target['projectId']}.iam.gserviceaccount.com",
    "ANALYTICS_EXPORT_AUDIENCE": origin,
    "MEDIA_BUCKET": "ichiropractic-shop-photos",
    "GOOGLE_CLOUD_PROJECT": target["projectId"],
    "FIRESTORE_DATABASE": target["firestoreDatabase"],
    "FIRESTORE_NAMESPACE": target["firestoreNamespace"],
    # Share links and QR codes made in the business app point customers here.
    "CUSTOMER_ORIGIN": "https://chalkboard.shreyaan.work",
    "GA_MEASUREMENT_ID": os.environ.get("GA_MEASUREMENT_ID", "").strip(),
    "ALLOWED_ORIGINS": json.dumps([origin, "https://chalkboard.shreyaan.work", "https://business.chalkboard.shreyaan.work"]),
    "FIREBASE_WEB_API_KEY": os.environ["FIREBASE_WEB_API_KEY"].strip(),
    "FIREBASE_WEB_APP_ID": os.environ["FIREBASE_WEB_APP_ID"].strip(),
    "FIREBASE_AUTH_DOMAIN": f"{target['projectId']}.firebaseapp.com",
    "RELEASE_COMMIT": os.environ.get("RELEASE_SHA", "local"),
    "MAX_ACTIVE_RUNS": "8",
    "MAX_TURN_SECONDS": "30",
    "MAX_VOICE_SECONDS": "120",
    "FACE_WORKER_URL": os.environ["FACE_WORKER_URL"].strip().rstrip("/"),
}
output = Path(".deployment/runtime.json")
if config["FEATURE_GOOGLE_GUIDE"] not in {"true", "false"}:
    raise SystemExit("FEATURE_GOOGLE_GUIDE must be true or false.")
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(config), encoding="utf-8")
print("Prepared ignored Cloud Run runtime configuration; Vertex Gemini uses the runtime identity.")
