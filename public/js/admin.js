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

    init() {
      try {
        this.token = localStorage.getItem('contestpulse_admin_token') || '';
      } catch {
        // private browsing / storage disabled -- just start with an empty field
      }
      this.fetchCounts();
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
  };
}
