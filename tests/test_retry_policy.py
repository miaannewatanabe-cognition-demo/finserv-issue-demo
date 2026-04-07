"""Tests for retry policy -- verifies non-retriable classification and backoff."""

from __future__ import annotations

from unittest.mock import patch

from integrations_worker.retry_policy import (
    compute_backoff,
    is_retriable_status,
    should_retry,
)


class TestIsRetriableStatus:
    """401/403 and other 4xx must NOT be retriable; 5xx and network errors must."""

    def test_401_not_retriable(self) -> None:
        assert is_retriable_status(401) is False

    def test_403_not_retriable(self) -> None:
        assert is_retriable_status(403) is False

    def test_400_not_retriable(self) -> None:
        assert is_retriable_status(400) is False

    def test_404_not_retriable(self) -> None:
        assert is_retriable_status(404) is False

    def test_422_not_retriable(self) -> None:
        assert is_retriable_status(422) is False

    def test_429_is_retriable(self) -> None:
        assert is_retriable_status(429) is True

    def test_500_is_retriable(self) -> None:
        assert is_retriable_status(500) is True

    def test_502_is_retriable(self) -> None:
        assert is_retriable_status(502) is True

    def test_503_is_retriable(self) -> None:
        assert is_retriable_status(503) is True

    def test_network_failure_zero_is_retriable(self) -> None:
        assert is_retriable_status(0) is True

    def test_200_not_retriable(self) -> None:
        assert is_retriable_status(200) is False


class TestShouldRetry:
    def test_retriable_within_budget(self) -> None:
        assert should_retry(500, attempt=1, max_retries=5) is True

    def test_retriable_at_budget_limit(self) -> None:
        assert should_retry(500, attempt=5, max_retries=5) is False

    def test_non_retriable_ignores_budget(self) -> None:
        assert should_retry(401, attempt=1, max_retries=5) is False


class TestComputeBackoff:
    @patch("integrations_worker.retry_policy.random.random", return_value=0.5)
    def test_first_attempt_base_backoff(self, _mock_random: object) -> None:
        # With jitter factor 0.25 and random()=0.5 -> jitter = 0
        delay = compute_backoff(attempt=1)
        assert delay == 1.0  # BASE_BACKOFF_SECONDS

    @patch("integrations_worker.retry_policy.random.random", return_value=0.5)
    def test_second_attempt_doubles(self, _mock_random: object) -> None:
        delay = compute_backoff(attempt=2)
        assert delay == 2.0

    @patch("integrations_worker.retry_policy.random.random", return_value=0.5)
    def test_capped_at_max(self, _mock_random: object) -> None:
        delay = compute_backoff(attempt=100)
        assert delay == 60.0  # MAX_BACKOFF_SECONDS

    def test_always_non_negative(self) -> None:
        for attempt in range(1, 20):
            assert compute_backoff(attempt) >= 0.0
