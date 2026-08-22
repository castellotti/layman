# <Harness Name>

<!--
Template for `docs/harnesses/*.md`. Copy this file, rename it to the harness id
(`pi.md`, `codex.md`, …), and delete every comment block as you fill it in.

These pages answer one question for a user who already has Layman running:
"how do I get *this* harness into the dashboard, and what will and won't work
once it's there?" They are not architecture docs — the mechanism belongs in the
root `CLAUDE.md` and any design rationale belongs in `docs/plans/`.

Keep it to roughly 25–40 lines. Every existing harness page fits in one screen;
that is deliberate, and a page that outgrows it is usually hiding a design note
that wants to live somewhere else.
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
Optional. Version requirements, upstream feature flags, known-flaky behaviour,
and links to the relevant `docs/plans/` document for anyone who needs the
rationale rather than the instructions. Delete if empty.
-->
