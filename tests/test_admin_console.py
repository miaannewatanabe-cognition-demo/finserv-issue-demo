"""Tests for the admin-console keyboard shortcut payout approval workflow.

Covers issue #2: operators can approve/reject staged payouts via single-key
shortcuts in the admin console.
"""

from __future__ import annotations

from integrations_worker.admin_console import (
    DEFAULT_SHORTCUTS,
    KeyboardShortcutHandler,
    PayoutAction,
    PayoutApprovalConsole,
)
from integrations_worker.types import PayoutStatus, StagedPayout


def _make_payout(payout_id: str = "p-1", amount_cents: int = 50000) -> StagedPayout:
    return StagedPayout(
        payout_id=payout_id,
        partner_id="partner-1",
        amount_cents=amount_cents,
        currency="USD",
        recipient="vendor@example.com",
    )


# ---------------------------------------------------------------
# KeyboardShortcutHandler
# ---------------------------------------------------------------


class TestKeyboardShortcutHandler:
    def test_default_shortcuts_loaded(self) -> None:
        handler = KeyboardShortcutHandler()
        assert handler.lookup("a") == PayoutAction.APPROVE
        assert handler.lookup("r") == PayoutAction.REJECT
        assert handler.lookup("s") == PayoutAction.SKIP
        assert handler.lookup("A") == PayoutAction.APPROVE_ALL
        assert handler.lookup("R") == PayoutAction.REJECT_ALL

    def test_unbound_key_returns_none(self) -> None:
        handler = KeyboardShortcutHandler()
        assert handler.lookup("z") is None

    def test_custom_binding(self) -> None:
        handler = KeyboardShortcutHandler()
        handler.bind("y", PayoutAction.APPROVE)
        assert handler.lookup("y") == PayoutAction.APPROVE

    def test_bind_replaces_existing(self) -> None:
        handler = KeyboardShortcutHandler()
        handler.bind("a", PayoutAction.REJECT)
        assert handler.lookup("a") == PayoutAction.REJECT

    def test_unbind_removes_key(self) -> None:
        handler = KeyboardShortcutHandler()
        handler.unbind("a")
        assert handler.lookup("a") is None

    def test_unbind_nonexistent_key_is_noop(self) -> None:
        handler = KeyboardShortcutHandler()
        handler.unbind("z")  # should not raise

    def test_bind_rejects_multichar_key(self) -> None:
        handler = KeyboardShortcutHandler()
        try:
            handler.bind("ab", PayoutAction.APPROVE)
            assert False, "Expected ValueError"
        except ValueError:
            pass

    def test_shortcuts_property_returns_copy(self) -> None:
        handler = KeyboardShortcutHandler()
        shortcuts = handler.shortcuts
        shortcuts["z"] = PayoutAction.APPROVE
        assert handler.lookup("z") is None

    def test_custom_initial_shortcuts(self) -> None:
        custom = {"x": PayoutAction.APPROVE, "q": PayoutAction.REJECT}
        handler = KeyboardShortcutHandler(shortcuts=custom)
        assert handler.lookup("x") == PayoutAction.APPROVE
        assert handler.lookup("q") == PayoutAction.REJECT
        assert handler.lookup("a") is None  # default not loaded


# ---------------------------------------------------------------
# PayoutApprovalConsole — single-payout actions
# ---------------------------------------------------------------


class TestPayoutApprovalSingleActions:
    def test_approve_via_shortcut(self) -> None:
        payout = _make_payout()
        console = PayoutApprovalConsole([payout], operator="ops@acme.com")

        action = console.handle_key("a")

        assert action == PayoutAction.APPROVE
        assert payout.status == PayoutStatus.APPROVED
        assert payout.reviewed_by == "ops@acme.com"
        assert payout.reviewed_at is not None

    def test_reject_via_shortcut(self) -> None:
        payout = _make_payout()
        console = PayoutApprovalConsole([payout], operator="ops@acme.com")

        action = console.handle_key("r")

        assert action == PayoutAction.REJECT
        assert payout.status == PayoutStatus.REJECTED
        assert payout.reviewed_by == "ops@acme.com"

    def test_skip_advances_cursor_without_changing_status(self) -> None:
        payouts = [_make_payout("p-1"), _make_payout("p-2")]
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")

        action = console.handle_key("s")

        assert action == PayoutAction.SKIP
        assert payouts[0].status == PayoutStatus.STAGED
        assert console.cursor == 1
        assert console.current_payout is not None
        assert console.current_payout.payout_id == "p-2"

    def test_unbound_key_returns_none_and_no_change(self) -> None:
        payout = _make_payout()
        console = PayoutApprovalConsole([payout], operator="ops@acme.com")

        action = console.handle_key("z")

        assert action is None
        assert payout.status == PayoutStatus.STAGED
        assert console.cursor == 0

    def test_action_on_empty_queue_is_noop(self) -> None:
        console = PayoutApprovalConsole([], operator="ops@acme.com")
        assert console.current_payout is None
        console.handle_key("a")  # should not raise


