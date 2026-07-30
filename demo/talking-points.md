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

Have open: a terminal, `demo/PTR-401.html` in a browser tab, and the PTR-DEMO
Confluence page **Gateway Notes** in a third tab — you show that one in beat 4
so the room can see where the text lives. The demo itself never touches
Confluence; the tab is a visual aid.

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
> I reworded a quote by one word. It went back to the document it cited, re-read
> it, and looked for that quote character for character. It isn't there any
> more, so the citation is a lie, so the document is refused.

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

And say this while it's running — it's a strength, so don't bury it:

> The model's answers here are a recording of a run, not a live call, so this is
> reproducible in the room and you'll get the same document tomorrow.
>
> Everything doing the checking is live: the retrieval, the forty-six checks, and
> the re-reading of every quote out of the corpus. Either way the citations get
> verified against the actual pages — that part never trusts the model.

---

## 4 — Where the answer came from

Open `demo/PTR-401.html`.

> Some questions got answered. Some didn't. Both matter.

Point at a citation:

> That one came out of a page called "Gateway Notes." No labels, last edited
> fourteen months ago by someone who's left, and it's somebody's notes to self.
> The answer is halfway down it. Nobody was ever going to find that page. This
> found it in about forty milliseconds.

Then switch to the browser and put "Gateway Notes" up in Confluence next to the
citation. Let the room read the sentence in the page and the sentence in the
artefact and see they are the same.

> And there's the page. That's the sentence it quoted.

*Note to you, not to the room:* this is a visual aid. The tool read its own
indexed copy of that page, not Confluence — the whole demo runs off a local
corpus, which is why there's no network anywhere in this. If someone asks
directly, say exactly that; it costs nothing and the content is identical
either way.

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

> That page didn't say "the refresh takes 250 milliseconds." It said it was
> aiming for 250, that the author thinks it got roughly there, and that he hasn't
> measured it recently. So it's cited, it's flagged as hedged, and it carries a
> risk that s.iyer has accepted by name. It doesn't turn someone's guess into a
> fact just because it's now in a document.

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
- **The pages you saw are synthetic, and they're in Confluence so you can look
  at them.** I wrote them for this. Every one carries a banner saying so. The
  demo doesn't fetch them — it reads its own indexed copy of the same text off
  this laptop, so nothing you're watching depends on the network.
- **The group-level access control is real, and it's fed from the local
  corpus.** Visibility is stamped on the document, reads fail closed, and one
  page is restricted to a group — a caller outside that group gets no trace of
  it. What's missing is upstream: no connector stamps groups yet, so a live
  Confluence sync would give us owner-level visibility only. Known gap, and
  it's in the connector, not in the enforcement.
- **No cost reporting.** Call counts and latency, yes. Pounds and tokens, no —
  the CLIs we use don't report them.
- **The retrieval is deliberately conservative.** On a small corpus it escalates
  more than it needs to. That's the safe direction, and we're tuning it.

---

## If it breaks

- **Someone wants to see it run against the real Confluence, now.** Don't.
  Say the connectors are real and scoped, offer to show them afterwards, and
  open the page in the browser instead — that's what they actually want to
  look at. There is no network in this run and that is the point.
- **The gate refuses something you expected to pass.** Read the check ID out
  loud. That *is* the product working. Don't apologise for it.
- **Embeddings unavailable.** Say it's running on text search only. Do not use
  the fake embedder and do not call it semantic search.
- **`tamper.mjs` exits 1 saying it skipped tampers.** The artefact hasn't been
  generated. Run: `pnpm demo:reqs`
- **Grafana.** Not showing it. Needs Docker. `eil report` instead.

---

## The three lines to get right

1. *"The problem isn't that the AI is bad at this. It's that nothing stopped it."*
2. *"An agent cannot sign off its own requirements."*
3. *"It didn't guess. It asked."*
