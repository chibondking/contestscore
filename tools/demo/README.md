# Demo replay

Play a captured contest back into a local contestscore as live N1MM UDP
traffic, time-compressed, so you can narrate a real-time dashboard for a
club talk without a radio or a contest in progress. The same machinery also
doubles as a **multi-op load-test rig**: replay a whole real Cabrillo log
as if it were several stations reporting live, to shake out a deployment
(ContestPulse, the busts panel, the dashboard's own rendering) against
realistic volume before a real multi-op weekend.

```
snapshot.js             capture a running instance -> snapshot-<stamp>.json
cabrillo-to-snapshot.js  turn a submitted Cabrillo log into a synthesized
                         multi-op snapshot -- random operator assignment,
                         a run/S&P heuristic, approximate WPX-shaped
                         points/mults (see its own header comment)
replay.js                re-emit a snapshot as <contactinfo> /
                         <dynamicresults> / <RadioInfo> UDP packets
                         (including a per-QSO F-key/PTT simulation),
                         pacing them like the real contest
```

`replay.js` is a stand-in for ContestPulse: same packet shapes, same ports.
Nothing here needs Playwright or a browser — you just open the dashboard in
any browser and talk over it while it fills in.

> **Never point `--reset` (or `snapshot.js`/`replay.js`'s `--api`) at a
> production instance someone else is watching.** `--reset` calls
> `DELETE /api/db` on whatever `--api` names — against `scoreboard.wt2p.us`
> or any other shared deployment, that wipes the real contest history, not
> just this tool's own scratch data. `replay.js`'s UDP packets themselves
> are also **not addressed to a URL at all** — `--host`/`--radio-port`/
> `--contact-port`/`--score-port` name a destination the same way N1MM's
> own Broadcast Data config would, so pointing them at a real ContestPulse
> relay (rather than a local contestscore's own UDP listeners) sends this
> tool's synthetic traffic through to whatever server that relay forwards
> to, live-scoreboard included. Everything below defaults to `localhost` on
> purpose -- change `--api`/`--host` deliberately, never by habit.

## One-time: a throwaway local instance

From the repo root, run contestscore against a scratch database so the demo
never touches your real `data/qsos.db`:

```sh
DB_PATH=./tools/demo/demo.db npm start
```

Leave that running. Dashboard: <http://localhost:3000>. It listens for UDP
on 12060/12061/12062 — the ports `replay.js` sends to by default.

## Run the demo

```sh
# newest snapshot in this folder, clean slate, ~8 min walkthrough
node tools/demo/replay.js --reset --duration 8
```

You'll see the dashboard's QSO count, rate meter, score, per-operator
charts and the Radios panel move as it goes. Open `/charts.html` in another
tab to show the trend charts building.

Useful variants:

```sh
node tools/demo/replay.js --reset --speed 20          # 20x real time
node tools/demo/replay.js --reset --interval 1500      # flat 1.5s per QSO
node tools/demo/replay.js --reset --loop               # booth mode: repeat forever
node tools/demo/replay.js --reset --from 1 --max 25    # just the first 25
node tools/demo/replay.js snapshot-20260910T221352Z.json --reset
```

`--duration N` picks the speed to finish in about N minutes. `--speed N`
divides every real gap by N; each wait is then clamped to
`[--min-gap, --max-gap]` (250 ms – 5 s) so a long lull becomes a beat and a
run still has rhythm. `--interval` ignores the real timing entirely.

`--help` lists every flag.

## Load-testing a multi-op deployment from a real Cabrillo log

A submitted Cabrillo log has none of a live multi-op's per-operator/
run-vs-S&P/points detail -- it's one flattened line per QSO. Turn it back
into a plausible multi-op snapshot first:

```sh
node tools/demo/cabrillo-to-snapshot.js path/to/log.txt
```

This reads the log's own `OPERATORS:` line and its trailing multi-
transmitter column (the `0`/`1` at the end of a `QSO:` line, present in a
`CATEGORY-TRANSMITTER: TWO`-style log) to build real per-radio timelines,
then synthesizes what Cabrillo can't carry:

- **operator** -- randomly assigned per radio, in 15-60 QSO blocks (a
  shift, not a coin flip every contact)
- **is_run_qso** -- a same-radio gap under 90s (`--run-gap` to change it)
  reads as still running the frequency; a bigger gap reads as S&P
- **points / WPX prefix mults** -- an approximate, *not official*,
  WPX-shaped rule (see the script's own header comment) -- enough for the
  score to climb and mults to tick, not for scoring accuracy

It prints the RNG seed it used (`--seed <n>` reproduces the exact same
operator assignment on a re-run) and writes a `snapshot-*.json` that
`replay.js` picks up exactly like a real capture:

```sh
node tools/demo/cabrillo-to-snapshot.js path/to/log.txt
node tools/demo/replay.js --reset --speed 40           # against your local instance
```

For a *load* test specifically -- proving a real ContestPulse relay and
the server hold up under multi-station volume, not just narrating a demo
-- point `replay.js` at ContestPulse's own listening ports instead of a
local contestscore's:

```sh
node tools/demo/replay.js --host <contestpulse-host> --speed 1
```

`--speed 1` replays at the log's own real pace (this is what "in
real time" means here -- a full 48-hour contest log takes 48 hours; slice
it first with `--from`/`--max`, or accept a higher `--speed`, for anything
shorter). Leave `--reset` off entirely for this path -- there's no local
`/api/db` to reset when the target is a relay, not a contestscore instance
you own.

## Re-capture

The checked-in snapshot is whatever was live when it was taken. To grab a
fresher or bigger one:

```sh
node tools/demo/snapshot.js                       # from scoreboard.wt2p.us
node tools/demo/snapshot.js --api http://localhost:3000
```

`replay.js` defaults to the newest `snapshot-*.json` next to it.

## Notes

- **Score.** `replay.js` re-derives the running score from the QSOs as it
  goes and auto-detects the formula (`points` vs `points × mults`) from the
  snapshot's score history. Override with `--score-formula`.
- **Timestamps.** Packets carry the original QSO time, but contestscore
  stamps its own `logged_at` on receipt — so the rate meter and every
  time-based chart build over the *replay's* wall-clock, which is what you
  want on stage.
- **Editing the story.** `--from` / `--max` trim to a slice; drop QSO
  objects from the snapshot's `/api/qsos` array to prune specific contacts.
- **F-key/PTT simulation.** Every QSO now gets a small `RadioInfo` pulse
  around it -- `IsTransmitting` true with a `FunctionKeyCaption` ("F1: CQ"
  for a run, "F2: My Call" for S&P, closing with a "F4: TU"-style caption),
  then back to listening -- scaled by `speed` so it doesn't add a fixed
  delay regardless of how compressed the replay is. `--no-fkey` skips just
  this (the sparse band/mode/op-change `RadioInfo` still sends unless
  `--no-radio` too); these are plausible F-key labels, not a claim about
  what any specific operator's own N1MM macros actually say.
