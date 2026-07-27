import sys

import pytest

from eil.llm.base import parse_json_reply
from eil.llm.cli import CliProvider
from eil.llm.maas import build_payload
from eil.llm.registry import get_provider


def test_cli_provider_roundtrip_via_python():
    echo = CliProvider("echo", [sys.executable, "-c", "import sys; print(sys.argv[1])"])
    result = echo.complete("hello world")
    assert result.text == "hello world"
    assert result.provider == "echo"
    assert result.prompt_tokens is None  # CLI backends report no usage
    assert result.latency_ms is not None


def test_cli_provider_prepends_system():
    echo = CliProvider("echo", [sys.executable, "-c", "import sys; print(sys.argv[1])"])
    result = echo.complete("question", system="you are terse")
    assert result.text.startswith("you are terse")


def test_cli_provider_raises_on_failure():
    fail = CliProvider("fail", [sys.executable, "-c", "import sys; sys.exit(3)"])
    with pytest.raises(RuntimeError, match="exited 3"):
        fail.complete("x")


def test_maas_payload_shape():
    payload = build_payload("q", "sys", "nemotron", 256)
    assert payload["messages"][0] == {"role": "system", "content": "sys"}
    assert payload["messages"][1] == {"role": "user", "content": "q"}
    assert payload["model"] == "nemotron"
    assert build_payload("q", None, "m", 1)["messages"][0]["role"] == "user"


def test_registry_selects_and_rejects(monkeypatch):
    monkeypatch.delenv("EIL_LLM_PROVIDER", raising=False)
    assert get_provider().name == "maas"
    assert get_provider("amp").name == "amp"
    assert get_provider("copilot").name == "copilot"
    monkeypatch.setenv("EIL_LLM_PROVIDER", "amp")
    assert get_provider().name == "amp"
    with pytest.raises(ValueError):
        get_provider("gpt")


def test_parse_json_reply_tolerates_fences():
    assert parse_json_reply('{"verdict": true}') == {"verdict": True}
    assert parse_json_reply('```json\n{"verdict": true}\n```') == {"verdict": True}
    assert parse_json_reply('Sure! Here you go: {"a": 1}') == {"a": 1}
    with pytest.raises(ValueError):
        parse_json_reply("no json here")
