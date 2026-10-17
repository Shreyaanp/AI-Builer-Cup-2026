from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .merchant import NewShopDraft


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CoachTurn(StrictModel):
    message: str = Field(min_length=1, max_length=2000)
    # BCP 47 tag of the owner's UI language (e.g. en, hi, es-MX, pt-BR). The coach still replies
    # in whatever language the owner actually writes in.
    language: str = Field(default="en", pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$")
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    session_id: UUID | None = None
    business_id: UUID | None = None
    new_shop: bool = False
    new_shop_draft: NewShopDraft | None = None

    @model_validator(mode="after")
    def separate_new_shop(self) -> "CoachTurn":
        if self.new_shop and self.business_id is not None:
            raise ValueError("New shop mode cannot edit an existing business.")
        if self.new_shop_draft is not None and not self.new_shop:
            raise ValueError("A new shop draft needs new shop mode.")
        return self

    @field_validator("message")
    @classmethod
    def require_content(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Add a message before sending.")
        return cleaned


class VoiceControl(StrictModel):
    # client_error: the app reports why it gave up (mic blocked, audio failed), so the
    # failure is visible in server logs instead of a silent "Voice connection ended".
    kind: Literal["text", "audio_end", "close", "ping", "pong", "client_error"]
    text: str = Field(default="", max_length=2000)


class NewShopVoiceContext(StrictModel):
    kind: Literal["new_shop"]
    draft: NewShopDraft | None = None


class BusinessProposal(StrictModel):
    name: str = Field(min_length=1, max_length=180)
    category: str = Field(min_length=1, max_length=180)
    location: str = Field(min_length=1, max_length=180)


class StreamEvent(StrictModel):
    kind: Literal[
        "ready",
        "delta",
        "reply",
        "turn_complete",
        "error",
        "interrupted",
        "input_transcript",
        "output_transcript",
        "audio_format",
        "pong",
        "ping",
        "proposal",
        # The saved new-shop draft, when the server knows more than the app (a resumed draft).
        "draft",
        "workflow",
        # Sourcing: the "Searching nearby suppliers…" state, supplier cards, an order card.
        "sourcing",
        "suppliers",
        "order",
        "rescue_proposal",
        # Supply chain: a purchase order drafted from the forecast, a supplier rule change.
        "purchase_order",
        "supply_rules",
        # Partner documents in and out: an order, the inbound list, or a document's SAP view.
        "supply",
        # A chart card (forecast, or how business is going) built from the tool result.
        "chart",
        # An app action from the coach: open a screen, or a prepared customer reply to send.
        "action",
        # A UPI payment link card the owner shares; the app never handles money.
        "payment_link",
    ]
    session_id: str | None = None
    text: str | None = None
    code: str | None = None
    mode: Literal["offline", "gemini"] | None = None
    sample_rate: int | None = None
    data: dict[str, object] | None = None

    def payload(self) -> dict[str, object]:
        return self.model_dump(exclude_none=True)
