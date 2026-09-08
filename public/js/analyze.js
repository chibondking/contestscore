// Not type="module" -- same reason as the other page scripts: Alpine's
// x-data="analyze()" is evaluated in global scope.
//
// One page, two modes picked from the URL:
//   /analyze          -> upload form (POST /api/analyze, token-gated)
//   /analyze/<id>      -> result landing: metadata + links into
//                         stats.html?log=<id> / charts.html?log=<id>
// The heavy rendering is the existing Stats/Charts pages, which know how to
// load a saved log via ?log=. This page is just upload + hand-off.
function analyze() {
  return {
    mode: 'upload',      // 'upload' | 'result' | 'notfound'
    logId: null,
    meta: null,
    excluded: [],
    showExcluded: false,
    compareId: '',
    cmpA: '',
    cmpB: '',
    token: '',
    file: null,
    fileName: '',
    busy: false,
    error: '',
    copied: false,

    init() {
      const m = location.pathname.match(/^\/analyze\/([A-Za-z0-9_-]{4,40})$/);
      if (m) {
        this.logId = m[1];
        this.mode = 'result';
        this.loadResult();
        return;
      }
      // Reuse the admin page's remembered token -- same secret.
      try { this.token = localStorage.getItem('contestpulse_admin_token') || ''; } catch { /* storage off */ }
    },

    saveToken() {
      try { localStorage.setItem('contestpulse_admin_token', this.token); } catch { /* storage off */ }
    },

    async loadResult() {
      try {
        const r = await fetch(`/api/analyze/${encodeURIComponent(this.logId)}`);
        if (r.status === 404) { this.mode = 'notfound'; return; }
        if (!r.ok) { this.error = `Failed to load analysis (${r.status})`; return; }
        const body = await r.json();
        this.meta = body.meta;
        this.excluded = body.excluded || [];
      } catch (err) {
        this.error = `Failed to load analysis: ${err}`;
      }
    },

    // Accept a bare id or a pasted /analyze/<id> URL.
    idFrom(s) {
      const m = String(s || '').trim().match(/([A-Za-z0-9_-]{4,40})\/?$/);
      return m ? m[1] : '';
    },

    goCompare() {
      const b = this.idFrom(this.compareId);
      if (b && b !== this.logId) window.location.href = `/compare?a=${this.logId}&b=${b}`;
    },

    goCompare2() {
      const a = this.idFrom(this.cmpA);
      const b = this.idFrom(this.cmpB);
      if (a && b) window.location.href = `/compare?a=${a}&b=${b}`;
    },

    pickFile(ev) {
      const list = ev.target.files || (ev.dataTransfer && ev.dataTransfer.files) || [];
      const f = list[0];
      if (f) { this.file = f; this.fileName = f.name; this.error = ''; }
    },

    onDrop(ev) {
      ev.preventDefault();
      this.pickFile(ev);
    },

    async upload() {
      if (!this.file || !this.token || this.busy) return;
      this.busy = true;
      this.error = '';
      try {
        const text = await this.file.text();
        const r = await fetch(`/api/analyze?filename=${encodeURIComponent(this.fileName)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
          body: text,
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          this.error = body.error || `Upload failed (${r.status})`;
          this.busy = false;
          return;
        }
        window.location.href = `/analyze/${body.id}`;
      } catch (err) {
        this.error = `Upload failed: ${err}`;
        this.busy = false;
      }
    },

    get shareUrl() {
      return `${window.location.origin}/analyze/${this.logId}`;
    },

    copyShare() {
      const done = () => { this.copied = true; setTimeout(() => { this.copied = false; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.shareUrl).then(done, done);
      } else {
        done();
      }
    },
  };
}
