/* Shared page chrome for the shop: the header turns solid on scroll and the mobile menu opens, exactly like the home page. */
(() => {
  const d = document;
  const body = d.body;
  const header = d.querySelector('.site-header');
  const burger = d.querySelector('.burger');
  const menu = d.getElementById('menu');

  if (header) {
    let ticking = false;
    const frame = () => { header.classList.toggle('is-scrolled', window.scrollY > 8); ticking = false; };
    addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
    frame();
  }

  if (burger && menu) {
    const setMenu = (open) => {
      menu.classList.toggle('open', open);
      menu.setAttribute('aria-hidden', String(!open));
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      body.classList.toggle('menu-open', open);
      if (open) { const a = menu.querySelector('a'); if (a) a.focus({ preventScroll: true }); }
    };
    burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('open')) { setMenu(false); burger.focus(); } });
    addEventListener('resize', () => { if (innerWidth >= 900 && menu.classList.contains('open')) setMenu(false); });
  }

  const yr = d.getElementById('yr');
  if (yr) yr.textContent = new Date().getFullYear();
})();
