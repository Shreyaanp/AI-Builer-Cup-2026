"""Public, typed visibility switches. These never grant account/business authority."""

from pydantic import BaseModel, ConfigDict


class FeatureFlags(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    google_guide: bool = False
    guest_customer: bool = False
