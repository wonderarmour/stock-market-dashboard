const FX_PAIRS = [
  { code: 'KRW', label: '원/달러 환율' },
  { code: 'JPY', label: '엔/달러 환율' },
];

// hidden: fetched into marketData (the AI trading-scenario prompt needs it) but no card.
const STOCKS = [
  { symbol: '^VIX', label: 'VIX 변동성 지수', section: 'us' },
  { symbol: '^IXIC', label: '나스닥 종합', section: 'us' },
  { symbol: '^GSPC', label: 'S&P 500', section: 'us' },
  { symbol: '^DJI', label: '다우존스', section: 'us' },
  { symbol: '^SOX', label: '필라델피아 반도체', section: 'us' },
  { symbol: '^KS11', label: '코스피', section: 'kr' },
  { symbol: '^KQ11', label: '코스닥', section: 'kr' },
  { symbol: '005930.KS', label: '삼성전자', hidden: true },
];

const SECTIONS = [
  { key: 'fx', title: '환율' },
  { key: 'us', title: '해외 지수' },
  { key: 'kr', title: '국내 지수' },
];

const RANGE_OPTIONS = [
  { key: '1mo', label: '1개월', days: 30 },
  { key: '3mo', label: '3개월', days: 90 },
  { key: '6mo', label: '6개월', days: 180 },
  { key: '1y', label: '1년', days: 365 },
  { key: '2y', label: '2년', days: 730 },
  { key: '5y', label: '5년', days: 1825 },
  { key: '10y', label: '10년', days: 3650 },
  { key: '20y', label: '20년', days: 7300 },
  { key: '30y', label: '30년', days: 10950 },
];
// Yahoo's `range` enum only goes up to 10y; beyond that we request an
// explicit period1/period2 window (and switch to weekly candles to keep
// payload size reasonable over multi-decade spans).
const YAHOO_RANGE_ENUM_MAX_DAYS = 3650;
const DEFAULT_RANGE = '3mo';

// populated on each load; used by chat.js to build the trading-scenario prompt
window.marketData = {};
window.currentRangeLabel = RANGE_OPTIONS.find((r) => r.key === DEFAULT_RANGE).label;

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function numberFmt(v, code) {
  if (code === 'JPY' || code === 'KRW') return v.toFixed(2);
  if (['^SOX', '^VIX', '^IXIC', '^GSPC', '^DJI', '^KS11', '^KQ11'].includes(code)) return v.toFixed(2);
  if (code === '005930.KS') return v.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 1000) return v.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

async function fetchFxData(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const symbols = FX_PAIRS.map((p) => p.code).join(',');
  const url = `https://api.frankfurter.dev/v1/${fmtDate(start)}..${fmtDate(end)}?base=USD&symbols=${symbols}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Frankfurter API 오류: ' + res.status);
  const data = await res.json();
  const dates = Object.keys(data.rates).sort();
  const series = {};
  FX_PAIRS.forEach((p) => {
    series[p.code] = dates.map((d) => ({ date: d, value: data.rates[d][p.code] })).filter((pt) => pt.value != null);
  });
  return series;
}

async function fetchStockData(symbol, rangeOption) {
  let query;
  if (rangeOption.days > YAHOO_RANGE_ENUM_MAX_DAYS) {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - rangeOption.days * 86400;
    query = `period1=${period1}&period2=${period2}&interval=1wk`;
  } else {
    query = `range=${rangeOption.key}&interval=1d`;
  }
  const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&${query}`);
  if (!res.ok) throw new Error('시세 조회 오류: ' + res.status);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    const errMsg = data?.chart?.error?.description || '데이터 없음';
    throw new Error(errMsg);
  }
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const volumes = result.indicators?.quote?.[0]?.volume || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      points.push({ date: fmtDate(new Date(timestamps[i] * 1000)), value: closes[i], volume: volumes[i] || 0 });
    }
  }
  return points;
}

