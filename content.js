if (window !== window.top) {
  // top frame only
} else if (!window.__bossAutoGreetInitialized) {
  window.__bossAutoGreetInitialized = true;

  const KEYS = {
    config: 'boss_config_v1',
    state: 'boss_state_v2',
    metrics: 'boss_metrics_v1',
    session: 'boss_session_v1',
  };

  const DEFAULT_TEMPLATE = {
    id: 'tpl-default-boss-delivery',
    name: '广告投放默认模板',
    version: 1,
    text: [
      '你是招聘筛选助手。根据简历判断是否建议打招呼。',
      '岗位目标：短视频/信息流广告投放方向（抖音/视频号/小红书/千川等）。',
      '硬性淘汰：应届、在校、实习；学历为初中/高中/中专/中技。',
      '请只返回JSON，不要解释。格式：{"pass":boolean,"reason":"简短原因","score":0-100}',
      '简历内容如下：',
      '{{resume_text}}',
    ].join('\n'),
  };

  const DEFAULT_CONFIG = {
    safeTestMode: true,
    dailyViewLimit: 120,
    dailyGreetLimit: 60,
    greetPerHourLimit: 18,
    pacing: {
      delayMin: 18000,
      delayMax: 55000,
      longBreakChance: 0.07,
      longBreakMin: 60000,
      longBreakMax: 150000,
      reviewPauseChance: 0.35,
      reviewPauseMin: 2500,
      reviewPauseMax: 9000,
      sessionBreakEveryMin: 4,
      sessionBreakEveryMax: 8,
      sessionBreakMin: 180000,
      sessionBreakMax: 420000,
      skipChance: 0.06,
    },
    filter: {
      keywords: ['抖音', '投放', '视频号', '小红书', '短视频', '直播', '广告投放', '千川', 'dou+', '信息流'],
      excludeExp: ['应届', '在校生', '实习'],
      badDegree: ['初中', '高中', '中专', '中技'],
    },
    greetings: [
      '您好！看到您有短视频/直播投放经验，和我们岗位很匹配，方便聊聊吗？',
      '您好，您的投放背景和岗位较匹配，主要做抖音和视频号投放，感兴趣可沟通。',
      '您好！看过您的投放经历，我们这边岗位方向相符，欢迎进一步了解。',
    ],
    ai: {
      enabled: true,
      endpoint: 'http://api.zhixiangyuanda.cn:8080/v1/messages',
      token: '',
      model: 'claude-sonnet-4-5',
      fallbackModels: ['claude-3-7-sonnet', 'claude-3-5-sonnet'],
      timeoutMs: 20000,
    },
    autoChat: {
      enabled: true,
      askResume: true,
      askWechat: true,
      humanConfirmBeforeWechat: true,
      waitAfterGreetMs: 2200,
      templates: {
        ask_resume: '您好，为了更准确评估匹配度，方便发一份最新简历吗？',
        ask_wechat: '看起来比较匹配，方便互加微信进一步沟通吗？',
        ack_wechat: '收到，我这边会尽快加您微信，感谢。'
      }
    },
    feishu: {
      enabled: false,
      mode: 'bitable',
      webhookUrl: '',
      appId: '',
      appSecret: '',
      appToken: '',
      tableId: '',
      fieldMap: {
        name: '候选人',
        wechat: '微信',
        resume_status: '简历状态',
        status: '阶段',
        note: '备注',
        source: '来源',
        updated_at: '更新时间'
      }
    },
    templates: [DEFAULT_TEMPLATE],
    activeTemplateId: DEFAULT_TEMPLATE.id,
  };

  let config = structuredClone(DEFAULT_CONFIG);
  let state = {
    running: false,
    todayViewCount: 0,
    totalViewCount: 0,
    todayGreetCount: 0,
    totalGreetCount: 0,
  };

  let metrics = {
    aiCalls: 0,
    aiSuccess: 0,
    aiFallback: 0,
    aiFailure: 0,
    latencyTotalMs: 0,
    candidatesProcessed: 0,
  };

  let session = {
    sessionId: '',
    status: 'idle',
    lastCandidateId: '',
    startedAt: 0,
    updatedAt: 0,
  };

  let runId = 0;
  let loopCount = 0;
  let nextSessionBreakAt = 6;
  const greetTimestamps = [];

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const now = () => Date.now();
  const dayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function makeSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function mergeConfig(base, patch) {
    const out = structuredClone(base);
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = mergeConfig(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  async function loadAll() {
    const data = await chrome.storage.local.get([KEYS.config, KEYS.state, KEYS.metrics, KEYS.session]);

    config = mergeConfig(DEFAULT_CONFIG, data[KEYS.config]);

    const savedState = data[KEYS.state] || {};
    if (savedState.date === dayKey()) {
      state.todayViewCount = savedState.todayView || 0;
      state.todayGreetCount = savedState.todayGreet || 0;
    } else {
      state.todayViewCount = 0;
      state.todayGreetCount = 0;
    }
    state.totalViewCount = savedState.totalView || 0;
    state.totalGreetCount = savedState.totalGreet || 0;

    metrics = { ...metrics, ...(data[KEYS.metrics] || {}) };
    session = { ...session, ...(data[KEYS.session] || {}) };
  }

  async function saveState() {
    await chrome.storage.local.set({
      [KEYS.state]: {
        date: dayKey(),
        todayView: state.todayViewCount,
        totalView: state.totalViewCount,
        todayGreet: state.todayGreetCount,
        totalGreet: state.totalGreetCount,
      },
    });
  }

  async function saveMetrics() {
    await chrome.storage.local.set({ [KEYS.metrics]: metrics });
  }

  async function saveSession() {
    session.updatedAt = now();
    await chrome.storage.local.set({ [KEYS.session]: session });
  }

  function emitStats() {
    const aiRate = metrics.aiCalls ? Number((metrics.aiSuccess / metrics.aiCalls).toFixed(4)) : 0;
    const fallbackRate = metrics.aiCalls ? Number((metrics.aiFallback / metrics.aiCalls).toFixed(4)) : 0;
    const avgLatencyMs = metrics.aiCalls ? Math.round(metrics.latencyTotalMs / metrics.aiCalls) : 0;

    chrome.runtime.sendMessage({
      from: 'content',
      type: 'stats',
      todayCount: state.todayGreetCount,
      totalCount: state.totalGreetCount,
      todayViewCount: state.todayViewCount,
      totalViewCount: state.totalViewCount,
      aiRate,
      fallbackRate,
      avgLatencyMs,
    }).catch(() => {});
  }

  function logEvent(message, level = 'info', meta = {}) {
    chrome.runtime.sendMessage({
      from: 'content',
      type: 'log',
      level,
      msg: message,
      meta: {
        session_id: session.sessionId || '',
        ...meta,
      },
    }).catch(() => {});
  }

  function getIframeDoc() {
    const iframe = document.querySelector('.alive-frame-wrap iframe, iframe[src*="frame/recommend"]');
    if (!iframe) return null;
    try {
      return iframe.contentDocument || iframe.contentWindow?.document;
    } catch (_) {
      return null;
    }
  }

  function getCards() {
    const doc = getIframeDoc();
    if (!doc) return [];
    return Array.from(doc.querySelectorAll('.card-list .card-item'));
  }

  function candidateId(card) {
    const txt = (card.innerText || '').trim().slice(0, 24);
    return `cand_${txt.replace(/\s+/g, '_')}_${Math.abs(txt.split('').reduce((a, c) => a + c.charCodeAt(0), 0))}`;
  }

  function detectWechatId(text) {
    const raw = text || '';
    const wxPattern = /(?:微信|vx|v信|v\s*x)[:：\s-]*([a-zA-Z][-_a-zA-Z0-9]{5,19})/i;
    const m = raw.match(wxPattern);
    if (m && m[1]) return m[1];
    const plain = raw.match(/\b[a-zA-Z][-_a-zA-Z0-9]{5,19}\b/g) || [];
    const hit = plain.find(x => /[a-zA-Z]/.test(x) && /\d/.test(x));
    return hit || '';
  }

  function transcriptSnapshot() {
    const docs = [document, getIframeDoc()].filter(Boolean);
    for (const d of docs) {
      const box = d.querySelector('.chat-content, .im-chat-content, .message-list, .chat-record, .conversation-content');
      if (box && box.innerText) return box.innerText.slice(-6000);
    }
    return (document.body?.innerText || '').slice(-6000);
  }

  async function sendChatText(text) {
    if (!text) return false;
    const docs = [document, getIframeDoc()].filter(Boolean);
    for (const d of docs) {
      const input = d.querySelector('#chat-input, [contenteditable="true"].input, .chat-input');
      if (!input) continue;
      input.focus();
      input.innerText = text;
      ['input', 'compositionend'].forEach(e => input.dispatchEvent(new Event(e, { bubbles: true })));
      await sleep(rand(300, 900));
      const sendBtn = d.querySelector('.btn-send, button[class*="send"]');
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
    }
    return false;
  }

  async function writeToFeishu(payload) {
    if (!config.feishu.enabled) return { skipped: true, code: 'FEISHU_DISABLED' };
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'feishuUpsert', payload: { config: config.feishu, data: payload } }, resolve);
    });
  }

  async function runAutoChat(candidateName, candId) {
    if (!config.autoChat.enabled) return;
    await sleep(config.autoChat.waitAfterGreetMs || 2000);

    const transcript = transcriptSnapshot();
    const hasResume = /简历|pdf|附件|作品集|发你简历|已投简历/i.test(transcript);
    const wx = detectWechatId(transcript);
    const hasWechat = !!wx || /微信|vx|v信/i.test(transcript);

    if (config.autoChat.askResume && !hasResume) {
      const ok = await sendChatText(config.autoChat.templates.ask_resume);
      if (ok) {
        logEvent('自动追问：已发送索取简历消息', 'info', { candidate_id: candId, code: 'AUTO_CHAT_ASK_RESUME' });
      }
      return;
    }

    if (config.autoChat.askWechat && hasResume && !hasWechat) {
      if (config.autoChat.humanConfirmBeforeWechat) {
        logEvent('候选人已具备要微信条件：请人工确认后发送（默认保护）', 'info', {
          candidate_id: candId,
          code: 'AUTO_CHAT_NEED_MANUAL_WECHAT_CONFIRM',
        });
        return;
      }
      const ok = await sendChatText(config.autoChat.templates.ask_wechat);
      if (ok) {
        logEvent('自动追问：已发送微信交换请求', 'info', { candidate_id: candId, code: 'AUTO_CHAT_ASK_WECHAT' });
      }
      return;
    }

    if (wx) {
      const result = await writeToFeishu({
        candidate_name: candidateName,
        candidate_id: candId,
        wechat: wx,
        resume_status: hasResume ? '已提供' : '未提供',
        status: '待加微信',
        source: 'BOSS直聘',
        note: '自动聊天提取',
      });
      if (result?.ok) {
        logEvent('飞书入库成功（已记录微信）', 'success', { candidate_id: candId, code: 'FEISHU_OK' });
        await sendChatText(config.autoChat.templates.ack_wechat);
      } else if (!result?.skipped) {
        logEvent(`飞书入库失败：${result?.error || '未知错误'}`, 'warn', { candidate_id: candId, code: result?.code || 'FEISHU_FAIL' });
      }
    }
  }

  function checkByRule(text) {
    const t = (text || '').toLowerCase();
    if (Math.random() < config.pacing.skipChance) return { pass: false, reason: '随机跳过', code: 'RANDOM_SKIP' };
    if (!config.filter.keywords.some(k => t.includes(k.toLowerCase()))) return { pass: false, reason: '无投放关键词', code: 'NO_KEYWORD' };
    if (config.filter.excludeExp.some(k => t.includes(k))) return { pass: false, reason: '应届/在校', code: 'EXCLUDED_EXP' };
    if (config.filter.badDegree.some(k => t.includes(k))) return { pass: false, reason: '学历不符', code: 'DEGREE_BLOCK' };
    return { pass: true, reason: '规则通过', code: 'RULE_PASS' };
  }

  function activeTemplate() {
    const tpl = (config.templates || []).find(t => t.id === config.activeTemplateId);
    return tpl || DEFAULT_TEMPLATE;
  }

  async function aiFilter(resumeText) {
    if (!config.ai.enabled || !config.ai.endpoint || !config.ai.token) {
      return { skipped: true, code: 'AI_DISABLED' };
    }

    const tpl = activeTemplate();
    const prompt = (tpl.text || DEFAULT_TEMPLATE.text).replace('{{resume_text}}', resumeText.slice(0, 12000));

    const models = [config.ai.model, ...(config.ai.fallbackModels || [])].filter(Boolean);
    const started = now();

    metrics.aiCalls += 1;
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const resp = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'aiFilter',
          payload: {
            endpoint: config.ai.endpoint,
            token: config.ai.token,
            model,
            prompt,
            timeoutMs: config.ai.timeoutMs,
          },
        }, resolve);
      });

      if (resp?.data) {
        const text = (resp.data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
        const s = text.indexOf('{');
        const e = text.lastIndexOf('}');
        if (s !== -1 && e > s) {
          try {
            const parsed = JSON.parse(text.slice(s, e + 1));
            metrics.aiSuccess += 1;
            if (i > 0) metrics.aiFallback += 1;
            metrics.latencyTotalMs += now() - started;
            await saveMetrics();
            return {
              pass: !!parsed.pass,
              reason: String(parsed.reason || ''),
              score: Number(parsed.score || 0),
              model,
              fallback: i > 0,
            };
          } catch (_) {}
        }
      }

      if (i === models.length - 1) {
        metrics.aiFailure += 1;
        metrics.latencyTotalMs += now() - started;
        await saveMetrics();
        return { error: resp?.error || 'AI_PARSE_FAIL', code: resp?.code || 'AI_FAIL_ALL' };
      }
    }

    metrics.aiFailure += 1;
    metrics.latencyTotalMs += now() - started;
    await saveMetrics();
    return { error: 'AI_UNKNOWN_FAIL', code: 'AI_UNKNOWN_FAIL' };
  }

  async function openResume(card) {
    const clickable = card.querySelector('.geek-info, .candidate-card, .card-inner, .geek-name, .name') || card;
    clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(400, 900));
    clickable.click();
    await sleep(rand(900, 1600));
  }

  function detailContainer(doc) {
    const selectors = ['.resume-detail-wrap', '.geek-detail-content', '.resume-content', '.right-content', '.detail-content', '.recommend-detail'];
    for (const s of selectors) {
      const el = doc.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  async function readResume(card) {
    const doc = getIframeDoc();
    if (!doc) return card.innerText || '';

    await openResume(card);
    const panel = detailContainer(doc);
    if (!panel) return card.innerText || '';

    for (let i = 0; i < rand(6, 10); i++) {
      panel.scrollTop = panel.scrollHeight;
      await sleep(rand(260, 760));
    }
    const text = panel.innerText || card.innerText || '';
    panel.scrollTop = 0;
    await sleep(rand(120, 260));
    return text;
  }

  async function clickGreet(card) {
    const btn = card.querySelector('button.btn-greet, .btn-greet, button[class*="greet"]');
    if (!btn) return false;
    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(600, 1500));
    btn.click();
    return true;
  }

  async function sendGreeting(text) {
    await sleep(rand(1500, 3000));
    const docs = [document, getIframeDoc()].filter(Boolean);
    let input = null;

    for (let i = 0; i < 15; i++) {
      for (const doc of docs) {
        input = doc.querySelector('#chat-input, [contenteditable="true"].input, .chat-input');
        if (input) break;
      }
      if (input) break;
      await sleep(300);
    }

    if (!input) return true;
    input.focus();
    input.innerText = text;
    ['input', 'compositionend'].forEach(e => input.dispatchEvent(new Event(e, { bubbles: true })));
    await sleep(rand(500, 1300));

    const sendBtn = input.ownerDocument.querySelector('.btn-send, button[class*="send"]');
    if (!sendBtn) return false;
    sendBtn.click();
    return true;
  }

  async function closeDialog() {
    const docs = [document, getIframeDoc()].filter(Boolean);
    for (const doc of docs) {
      const btn = doc.querySelector('.dialog-close, .modal-close, .icon-close, [class*="close-btn"]');
      if (btn) {
        btn.click();
        await sleep(300);
        break;
      }
    }
  }

  async function runOnce(currentRunId) {
    const cards = getCards();
    if (!cards.length) {
      logEvent('未找到候选人卡片，请确认在推荐牛人页面', 'warn', { code: 'NO_CARDS' });
      return 0;
    }

    let done = 0;
    logEvent(`找到 ${cards.length} 个候选人，开始处理（先看完整简历再筛选）`, 'info');

    let startIdx = 0;
    if (session.lastCandidateId) {
      const idx = cards.findIndex(c => candidateId(c) === session.lastCandidateId);
      if (idx >= 0 && idx + 1 < cards.length) {
        startIdx = idx + 1;
        logEvent(`从上次检查点恢复：第 ${startIdx + 1} 位候选人`, 'info', { code: 'RESUME_FROM_CHECKPOINT' });
      }
    }

    for (const card of cards.slice(startIdx)) {
      if (!state.running || currentRunId !== runId) break;

      if (state.todayViewCount >= config.dailyViewLimit) {
        state.running = false;
        logEvent(`已达今日看简历上限 ${config.dailyViewLimit}`, 'warn', { code: 'VIEW_LIMIT' });
        break;
      }
      if (state.todayGreetCount >= config.dailyGreetLimit) {
        state.running = false;
        logEvent(`已达今日打招呼上限 ${config.dailyGreetLimit}`, 'warn', { code: 'GREET_LIMIT' });
        break;
      }

      while (greetTimestamps.length && now() - greetTimestamps[0] > 3600 * 1000) greetTimestamps.shift();
      if (greetTimestamps.length >= config.greetPerHourLimit) {
        const waitMs = Math.max(15000, 3600 * 1000 - (now() - greetTimestamps[0]));
        logEvent(`已达每小时打招呼上限 ${config.greetPerHourLimit}，休息 ${(waitMs / 60000).toFixed(1)} 分钟`, 'warn', { code: 'HOUR_LIMIT' });
        await sleep(waitMs);
      }

      const name = ((card.innerText || '').split('\n')[0] || '').trim().slice(0, 10);
      const candId = candidateId(card);
      session.lastCandidateId = candId;
      await saveSession();

      const resumeText = await readResume(card);
      if (Math.random() < config.pacing.reviewPauseChance) {
        const p = rand(config.pacing.reviewPauseMin, config.pacing.reviewPauseMax);
        logEvent(`模拟人工阅读停顿 ${(p / 1000).toFixed(1)}s`, 'info', { candidate_id: candId });
        await sleep(p);
      }

      state.todayViewCount += 1;
      state.totalViewCount += 1;
      metrics.candidatesProcessed += 1;
      await Promise.all([saveState(), saveMetrics()]);
      logEvent(`已查看完整简历：${name}（今日查看 ${state.todayViewCount}/${config.dailyViewLimit}）`, 'info', { candidate_id: candId });

      const rule = checkByRule(resumeText);
      let finalPass = rule.pass;
      let reason = rule.reason;

      if (rule.pass) {
        const ai = await aiFilter(resumeText);
        if (ai.error) {
          logEvent(`AI筛选失败，回退本地规则：${ai.error}`, 'warn', {
            candidate_id: candId,
            rule_result: rule.code,
            fallback_reason: ai.code || 'AI_FAIL',
          });
        } else if (ai.skipped) {
          logEvent('AI未启用，使用本地规则', 'info', { candidate_id: candId, fallback_reason: ai.code });
        } else {
          finalPass = ai.pass;
          reason = ai.reason || (ai.pass ? 'AI通过' : 'AI不通过');
          logEvent(`AI判定：${ai.pass ? '通过' : '不通过'}（score ${ai.score}）`, 'info', {
            candidate_id: candId,
            ai_result: ai.pass ? 'PASS' : 'REJECT',
            latency_ms: metrics.aiCalls ? Math.round(metrics.latencyTotalMs / metrics.aiCalls) : 0,
          });
        }
      }

      if (!finalPass) {
        logEvent(`跳过 ${name}：${reason}`, 'info', { candidate_id: candId, rule_result: rule.code });
        await sleep(rand(800, 2500));
        emitStats();
        continue;
      }

      logEvent(`准备打招呼：${name}`, 'info', { candidate_id: candId });

      if (config.safeTestMode) {
        const d = rand(1200, 2800);
        logEvent('测试模式：已通过筛选，未发送打招呼（保护账号）', 'info', { candidate_id: candId });
        await sleep(d);
        emitStats();
        continue;
      }

      const clicked = await clickGreet(card);
      if (!clicked) {
        logEvent(`${name}：未找到打招呼按钮`, 'warn', { candidate_id: candId, code: 'NO_GREET_BTN' });
        continue;
      }

      const sent = await sendGreeting(pick(config.greetings));
      if (sent) {
        state.todayGreetCount += 1;
        state.totalGreetCount += 1;
        greetTimestamps.push(now());
        done += 1;
        await saveState();
        logEvent(`✓ 成功：${name}（今日打招呼 ${state.todayGreetCount}/${config.dailyGreetLimit}）`, 'success', { candidate_id: candId });

        await runAutoChat(name, candId);
        await closeDialog();
      } else {
        logEvent(`✗ 失败：${name}`, 'error', { candidate_id: candId, code: 'SEND_FAIL' });
        await closeDialog();
      }

      loopCount += 1;
      if (loopCount >= nextSessionBreakAt) {
        const b = rand(config.pacing.sessionBreakMin, config.pacing.sessionBreakMax);
        logEvent(`阶段性休息 ${(b / 60000).toFixed(1)} 分钟`, 'info', { code: 'SESSION_BREAK' });
        await sleep(b);
        loopCount = 0;
        nextSessionBreakAt = rand(config.pacing.sessionBreakEveryMin, config.pacing.sessionBreakEveryMax);
      }

      const delay = Math.random() < config.pacing.longBreakChance
        ? rand(config.pacing.longBreakMin, config.pacing.longBreakMax)
        : rand(config.pacing.delayMin, config.pacing.delayMax);
      logEvent(`等待 ${(delay / 1000).toFixed(0)}s...`, 'info');
      await sleep(delay);
      emitStats();
    }

    return done;
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.action === 'ping') {
      reply({ ok: true });
      return true;
    }

    if (msg.action === 'start') {
      if (state.running) {
        reply({ ok: true, running: true });
        return true;
      }

      loadAll().then(() => {
        state.running = true;
        runId += 1;
        loopCount = 0;
        nextSessionBreakAt = rand(config.pacing.sessionBreakEveryMin, config.pacing.sessionBreakEveryMax);
        const currentRunId = runId;

        session.sessionId = makeSessionId();
        session.status = 'running';
        session.startedAt = now();
        saveSession();

        emitStats();
        logEvent(`开始，今日已打招呼 ${state.todayGreetCount} 个，已看简历 ${state.todayViewCount} 份`, 'info');

        runOnce(currentRunId).then(n => {
          if (currentRunId !== runId) return;
          state.running = false;
          session.status = 'stopped';
          saveSession();
          logEvent(`本轮完成 ${n} 个`, 'info');
          chrome.runtime.sendMessage({ from: 'content', type: 'stopped' }).catch(() => {});
        }).catch(err => {
          state.running = false;
          session.status = 'error';
          saveSession();
          logEvent(`✗ 运行异常：${err?.message || '未知错误'}`, 'error', { code: 'RUN_EXCEPTION' });
          chrome.runtime.sendMessage({ from: 'content', type: 'stopped' }).catch(() => {});
        });
      });

      reply({ ok: true });
      return true;
    }

    if (msg.action === 'stop') {
      state.running = false;
      runId += 1;
      session.status = 'stopped';
      saveSession();
      logEvent('已停止', 'info', { code: 'MANUAL_STOP' });
      chrome.runtime.sendMessage({ from: 'content', type: 'stopped' }).catch(() => {});
      reply({ ok: true });
      return true;
    }

    if (msg.action === 'getStats') {
      loadAll().then(() => {
        const aiRate = metrics.aiCalls ? Number((metrics.aiSuccess / metrics.aiCalls).toFixed(4)) : 0;
        const fallbackRate = metrics.aiCalls ? Number((metrics.aiFallback / metrics.aiCalls).toFixed(4)) : 0;
        const avgLatencyMs = metrics.aiCalls ? Math.round(metrics.latencyTotalMs / metrics.aiCalls) : 0;
        reply({
          todayCount: state.todayGreetCount,
          totalCount: state.totalGreetCount,
          running: state.running,
          todayViewCount: state.todayViewCount,
          totalViewCount: state.totalViewCount,
          aiRate,
          fallbackRate,
          avgLatencyMs,
          safeTestMode: config.safeTestMode,
        });
      });
      return true;
    }

    if (msg.action === 'discover') {
      const doc = getIframeDoc();
      const cards = doc ? doc.querySelectorAll('.card-list .card-item').length : 0;
      reply({ url: location.href, iframeFound: !!doc, cards });
      return true;
    }

    reply({ ok: false });
    return true;
  });
}
