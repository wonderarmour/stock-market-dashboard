const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  // .env is optional
}

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = 'gpt-5.6-luna';
// Public base URL when deployed behind HTTPS (e.g. https://34-1-2-3.sslip.io);
// drives the Kakao redirect URI and the Secure cookie flag.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const BASE_URL = PUBLIC_URL || `http://localhost:${PORT}`;

// ---- password gate (single user). Off when APP_PASSWORD is unset (local use). ----
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || APP_PASSWORD;
const sessionToken = () => crypto.createHmac('sha256', SESSION_SECRET).update('dashboard-session-v1').digest('hex');
const loginFailures = new Map(); // ip -> { count, until }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const c = parseCookies(req).sid || '';
  const t = sessionToken();
  return c.length === t.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(t));
}
function loginPage(error = '') {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>로그인</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
<body style="margin:0;background:#fff;font-family:'Pretendard Variable',Pretendard,system-ui,sans-serif;color:oklch(0.234 0.03 254)">
<form method="post" action="/login" style="max-width:360px;margin:18vh auto;padding:0 24px">
<h1 style="font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px">마켓 대시보드</h1>
<p style="margin:0 0 20px;color:oklch(0.155 0.06 261/.58);font-size:14px">비밀번호를 입력해 주세요</p>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="비밀번호" style="width:100%;box-sizing:border-box;height:48px;border:1px solid oklch(0.913 0.008 247);border-radius:12px;background:oklch(0.957 0.005 247);padding:0 12px;font:inherit;font-size:15px;outline:none">
${error ? `<p style="color:oklch(0.628 0.218 22);font-size:13px;margin:8px 0 0">${error}</p>` : ''}
<button style="width:100%;height:48px;margin-top:14px;border:none;border-radius:999px;background:oklch(0.624 0.176 254);color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer">들어가기</button>
</form></body></html>`;
}

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error('Failed to parse JSON: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function postJSON(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(url, options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          reject(new Error('Failed to parse JSON: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const NEWS_FEEDS = [
  { source: '한국경제', category: '경제', region: 'kr', url: 'https://www.hankyung.com/feed/economy' },
  { source: '한국경제', category: '증권', region: 'kr', url: 'https://www.hankyung.com/feed/finance' },
  { source: '연합뉴스', category: '경제', region: 'kr', url: 'https://www.yna.co.kr/rss/economy.xml' },
  { source: 'CNBC', category: 'Top News', region: 'global', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { source: 'CNBC', category: 'Finance', region: 'global', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { source: 'MarketWatch', category: 'Top Stories', region: 'global', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'WSJ', category: 'Markets', region: 'global', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
];
const NEWS_PER_FEED = 12;
const TELEGRAM_CHANNELS = (process.env.TELEGRAM_CHANNELS || 'wowtv_official,FastStockNews').split(',').map((s) => s.trim()).filter(Boolean);

const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = producer().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

function stripCdata(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}
function stripHtml(s = '') {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return m ? stripCdata(m[1]) : '';
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const img =
      (b.match(/<media:content[^>]*url="([^"]+)"/) || [])[1] ||
      (b.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] ||
      (b.match(/<img[^>]*src="([^"]+)"/) || [])[1] ||
      '';
    items.push({
      title: stripHtml(tag(b, 'title')),
      link: stripHtml(tag(b, 'link')),
      pubDate: tag(b, 'pubDate'),
      description: stripHtml(tag(b, 'description')).slice(0, 200),
      image: img,
    });
  }
  return items;
}

const ogCache = new Map();
async function ogImage(link) {
  if (ogCache.has(link)) return ogCache.get(link);
  const p = fetchText(link)
    .then(({ body }) => (body.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/) || body.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/) || [])[1] || '')
    .catch(() => '');
  ogCache.set(link, p);
  return p;
}

async function loadNews() {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const { body } = await fetchText(feed.url);
      const items = parseRss(body).slice(0, NEWS_PER_FEED);
      await Promise.all(items.filter((it) => !it.image && it.link).map(async (it) => { it.image = await ogImage(it.link); }));
      return items.map((it) => ({ ...it, source: feed.source, category: feed.category, region: feed.region }));
    })
  );
  const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { fetchedAt: new Date().toISOString(), items: all };
}

// 5-bullet Korean digest of everything currently in the news cache.
async function newsBrief() {
  const news = await cached('news', 10 * 60 * 1000, loadNews);
  const lines = news.items.slice(0, 60).map((it) => `- [${it.region === 'kr' ? '국내' : '해외'}/${it.source}] ${it.title}${it.description ? ' — ' + it.description.slice(0, 120) : ''}`);
  const system = '당신은 투자자를 위한 한국어 모닝 브리핑 에디터입니다. 주어진 국내·해외 기사 목록을 읽고, 시장에 실제로 영향이 큰 흐름만 골라 정확히 5개의 꼭지로 개조식 요약을 씁니다. ' +
    '각 꼭지는 "굵은 제목(10자 내외) — 한 문장 설명" 형식의 한 줄(60자 내외), 앞에 "- "를 붙입니다. 국내와 해외를 균형 있게 다루고, 가능하면 지수·환율·금리·반도체 관련 함의를 한 구절로 덧붙입니다. 제목·서론·결론 없이 5개 불릿만 출력합니다.';
  const { status, body } = await postJSON(
    'https://api.openai.com/v1/chat/completions',
    { model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: `기사 목록 (${news.items.length}건 중 최신 ${lines.length}건):\n${lines.join('\n')}` }] },
    { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  );
  if (status >= 400) throw new Error(body.error?.message || 'OpenAI API 오류');
  return { brief: body.choices?.[0]?.message?.content ?? '', basedOn: news.fetchedAt, count: news.items.length, generatedAt: new Date().toISOString() };
}

function parseTelegram(channel, html) {
  const title = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || channel;
  const posts = [];
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const id = (b.match(/data-post="([^"]+)"/) || [])[1] || '';
    const date = (b.match(/<time[^>]*datetime="([^"]+)"/) || [])[1] || '';
    const textM = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const text = textM ? stripHtml(textM[1]).slice(0, 300) : '';
    const photos = [];
    const pr = /tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g;
    let pm;
    while ((pm = pr.exec(b))) photos.push(pm[1]);
    if (photos.length) posts.push({ id, url: id ? `https://t.me/${id}` : '', date, text, photos });
  }
  return { channel, title, posts };
}

