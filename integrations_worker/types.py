"""Data types for the integrations worker."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import datetime, timezone


class DeliveryStatus(enum.Enum):
    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"
    ABANDONED = "abandoned"


@dataclass
class WebhookDelivery:
    """A single webhook delivery attempt record."""

    delivery_id: str
    partner_id: str
    endpoint_url: str
    payload: dict
    status: DeliveryStatus = DeliveryStatus.PENDING
    attempt_count: int = 0
    last_status_code: int | None = None
    last_error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class PayoutStatus(enum.Enum):
    STAGED = "staged"
    APPROVED = "approved"
    REJECTED = "rejected"


@dataclass
class StagedPayout:
    """A payout awaiting operator approval in the admin console."""

    payout_id: str
    partner_id: str
    amount_cents: int
    currency: str
    recipient: str
    status: PayoutStatus = PayoutStatus.STAGED
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None


@dataclass
class PartnerConfig:
    """Configuration for a partner integration."""

    partner_id: str
    base_url: str
    api_key: str
    max_retries: int = 5
