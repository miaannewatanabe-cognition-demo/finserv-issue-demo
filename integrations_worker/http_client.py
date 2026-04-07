"""HTTP client for partner API calls."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import requests

logger = logging.getLogger(__name__)


@dataclass
class DeliveryResult:
    """Result of a single webhook delivery attempt."""

    status_code: int
    success: bool
    error: str | None = None


class PartnerHttpClient:
    """HTTP client that sends webhook payloads to partner endpoints."""

    def __init__(self, timeout: int = 30) -> None:
        self.timeout = timeout
        self.session = requests.Session()

    def deliver(self, endpoint_url: str, payload: dict, api_key: str) -> DeliveryResult:
        """Send a webhook payload to a partner endpoint.

        Returns a DeliveryResult with the HTTP status code and success flag.
        """
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        try:
            response = self.session.post(
                endpoint_url,
                json=payload,
                headers=headers,
                timeout=self.timeout,
            )
            success = 200 <= response.status_code < 300
            error = None if success else f"HTTP {response.status_code}"
            return DeliveryResult(
                status_code=response.status_code,
                success=success,
                error=error,
            )
        except requests.Timeout:
            logger.warning("Request to %s timed out", endpoint_url)
            return DeliveryResult(status_code=0, success=False, error="timeout")
        except requests.ConnectionError as exc:
            logger.warning("Connection error to %s: %s", endpoint_url, exc)
            return DeliveryResult(status_code=0, success=False, error="connection_error")
        except requests.RequestException as exc:
            logger.error("Request error to %s: %s", endpoint_url, exc)
            return DeliveryResult(status_code=0, success=False, error=str(exc))
