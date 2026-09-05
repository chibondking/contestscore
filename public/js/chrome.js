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
(function () {
  const NAV_LINKS = [
    { page: 'dashboard', href: '/', label: 'Dashboard' },
    { page: 'charts', href: '/charts.html', label: 'Charts' },
    { page: 'admin', href: '/admin.html', label: 'Admin' },
  ];

  const header = document.querySelector('.header');
  if (header) {
    const active = header.dataset.page;
    const nav = NAV_LINKS
      .map((l) => `<a href="${l.href}" class="nav__link${l.page === active ? ' nav__link--active' : ''}">${l.label}</a>`)
      .join('');
    header.insertAdjacentHTML('afterbegin', `<h1>ContestPulse</h1><nav class="nav">${nav}</nav>`);
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
