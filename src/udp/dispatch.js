const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

// radioListener.js/contactListener.js/scoreListener.js each require this
// module (to route packets on their own socket by content, not just their
// own port), so requiring them back at the top of this file would be
// circular -- at module-load time, whichever one loads first would get
// this module's still-incomplete exports. Requiring them lazily, inside the
// function body, sidesteps that: by the time handleAnyBuffer() actually
// runs, all three have long finished loading (require() just hits the
// module cache on every call after the first, so there's no real cost).

async function getRootElement(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  return Object.keys(result)[0] || '';
}

// Routes a packet to the right parser/handler purely by its own XML root
// element, regardless of which local UDP port or HTTP ingest path it
// arrived on. This exists because "which port" and "what packet type" have
// now failed to line up twice in real installations: a FlexRadio/SmartSDR
// CAT setup exclusively claiming the port N1MM's own docs call the default
// Contact port, and a live capture where a Score broadcast (dynamicresults,
// wrapped in <rtc> -- see parsers/score.js) arrived on whatever port a
// deployment's own config called "radio_port". Both are ultimately the same
// class of problem: trusting a port LABEL to imply content type is fragile
// against real-world N1MM/ContestPulse port configuration, however it came
// to be mismatched. Dispatching by actual root element is robust to it
// either way -- each of the three listeners (and all three HTTP ingest
// routes) can now correctly handle any known packet type arriving on any of
// them, not just the one its own name suggests.
async function handleAnyBuffer(buf, emitter, source) {
  const root = await getRootElement(buf).catch(() => '');

  if (root === 'RadioInfo') {
    return require('./radioListener').handleRadioBuffer(buf, emitter, source);
  }

  if (['contactinfo', 'contactreplace', 'contactdelete', 'lookupinfo', 'spot'].includes(root)) {
    return require('./contactListener').handleContactBuffer(buf, emitter, source);
  }

  if (root === 'dynamicresults' || root === 'rtc') {
    return require('./scoreListener').handleScoreBuffer(buf, emitter, source);
  }

  console.warn(`dispatch: unrecognized root element <${root}> from ${source}`);
}

module.exports = { handleAnyBuffer, getRootElement };
