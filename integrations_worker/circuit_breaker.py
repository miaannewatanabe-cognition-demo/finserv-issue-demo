"""Per-partner circuit breaker for the batch retry worker.

When a partner endpoint returns a consecutive streak of non-retriable auth
errors (401/403), the circuit breaker trips and short-circuits the remaining
deliveries for that partner in the current batch run.  This prevents the
worker from burning CPU sending requests that are guaranteed to fail.

Fixes #3.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# How many consecutive auth failures before the breaker trips.
DEFAULT_AUTH_FAILURE_THRESHOLD = 3

# Status codes considered authentication / authorisation failures.
AUTH_FAILURE_CODES: frozenset[int] = frozenset({401, 403})


class PartnerCircuitBreaker:
    """Tracks consecutive auth failures per partner and trips when threshold is hit."""

    def __init__(self, threshold: int = DEFAULT_AUTH_FAILURE_THRESHOLD) -> None:
        self.threshold = threshold
        # partner_id -> consecutive auth failure count
        self._failure_counts: dict[str, int] = {}
        # partner_id -> True if tripped
        self._tripped: dict[str, bool] = {}

    def record_result(self, partner_id: str, status_code: int) -> None:
        """Record a delivery result for the given partner.

        Increments the consecutive auth-failure counter on 401/403, resets it
        on any other status.  Trips the breaker when the threshold is reached.
        """
        if status_code in AUTH_FAILURE_CODES:
            count = self._failure_counts.get(partner_id, 0) + 1
            self._failure_counts[partner_id] = count
            if count >= self.threshold and not self._tripped.get(partner_id, False):
                self._tripped[partner_id] = True
                logger.warning(
                    "Circuit breaker tripped for partner %s after %d consecutive "
                    "auth failures (last status %d) -- skipping remaining deliveries",
                    partner_id,
                    count,
                    status_code,
                )
        else:
            # Any non-auth response resets the counter.
            self._failure_counts[partner_id] = 0

    def is_open(self, partner_id: str) -> bool:
        """Return True if the breaker is tripped (open) for *partner_id*."""
        return self._tripped.get(partner_id, False)

    def reset(self, partner_id: str | None = None) -> None:
        """Reset the breaker for one or all partners."""
        if partner_id is not None:
            self._failure_counts.pop(partner_id, None)
            self._tripped.pop(partner_id, None)
        else:
            self._failure_counts.clear()
            self._tripped.clear()
