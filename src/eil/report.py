"""Self-contained HTML metrics report — the no-Grafana proof path.

Queries the metrics views and renders tables plus server-side SVG charts:
fully deterministic output for a given database state, no JavaScript, no
external assets. `eil report` writes it; Grafana renders the same views
interactively where it's installed.
"""

from __future__ import annotations

import html
from datetime import UTC, datetime
from typing import Any

import psycopg

CSS = """
body{font-family:"Avenir Next",Avenir,"Helvetica Neue",Arial,sans-serif;color:#16211F;
background:#F6F7F5;margin:0;padding:2.5rem 1.2rem 4rem;font-size:15px;line-height:1.5}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.7rem;letter-spacing:-.01em;margin:0 0 .2rem}
h2{font-size:1.05rem;margin:2.2rem 0 .6rem}
.meta{font-family:ui-monospace,Menlo,monospace;font-size:.7rem;color:#46534F;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;font-size:.82rem;background:#fff}
th{font-family:ui-monospace,Menlo,monospace;font-size:.62rem;text-transform:uppercase;
letter-spacing:.1em;text-align:left;color:#46534F;border-bottom:2px solid #16211F;padding:.4rem .6rem}
td{border-bottom:1px solid #D5DBD8;padding:.4rem .6rem;font-variant-numeric:tabular-nums}
.section{background:#fff;border:1px solid #D5DBD8;padding:1rem 1.1rem;margin-bottom:1rem;overflow-x:auto}
.empty{color:#46534F;font-style:italic;font-size:.85rem}
svg text{font-family:ui-monospace,Menlo,monospace;font-size:9px;fill:#46534F}
"""

ACCENT = "#0E7C6B"
CAUTION = "#A85E14"


def _rows(conn: psycopg.Connection, sql: str) -> list[dict[str, Any]]:
    cur = conn.execute(sql)
    cols = [d.name for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def collect(conn: psycopg.Connection) -> dict[str, list[dict[str, Any]]]:
    return {
        "tool_calls": _rows(conn, "SELECT * FROM metrics.vw_tool_calls ORDER BY day, tool, principal"),
        "zero_results": _rows(conn, "SELECT * FROM metrics.vw_zero_results ORDER BY day, tool"),
        "two_phase": _rows(conn, "SELECT * FROM metrics.vw_two_phase ORDER BY day"),
        "eval_trend": _rows(conn, "SELECT * FROM metrics.vw_eval_trend ORDER BY at"),
        "llm_calls": _rows(conn, "SELECT * FROM metrics.vw_llm_calls ORDER BY day, provider, model"),
        "connector_health": _rows(conn, "SELECT * FROM metrics.vw_connector_health ORDER BY source"),
        "spend": _rows(conn, "SELECT * FROM metrics.vw_spend_daily ORDER BY day, tool"),
    }


def _bar_chart(items: list[tuple[str, float]], width: int = 640, color: str = ACCENT) -> str:
    if not items:
        return ""
    top = max(v for _, v in items) or 1
    bar_h, gap, label_w = 16, 6, 170
    height = len(items) * (bar_h + gap) + 4
    parts = [f'<svg width="{width}" height="{height}" role="img">']
    for i, (label, value) in enumerate(items):
        y = i * (bar_h + gap)
        w = max(2, int((width - label_w - 60) * value / top))
        parts.append(f'<text x="0" y="{y + 12}">{html.escape(str(label)[:26])}</text>')
        parts.append(f'<rect x="{label_w}" y="{y}" width="{w}" height="{bar_h}" fill="{color}"/>')
        parts.append(f'<text x="{label_w + w + 6}" y="{y + 12}">{value:g}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _line_chart(points: list[tuple[str, float]], width: int = 640, height: int = 140) -> str:
    if not points:
        return ""
    pad, plot_w, plot_h = 34, width - 50, height - 30
    lo, hi = 0.0, max(1.0, max(v for _, v in points))
    step = plot_w / max(1, len(points) - 1)
    coords = [
        (pad + i * step, pad // 2 + plot_h * (1 - (v - lo) / (hi - lo)))
        for i, (_, v) in enumerate(points)
    ]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in coords)
    parts = [f'<svg width="{width}" height="{height}" role="img">']
    for frac in (0.0, 0.5, 1.0):
        gy = pad // 2 + plot_h * (1 - frac)
        parts.append(f'<line x1="{pad}" y1="{gy:.1f}" x2="{pad + plot_w}" y2="{gy:.1f}" stroke="#D5DBD8"/>')
        parts.append(f'<text x="0" y="{gy + 3:.1f}">{lo + (hi - lo) * frac:.2f}</text>')
    parts.append(f'<polyline points="{poly}" fill="none" stroke="{ACCENT}" stroke-width="2"/>')
    x_last, y_last = coords[-1]
    parts.append(f'<circle cx="{x_last:.1f}" cy="{y_last:.1f}" r="3.5" fill="{CAUTION}"/>')
    parts.append(f'<text x="{max(0, x_last - 30):.1f}" y="{height - 4}">{html.escape(points[-1][0])}</text>')
    parts.append(f'<text x="{pad}" y="{height - 4}">{html.escape(points[0][0])}</text>')
    parts.append("</svg>")
    return "".join(parts)


def _table(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return '<p class="empty">no data yet</p>'
    cols = list(rows[0])
    head = "".join(f"<th>{html.escape(c)}</th>" for c in cols)
    body = "".join(
        "<tr>" + "".join(f"<td>{html.escape(str(r[c] if r[c] is not None else '—'))}</td>" for c in cols) + "</tr>"
        for r in rows
    )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def render(data: dict[str, list[dict[str, Any]]], generated_at: str | None = None) -> str:
    generated_at = generated_at or datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    calls_by_tool: dict[str, int] = {}
    for r in data["tool_calls"]:
        calls_by_tool[r["tool"]] = calls_by_tool.get(r["tool"], 0) + int(r["calls"])
    eval_points = [
        (str(r["day"]), float(r["mean_recall"])) for r in data["eval_trend"]
    ]
    sections = [
        ("Adoption — MCP calls by tool (north star)",
         _bar_chart(sorted(calls_by_tool.items(), key=lambda kv: -kv[1])) + _table(data["tool_calls"])),
        ("Zero-result rate — each one is a corpus gap or router miss", _table(data["zero_results"])),
        ("Two-phase ratio — get_doc per search", _table(data["two_phase"])),
        ("Eval recall trend", _line_chart(eval_points) + _table(data["eval_trend"])),
        ("LLM calls by provider", _table(data["llm_calls"])),
        ("Connector health — cursor age", _table(data["connector_health"])),
        ("Spend (vendor-native units)", _table(data["spend"])),
    ]
    body = "".join(
        f'<div class="section"><h2>{html.escape(title)}</h2>{content}</div>'
        for title, content in sections
    )
    return (
        f"<title>EIL Metrics Report</title><style>{CSS}</style>"
        f'<div class="wrap"><h1>EIL Metrics Report</h1>'
        f'<p class="meta">generated {generated_at} · source: metrics.vw_* views · '
        f"same views Grafana reads</p>{body}</div>"
    )
