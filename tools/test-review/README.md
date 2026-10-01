# Test review

A page for reading every test by hand, plus the check that the DXLog
native-broadcast change (`3cf5157`) left N1MM parsing alone. Run both from
the repo root.

## `test-review.html`

Every test the suite runs (403 at `3cf5157`), grouped by file, each with its
source, its `file:line` (linked on GitHub at the commit it was built from),
and the commit that added it (`git blame`). Filters: the logger packet path
(`test/parsers/`, `test/udp/`, `test/routes/ingest.test.js` -- what N1MM,
DXLog and TR4W packets go through), tests added since v1.4.0 or v1.3.2,
not yet reviewed, and search. Tick a test once read; ticks are kept in your
browser (localStorage, per commit), nowhere else.

Open it straight from disk, or rebuild it for the current checkout:

```sh
node tools/test-review/build.js
```

That runs the whole suite through `reporter.mjs` (a `node --test` reporter
that records each test's real file and line, so tests generated in a loop
are listed one by one) and fills `template.html`.

The three boxes at the top of the page (12/12 packets identical, 0 existing
test lines changed, the pass count) describe `3cf5157`; only the pass count
is recomputed on a rebuild.

## `compare-n1mm-parse.js`

```sh
node tools/test-review/compare-n1mm-parse.js            # vs 3cf5157^
node tools/test-review/compare-n1mm-parse.js v1.4.0     # or any ref
```

Parses every N1MM-format `<contactinfo>`/`<contactreplace>` packet in the
tests, and the DXLog N1MM-mode captures in `test/fixtures/dxlog/`, with both
the given ref's `src/parsers/contact.js` and the current one, and compares
the results field by field. Exits non-zero if any differ. At `3cf5157`
against `3cf5157^`: 12 of 12 identical.

To check that no existing test was edited or removed by a commit (only
added to):

```sh
git diff 3cf5157^ 3cf5157 -- test | grep -cE '^-[^-]'   # 0
```
