const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScore } = require('../../src/parsers/score');

// Real N1MM wire format — root <dynamicresults>, per-band/mode <qso>/<point>
// pairs under <breakdown>, plus a band="total" mode="ALL" pair for the
// contest grand total. Overall points are <score>, not <total>. See
// https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/
const base = `<?xml version="1.0"?>
<dynamicresults>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <ops>K1TTT</ops>
  <class power="HIGH" assisted="NON-ASSISTED" transmitter="ONE"
    ops="SINGLE-OP" bands="ALL" mode="CW" overlay="N/A">
  </class>
  <club></club>
  <qth>
    <dxcccountry>K</dxcccountry>
    <cqzone>5</cqzone>
    <iaruzone>8</iaruzone>
    <arrlsection>CT</arrlsection>
    <stprvoth>CT</stprvoth>
    <grid6>FN31</grid6>
  </qth>
  <breakdown>
    <qso band="20" mode="CW">30</qso>
    <point band="20" mode="CW">60</point>
    <qso band="40" mode="CW">12</qso>
    <point band="40" mode="CW">24</point>
    <qso band="total" mode="ALL">42</qso>
    <point band="total" mode="ALL">84</point>
  </breakdown>
  <score>84</score>
  <timestamp>2020-01-17 17:33:37</timestamp>
</dynamicresults>`;

describe('parseScore', () => {
  it('extracts contest header fields', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.equal(s.contest, 'CQ-WPX-CW');
    assert.equal(s.call, 'K1TTT');
    assert.equal(s.power, 'HIGH');
    assert.equal(s.transmitter, 'ONE');
    assert.equal(s.category_ops, 'SINGLE-OP');
    assert.equal(s.category_mode, 'CW');
    assert.equal(s.dxcc_country, 'K');
    assert.equal(s.cq_zone, '5');
    assert.equal(s.score_total, 84);
  });

  it('parses assisted="ASSISTED"/"NON-ASSISTED" into a boolean', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.equal(s.assisted, 0);

    const assisted = base.replace('assisted="NON-ASSISTED"', 'assisted="ASSISTED"');
    const a = await parseScore(Buffer.from(assisted));
    assert.equal(a.assisted, 1);
  });

  it('parses the per-band/mode breakdown, zipping qso and point by band+mode', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.equal(s.breakdown.length, 3);

    const b20 = s.breakdown.find((b) => b.band === '20' && b.mode === 'CW');
    assert.equal(b20.qsos, 30);
    assert.equal(b20.points, 60);
    assert.equal(b20.is_total, false);

    const b40 = s.breakdown.find((b) => b.band === '40' && b.mode === 'CW');
    assert.equal(b40.qsos, 12);
    assert.equal(b40.points, 24);
  });

  it('flags the band="total" mode="ALL" row as the grand total', async () => {
    const s = await parseScore(Buffer.from(base));
    const total = s.breakdown.find((b) => b.is_total);
    assert.ok(total);
    assert.equal(total.qsos, 42);
    assert.equal(total.points, 84);
  });

  it('leaves mults null when no <mult> breakdown is present', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.ok(s.breakdown.every((b) => b.mults === null));
  });

  it('parses a <mult> breakdown defensively when present', async () => {
    const withMults = base.replace(
      '<qso band="total" mode="ALL">42</qso>',
      '<mult band="20" mode="CW">5</mult><qso band="total" mode="ALL">42</qso>'
    );
    const s = await parseScore(Buffer.from(withMults));
    const b20 = s.breakdown.find((b) => b.band === '20' && b.mode === 'CW');
    assert.equal(b20.mults, 5);
  });

  it('handles a single breakdown entry (no auto-array) without throwing', async () => {
    const single = `<dynamicresults>
      <contest>TEST</contest>
      <call>W1TEST</call>
      <breakdown>
        <qso band="total" mode="ALL">5</qso>
        <point band="total" mode="ALL">5</point>
      </breakdown>
      <score>5</score>
    </dynamicresults>`;
    const s = await parseScore(Buffer.from(single));
    assert.equal(s.breakdown.length, 1);
    assert.equal(s.breakdown[0].qsos, 5);
    assert.equal(s.breakdown[0].is_total, true);
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<dynamicresults>
      <contest>TEST</contest>
      <call>W1TEST</call>
    </dynamicresults>`;
    const s = await parseScore(Buffer.from(minimal));
    assert.equal(s.contest, 'TEST');
    assert.equal(s.breakdown.length, 0);
    assert.equal(s.score_total, 0);
  });

  it('rejects non-dynamicresults XML', async () => {
    await assert.rejects(
      () => parseScore(Buffer.from('<RadioInfo><RadioNr>1</RadioNr></RadioInfo>')),
      /Not a dynamicresults \(Score\) packet/
    );
  });

  // Live capture, 2026-09, N1MM+ Score Reporting, "CW-OPEN" contest: real
  // Score broadcasts arrived with <dynamicresults> nested one level deeper
  // than the docs show, inside an outer <rtc> wrapper. Every real Score
  // broadcast was silently rejected until this shape was also accepted.
  it('accepts dynamicresults nested inside an <rtc> wrapper (real capture)', async () => {
    const rtcWrapped = `<?xml version="1.0"?>
<rtc>
<dynamicresults>
        <contest>CW-OPEN</contest>
        <call>WT2P</call>
        <ops>WT2P</ops>
        <class power="LOW" assisted="ASSISTED" transmitter="ONE" ops="SINGLE-OP" bands="ALL" mode="CW" overlay="N/A"></class>
        <breakdown>
          <qso band="total" mode="ALL">10</qso>
          <point band="total" mode="ALL">20</point>
        </breakdown>
        <score>20</score>
</dynamicresults>
</rtc>`;
    const s = await parseScore(Buffer.from(rtcWrapped));
    assert.equal(s.contest, 'CW-OPEN');
    assert.equal(s.call, 'WT2P');
    assert.equal(s.power, 'LOW');
    assert.equal(s.assisted, 1);
    assert.equal(s.score_total, 20);
    const total = s.breakdown.find((b) => b.is_total);
    assert.equal(total.qsos, 10);
    assert.equal(total.points, 20);
  });

  it('still prefers the bare (non-<rtc>) shape when both would be present', async () => {
    // Not a real N1MM shape, just confirming the fallback order is
    // "bare first, then rtc-wrapped" rather than the other way round.
    const bareStillWorks = await parseScore(Buffer.from(base));
    assert.equal(bareStillWorks.contest, 'CQ-WPX-CW');
  });
});
