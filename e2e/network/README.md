# Browser checks: glove network views

End-to-end checks of the Network, Map, Topology and Trace tabs, driven in a real Chrome against a
throwaway Layman fed by `packages/server/scripts/netobs-replay.ts`. The unit tests cover the
logic; these cover what only the running app shows: rendering, URLs, the control round trip through
a fake gate, restarts, and that every request goes to Layman itself.

```bash
make e2e-network                          # up, run all, down
scripts/netobs-e2e.sh up                  # or step by step
scripts/netobs-e2e.sh run network trace   # some checks
scripts/netobs-e2e.sh down --purge        # also delete the work dir and image
```

`up` builds the image, installs `playwright-core` into the work dir (not the repo, so it never
reaches the runtime image), writes a fake glove home with the fixture looping, glove's scenarios
and a 300-destination session, and starts the container on :8890. Nothing touches the live
Layman on :8880, its data, or `~/.glove`. Screenshots land in `$LAYMAN_E2E_DIR/shots`.

| Check | Covers |
|---|---|
| `network` | KPIs, destination table, filters, grouping, every flow state across the scenarios, windowing, 1280×800 |
| `control` | block/unblock through the fake gate, pending → enforced by hash, kill switch and restore, external edits, rejected rules |
| `map` | offline map, clusters, detail card, activity, ribbon; no off-site request |
| `topology` | diagram, bands, selected path, sizes |
| `trace` | turns, waterfall, joins, details, open-in-trace |
| `persistence` | rollups across three container restarts, no double count, history-only sessions (needs `sqlite3`) |
| `ip-setting` | `glove.showIpAddresses` in Settings, and the metadata fetch joined to its guard refusal |

Needs Node with the workspace installed (`pnpm install`), Docker or Podman, and Chrome
(`CHROME_PATH` for another binary). Variables are listed in `env.mjs`. The `persistence` and
`control` checks change the fake home and restart the container, so run the checks in the order
`run` uses when running all of them.
