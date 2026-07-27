"""OpenAI-compatible API provider — the default path, via the LiteLLM gateway.

Env: EIL_MAAS_BASE_URL (default: local LiteLLM), EIL_MAAS_API_KEY,
EIL_MAAS_MODEL (Nemotron-class deployment name in the MaaS catalog).
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

from eil.llm.base import LLMResult


def build_payload(
    prompt: str, system: str | None, model: str, max_tokens: int
) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return {"model": model, "messages": messages, "max_tokens": max_tokens}


class MaasProvider:
    name = "maas"

    def __init__(self) -> None:
        self.base_url = os.environ.get("EIL_MAAS_BASE_URL", "http://localhost:4000")
        self.api_key = os.environ.get("EIL_MAAS_API_KEY", "")
        self.default_model = os.environ.get("EIL_MAAS_MODEL", "nemotron")

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        model: str | None = None,
        max_tokens: int = 1024,
    ) -> LLMResult:
        model = model or self.default_model
        started = time.monotonic()
        response = httpx.post(
            f"{self.base_url.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json=build_payload(prompt, system, model, max_tokens),
            timeout=120,
        )
        response.raise_for_status()
        data = response.json()
        usage = data.get("usage", {})
        return LLMResult(
            text=data["choices"][0]["message"]["content"],
            provider=self.name,
            model=data.get("model", model),
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            latency_ms=int((time.monotonic() - started) * 1000),
        )