function buildCard(labelText, code) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="label">${labelText}</div>
    <div class="sub">${code}</div>
    <div class="loading">불러오는 중...</div>
  `;
  return card;
}

// Volume-weighted average price over the window when volume exists (stocks,
// KOSPI/KOSDAQ, most indices); plain average otherwise (FX, VIX).
function windowAverage(series) {
  const totalVol = series.reduce((a, p) => a + (p.volume || 0), 0);
  if (totalVol > 0) {
    return { label: '거래량가중평균(VWAP)', value: series.reduce((a, p) => a + p.value * (p.volume || 0), 0) / totalVol };
  }
  return { label: '단순평균', value: series.reduce((a, p) => a + p.value, 0) / series.length };
}

function renderCardContent(card, labelText, series, code, subText = code, rangeLabel = window.currentRangeLabel) {
  if (!series || series.length === 0) {
    card.innerHTML = `<div class="label">${labelText}</div><div class="sub">${subText}</div><div class="error">데이터를 불러오지 못했어요</div>`;
    return;
  }
  const last = series[series.length - 1];
  const first = series[0];
  const prev = series.length > 1 ? series[series.length - 2] : last;
  const fmtDelta = (from) => {
    const change = last.value - from.value;
    const pct = (change / from.value) * 100;
    const sign = change >= 0 ? '+' : '-';
    return { up: change >= 0, text: `${sign}${Math.abs(change).toFixed(2)} (${sign}${Math.abs(pct).toFixed(2)}%)` };
  };
  const period = fmtDelta(first);
  const daily = fmtDelta(prev);
  const avg = windowAverage(series);
  const vsAvg = fmtDelta({ value: avg.value });

  card.classList.toggle('trend-up', period.up);
  card.classList.toggle('trend-down', !period.up);
  card.innerHTML = `
    <div class="label">${labelText}</div>
    <div class="sub">${subText}</div>
    <div class="stat-row">
      <div class="value">${numberFmt(last.value, code)}</div>
      <div class="delta ${period.up ? 'up' : 'down'}">${period.text}</div>
    </div>
    <div class="asof">${rangeLabel} 전(${first.date}) 대비 · 전일 대비 <span class="${daily.up ? 'up' : 'down'}">${daily.text}</span> · ${last.date} 기준</div>
    <div class="asof">${rangeLabel} ${avg.label} ${numberFmt(avg.value, code)} 대비 <span class="${vsAvg.up ? 'up' : 'down'}">${vsAvg.text}</span></div>
    <div class="chart-box"></div>
  `;
  const box = card.querySelector('.chart-box');
  renderChart(box, series, code);
}

function renderChart(container, series, code) {
  const width = 400;
  const height = 120;
  const padTop = 8;
  const padBottom = 8;
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const xScale = (i) => (i / (series.length - 1)) * width;
  const yScale = (v) => height - padBottom - ((v - min) / range) * (height - padTop - padBottom);

  let linePath = '';
  let areaPath = '';
  series.forEach((p, i) => {
    const x = xScale(i);
    const y = yScale(p.value);
    linePath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
    areaPath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
  });
  areaPath += `L${width},${height} L0,${height} Z`;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('class', 'baseline');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('x2', String(width));
  baseline.setAttribute('y1', String(height - padBottom));
  baseline.setAttribute('y2', String(height - padBottom));
  svg.appendChild(baseline);

  const area = document.createElementNS(svgNS, 'path');
  area.setAttribute('class', 'area');
  area.setAttribute('d', areaPath);
  svg.appendChild(area);

  const line = document.createElementNS(svgNS, 'path');
  line.setAttribute('class', 'line');
  line.setAttribute('d', linePath);
  svg.appendChild(line);

  const hoverLine = document.createElementNS(svgNS, 'line');
  hoverLine.setAttribute('class', 'hover-line');
  hoverLine.setAttribute('y1', '0');
  hoverLine.setAttribute('y2', String(height));
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(svgNS, 'circle');
  hoverDot.setAttribute('class', 'hover-dot');
  hoverDot.setAttribute('r', '4');
  svg.appendChild(hoverDot);

  container.style.position = 'relative';
  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  container.appendChild(tooltip);

  const overlay = document.createElementNS(svgNS, 'rect');
  overlay.setAttribute('x', '0');
  overlay.setAttribute('y', '0');
  overlay.setAttribute('width', String(width));
  overlay.setAttribute('height', String(height));
  overlay.setAttribute('fill', 'transparent');
  svg.appendChild(overlay);

  function handleMove(evt) {
    const rect = svg.getBoundingClientRect();
    const relX = evt.clientX - rect.left;
    const ratio = Math.min(Math.max(relX / rect.width, 0), 1);
    const idx = Math.round(ratio * (series.length - 1));
    const pt = series[idx];
    const x = xScale(idx);
    const y = yScale(pt.value);

    hoverLine.setAttribute('x1', String(x));
    hoverLine.setAttribute('x2', String(x));
    hoverLine.style.opacity = '1';
    hoverDot.setAttribute('cx', String(x));
    hoverDot.setAttribute('cy', String(y));
    hoverDot.style.opacity = '1';

    tooltip.style.opacity = '1';
    tooltip.style.left = `${(x / width) * 100}%`;
    tooltip.style.top = `${(y / height) * 100}%`;
    tooltip.textContent = `${pt.date}: ${numberFmt(pt.value, code)}`;
  }

  function handleLeave() {
    hoverLine.style.opacity = '0';
    hoverDot.style.opacity = '0';
    tooltip.style.opacity = '0';
  }

  overlay.addEventListener('mousemove', handleMove);
  overlay.addEventListener('mouseleave', handleLeave);
}

function buildRangeSelector(onChange) {
  const container = document.getElementById('range-selector');
  container.innerHTML = '';
  RANGE_OPTIONS.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'range-btn' + (opt.key === DEFAULT_RANGE ? ' active' : '');
    btn.textContent = opt.label;
    btn.dataset.key = opt.key;
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      container.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(opt);
    });
    container.appendChild(btn);
  });
}

async function loadAll(rangeOption) {
  const sectionsEl = document.getElementById('sections');
  const subtitle = document.getElementById('subtitle');
  sectionsEl.innerHTML = '';
  window.marketData = {};
  window.currentRangeLabel = rangeOption.label;
  const cards = {};

  const grids = {};
  SECTIONS.forEach((sec) => {
    const wrap = document.createElement('section');
    wrap.className = 'section';
    wrap.innerHTML = `<h2 class="section-title">${sec.title}</h2><div class="grid"></div>`;
    sectionsEl.appendChild(wrap);
    grids[sec.key] = wrap.querySelector('.grid');
  });

  FX_PAIRS.forEach((p) => {
    const card = buildCard(p.label, `USD/${p.code}`);
    grids.fx.appendChild(card);
    cards[p.code] = card;
  });
  STOCKS.forEach((s) => {
    if (s.hidden) return;
    const card = buildCard(s.label, s.symbol);
    grids[s.section].appendChild(card);
    cards[s.symbol] = card;
  });

  subtitle.textContent = `최근 ${rangeOption.label} 추이 · 불러오는 중...`;

  try {
    const fxData = await fetchFxData(rangeOption.days);
    FX_PAIRS.forEach((p) => {
      renderCardContent(cards[p.code], p.label, fxData[p.code], p.code, `USD/${p.code}`);
      window.marketData[p.code] = { label: p.label, series: fxData[p.code] };
    });
  } catch (e) {
    FX_PAIRS.forEach((p) => {
      cards[p.code].innerHTML = `<div class="label">${p.label}</div><div class="error">${e.message}</div>`;
    });
  }

  for (const s of STOCKS) {
    try {
      const points = await fetchStockData(s.symbol, rangeOption);
      if (cards[s.symbol]) renderCardContent(cards[s.symbol], s.label, points, s.symbol);
      window.marketData[s.symbol] = { label: s.label, series: points };
    } catch (e) {
      if (cards[s.symbol]) cards[s.symbol].innerHTML = `<div class="label">${s.label}</div><div class="error">${e.message}</div>`;
    }
  }

  subtitle.textContent = `최근 ${rangeOption.label} 추이 · 마지막 갱신: ${new Date().toLocaleString('ko-KR')}`;
  document.dispatchEvent(new CustomEvent('market-data-ready'));
}

// Builds a compact text summary (latest value, 1d/5d/range change, range high/low)
// of every loaded series, used as the data context for the AI trading-scenario prompt.
window.buildMarketSummaryText = function buildMarketSummaryText() {
  const lines = [];
  const rangeLabel = window.currentRangeLabel || '선택된 기간';
  Object.values(window.marketData).forEach(({ label, series }) => {
    if (!series || series.length === 0) {
      lines.push(`- ${label}: 데이터 없음`);
      return;
    }
    const n = series.length;
    const last = series[n - 1];
    const prev1 = series[Math.max(0, n - 2)];
    const prev5 = series[Math.max(0, n - 6)];
    const first = series[0];
    const values = series.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const chg1 = last.value - prev1.value;
    const chg5 = last.value - prev5.value;
    const chgRange = last.value - first.value;
    const pct = (chg, base) => ((chg / base) * 100).toFixed(2);
    lines.push(
      `- ${label}: 현재 ${last.value.toFixed(2)} (${last.date}) | ` +
        `1일 ${chg1 >= 0 ? '+' : ''}${chg1.toFixed(2)} (${pct(chg1, prev1.value)}%) | ` +
        `5일 ${chg5 >= 0 ? '+' : ''}${chg5.toFixed(2)} (${pct(chg5, prev5.value)}%) | ` +
        `${rangeLabel} ${chgRange >= 0 ? '+' : ''}${chgRange.toFixed(2)} (${pct(chgRange, first.value)}%) | ` +
        `${rangeLabel} 범위 ${min.toFixed(2)} ~ ${max.toFixed(2)} | ` +
        (() => { const a = windowAverage(series); return `${rangeLabel} ${a.label} ${a.value.toFixed(2)} 대비 ${pct(last.value - a.value, a.value)}%`; })()
    );
  });
  return lines.join('\n');
};

buildRangeSelector((opt) => loadAll(opt));
loadAll(RANGE_OPTIONS.find((r) => r.key === DEFAULT_RANGE));
