"""LLM provider abstraction — every model call in EIL goes through this.

Workflows call models as functions; which backend executes is configuration,
not code: the MaaS API (through the LiteLLM gateway), headless Amp, or the
Copilot CLI/SDK. Judgment steps stay provider-agnostic, and per-workflow
tiering (Nemotron vs frontier-via-Amp) becomes an env/config decision driven
by eval data.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol

import psycopg


@dataclass(frozen=True)
class LLMResult:
    text: str
    provider: str
    model: str | None = None
    prompt_tokens: int | None = None  # None: backend doesn't report usage (CLI providers)
    completion_tokens: int | None = None
    latency_ms: int | None = None


class Provider(Protocol):
    name: str

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 1024,
    ) -> LLMResult: ...


def log_call(conn: psycopg.Connection, caller: str, result: LLMResult, ok: bool = True) -> None:
    """Local usage record — the telemetry seed for backends the gateway can't
    see (Amp/Copilot CLI). MaaS calls are additionally logged gateway-side."""
    conn.execute(
        "INSERT INTO llm_calls (provider, model, caller, prompt_tokens, completion_tokens,"
        " latency_ms, ok) VALUES (%s, %s, %s, %s, %s, %s, %s)",
        (
            result.provider, result.model, caller, result.prompt_tokens,
            result.completion_tokens, result.latency_ms, ok,
        ),
    )


def parse_json_reply(text: str) -> dict:
    """Tolerant JSON extraction for structured-output judgment steps: accepts
    raw JSON or a reply wrapping JSON in markdown fences."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        text = text.removeprefix("json").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start : end + 1])
