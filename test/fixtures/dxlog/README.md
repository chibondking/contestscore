Real UDP packets from DXLog.net 2.6.37 with its N1MM-compatible broadcast
turned on (CW-OPS test session, captured 2026-09-30 by WT2P). Byte-for-byte
as received; used by test/parsers/dxlog.test.js and test/udp/pipeline.test.js.

- `radioinfo.xml`: `<RadioInfo>` (port 12064). Note `<Station>`, not N1MM's `<StationName>`.
- `contactinfo.xml`: a new QSO (K9CT, 40m, a new multiplier), port 13061.
- `contactreplace-xqso.xml`: the X-QSO of K9MMS: `IsClaimedQso` 0, points 0, mult cleared.
- `dynamicresults.xml`: the score post (port 12062), sent on DXLog's online-scoreboard timer.

DXLog's native broadcast (its own format, N1MM-compatible broadcast off), same
session, as received:

- `native-contactinfo.xml`: a new QSO (K3WW): `<guid>`, `<stationid>`, `<nr>`,
  `<exch1>`/`<exch2>`, and `<mult1>K3WW</mult1>` (the mult's value, not a flag).
- `native-contactinfo-xqso.xml`: the same QSO marked X-QSO: same `<guid>`,
  `<newqso>False`, `<xqso>True`, points 0, `<mult1>` empty.
