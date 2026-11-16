# glove netobs fixture (copy)

A byte-for-byte copy of glove's `tests/fixtures/netobs/`: a `net/` directory produced by glove's real
gate code, covering every fixture-marked state in glove's state table. It is the cross-repo contract
test for Layman's reader (`../fixture.test.ts`).

- Copied: 2026-11-16
- From glove `main` at `c5bd863` (regenerated 2026-10-16: the exit is `vpn-endpoint`, no country; the services are `webfetch-mcp`/`webfetch-egress`)

Do not edit these files. To refresh:

```bash
cd ../glove && uv run python tests/fixtures/netobs/generate.py   # regenerate in glove, if needed
cp ../glove/tests/fixtures/netobs/* packages/server/src/netobs/__fixtures__/
```

then update the date and commit above. `fixture.test.ts` includes a drift guard that fails when this
copy differs from `../glove/tests/fixtures/netobs/` (and is skipped when glove is not checked out
next to this repo), so a stale copy is noticed rather than silently tested against.
