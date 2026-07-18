from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from plugins.whip_operator import (
    CAPABILITY_SCHEMA,
    ENVELOPE_SCHEMA,
    REQUEST_SCHEMA,
    _handle_authenticated_gateway_dispatch,
    capability_id_for_key,
)


KEY_HEX = "ab" * 32
CANONICAL_CHAT = "15551234567@s.whatsapp.net"
CANONICAL_USER = "15557654321@s.whatsapp.net"
CHAT_LID = "15551234567@lid"
USER_LID = "15557654321@lid"
BODY = "ship this safely through Whip"
GOLDEN_CAPABILITY_ID = (
    "48cb18ebb2323c93b9d1811a5eb7fef1539af101a7f6598f0715303171a8313b"
)
GOLDEN_BODY_SHA256 = (
    "5366442a94ecd50574437ec96610a4ac99bdc7835b070ce5717612b2904e7ebf"
)
GOLDEN_HMAC_SHA256 = (
    "5880f80a06ce32f7fa80e6c278490dc75c3ad7d778cb2da3fdacb19a2f155836"
)


def _private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700)
    return path


def _capability(path: Path) -> Path:
    packet = {
        "schema_version": CAPABILITY_SCHEMA,
        "capability_id": capability_id_for_key(KEY_HEX),
        "hmac_key": KEY_HEX,
        "owner_platform": "whatsapp",
        "owner_chat_id": CANONICAL_CHAT,
        "owner_user_id": CANONICAL_USER,
        "owner_chat_aliases": [CANONICAL_CHAT, CHAT_LID],
        "owner_user_aliases": [CANONICAL_USER, USER_LID],
    }
    path.write_text(
        json.dumps(packet, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    path.chmod(0o600)
    return path


def _config(tmp_path: Path) -> dict:
    private = _private_dir(tmp_path / "private")
    launcher = tmp_path / "whip-operator-do"
    launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    launcher.chmod(0o755)
    registry = private / "registry.json"
    registry.write_text("{}\n", encoding="utf-8")
    registry.chmod(0o600)
    state_root = _private_dir(private / "state")
    return {
        "launcher": str(launcher),
        "capability_file": str(_capability(private / "capability.json")),
        "target_registry": str(registry),
        "state_root": str(state_root),
        "timeout_seconds": 5,
        "target_hint": None,
    }


def _event(**overrides) -> dict:
    value = {
        "platform": "whatsapp",
        "chat_id": CHAT_LID,
        "user_id": USER_LID,
        "thread_id": None,
        "message_id": "wamid.owner.42",
        "reply_to_message_id": "wamid.owner.41",
        "timestamp": "2026-07-18T09:30:00+00:00",
        "text": BODY,
        "chat_type": "dm",
        "is_group": False,
        "message_type": "text",
        "has_media": False,
        "media_types": (),
        "is_command": False,
        "command": None,
    }
    value.update(overrides)
    return value


def _accepted_receipt() -> bytes:
    return json.dumps(
        {
            "schema_version": "whip.operator_ingress_result.v1",
            "status": "accepted",
            "mission_id": "1" * 64,
            "origin_ref": f"origin:{'2' * 64}",
            "repository": "AytuncYildizli/whip",
            "launch_state": "process_spawned",
            "launch_pid": 4242,
            "blockers": [],
        },
        sort_keys=True,
    ).encode()


def _resumed_receipt() -> bytes:
    packet = json.loads(_accepted_receipt())
    packet["status"] = "resumed"
    packet["launch_pid"] = 5252
    return json.dumps(packet, sort_keys=True).encode()


class _Process:
    def __init__(self, stdout: bytes, *, returncode: int = 0, delay: float = 0):
        self.stdout = stdout
        self.stderr = b"must-not-surface"
        self.returncode = returncode
        self.delay = delay
        self.input = None
        self.killed = False

    async def communicate(self, payload):
        self.input = payload
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.stdout, self.stderr

    def kill(self):
        self.killed = True

    async def wait(self):
        return self.returncode


@pytest.mark.asyncio
async def test_owner_lid_is_canonicalized_and_request_uses_stdin_only(tmp_path):
    config = _config(tmp_path)
    process = _Process(_accepted_receipt())
    calls = []

    async def create(*argv, **kwargs):
        calls.append((argv, kwargs))
        return process

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(),
        config=config,
        create_subprocess_exec=create,
    )

    assert result == {
        "action": "handled",
        "response": "🟡 Whip accepted 111111111111 · AytuncYildizli/whip",
    }
    assert len(calls) == 1
    argv, kwargs = calls[0]
    assert argv[1:] == (
        "ingress",
        "--capability-file",
        config["capability_file"],
        "--target-registry",
        config["target_registry"],
        "--state-root",
        config["state_root"],
    )
    assert BODY not in argv
    assert CHAT_LID not in argv
    assert USER_LID not in argv
    assert KEY_HEX not in json.dumps(kwargs)
    assert "shell" not in kwargs
    assert kwargs["start_new_session"] is True
    request = json.loads(process.input)
    assert request["schema_version"] == REQUEST_SCHEMA
    assert request["body"] == BODY
    assert request["envelope"]["schema_version"] == ENVELOPE_SCHEMA
    assert request["envelope"]["chat_id"] == CANONICAL_CHAT
    assert request["envelope"]["user_id"] == CANONICAL_USER
    assert capability_id_for_key(KEY_HEX) == GOLDEN_CAPABILITY_ID
    assert request["envelope"]["capability_id"] == GOLDEN_CAPABILITY_ID
    assert hashlib.sha256(BODY.encode()).hexdigest() == GOLDEN_BODY_SHA256
    assert request["envelope"]["body_sha256"] == GOLDEN_BODY_SHA256
    assert request["envelope"]["hmac_sha256"] == GOLDEN_HMAC_SHA256


@pytest.mark.asyncio
async def test_exact_approval_resume_receipt_is_pending_not_final_green(tmp_path):
    async def create(*_args, **_kwargs):
        return _Process(_resumed_receipt())

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(
            text=(
                "APPROVE MERGE AytuncYildizli/whip PR #914 HEAD "
                f"{'5' * 40} RELEASE {'6' * 64}"
            ),
            message_id="wamid.approval.914",
        ),
        config=_config(tmp_path),
        create_subprocess_exec=create,
    )

    assert result == {
        "action": "handled",
        "response": "🟡 Whip resumed 111111111111 · AytuncYildizli/whip",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"platform": "telegram"},
        {"chat_type": "group", "is_group": True},
        {"is_command": True, "command": "help"},
        {"has_media": True, "message_type": "photo"},
        {"chat_id": "attacker@s.whatsapp.net"},
        {"user_id": "attacker@s.whatsapp.net"},
    ],
)
async def test_non_owner_group_control_and_media_events_fall_through(
    tmp_path,
    overrides,
):
    async def create(*_args, **_kwargs):
        pytest.fail("excluded event must not invoke Whip")

    assert await _handle_authenticated_gateway_dispatch(
        event=_event(**overrides),
        config=_config(tmp_path),
        create_subprocess_exec=create,
    ) is None


