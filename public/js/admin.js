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

    // GET /api/cty: the country file this server resolves continents with.
    cty: {},

    // Possible Busts switch (GET /api/busts `hidden`). null until loaded.
    bustsHidden: null,
    bustsBusy: false,
    bustsMessage: '',
    bustsMessageIsError: false,

    // COSB standings card switch (GET /api/cosb `standings_switch`).
    cosbStandings: null,
    cosbStandingsBusy: false,
    cosbStandingsMessage: '',
    cosbStandingsMessageIsError: false,

    // COSB publishing (GET /api/cosb `publish`). null until loaded.
    cosbPublish: null,
    cosbUser: '',
    cosbPassword: '',
    cosbBusy: false,
    cosbMessage: '',
    cosbMessageIsError: false,

    cacheBusy: false,
    cacheMessage: '',
    cacheMessageIsError: false,

    init() {
      try {
        this.token = localStorage.getItem('contestpulse_admin_token') || '';
      } catch {
        // private browsing / storage disabled -- just start with an empty field
      }
      this.fetchCounts();
      this.fetchLookupStatus();
      this.fetchCty();
      this.fetchBustsHidden();
      this.fetchCosb();
    },

    async fetchCosb() {
      try {
        const body = await fetch('/api/cosb').then((r) => r.json());
        this.cosbPublish = body.publish;
        this.cosbStandings = body.standings_switch;
        if (body.publish && !this.cosbUser) this.cosbUser = body.publish.user || '';
      } catch (err) {
        console.error('Failed to load COSB settings:', err);
      }
    },

    async setCosbStandings(enabled) {
      if (!this.token || this.cosbStandingsBusy) return;
      this.cosbStandingsBusy = true;
      this.cosbStandingsMessage = '';
      try {
        const res = await fetch('/api/cosb/standings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          this.cosbStandings = { available: body.available, enabled: body.enabled };
          this.cosbStandingsMessage = body.enabled ? 'Standings card on.' : 'Standings card off.';
          this.cosbStandingsMessageIsError = false;
        } else {
          this.cosbStandingsMessage = `Save failed: ${body.error || res.status}`;
          this.cosbStandingsMessageIsError = true;
        }
      } catch (err) {
        this.cosbStandingsMessage = `Save failed: ${err.message}`;
        this.cosbStandingsMessageIsError = true;
      } finally {
        this.cosbStandingsBusy = false;
      }
    },

    cosbLastLabel() {
      const l = this.cosbPublish && this.cosbPublish.last;
      if (!l) return '—';
      const t = (l.at || '').slice(11, 16) + 'z';
      return l.ok ? `OK ${t}` : `${l.message || 'failed'} ${t}`;
    },

    async saveCosb(enabled) {
      if (!this.token || this.cosbBusy) return;
      this.cosbBusy = true;
      this.cosbMessage = '';
      try {
        const res = await fetch('/api/cosb/publish', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, user: this.cosbUser.trim().toUpperCase(), password: this.cosbPassword }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          this.cosbPublish = body;
          this.cosbPassword = '';
          this.cosbMessage = body.enabled ? 'Publishing to COSB.' : 'COSB publishing off.';
          this.cosbMessageIsError = false;
        } else {
          this.cosbMessage = `Save failed: ${body.error || res.status}`;
          this.cosbMessageIsError = true;
        }
      } catch (err) {
        this.cosbMessage = `Save failed: ${err.message}`;
        this.cosbMessageIsError = true;
      } finally {
        this.cosbBusy = false;
      }
    },

    async fetchBustsHidden() {
      try {
        const body = await fetch('/api/busts').then((r) => r.json());
        this.bustsHidden = Boolean(body.hidden);
      } catch (err) {
        console.error('Failed to load Possible Busts setting:', err);
      }
    },

    async setBustsHidden(hidden) {
      if (!this.token || this.bustsBusy) return;
      this.bustsBusy = true;
      this.bustsMessage = '';
      try {
        const res = await fetch(`/api/busts/${hidden ? 'hide' : 'show'}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          this.bustsHidden = Boolean(body.hidden);
          this.bustsMessage = hidden ? 'Possible Busts hidden.' : 'Possible Busts shown.';
          this.bustsMessageIsError = false;
        } else {
          this.bustsMessage = `Save failed: ${body.error || res.status}`;
          this.bustsMessageIsError = true;
        }
      } catch (err) {
        this.bustsMessage = `Save failed: ${err.message}`;
        this.bustsMessageIsError = true;
      } finally {
        this.bustsBusy = false;
      }
    },

    async fetchCty() {
      try {
        this.cty = await fetch('/api/cty').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load country file info:', err);
      }
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
          this.message = 'Database reset -- all QSOs and score history cleared (callsign cache and solar history kept).';
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

    async clearCache() {
      if (!this.token || this.cacheBusy) return;
      if (!window.confirm('Forget every cached callsign lookup (including the Possible Busts list)?')) return;
      this.cacheBusy = true;
      this.cacheMessage = '';
      try {
        const res = await fetch('/api/lookup/cache', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.token}`, 'X-Confirm': 'yes' },
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          this.cacheMessage = `Cache cleared -- ${body.cleared ?? 0} callsign(s) forgotten.`;
          this.cacheMessageIsError = false;
          this.fetchLookupStatus(); // the count should drop to 0 now
        } else {
          this.cacheMessage = `Clear failed: ${body.error || res.status}`;
          this.cacheMessageIsError = true;
        }
      } catch (err) {
        this.cacheMessage = `Clear failed: ${err.message}`;
        this.cacheMessageIsError = true;
      } finally {
        this.cacheBusy = false;
      }
    },

    pauseLookup()  { this.setLookupPaused(true); },
    resumeLookup() { this.setLookupPaused(false); },
  };
}
