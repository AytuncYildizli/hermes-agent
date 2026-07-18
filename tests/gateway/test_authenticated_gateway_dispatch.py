"""Authenticated gateway plugin dispatch contract tests.

The post-authorization hook is deliberately separate from
``pre_gateway_dispatch``: it only sees authorized, non-control user messages
and can consume them before either the idle agent path or the active-session
queue/steer/interrupt path runs.
"""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import hermes_cli.plugins as plugin_module
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType, SendResult
from gateway.run import GatewayRunner
from gateway.session import SessionSource, build_session_key
from hermes_cli.plugins import PluginManager, VALID_HOOKS


class _FakeAdapter:
    def __init__(self) -> None:
        self._active_sessions = {}
        self._pending_messages = {}
        self.sent = []

    async def send(self, chat_id, content, **kwargs):
        self.sent.append((chat_id, content, kwargs))
        return SendResult(success=True, message_id="sent-1")

    async def _send_with_retry(self, *, chat_id, content, **kwargs):
        self.sent.append((chat_id, content, kwargs))
        return SendResult(success=True, message_id="sent-1")


def _make_event(
    text: str = "send this to Whip",
    *,
    chat_type: str = "dm",
    message_type: MessageType = MessageType.TEXT,
) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=message_type,
        source=SessionSource(
            platform=Platform.WHATSAPP,
            chat_id="15551234567@s.whatsapp.net",
            chat_type=chat_type,
            user_id="15557654321@s.whatsapp.net",
            user_name="tester",
            thread_id="thread-7",
        ),
        raw_message={"authorization": "Bearer must-not-leak"},
        message_id="message-42",
        media_urls=["/private/cache/customer-photo.jpg"],
        media_types=["image/jpeg"],
        reply_to_message_id="message-41",
        channel_prompt="must-not-leak",
        timestamp=datetime(2026, 7, 18, 9, 30, tzinfo=timezone.utc),
    )


def _make_runner(*, authorized: bool = True):
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.WHATSAPP: PlatformConfig(enabled=True)}
    )
    adapter = _FakeAdapter()
    runner.adapters = {Platform.WHATSAPP: adapter}
    runner.session_store = MagicMock()
    runner.pairing_store = MagicMock()
    runner._is_user_authorized = MagicMock(return_value=authorized)
    runner._running_agents = {}
    runner._running_agents_ts = {}
    runner._session_run_generation = {}
    runner._pending_messages = {}
    runner._pending_approvals = {}
    runner._update_prompt_pending = {}
    runner._busy_ack_ts = {}
    runner._busy_input_mode = "interrupt"
    runner._draining = False
    runner._background_tasks = set()
    runner.hooks = SimpleNamespace(
        emit=AsyncMock(),
        emit_collect=AsyncMock(return_value=[]),
        loaded_hooks=False,
    )
    runner._handle_message_with_agent = AsyncMock(return_value="agent-response")
    return runner, adapter


def _install_hook_manager(monkeypatch, *callbacks) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    manager._hooks["authenticated_gateway_dispatch"] = list(callbacks)
    monkeypatch.setattr(plugin_module, "_plugin_manager", manager)
    return manager


@pytest.fixture(autouse=True)
def _disable_pre_auth_dispatch(monkeypatch):
    """Keep the legacy synchronous pre-auth hook out of these assertions."""
    monkeypatch.setattr(plugin_module, "invoke_hook", lambda *_args, **_kwargs: [])


@pytest.mark.asyncio
async def test_unauthorized_message_never_invokes_authenticated_hook(monkeypatch):
    hook = AsyncMock(return_value={"action": "handled", "response": "accepted"})
    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=False)

    result = await runner._handle_message(_make_event(chat_type="group"))

    assert "authenticated_gateway_dispatch" in VALID_HOOKS
    assert result is None
    hook.assert_not_awaited()
    runner._handle_message_with_agent.assert_not_awaited()
    assert adapter.sent == []


@pytest.mark.asyncio
async def test_authorized_idle_handled_sends_once_and_preserves_bounded_event(monkeypatch):
    seen = {}

    async def hook(*, event):
        seen.update(event)
        return {"action": "handled", "response": "Whip accepted message-42"}

    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=True)

    result = await runner._handle_message(_make_event(message_type=MessageType.PHOTO))

    assert result is None
    assert len(adapter.sent) == 1
    assert adapter.sent[0][1] == "Whip accepted message-42"
    runner._handle_message_with_agent.assert_not_awaited()
    assert seen == {
        "platform": "whatsapp",
        "chat_id": "15551234567@s.whatsapp.net",
        "user_id": "15557654321@s.whatsapp.net",
        "thread_id": "thread-7",
        "message_id": "message-42",
        "reply_to_message_id": "message-41",
        "timestamp": "2026-07-18T09:30:00+00:00",
        "text": "send this to Whip",
        "chat_type": "dm",
        "is_group": False,
        "message_type": "photo",
        "has_media": True,
        "media_types": ("image/jpeg",),
        "is_command": False,
        "command": None,
    }


