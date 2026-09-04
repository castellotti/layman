# <Harness Name>

<!--
Template for `docs/harnesses/*.md`. Copy this file, rename it to the harness id
(`pi.md`, `codex.md`, …), and delete every comment block as you fill it in.

These pages answer one question for a user who already has Layman running:
"how do I get *this* harness into the dashboard, and what will and won't work
once it's there?" Keep that user-facing part (everything above the
"Architecture & implementation notes" heading) to roughly 25–40 lines and one
screen.

Deep mechanism and design rationale now live in these pages too, under a final
"## Architecture & implementation notes" section (see `claude-code.md` /
`pi.md`), because the root `CLAUDE.md` has a size limit and harness-specific
detail was pushing it over. The root file keeps only the shared pipeline and
cross-cutting decisions, with a pointer to `docs/harnesses/<harness>.md`. Add
that section when you have detail that belongs to one harness; leave it off for
a genuinely simple integration.
-->

<!--
One or two sentences: the integration mechanism, and the single most important
caveat. This paragraph is what a reader skims to decide whether to keep reading.

  "Codex uses shell-script hooks that Layman installs to `~/.codex/hooks/layman/`…"
  "Vibe has no hook or plugin system, so Layman monitors it passively…"
-->

## Installation

<!--
Numbered steps, in the order the user performs them. Name the exact paths
Layman writes to, so a user can verify or remove them by hand.

If installation is one click in the dashboard, say so and name the button
exactly as it appears: **Settings -> Harness** -> **Install**.

If a manual step is unavoidable (OpenCode's plugin registration, a feature flag
the harness ships disabled), give it its own numbered step and say *why* it
can't be automated — otherwise it reads as an oversight.

If the harness must be restarted for the integration to load, say that here.
Omit this whole section only for genuinely zero-config integrations.
-->

## Activating a session

<!--
Sessions are opt-in unless stated otherwise. Cover:

  - the exact activation token (`/layman`, `$layman`, `@layman`) and where it is typed
  - what the user should see in the dashboard once it works
  - the auto-activate toggle, named by its real UI location:
    **Settings -> Harness** -> **Auto-activate sessions** on this harness's row

If no activation step exists (Vibe), replace this section with a short
"**No activation step is needed.**" paragraph and explain what triggers capture.
-->

## Capabilities

<!--
A short bullet list of what this harness gives Layman that a reader would
otherwise have to discover empirically. Draw from:

  - tool approval / denial from the Layman UI (and whether it blocks the agent)
  - prompt submission from the Layman UI (bidirectional)
  - live token streaming, and at what fidelity (token-level vs post-turn counter)
  - thinking / reasoning blocks captured separately from the response
  - session metrics: model, context %, cost, tokens
  - historical import or replay of pre-activation history
-->

## Limitations

<!--
The mirror of Capabilities, and the section users actually come back for.
Be specific and give the reason, not just the symptom:

  "Codex supports 5 hook events … features that require `PermissionRequest`
   are not available."

Cover blocking timeouts, missing event types, required host binaries (`jq`),
and anything that silently degrades rather than failing loudly.

Delete this section only if there are genuinely no limitations worth naming —
which has not yet been true of any harness.
-->

## Notes

<!--
Optional. Version requirements, upstream feature flags, known-flaky behaviour.
Deep mechanism and design rationale go in the "Architecture & implementation
notes" section below rather than here. Delete if empty.
-->

## Architecture & implementation notes

<!--
Optional, and the only part of this page that is not user-facing. The mechanism
and the "why", moved out of the root `CLAUDE.md` because it has a size limit:
how the integration wires into Layman, the non-obvious design decisions, and the
bugs each one prevents. Lead with a one-line note that it moved from `CLAUDE.md`
(see `claude-code.md` / `pi.md` for the shape). The root file keeps only a
one-line pointer to this section. Delete for a genuinely simple integration that
has no detail of its own.
-->
