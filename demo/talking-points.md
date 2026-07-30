# Talking points — 15 minutes

Not a script to read. The lines are there so you have something to fall back on
if you lose the thread. Say them in your own words.

| | Beat | Time |
|---|---|---|
| 1 | The nine things it made up | 0:00 – 2:30 |
| 2 | The idea, in one sentence | 2:30 – 3:30 |
| 3 | Break it live | 3:30 – 8:30 |
| 4 | Where the answer came from | 8:30 – 11:30 |
| 5 | What it's worth, and what I'm asking for | 11:30 – 13:30 |
| 6 | Questions | 13:30 – 15:00 |

Have open: a terminal, and `demo/PTR-401.html` in a browser tab.

---

## 1 — The nine things it made up

> I gave an AI a real ticket. Intraday PSR limit amendment — Risk Ops wants to
> change a counterparty's limit during the session, without a restart. Same
> ticket a BA would pick up.
>
> This is what came back. It's well written. It's complete. It's confident.
>
> And it's wrong in nine places.

Walk down the list. Don't rush it. Let the room react.

> It decided the amendment applies within 100 milliseconds. We never said that.
>
> It decided that if the limit service is unavailable, we let the order through.
> Nobody told it that. It chose it.
>
> It decided in-flight orders keep the old limit. It decided one person can
> approve an amendment. It decided we net exposure.

Then stop and say the actual point:

> Every one of those is a real decision. Someone has to make each of them, and
> right now that someone is a model, silently, in the middle of a document that
> reads like it was written by a person who knew.
>
> The one about failing open is the one that would keep me up. An order control
> that can't be evaluated has to reject. That's not an opinion, it's the
> obligation. And nothing in this document says it was ever considered.
>
> The problem isn't that the AI is bad at this. It's better than I expected.
> The problem is that nothing stopped it.

**If you haven't captured the ungated run:** don't fake it. Say
*"I ran this last night and I'll show you the file"*, or offer to run it live on
any feature someone names. The offer lands as well as the output.

---

## 2 — The idea, in one sentence

> AI proposes. Code decides. A named person signs.
>
> The model only ever gives two numbers and a sentence — how much we don't know,
> how hard it is. Everything after that is arithmetic, and the arithmetic is in a
> library, not in the model. Then a person signs it.
>
> And no stage can pass itself.

That last line is the whole thing. Say it slowly.

---

## 3 — Break it live

This is the beat. Everything before it was setup.

> This is the same feature, run through the pipeline. Every requirement has
> acceptance criteria. Every claim either cites a page or is flagged as a
> question nobody has answered.
>
> Now watch me try to cheat it.

```
node demo/tamper.mjs
```

Six edits. Six refusals. Talk over it:

> I changed one number — a score, from 2 to 21. The file now disagrees with its
> own arithmetic. It caught it twice, from two different directions.
>
> I typed "TBD" into a requirement. A requirement that says TBD hasn't been
> elaborated. It's been postponed.
>
> I reworded a quote by one word. It went back to the actual Confluence page and
> re-read it. The quote isn't there any more, so the citation is a lie, so the
> document is refused.

Then land the last one:

> And this one. I changed the sign-off from a person to the agent.
>
> *An agent cannot sign off its own requirements.*
>
> That's not a policy in a wiki that everyone agrees with and nobody follows.
> It's forty-six checks in a piece of code, and the document does not come out
> the other side.

Say the honest bit too — it's stronger, not weaker:

> Same input, same answer, every time. There's no model anywhere in that. The
> thing that judges the work isn't the thing that did the work.

---

## 4 — Where the answer came from

Open `demo/PTR-401.html`.

> Some questions got answered. Some didn't. Both matter.

Point at a citation:

> That one came out of a page called "Gateway Notes." No labels, last edited
> fourteen months ago by someone who's left. The answer is in the first
> paragraph. Nobody was ever going to find that page. This found it in about
> forty milliseconds.

Then the more interesting half:

> And this one it wouldn't answer. What happens to orders already working when
> we reduce a limit.
>
> It didn't guess. It put a question in the document, with a name against it,
> and the document can't be signed while that question is open.

Then the line worth pausing on:

> I went looking afterwards. There's a ticket open in our own Jira asking
> exactly that. Nobody has decided. So the machine and the tracker agree — and
> the machine found it in twenty minutes rather than in UAT.

If someone asks about the hedge marker:

> That page didn't say "the cutoff is five seconds." It said "I think it's five
> seconds, check with the team." So it's cited, and it's flagged as hedged, and
> it carries a risk somebody has to accept by name. It doesn't turn someone's
> guess into a fact just because it's now in a document.

---

## 5 — What it's worth, and what I'm asking for

Don't put a number up. Get one from the room.

> I'm not going to tell you what this saves. I'll tell you what it does and you
> can price it.
>
> It counts unknowns. Each one either gets answered from something we've already
> written down, with a citation — or it becomes a question for a named person.
>
> So the question for you is: what does one clarification round-trip cost us
> today? PO, tech lead, QA, and the work sitting still while we wait.

Let them answer. Then:

> Whatever that number is, multiply it by the ones we didn't have to ask.

Then the bigger one:

> But that's the small argument. The bigger one is the nine things at the start.
>
> A requirements defect in an order-path control isn't a bug. If we let an order
> through because nobody wrote down what happens when the limit service times
> out, that's not a sprint problem. That's a conversation with a regulator.
>
> This is a machine that will not let that decision go unmade.

The ask:

> Two things.
>
> One — let this be how agentic delivery work gets done here. Not a tool people
> can pick up. The way it's done.
>
> Two — one squad, one quarter, and we count it properly. How many questions got
> answered from what we already knew, how many went to a person, and what came
> back late anyway.

---

## What to volunteer before anyone finds it

Say these yourself. It buys more than it costs.

- **This is phase one of four.** Requirements only. Design, planning and
  implementation are specified and not built. Starting here was deliberate —
  it's where the expensive mistakes are made.
- **The pages you saw are synthetic.** I wrote them so this runs on a laptop
  with no network. Every one carries a banner saying so. The same content is in
  Confluence, so what you're watching is exactly what the live run does.
- **Access control is owner-only against live data.** Group-level visibility
  works against fixtures, not against our Confluence yet. Don't let me claim
  otherwise.
- **No cost reporting.** Call counts and latency, yes. Pounds and tokens, no —
  the CLIs we use don't report them.
- **The retrieval is deliberately conservative.** On a small corpus it escalates
  more than it needs to. That's the safe direction, and we're tuning it.

---

## If it breaks

- **Live Confluence won't reach.** Fall back to fixtures. Same content, same
  behaviour. Say so and carry on — nothing else changes.
- **The gate refuses something you expected to pass.** Read the check ID out
  loud. That *is* the product working. Don't apologise for it.
- **Embeddings unavailable.** Say it's running on text search only. Do not use
  the fake embedder and do not call it semantic search.
- **`tamper.mjs` exits 1 saying it skipped tampers.** The artefact hasn't been
  generated. Run:
  `pnpm eil reqs elaborate PTR-401 --out demo/PTR-401.reqs.json`
- **Grafana.** Not showing it. Needs Docker. `eil report` instead.

---

## The three lines to get right

1. *"The problem isn't that the AI is bad at this. It's that nothing stopped it."*
2. *"An agent cannot sign off its own requirements."*
3. *"It didn't guess. It asked."*
