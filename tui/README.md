# contestscore TUI

A terminal front end for the live results dashboard, for when you're SSHed
into the box and don't want a browser in the way.

```sh
npm run tui
```

That's it -- it defaults to `http://localhost:3000`, the instance running on
the same machine. `--url` or `CONTESTSCORE_URL` point it somewhere else
(mostly useful for testing against a scratch instance on another port).

```
 q   quit
 b   toggle the mult bell (off at startup)
 r   force a full refresh from the REST API
```

Shows the same things the dashboard's results core does: score + total
sparkline, the 10/30/60-minute rate meter, radios (band/mode/op, RUN, a red
dot while transmitting, the F-key caption while keying), QSOs by continent,
per-operator QSOs/points/peak rate, and the recent QSO log with X-QSO / QTC
/ MULT flags. Not here: the Admin page, the world map, Possible Busts.

The mult bell is the terminal's own bell character, so whatever your
terminal does for a bell is what you get. Same rules as the browser's: off
unless you turn it on, a `--after N` style threshold so the early hours stay
quiet, one ding per 2s burst, and nothing for edits or a replayed backlog.
`CONTESTSCORE_TUI_BELL=1` and `CONTESTSCORE_TUI_BELL_AFTER=50` set the
startup state; `b` toggles it live.

## How it fits

It's a **client only** -- nothing in `src/` knows it exists. The initial load
is `GET /api/{qsos,score,score/history,radios,rate,bridges,solar}` and
everything after that arrives on the same socket.io events the browser page
listens for, which is why it needs `socket.io-client` (the one dependency
the TUI adds). A reconnect re-syncs from REST, since anything that happened
during the gap arrived as events nobody was listening for.

The derivations it needs -- `scoreStale`, `operatorStats`,
`continentCounts`, `bandLabel`, the mult-bell rules -- are **copied** from
`public/js/dashboard.js`, not shared with it. They live inside
`dashboard()`'s closure in a classic browser script with no module system
(see CLAUDE.md), so sharing them would mean refactoring the page this only
mirrors; `report.js` and `compare.js` already keep their own copies of
`bandLabel` for the same reason. **If one changes in the dashboard, change
it here too.**

`--once` prints a plain-text snapshot instead of taking over the screen (no
escape codes, no socket, exit 1 if the API couldn't be reached) -- handy in
a pipe, and what gets used to eyeball it in CI-ish ways:

```sh
node tui/index.js --once
```
