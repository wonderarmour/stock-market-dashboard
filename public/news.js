(function () {
  const tabs = document.querySelectorAll('.tab-btn');
  const pages = {};
  tabs.forEach((b) => { pages[b.dataset.tab] = document.getElementById('page-' + b.dataset.tab); });
  const rssGrids = { kr: document.getElementById('rss-grid-kr'), global: document.getElementById('rss-grid-global') };
  const rssStatus = document.getElementById('rss-status');
  const briefBox = document.getElementById('brief-box');
  const briefStatus = document.getElementById('brief-status');
  const tgWrap = document.getElementById('tg-sections');
  const tgStatus = document.getElementById('tg-status');
  const tgInput = document.getElementById('tg-channels');
  const tgApply = document.getElementById('tg-apply');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxLink = document.getElementById('lightbox-link');

  let newsLoaded = false;
  const STORAGE_KEY = 'tg-channels';

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.toggle('active', b === btn));
      Object.entries(pages).forEach(([k, el]) => (el.hidden = k !== btn.dataset.tab));
      if (btn.dataset.tab === 'news' && !newsLoaded) {
        newsLoaded = true;
        loadRss();
        loadBrief();
        loadTelegram();
      }
    });
  });

  document.querySelectorAll('.subtabs').forEach((nav) => {
    const btns = nav.querySelectorAll('.subtab-btn');
    btns.forEach((btn) => {
      if (!btn.dataset.subtab) return; // other segmented controls reuse the styling only
      btn.addEventListener('click', () => {
        btns.forEach((b) => {
          b.classList.toggle('active', b === btn);
          document.getElementById('sub-' + b.dataset.subtab).hidden = b !== btn;
        });
      });
    });
  });

  function timeAgo(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.round(h / 24)}일 전`;
  }

  function dayKey(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '날짜 미상';
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }

  async function loadBrief() {
    briefStatus.textContent = '';
    try {
      const res = await fetch('/api/news-brief');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      briefBox.innerHTML = window.mdLite ? window.mdLite(data.brief) : data.brief;
      briefStatus.textContent = `기사 ${data.count}건 기반 · ${new Date(data.generatedAt).toLocaleTimeString('ko-KR')} 생성 · AI 요약`;
    } catch (e) {
      briefBox.innerHTML = `<div class="error">브리핑 생성 실패: ${e.message}</div>`;
    }
  }

  async function loadRss() {
    rssStatus.textContent = '불러오는 중...';
    Object.values(rssGrids).forEach((g) => (g.innerHTML = ''));
    try {
      const res = await fetch('/api/news');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const nKr = data.items.filter((i) => i.region === 'kr').length;
      rssStatus.textContent = `국내 ${nKr}건 · 해외 ${data.items.length - nKr}건 · ${new Date(data.fetchedAt).toLocaleTimeString('ko-KR')} 기준`;
      data.items.forEach((it) => {
        const rssGrid = rssGrids[it.region === 'global' ? 'global' : 'kr'];
        const a = document.createElement('a');
        a.className = 'news-card';
        a.href = it.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = `
          <div class="news-thumb">${it.image ? `<img loading="lazy" alt="">` : ''}</div>
          <div class="news-body">
            <div class="news-meta"><span class="news-source">${it.source}</span><span class="news-cat">${it.category}</span><span class="news-time">${timeAgo(it.pubDate)}</span></div>
            <div class="news-title"></div>
            <div class="news-desc"></div>
          </div>`;
        if (it.image) a.querySelector('img').src = it.image;
        a.querySelector('.news-title').textContent = it.title;
        a.querySelector('.news-desc').textContent = it.description;
        rssGrid.appendChild(a);
      });
    } catch (e) {
      rssStatus.textContent = `오류: ${e.message}`;
    }
  }

  function savedChannels() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  }

  async function loadTelegram() {
    const channels = tgInput.value.trim();
    tgStatus.textContent = '불러오는 중...';
    tgWrap.innerHTML = '';
    try {
      const qs = channels ? `?channels=${encodeURIComponent(channels)}` : '';
      const res = await fetch('/api/telegram' + qs);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const total = data.channels.reduce((n, c) => n + c.posts.length, 0);
      tgStatus.textContent = `${data.channels.length}개 채널 · 이미지 포스트 ${total}건`;
      data.channels.forEach((ch) => {
        const sec = document.createElement('section');
        sec.className = 'tg-channel';
        const head = document.createElement('div');
        head.className = 'tg-channel-head';
        head.innerHTML = `<span class="tg-channel-title"></span><a class="tg-channel-link" target="_blank" rel="noopener">@${ch.channel}</a>`;
        head.querySelector('.tg-channel-title').textContent = ch.title;
        head.querySelector('.tg-channel-link').href = `https://t.me/s/${ch.channel}`;
        sec.appendChild(head);
        if (ch.error) {
          sec.insertAdjacentHTML('beforeend', `<div class="tg-empty">불러오기 실패: ${ch.error}</div>`);
        } else if (!ch.posts.length) {
          sec.insertAdjacentHTML('beforeend', `<div class="tg-empty">최근 이미지 포스트가 없어요</div>`);
        }
        const byDay = new Map();
        [...ch.posts].reverse().forEach((p) => {
          const k = dayKey(p.date);
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(p);
        });
        byDay.forEach((posts, day) => {
          const dayEl = document.createElement('div');
          dayEl.className = 'tg-day';
          dayEl.innerHTML = `<div class="tg-day-label">${day}</div><div class="tg-grid"></div>`;
          const grid = dayEl.querySelector('.tg-grid');
          posts.forEach((p) => {
            p.photos.forEach((src) => {
              const fig = document.createElement('figure');
              fig.className = 'tg-item';
              fig.innerHTML = `<img loading="lazy" alt=""><figcaption></figcaption>`;
              fig.querySelector('img').src = src;
              fig.querySelector('figcaption').textContent = p.text || new Date(p.date).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
              fig.addEventListener('click', () => openLightbox(src, p.url));
              grid.appendChild(fig);
            });
          });
          sec.appendChild(dayEl);
        });
        tgWrap.appendChild(sec);
      });
    } catch (e) {
      tgStatus.textContent = `오류: ${e.message}`;
    }
  }

  function openLightbox(src, url) {
    lightboxImg.src = src;
    lightboxLink.href = url || '#';
    lightboxLink.hidden = !url;
    lightbox.hidden = false;
  }
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.dataset.close !== undefined) lightbox.hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lightbox.hidden = true; });

  tgInput.value = savedChannels();
  tgApply.addEventListener('click', () => {
    try { localStorage.setItem(STORAGE_KEY, tgInput.value.trim()); } catch {}
    loadTelegram();
  });
})();