@pytest.mark.asyncio
async def test_authorized_busy_handled_does_not_queue_interrupt_or_steer(monkeypatch):
    hook = AsyncMock(
        return_value={"action": "handled", "response": "Whip accepted busy message"}
    )
    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=True)
    runner._busy_input_mode = "steer"
    event = _make_event()
    session_key = build_session_key(event.source)
    running_agent = MagicMock()
    runner._running_agents[session_key] = running_agent

    handled = await runner._handle_active_session_busy_message(event, session_key)

    assert handled is True
    hook.assert_awaited_once()
    assert len(adapter.sent) == 1
    assert adapter.sent[0][1] == "Whip accepted busy message"
    assert adapter._pending_messages == {}
    running_agent.interrupt.assert_not_called()
    running_agent.steer.assert_not_called()


@pytest.mark.asyncio
async def test_unhandled_message_falls_through_to_agent_exactly_once(monkeypatch):
    hook = AsyncMock(return_value=None)
    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=True)
    event = _make_event()

    result = await runner._handle_message(event)

    assert result == "agent-response"
    hook.assert_awaited_once()
    runner._handle_message_with_agent.assert_awaited_once()
    assert adapter.sent == []


@pytest.mark.asyncio
async def test_malformed_hook_result_fails_closed_without_double_execution(monkeypatch):
    hook = AsyncMock(
        return_value={
            "action": "handled",
            "response": "looks valid but has an unbounded extra field",
            "extra": True,
        }
    )
    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=True)

    result = await runner._handle_message(_make_event())

    assert result is None
    hook.assert_awaited_once()
    runner._handle_message_with_agent.assert_not_awaited()
    assert len(adapter.sent) == 1
    assert adapter.sent[0][0] == "15551234567@s.whatsapp.net"
    assert adapter.sent[0][1] == (
        "🔴 Authenticated dispatch blocked: plugin_boundary_failed"
    )
    assert adapter.sent[0][2]["reply_to"] == "message-42"


@pytest.mark.asyncio
async def test_dispatch_infrastructure_exception_fails_closed(monkeypatch, caplog):
    _install_hook_manager(monkeypatch)
    monkeypatch.setattr(
        plugin_module,
        "invoke_authenticated_gateway_dispatch",
        AsyncMock(side_effect=RuntimeError("must-not-fall-through")),
    )
    runner, adapter = _make_runner(authorized=True)

    result = await runner._handle_message(_make_event())

    assert result is None
    runner._handle_message_with_agent.assert_not_awaited()
    assert adapter.sent[0][1] == (
        "🔴 Authenticated dispatch blocked: plugin_boundary_failed"
    )
    assert "must-not-fall-through" not in caplog.text


@pytest.mark.asyncio
async def test_oversized_or_empty_hook_response_is_blocked_without_delivery_amplification(
    monkeypatch,
):
    for response in ("", "x" * 4097):
        hook = AsyncMock(
            return_value={"action": "handled", "response": response}
        )
        _install_hook_manager(monkeypatch, hook)
        runner, adapter = _make_runner(authorized=True)

        result = await runner._handle_message(_make_event())

        assert result is None
        runner._handle_message_with_agent.assert_not_awaited()
        assert adapter.sent[0][1] == (
            "🔴 Authenticated dispatch blocked: plugin_boundary_failed"
        )


@pytest.mark.asyncio
async def test_existing_slash_control_behavior_does_not_reach_authenticated_hook(monkeypatch):
    hook = AsyncMock(return_value={"action": "handled", "response": "wrong"})
    _install_hook_manager(monkeypatch, hook)
    runner, adapter = _make_runner(authorized=True)
    runner._handle_help_command = AsyncMock(return_value="existing help")

    result = await runner._handle_message(_make_event(text="/help"))

    assert result == "existing help"
    hook.assert_not_awaited()
    runner._handle_help_command.assert_awaited_once()
    runner._handle_message_with_agent.assert_not_awaited()
    assert adapter.sent == []
