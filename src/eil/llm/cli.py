"""CLI-backed providers: headless Amp and Copilot.

Both tools expose non-interactive prompt modes; exact flags differ by version,
so the argv is env-configurable rather than hardcoded:

  EIL_AMP_ARGV      default: amp -x
  EIL_COPILOT_ARGV  default: copilot -p

The prompt is appended as the final argument; stdout is the reply. These
backends report no token usage — their cost lands in the telemetry plane via
the Amp admin / Copilot billing collectors (F1), while call counts and latency
are still recorded locally through log_call().
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time

from eil.llm.base import LLMResult


class CliProvider:
    def __init__(self, name: str, argv: list[str], timeout_s: int = 600) -> None:
        self.name = name
        self.argv = argv
        self.timeout_s = timeout_s

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        model: str | None = None,  # model choice lives in the tool's own config
        max_tokens: int = 1024,
    ) -> LLMResult:
        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        started = time.monotonic()
        proc = subprocess.run(
            [*self.argv, full_prompt],
            capture_output=True,
            text=True,
            timeout=self.timeout_s,
            check=False,  # non-zero handled below with stderr context
        )
        if proc.returncode != 0:
            raise RuntimeError(f"{self.name} exited {proc.returncode}: {proc.stderr.strip()[:500]}")
        return LLMResult(
            text=proc.stdout.strip(),
            provider=self.name,
            model=model,
            latency_ms=int((time.monotonic() - started) * 1000),
        )


def amp_provider() -> CliProvider:
    return CliProvider("amp", shlex.split(os.environ.get("EIL_AMP_ARGV", "amp -x")))


def copilot_provider() -> CliProvider:
    return CliProvider("copilot", shlex.split(os.environ.get("EIL_COPILOT_ARGV", "copilot -p")))
