# Styx

[Styx](https://github.com/Jigsaw-Studio/styx-godot) began as a Raspberry Pi WiFi access point that records
the traffic passing through it, and a [Godot](https://godotengine.org) app that draws it. Its best-known
view is the **Matrix**: green glyph rain with the domain names being accessed falling through it.

Layman's Styx extension draws the same picture for what an AI coding agent reached, and serves the data
in the shape styx-godot already reads, so that app can be pointed at Layman as well as at a Pi. It is
optional, off by default, and independent of glove: with it off there are no tabs and `/api/styx/` answers
404.

## Turning it on

**Settings → Extensions → Styx → Matrix views.** The setting is `styx.enabled` in
`~/.local/share/layman/layman.json`. `styx.godotDir` is for the Matrix (Godot) tab, which is not built yet.

## The tabs

| Tab | URL | What it is | Status |
|---|---|---|---|
| **Matrix** | `?view=matrix` | The real styx-godot web export, running its own shaders, in an iframe | coming |
| **Matrix 2D** | `?view=matrix2d` | Layman's own Canvas 2D rendering. No Godot | available |
| **Matrix 3D** | `?view=matrix3d` | Layman's own WebGL2 rendering. No Godot | available |

All three are session views (`/s/<id>?view=matrix2d`) and show the session open in the app, or else the
newest live one; with none they show every live session together.

**Matrix 2D.** A full-area canvas of monospace columns. Every column carries faint, slow filler rain.
Each destination falls as its own stream: its address in upper case, one character per row, the lowest
character brightest and the ones above fading out. A busier destination falls faster and comes back
sooner. A destination glove refused falls in the error colour, one that did not go through the tunnel in
the warning colour. A host reached for the first time falls at once, with a bright head, for that one
fall. A window picker (`1m`, `15m`, `1h`, `All`, remembered in the browser) chooses how far back to look; with
no session open, `All` means the last day, the longest the feed answers for every live session together. Hover
a stream for its address, count and bytes; click it to keep the card, which for a sandboxed session offers
**Open in Network**. The tab's shortcut is `X`. With Settings → Motion at Reduced or Off, it draws one still
frame instead of falling.

**Matrix 3D.** The same destinations, drawn on the GPU in a browser with WebGL2: larger glyphs, one stream
per column reading top to bottom, the head near white, a refused destination red, one that did not go
through the tunnel amber, a host reached for the first time in the accent colour for its first fall, and
faint filler rain behind them. It follows the window picker, the session, the theme (a light theme draws
dark glyphs on the light ground) and Settings → Motion exactly as Matrix 2D does, and hover and click give
the same card. A browser without WebGL2 shows a message and a button to Matrix 2D.

## The feed

`GET /api/styx/v1/matrix` has the shape of styx-os's `GET /v1/matrix` (its nginx exposes it as
`/api/v1/matrix`), plus optional fields styx-godot ignores. Layman serves it itself: the Pi's API reads
the Pi's packet database, and this is a second, independent source of the same shape.

| Query | Meaning |
|---|---|
| `relative` | Styx's own: a window ending now, `<integer><unit>`, unit `s`, `m`, `h` or `d` (`60s`, `15m`, `1h`). Absent: the whole record of the selected session. With no selector and no `relative`, the window is `15m`. |
| `session` | A Layman session id. If that session is gloved, the answer is its glove session's flows. |
| `glove` | A glove session id (the token the network views use). |

`session` and `glove` together: 400. Any of Styx's absolute-time parameters (`start_date`, `start_time`,
`end_date`, `end_time`, `timezone`, `client`): 400 with `{ "error": "… is not supported by Layman's Styx
feed" }`. A malformed `relative`: 400. An unknown `session` or `glove`: 404. Styx off: 404 for the whole
`/api/styx/` prefix.

The answer is a JSON array, highest `count` first, ties by `address` ascending, at most 256 rows:

```json
[
  { "address": "api.github.com:443", "sent": 5120, "received": 88211, "count": 14,
    "blocked": 0, "untunnelled": false }
]
```

| Field | Meaning |
|---|---|
| `address` | `host:port`, lower-case. For a standard session a URL with no port gets its scheme's (`:443` for https, `:80` for http), so the port tells which was used; `host` alone only for a target with no URL (an ssh host). |
| `sent`, `received` | Bytes up and down. 0 for a standard session. |
| `count` | How many times it was reached: flows for a gloved session, tool calls naming it for a standard one. Always at least 1. |
| `blocked` | Layman addition: how many of those glove refused. 0 for a standard session. |
| `untunnelled` | Layman addition: true when glove classed the traffic `direct` and it is not a known VPN route. false for a standard session. |

styx-godot reads only `address` and `count`.

## What the data is

- **A gloved session** (a Layman session whose name is a glove session id that Layman has network records
  for) uses glove's full flow data: bytes, counts, refusals. With a window, it is the flows in that
  window; without one, glove's running totals per destination, which survive the memory limit on old
  flows. A window reaches back only as far as the flows Layman still holds in memory, which is right for
  a recent window.
- **A standard session** uses the hosts its tool calls named (a `WebFetch` URL, a `curl` in a shell
  command), counted once per call. Bytes are 0. Traffic that no tool call named does not appear.
- **With no selector**, every live gloved session and every live standard session, merged.
- **A hop is not a destination.** A sandbox's local link to a sidecar (the llm-auth hop, say) is left out,
  as in the network views: its bytes are counted at the next leg.
- **Freshness.** A windowed answer for a standard session comes from the events Layman holds in memory, so
  a host a tool call names shows at once. The whole record of a standard session is reused for 5 s, so a
  new host can take that long to appear under **All**.

## Privacy

- Layman reads only its own records. The feed never makes a network call keyed on what it shows, and it
  never looks a host up (no DNS, no geolocation, no reputation service).
- Hosts are shown as recorded. For a standard session they come from events that went through the PII
  filter, so an IP address the filter redacted is not shown.
- Nothing here is synced between hosts, and the extension adds no table: the feed is computed on request.

## Licences

Layman is MIT. In styx-godot, the domain shader is the author's own (MIT), but its background and 3D rain
shaders are Shadertoy ports under CC BY-NC-SA 3.0. Layman's 2D and 3D renderers are therefore written from
scratch and share no code with any styx-godot shader. The Matrix (Godot) tab runs a build of styx-godot
that the user makes locally; Layman never ships it.