async function loadTelegram(channels) {
  const results = await Promise.allSettled(
    channels.map(async (c) => {
      const { status, body } = await fetchText(`https://t.me/s/${encodeURIComponent(c)}`);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return parseTelegram(c, body);
    })
  );
  return {
    fetchedAt: new Date().toISOString(),
    channels: results.map((r, i) => (r.status === 'fulfilled' ? r.value : { channel: channels[i], title: channels[i], posts: [], error: r.reason?.message })),
  };
}

// ---- "news of that era" summary: Wikipedia current-events + article extracts
// as grounding, then an LLM writes a Korean market-focused digest. ----
const WIKI_UA = 'MarketDashboard/1.0 (local dev; contact: none)';
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FIN_RE = /(stock|share price|Nasdaq|Dow Jones|S&P|Wall Street|Federal Reserve|interest rate|central bank|bank|bailout|crisis|recession|inflation|oil price|OPEC|Treasury|bond|GDP|unemployment|earnings|tariff|trade war|default|bankrupt|IMF|currency|dollar|yen|euro|tech|Nvidia|Apple|Microsoft|Intel|chip|semiconductor|AI )/i;

function monthKeys(startDate, endDate, cap = 4) {
  const s = new Date(startDate), e = new Date(endDate);
  const all = [];
  for (let d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1)); d <= e; d.setUTCMonth(d.getUTCMonth() + 1)) {
    all.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  }
  if (all.length <= cap) return all;
  const out = [];
  for (let i = 0; i < cap; i++) out.push(all[Math.round((i * (all.length - 1)) / (cap - 1))]);
  return out;
}

