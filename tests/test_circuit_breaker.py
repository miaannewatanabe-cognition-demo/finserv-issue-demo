"""Tests for the per-partner circuit breaker."""

from __future__ import annotations

from integrations_worker.circuit_breaker import PartnerCircuitBreaker


class TestPartnerCircuitBreaker:
    def test_not_tripped_initially(self) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        assert cb.is_open("partner-1") is False

    def test_trips_after_threshold_consecutive_401s(self) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        for _ in range(3):
            cb.record_result("partner-1", 401)
        assert cb.is_open("partner-1") is True

    def test_trips_on_403_as_well(self) -> None:
        cb = PartnerCircuitBreaker(threshold=2)
        cb.record_result("partner-1", 403)
        cb.record_result("partner-1", 403)
        assert cb.is_open("partner-1") is True

    def test_non_auth_error_resets_counter(self) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        # A 500 resets the consecutive auth failure counter.
        cb.record_result("partner-1", 500)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        assert cb.is_open("partner-1") is False

    def test_success_resets_counter(self) -> None:
        cb = PartnerCircuitBreaker(threshold=3)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 200)
        cb.record_result("partner-1", 401)
        assert cb.is_open("partner-1") is False

    def test_independent_per_partner(self) -> None:
        cb = PartnerCircuitBreaker(threshold=2)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        assert cb.is_open("partner-1") is True
        assert cb.is_open("partner-2") is False

    def test_reset_single_partner(self) -> None:
        cb = PartnerCircuitBreaker(threshold=2)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        assert cb.is_open("partner-1") is True
        cb.reset("partner-1")
        assert cb.is_open("partner-1") is False

    def test_reset_all(self) -> None:
        cb = PartnerCircuitBreaker(threshold=2)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-1", 401)
        cb.record_result("partner-2", 403)
        cb.record_result("partner-2", 403)
        cb.reset()
        assert cb.is_open("partner-1") is False
        assert cb.is_open("partner-2") is False
