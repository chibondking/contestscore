# Demo replay

Play a captured contest back into a local contestscore as live N1MM UDP
traffic, time-compressed, so you can narrate a real-time dashboard for a
club talk without a radio or a contest in progress.

```
snapshot.js   capture a running instance -> snapshot-<stamp>.json
replay.js     re-emit that snapshot as <contactinfo> / <dynamicresults> /
              <RadioInfo> UDP packets, pacing them like the real contest
```

`replay.js` is a stand-in for ContestPulse: same packet shapes, same ports.
Nothing here needs Playwright or a browser — you just open the dashboard in
any browser and talk over it while it fills in.

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
