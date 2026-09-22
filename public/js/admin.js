// Not type="module" -- same reason as dashboard.js: Alpine's
// x-data="admin()" is evaluated in global scope, and a module's top-level
// declarations don't land there.
function admin() {
  return {
    token: '',
    confirmed: false,
    resetting: false,
    message: '',
    messageIsError: false,
    counts: {},

    lookupStatus: { provider: 'none', enabled: false, paused: false },
    lookupBusy: false,
    lookupMessage: '',
    lookupMessageIsError: false,

    init() {
      try {
        this.token = localStorage.getItem('contestpulse_admin_token') || '';
      } catch {
        // private browsing / storage disabled -- just start with an empty field
      }
      this.fetchCounts();
      this.fetchLookupStatus();
    },

    saveToken() {
      try {
        localStorage.setItem('contestpulse_admin_token', this.token);
      } catch {
        // ignore -- not worth surfacing an error just for a remembered token
      }
    },

    async fetchCounts() {
      try {
        const [qsos, score] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
        ]);
        this.counts = { qsos: qsos.length, score: score.total ?? 0 };
      } catch (err) {
        console.error('Failed to load current counts:', err);
      }
    },

    async reset() {
      if (!this.token || !this.confirmed || this.resetting) return;
      this.resetting = true;
      this.message = '';
      try {
        const res = await fetch('/api/db', {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'X-Confirm': 'yes',
          },
        });
        if (res.ok) {
          this.message = 'Database reset -- all QSOs and score history cleared.';
          this.messageIsError = false;
          this.confirmed = false;
          await this.fetchCounts();
        } else {
          const body = await res.json().catch(() => ({}));
          this.message = `Reset failed: ${body.error || res.status}`;
          this.messageIsError = true;
        }
      } catch (err) {
        this.message = `Reset failed: ${err.message}`;
        this.messageIsError = true;
      } finally {
        this.resetting = false;
      }
    },

    async fetchLookupStatus() {
      try {
        this.lookupStatus = await fetch('/api/lookup/status').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load lookup status:', err);
      }
    },

    async setLookupPaused(paused) {
      if (!this.token || this.lookupBusy) return;
      this.lookupBusy = true;
      this.lookupMessage = '';
      try {
        const res = await fetch(`/api/lookup/${paused ? 'pause' : 'resume'}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          this.lookupStatus = body;
          this.lookupMessage = paused ? 'Lookups paused.' : 'Lookups resumed.';
          this.lookupMessageIsError = false;
        } else {
          this.lookupMessage = `${paused ? 'Pause' : 'Resume'} failed: ${body.error || res.status}`;
          this.lookupMessageIsError = true;
        }
      } catch (err) {
        this.lookupMessage = `${paused ? 'Pause' : 'Resume'} failed: ${err.message}`;
        this.lookupMessageIsError = true;
      } finally {
        this.lookupBusy = false;
      }
    },

    pauseLookup()  { this.setLookupPaused(true); },
    resumeLookup() { this.setLookupPaused(false); },
  };
}
