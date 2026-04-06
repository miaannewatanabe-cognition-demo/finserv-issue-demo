"""Keyboard-shortcut driven admin console for approving staged payouts.

Provides a ``KeyboardShortcutHandler`` that maps single-key shortcuts to
payout approval actions, and a ``PayoutApprovalConsole`` that applies those
actions to a queue of staged payouts.

Closes #2.
"""

from __future__ import annotations

import enum
import logging
from datetime import datetime, timezone
from typing import Callable

from integrations_worker.types import PayoutStatus, StagedPayout

logger = logging.getLogger(__name__)


class PayoutAction(enum.Enum):
    """Actions an operator can take on a staged payout."""

    APPROVE = "approve"
    REJECT = "reject"
    SKIP = "skip"
    APPROVE_ALL = "approve_all"
    REJECT_ALL = "reject_all"


# Default keyboard shortcut mapping.
DEFAULT_SHORTCUTS: dict[str, PayoutAction] = {
    "a": PayoutAction.APPROVE,
    "r": PayoutAction.REJECT,
    "s": PayoutAction.SKIP,
    "A": PayoutAction.APPROVE_ALL,
    "R": PayoutAction.REJECT_ALL,
}


class KeyboardShortcutHandler:
    """Maps single-key presses to ``PayoutAction`` values.

    Supports registering custom shortcut bindings and looking up the action
    for a given key press.
    """

    def __init__(self, shortcuts: dict[str, PayoutAction] | None = None) -> None:
        self._shortcuts: dict[str, PayoutAction] = dict(shortcuts or DEFAULT_SHORTCUTS)

    @property
    def shortcuts(self) -> dict[str, PayoutAction]:
        """Return a copy of the current shortcut bindings."""
        return dict(self._shortcuts)

    def bind(self, key: str, action: PayoutAction) -> None:
        """Bind *key* to *action*, replacing any previous binding for *key*."""
        if len(key) != 1:
            raise ValueError(f"Shortcut key must be a single character, got {key!r}")
        self._shortcuts[key] = action
        logger.debug("Bound key %r → %s", key, action.value)

    def unbind(self, key: str) -> None:
        """Remove the binding for *key*.  No-op if *key* is not bound."""
        self._shortcuts.pop(key, None)

    def lookup(self, key: str) -> PayoutAction | None:
        """Return the action bound to *key*, or ``None`` if unbound."""
        return self._shortcuts.get(key)


class PayoutApprovalConsole:
    """Processes a queue of staged payouts using keyboard shortcut actions.

    This class encapsulates the approval logic.  It does **not** perform
    terminal I/O itself — callers feed key-presses via ``handle_key`` or
    invoke ``apply_action`` directly so the logic remains testable without
    a live terminal.
    """

    def __init__(
        self,
        payouts: list[StagedPayout],
        operator: str,
        shortcut_handler: KeyboardShortcutHandler | None = None,
        on_status_change: Callable[[StagedPayout, PayoutStatus], None] | None = None,
    ) -> None:
        self._payouts = list(payouts)
        self._operator = operator
        self._handler = shortcut_handler or KeyboardShortcutHandler()
        self._cursor = 0
        self._on_status_change = on_status_change

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def payouts(self) -> list[StagedPayout]:
        return list(self._payouts)

    @property
    def cursor(self) -> int:
        return self._cursor

    @property
    def current_payout(self) -> StagedPayout | None:
        """Return the payout at the cursor, or ``None`` if the queue is exhausted."""
        if self._cursor >= len(self._payouts):
            return None
        return self._payouts[self._cursor]

    @property
    def pending_count(self) -> int:
        """Number of payouts still in STAGED status."""
        return sum(1 for p in self._payouts if p.status == PayoutStatus.STAGED)

    # ------------------------------------------------------------------
    # Key handling
    # ------------------------------------------------------------------

    def handle_key(self, key: str) -> PayoutAction | None:
        """Look up the action for *key* and apply it.

        Returns the ``PayoutAction`` that was applied, or ``None`` if the
        key is not bound to any action.
        """
        action = self._handler.lookup(key)
        if action is None:
            logger.debug("Unbound key %r ignored", key)
            return None
        self.apply_action(action)
        return action

    def apply_action(self, action: PayoutAction) -> None:
        """Apply *action* to the current payout (or all remaining payouts)."""
        if action == PayoutAction.APPROVE_ALL:
            self._approve_all_remaining()
        elif action == PayoutAction.REJECT_ALL:
            self._reject_all_remaining()
        elif action == PayoutAction.SKIP:
            self._advance_cursor()
        elif action in (PayoutAction.APPROVE, PayoutAction.REJECT):
            payout = self.current_payout
            if payout is None:
                logger.info("No more payouts to process")
                return
            new_status = (
                PayoutStatus.APPROVED if action == PayoutAction.APPROVE else PayoutStatus.REJECTED
            )
            self._set_status(payout, new_status)
            self._advance_cursor()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _set_status(self, payout: StagedPayout, status: PayoutStatus) -> None:
        payout.status = status
        payout.reviewed_at = datetime.now(timezone.utc)
        payout.reviewed_by = self._operator
        logger.info(
            "Payout %s %s by %s", payout.payout_id, status.value, self._operator,
        )
        if self._on_status_change is not None:
            self._on_status_change(payout, status)

    def _advance_cursor(self) -> None:
        if self._cursor < len(self._payouts):
            self._cursor += 1

    def _approve_all_remaining(self) -> None:
        for payout in self._payouts[self._cursor:]:
            if payout.status == PayoutStatus.STAGED:
                self._set_status(payout, PayoutStatus.APPROVED)
        self._cursor = len(self._payouts)

    def _reject_all_remaining(self) -> None:
        for payout in self._payouts[self._cursor:]:
            if payout.status == PayoutStatus.STAGED:
                self._set_status(payout, PayoutStatus.REJECTED)
        self._cursor = len(self._payouts)
