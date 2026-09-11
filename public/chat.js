(function () {
  const toggle = document.getElementById('chat-toggle');
  const panel = document.getElementById('chat-panel');
  const messagesEl = document.getElementById('chat-messages');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const statusEl = document.getElementById('chat-status');

  const history = [];
  let connectionChecked = false;

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function openPanel() {
    panel.hidden = false;
    checkConnection();
  }

  async function callChat(messages) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `요청 실패 (HTTP ${res.status})`);
    }
    return data.reply;
  }

  async function checkConnection() {
    if (connectionChecked) return;
    connectionChecked = true;
    statusEl.textContent = '연결 확인 중...';
    const testMessages = [{ role: 'user', content: '연결 테스트: 한국어로 아주 짧게 인사해줘.' }];
    try {
      const reply = await callChat(testMessages);
      statusEl.textContent = '연결됨';
      addMessage('system-note', `API 연결 확인: "${reply}"`);
    } catch (e) {
      statusEl.textContent = '연결 오류';
      addMessage('error', `API 연결 테스트 실패: ${e.message}`);
    }
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    sendBtn.disabled = true;

    const pending = addMessage('assistant', '...');
    try {
      const reply = await callChat(history);
      if (window.mdLite) pending.innerHTML = window.mdLite(reply); else pending.textContent = reply;
      history.push({ role: 'assistant', content: reply });
    } catch (e) {
      pending.remove();
      addMessage('error', `오류: ${e.message}`);
      history.pop();
    } finally {
      sendBtn.disabled = false;
    }
  }

  const scenarioBtn = document.getElementById('scenario-btn');

  async function runScenarioAnalysis() {
    openPanel();
    if (!window.buildMarketSummaryText) {
      addMessage('error', '시장 데이터를 아직 불러오는 중이에요. 잠시 후 다시 눌러 주세요.');
      return;
    }
    const summary = window.buildMarketSummaryText();
    if (!summary) {
      addMessage('error', '분석할 시장 데이터가 없어요.');
      return;
    }

    addMessage('user', '오늘(시세·뉴스)과 과거(유사 사례)를 바탕으로 삼성전자 대응 시나리오를 요청했어요');
    scenarioBtn.disabled = true;
    const pending = addMessage('assistant', '1/3 오늘 뉴스 수집 중...');

    // 오늘: headline digest from the RSS endpoint
    let newsText = '뉴스 수집 실패';
    try {
      const res = await fetch('/api/news');
      const data = await res.json();
      if (res.ok) {
        newsText = (data.items || []).slice(0, 15).map((it) => `- [${it.source}/${it.category}] ${it.title}`).join('\n') || '기사 없음';
      }
    } catch (e) { /* keep fallback text */ }

    // 과거: analog search over the full NASDAQ history (cached in drawdown.js)
    pending.textContent = '2/3 과거 유사 사례 분석 중... (1971년~ 나스닥 전체 히스토리)';
    let analogText = '유사 사례 분석 실패';
    try {
      if (window.buildAnalogSummaryText) analogText = await window.buildAnalogSummaryText();
    } catch (e) { analogText = `유사 사례 분석 실패: ${e.message}`; }

    pending.textContent = '3/3 대응 시나리오 작성 중...';
    const prompt =
      `오늘 날짜: ${new Date().toISOString().slice(0, 10)}\n\n` +
      '## A. 오늘의 시세 (선택 기간 대비 변동, 전일 대비 변동, 기간 고저)\n' + summary +
      '\n\n## B. 오늘의 주요 뉴스 헤드라인\n' + newsText +
      '\n\n## C. 과거 유사 사례 (나스닥 전체 히스토리에서 현재 경로와 가장 닮은 구간과, 그때 이후 실제 전개)\n' + analogText +
      '\n\n위 A·B·C를 종합해 삼성전자(005930.KS)에 대한 "현재 시점 대응 시나리오"를 한국어로 작성해줘. 구조:\n' +
      '1. 현재 국면 진단 — 오늘 시세·뉴스와 과거 유사 사례가 가리키는 방향이 일치하는지/충돌하는지 한 문단으로. (유사 사례의 "무작위 대비 백분위"가 95 미만이면 근거가 약하다고 명시)\n' +
      '2. 대응 시나리오 3개 — 기본(가장 가능성 높음) / 상방 / 하방. 각각: 발동 조건(가격·지표·뉴스 트리거), 확률감(높음/중간/낮음), 구체적 대응 행동(신규 진입·비중 조절·손절·익절 기준을 삼성전자 현재가 기준 가격대로), 무효화 조건.\n' +
      '3. 오늘 체크리스트 — 장중 확인할 지표·이벤트 3~5개 (환율·VIX·SOX·코스피·뉴스 중에서).\n' +
      '4. 핵심 리스크 2~3개.\n' +
      '불릿 위주로 간결하게, 모든 문장은 해요체로. 마지막 줄에는 반드시 "이 내용은 투자 참고용 정보이고 투자 조언이 아니에요. 투자 판단과 책임은 본인에게 있어요."라는 문구를 그대로 포함해줘.';

    const requestMessages = [...history, { role: 'user', content: prompt }];
    try {
      const reply = await callChat(requestMessages);
      if (window.mdLite) pending.innerHTML = window.mdLite(reply); else pending.textContent = reply;
      history.push({ role: 'user', content: prompt });
      history.push({ role: 'assistant', content: reply });
    } catch (e) {
      pending.remove();
      addMessage('error', `분석 요청 실패: ${e.message}`);
    } finally {
      scenarioBtn.disabled = false;
    }
  }

  scenarioBtn.addEventListener('click', runScenarioAnalysis);

  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) checkConnection();
  });

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
})();
