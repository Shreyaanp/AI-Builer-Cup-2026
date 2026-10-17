import hashlib
import secrets
from dataclasses import dataclass
from pathlib import Path

import anyio
import firebase_admin
from fastapi import HTTPException, Request, Response, WebSocket
from firebase_admin import auth as firebase_auth
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .settings import Settings

COOKIE = "ogoogle_preview_session"


@dataclass(frozen=True)
class Principal:
    uid: str
    source: str
    # Verified Google profile fields; used only for a customer's display name and reply contact.
    email: str = ""
    name: str = ""
    guest: bool = False


CUSTOMER_COOKIE = "chalkboard_customer"


def guest_principal(uid: str, source: str) -> Principal:
    label = hashlib.sha256(uid.encode()).hexdigest()
    return Principal(uid, source, label + "@guest.invalid", "Guest " + label[:6], True)


class IdentityService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        secret = settings.session_signing_secret.get_secret_value()
        if not secret and settings.app_env == "local":
            path = Path("data/local-session.key")
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
            secret = path.read_text(encoding="utf-8")
        self.signer = URLSafeTimedSerializer(secret or secrets.token_urlsafe(32), salt="preview")
        self.firebase_app = (
            firebase_admin.initialize_app(
                options={"projectId": settings.google_cloud_project}, name=secrets.token_hex(8)
            )
            if settings.auth_mode == "firebase"
            else None
        )

    def bootstrap(self, request: Request, response: Response) -> dict[str, object]:
        if self.settings.auth_mode != "local":
            return {
                "auth_mode": "firebase",
                "firebase": {
                    "apiKey": self.settings.firebase_web_api_key,
                    "appId": self.settings.firebase_web_app_id,
                    "authDomain": self.settings.firebase_auth_domain,
                    "projectId": self.settings.google_cloud_project,
                },
            }
        try:
            self.local_principal(request.cookies.get(COOKIE))
        except HTTPException:
            response.set_cookie(
                COOKIE,
                self.signer.dumps(secrets.token_urlsafe(24)),
                httponly=True,
                samesite="strict",
                secure=self.settings.app_env == "production",
                max_age=86400,
            )
        return {"auth_mode": "local", "status": "private development session"}

    def local_principal(self, cookie: str | None) -> Principal:
        try:
            uid = self.signer.loads(cookie or "", max_age=86400)
            if not isinstance(uid, str) or not uid:
                raise BadSignature("Invalid preview identity")
            return Principal(uid, "local")
        except BadSignature as error:
            raise HTTPException(401, "Start a private session first.") from error

    async def bearer_principal(self, token: str, *, customer: bool = False) -> Principal:
        if not token or len(token) > 8192:
            raise HTTPException(401, "A valid sign-in token is required.")
        try:
            claims = await anyio.to_thread.run_sync(
                lambda: firebase_auth.verify_id_token(token, app=self.firebase_app)
            )
            if (
                customer
                and self.settings.guest_customer
                and claims.get("firebase", {}).get("sign_in_provider") == "anonymous"
            ):
                uid = str(claims["uid"])
                return guest_principal(uid, "firebase")
            if claims.get("firebase", {}).get("sign_in_provider") != "google.com" or not claims.get(
                "email_verified"
            ):
                raise HTTPException(403, "Use a verified Google sign-in for this app.")
            return Principal(
                str(claims["uid"]),
                "firebase",
                str(claims.get("email", ""))[:254],
                str(claims.get("name", ""))[:100],
            )
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(401, "Sign-in token could not be verified.") from error

    async def require(self, request: Request) -> Principal:
        if self.settings.auth_mode == "local":
            return self.local_principal(request.cookies.get(COOKIE))
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Sign in before starting a conversation.")
        return await self.bearer_principal(authorization[7:])

    # Customer identity is separate from owner authority; anonymous access is feature-gated.
    # Local mode stands in for Google with an explicit signed cookie, so the gate is real in tests.
    def customer_signer(self) -> URLSafeTimedSerializer:
        return URLSafeTimedSerializer(self.signer.secret_key, salt="customer")

    def start_local_customer(
        self, response: Response, name: str, prior: Principal | None = None, *, guest: bool = False
    ) -> Principal:
        if self.settings.auth_mode != "local":
            raise HTTPException(404, "Use Google sign-in.")
        principal = Principal(
            prior.uid if prior else "local-customer-" + secrets.token_hex(8),
            "local",
            "customer@example.test",
            name,
            guest,
        )
        if guest:
            principal = guest_principal(principal.uid, "local")
        response.set_cookie(
            CUSTOMER_COOKIE,
            self.customer_signer().dumps([principal.uid, principal.name, principal.guest]),
            httponly=True,
            samesite="strict",
            secure=self.settings.app_env == "production",
            max_age=30 * 86400,
        )
        return principal

    async def customer(self, request: Request) -> Principal | None:
        if self.settings.auth_mode == "local":
            try:
                values = self.customer_signer().loads(
                    request.cookies.get(CUSTOMER_COOKIE, ""), max_age=30 * 86400
                )
                uid, name = values[:2]
                guest = bool(values[2]) if len(values) > 2 else False
                if guest and not self.settings.guest_customer:
                    return None
                if guest:
                    return guest_principal(str(uid), "local")
                email = "customer@example.test"
                return Principal(str(uid), "local", email, str(name), guest)
            except (BadSignature, ValueError, TypeError):
                return None
        authorization = request.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            return None
        return await self.bearer_principal(authorization[7:], customer=True)

    async def require_customer(self, request: Request) -> Principal:
        principal = await self.customer(request)
        if principal is None:
            raise HTTPException(401, "SIGN_IN_REQUIRED")
        return principal

    async def require_websocket(self, websocket: WebSocket) -> Principal:
        if self.settings.auth_mode == "local":
            return self.local_principal(websocket.cookies.get(COOKIE))
        # Browsers cannot attach an Authorization header to a WebSocket.
        # Authenticate in the first bounded frame, never in a logged URL query.
        first = await websocket.receive_text()
        if len(first) > 10_000:
            raise HTTPException(401, "Authentication frame too large.")
        from pydantic import BaseModel, ConfigDict, Field

        class Authentication(BaseModel):
            model_config = ConfigDict(extra="forbid")
            kind: str = Field(pattern="^authenticate$")
            token: str = Field(max_length=8192)

        try:
            return await self.bearer_principal(Authentication.model_validate_json(first).token)
        except ValueError as error:
            raise HTTPException(401, "Authentication required.") from error

    def close(self) -> None:
        if self.firebase_app:
            firebase_admin.delete_app(self.firebase_app)
