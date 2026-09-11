// 포트폴리오 탭: server-backed watchlist (window.pfStore) rendered with the same
// card/chart/range machinery as the 시장 tab (globals from app.js).
(async function () {
  const store = await window.pfStore.ready;
  const input = document.getElementById('pf-input');
  const results = document.getElementById('pf-results');
  const addBtn = document.getElementById('pf-add-btn');
  const grid = document.getElementById('pf-grid');
  const empty = document.getElementById('pf-empty');
  const status = document.getElementById('pf-status');
  const rangeBox = document.getElementById('pf-range');

  let items = load();
  let range = RANGE_OPTIONS.find((r) => r.key === DEFAULT_RANGE);
  let loadedOnce = false;

  function load() { return Array.isArray(store.get('symbols')) ? store.get('symbols') : []; }
  function save() { store.set('symbols', items); }

  RANGE_OPTIONS.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'range-btn' + (opt.key === range.key ? ' active' : '');
    b.textContent = opt.label;
    b.addEventListener('click', () => {
      if (opt.key === range.key) return;
      range = opt;
      rangeBox.querySelectorAll('.range-btn').forEach((x) => x.classList.toggle('active', x === b));
      renderAll();
    });
    rangeBox.appendChild(b);
  });

  const combined = document.getElementById('pf-combined');
  const viewBtns = document.querySelectorAll('#pf-view .subtab-btn');
  let view = 'cards';
  const seriesCache = new Map(); // `${symbol}|${range.key}` -> points | Error

  viewBtns.forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view === view) return;
    view = b.dataset.view;
    viewBtns.forEach((x) => x.classList.toggle('active', x === b));
    renderAll();
  }));

  function removeItem(symbol) {
    items = items.filter((x) => x.symbol !== symbol);
    save();
    renderAll();
  }

  async function getSeries(item) {
    const k = `${item.symbol}|${range.key}`;
    if (!seriesCache.has(k)) {
      try { seriesCache.set(k, await fetchStockData(item.symbol, range)); }
      catch (e) { seriesCache.set(k, e); }
    }
    return seriesCache.get(k);
  }

  function renderCard(item, data) {
    const card = buildCard(item.label, item.symbol);
    if (data instanceof Error) card.innerHTML = `<div class="label">${item.label}</div><div class="sub">${item.symbol}</div><div class="error">${data.message}</div>`;
    else renderCardContent(card, item.label, data, item.symbol, item.symbol, range.label);
    const rm = document.createElement('button');
    rm.className = 'pf-remove'; rm.title = '삭제'; rm.textContent = '×';
    rm.addEventListener('click', () => removeItem(item.symbol));
    card.appendChild(rm);
    grid.appendChild(card);
  }

  // Combined view: every series indexed to 0% at the start of the range so
  // different price scales share one axis (never a dual-axis chart).
  const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  let hidden = new Set(Array.isArray(store.get('hidden')) ? store.get('hidden') : []);
  // opts.normalize (default true): plot % change from each series' first point.
  // normalize:false plots the raw values (already in %), used by the rolling charts.
  function renderCombined(rows, container = combined, opts = {}) {
    const normalize = opts.normalize !== false;
    const valid = rows.filter((r) => !(r.data instanceof Error) && r.data.length > 1);
    if (!valid.length) { container.innerHTML = '<div class="tg-empty">표시할 데이터가 없어요</div>'; return; }
    const all = valid.map((r, i) => ({
      item: r.item, color: PALETTE[i % PALETTE.length], hidden: hidden.has(r.item.symbol),
      pts: r.data.map((p) => ({ t: new Date(p.date).getTime(), date: p.date, price: p.value, pct: normalize ? (p.value / r.data[0].value - 1) * 100 : p.value })),
    }));
    const isSynthetic = (sym) => sym === 'PORTFOLIO' || sym.startsWith('COMBO:') || sym.startsWith('ROLL:') || sym.startsWith('SYM:');
    const legend = `<div class="pf-legend">${all.map((s) => `<button type="button" class="pf-chip${s.hidden ? ' off' : ''}" data-symbol="${s.item.symbol}" title="클릭: 숨기기/보이기"><i style="background:${s.color}"></i>${s.item.label}${isSynthetic(s.item.symbol) ? '' : ` <span class="meta">${s.item.symbol}</span>`}</button>`).join('')}<span class="meta pf-legend-hint">종목을 클릭하면 숨기기/보이기</span></div>`;
    const series = all.filter((s) => !s.hidden);
    if (!series.length) {
      container.innerHTML = legend + '<div class="tg-empty">모든 종목을 숨겼어요. 범례를 눌러 다시 표시해 주세요.</div>';
      bindLegend(container);
      return;
    }
    const W = 800, H = 320, L = 52, R = 16, T = 16, B = 34;
    const tMin = Math.min(...series.map((s) => s.pts[0].t)), tMax = Math.max(...series.map((s) => s.pts[s.pts.length - 1].t));
    let yMin = Math.min(...series.flatMap((s) => s.pts.map((p) => p.pct))), yMax = Math.max(...series.flatMap((s) => s.pts.map((p) => p.pct)));
    yMin = Math.min(yMin, 0); yMax = Math.max(yMax, 0);
    const pad = (yMax - yMin) * 0.06 || 1; yMin -= pad; yMax += pad;
    const x = (t) => L + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - L - R);
    const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);

    const step = niceStep((yMax - yMin) / 5);
    let gridHtml = '';
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      const yy = y(v);
      gridHtml += `<line class="${Math.abs(v) < 1e-9 ? 'zero' : 'grid-line'}" x1="${L}" x2="${W - R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${v.toFixed(0)}%</text>`;
    }
    let xTicks = '';
    for (let i = 0; i <= 4; i++) {
      const t = tMin + ((tMax - tMin) * i) / 4;
      xTicks += `<text class="tick" x="${x(t).toFixed(1)}" y="${H - 12}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${new Date(t).toISOString().slice(0, 10)}</text>`;
    }
    const paths = series.map((s) => `<path class="cline" stroke="${s.color}" d="${s.pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ',' + y(p.pct).toFixed(1)).join(' ')}"/>`).join('');
    const endLabels = series.map((s) => { const p = s.pts[s.pts.length - 1]; return `<text class="endlab" x="${(x(p.t) + 4).toFixed(1)}" y="${(y(p.pct) + 4).toFixed(1)}" fill="${s.color}">${p.pct > 0 ? '+' : ''}${p.pct.toFixed(1)}%</text>`; }).join('');

    container.innerHTML = legend + `
      <div class="pf-combined-box">
        <svg class="cchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${gridHtml}${xTicks}${paths}${endLabels}
          <line class="hover-line" y1="${T}" y2="${H - B}" x1="0" x2="0" style="opacity:0"/>
          <rect class="overlay" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
        </svg>
        <div class="tooltip pf-tip"></div>
      </div>
      <div class="tg-hint" style="margin:8px 0 0">${opts.hint ?? '기간 시작일 종가를 0%로 놓고 각 종목의 등락률을 같은 축에 겹쳐 그려요. 거래일이 다른 시장(한국·미국)은 각자의 날짜에 맞춰 그려요.'}</div>`;

    const svg = container.querySelector('svg'), overlay = svg.querySelector('.overlay');
    const hover = svg.querySelector('.hover-line'), tip = container.querySelector('.pf-tip');
    const nearest = (pts, t) => { let lo = 0, hi = pts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m + 1; else hi = m; } return lo > 0 && Math.abs(pts[lo - 1].t - t) < Math.abs(pts[lo].t - t) ? pts[lo - 1] : pts[lo]; };
    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const t = tMin + ((e.clientX - rect.left) / rect.width * W - L) / (W - L - R) * (tMax - tMin);
      const tc = Math.min(tMax, Math.max(tMin, t));
      hover.setAttribute('x1', x(tc)); hover.setAttribute('x2', x(tc)); hover.style.opacity = '1';
      tip.innerHTML = `<div>${new Date(tc).toISOString().slice(0, 10)}</div>` + series.map((s) => { const p = nearest(s.pts, tc); return `<div><i style="background:${s.color}"></i>${s.item.label} ${p.pct > 0 ? '+' : ''}${p.pct.toFixed(1)}%${normalize ? ` <span class="meta">(${numberFmt(p.price, s.item.symbol)})</span>` : ''}</div>`; }).join('');
      tip.style.opacity = '1';
      const px = (x(tc) / W) * 100;
      tip.style.left = `${px}%`; tip.style.top = '8px';
      tip.style.transform = px > 65 ? 'translate(-100%, 0)' : 'translate(0, 0)';
    });
    overlay.addEventListener('mouseleave', () => { hover.style.opacity = '0'; tip.style.opacity = '0'; });
    bindLegend(container);
  }
  function bindLegend(container) {
    container.querySelectorAll('.pf-chip[data-symbol]').forEach((chip) => chip.addEventListener('click', () => {
      const s = chip.dataset.symbol;
      if (hidden.has(s)) hidden.delete(s); else hidden.add(s);
      store.set('hidden', [...hidden]);
      renderAll();
    }));
  }
  // ---- weighted portfolio view: constant initial weights (buy & hold from the
  // range start), each series forward-filled onto the union of trading dates.
  const weighted = document.getElementById('pf-weighted');
  let weights = store.get('weights') && typeof store.get('weights') === 'object' ? store.get('weights') : {};
  function saveWeights() { store.set('weights', weights); }
  function currentWeights(valid) {
    const w = {};
    valid.forEach((r) => { const v = parseFloat(weights[r.item.symbol]); w[r.item.symbol] = Number.isFinite(v) && v >= 0 ? v : 100 / valid.length; });
    return w;
  }
  function buildPortfolioSeries(valid, w) {
    const total = valid.reduce((a, r) => a + w[r.item.symbol], 0);
    if (!total) return null;
    const dates = [...new Set(valid.flatMap((r) => r.data.map((p) => p.date)))].sort();
    const ptr = valid.map(() => 0), lastRel = valid.map(() => 1);
    const out = [];
    for (const d of dates) {
      let sum = 0;
      valid.forEach((r, i) => {
        while (ptr[i] < r.data.length && r.data[ptr[i]].date <= d) { lastRel[i] = r.data[ptr[i]].value / r.data[0].value; ptr[i]++; }
        sum += (w[r.item.symbol] / total) * lastRel[i];
      });
      out.push({ date: d, value: 100 * sum });
    }
    return out;
  }
  function portfolioStats(pts) {
    const ret = pts[pts.length - 1].value / pts[0].value - 1;
    let peak = -Infinity, mdd = 0;
    pts.forEach((p) => { peak = Math.max(peak, p.value); mdd = Math.min(mdd, p.value / peak - 1); });
    const lr = pts.slice(1).map((p, i) => Math.log(p.value / pts[i].value));
    const m = lr.reduce((a, b) => a + b, 0) / (lr.length || 1);
    const vol = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, lr.length - 1) * 252);
    return { ret: ret * 100, mdd: mdd * 100, vol: vol * 100 };
  }
  function renderWeighted(rows) {
    const valid = rows.filter((r) => !(r.data instanceof Error) && r.data.length > 1);
    if (!valid.length) { weighted.innerHTML = '<div class="tg-empty">표시할 데이터가 없어요</div>'; return; }
    const w = currentWeights(valid);
    const editor = `<div class="pf-weights">${valid.map((r) => {
      const v = +w[r.item.symbol].toFixed(1);
      return `<div class="pf-wrow" data-symbol="${r.item.symbol}"><span class="sym">${r.item.label}</span><input type="range" min="0" max="100" step="1" value="${Math.min(100, v)}" aria-label="${r.item.label} 비중"><input type="number" min="0" step="1" value="${v}">%<span class="meta norm"></span></div>`;
    }).join('')}<div class="pf-wfoot"><button type="button" class="range-btn" id="pf-equal">동일 비중</button><span class="meta">합계 <b id="pf-wsum"></b>% → 자동 정규화 · 기간 시작일 비중으로 매수 후 보유 가정</span></div></div>`;
    weighted.innerHTML = editor + '<div id="pf-weighted-out"></div>';
    updateWeightLabels(valid);
    renderWeightedOut(valid);
    bindWeights(valid);
  }
  function updateWeightLabels(valid) {
    const w = currentWeights(valid);
    const total = valid.reduce((a, r) => a + w[r.item.symbol], 0);
    weighted.querySelectorAll('.pf-wrow').forEach((row) => {
      const s = row.dataset.symbol;
      row.querySelector('.norm').textContent = `(${total ? ((w[s] / total) * 100).toFixed(1) : '0.0'}%)`;
    });
    const sum = document.getElementById('pf-wsum');
    if (sum) sum.textContent = total.toFixed(1);
  }
  function renderWeightedOut(valid) {
    const out = document.getElementById('pf-weighted-out');
    const w = currentWeights(valid);
    const pf = buildPortfolioSeries(valid, w);
    if (!pf) { out.innerHTML = '<div class="tg-empty">비중이 모두 0이에요</div>'; return; }
    const st = portfolioStats(pf);
    const stats = `<div class="pf-stats"><div><span class="k">기간 수익률</span><b class="${st.ret >= 0 ? 'up' : 'down'}">${st.ret >= 0 ? '+' : ''}${st.ret.toFixed(2)}%</b></div><div><span class="k">최대 낙폭(MDD)</span><b class="down">${st.mdd.toFixed(2)}%</b></div><div><span class="k">연환산 변동성</span><b>${st.vol.toFixed(1)}%</b></div></div>`;
    out.innerHTML = stats + '<div id="pf-weighted-chart"></div>' + renderCombosSection(valid, w) + '<div id="pf-rolling"></div>';
    renderCombined([{ item: { label: '내 포트폴리오', symbol: 'PORTFOLIO' }, data: pf }, ...valid], document.getElementById('pf-weighted-chart'));
    renderCombosChart(valid, w);
    bindCombos(valid, w);
    renderRolling(valid, w);
  }

  // ---- rolling (sliding-window) metrics: return / max drawdown / volatility
  // recomputed at every point over the trailing window, for the current input
  // and every saved combo.
  const ROLL_WINDOWS = [{ days: 30, label: '1개월' }, { days: 90, label: '3개월' }, { days: 180, label: '6개월' }, { days: 365, label: '1년' }];
  let rollDays = (() => { const v = parseInt(store.get('rollingWindow'), 10); return ROLL_WINDOWS.some((x) => x.days === v) ? v : 90; })();
  function rollingMetrics(pts, windowDays) {
    const ms = windowDays * 86400000;
    const ts = pts.map((p) => new Date(p.date).getTime());
    const spacing = (ts[ts.length - 1] - ts[0]) / Math.max(1, ts.length - 1) / 86400000;
    const perYear = 365 / Math.max(1, spacing);
    const ret = [], mdd = [], vol = [];
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      while (ts[i] - ts[j] > ms) j++;
      if (ts[i] - ts[j] < ms * 0.7 || i - j < 3) continue;
      const slice = pts.slice(j, i + 1);
      ret.push({ date: pts[i].date, value: (pts[i].value / pts[j].value - 1) * 100 });
      let peak = -Infinity, dd = 0;
      slice.forEach((p) => { peak = Math.max(peak, p.value); dd = Math.min(dd, p.value / peak - 1); });
      mdd.push({ date: pts[i].date, value: dd * 100 });
      const lr = slice.slice(1).map((p, k) => Math.log(p.value / slice[k].value));
      const m = lr.reduce((a, b) => a + b, 0) / lr.length;
      vol.push({ date: pts[i].date, value: Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, lr.length - 1) * perYear) * 100 });
    }
    return { ret, mdd, vol };
  }
  let rollScope = (() => { const v = store.get('rollingScope'); return ['all', 'combos', 'symbols'].includes(v) ? v : 'all'; })();
  function renderRolling(valid, cur) {
    const box = document.getElementById('pf-rolling');
    const comboRows = comboList(valid, cur).filter((c) => c.series).map((c) => ({ name: c.name, id: c.id, series: c.series }));
    const symbolRows = valid.map((r) => ({ name: r.item.label, id: `SYM:${r.item.symbol}`, series: r.data }));
    const list = rollScope === 'combos' ? comboRows : rollScope === 'symbols' ? symbolRows : comboRows.concat(symbolRows);
    const spanDays = valid.length ? (new Date(valid[0].data[valid[0].data.length - 1].date) - new Date(valid[0].data[0].date)) / 86400000 : 0;
    const pills = ROLL_WINDOWS.map((x) => `<button type="button" class="range-btn${x.days === rollDays ? ' active' : ''}${x.days > spanDays ? ' disabled' : ''}" data-roll="${x.days}" ${x.days > spanDays ? 'disabled' : ''}>${x.label}</button>`).join('');
    const scopes = [['all', '전체'], ['combos', '조합만'], ['symbols', '종목만']].map(([k, l]) => `<button type="button" class="subtab-btn${k === rollScope ? ' active' : ''}" data-roll-scope="${k}">${l}</button>`).join('');
    const computed = list.map((c) => ({ c, m: rollingMetrics(c.series, rollDays) })).filter((x) => x.m.ret.length > 1);
    const head = `<div class="news-head" style="margin:22px 0 8px"><h3 class="section-title" style="margin:0;font-size:16px">롤링(슬라이딩 윈도우) 분석</h3><div class="toolbar" style="margin:0;gap:8px"><nav class="subtabs" style="margin:0">${scopes}</nav><div class="range-selector">${pills}</div></div></div>
      <div class="tg-hint" style="margin:0 0 12px">각 시점에서 "직전 ${ROLL_WINDOWS.find((x) => x.days === rollDays).label}" 창을 잘라 수익률·최대 낙폭·연환산 변동성을 다시 계산한 시계열이에요. 조합(현재 입력·저장 조합)과 개별 종목을 함께 또는 따로 볼 수 있고, 범례를 누르면 선을 숨길 수 있어요. 조회 기간이 창보다 길어야 하고(현재 ${Math.round(spanDays)}일), 처음 한 창 길이만큼은 값이 없어요.</div>`;
    if (!computed.length) { box.innerHTML = head + '<div class="tg-empty">조회 기간이 창 길이보다 짧아요. 위에서 더 긴 기간을 선택해 주세요.</div>'; bindRolling(valid, cur); return; }
    box.innerHTML = head + ['ret', 'mdd', 'vol'].map((k) => `<div class="pf-roll-title">${{ ret: '롤링 수익률', mdd: '롤링 최대 낙폭', vol: '롤링 연환산 변동성' }[k]} (%)</div><div id="pf-roll-${k}"></div>`).join('');
    const hints = { ret: '해당 날짜 기준 직전 창 동안의 수익률.', mdd: '해당 날짜 기준 직전 창 안에서 고점 대비 최대 하락폭.', vol: '해당 날짜 기준 직전 창의 일간(또는 주간) 로그수익률 표준편차를 연환산.' };
    ['ret', 'mdd', 'vol'].forEach((k) => renderCombined(computed.map((x) => ({ item: { label: x.c.name, symbol: `ROLL:${k}:${x.c.id}` }, data: x.m[k] })), document.getElementById(`pf-roll-${k}`), { normalize: false, hint: hints[k] }));
    bindRolling(valid, cur);
  }
  function bindRolling(valid, cur) {
    document.querySelectorAll('#pf-rolling [data-roll]').forEach((b) => b.addEventListener('click', () => {
      rollDays = +b.dataset.roll;
      store.set('rollingWindow', rollDays);
      renderRolling(valid, cur);
    }));
    document.querySelectorAll('#pf-rolling [data-roll-scope]').forEach((b) => b.addEventListener('click', () => {
      rollScope = b.dataset.rollScope;
      store.set('rollingScope', rollScope);
      renderRolling(valid, cur);
    }));
  }

  // ---- weight-combination comparison: current input + user-saved combos, side by side.
  let combos = Array.isArray(store.get('combos')) ? store.get('combos') : [];
  function saveCombos() { store.set('combos', combos); }
  function comboList(valid, cur) {
    const syms = valid.map((r) => r.item.symbol);
    const list = [{ name: '현재 입력', weights: cur, kind: 'current' }];
    combos.forEach((c, i) => list.push({ name: c.name, weights: c.weights, kind: 'saved', idx: i }));
    return list.map((c, i) => {
      const w = {}; syms.forEach((s) => { w[s] = Math.max(0, parseFloat(c.weights[s]) || 0); });
      const total = syms.reduce((a, s) => a + w[s], 0);
      const series = total ? buildPortfolioSeries(valid, w) : null;
      return { ...c, id: `COMBO:${i}`, w, total, series, stats: series ? portfolioStats(series) : null,
        desc: syms.map((s) => `${valid.find((r) => r.item.symbol === s).item.label} ${total ? ((w[s] / total) * 100).toFixed(0) : 0}`).join(' / ') };
    });
  }
  function renderCombosSection(valid, cur) {
    const list = comboList(valid, cur).filter((c) => c.stats);
    const best = (key, dir) => { const vals = list.map((c) => c.stats[key]); return dir > 0 ? Math.max(...vals) : Math.min(...vals); };
    const bRet = best('ret', 1), bMdd = best('mdd', 1), bVol = best('vol', -1), bRr = Math.max(...list.map((c) => c.stats.ret / (c.stats.vol || 1)));
    const cell = (v, isBest, cls = '') => `<td class="${cls}${isBest ? ' best' : ''}">${v}</td>`;
    const rows = list.map((c) => {
      const s = c.stats, rr = s.ret / (s.vol || 1);
      const act = c.kind === 'saved' ? `<button type="button" class="pf-mini" data-apply="${c.idx}">적용</button><button type="button" class="pf-mini danger" data-del="${c.idx}">삭제</button>` : '';
      const nameCell = c.kind === 'saved'
        ? `<b class="pf-name-edit" contenteditable="true" spellcheck="false" data-idx="${c.idx}" title="클릭해서 이름 수정 (Enter로 확정)">${c.name}</b>`
        : `<b>${c.name}</b>`;
      return `<tr class="${c.kind}"><td>${nameCell}<div class="meta">${c.desc}</div></td>${cell((s.ret >= 0 ? '+' : '') + s.ret.toFixed(2) + '%', s.ret === bRet, s.ret >= 0 ? 'up' : 'down')}${cell(s.mdd.toFixed(2) + '%', s.mdd === bMdd, 'down')}${cell(s.vol.toFixed(1) + '%', s.vol === bVol)}${cell(rr.toFixed(2), rr === bRr)}<td class="act">${act}</td></tr>`;
    }).join('');
    return `
      <div class="pf-combos">
        <div class="news-head" style="margin:18px 0 8px"><h3 class="section-title" style="margin:0;font-size:16px">비중 조합 비교</h3>
          <span class="pf-save"><input id="pf-combo-name" type="text" placeholder="조합 이름 (예: 공격형)" maxlength="20"><button type="button" class="pf-mini" id="pf-combo-save">현재 입력 저장</button></span></div>
        <div class="table-wrap"><table class="pf-table"><thead><tr><th>조합</th><th>기간 수익률</th><th>최대 낙폭</th><th>연환산 변동성</th><th title="기간 수익률 ÷ 연환산 변동성">수익/변동성</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="tg-hint" style="margin:6px 0 10px">비중을 바꾼 뒤 이름을 붙여 저장하면 여기에 쌓여 비교돼요. 각 열의 최선값은 파란 배경으로 표시되고, 같은 기간·같은 매수후보유 가정의 상대 비교용이에요.</div>
        <div id="pf-combos-chart"></div>
      </div>`;
  }
  function renderCombosChart(valid, cur) {
    const list = comboList(valid, cur).filter((c) => c.series);
    renderCombined(list.map((c) => ({ item: { label: c.name, symbol: c.id }, data: c.series })), document.getElementById('pf-combos-chart'));
  }
  function bindCombos(valid, cur) {
    const nameEl = document.getElementById('pf-combo-name');
    document.getElementById('pf-combo-save').addEventListener('click', () => {
      const name = (nameEl.value || '').trim() || `조합 ${combos.length + 1}`;
      combos.push({ name, weights: { ...cur } }); saveCombos(); renderAll();
    });
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('pf-combo-save').click(); });
    weighted.querySelectorAll('.pf-name-edit').forEach((el) => {
      const idx = +el.dataset.idx;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.textContent = combos[idx].name; el.blur(); }
      });
      el.addEventListener('blur', () => {
        const name = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 20);
        if (!name || name === combos[idx].name) { el.textContent = combos[idx].name; return; }
        combos[idx].name = name; saveCombos(); renderAll();
      });
    });
    weighted.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { combos.splice(+b.dataset.del, 1); saveCombos(); renderAll(); }));
    weighted.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => { weights = { ...combos[+b.dataset.apply].weights }; saveWeights(); renderAll(); }));
  }
  // Sliders update the editor labels immediately; the heavy outputs (stats,
  // charts, combo table) are re-rendered debounced so dragging stays smooth
  // and the editor DOM itself is never replaced mid-drag.
  function bindWeights(valid) {
    let timer = null;
    const apply = (symbol, value, persist) => {
      weights[symbol] = Math.max(0, value);
      updateWeightLabels(valid);
      clearTimeout(timer);
      timer = setTimeout(() => renderWeightedOut(valid), persist ? 0 : 150);
      if (persist) saveWeights();
    };
    weighted.querySelectorAll('.pf-wrow').forEach((row) => {
      const s = row.dataset.symbol, slider = row.querySelector('input[type=range]'), num = row.querySelector('input[type=number]');
      slider.addEventListener('input', () => { num.value = slider.value; apply(s, +slider.value, false); });
      slider.addEventListener('change', () => apply(s, +slider.value, true));
      num.addEventListener('input', () => { const v = parseFloat(num.value) || 0; slider.value = Math.min(100, v); apply(s, v, false); });
      num.addEventListener('change', () => apply(s, parseFloat(num.value) || 0, true));
    });
    const eq = document.getElementById('pf-equal');
    if (eq) eq.addEventListener('click', () => { weights = {}; saveWeights(); renderAll(); });
  }

  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }

  async function renderAll() {
    grid.innerHTML = ''; combined.innerHTML = ''; weighted.innerHTML = '';
    empty.hidden = items.length > 0;
    grid.hidden = view !== 'cards'; combined.hidden = view !== 'combined'; weighted.hidden = view !== 'weighted'; holdingsEl.hidden = view !== 'holdings';
    if (view === 'holdings') { renderHoldings(); status.textContent = items.length ? `${items.length}종목` : ''; return; }
    status.textContent = items.length ? `${items.length}종목 · 최근 ${range.label} · 불러오는 중...` : '';
    const rows = await Promise.all(items.map(async (item) => ({ item, data: await getSeries(item) })));
    status.textContent = items.length ? `${items.length}종목 · 최근 ${range.label}` : '';
    if (view === 'cards') rows.forEach((r) => renderCard(r.item, r.data));
    else if (!items.length) return;
    else if (view === 'combined') { renderCombined(rows); combined.prepend(manageBar()); }
    else { renderWeighted(rows); weighted.prepend(manageBar()); }
  }

  // Symbol chips with a remove button, shown on the non-card views.
  function manageBar() {
    const bar = document.createElement('div');
    bar.className = 'pf-manage';
    bar.innerHTML = `<span class="meta">종목 관리</span>` + items.map((it) => `<span class="pf-mchip"><b>${it.label}</b><span class="meta">${it.symbol}</span><button type="button" class="pf-mremove" data-symbol="${it.symbol}" title="삭제">×</button></span>`).join('');
    bar.querySelectorAll('.pf-mremove').forEach((b) => b.addEventListener('click', () => {
      if (confirm(`${b.dataset.symbol} 종목을 포트폴리오에서 삭제해요.`)) removeItem(b.dataset.symbol);
    }));
    return bar;
  }

  async function addSymbol(symbol, label) {
    symbol = symbol.trim().toUpperCase();
    if (!symbol) return;
    if (items.some((x) => x.symbol === symbol)) { status.textContent = `${symbol}은(는) 이미 있어요`; return; }
    items.push({ symbol, label: label || symbol });
    save();
    input.value = '';
    results.hidden = true;
    renderAll();
  }

  let searchTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 1) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        const quotes = data.quotes || [];
        results.innerHTML = quotes.length
          ? quotes.map((x) => `<div class="pf-result" data-symbol="${x.symbol}" data-name="${x.name.replace(/"/g, '&quot;')}"><span><span class="sym">${x.symbol}</span> ${x.name}</span><span class="meta">${x.exchange} · ${x.type}</span></div>`).join('')
          : `<div class="pf-result"><span class="meta">검색 결과 없음 — 티커를 직접 입력하고 Enter</span></div>`;
        results.hidden = false;
      } catch { results.hidden = true; }
    }, 250);
  });
  results.addEventListener('click', (e) => {
    const el = e.target.closest('.pf-result[data-symbol]');
    if (el) addSymbol(el.dataset.symbol, el.dataset.name);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSymbol(input.value); }
    if (e.key === 'Escape') results.hidden = true;
  });
  addBtn.addEventListener('click', () => addSymbol(input.value));
  document.addEventListener('click', (e) => { if (!e.target.closest('.pf-search')) results.hidden = true; });

  // ---- 실제 보유 & 리밸런싱: holdings (qty + target %) live on the server so the
  // daily check can run without a browser open. ----
  const holdingsEl = document.getElementById('pf-holdings');
  const DEFAULT_RULES = { absBand: 5, relBand: 25, calendarDays: 90, lastRebalancedAt: null };
  function getHoldings() { const h = store.get('holdings'); return Array.isArray(h) ? h : []; }
  function getRules() { return { ...DEFAULT_RULES, ...(store.get('rules') || {}) }; }
  const fmtMoney = (v, cur) => (v == null ? '-' : `${Math.round(v).toLocaleString('ko-KR')} ${cur || ''}`.trim());
  const fmtPct = (v, d = 1) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);

  function renderHoldings() {
    const bySym = Object.fromEntries(getHoldings().map((h) => [h.symbol, h]));
    const rules = getRules();
    const rows = items.map((it) => {
      const h = bySym[it.symbol] || {};
      return `<tr data-symbol="${it.symbol}" data-label="${it.label.replace(/"/g, '&quot;')}"><td><b>${it.label}</b><div class="meta">${it.symbol}</div></td>
        <td><input type="number" min="0" step="any" class="h-qty" value="${h.qty ?? ''}" placeholder="0"></td>
        <td><input type="number" min="0" step="1" class="h-target" value="${h.target ?? ''}" placeholder="0"> %</td></tr>`;
    }).join('');
    const targetSum = items.reduce((a, it) => a + Number(bySym[it.symbol]?.target || 0), 0);
    holdingsEl.innerHTML = `
      <p class="tg-hint" style="margin:0 0 12px">보유 수량과 목표 비중을 입력하고 저장하면, 서버가 매일 장 마감 후 현재가로 비중을 다시 계산해 리밸런싱이 필요한지 점검해요. 필요하면 텔레그램으로 알려 주고 탭에 빨간 점이 켜져요. 종목은 위 검색창에서 추가해 주세요.</p>
      <div class="table-wrap"><table class="pf-table pf-hold-table"><thead><tr><th>종목</th><th>보유 수량</th><th>목표 비중</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="meta">종목을 먼저 추가해 주세요</td></tr>'}</tbody></table></div>
      <div class="pf-wfoot" style="margin:10px 0 18px"><span class="meta">목표 비중 합계 <b id="h-sum">${targetSum.toFixed(0)}</b>% (100이 아니어도 비율로 맞춰요)</span><button type="button" class="pf-mini" id="h-equal">동일 목표비중</button></div>
      <h3 class="pf-roll-title" style="margin-top:0">리밸런싱 기준</h3>
      <div class="pf-rules">
        <label>절대 밴드 <input type="number" min="0" step="0.5" id="r-abs" value="${rules.absBand}"> %p</label>
        <label>상대 밴드 <input type="number" min="0" step="1" id="r-rel" value="${rules.relBand}"> %</label>
        <label>정기 점검 <input type="number" min="0" step="1" id="r-cal" value="${rules.calendarDays}"> 일마다</label>
        <label>마지막 리밸런싱 <input type="date" id="r-last" value="${rules.lastRebalancedAt ? rules.lastRebalancedAt.slice(0, 10) : ''}"></label>
        <button type="button" class="pf-mini" id="r-today">오늘 리밸런싱 완료</button>
      </div>
      <p class="tg-hint" style="margin:6px 0 14px">목표 대비 <b>절대 밴드(%p)</b> 또는 <b>상대 밴드(목표 비중의 %)</b> 중 하나라도 넘으면 조정 신호예요. 정기 점검은 마지막 리밸런싱 후 정해진 일수가 지나면 알려 줘요(0이면 끄기). 업계에서 흔한 기본값은 5%p / 25% / 90일이에요.</p>
      <div class="pf-wfoot"><button type="button" class="scenario-btn" id="h-save">저장하고 지금 점검하기</button><button type="button" class="pf-mini" id="h-notify">텔레그램으로 보내기</button><button type="button" class="pf-mini" id="h-kakao-send">카카오톡으로 보내기</button><button type="button" class="pf-mini" id="h-kakao-connect">카카오 연결</button><span class="meta" id="h-status"></span></div>
      <div id="h-result"></div>`;

    const notifyVia = async (channel, label) => {
      const st = holdingsEl.querySelector('#h-status');
      st.textContent = `${label}으로 보내는 중...`;
      try {
        const res = await fetch(`/api/rebalance-notify?channel=${channel}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        st.textContent = `${label}으로 보냈어요`;
      } catch (e) { st.textContent = `전송 실패: ${e.message}`; }
    };
    holdingsEl.querySelector('#h-kakao-send').addEventListener('click', () => notifyVia('kakao', '카카오톡'));
    holdingsEl.querySelector('#h-kakao-connect').addEventListener('click', () => { window.open('/auth/kakao', '_blank'); });

    holdingsEl.querySelector('#h-equal').addEventListener('click', () => {
      const n = items.length || 1;
      holdingsEl.querySelectorAll('.h-target').forEach((el) => { el.value = (100 / n).toFixed(1); });
      updateTargetSum();
    });
    holdingsEl.querySelectorAll('.h-target').forEach((el) => el.addEventListener('input', updateTargetSum));
    holdingsEl.querySelector('#r-today').addEventListener('click', () => { holdingsEl.querySelector('#r-last').value = new Date().toISOString().slice(0, 10); });
    holdingsEl.querySelector('#h-save').addEventListener('click', async () => {
      saveHoldingsForm();
      updateTargetSum();
      await store.flush();
      loadCheck(true);
    });
    holdingsEl.querySelector('#h-notify').addEventListener('click', () => notifyVia('telegram', '텔레그램'));
    loadCheck(false);
  }
  function updateTargetSum() {
    const sum = [...holdingsEl.querySelectorAll('.h-target')].reduce((a, el) => a + (parseFloat(el.value) || 0), 0);
    holdingsEl.querySelector('#h-sum').textContent = sum.toFixed(0);
  }
  function saveHoldingsForm() {
    const holdings = [...holdingsEl.querySelectorAll('tr[data-symbol]')].map((tr) => ({
      symbol: tr.dataset.symbol, label: tr.dataset.label,
      qty: parseFloat(tr.querySelector('.h-qty').value) || 0, target: parseFloat(tr.querySelector('.h-target').value) || 0,
    }));
    const last = holdingsEl.querySelector('#r-last').value;
    store.set('holdings', holdings);
    store.set('rules', {
      absBand: parseFloat(holdingsEl.querySelector('#r-abs').value) || 0,
      relBand: parseFloat(holdingsEl.querySelector('#r-rel').value) || 0,
      calendarDays: parseInt(holdingsEl.querySelector('#r-cal').value, 10) || 0,
      lastRebalancedAt: last ? new Date(last + 'T00:00:00').toISOString() : null,
    });
  }
  async function loadCheck(refresh) {
    const out = holdingsEl.querySelector('#h-result'), st = holdingsEl.querySelector('#h-status');
    if (!out) return;
    st.textContent = refresh ? '현재가를 받아 점검하는 중...' : '';
    try {
      const res = await fetch('/api/rebalance-check' + (refresh ? '?refresh=1' : ''));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      st.textContent = '';
      renderCheck(data);
      window.setRebalanceBadge && window.setRebalanceBadge(data);
    } catch (e) { st.textContent = `점검 실패: ${e.message}`; }
  }
  function renderCheck(d) {
    const out = holdingsEl.querySelector('#h-result');
    if (!d.rows || !d.rows.length) { out.innerHTML = `<div class="tg-empty">${(d.reasons || []).join(' ') || '보유 정보를 저장하면 점검 결과가 여기에 나와요'}</div>`; return; }
    const banner = `<div class="h-banner ${d.triggered ? 'warn' : 'ok'}"><b>${d.triggered ? '리밸런싱 점검이 필요해요' : '목표 범위 안에 있어요'}</b>${d.reasons.length ? '<ul>' + d.reasons.map((r) => `<li>${r}</li>`).join('') + '</ul>' : ''}</div>`;
    const rows = d.rows.map((r) => `<tr class="${r.bandHit ? 'hit' : ''}"><td><b>${r.label}</b><div class="meta">${r.symbol}</div></td><td>${r.error ? `<span class="meta">${r.error}</span>` : fmtMoney(r.price, r.currency)}</td><td>${fmtMoney(r.valueKRW ?? r.value, r.valueKRW != null ? 'KRW' : r.currency)}</td><td>${r.curPct == null ? '-' : r.curPct.toFixed(1) + '%'}</td><td>${r.target.toFixed(1)}%</td><td class="${r.drift > 0 ? 'up' : r.drift < 0 ? 'down' : ''}">${fmtPct(r.drift)}p <span class="meta">(${fmtPct(r.relDrift, 0)})</span></td><td>${r.bandHit ? '<span class="h-flag">조정</span>' : '<span class="meta">유지</span>'}</td></tr>`).join('');
    const trades = d.trades.length ? `<h3 class="pf-roll-title">목표 비중으로 돌아가려면</h3><ul class="h-trades">${d.trades.map((t) => `<li><b>${t.label}</b> ${t.action === 'buy' ? '<span class="up">매수</span>' : '<span class="down">매도</span>'} ${t.shares}${/-USD$/.test(t.symbol) ? '' : '주'} <span class="meta">≈ ${fmtMoney(t.amount, t.currency)}</span></li>`).join('')}</ul>` : '';
    const k = d.kakao || {};
    const kakaoLine = !k.configured ? '카카오톡: .env 에 KAKAO_REST_KEY 를 넣고 서버를 재시작한 뒤 "카카오 연결"을 눌러 주세요'
      : k.connected ? `카카오톡: 연결됨 (${k.connectedAt ? k.connectedAt.slice(0, 10) + ' 연결' : ''}${k.refreshExpiresAt ? `, ${k.refreshExpiresAt.slice(0, 10)}까지 유효 · 알림이 나갈 때마다 자동 연장` : ''})`
      : '카카오톡: 아직 연결되지 않았어요. "카카오 연결" 버튼을 눌러 한 번 로그인하면 "나와의 채팅"으로 알림이 와요';
    const tgLine = d.telegramConfigured ? '텔레그램: 켜짐' : '텔레그램: 꺼짐 (.env 에 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)';
    const tg = `${d.schedule}에 자동 점검하고, 조정 신호가 있으면 연결된 채널로 하루 한 번 알려 줘요. 앱 내 빨간 점 배지는 항상 동작해요.<br>${tgLine} · ${kakaoLine}${d.lastAlertDate ? `<br>마지막 알림 ${d.lastAlertDate}` : ''}${d.lastAlertError ? `<br>최근 전송 오류: ${d.lastAlertError}` : ''}`;
    const kc = holdingsEl.querySelector('#h-kakao-connect'); if (kc) kc.textContent = k.connected ? '카카오 다시 연결' : '카카오 연결';
    out.innerHTML = banner + `<div class="table-wrap"><table class="pf-table"><thead><tr><th>종목</th><th>현재가</th><th>평가액</th><th>현재 비중</th><th>목표</th><th>드리프트</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="meta" style="margin:8px 0">총 평가액 ${fmtMoney(d.totalValue, 'KRW')}${d.fxUsdKrw ? ` (달러 자산은 ${d.fxUsdKrw.toFixed(1)}원/달러로 환산)` : ''} · ${new Date(d.asOf).toLocaleString('ko-KR')} 기준${d.daysSince != null ? ` · 마지막 리밸런싱 후 ${d.daysSince}일` : ''}</div>` + trades + `<div class="tg-hint" style="margin:12px 0 0">${tg}</div>`;
  }

  document.querySelector('.tab-btn[data-tab="portfolio"]').addEventListener('click', () => {
    if (!loadedOnce) { loadedOnce = true; renderAll(); }
  });
})();
