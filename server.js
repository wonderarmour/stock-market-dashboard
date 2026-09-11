const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (e) {
  // .env is optional
}

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = 'gpt-5.6-luna';

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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
  console.log(`Server running at http://localhost:${PORT}`);
});