async function wikiMonthFacts({ y, m }) {
  const title = `Portal:Current events/${MONTHS_EN[m]} ${y}`;
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&formatversion=2`;
  try {
    const { body } = await fetchJSON(url, { 'User-Agent': WIKI_UA });
    if (!body?.parse?.text) return null;
    const text = body.parse.text.replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const sentences = (text.match(/[^.]{20,260}\./g) || []).map((s) => s.trim()).filter((s) => FIN_RE.test(s));
    const uniq = [...new Set(sentences)].slice(0, 14);
    return { title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, facts: uniq };
  } catch (e) {
    return null;
  }
}

async function wikiSearchExtracts(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exchars=700&format=json&formatversion=2`;
  try {
    const { body } = await fetchJSON(url, { 'User-Agent': WIKI_UA });
    return (body?.query?.pages || []).filter((p) => p.extract).map((p) => ({
      title: p.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`, extract: p.extract.replace(/\s+/g, ' ').trim(),
    }));
  } catch (e) {
    return [];
  }
}

async function eraNews({ start, extreme, end, label, direction }) {
  const months = monthKeys(start, extreme);
  const monthFacts = (await Promise.all(months.map(wikiMonthFacts))).filter(Boolean).filter((m) => m.facts.length);
  const sy = new Date(start).getUTCFullYear(), sm = MONTHS_EN[new Date(start).getUTCMonth()];
  const articles = await wikiSearchExtracts(`stock market ${sm} ${sy} Nasdaq ${direction === 'up' ? 'rally bull market' : 'crash correction bear market'}`);

  const ctx = [];
  monthFacts.forEach((m) => { ctx.push(`[${m.title}]`); m.facts.forEach((f) => ctx.push(`- ${f}`)); });
  articles.forEach((a) => ctx.push(`[Article: ${a.title}] ${a.extract}`));
  const grounded = ctx.length > 0;

  const system = '당신은 금융시장 역사에 정통한 한국어 뉴스 에디터입니다. 주어진 기간의 나스닥 ' + (direction === 'up' ? '상승장' : '조정/하락장') +
    '을 둘러싼 당시 뉴스와 배경을 투자자 관점에서 요약합니다. 반드시 다음 구조로 씁니다: ' +
    '1) 한 줄 요약  2) 배경(왜 시작됐나)  3) 주요 사건 타임라인(날짜별 5~10개 불릿, 가능하면 월/일 표기)  4) 시장 반응(지수·금리·달러·섹터)  5) 이후 전개와 교훈. ' +
    '제공된 자료(위키백과 발췌)를 우선 근거로 삼고, 자료에 없는 내용을 지식으로 보충할 때는 문장 끝에 (지식) 표시를 붙입니다. 확실하지 않은 날짜·수치는 단정하지 말고 "~경"으로 씁니다. 총 300~600자 내외의 불릿 중심 한국어.';
  const user = `기간: ${start} (${direction === 'up' ? '저점' : '고점'}) → ${extreme} (${direction === 'up' ? '고점' : '저점'})${end ? ` → ${end} (국면 종료)` : ''}\n이벤트명: ${label}\n\n` +
    (grounded ? `참고 자료:\n${ctx.join('\n')}` : '참고 자료 없음(위키백과 기록 없는 시기). 모델 지식으로 작성하되 모든 문단에 (지식) 표시.');

  const { status, body } = await postJSON(
    'https://api.openai.com/v1/chat/completions',
    { model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  );
  if (status >= 400) throw new Error(body.error?.message || 'OpenAI API 오류');
  const summary = body.choices?.[0]?.message?.content ?? '';
  const sources = monthFacts.map((m) => ({ title: m.title, url: m.url })).concat(articles.map((a) => ({ title: a.title, url: a.url })));
  return { summary, sources, grounded, generatedAt: new Date().toISOString() };
}

// ---- portfolio state (single-user JSON file) + rebalancing check/alerts ----
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}
const DEFAULT_RULES = { absBand: 5, relBand: 25, calendarDays: 90, lastRebalancedAt: null };

async function latestPrice(symbol) {
  const { body } = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const r = body?.chart?.result?.[0];
  if (!r) throw new Error(body?.chart?.error?.description || '시세 없음');
  const closes = (r.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const price = r.meta?.regularMarketPrice ?? closes[closes.length - 1];
  const ts = r.meta?.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000).toISOString() : null;
  return { price, currency: r.meta?.currency || '', asOf: ts };
}

// Drift vs. target for every holding; band rule (absolute %p OR relative %)
// plus a calendar "due for review" rule. Trades bring each holding back to target.
async function runRebalanceCheck(state) {
  const holdings = (state.holdings || []).filter((h) => h.symbol && (Number(h.qty) > 0 || Number(h.target) > 0));
  const rules = { ...DEFAULT_RULES, ...(state.rules || {}) };
  if (!holdings.length) return { asOf: new Date().toISOString(), rows: [], triggered: false, reasons: ['보유 종목이 없어요'], trades: [], totalValue: 0, rules };
  const [priced, fx] = await Promise.all([
    Promise.all(holdings.map(async (h) => {
      try { return { ...h, ...(await latestPrice(h.symbol)) }; } catch (e) { return { ...h, price: null, error: e.message }; }
    })),
    latestPrice('KRW=X').then((r) => r.price).catch(() => null), // USD -> KRW
  ]);
  // Values are compared in KRW: USD-priced assets are converted with the live rate.
  const toKRW = (h) => (h.currency === 'KRW' || !fx ? Number(h.qty) * h.price : Number(h.qty) * h.price * (h.currency === 'USD' ? fx : 1));
  const ok = priced.filter((h) => h.price != null);
  const totalValue = ok.reduce((a, h) => a + toKRW(h), 0);
  const targetSum = ok.reduce((a, h) => a + Number(h.target || 0), 0) || 1;
  const rows = priced.map((h) => {
    const value = h.price != null ? Number(h.qty) * h.price : null;
    const valueKRW = h.price != null ? toKRW(h) : null;
    const curPct = valueKRW != null && totalValue ? (valueKRW / totalValue) * 100 : null;
    const target = (Number(h.target || 0) / targetSum) * 100;
    const drift = curPct != null ? curPct - target : null;
    const relDrift = drift != null && target ? (drift / target) * 100 : null;
    const bandHit = drift != null && (Math.abs(drift) >= rules.absBand || (target > 0 && Math.abs(relDrift) >= rules.relBand));
    return { symbol: h.symbol, label: h.label || h.symbol, qty: Number(h.qty), price: h.price, currency: h.currency, value, valueKRW, curPct, target, drift, relDrift, bandHit, error: h.error || null };
  });
  const daysSince = rules.lastRebalancedAt ? Math.floor((Date.now() - new Date(rules.lastRebalancedAt)) / 86400000) : null;
  const calendarDue = rules.calendarDays > 0 && (daysSince == null || daysSince >= rules.calendarDays);
  const bandRows = rows.filter((r) => r.bandHit);
  const reasons = [];
  bandRows.forEach((r) => reasons.push(`${r.label} 비중 ${r.curPct.toFixed(1)}% (목표 ${r.target.toFixed(1)}%, ${r.drift > 0 ? '+' : ''}${r.drift.toFixed(1)}%p / 상대 ${r.relDrift > 0 ? '+' : ''}${r.relDrift.toFixed(0)}%)`));
  if (calendarDue) reasons.push(daysSince == null ? `정기 점검 주기(${rules.calendarDays}일) 기준일이 설정되지 않았어요` : `마지막 리밸런싱 후 ${daysSince}일 경과 (주기 ${rules.calendarDays}일)`);
  const trades = rows.filter((r) => r.value != null).map((r) => {
    const rate = r.valueKRW && r.value ? r.valueKRW / r.value : 1; // KRW per native unit
    const targetValue = ((r.target / 100) * totalValue) / rate;
    const diff = targetValue - r.value;
    const fractional = /-USD$/.test(r.symbol);
    const shares = fractional ? Math.round((diff / r.price) * 10000) / 10000 : Math.trunc(diff / r.price);
    return { symbol: r.symbol, label: r.label, action: diff >= 0 ? 'buy' : 'sell', shares: Math.abs(shares), amount: Math.abs(shares) * r.price, currency: r.currency };
  }).filter((t) => t.shares > 0);
  return { asOf: new Date().toISOString(), rows, totalValue, fxUsdKrw: fx, rules, daysSince, calendarDue, bandTriggered: bandRows.length > 0, triggered: bandRows.length > 0 || calendarDue, reasons, trades };
}

function formatAlert(check) {
  const lines = [`📊 <b>리밸런싱 점검</b> (${check.asOf.slice(0, 10)})`, check.triggered ? '⚠️ 조정이 필요해요' : '✅ 목표 범위 안이에요'];
  check.reasons.forEach((r) => lines.push('• ' + r));
  if (check.trades.length) {
    lines.push('', '<b>목표 비중으로 돌아가려면</b>');
    check.trades.forEach((t) => lines.push(`• ${t.label}: ${t.action === 'buy' ? '매수' : '매도'} ${t.shares}${/-USD$/.test(t.symbol) ? '' : '주'} (≈ ${Math.round(t.amount).toLocaleString('ko-KR')} ${t.currency})`));
  }
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 가 .env 에 없어요');
  const { status, body } = await postJSON(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' });
  if (status >= 400 || !body.ok) throw new Error(body.description || `Telegram HTTP ${status}`);
  return true;
}

// ---- KakaoTalk "나에게 보내기" (Kakao Developers message API, personal use) ----
// One-time browser login stores a refresh token in data/kakao.json; access
// tokens (6h) are refreshed automatically. Text template is capped at 200 chars.
const KAKAO_FILE = path.join(DATA_DIR, 'kakao.json');
const kakaoRedirectUri = () => `${BASE_URL}/auth/kakao/callback`;
function readKakao() { try { return JSON.parse(fs.readFileSync(KAKAO_FILE, 'utf8')); } catch { return null; } }
function writeKakao(tok) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(KAKAO_FILE, JSON.stringify(tok, null, 2), 'utf8'); }
function postForm(url, fields, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString();
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); } catch (e) { reject(new Error('Kakao 응답 파싱 실패: ' + data.slice(0, 120))); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function kakaoExchange(fields) {
  const { status, body } = await postForm('https://kauth.kakao.com/oauth/token', {
    client_id: process.env.KAKAO_REST_KEY, ...(process.env.KAKAO_CLIENT_SECRET ? { client_secret: process.env.KAKAO_CLIENT_SECRET } : {}), ...fields,
  });
  if (status >= 400 || body.error) throw new Error(body.error_description || body.error || `Kakao HTTP ${status}`);
  const prev = readKakao() || {};
  const tok = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || prev.refresh_token,
    expires_at: Date.now() + (body.expires_in || 21600) * 1000,
    refresh_expires_at: body.refresh_token_expires_in ? Date.now() + body.refresh_token_expires_in * 1000 : prev.refresh_expires_at,
    connected_at: prev.connected_at || new Date().toISOString(),
  };
  writeKakao(tok);
  return tok;
}
async function kakaoAccessToken() {
  if (!process.env.KAKAO_REST_KEY) throw new Error('KAKAO_REST_KEY 가 .env 에 없어요');
  const tok = readKakao();
  if (!tok || !tok.refresh_token) throw new Error('카카오가 연결되지 않았어요. 실제 보유 화면에서 "카카오 연결"을 눌러 주세요');
  if (tok.expires_at - Date.now() > 5 * 60 * 1000) return tok.access_token;
  if (tok.refresh_expires_at && tok.refresh_expires_at < Date.now()) throw new Error('카카오 로그인이 만료됐어요. 다시 연결해 주세요');
  return (await kakaoExchange({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).access_token;
}
function kakaoText(check) {
  const head = `[리밸런싱 점검 ${check.asOf.slice(0, 10)}] ${check.triggered ? '조정 필요' : '목표 범위 안'}`;
  const drift = check.rows.filter((r) => r.bandHit).map((r) => `${r.label} ${r.drift > 0 ? '+' : ''}${r.drift.toFixed(1)}%p`).join(', ');
  const trades = check.trades.map((t) => `${t.label} ${t.action === 'buy' ? '매수' : '매도'} ${t.shares}`).join(', ');
  let text = head + (drift ? `\n밴드 초과: ${drift}` : '') + (check.calendarDue ? '\n정기 점검 시점이에요' : '') + (trades ? `\n조정안: ${trades}` : '');
  return text.length > 200 ? text.slice(0, 197) + '…' : text;
}
async function sendKakao(check) {
  const token = await kakaoAccessToken();
  // Kakao only allows link URLs on domains registered in the app console, and
  // localhost can't be registered — so the button points at a configurable public URL.
  const linkUrl = process.env.KAKAO_LINK_URL || PUBLIC_URL || 'https://github.com/wonderarmour/stock-market-dashboard';
  const template = { object_type: 'text', text: kakaoText(check), link: { web_url: linkUrl, mobile_web_url: linkUrl }, button_title: '자세히 보기' };
  const { status, body } = await postForm('https://kapi.kakao.com/v2/api/talk/memo/default/send', { template_object: JSON.stringify(template) }, { Authorization: `Bearer ${token}` });
  if (status >= 400 || (body.result_code != null && body.result_code !== 0)) throw new Error(body.msg || body.error_description || `Kakao HTTP ${status} (code ${body.code ?? body.result_code})`);
  return true;
}
function kakaoStatus() {
  const tok = readKakao();
  return { configured: !!process.env.KAKAO_REST_KEY, connected: !!(tok && tok.refresh_token), connectedAt: tok?.connected_at || null, refreshExpiresAt: tok?.refresh_expires_at ? new Date(tok.refresh_expires_at).toISOString() : null, redirectUri: kakaoRedirectUri() };
}

// Daily check at 16:30 KST (after the KRX close); alerts once per day when triggered.
const CHECK_HOUR_KST = 16, CHECK_MIN_KST = 30;
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
async function scheduledCheck() {
  const state = readState();
  const check = await runRebalanceCheck(state);
  state.lastCheck = check;
  const today = kstNow().toISOString().slice(0, 10);
  state.lastScheduledDate = today;
  if (check.triggered && state.lastAlertDate !== today) {
    const errors = [];
    let sent = false;
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try { await sendTelegram(formatAlert(check)); sent = true; } catch (e) { errors.push('텔레그램: ' + e.message); }
    }
    if (kakaoStatus().connected) {
      try { await sendKakao(check); sent = true; } catch (e) { errors.push('카카오: ' + e.message); }
    }
    if (sent) state.lastAlertDate = today;
    state.lastAlertError = errors.length ? errors.join(' / ') : null;
  }
  writeState(state);
  return check;
}
setInterval(() => {
  const now = kstNow();
  if (now.getUTCHours() !== CHECK_HOUR_KST || now.getUTCMinutes() !== CHECK_MIN_KST) return;
  if (readState().lastScheduledDate === now.toISOString().slice(0, 10)) return;
  scheduledCheck().catch((e) => console.error('scheduled check failed', e.message));
}, 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- auth gate ----
  if (APP_PASSWORD) {
    const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        const f = loginFailures.get(ip);
        if (f && f.until > Date.now()) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(loginPage('잠시 후 다시 시도해 주세요')); return; }
        const body = new URLSearchParams(await readBody(req));
        const pw = body.get('password') || '';
        const ok = pw.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
        if (!ok) {
          const n = (f?.count || 0) + 1;
          loginFailures.set(ip, { count: n, until: n >= 5 ? Date.now() + 60 * 1000 : 0 });
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(loginPage('비밀번호가 맞지 않아요')); return;
        }
        loginFailures.delete(ip);
        res.writeHead(302, { 'Set-Cookie': `sid=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`, Location: '/' }); res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(loginPage()); return;
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': `sid=; Path=/; HttpOnly; Max-Age=0${secure}`, Location: '/login' }); res.end(); return;
    }
    if (url.pathname !== '/auth/kakao/callback' && !isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '로그인이 필요해요' })); return; }
      res.writeHead(302, { Location: '/login' }); res.end(); return;
    }
  }

  if (url.pathname === '/api/quote') {
    const symbol = url.searchParams.get('symbol');
    const interval = url.searchParams.get('interval') || '1d';
    const period1 = url.searchParams.get('period1');
    const period2 = url.searchParams.get('period2');
    if (!symbol) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'symbol required' }));
      return;
    }
    try {
      // Yahoo's `range` enum tops out at 10y; period1/period2 (unix seconds)
      // let us request arbitrary windows (e.g. 20y/30y) beyond that.
      const rangeParam = period1 && period2 ? `period1=${period1}&period2=${period2}` : `range=${url.searchParams.get('range') || '3mo'}`;
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${rangeParam}&interval=${interval}`;
      const { status, body } = await fetchJSON(yahooUrl);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/api/portfolio' && req.method === 'GET') { json(200, readState()); return; }
  if (url.pathname === '/api/portfolio' && req.method === 'PUT') {
    try {
      const patch = JSON.parse((await readBody(req)) || '{}');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('객체가 필요해요');
      const state = readState();
      delete patch.lastCheck; delete patch.lastScheduledDate; delete patch.lastAlertDate; delete patch.lastAlertError;
      Object.assign(state, patch);
      writeState(state);
      json(200, state);
    } catch (e) { json(400, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/rebalance-check') {
    try {
      const state = readState();
      const fresh = state.lastCheck && Date.now() - new Date(state.lastCheck.asOf) < 60 * 60 * 1000;
      if (url.searchParams.get('refresh') === '1' || !fresh) {
        state.lastCheck = await runRebalanceCheck(state);
        writeState(state);
      }
      json(200, { ...state.lastCheck, telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), kakao: kakaoStatus(), lastAlertDate: state.lastAlertDate || null, lastAlertError: state.lastAlertError || null, schedule: `매일 ${CHECK_HOUR_KST}:${String(CHECK_MIN_KST).padStart(2, '0')} KST` });
    } catch (e) { json(502, { error: e.message }); }
    return;
  }
  if (url.pathname === '/api/rebalance-notify' && req.method === 'POST') {
    const channel = url.searchParams.get('channel') || 'telegram';
    try {
      const state = readState();
      const check = state.lastCheck || (await runRebalanceCheck(state));
      if (channel === 'kakao') await sendKakao(check); else await sendTelegram(formatAlert(check));
      state.lastAlertDate = kstNow().toISOString().slice(0, 10); state.lastAlertError = null; writeState(state);
      json(200, { ok: true, channel });
    } catch (e) { json(502, { error: e.message }); }
    return;
  }

  // Kakao OAuth: /auth/kakao -> Kakao login -> /auth/kakao/callback stores tokens.
  if (url.pathname === '/auth/kakao') {
    if (!process.env.KAKAO_REST_KEY) { json(500, { error: 'KAKAO_REST_KEY 가 .env 에 없어요' }); return; }
    const q = new URLSearchParams({ client_id: process.env.KAKAO_REST_KEY, redirect_uri: kakaoRedirectUri(), response_type: 'code', scope: 'talk_message' });
    res.writeHead(302, { Location: `https://kauth.kakao.com/oauth/authorize?${q}` }); res.end();
    return;
  }
  if (url.pathname === '/auth/kakao/callback') {
    const page = (title, body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:Pretendard,system-ui,sans-serif;padding:40px;max-width:560px"><h2>${title}</h2><p>${body}</p><p><a href="/">대시보드로 돌아가기</a></p></body>`); };
    const err = url.searchParams.get('error');
    if (err) { page('카카오 연결에 실패했어요', `${err}: ${url.searchParams.get('error_description') || ''}`); return; }
    try {
      await kakaoExchange({ grant_type: 'authorization_code', redirect_uri: kakaoRedirectUri(), code: url.searchParams.get('code') || '' });
      page('카카오톡이 연결됐어요', '이제 리밸런싱 알림이 "나와의 채팅"으로 와요. 이 창은 닫아도 돼요.');
    } catch (e) { page('카카오 연결에 실패했어요', e.message); }
    return;
  }
  if (url.pathname === '/api/kakao/status') { json(200, kakaoStatus()); return; }
  if (url.pathname === '/api/kakao/disconnect' && req.method === 'POST') {
    try { fs.unlinkSync(KAKAO_FILE); } catch {}
    json(200, { ok: true });
    return;
  }

  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'q required' }));
      return;
    }
    try {
      const yurl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&lang=ko-KR&region=KR`;
      const { body } = await cached('search:' + q, 60 * 60 * 1000, () => fetchJSON(yurl));
      const quotes = (body.quotes || [])
        .filter((x) => x.symbol && ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND', 'CRYPTOCURRENCY', 'CURRENCY'].includes(x.quoteType))
        .map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, exchange: x.exchDisp || x.exchange || '', type: x.quoteType }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ quotes }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/news') {
    try {
      const data = await cached('news', 10 * 60 * 1000, loadNews);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/news-brief') {
    if (!process.env.OPENAI_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '서버에 OPENAI_API_KEY가 설정되어 있지 않습니다.' }));
      return;
    }
    try {
      const data = await cached('news-brief', 10 * 60 * 1000, newsBrief);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/telegram') {
    const param = url.searchParams.get('channels');
    const channels = param ? param.split(',').map((s) => s.trim().replace(/^@/, '')).filter((s) => /^[A-Za-z0-9_]{3,64}$/.test(s)) : TELEGRAM_CHANNELS;
    try {
      const data = await cached('tg:' + channels.join(','), 5 * 60 * 1000, () => loadTelegram(channels));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/era-news') {
    const q = (k) => url.searchParams.get(k) || '';
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDate(q('start')) || !isDate(q('extreme'))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'start/extreme (YYYY-MM-DD) 필요' }));
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '서버에 OPENAI_API_KEY가 설정되어 있지 않습니다.' }));
      return;
    }
    const params = { start: q('start'), extreme: q('extreme'), end: isDate(q('end')) ? q('end') : '', label: q('label').slice(0, 120), direction: q('direction') === 'up' ? 'up' : 'down' };
    try {
      const data = await cached('era:' + JSON.stringify(params), 24 * 60 * 60 * 1000, () => eraNews(params));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!process.env.OPENAI_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '서버에 OPENAI_API_KEY가 설정되어 있지 않습니다.' }));
      return;
    }
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}');
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages 배열이 필요합니다.' }));
        return;
      }
      const { status, body } = await postJSON(
        'https://api.openai.com/v1/chat/completions',
        { model: OPENAI_MODEL, messages },
        { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
      );
      if (status >= 400) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: body.error?.message || 'OpenAI API 오류', raw: body }));
        return;
      }
      const reply = body.choices?.[0]?.message?.content ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // static file serving
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}${PUBLIC_URL ? ` (public: ${PUBLIC_URL})` : ''}`);
  if (!APP_PASSWORD) console.log('APP_PASSWORD 가 없어서 비밀번호 보호가 꺼져 있어요. 외부에 공개할 때는 반드시 설정하세요.');
});
