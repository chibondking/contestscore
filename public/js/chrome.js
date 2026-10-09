// Shared header/footer chrome for all three pages (index/charts/admin) --
// the h1+nav and the footer attribution line were byte-for-byte identical
// in three separate HTML files (nav differing only in which link carried
// nav__link--active); this injects them once instead. Not type="module",
// same reason as dashboard.js/charts.js/admin.js: nothing here needs
// module scoping, and this runs as a plain global script anyway.
//
// Load this at the bottom of <body>, same place as the page's own script --
// it needs to run AFTER the header/footer elements are parsed (so it can
// find them) but BEFORE Alpine's deferred script processes the page. Both
// hold here: a non-deferred script executes the instant the parser reaches
// it, which is after everything earlier in the body has been parsed into
// the DOM, and always before any deferred script fires. The injected
// markup carries no x-directives, so Alpine never needs to "see" it as
// anything other than plain static HTML.
//
// Each page marks its <header class="header"> with data-page="dashboard" |
// "charts" | "admin" to pick the active nav link; any page-specific header
// content (status badge, toggles, etc.) stays written directly in that
// page's own HTML -- this only prepends the shared h1+nav ahead of it.
// Dark is the site's default and is NOT remembered by prefers-color-scheme
// -- this is a manual per-viewer choice, opt-in only. The actual
// data-theme="light"/"wt2p" attribute is set as early as possible by a small
// inline script in each page's own <head> (before first paint, so a
// viewer who chose light never sees a dark flash); this constant is only
// used here to persist a *change*.
const THEME_KEY = 'contestpulse_theme';

(function () {
  const NAV_LINKS = [
    { page: 'dashboard', href: '/', label: 'Dashboard' },
    { page: 'charts', href: '/charts.html', label: 'Charts' },
    { page: 'stats', href: '/stats.html', label: 'Stats' },
    { page: 'solar', href: '/solar.html', label: 'Solar' },
    { page: 'analyze', href: '/analyze', label: 'Analyze' },
    { page: 'admin', href: '/admin.html', label: 'Admin' },
  ];

  const header = document.querySelector('.header');
  if (header) {
    // Stats/Charts loaded with ?log=<id> are the analyzer's result views --
    // highlight Analyze, not the page's own nav slot.
    let active = header.dataset.page;
    try {
      if (new URLSearchParams(window.location.search).has('log')) active = 'analyze';
    } catch { /* no URLSearchParams -- keep the page's own dataset.page */ }
    const nav = NAV_LINKS
      .map((l) => `<a href="${l.href}" class="nav__link${l.page === active ? ' nav__link--active' : ''}">${l.label}</a>`)
      .join('');
    header.insertAdjacentHTML('afterbegin', `<h1>ContestPulse</h1><nav class="nav">${nav}</nav>`);

    // Theme picker, always the last (so: rightmost) header control on every
    // page: Dark (default, no attribute), Light, or WT2P (matches wt2p.us).
    // Stored under the same key the pre-paint snippet in each page's <head>
    // reads, so the chosen theme is on <html> before anything renders.
    const THEMES = [['dark', 'Dark'], ['light', 'Light'], ['wt2p', 'WT2P']];
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    header.insertAdjacentHTML('beforeend', `
      <label class="theme-toggle" title="Colour theme">
        <span>Theme</span>
        <select class="theme-select">${THEMES.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </label>`);
    header.querySelector('.theme-select').addEventListener('change', (e) => {
      try { localStorage.setItem(THEME_KEY, e.target.value); } catch { /* ignore */ }
      // Chart.js canvases (charts.js/dashboard.js) pick their tick/grid
      // colors once, at build time, off this same attribute -- a reload is
      // the simplest way to guarantee every chart on the page (not just
      // the plain CSS) comes back correctly themed, rather than each page
      // needing its own "rebuild every chart" listener for a rare action.
      location.reload();
    });
  }

  const footer = document.querySelector('.footer');
  if (footer) {
    footer.insertAdjacentHTML(
      'afterbegin',
      '<span>Created by <a href="https://wt2p.us" target="_blank" rel="noopener">WT2P</a> &middot; ' +
        '<a href="https://github.com/chibondking/contestscore" target="_blank" rel="noopener">GitHub</a></span>',
    );
  }
})();
