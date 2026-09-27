# glove netobs scenarios (copy)

A byte-for-byte copy of glove's `tests/fixtures/netobs-scenarios/`: one complete `net/` directory per
state in glove's state table that the original fixture (`../__fixtures__/`) lacks, written by glove's real
forwarder and collector code. glove's own `README.md` here says what each scenario contains and what
was forced. Read by `../scenarios.test.ts`.

- Copied: 2026-09-25
- From glove commit `ab0ad9f`, merged to glove's `main` as `405683c` (PR #11). The scenario
  data is unchanged since `aec500b`; only `generate.py` moved on.

Do not edit these files (this one excepted). To refresh:

```bash
rsync -a --delete --exclude COPIED.md ../glove/tests/fixtures/netobs-scenarios/ packages/server/src/netobs/__scenarios__/
```

then update the date and commit above. `scenarios.test.ts` has a drift guard that fails when this copy
differs from glove's (skipped when glove, or that directory, is not checked out next to this repo).
