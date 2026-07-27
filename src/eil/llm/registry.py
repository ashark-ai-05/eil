"""Provider selection: per-call name > EIL_LLM_PROVIDER env > maas default.

The per-workflow tiering rule from the design doc lives here operationally:
deterministic steps use no provider at all; judgment steps default to the
gateway (maas); steps that evals prove need frontier reasoning name "amp"."""

from __future__ import annotations

import os

from eil.llm.base import Provider
from eil.llm.cli import amp_provider, copilot_provider
from eil.llm.maas import MaasProvider


def get_provider(name: str | None = None) -> Provider:
    name = name or os.environ.get("EIL_LLM_PROVIDER", "maas")
    match name:
        case "maas":
            return MaasProvider()
        case "amp":
            return amp_provider()
        case "copilot":
            return copilot_provider()
        case _:
            raise ValueError(f"unknown LLM provider: {name!r} (expected maas | amp | copilot)")
