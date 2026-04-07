"""Tests for the batch retry worker.

Covers the fix for issue #3: 401s are now non-retriable and the circuit
breaker short-circuits remaining deliveries for a partner after consecutive
auth failures.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from integrations_worker.batch_retry import BatchRetryWorker
from integrations_worker.circuit_breaker import PartnerCircuitBreaker
from integrations_worker.http_client import DeliveryResult, PartnerHttpClient
from integrations_worker.types import DeliveryStatus, PartnerConfig, WebhookDelivery


def _make_delivery(partner_id: str = "partner-1", delivery_id: str = "d-1") -> WebhookDelivery:
    return WebhookDelivery(
        delivery_id=delivery_id,
        partner_id=partner_id,
        endpoint_url="https://partner.example.com/webhook",
        payload={"event": "payment.completed"},
    )


def _make_worker(
    side_effects: list[DeliveryResult],
    max_retries: int = 5,
    circuit_breaker: PartnerCircuitBreaker | None = None,
) -> BatchRetryWorker:
    client = MagicMock(spec=PartnerHttpClient)
    client.deliver.side_effect = side_effects
    configs = {
        "partner-1": PartnerConfig(
            partner_id="partner-1",
            base_url="https://partner.example.com",
            api_key="test-key",
            max_retries=max_retries,
        ),
    }
    return BatchRetryWorker(
        http_client=client,
        partner_configs=configs,
        circuit_breaker=circuit_breaker,
    )


class TestBatchRetryWorker:
    def test_successful_delivery(self) -> None:
        worker = _make_worker([DeliveryResult(status_code=200, success=True)])
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.DELIVERED
        assert delivery.attempt_count == 1

    @patch("integrations_worker.batch_retry.wait_before_retry")
    def test_retry_then_succeed(self, _mock_wait: object) -> None:
        worker = _make_worker([
            DeliveryResult(status_code=500, success=False, error="HTTP 500"),
            DeliveryResult(status_code=200, success=True),
        ])
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.DELIVERED
        assert delivery.attempt_count == 2

    @patch("integrations_worker.batch_retry.wait_before_retry")
    def test_exhaust_retries(self, _mock_wait: object) -> None:
        worker = _make_worker(
            [DeliveryResult(status_code=500, success=False, error="HTTP 500")] * 6,
            max_retries=5,
        )
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.attempt_count == 5

    def test_unknown_partner_abandoned(self) -> None:
        worker = _make_worker([])
        delivery = _make_delivery(partner_id="unknown")

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.ABANDONED


class TestNonRetriable401:
    """Issue #3: 401 must fail immediately -- no retry, no hot loop."""

    def test_401_fails_on_first_attempt(self) -> None:
        """A 401 should fail the delivery immediately without retrying."""
        worker = _make_worker([
            DeliveryResult(status_code=401, success=False, error="HTTP 401"),
        ])
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.attempt_count == 1
        assert delivery.last_status_code == 401

    def test_403_fails_on_first_attempt(self) -> None:
        worker = _make_worker([
            DeliveryResult(status_code=403, success=False, error="HTTP 403"),
        ])
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.attempt_count == 1

    @patch("integrations_worker.batch_retry.wait_before_retry")
    def test_mid_run_401_stops_immediately(self, _mock_wait: object) -> None:
        """Simulates credential rotation mid-run: first call succeeds,
        then partner rotates creds and returns 401."""
        worker = _make_worker([
            DeliveryResult(status_code=500, success=False, error="HTTP 500"),
            DeliveryResult(status_code=401, success=False, error="HTTP 401"),
        ])
        delivery = _make_delivery()

        worker.process_batch([delivery])

        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.attempt_count == 2
        assert delivery.last_status_code == 401


class TestCircuitBreakerIntegration:
    """Circuit breaker trips after consecutive auth failures and skips
    remaining deliveries for that partner."""

    def test_circuit_breaker_trips_after_consecutive_401s(self) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        # 3 deliveries each getting a 401 -> breaker trips on 3rd
        responses = [
            DeliveryResult(status_code=401, success=False, error="HTTP 401"),
        ] * 5  # extra in case called
        worker = _make_worker(responses, circuit_breaker=cb)

        deliveries = [_make_delivery(delivery_id=f"d-{i}") for i in range(5)]
        worker.process_batch(deliveries)

        # First 3 get HTTP calls (each fails with 401 on attempt 1).
        # After the 3rd, the breaker is open and remaining are skipped.
        for d in deliveries[:3]:
            assert d.status == DeliveryStatus.FAILED
            assert d.attempt_count == 1

        for d in deliveries[3:]:
            assert d.status == DeliveryStatus.FAILED
            assert d.last_error == "circuit_breaker_open"
            assert d.attempt_count == 0  # never attempted

    @patch("integrations_worker.batch_retry.wait_before_retry")
    def test_circuit_breaker_does_not_trip_on_5xx(self, _mock_wait: object) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        responses = [
            DeliveryResult(status_code=500, success=False, error="HTTP 500"),
        ] * 6
        worker = _make_worker(responses, max_retries=5, circuit_breaker=cb)

        delivery = _make_delivery()
        worker.process_batch([delivery])

        # 5xx errors should exhaust retries normally, not trip the breaker.
        assert delivery.status == DeliveryStatus.FAILED
        assert delivery.attempt_count == 5
        assert cb.is_open("partner-1") is False

    def test_mixed_partners_only_affected_partner_tripped(self) -> None:
        cb = PartnerCircuitBreaker(threshold=2)
        client = MagicMock(spec=PartnerHttpClient)

        # partner-1 always returns 401, partner-2 always returns 200
        def deliver_side_effect(url: str, payload: dict, api_key: str) -> DeliveryResult:
            if api_key == "key-1":
                return DeliveryResult(status_code=401, success=False, error="HTTP 401")
            return DeliveryResult(status_code=200, success=True)

        client.deliver.side_effect = deliver_side_effect
        configs = {
            "partner-1": PartnerConfig(
                partner_id="partner-1",
                base_url="https://p1.example.com",
                api_key="key-1",
                max_retries=5,
            ),
            "partner-2": PartnerConfig(
                partner_id="partner-2",
                base_url="https://p2.example.com",
                api_key="key-2",
                max_retries=5,
            ),
        }
        worker = BatchRetryWorker(
            http_client=client, partner_configs=configs, circuit_breaker=cb,
        )

        deliveries = [
            _make_delivery(partner_id="partner-1", delivery_id="d-1"),
            _make_delivery(partner_id="partner-1", delivery_id="d-2"),
            _make_delivery(partner_id="partner-1", delivery_id="d-3"),
            _make_delivery(partner_id="partner-2", delivery_id="d-4"),
        ]
        worker.process_batch(deliveries)

        # partner-1: first 2 fail with 401, breaker trips, 3rd skipped
        assert deliveries[0].status == DeliveryStatus.FAILED
        assert deliveries[1].status == DeliveryStatus.FAILED
        assert deliveries[2].status == DeliveryStatus.FAILED
        assert deliveries[2].last_error == "circuit_breaker_open"

        # partner-2: unaffected, succeeds normally
        assert deliveries[3].status == DeliveryStatus.DELIVERED
