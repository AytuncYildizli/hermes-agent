"""Regression tests for broker pointer-backed STT credentials."""

from unittest.mock import patch


def test_openai_audio_helper_resolves_voice_secret_pointer(monkeypatch):
    monkeypatch.setenv("VOICE_TOOLS_OPENAI_KEY", "secret://env/voice-tools-openai-key")
    monkeypatch.delenv("OPENAI_TRANSCRIPTION_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    from tools import tool_backend_helpers as helpers

    with patch.object(helpers, "_resolve_secret_pointer_env_value", return_value="sk-real") as resolver:
        assert helpers.resolve_openai_audio_api_key() == "sk-real"
    resolver.assert_called_once_with("VOICE_TOOLS_OPENAI_KEY", "secret://env/voice-tools-openai-key")


def test_openai_audio_helper_uses_transcription_key_fallback(monkeypatch):
    monkeypatch.delenv("VOICE_TOOLS_OPENAI_KEY", raising=False)
    monkeypatch.setenv("OPENAI_TRANSCRIPTION_API_KEY", "secret://env/openai-transcription-api-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    from tools import tool_backend_helpers as helpers

    with patch.object(helpers, "_resolve_secret_pointer_env_value", side_effect=lambda name, value: "sk-stt" if value else ""):
        assert helpers.resolve_openai_audio_api_key() == "sk-stt"


def test_transcription_config_api_key_pointer_resolved(monkeypatch):
    monkeypatch.delenv("VOICE_TOOLS_OPENAI_KEY", raising=False)
    monkeypatch.delenv("OPENAI_TRANSCRIPTION_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    from tools import transcription_tools as tt

    with patch.object(tt, "_load_stt_config", return_value={"openai": {"api_key": "secret://stt/key", "base_url": "http://local/v1"}}), \
         patch.object(tt, "_resolve_secret_pointer_env_value", return_value="sk-config"):
        assert tt._resolve_openai_audio_client_config() == ("sk-config", "http://local/v1")


def test_transcription_get_env_value_resolves_pointer(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    from tools import transcription_tools as tt

    with patch("hermes_cli.config.get_env_value", return_value="secret://groq/key"), \
         patch.object(tt, "_resolve_secret_pointer_env_value", return_value="gsk-real"):
        assert tt.get_env_value("GROQ_API_KEY") == "gsk-real"


def test_transcription_import_survives_stale_helper_without_private_resolver(tmp_path):
    """Gateway should not crash if an old cached helper module lacks the private resolver."""
    import subprocess
    import sys
    import textwrap
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    code = textwrap.dedent(
        f"""
        import sys
        import types

        sys.path.insert(0, {str(repo)!r})
        helper = types.ModuleType("tools.tool_backend_helpers")
        helper.managed_nous_tools_enabled = lambda *args, **kwargs: False
        helper.nous_tool_gateway_unavailable_message = lambda *args, **kwargs: "unavailable"
        helper.resolve_openai_audio_api_key = lambda: ""
        sys.modules["tools.tool_backend_helpers"] = helper

        from tools import transcription_tools as tt

        assert callable(tt.get_env_value)
        assert callable(tt._resolve_secret_pointer_env_value)
        """
    )
    cp = subprocess.run(
        [sys.executable, "-c", code],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    assert cp.returncode == 0, cp.stderr
