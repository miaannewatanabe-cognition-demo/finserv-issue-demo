"""Batch retry worker for failed webhook deliveries.

Picks up pending/failed deliveries and re-attempts them in a loop.
Uses a per-partner circuit breaker to short-circuit remaining deliveries
when consecutive auth failures (401/403) indicate a credential rotation.

Fixes #3.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from integrations_worker.circuit_breaker import PartnerCircuitBreaker
from integrations_worker.http_client import PartnerHttpClient
from integrations_worker.retry_policy import should_retry, wait_before_retry
from integrations_worker.types import DeliveryStatus, PartnerConfig, WebhookDelivery

logger = logging.getLogger(__name__)


class BatchRetryWorker:
    """Processes a batch of webhook deliveries, retrying failures.

    Integrates a ``PartnerCircuitBreaker`` so that when a partner's
    credentials are rotated mid-run, the worker stops hammering the
    endpoint and fails remaining deliveries for that partner immediately.
    """

    def __init__(
        self,
        http_client: PartnerHttpClient,
        partner_configs: dict[str, PartnerConfig],
        circuit_breaker: PartnerCircuitBreaker | None = None,
    ) -> None:
        self.http_client = http_client
        self.partner_configs = partner_configs
        self.circuit_breaker = circuit_breaker or PartnerCircuitBreaker()

    def process_batch(self, deliveries: list[WebhookDelivery]) -> list[WebhookDelivery]:
        """Retry every delivery in *deliveries* until success or budget exhaustion.

        Deliveries whose partner circuit breaker has tripped are failed
        immediately without an HTTP call.

        Returns the list with updated statuses.
        """
        for delivery in deliveries:
            if self.circuit_breaker.is_open(delivery.partner_id):
                delivery.status = DeliveryStatus.FAILED
                delivery.last_error = "circuit_breaker_open"
                logger.info(
                    "Skipping delivery %s — circuit breaker open for partner %s",
                    delivery.delivery_id,
                    delivery.partner_id,
                )
                continue
            self._process_one(delivery)
        return deliveries

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _process_one(self, delivery: WebhookDelivery) -> None:
        partner_cfg = self.partner_configs.get(delivery.partner_id)
        if partner_cfg is None:
            logger.error("No config for partner %s, abandoning delivery %s",
                         delivery.partner_id, delivery.delivery_id)
            delivery.status = DeliveryStatus.ABANDONED
            return

        max_retries = partner_cfg.max_retries

        while True:
            delivery.attempt_count += 1
            result = self.http_client.deliver(
                delivery.endpoint_url,
                delivery.payload,
                partner_cfg.api_key,
            )
            delivery.last_status_code = result.status_code
            delivery.last_error = result.error
            delivery.updated_at = datetime.now(timezone.utc)

            self.circuit_breaker.record_result(delivery.partner_id, result.status_code)

            if result.success:
                delivery.status = DeliveryStatus.DELIVERED
                logger.info("Delivery %s succeeded on attempt %d",
                            delivery.delivery_id, delivery.attempt_count)
                return

            # Non-retriable status (401, 403, etc.) or budget exhausted → fail.
            if not should_retry(result.status_code, delivery.attempt_count, max_retries):
                delivery.status = DeliveryStatus.FAILED
                logger.warning(
                    "Delivery %s failed after %d attempts (last status %s)",
                    delivery.delivery_id, delivery.attempt_count, result.status_code,
                )
                return

            # Circuit breaker may have tripped during this attempt.
            if self.circuit_breaker.is_open(delivery.partner_id):
                delivery.status = DeliveryStatus.FAILED
                delivery.last_error = "circuit_breaker_open"
                logger.warning(
                    "Delivery %s aborted — circuit breaker tripped for partner %s",
                    delivery.delivery_id,
                    delivery.partner_id,
                )
                return

            logger.debug(
                "Delivery %s attempt %d failed (%s), retrying…",
                delivery.delivery_id, delivery.attempt_count, result.status_code,
            )
            wait_before_retry(delivery.attempt_count)
