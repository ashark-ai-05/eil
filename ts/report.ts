/**
 * Self-contained HTML metrics report — the no-Grafana proof path. Queries
 * the metrics views and renders tables plus server-side SVG charts:
 * deterministic for a given database state, no JavaScript, no external assets.
 */

import type pg from "pg";

const CSS = `
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
`;

const ACCENT = "#0E7C6B";
const CAUTION = "#A85E14";

const esc = (s: unknown) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type Rows = Array<Record<string, unknown>>;

async function rows(client: pg.Client, sql: string): Promise<Rows> {
  return (await client.query(sql)).rows;
}

export async function collect(client: pg.Client): Promise<Record<string, Rows>> {
  return {
    tool_calls: await rows(
      client,
      "SELECT * FROM metrics.vw_tool_calls ORDER BY day, tool, principal",
    ),
    zero_results: await rows(client, "SELECT * FROM metrics.vw_zero_results ORDER BY day, tool"),
    two_phase: await rows(client, "SELECT * FROM metrics.vw_two_phase ORDER BY day"),
    eval_trend: await rows(client, "SELECT * FROM metrics.vw_eval_trend ORDER BY at"),
    llm_calls: await rows(
      client,
      "SELECT * FROM metrics.vw_llm_calls ORDER BY day, provider, model",
    ),
    connector_health: await rows(
      client,
      "SELECT * FROM metrics.vw_connector_health ORDER BY source",
    ),
    spend: await rows(client, "SELECT * FROM metrics.vw_spend_daily ORDER BY day, tool"),
  };
}

function barChart(items: Array<[string, number]>, width = 640, color = ACCENT): string {
  if (items.length === 0) return "";
  const top = Math.max(...items.map(([, v]) => v)) || 1;
  const barH = 16;
  const gap = 6;
  const labelW = 170;
  const height = items.length * (barH + gap) + 4;
  const parts = [`<svg width="${width}" height="${height}" role="img">`];
  items.forEach(([label, value], i) => {
    const y = i * (barH + gap);
    const w = Math.max(2, Math.floor(((width - labelW - 60) * value) / top));
    parts.push(`<text x="0" y="${y + 12}">${esc(String(label).slice(0, 26))}</text>`);
    parts.push(`<rect x="${labelW}" y="${y}" width="${w}" height="${barH}" fill="${color}"/>`);
    parts.push(`<text x="${labelW + w + 6}" y="${y + 12}">${value}</text>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

function lineChart(points: Array<[string, number]>, width = 640, height = 140): string {
  if (points.length === 0) return "";
  const pad = 34;
  const plotW = width - 50;
  const plotH = height - 30;
  const hi = Math.max(1.0, ...points.map(([, v]) => v));
  const step = plotW / Math.max(1, points.length - 1);
  const coords = points.map(([, v], i): [number, number] => [
    pad + i * step,
    Math.floor(pad / 2) + plotH * (1 - v / hi),
  ]);
  const poly = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const parts = [`<svg width="${width}" height="${height}" role="img">`];
  for (const frac of [0.0, 0.5, 1.0]) {
    const gy = Math.floor(pad / 2) + plotH * (1 - frac);
    parts.push(
      `<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${pad + plotW}" y2="${gy.toFixed(1)}" stroke="#D5DBD8"/>`,
    );
    parts.push(`<text x="0" y="${(gy + 3).toFixed(1)}">${(hi * frac).toFixed(2)}</text>`);
  }
  parts.push(`<polyline points="${poly}" fill="none" stroke="${ACCENT}" stroke-width="2"/>`);
  const [xLast, yLast] = coords[coords.length - 1]!;
  parts.push(
    `<circle cx="${xLast.toFixed(1)}" cy="${yLast.toFixed(1)}" r="3.5" fill="${CAUTION}"/>`,
  );
  parts.push(
    `<text x="${Math.max(0, xLast - 30).toFixed(1)}" y="${height - 4}">${esc(points[points.length - 1]![0])}</text>`,
  );
  parts.push(`<text x="${pad}" y="${height - 4}">${esc(points[0]![0])}</text>`);
  parts.push("</svg>");
  return parts.join("");
}

function table(data: Rows): string {
  if (data.length === 0) return '<p class="empty">no data yet</p>';
  const cols = Object.keys(data[0]!);
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = data
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c] ?? "—")}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function render(data: Record<string, Rows>, generatedAt?: string): string {
  const generated = generatedAt ?? `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const callsByTool = new Map<string, number>();
  for (const r of data.tool_calls ?? []) {
    const tool = String(r.tool);
    callsByTool.set(tool, (callsByTool.get(tool) ?? 0) + Number(r.calls));
  }
  const evalPoints: Array<[string, number]> = (data.eval_trend ?? []).map((r) => [
    String(r.day ?? "").slice(0, 10),
    Number(r.mean_recall),
  ]);
  const sections: Array<[string, string]> = [
    [
      "Adoption — MCP calls by tool (north star)",
      barChart([...callsByTool.entries()].sort((a, b) => b[1] - a[1])) +
        table(data.tool_calls ?? []),
    ],
    ["Zero-result rate — each one is a corpus gap or router miss", table(data.zero_results ?? [])],
    ["Two-phase ratio — get_doc per search", table(data.two_phase ?? [])],
    ["Eval recall trend", lineChart(evalPoints) + table(data.eval_trend ?? [])],
    ["LLM calls by provider", table(data.llm_calls ?? [])],
    ["Connector health — cursor age", table(data.connector_health ?? [])],
    ["Spend (vendor-native units)", table(data.spend ?? [])],
  ];
  const body = sections
    .map(([title, content]) => `<div class="section"><h2>${esc(title)}</h2>${content}</div>`)
    .join("");
  const meta = `generated ${esc(generated)} · source: metrics.vw_* views · same views Grafana reads`;
  return `<title>EIL Metrics Report</title><style>${CSS}</style><div class="wrap"><h1>EIL Metrics Report</h1><p class="meta">${meta}</p>${body}</div>`;
}
