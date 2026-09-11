// Server-backed portfolio state (single-user JSON file behind /api/portfolio).
// Replaces the old per-browser localStorage; migrates it once if the server is empty.
(function () {
  const LEGACY = {
    'portfolio-symbols': ['symbols', true], 'portfolio-weights': ['weights', true], 'portfolio-combos': ['combos', true],
    'portfolio-hidden': ['hidden', true], 'portfolio-rolling-window': ['rollingWindow', false], 'portfolio-rolling-scope': ['rollingScope', false],
  };
  let state = {};
  let pending = {};
  let timer = null;

  async function flush() {
    const body = pending; pending = {}; timer = null;
    if (!Object.keys(body).length) return;
    try {
      const res = await fetch('/api/portfolio', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (e) {
      console.warn('portfolio save failed', e);
      pending = { ...body, ...pending };
      timer = setTimeout(flush, 3000);
    }
  }

  const store = {
    get(key, def) { return state[key] === undefined ? def : state[key]; },
    set(key, val) {
      state[key] = val; pending[key] = val;
      clearTimeout(timer); timer = setTimeout(flush, 300);
    },
    flush,
    all() { return state; },
  };

  store.ready = (async () => {
    try {
      const res = await fetch('/api/portfolio');
      state = res.ok ? await res.json() : {};
    } catch { state = {}; }
    // Migrate only when none of the browser-era keys exist on the server yet.
    const empty = !['symbols', 'weights', 'combos', 'hidden'].some((k) => state[k] !== undefined);
    if (empty) {
      let migrated = false;
      Object.entries(LEGACY).forEach(([lk, [key, isJson]]) => {
        try {
          const raw = localStorage.getItem(lk);
          if (raw == null) return;
          store.set(key, isJson ? JSON.parse(raw) : raw);
          migrated = true;
        } catch {}
      });
      if (migrated) await new Promise((r) => setTimeout(r, 350));
    }
    return store;
  })();

  window.pfStore = store;

  // Rebalance badge on the 포트폴리오 tab (uses the server's last daily check).
  store.ready.then(async () => {
    try {
      const res = await fetch('/api/rebalance-check');
      const data = await res.json();
      window.setRebalanceBadge && window.setRebalanceBadge(data);
    } catch {}
  });
  window.setRebalanceBadge = function (data) {
    const tab = document.querySelector('.tab-btn[data-tab="portfolio"]');
    const sub = document.querySelector('#pf-view [data-view="holdings"]');
    [tab, sub].forEach((el) => {
      if (!el) return;
      let b = el.querySelector('.badge-dot');
      if (data && data.triggered) {
        if (!b) { b = document.createElement('span'); b.className = 'badge-dot'; b.title = '리밸런싱 점검 필요'; el.appendChild(b); }
      } else if (b) b.remove();
    });
  };
})();