# ---------------------------------------------------------------
# PayoutApprovalConsole — bulk actions
# ---------------------------------------------------------------


class TestPayoutApprovalBulkActions:
    def test_approve_all_approves_remaining_staged(self) -> None:
        payouts = [_make_payout(f"p-{i}") for i in range(4)]
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")

        # Reject the first one manually, then approve-all the rest.
        console.handle_key("r")
        action = console.handle_key("A")

        assert action == PayoutAction.APPROVE_ALL
        assert payouts[0].status == PayoutStatus.REJECTED
        for p in payouts[1:]:
            assert p.status == PayoutStatus.APPROVED
            assert p.reviewed_by == "ops@acme.com"

    def test_reject_all_rejects_remaining_staged(self) -> None:
        payouts = [_make_payout(f"p-{i}") for i in range(3)]
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")

        action = console.handle_key("R")

        assert action == PayoutAction.REJECT_ALL
        for p in payouts:
            assert p.status == PayoutStatus.REJECTED

    def test_approve_all_skips_already_reviewed(self) -> None:
        payouts = [_make_payout(f"p-{i}") for i in range(3)]
        # Reject the first one, skip the second, approve-all.
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")
        console.handle_key("r")  # reject p-0
        console.handle_key("A")  # approve-all remaining

        assert payouts[0].status == PayoutStatus.REJECTED
        assert payouts[1].status == PayoutStatus.APPROVED
        assert payouts[2].status == PayoutStatus.APPROVED


# ---------------------------------------------------------------
# PayoutApprovalConsole — cursor behaviour
# ---------------------------------------------------------------


class TestPayoutApprovalCursor:
    def test_cursor_advances_through_queue(self) -> None:
        payouts = [_make_payout(f"p-{i}") for i in range(3)]
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")

        console.handle_key("a")
        assert console.cursor == 1
        console.handle_key("r")
        assert console.cursor == 2
        console.handle_key("a")
        assert console.cursor == 3
        assert console.current_payout is None

    def test_cursor_does_not_exceed_length(self) -> None:
        payout = _make_payout()
        console = PayoutApprovalConsole([payout], operator="ops@acme.com")
        console.handle_key("a")
        console.handle_key("a")  # past end, should be safe
        assert console.cursor == 1

    def test_pending_count_decreases(self) -> None:
        payouts = [_make_payout(f"p-{i}") for i in range(3)]
        console = PayoutApprovalConsole(payouts, operator="ops@acme.com")

        assert console.pending_count == 3
        console.handle_key("a")
        assert console.pending_count == 2
        console.handle_key("r")
        assert console.pending_count == 1


# ---------------------------------------------------------------
# PayoutApprovalConsole — callback integration
# ---------------------------------------------------------------


class TestPayoutApprovalCallback:
    def test_on_status_change_fires_for_each_action(self) -> None:
        changes: list[tuple[str, PayoutStatus]] = []

        def on_change(payout: StagedPayout, status: PayoutStatus) -> None:
            changes.append((payout.payout_id, status))

        payouts = [_make_payout(f"p-{i}") for i in range(2)]
        console = PayoutApprovalConsole(
            payouts, operator="ops@acme.com", on_status_change=on_change,
        )
        console.handle_key("a")
        console.handle_key("r")

        assert changes == [
            ("p-0", PayoutStatus.APPROVED),
            ("p-1", PayoutStatus.REJECTED),
        ]

    def test_on_status_change_fires_for_approve_all(self) -> None:
        changes: list[tuple[str, PayoutStatus]] = []

        def on_change(payout: StagedPayout, status: PayoutStatus) -> None:
            changes.append((payout.payout_id, status))

        payouts = [_make_payout(f"p-{i}") for i in range(3)]
        console = PayoutApprovalConsole(
            payouts, operator="ops@acme.com", on_status_change=on_change,
        )
        console.handle_key("A")

        assert len(changes) == 3
        assert all(status == PayoutStatus.APPROVED for _, status in changes)


# ---------------------------------------------------------------
# Default shortcuts sanity check
# ---------------------------------------------------------------


class TestDefaultShortcuts:
    def test_all_default_shortcuts_are_single_char(self) -> None:
        for key in DEFAULT_SHORTCUTS:
            assert len(key) == 1, f"Shortcut {key!r} is not a single character"

    def test_default_shortcuts_cover_core_actions(self) -> None:
        actions = set(DEFAULT_SHORTCUTS.values())
        assert PayoutAction.APPROVE in actions
        assert PayoutAction.REJECT in actions
        assert PayoutAction.SKIP in actions
        assert PayoutAction.APPROVE_ALL in actions
        assert PayoutAction.REJECT_ALL in actions
