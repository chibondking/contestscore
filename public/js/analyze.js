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
    // Saved-analyses list (upload view, when a token is present)
    savedLogs: [],
    savedRetention: null,
    savedError: '',
    savedLoading: false,
    // Entry source: an uploaded file, typed-in QSOs, or a snapshot of the
    // realtime `qsos` table.
    entryMode: 'file',   // 'file' | 'manual' | 'live'
    liveCount: null,     // QSOs currently in the live contest DB
    man: {
      contest: '', mycall: '', myexch: '',
      band: '20m', mode: 'CW',
      date: new Date().toISOString().slice(0, 10),
      qsos: '',
    },

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
      if (this.token) this.loadSaved();
      // /api/qsos is public -- get the live contest QSO count for the
      // "snapshot the live contest" panel.
      fetch('/api/qsos')
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => { this.liveCount = Array.isArray(rows) ? rows.length : 0; })
        .catch(() => { this.liveCount = 0; });
    },

    saveToken() {
      try { localStorage.setItem('contestpulse_admin_token', this.token); } catch { /* storage off */ }
    },

    async loadSaved() {
      if (!this.token) { this.savedLogs = []; return; }
      this.savedLoading = true;
      this.savedError = '';
      try {
        const r = await fetch('/api/analyze', { headers: { Authorization: `Bearer ${this.token}` } });
        if (r.status === 401 || r.status === 503) {
          this.savedError = 'Token not accepted';
          this.savedLogs = [];
        } else if (!r.ok) {
          this.savedError = `List failed (${r.status})`;
        } else {
          const body = await r.json();
          this.savedLogs = body.items || [];
          this.savedRetention = body.retention || null;
        }
      } catch (err) {
        this.savedError = `List failed: ${err}`;
      }
      this.savedLoading = false;
    },

    async deleteSaved(id) {
      if (!window.confirm('Delete this saved analysis? The share link will stop working.')) return;
      try {
        const r = await fetch(`/api/analyze/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (r.ok) this.savedLogs = this.savedLogs.filter((x) => x.id !== id);
        else this.savedError = `Delete failed (${r.status})`;
      } catch (err) {
        this.savedError = `Delete failed: ${err}`;
      }
    },

    ageOut(createdAt) {
      if (!this.savedRetention || !this.savedRetention.ttl_days || !createdAt) return '';
      const born = new Date(createdAt.replace(' ', 'T') + 'Z').getTime();
      const days = Math.ceil((born + this.savedRetention.ttl_days * 86400000 - Date.now()) / 86400000);
      return days > 0 ? `${days}d left` : 'expiring';
    },

    async downloadReport() {
      try {
        const body = await fetch(`/api/analyze/${encodeURIComponent(this.logId)}`).then((r) => r.json());
        const html = renderReport({ meta: body.meta, qsos: body.qsos });
        const blob = new Blob([html], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const base = `${body.meta.station_call || 'log'}-${body.meta.contest_key || body.meta.contest || 'report'}`;
        a.download = `${base.replace(/[^A-Za-z0-9._-]+/g, '_')}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (err) {
        this.error = `Report failed: ${err}`;
      }
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
      await this.uploadText(await this.file.text(), this.fileName);
    },

    // Shared by the file path and the manual-entry path -- POST raw text to
    // /api/analyze and hand off to the result page.
    async uploadText(text, filename) {
      if (!this.token || this.busy) return;
      this.busy = true;
      this.error = '';
      try {
        const r = await fetch(`/api/analyze?filename=${encodeURIComponent(filename)}`, {
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

    // Manual entry: how many QSO lines currently parse (live counter).
    get manCount() {
      return parseManualLines(this.man.qsos).length;
    },

    analyzeManual() {
      if (!this.man.mycall || !this.manCount || !this.token || this.busy) return;
      const text = buildManualCabrillo(this.man);
      const name = `manual-${(this.man.contest || 'log').replace(/[^A-Za-z0-9]+/g, '-')}.cbr`;
      this.uploadText(text, name);
    },

    // Snapshot the realtime qsos table into a saved analysis -- full N1MM
    // fidelity (points / mults / operator / run), no export needed.
    async analyzeLive() {
      if (!this.token || this.busy || !this.liveCount) return;
      this.busy = true;
      this.error = '';
      try {
        const r = await fetch('/api/analyze/from-live', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          this.error = body.error || `Snapshot failed (${r.status})`;
          this.busy = false;
          return;
        }
        window.location.href = `/analyze/${body.id}`;
      } catch (err) {
        this.error = `Snapshot failed: ${err}`;
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
