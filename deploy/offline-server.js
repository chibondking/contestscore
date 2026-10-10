#!/usr/bin/env node
// A stand-in for a suspended tenant: answers every request with a styled
// "temporarily offline" page (HTTP 503) on that tenant's own port.
//
// Why this exists: each scoreboard hostname routes straight to
// 127.0.0.1:<tenant port> (Cloudflare Tunnel ingress, or a reverse proxy).
// A suspended tenant leaves nothing listening there, so the visitor gets
// Cloudflare's own "Bad Gateway / host error" page -- which looks like the
// whole box fell over. `contestscore-tenant suspend` starts
// contestscore-offline@<id>.service instead, which binds the same port and
// says what's actually going on, in wt2p.us's colours.
//
// Deliberately dependency-free and self-contained (the page is inlined
// below, not read from public/): it has to start even if the checkout is
// mid-deploy, and it must never be mistaken for part of the app. No DB, no
// sockets, no env but the tenant's own.
//
// 503 + Retry-After is the right status, not 200: a search engine or an
// uptime monitor must not take this page for the real scoreboard. It also
// means ContestPulse's contact relay hold (contestpulse/hold.go) keeps
// retrying rather than dropping QSOs, so a station that was logging through
// a suspend doesn't lose the ones it sent in between.

'use strict';
const http = require('http');

const port = Number(process.env.HTTP_PORT || 3000);
const host = process.env.HTTP_HOST || '127.0.0.1';
const name = (process.env.CONTESTSCORE_TENANT_NAME || process.env.CONTESTSCORE_TENANT || '').trim();

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Colours are wt2p.us's own :root tokens (--bg/--panel/--accent/--text/
// --muted/--border), the same set public/css/dashboard.css's "wt2p" theme
// reads -- change one, consider the other. Fira Code from Google Fonts with
// the usual monospace fallback stack, so a viewer with no internet still
// gets a sane face.
const page = (station) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<!-- Comes back on its own once the tenant is resumed -- nobody has to
     remember to reload the wall display. -->
<meta http-equiv="refresh" content="60">
<title>Temporarily offline &middot; ContestPulse</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;700&display=swap');
  :root {
    --bg: #0d0d0d;
    --panel: #121212;
    --accent: #ff9400;
    --text: #ffaa00;
    --muted: #cc7a00;
    --border: #261a00;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Fira Code', ui-monospace, 'Cascadia Mono', Consolas, 'Roboto Mono', 'DejaVu Sans Mono', monospace;
    display: flex; align-items: center; justify-content: center;
    padding: 1.5rem; line-height: 1.6;
  }
  main { width: 100%; max-width: 34rem; }
  h1 {
    margin: 0 0 .25rem;
    font-size: clamp(1.75rem, 7vw, 2.75rem);
    color: var(--accent);
    text-shadow: 0 0 12px rgba(255, 148, 0, .35);
    letter-spacing: .04em;
  }
  .cursor {
    display: inline-block; width: .6em; height: 1.05em; margin-left: .15em;
    background: var(--accent); vertical-align: text-bottom;
    animation: blink 1.1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .lede { margin: 0 0 1.5rem; font-size: 1.15rem; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 6px; padding: 1rem 1.1rem; margin: 0 0 1.25rem;
  }
  .card p { margin: 0; color: var(--muted); font-size: .95rem; }
  .card p + p { margin-top: .6rem; }
  .station { color: var(--accent); }
  footer { color: var(--muted); font-size: .8rem; }
  footer a { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
</style>
</head>
<body>
<main>
  <h1>Off the air<span class="cursor"></span></h1>
  <p class="lede">${station ? `<span class="station">${station}</span>'s scoreboard is` : 'This scoreboard is'} temporarily offline.</p>
  <div class="card">
    <p>The server is up &mdash; this scoreboard is just paused. It will be
       back when the operators bring it back; nothing has been lost.</p>
    <p>This page reloads itself every minute, so a wall display will pick the
       scoreboard back up on its own.</p>
  </div>
  <footer>ContestPulse &middot; <a href="https://wt2p.us">wt2p.us</a></footer>
</main>
</body>
</html>
`;

const body = Buffer.from(page(esc(name)));

const server = http.createServer((req, res) => {
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Retry-After': '300',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(port, host, () => {
  console.log(`offline page for ${name || 'tenant'} on http://${host}:${port}`);
});
