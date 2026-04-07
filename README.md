# finserv-issue-demo

Enterprise integrations worker for processing webhook deliveries to partner endpoints.

## Structure

```
integrations_worker/
  batch_retry.py      — Batch retry worker for failed webhook deliveries
  circuit_breaker.py  — Per-partner circuit breaker for auth failure detection
  http_client.py      — HTTP client for partner API calls
  retry_policy.py     — Retry/backoff configuration
  types.py            — Data types
tests/
  test_batch_retry.py — Tests for the batch retry worker
  test_circuit_breaker.py — Tests for the circuit breaker
  test_retry_policy.py — Tests for retry policy
```

## Setup

```bash
python -m pip install -r requirements.txt
```

## Running Tests

```bash
python -m pytest tests/ -v
```

## Lint

```bash
python -m ruff check .
```