@pytest.mark.asyncio
async def test_timeout_kills_ingress_and_returns_explicit_handled_red(tmp_path):
    config = _config(tmp_path)
    config["timeout_seconds"] = 0.01
    process = _Process(_accepted_receipt(), delay=1)

    async def create(*_args, **_kwargs):
        return process

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(),
        config=config,
        create_subprocess_exec=create,
    )

    assert result == {
        "action": "handled",
        "response": "🔴 Whip ingress blocked: whip_ingress_timeout",
    }
    assert process.killed is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdout,returncode",
    [
        (b"not-json", 0),
        (b"{}", 0),
        (_accepted_receipt(), 7),
        (b"x" * (64 * 1024 + 1), 0),
    ],
)
async def test_invalid_or_oversized_ingress_output_never_falls_through(
    tmp_path,
    stdout,
    returncode,
):
    async def create(*_args, **_kwargs):
        return _Process(stdout, returncode=returncode)

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(),
        config=_config(tmp_path),
        create_subprocess_exec=create,
    )

    assert result == {
        "action": "handled",
        "response": "🔴 Whip ingress blocked: whip_ingress_invalid_receipt",
    }


@pytest.mark.asyncio
async def test_unreadable_owner_capability_falls_through_without_claiming_identity(tmp_path):
    config = _config(tmp_path)
    Path(config["capability_file"]).chmod(0o644)

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(),
        config=config,
        create_subprocess_exec=SimpleNamespace(),
    )

    assert result is None


@pytest.mark.asyncio
async def test_valid_owner_capability_with_invalid_registry_returns_handled_red(tmp_path):
    config = _config(tmp_path)
    Path(config["target_registry"]).chmod(0o644)

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(),
        config=config,
        create_subprocess_exec=SimpleNamespace(),
    )

    assert result == {
        "action": "handled",
        "response": "🔴 Whip ingress blocked: whip_ingress_config_invalid",
    }
    assert str(tmp_path) not in result["response"]


@pytest.mark.asyncio
async def test_non_owner_with_invalid_runtime_config_is_never_claimed(tmp_path):
    config = _config(tmp_path)
    Path(config["target_registry"]).chmod(0o644)

    result = await _handle_authenticated_gateway_dispatch(
        event=_event(chat_id="authorized-peer@s.whatsapp.net"),
        config=config,
        create_subprocess_exec=SimpleNamespace(),
    )

    assert result is None
