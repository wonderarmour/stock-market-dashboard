// Episode analyzer for a long price history: finds every drawdown (or rally)
// episode, labels documented ones, and ranks which past episode most resembles
// the current path. Instantiated twice at the bottom (하락 / 상승).
(function () {
  const SYMBOL = '^IXIC';

  function fmtDate(d) { return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function pct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }
  function chg(from, to) { return ((to - from) / from) * 100; }

  let historyPromise = null;
  function fetchFullHistory() {
    if (historyPromise) return historyPromise;
    historyPromise = (async () => {
      const period2 = Math.floor(Date.now() / 1000);
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(SYMBOL)}&period1=0&period2=${period2}&interval=1d`);
      if (!res.ok) throw new Error('시세 조회 오류: ' + res.status);
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error(data?.chart?.error?.description || '데이터 없음');
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const points = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (closes[i] != null) points.push({ date: fmtDate(new Date(timestamps[i] * 1000)), value: closes[i] });
      }
      return points;
    })().catch((e) => { historyPromise = null; throw e; });
    return historyPromise;
  }

  // ---- episode detection -------------------------------------------------
  // down: from the running peak, price falls >= |trigger|%. Ends when it regains
  //   the peak ("recovered"), first rallies +endPct off the trough ("rebound":
  //   a new phase - otherwise a peak that takes 15 years to regain, like 2000,
  //   swallows 2008/2010/2011), or data ends.
  // up: mirror image - from the running trough, price rises >= trigger%. Ends
  //   when it pulls back endPct% from the episode high ("pullback") or data ends.
  function findEpisodes(series, cfg) {
    const up = cfg.direction === 'up';
    const better = (a, b) => (up ? a < b : a > b); // "more extreme" reference
    const events = [];
    if (series.length < 2) return events;
    let refIdx = 0; // running peak (down) / running trough (up)
    let cur = null;

    for (let i = 1; i < series.length; i++) {
      const v = series[i].value;
      if (!cur) {
        if (better(v, series[refIdx].value)) { refIdx = i; continue; }
        const move = chg(series[refIdx].value, v);
        if (up ? move >= cfg.triggerPct : move <= cfg.triggerPct) cur = { startIndex: refIdx, extremeIndex: i };
        continue;
      }
      const ext = series[cur.extremeIndex].value;
      if (up ? v > ext : v < ext) cur.extremeIndex = i;
      const extNow = series[cur.extremeIndex].value;
      if (!up && v >= series[cur.startIndex].value) { cur.endIndex = i; cur.endReason = 'recovered'; }
      else if (!up && chg(extNow, v) >= cfg.endPct) { cur.endIndex = i; cur.endReason = 'rebound'; }
      else if (up && chg(extNow, v) <= -cfg.endPct) { cur.endIndex = i; cur.endReason = 'pullback'; }
      if (cur.endIndex != null) { events.push(cur); refIdx = i; cur = null; }
    }
    if (cur) { cur.endIndex = series.length - 1; cur.endReason = 'ongoing'; events.push(cur); }

    if (!up) {
      events.forEach((ev) => {
        if (ev.endReason !== 'rebound') return;
        const target = series[ev.startIndex].value;
        for (let j = ev.endIndex; j < series.length; j++) if (series[j].value >= target) { ev.fullRecoveryIndex = j; break; }
      });
    }
    return events;
  }

  // ---- labeling ------------------------------------------------------------
  function identify(known, startDate, extremeDate) {
    const t = (d) => daysBetween('1900-01-01', d);
    let best = null, bestScore = 0;
    known.forEach((k) => {
      const overlap = Math.min(t(extremeDate), t(k.end)) - Math.max(t(startDate), t(k.start));
      if (overlap <= 0) return;
      const span = Math.min(Math.max(1, daysBetween(startDate, extremeDate)), Math.max(1, daysBetween(k.start, k.end)));
      const score = overlap / span;
      if (score > bestScore) { bestScore = score; best = k; }
    });
    if (best && bestScore >= 0.3) return best.name;
    let near = null, nearDiff = Infinity;
    known.forEach((k) => { const d = Math.abs(daysBetween(k.start, startDate)); if (d < nearDiff) { nearDiff = d; near = k; } });
    return near && nearDiff <= 60 ? near.name : null;
  }

  function describe(series, ev, cfg) {
    const start = series[ev.startIndex], extreme = series[ev.extremeIndex], end = series[ev.endIndex];
    const movePct = chg(start.value, extreme.value);
    const known = identify(cfg.known, start.date, extreme.date);
    return { start, extreme, end, movePct, isKnown: !!known, name: known || `${cfg.severity(movePct)} (구체적 계기 미상)` };
  }

  function endText(series, ev, d, cfg) {
    if (ev.endReason === 'recovered') return `${d.end.date} 이전 고점 회복`;
    if (ev.endReason === 'rebound') {
      const later = ev.fullRecoveryIndex != null ? `이전 고점은 ${series[ev.fullRecoveryIndex].date} 회복` : '이전 고점 아직 미회복';
      return `${d.end.date} 저점 대비 +${cfg.endPct}% 반등으로 국면 종료 (${later})`;
    }
    if (ev.endReason === 'pullback') return `${d.end.date} 고점 대비 -${cfg.endPct}% 조정으로 국면 종료`;
    return `진행 중 (${cfg.direction === 'up' ? '아직 -' + cfg.endPct + '% 조정 없음' : '이전 고점 미회복'})`;
  }

  // ---- "news of that era" modal ----
  function eraAttrs(d, ev, cfg) {
    return `data-era-start="${d.start.date}" data-era-extreme="${d.extreme.date}" data-era-end="${ev.endReason === 'ongoing' ? '' : d.end.date}" data-era-label="${d.name.replace(/"/g, '&quot;')}" data-era-dir="${cfg.direction}" title="클릭: 당시 뉴스 요약"`;
  }
  // Minimal markdown: escape HTML, then **bold**, "- " bullets, "### " headings.
  function mdLite(text) {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.split('\n').map((line) => {
      let l = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^\s*#{1,6}\s+/.test(l)) return `<div class="md-h">${l.replace(/^\s*#{1,6}\s+/, '')}</div>`;
      if (/^\s*[-•*]\s+/.test(l)) return `<div class="md-li">${l.replace(/^\s*[-•*]\s+/, '')}</div>`;
      return l.trim() ? `<div>${l}</div>` : '<div class="md-gap"></div>';
    }).join('');
  }
  window.mdLite = mdLite;
  const eraModal = document.getElementById('era-modal');
  const eraTitle = document.getElementById('era-title'), eraMeta = document.getElementById('era-meta');
  const eraBody = document.getElementById('era-body'), eraSources = document.getElementById('era-sources');
  async function openEra(ds) {
    eraTitle.textContent = ds.eraLabel;
    eraMeta.textContent = `${ds.eraStart} → ${ds.eraExtreme}${ds.eraEnd ? ' → ' + ds.eraEnd : ''}`;
    eraBody.textContent = '당시 기록을 모으고 요약하는 중... (위키백과 + AI, 10~20초)';
    eraSources.innerHTML = '';
    eraModal.hidden = false;
    try {
      const qs = new URLSearchParams({ start: ds.eraStart, extreme: ds.eraExtreme, end: ds.eraEnd || '', label: ds.eraLabel, direction: ds.eraDir });
      const res = await fetch('/api/era-news?' + qs);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      eraBody.innerHTML = mdLite(data.summary);
      const src = data.sources.map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>`).join(' · ');
      eraSources.innerHTML = (data.grounded ? '근거 자료: ' + src : '위키백과에 이 시기 기록이 없어 AI 지식만으로 작성했어요') + ' · AI 요약이라 세부 날짜·수치는 원문으로 확인해 주세요.';
    } catch (e) {
      eraBody.textContent = `요약 실패: ${e.message}`;
    }
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-era-start]');
    if (el) { openEra(el.dataset); return; }
    if (e.target === eraModal || e.target.dataset.close !== undefined) eraModal.hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') eraModal.hidden = true; });

  function renderEvent(series, ev, d, cfg) {
    const card = document.createElement('div');
    card.className = 'card ' + (cfg.direction === 'up' ? 'trend-up' : 'trend-down') + ' clickable';
    card.innerHTML = `
      <div class="label">${d.name}</div>
      <div class="sub">${d.start.date} ${cfg.startWord} ${d.start.value.toFixed(2)} → ${d.extreme.date} ${cfg.extremeWord} ${d.extreme.value.toFixed(2)}</div>
      <div class="stat-row">
        <div class="value">${pct(d.movePct)}</div>
        <div class="delta ${cfg.direction === 'up' ? 'up' : 'down'}">${cfg.moveWord}</div>
      </div>
      <div class="asof">${cfg.startWord}→${cfg.extremeWord} ${daysBetween(d.start.date, d.extreme.date)}일 · ${endText(series, ev, d, cfg)}</div>
      <div class="chart-box"></div>
    `;
    const attrs = document.createElement('div');
    attrs.innerHTML = `<i ${eraAttrs(d, ev, cfg)}></i>`;
    [...attrs.firstChild.attributes].forEach((at) => card.setAttribute(at.name, at.value));
    const a = Math.max(0, ev.startIndex - 5), b = Math.min(series.length - 1, ev.endIndex + 5);
    renderChart(card.querySelector('.chart-box'), series.slice(a, b + 1), SYMBOL);
    return card;
  }

  // ---- analog search --------------------------------------------------------
  // Score = 0.40 shape (Pearson corr. of day-by-day %-from-start paths)
  //       + 0.30 level (RMSE of those paths, %-points)
  //       + 0.15 volatility regime (20d realized vol at the comparable day)
  //       + 0.15 run-in (12-month return into the start point).
  // Shape+level is the standard "historical analog overlay"; vol tells a panic
  // from a grind, run-in tells a bubble unwind from a dip (or a V-bounce from a grind up).
  function pathFrom(series, idx, len) {
    const base = series[idx].value, out = [];
    for (let k = 0; k <= len && idx + k < series.length; k++) out.push(chg(base, series[idx + k].value));
    return out;
  }
  function realizedVol(series, idx, win = 20) {
    const r = [];
    for (let i = Math.max(1, idx - win + 1); i <= idx; i++) r.push(Math.log(series[i].value / series[i - 1].value));
    if (r.length < 5) return null;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt((r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * 252) * 100;
  }
  function runIn(series, idx, win = 252) { return idx - win < 0 ? null : chg(series[idx - win].value, series[idx].value); }
  function pearson(a, b) {
    const n = Math.min(a.length, b.length); if (n < 3) return 0;
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }
  function closeness(a, b) { return a == null || b == null ? 0.5 : 1 - Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-9); }

  // Resample a path to at most `m` points so DTW/corr cost is bounded and long
  // and short episodes are compared on the same footing.
  function resample(path, m) {
    if (path.length <= m) return path;
    const out = [];
    for (let i = 0; i < m; i++) out.push(path[Math.round((i * (path.length - 1)) / (m - 1))]);
    return out;
  }
  function blockReturns(path, block = 5) {
    const out = [];
    for (let i = block; i < path.length; i += block) out.push(path[i] - path[i - block]);
    return out;
  }
  // Sakoe-Chiba banded DTW on %-paths; returns average per-step distance.
  function dtw(a, b, bandFrac = 0.1) {
    const n = a.length, m = b.length, w = Math.max(2, Math.round(Math.max(n, m) * bandFrac));
    const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
    D[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let j = Math.max(1, i - w); j <= Math.min(m, i + w); j++) {
        const c = Math.abs(a[i - 1] - b[j - 1]);
        D[i][j] = c + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
      }
    }
    return D[n][m] / Math.max(n, m);
  }
  function bestLagCorr(series, startIdx, len, cur, maxLag = 3) {
    let best = -1;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const s = startIdx + lag;
      if (s < 0 || s + len >= series.length) continue;
      best = Math.max(best, pearson(resample(cur, 120), resample(pathFrom(series, s, len), 120)));
    }
    return best;
  }
  const MAX_PTS = 120;

  // Raw component metrics for one candidate window vs the current path.
  function metricsFor(series, startIdx, len, cur, curVol, curRun) {
    const p = pathFrom(series, startIdx, len);
    const c = cur.slice(0, len + 1);
    const corrLevel = bestLagCorr(series, startIdx, len, c);
    const corrRet = pearson(blockReturns(resample(c, MAX_PTS)), blockReturns(resample(p, MAX_PTS)));
    const d = dtw(resample(c, MAX_PTS), resample(p, MAX_PTS));
    const vol = realizedVol(series, startIdx + len), run = runIn(series, startIdx);
    return { corrLevel, corrRet, dtw: d, vol, run, moveAtLen: p[p.length - 1] };
  }
  function scoreOf(m, medDtw, curVol, curRun, w) {
    const sShape = 0.5 * ((m.corrLevel + 1) / 2) + 0.5 * ((m.corrRet + 1) / 2);
    const sLevel = 1 - m.dtw / (m.dtw + medDtw);
    const sVol = m.vol == null || curVol == null ? 0.5 : Math.max(0, 1 - Math.abs(Math.log(curVol / m.vol)) / Math.log(3));
    const sRun = closeness(curRun, m.run);
    return { score: w.shape * sShape + w.level * sLevel + w.vol * sVol + w.run * sRun, sShape, sLevel, sVol, sRun };
  }

  // Shared weight controls (normalized to sum 1). Defaults 40/30/15/15.
  const DEFAULT_W = { shape: 40, level: 30, vol: 15, run: 15 };
  function getWeights() {
    const raw = {};
    Object.keys(DEFAULT_W).forEach((k) => {
      const el = document.getElementById('w-' + k);
      const v = el ? parseFloat(el.value) : NaN;
      raw[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_W[k];
    });
    const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
    const w = {};
    Object.keys(raw).forEach((k) => { w[k] = raw[k] / sum; });
    return w;
  }

  function findAnalogs(series, events, described, cfg) {
    const up = cfg.direction === 'up';
    const last = series.length - 1;
    // current reference = start of the ongoing episode if there is one, else the
    // extreme (peak for down / trough for up) since the last episode ended -
    // i.e. the low since the last -10% correction, not the all-time low.
    const lastEv = events[events.length - 1];
    let ref;
    if (lastEv && lastEv.endReason === 'ongoing') ref = lastEv.startIndex;
    else {
      ref = lastEv ? lastEv.endIndex : 0;
      for (let i = ref + 1; i < series.length; i++) if (up ? series[i].value <= series[ref].value : series[i].value >= series[ref].value) ref = i;
    }
    const n = last - ref;
    const curPath = pathFrom(series, ref, n);
    const curVol = realizedVol(series, last), curRun = runIn(series, ref);

    // 1) candidate episodes
    const cands = [];
    events.forEach((ev, idx) => {
      if (ev.endReason === 'ongoing') return;
      const len = Math.min(n, ev.endIndex - ev.startIndex);
      if (len < Math.min(n, 10) || len < 3) return;
      cands.push({ ev, d: described[idx], len, m: metricsFor(series, ev.startIndex, len, curPath, curVol, curRun) });
    });
    // 2) random-window null baseline: how good does a match look by chance?
    const len0 = Math.min(n, 250);
    const nulls = [];
    const lo = 260, hi = last - len0 - 1;
    if (hi > lo && len0 >= 3) {
      const K = 120;
      for (let k = 0; k < K; k++) {
        const s = lo + Math.floor(Math.random() * (hi - lo));
        if (s + len0 >= ref - 5 && s <= last) continue; // don't overlap the current window
        nulls.push(metricsFor(series, s, len0, curPath, curVol, curRun));
      }
    }
    const allDtw = cands.map((c) => c.m.dtw).concat(nulls.map((m) => m.dtw)).sort((a, b) => a - b);
    const medDtw = allDtw.length ? allDtw[Math.floor(allDtw.length / 2)] : 1;
    return { series, last, ref, n, curMove: curPath[curPath.length - 1], curVol, curRun, cands, nulls, medDtw };
  }

  // Weight-dependent part, cheap to re-run when the user changes weights.
  function scoreAll(res, w) {
    const { series, last, cands, nulls, medDtw, curVol, curRun } = res;
    cands.forEach((c) => Object.assign(c, scoreOf(c.m, medDtw, curVol, curRun, w)));
    const nullScores = nulls.map((m) => scoreOf(m, medDtw, curVol, curRun, w).score).sort((a, b) => a - b);
    const pctBelow = (s) => (nullScores.length ? (nullScores.filter((x) => x < s).length / nullScores.length) * 100 : null);
    cands.sort((a, b) => b.score - a.score);
    cands.forEach((c) => { c.nullPct = pctBelow(c.score); });

    // analog ensemble: what happened over the next 60 trading days after the comparable point
    const H = 60;
    const fwd = cands.slice(0, 5).map((c) => {
      const from = c.ev.startIndex + c.len, to = Math.min(last, from + H);
      return to > from ? chg(series[from].value, series[to].value) : null;
    }).filter((v) => v != null).sort((a, b) => a - b);
    const ensemble = fwd.length ? { n: fwd.length, med: fwd[Math.floor(fwd.length / 2)], min: fwd[0], max: fwd[fwd.length - 1], h: H } : null;

    return { ...res, w, top: cands.slice(0, 10), nullN: nullScores.length, ensemble };
  }

  function renderAnalogs(series, res, cfg, box) {
    const refPt = series[res.ref], lastPt = series[series.length - 1];
    let html = `
      <div class="analog-now">
        <div class="analog-title">현재 상황</div>
        <div>최근 ${cfg.startWord} ${refPt.date} (${refPt.value.toFixed(2)}) → 현재 ${lastPt.date} ${lastPt.value.toFixed(2)} · ${cfg.startWord} 대비 <b>${pct(res.curMove)}</b> · ${cfg.startWord} 이후 ${res.n}거래일 · 20일 변동성 ${res.curVol?.toFixed(0) ?? '-'}% · ${cfg.startWord} 직전 12개월 ${res.curRun != null ? pct(res.curRun) : '-'}</div>
        ${res.n < 10 ? '<div class="analog-warn">' + cfg.startWord + ' 이후 기간이 짧아서(10거래일 미만) 경로 비교 신뢰도가 낮아요</div>' : ''}
      </div>`;
    if (!res.top.length) { box.innerHTML = html + '<div class="tg-empty">비교할 수 있는 과거 이벤트가 없어요</div>'; return; }
    html += '<div class="analog-list">';
    res.top.forEach((t, i) => {
      const d = t.d, m = t.m;
      const sig = t.nullPct == null ? '' : ` · 무작위 ${res.nullN}개 구간 대비 백분위 ${t.nullPct.toFixed(0)}${t.nullPct >= 95 ? ' (유의미)' : t.nullPct >= 80 ? '' : ' (우연 수준)'}`;
      html += `
        <div class="analog-item${i === 0 ? ' best' : ''}" ${eraAttrs(d, t.ev, cfg)}>
          <div class="analog-rank">${i + 1}위 · 유사도 ${(t.score * 100).toFixed(0)}점${sig}</div>
          <div class="analog-name">${d.name}</div>
          <div class="analog-meta">${d.start.date} ${cfg.startWord} · 같은 시점(${t.len}거래일) ${pct(m.moveAtLen)} vs 현재 ${pct(res.curMove)}</div>
          <div class="analog-meta">형태 ${(t.sShape * 100).toFixed(0)} (경로 상관 ${m.corrLevel.toFixed(2)} · 5일 수익률 상관 ${m.corrRet.toFixed(2)}) · 수준 ${(t.sLevel * 100).toFixed(0)} (DTW ${m.dtw.toFixed(1)}%p) · 변동성 ${(t.sVol * 100).toFixed(0)} (${m.vol?.toFixed(0) ?? '-'}%) · 진입 흐름 ${(t.sRun * 100).toFixed(0)} (${m.run != null ? pct(m.run) : '-'})</div>
          <div class="analog-after">그때는: ${cfg.moveWord} ${pct(d.movePct)} (${cfg.startWord} 후 ${daysBetween(d.start.date, d.extreme.date)}일째 ${cfg.extremeWord}) · ${endText(series, t.ev, d, cfg)}</div>
        </div>`;
    });
    html += '</div><div class="tg-hint" style="margin:8px 0 0">카드를 누르면 그 당시 뉴스 요약을 볼 수 있어요</div>';
    if (res.ensemble) {
      const e = res.ensemble;
      html += `<div class="analog-ensemble">상위 ${e.n}개 유사 사례에서 "같은 시점" 이후 ${e.h}거래일 지수 변화: 중앙값 <b>${pct(e.med)}</b> (범위 ${pct(e.min)} ~ ${pct(e.max)}). 단일 1위 사례보다 이 분포를 참고해 주세요.</div>`;
    }
    const w = res.w;
    html += `<div class="tg-hint" style="margin:10px 0 0">적용 가중치: 형태 ${(w.shape * 100).toFixed(0)}% · 수준 ${(w.level * 100).toFixed(0)}% · 변동성 ${(w.vol * 100).toFixed(0)}% · 진입 흐름 ${(w.run * 100).toFixed(0)}% (상단 "유사도 기준 설정"에서 조절할 수 있어요). "무작위 구간 대비 백분위"는 같은 길이의 임의 구간 ${res.nullN}개보다 점수가 높은 비율이고, 95 이상일 때만 우연 이상의 유사성으로 봐요. 과거 유사 사례는 참고용이고 앞으로의 흐름을 보장하지 않아요.</div>`;
    box.innerHTML = html;
  }

  // ---- wiring ---------------------------------------------------------------
  function setup(base) {
    const ids = base.ids;
    const btn = document.getElementById(ids.btn), status = document.getElementById(ids.status);
    const list = document.getElementById(ids.list), box = document.getElementById(ids.analog);
    const triggerInput = document.getElementById(ids.trigger), endInput = document.getElementById(ids.end);
    const title = document.getElementById(ids.title);
    let running = false;
    let lastRes = null, lastCfg = null;
    Object.keys(DEFAULT_W).forEach((k) => {
      const el = document.getElementById('w-' + k);
      if (el) el.addEventListener('input', () => { if (lastRes) renderAnalogs(lastRes.series, scoreAll(lastRes, getWeights()), lastCfg, box); });
    });
    btn.addEventListener('click', async () => {
      if (running) return;
      const trig = Math.abs(parseFloat(triggerInput.value)) || Math.abs(base.triggerPct);
      const endPct = Math.abs(parseFloat(endInput.value)) || base.endPct;
      const cfg = { ...base, triggerPct: base.direction === 'up' ? trig : -trig, endPct };
      triggerInput.value = trig; endInput.value = endPct;
      title.textContent = `${base.title} (${cfg.startWord} 대비 ${cfg.direction === 'up' ? '+' : '−'}${trig}% 이상)`;
      running = true; btn.disabled = true;
      status.textContent = '전체 히스토리 불러오는 중... (1971년~현재)';
      list.innerHTML = ''; box.innerHTML = '';
      try {
        const series = await fetchFullHistory();
        const events = findEpisodes(series, cfg);
        const described = events.map((ev) => describe(series, ev, cfg));
        status.textContent = `총 ${events.length}건 · 사건명 식별 ${described.filter((d) => d.isKnown).length}건`;
        lastRes = findAnalogs(series, events, described, cfg); lastCfg = cfg;
        renderAnalogs(series, scoreAll(lastRes, getWeights()), cfg, box);
        events.map((_, i) => i)
          .sort((a, b) => series[events[b].startIndex].date.localeCompare(series[events[a].startIndex].date))
          .forEach((i) => list.appendChild(renderEvent(series, events[i], described[i], cfg)));
      } catch (e) {
        status.textContent = `오류: ${e.message}`;
      } finally { running = false; btn.disabled = false; }
    });
  }

  // Headless run of both analyzers (default thresholds/weights) -> compact text for the
  // AI trading-scenario prompt. Uses the same cached history as the UI buttons.
  const CONFIGS = [];
  window.buildAnalogSummaryText = async function buildAnalogSummaryText() {
    const series = await fetchFullHistory();
    const out = [];
    CONFIGS.forEach((cfg) => {
      const events = findEpisodes(series, cfg);
      const described = events.map((ev) => describe(series, ev, cfg));
      const res = scoreAll(findAnalogs(series, events, described, cfg), { shape: 0.4, level: 0.3, vol: 0.15, run: 0.15 });
      const refPt = series[res.ref];
      out.push(`[나스닥 ${cfg.direction === 'up' ? '상승' : '조정'} 관점] 최근 ${cfg.startWord} ${refPt.date} (${refPt.value.toFixed(0)}) 대비 현재 ${pct(res.curMove)}, ${cfg.startWord} 이후 ${res.n}거래일, 20일 변동성 ${res.curVol?.toFixed(0) ?? '-'}%`);
      res.top.slice(0, 5).forEach((t, i) => {
        const d = t.d;
        out.push(`  ${i + 1}. ${d.name} (${d.start.date} ${cfg.startWord}) 유사도 ${(t.score * 100).toFixed(0)}점, 무작위 대비 백분위 ${t.nullPct?.toFixed(0) ?? '-'} · 그때 이후: ${cfg.moveWord} ${pct(d.movePct)} (${daysBetween(d.start.date, d.extreme.date)}일째 ${cfg.extremeWord}), ${endText(series, t.ev, d, cfg)}`);
      });
      if (res.ensemble) out.push(`  상위 ${res.ensemble.n}개 앙상블: 같은 시점 이후 ${res.ensemble.h}거래일 변화 중앙값 ${pct(res.ensemble.med)} (범위 ${pct(res.ensemble.min)} ~ ${pct(res.ensemble.max)})`);
    });
    return out.join('\n');
  };

  // Documented episodes. Unmatched ones are labeled by size only - no guessed causes.
  const KNOWN_DRAWDOWNS = [
    { name: '1973–1974년 오일쇼크·스태그플레이션 약세장', start: '1973-01-11', end: '1974-10-03' },
    { name: '1978년 10월 달러 위기·긴축발 급락', start: '1978-09-13', end: '1978-11-14' },
    { name: '1980년 볼커 신용통제·은 투기 붕괴', start: '1980-02-08', end: '1980-03-27' },
    { name: '1981–1982년 볼커 긴축발 경기침체', start: '1981-05-29', end: '1982-08-12' },
    { name: '1983–1984년 1차 기술주(PC·반도체) 거품 붕괴', start: '1983-06-24', end: '1984-07-24' },
    { name: '1986년 9월 프로그램 매매발 급락', start: '1986-07-03', end: '1986-09-29' },
    { name: '1987년 블랙먼데이', start: '1987-08-25', end: '1987-10-28' },
    { name: '1989년 UAL 인수 무산 미니크래시 → 1990년 걸프전·S&L 위기', start: '1989-10-09', end: '1990-10-16' },
    { name: '1992년 바이오테크 거품 붕괴', start: '1992-02-12', end: '1992-06-26' },
    { name: '1994년 Fed 긴축발 채권시장 발작', start: '1994-03-18', end: '1994-06-24' },
    { name: '1996년 여름 기술주 조정', start: '1996-06-05', end: '1996-07-24' },
    { name: '1997년 아시아 외환위기', start: '1997-10-09', end: '1997-10-28' },
    { name: '1998년 러시아 모라토리엄·LTCM 사태', start: '1998-07-20', end: '1998-10-08' },
    { name: '2000–2002년 닷컴버블 붕괴', start: '2000-03-10', end: '2002-10-09' },
    { name: '2004년 금리 인상 전환·유가 상승 조정', start: '2004-01-26', end: '2004-08-12' },
    { name: '2007–2009년 글로벌 금융위기', start: '2007-10-31', end: '2009-03-09' },
    { name: '2010년 유럽 재정위기·플래시 크래시', start: '2010-04-23', end: '2010-07-02' },
    { name: '2011년 미국 신용등급 강등·유럽 부채위기 확산', start: '2011-04-29', end: '2011-10-03' },
    { name: '2012년 유럽 부채위기 재점화(그리스·스페인)', start: '2012-03-26', end: '2012-06-01' },
    { name: '2015–2016년 중국 경기둔화·유가 급락', start: '2015-07-20', end: '2016-02-11' },
    { name: '2018년 4분기 Fed 긴축·미중 무역전쟁 급락', start: '2018-08-29', end: '2018-12-24' },
    { name: '2020년 코로나19 팬데믹 쇼크', start: '2020-02-19', end: '2020-03-23' },
    { name: '2020년 9월 대형 기술주 과열 조정', start: '2020-09-02', end: '2020-09-23' },
    { name: '2021년 초 국채금리 급등발 성장주 조정', start: '2021-02-12', end: '2021-03-08' },
    { name: '2021–2022년 Fed 긴축발 약세장', start: '2021-11-19', end: '2022-12-28' },
    { name: '2023년 국채금리 5% 급등 조정', start: '2023-07-19', end: '2023-10-26' },
    { name: '2024년 8월 엔캐리 청산·AI 랠리 되돌림', start: '2024-07-10', end: '2024-08-07' },
    { name: '2025년 상호관세 쇼크 급락', start: '2024-12-16', end: '2025-04-08' },
  ];
  const KNOWN_RALLIES = [
    { name: '1974–1980년 오일쇼크 이후 회복 랠리', start: '1974-10-03', end: '1980-02-08' },
    { name: '1982–1983년 볼커 긴축 종료·PC 붐 랠리', start: '1982-08-12', end: '1983-06-24' },
    { name: '1984–1987년 레이건 호황기 강세장', start: '1984-07-24', end: '1987-08-25' },
    { name: '1987년 블랙먼데이 이후 회복 랠리', start: '1987-10-28', end: '1989-10-09' },
    { name: '1990–1992년 걸프전 종전·금리 인하 랠리', start: '1990-10-16', end: '1992-02-12' },
    { name: '1992–1994년 경기 회복 랠리', start: '1992-06-26', end: '1994-03-18' },
    { name: '1994–1996년 인터넷 초기 강세장', start: '1994-06-24', end: '1996-06-05' },
    { name: '1996–1998년 IT 강세장', start: '1996-07-24', end: '1998-07-20' },
    { name: '1998–2000년 닷컴버블 랠리', start: '1998-10-08', end: '2000-03-10' },
    { name: '2002–2004년 닷컴 붕괴 이후 회복 랠리', start: '2002-10-09', end: '2004-01-26' },
    { name: '2004–2007년 주택 호황기 강세장', start: '2004-08-12', end: '2007-10-31' },
    { name: '2009–2010년 금융위기 이후 반등 랠리', start: '2009-03-09', end: '2010-04-23' },
    { name: '2010–2011년 QE2 랠리', start: '2010-07-02', end: '2011-04-29' },
    { name: '2011–2012년 유럽 위기 완화 랠리', start: '2011-10-03', end: '2012-03-26' },
    { name: '2012–2015년 QE3·모바일 강세장', start: '2012-06-01', end: '2015-07-20' },
    { name: '2016–2018년 감세·FAANG 강세장', start: '2016-02-11', end: '2018-08-29' },
    { name: '2018–2020년 Fed 완화 전환 랠리', start: '2018-12-24', end: '2020-02-19' },
    { name: '2020년 코로나 이후 유동성 랠리', start: '2020-03-23', end: '2020-09-02' },
    { name: '2020–2021년 백신·부양책 강세장', start: '2020-09-23', end: '2021-02-12' },
    { name: '2021년 리오프닝·성장주 랠리', start: '2021-03-08', end: '2021-11-19' },
    { name: '2022–2023년 AI 붐 랠리(챗GPT)', start: '2022-12-28', end: '2023-07-19' },
    { name: '2023–2024년 AI·금리 인하 기대 랠리', start: '2023-10-26', end: '2024-07-10' },
    { name: '2024년 하반기 대선·금리 인하 랠리', start: '2024-08-07', end: '2024-12-16' },
    { name: '2025년 관세 유예 이후 V자 반등 랠리', start: '2025-04-08', end: '2025-10-29' },
  ];

  const DOWN_CFG = {
    direction: 'down', triggerPct: -10, endPct: 20, known: KNOWN_DRAWDOWNS,
    startWord: '고점', extremeWord: '저점', moveWord: '고점 대비 최대 낙폭',
    severity: (m) => (m <= -30 ? '대형 약세장' : m <= -20 ? '약세장' : '단기 조정'),
    title: '나스닥 조정 이벤트',
    ids: { btn: 'drawdown-btn', status: 'drawdown-status', list: 'drawdown-list', analog: 'drawdown-analog', trigger: 'drawdown-trigger', end: 'drawdown-end', title: 'drawdown-title' },
  };
  const UP_CFG = {
    direction: 'up', triggerPct: 20, endPct: 10, known: KNOWN_RALLIES,
    startWord: '저점', extremeWord: '고점', moveWord: '저점 대비 최대 상승폭',
    severity: (m) => (m >= 100 ? '대형 강세장' : m >= 50 ? '강세장' : '단기 랠리'),
    title: '나스닥 상승장 이벤트',
    ids: { btn: 'rally-btn', status: 'rally-status', list: 'rally-list', analog: 'rally-analog', trigger: 'rally-trigger', end: 'rally-end', title: 'rally-title' },
  };
  CONFIGS.push(DOWN_CFG, UP_CFG);
  setup(DOWN_CFG);
  setup(UP_CFG);
})();
