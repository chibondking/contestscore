# contestscore TUI

A terminal front end for the live results dashboard, for when you're SSHed
into the box and don't want a browser in the way.

```sh
npm run tui
```

That's it -- it defaults to `http://localhost:3000`, the instance running on
the same machine. On the hosted box use `cstui` instead (`deploy/cstui`,
installed to `/usr/local/bin` by the deploy): it runs this as the
`contestscore` user, which a login user has to do anyway since the app
directory is `750`, and looks the port up from the tenant's own
`tenant.env` -- `cstui`, `cstui nw8s`, `cstui --list`. `--url` or `CONTESTSCORE_URL` point it somewhere else
(mostly useful for testing against a scratch instance on another port).

```
 q   quit
 b   toggle the mult bell (off at startup)
 r   force a full refresh from the REST API
```

Shows the same things the dashboard's results core does: score + total
sparkline, the 10/30/60-minute rate meter, radios (band/mode/op, RUN, a red
dot while transmitting, the F-key caption while keying), QSOs by continent,
per-operator QSOs/points/peak rate, the stats page's at-a-glance tiles
(pts/QSO, average rate, DXCC, CQ zones, bands, hours active, elapsed), and
the recent QSO log with X-QSO / QTC / MULT flags. Not here: the Admin page,
the world map, Possible Busts.

On a terminal 94 columns or wider the screen splits: the QSO log, radios
and continents down the left, the glance tiles and the operator table down
the right beside them. That's the whole point of the split -- the QSO log
is the one section that wants every row it can get, and stacking everything
full-width was spending its vertical space on tables that only need a few
lines. The right pane is sized to the operator table (46 columns at most),
not to a fraction of the screen, so a very wide terminal gives the extra
columns to the log. Narrower than 94 it all stacks full-width as before,
and the operator table drops its 10m/hr column when the pane is too tight
for it.

A big multi-op is the case the widths are sized for: up to eight radios and
the whole operator roster on screen at once, the radio rows sorted by
station then radio number (so a radio that first reports mid-contest
doesn't land at the bottom of the list), and the radio-label and operator
columns sized to the names actually on screen -- a station prefix like
`SHACK-B R2` or a slashed call like `VE3ABC/W1` would otherwise run past a
fixed column and shove everything after it out of line on that one row. If
the terminal is too short for the full list, the radio table gives way
before the QSO log does and says `+N more` rather than just ending.

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
`public/js/dashboard.js`, not shared with it (and `glanceStats` the same
way from `public/js/stats.js`'s At a Glance tiles). They live inside
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
