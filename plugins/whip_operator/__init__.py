"""Opt-in authenticated WhatsApp owner dispatch into Whip."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable


REQUEST_SCHEMA = "whip.operator_ingress_request.v1"
ENVELOPE_SCHEMA = "whip.operator_ingress_envelope.v1"
CAPABILITY_SCHEMA = "whip.operator_ingress_capability.v1"
RESULT_SCHEMA = "whip.operator_ingress_result.v1"

MAX_BODY_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 96 * 1024
MAX_RESULT_BYTES = 64 * 1024
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ORIGIN_REF_RE = re.compile(r"^origin:[0-9a-f]{64}$")
_OPAQUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,1023}$")
_MESSAGE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$")
_REPOSITORY_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$"
)
_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_BLOCKER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_CAPABILITY_FIELDS = {
    "schema_version",
    "capability_id",
    "hmac_key",
    "owner_platform",
    "owner_chat_id",
    "owner_user_id",
    "owner_chat_aliases",
    "owner_user_aliases",
}
_EVENT_FIELDS = {
    "platform",
    "chat_id",
    "user_id",
    "thread_id",
    "message_id",
    "reply_to_message_id",
    "timestamp",
    "text",
    "chat_type",
    "is_group",
    "message_type",
    "has_media",
    "media_types",
    "is_command",
    "command",
}


class WhipOperatorPluginError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _fail(code: str, cause: BaseException | None = None) -> None:
    if cause is None:
        raise WhipOperatorPluginError(code)
    raise WhipOperatorPluginError(code) from cause


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("whip_ingress_json_invalid")
        result[key] = value
    return result


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        _fail("whip_ingress_json_invalid", exc)


def _domain_payload(value: object, domain: str) -> bytes:
    domain_bytes = domain.encode("ascii")
    payload = _canonical_json_bytes(value)
    return (
        len(domain_bytes).to_bytes(8, "big")
        + domain_bytes
        + len(payload).to_bytes(8, "big")
        + payload
    )


def _key_bytes(value: object) -> bytes:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        _fail("whip_ingress_config_invalid")
    try:
        return bytes.fromhex(value)
    except ValueError as exc:
        _fail("whip_ingress_config_invalid", exc)


def capability_id_for_key(hmac_key: object) -> str:
    return hashlib.sha256(
        b"whip.operator_ingress_capability_id.v1\0" + _key_bytes(hmac_key)
    ).hexdigest()


def _owned_by_current_user(metadata: os.stat_result) -> bool:
    return not hasattr(os, "getuid") or metadata.st_uid == os.getuid()


def _private_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as exc:
        _fail("whip_ingress_config_invalid", exc)
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or not _owned_by_current_user(metadata)
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        _fail("whip_ingress_config_invalid")


def _private_file(path: Path, *, max_bytes: int) -> bytes:
    _private_directory(path.parent)
    try:
        visible = path.lstat()
    except OSError as exc:
        _fail("whip_ingress_config_invalid", exc)
    if (
        stat.S_ISLNK(visible.st_mode)
        or not stat.S_ISREG(visible.st_mode)
        or not _owned_by_current_user(visible)
        or stat.S_IMODE(visible.st_mode) != 0o600
        or visible.st_nlink != 1
        or not 1 <= visible.st_size <= max_bytes
    ):
        _fail("whip_ingress_config_invalid")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: int | None = None
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or not _owned_by_current_user(opened)
            or stat.S_IMODE(opened.st_mode) != 0o600
            or opened.st_nlink != 1
            or not 1 <= opened.st_size <= max_bytes
            or opened.st_dev != visible.st_dev
            or opened.st_ino != visible.st_ino
        ):
            _fail("whip_ingress_config_invalid")
        payload = bytearray()
        while len(payload) <= max_bytes:
            chunk = os.read(descriptor, min(65536, max_bytes + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
    except WhipOperatorPluginError:
        raise
    except OSError as exc:
        _fail("whip_ingress_config_invalid", exc)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if not payload or len(payload) > max_bytes:
        _fail("whip_ingress_config_invalid")
    return bytes(payload)


def _decode_json(payload: bytes, *, code: str) -> dict[str, Any]:
    try:
        value = json.loads(
            payload.decode("utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()),
            object_pairs_hook=_strict_object,
        )
    except (json.JSONDecodeError, UnicodeError, ValueError, RecursionError) as exc:
        _fail(code, exc)
    if type(value) is not dict:
        _fail(code)
    return value


def _bounded_text(
    value: object,
    *,
    max_bytes: int,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        _fail("whip_ingress_event_invalid")
    if len(value.encode("utf-8")) > max_bytes:
        _fail("whip_ingress_event_invalid")
    if pattern is not None and pattern.fullmatch(value) is None:
        _fail("whip_ingress_event_invalid")
    return value


def _validate_aliases(value: object, *, canonical: str) -> tuple[str, ...]:
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 16
        or len(set(value)) != len(value)
        or canonical not in value
    ):
        _fail("whip_ingress_config_invalid")
    aliases: list[str] = []
    for alias in value:
        if (
            not isinstance(alias, str)
            or len(alias.encode("utf-8")) > 1024
            or _OPAQUE_RE.fullmatch(alias) is None
        ):
            _fail("whip_ingress_config_invalid")
        aliases.append(alias)
    return tuple(aliases)


def _load_capability(path: Path) -> dict[str, Any]:
    capability = _decode_json(
        _private_file(path, max_bytes=64 * 1024),
        code="whip_ingress_config_invalid",
    )
    if (
        set(capability) != _CAPABILITY_FIELDS
        or capability.get("schema_version") != CAPABILITY_SCHEMA
        or capability.get("owner_platform") != "whatsapp"
    ):
        _fail("whip_ingress_config_invalid")
    key = capability.get("hmac_key")
    if capability.get("capability_id") != capability_id_for_key(key):
        _fail("whip_ingress_config_invalid")
    for field in ("owner_chat_id", "owner_user_id"):
        value = capability.get(field)
        if (
            not isinstance(value, str)
            or len(value.encode("utf-8")) > 1024
            or _OPAQUE_RE.fullmatch(value) is None
        ):
            _fail("whip_ingress_config_invalid")
    capability["owner_chat_aliases"] = _validate_aliases(
        capability.get("owner_chat_aliases"),
        canonical=capability["owner_chat_id"],
    )
    capability["owner_user_aliases"] = _validate_aliases(
        capability.get("owner_user_aliases"),
        canonical=capability["owner_user_id"],
    )
    return capability


def _absolute_path(value: object, *, basename: str | None = None) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        _fail("whip_ingress_config_invalid")
    path = Path(value)
    if not path.is_absolute() or (basename is not None and path.name != basename):
        _fail("whip_ingress_config_invalid")
    return path


def _validated_config(value: object) -> dict[str, Any]:
    required = {
        "launcher",
        "capability_file",
        "target_registry",
        "state_root",
        "timeout_seconds",
        "target_hint",
    }
    if type(value) is not dict or set(value) != required:
        _fail("whip_ingress_config_invalid")
    launcher = _absolute_path(value["launcher"], basename="whip-operator-do")
    try:
        launcher_metadata = launcher.lstat()
    except OSError as exc:
        _fail("whip_ingress_config_invalid", exc)
    if (
        stat.S_ISLNK(launcher_metadata.st_mode)
        or not stat.S_ISREG(launcher_metadata.st_mode)
        or not _owned_by_current_user(launcher_metadata)
        or not os.access(launcher, os.X_OK)
    ):
        _fail("whip_ingress_config_invalid")
    capability_path = _absolute_path(value["capability_file"])
    registry_path = _absolute_path(value["target_registry"])
    state_root = _absolute_path(value["state_root"])
    _private_directory(state_root)
    registry_metadata = _private_file(registry_path, max_bytes=256 * 1024)
    del registry_metadata
    timeout = value["timeout_seconds"]
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not 0.001 <= float(timeout) <= 60.0
    ):
        _fail("whip_ingress_config_invalid")
    hint = value["target_hint"]
    if hint is not None:
        if (
            not isinstance(hint, str)
            or len(hint.encode("utf-8")) > 200
            or (
                _REPOSITORY_RE.fullmatch(hint) is None
                and _ALIAS_RE.fullmatch(hint) is None
            )
        ):
            _fail("whip_ingress_config_invalid")
    return {
        "launcher": launcher,
        "capability_file": capability_path,
        "target_registry": registry_path,
        "state_root": state_root,
        "timeout_seconds": float(timeout),
        "target_hint": hint,
    }


def _canonical_timestamp(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        _fail("whip_ingress_event_invalid")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        _fail("whip_ingress_event_invalid", exc)
    if parsed.tzinfo is None:
        _fail("whip_ingress_event_invalid")
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _signed_request(
    *,
    event: dict[str, Any],
    capability: dict[str, Any],
    target_hint: str | None,
) -> dict[str, Any]:
    body = _bounded_text(event.get("text"), max_bytes=MAX_BODY_BYTES)
    if body != body.strip():
        _fail("whip_ingress_event_invalid")
    message_id = _bounded_text(
        event.get("message_id"),
        max_bytes=256,
        pattern=_MESSAGE_ID_RE,
    )
    reply_id = event.get("reply_to_message_id")
    if reply_id is not None:
        reply_id = _bounded_text(
            reply_id,
            max_bytes=256,
            pattern=_MESSAGE_ID_RE,
        )
    core = {
        "schema_version": ENVELOPE_SCHEMA,
        "capability_id": capability["capability_id"],
        "platform": "whatsapp",
        "chat_type": "dm",
        "chat_id": capability["owner_chat_id"],
        "user_id": capability["owner_user_id"],
        "message_id": message_id,
        "reply_to_message_id": reply_id,
        "received_at": _canonical_timestamp(event.get("timestamp")),
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "target_hint": target_hint,
    }
    signature = hmac.new(
        _key_bytes(capability["hmac_key"]),
        _domain_payload(core, ENVELOPE_SCHEMA),
        hashlib.sha256,
    ).hexdigest()
    request = {
        "schema_version": REQUEST_SCHEMA,
        "envelope": {**core, "hmac_sha256": signature},
        "body": body,
    }
    if len(_canonical_json_bytes(request)) > MAX_REQUEST_BYTES:
        _fail("whip_ingress_event_invalid")
    return request


def _red(code: str) -> dict[str, str]:
    safe = code if _BLOCKER_RE.fullmatch(code) is not None else "whip_ingress_failed"
    return {
        "action": "handled",
        "response": f"🔴 Whip ingress blocked: {safe}",
    }


def _receipt_response(payload: bytes, *, returncode: int) -> dict[str, str]:
    if not payload or len(payload) > MAX_RESULT_BYTES:
        return _red("whip_ingress_invalid_receipt")
    try:
        receipt = _decode_json(payload, code="whip_ingress_invalid_receipt")
    except WhipOperatorPluginError:
        return _red("whip_ingress_invalid_receipt")
    if receipt.get("schema_version") != RESULT_SCHEMA:
        return _red("whip_ingress_invalid_receipt")
    status = receipt.get("status")
    if status == "blocked":
        if set(receipt) != {"schema_version", "status", "blockers"}:
            return _red("whip_ingress_invalid_receipt")
        blockers = receipt.get("blockers")
        if (
            not isinstance(blockers, list)
            or not blockers
            or not all(
                isinstance(code, str) and _BLOCKER_RE.fullmatch(code)
                for code in blockers
            )
        ):
            return _red("whip_ingress_invalid_receipt")
        return _red(blockers[0])
    expected = {
        "schema_version",
        "status",
        "mission_id",
        "origin_ref",
        "repository",
        "launch_state",
        "launch_pid",
        "blockers",
    }
    mission_id = receipt.get("mission_id")
    repository = receipt.get("repository")
    if (
        returncode != 0
        or set(receipt) != expected
        or status not in {"accepted", "replayed", "resumed"}
        or not isinstance(mission_id, str)
        or _SHA256_RE.fullmatch(mission_id) is None
        or not isinstance(receipt.get("origin_ref"), str)
        or _ORIGIN_REF_RE.fullmatch(receipt["origin_ref"]) is None
        or not isinstance(repository, str)
        or _REPOSITORY_RE.fullmatch(repository) is None
        or receipt.get("launch_state") != "process_spawned"
        or isinstance(receipt.get("launch_pid"), bool)
        or not isinstance(receipt.get("launch_pid"), int)
        or receipt["launch_pid"] <= 0
        or receipt.get("blockers") != []
    ):
        return _red("whip_ingress_invalid_receipt")
    return {
        "action": "handled",
        "response": f"🟡 Whip {status} {mission_id[:12]} · {repository}",
    }


async def _handle_authenticated_gateway_dispatch(
    *,
    event: dict[str, Any],
    config: dict[str, Any],
    create_subprocess_exec: Callable[..., Awaitable[Any]] = asyncio.create_subprocess_exec,
) -> dict[str, str] | None:
    if type(event) is not dict or set(event) != _EVENT_FIELDS:
        return None
    if (
        event.get("platform") != "whatsapp"
        or event.get("chat_type") != "dm"
        or event.get("is_group") is not False
        or event.get("is_command") is not False
        or event.get("command") is not None
        or event.get("has_media") is not False
        or event.get("message_type") != "text"
    ):
        return None
    # Establish the owner boundary before validating the rest of the runtime
    # config. A broken registry/launcher must never let this plugin claim an
    # otherwise authorized non-owner Hermes conversation.
    try:
        if type(config) is not dict:
            _fail("whip_ingress_config_invalid")
        capability_path = _absolute_path(config.get("capability_file"))
        capability = _load_capability(capability_path)
    except (WhipOperatorPluginError, OSError, TypeError, ValueError):
        return None
    if (
        event.get("chat_id") not in capability["owner_chat_aliases"]
        or event.get("user_id") not in capability["owner_user_aliases"]
    ):
        return None
    try:
        accepted_config = _validated_config(config)
    except (WhipOperatorPluginError, OSError, TypeError, ValueError):
        return _red("whip_ingress_config_invalid")
    try:
        request = _signed_request(
            event=event,
            capability=capability,
            target_hint=accepted_config["target_hint"],
        )
        stdin_payload = _canonical_json_bytes(request)
        process = await create_subprocess_exec(
            str(accepted_config["launcher"]),
            "ingress",
            "--capability-file",
            str(accepted_config["capability_file"]),
            "--target-registry",
            str(accepted_config["target_registry"]),
            "--state-root",
            str(accepted_config["state_root"]),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd="/",
            env={
                "HOME": str(Path.home()),
                "LANG": "C",
                "LC_ALL": "C",
                "PATH": "/usr/bin:/bin",
                "XDG_STATE_HOME": str(accepted_config["state_root"]),
            },
            close_fds=True,
            start_new_session=True,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(stdin_payload),
                timeout=accepted_config["timeout_seconds"],
            )
        except asyncio.TimeoutError:
            process.kill()
            try:
                await process.wait()
            except Exception:
                pass
            return _red("whip_ingress_timeout")
        return _receipt_response(stdout, returncode=process.returncode)
    except asyncio.CancelledError:
        raise
    except (WhipOperatorPluginError, OSError, RuntimeError, TypeError, ValueError):
        return _red("whip_ingress_launch_failed")


def _load_plugin_config() -> dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        all_config = load_config()
    except Exception:
        return {}
    plugins = all_config.get("plugins") if isinstance(all_config, dict) else None
    entries = plugins.get("entries") if isinstance(plugins, dict) else None
    value = entries.get("whip_operator") if isinstance(entries, dict) else None
    return value if isinstance(value, dict) else {}


def register(ctx) -> None:
    async def dispatch(*, event: dict[str, Any], **_kwargs: Any):
        return await _handle_authenticated_gateway_dispatch(
            event=event,
            config=_load_plugin_config(),
        )

    ctx.register_hook("authenticated_gateway_dispatch", dispatch)


__all__ = [
    "CAPABILITY_SCHEMA",
    "ENVELOPE_SCHEMA",
    "REQUEST_SCHEMA",
    "WhipOperatorPluginError",
    "capability_id_for_key",
    "register",
]
