-- hamqsl occasionally reports <solarflux>0</solarflux> (a feed glitch: the
-- real flux never drops below ~65), which drew spikes to zero on the solar
-- page. Each such reading takes the SFI of the newest earlier non-zero
-- reading instead (CJ, 2026-11-08); src/solar/index.js's carryForwardSfi()
-- does the same for new readings. An UPDATE of the one bad value -- the
-- rows themselves are kept, as solar_snapshots always is. A 0 with no
-- earlier reading becomes NULL ("no value") rather than staying 0.
UPDATE solar_snapshots
SET sfi = (
  SELECT p.sfi FROM solar_snapshots p
  WHERE p.fetched_at < solar_snapshots.fetched_at AND p.sfi > 0
  ORDER BY p.fetched_at DESC, p.id DESC
  LIMIT 1
)
WHERE sfi = 0;
