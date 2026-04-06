"""Retry and back-off policy for webhook delivery.

Classifies HTTP responses into retriable vs. non-retriable categories and
applies exponential back-off with jitter for retriable failures.

Non-retriable status codes (4xx auth/client errors) are failed immediately
so the worker never hot-loops when a partner rotates credentials.

Fixes #3.
"""

from __future__ import annotations

import logging
import random
import time

logger = logging.getLogger(__name__)

# Status codes that must never be retried — the request itself is invalid
# or the credentials are wrong; repeating it won't help.
NON_RETRIABLE_STATUS_CODES: frozenset[int] = frozenset({
    400,  # Bad Request
    401,  # Unauthorized
    403,  # Forbidden
    404,  # Not Found
    405,  # Method Not Allowed
    409,  # Conflict
    410,  # Gone
    422,  # Unprocessable Entity
})

# Back-off parameters
BASE_BACKOFF_SECONDS: float = 1.0
MAX_BACKOFF_SECONDS: float = 60.0
BACKOFF_MULTIPLIER: float = 2.0
JITTER_FACTOR: float = 0.25  # ±25 % jitter


def is_retriable_status(status_code: int) -> bool:
    """Return True if the HTTP status indicates a retriable failure.

    Retriable: 5xx server errors, 429 (rate-limit), and network-level
    failures (status_code == 0).
    Non-retriable: 4xx client errors listed in NON_RETRIABLE_STATUS_CODES.
    """
    if status_code == 0:
        return True
    if status_code == 429:
        return True
    if status_code in NON_RETRIABLE_STATUS_CODES:
        return False
    if status_code >= 500:
        return True
    if 400 <= status_code < 500:
        return False
    return False


def should_retry(status_code: int, attempt: int, max_retries: int) -> bool:
    """Return True if the delivery should be retried.

    A delivery is retried only when the status is retriable AND the retry
    budget has not been exhausted.
    """
    if attempt >= max_retries:
        return False
    return is_retriable_status(status_code)


def compute_backoff(attempt: int) -> float:
    """Compute exponential back-off with jitter for *attempt* (1-indexed).

    Returns the number of seconds to sleep before the next attempt.
    """
    raw = BASE_BACKOFF_SECONDS * (BACKOFF_MULTIPLIER ** (attempt - 1))
    clamped = min(raw, MAX_BACKOFF_SECONDS)
    jitter = clamped * JITTER_FACTOR * (2 * random.random() - 1)  # noqa: S311
    return max(0.0, clamped + jitter)


def wait_before_retry(attempt: int) -> None:
    """Sleep with exponential back-off before the next retry attempt."""
    delay = compute_backoff(attempt)
    logger.debug("Backing off %.2f s before attempt %d", delay, attempt + 1)
    time.sleep(delay)
