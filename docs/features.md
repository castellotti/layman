# Features in Depth

Deep-dives on Layman's analysis, safety, and recording features. For the view-by-view tour, see the [README](../README.md).

## Automated risk analysis

Layman can use an AI model to classify the risk level of each action, explain what it means in plain language, and flag anything that looks risky. Requires an API key - see [AI analysis setup](installation.md#ai-analysis-optional).

- **Auto-explain** and **auto-analysis** run in the background with configurable severity thresholds (All / Medium+ / High only) and detail level (Quick / Detailed).
- User-initiated requests jump ahead of background analysis in a priority queue.
- The Investigation panel's **Explain** tab shows the Layman's Terms explanation followed by the risk analysis; **Chat** answers follow-up questions. Both use full-session context assembled selected-item-first, and a model selector in the panel header overrides the analysis model for all panel functions.

![Investigation panel](images/investigation.png)

**Chat** isn't limited to the selected event - ask it about the task or command in context, and it reasons across the whole session to answer.

![Investigation chat answering a session-context question](images/chat.png)

## Drift monitoring

Layman continuously monitors AI agent sessions for two kinds of drift:

- **Session goal drift** - detects when the agent strays from what you asked it to do (scope creep, phantom file references, pattern breaks).
- **Rules drift** - detects when the agent violates rules defined in your project's `CLAUDE.md` files (wrong commands, forbidden actions, convention breaks). `AGENTS.md` files are also supported for harnesses besides Claude Code.

Drift scores are EMA-smoothed (alpha 0.3) to avoid reacting to one-off spikes. Scores map to three color levels (green -> amber -> red) with configurable thresholds. At **amber** the agent gets an in-context reminder (on pi, which has no way to inject one, it is shown to you instead); at **red** Layman can pause the agent entirely and require your approval to continue. Individual drift findings can be dismissed as false positives - dismissed items are fed back into the LLM prompt so they won't be re-flagged.

![Drift monitoring](images/drift.png)

## Tool approval

For harnesses with pre-execution hooks (Claude Code, Codex, Cline), Layman can intercept tool calls before they execute and ask for your approval. Pending calls surface as callouts on the Dashboard and in Logs with **Allow / Deny / Defer** actions. Auto-approve levels (All / Medium / High / None) delegate low-risk calls automatically.

pi is the exception: it can block, but does not by default. pi's design position is that a coding agent should not impose permission popups, so Layman offers it as a per-harness choice instead of assuming it — turn on **Require approval for tool calls** on the pi row in **Settings -> Harness**. The change takes effect on the next tool call, with no pi restart.

![Tool approval](images/approval.png)

## Session recording, bookmarks, and search

Sessions can optionally be recorded to a local SQLite database, capturing user prompts, agent responses, permission requests, and tool calls. Recording is **opt-in**.

- **Sessions view** - bookmark folders above a newest-first **History** list, with keyboard navigation (↑/↓/Enter/Esc) and drag-to-reorder within folders.
- **Search** covers session names, working directories, and full event content. Matching sessions show match counts; inside a session, matched events are highlighted with ‹ › navigation between them.
- **Prompts view** - bookmark individual prompt/response pairs as Highlights, organized in the same folders + History structure, with a reading pane and **Open session** navigation.

![Sessions view](images/sessions.png)

![Prompts view](images/prompts.png)

## Historical session import

Layman can discover and import past sessions from JSONL transcript files that were never monitored live - Claude Code (`~/.claude/projects/`) and pi (`~/.pi/agent/sessions/`). **Settings -> Data** provides a scan dialog with per-session results, a Harness column, and an optional auto-import-on-startup flag. Existing live sessions are enriched with missing events without downgrading their live status.

pi's session files are format-version-3 JSONL *trees* (entries link by `id`/`parentId` rather than forming a flat sequence, since pi branches in place on `/fork`), so import walks from the latest-timestamp leaf back to the root and imports only that path - abandoned branches are left out rather than replayed as if they happened. Reasoning is carried through directly from pi's own `thinking` content blocks, the same clean separation the live extension gets, with no `<thinking>`-tag parsing involved.

## PII filter

All logged events are automatically scanned for personally identifiable information (email addresses, API keys, passwords, credit card numbers, JWTs - 24 categories) and redacted **before storage**. Toggle in **Settings -> Data**.

## File and URL access tracking

Layman tracks every file the agent reads or writes and every URL it fetches during a session, surfacing them in a dedicated access panel so you can see exactly what was touched.

![Access tracking](images/access.png)

## Session summary

Each session header shows an AI-generated plain-English summary of what the agent did, updated live as the session progresses and available in history. Click the summary to see previous versions and timestamps.

## Session metrics

When connected to Claude Code, sessions show live metrics: model name, context window usage (exact `ctx NN%` with a meter), cumulative session cost, token counts, lines changed, and rate-limit warnings in the account limits strip. pi reports the same metrics plus its current reasoning level.

Cost is shown only when it is non-zero. A locally hosted model has every cost field set to zero, and a permanent `$0.00` in the most prominent slot would crowd out the numbers that actually move.

## Live token streaming

Harnesses that expose a streaming hook push partial output to the dashboard as it is generated: a row pinned to the tail of the Logs stream showing the response as it is written, the model's reasoning rendered separately and de-emphasised, and a token counter that ticks during generation. When the turn finishes, the live row is replaced by the committed response.

The live count is shown as `~1.2k out` because no harness reports usage while it is still generating — it arrives with the finished message, by which point the live row is gone. The `~` marks a figure derived from the output so far; the exact numbers appear in the session metrics bar once the turn ends.

Fidelity depends on what each harness exposes. Where there is no streaming hook, there is simply no live row — nothing is stuck or empty:

| Harness | Live text | Live thinking | Live tokens |
|---|:-:|:-:|:-:|
| pi | token-level | token-level, separate stream | live estimate, exact after |
| OpenCode | token-level | `reasoning` parts | live estimate, exact after |
| Claude Code | ❌ | ❌ | post-turn counter |
| Codex | ❌ | ❌ | post-turn only |
| Cline | ❌ | ❌ | post-turn only |
| Mistral Vibe | ❌ | ❌ | post-turn only |

Two toggles in **Settings -> Stream behavior**: **Live tokens** turns the channel off entirely, and **Live thinking** drops just the reasoning stream. Both take effect on the server, so turning them off stops the data being sent rather than merely hidden. Streamed text passes through the same PII filter as recorded events.

## Multi-host sync

Run Layman on more than one machine and bring their sessions together. One instance acts as the **central** store; each other machine runs as a **remote** that keeps recording locally, exactly as a standalone install does, and **pushes** its data to central whenever it is reachable. Interruptions recover with no loss or duplicates — a dropped connection simply re-sends from where it left off.

Central shows every remote's sessions in **Sessions**, **Prompts** and search, each tagged with a **host chip** naming the machine it came from, and surfaces a remote's *live* session on the **Dashboard** — a read-only row with a running indicator and its last few events — within a few seconds. No approvals and no live token streams cross hosts. Bookmarks, folders and highlights sync too, and stay **read-only on any machine that did not create them** (the chip is shown, the rename/delete/drag affordances are not).

An optional **Mirror** mode on a remote pulls central's full history — every *other* host's data — so it can be browsed and searched offline. Settings → Multi-host sync carries per-host statistics (sessions, events, content size, last seen), token issuance for enrolling remotes, and the Mirror and danger-zone controls.

Set up in **Settings → Connection → Multi-host sync**. The network model is a private LAN / Tailscale / VPN with per-host bearer tokens over plain HTTP; **the dashboard itself has no authentication and must not be exposed to the public internet**. See [installation.md → Running a central instance](installation.md#running-a-central-instance) for the deployment steps.

![Multi-host sync settings](images/multi-host-sync.png)

## Setup wizard

First-run setup is guided by a wizard that detects installed AI clients and walks through configuration options.

![Setup wizard](images/wizard.png)
