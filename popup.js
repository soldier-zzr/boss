const KEYS = {
  config: 'boss_config_v1',
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
  ai: {
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
  },
  templates: [DEFAULT_TEMPLATE],
  activeTemplateId: DEFAULT_TEMPLATE.id,
};

let isRunning = false;
let config = structuredClone(DEFAULT_CONFIG);
let editingTemplateId = DEFAULT_TEMPLATE.id;

function $(id) { return document.getElementById(id); }

function addLog(msg, type = '') {
  const area = $('log-area');
  const line = document.createElement('div');
  line.className = `line ${type}`.trim();
  const time = new Date().toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${msg}`;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
  while (area.children.length > 300) area.removeChild(area.firstChild);
}

function setRunning(running) {
  isRunning = running;
  $('btn-start').disabled = running;
  $('btn-stop').disabled = !running;
  $('status-dot').className = `dot ${running ? 'running' : 'stopped'}`;
  $('status-text').textContent = running ? '运行中...' : '已停止';
}

function updateStats(s = {}) {
  $('today-greet').textContent = s.todayCount || 0;
  $('today-view').textContent = s.todayViewCount || 0;
  $('ai-rate').textContent = `${Math.round((s.aiRate || 0) * 100)}%`;
  $('avg-latency').textContent = `${s.avgLatencyMs || 0}ms`;
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch {
      return false;
    }
  }
}

async function sendToContent(action) {
  const tab = await getActiveTab();
  if (!tab || !tab.url?.includes('zhipin.com')) {
    addLog('请先打开 BOSS直聘 页面', 'error');
    return null;
  }

  if (!await ensureContentScript(tab.id)) {
    addLog('内容脚本加载失败，请刷新页面后重试', 'error');
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, { action });
  } catch {
    return null;
  }
}

function maskToken(v) {
  if (!v) return '';
  if (v.length < 10) return '******';
  return `${v.slice(0, 4)}********${v.slice(-4)}`;
}

function renderTemplatePanel() {
  const select = $('template-select');
  select.innerHTML = '';

  for (const tpl of config.templates) {
    const opt = document.createElement('option');
    opt.value = tpl.id;
    opt.textContent = `${tpl.name} (v${tpl.version || 1})`;
    select.appendChild(opt);
  }

  select.value = editingTemplateId;
  const tpl = config.templates.find(t => t.id === editingTemplateId) || config.templates[0];
  if (!tpl) return;

  $('template-name').value = tpl.name || '';
  $('template-version').value = tpl.version || 1;
  $('template-text').value = tpl.text || '';
}

function renderApiPanel() {
  $('api-endpoint').value = config.ai.endpoint || '';
  $('api-model').value = config.ai.model || '';
  $('api-fallback').value = (config.ai.fallbackModels || []).join(', ');
  $('api-timeout').value = config.ai.timeoutMs || 20000;
  $('api-token').value = config.ai.token || '';
  $('btn-mode').textContent = config.safeTestMode ? '切换到真实模式' : '切换到安全测试模式';
}

function renderChatPanel() {
  $('chat-enabled').checked = !!config.autoChat?.enabled;
  $('chat-ask-resume').checked = !!config.autoChat?.askResume;
  $('chat-ask-wechat').checked = !!config.autoChat?.askWechat;
  $('chat-manual-wechat').checked = config.autoChat?.humanConfirmBeforeWechat !== false;
  $('chat-wait').value = config.autoChat?.waitAfterGreetMs || 2200;
  $('chat-tpl-resume').value = config.autoChat?.templates?.ask_resume || '';
  $('chat-tpl-wechat').value = config.autoChat?.templates?.ask_wechat || '';
  $('chat-tpl-ack').value = config.autoChat?.templates?.ack_wechat || '';

  $('feishu-enabled').checked = !!config.feishu?.enabled;
  $('feishu-mode').value = config.feishu?.mode || 'bitable';
  $('feishu-webhook').value = config.feishu?.webhookUrl || '';
  $('feishu-app-id').value = config.feishu?.appId || '';
  $('feishu-app-secret').value = config.feishu?.appSecret || '';
  $('feishu-app-token').value = config.feishu?.appToken || '';
  $('feishu-table-id').value = config.feishu?.tableId || '';
}

async function persistConfig() {
  await chrome.storage.local.set({ [KEYS.config]: config });
}

function togglePanel(id) {
  for (const pid of ['panel-template', 'panel-api', 'panel-chat']) {
    $(pid).classList.toggle('hidden', pid !== id ? true : !$(pid).classList.contains('hidden'));
  }
}

$('btn-start').addEventListener('click', async () => {
  if (isRunning) return;
  const r = await sendToContent('start');
  if (r?.ok) {
    setRunning(true);
    addLog('已启动自动打招呼');
  }
});

$('btn-stop').addEventListener('click', async () => {
  await sendToContent('stop');
  setRunning(false);
  addLog('已手动停止');
});

$('btn-discover').addEventListener('click', async () => {
  const r = await sendToContent('discover');
  if (!r) return;
  addLog(`URL: ${r.url}`);
  addLog(r.cards > 0 ? `✓ 找到 ${r.cards} 个候选人卡片，可以开始` : '未找到候选人卡片，请到推荐牛人页面', r.cards > 0 ? 'success' : 'error');
});

$('btn-panel-template').addEventListener('click', () => togglePanel('panel-template'));
$('btn-panel-api').addEventListener('click', () => togglePanel('panel-api'));
$('btn-panel-chat').addEventListener('click', () => togglePanel('panel-chat'));

$('template-select').addEventListener('change', e => {
  editingTemplateId = e.target.value;
  renderTemplatePanel();
});

$('tpl-new').addEventListener('click', () => {
  const id = `tpl-${Date.now()}`;
  const t = { id, name: '新模板', version: 1, text: DEFAULT_TEMPLATE.text };
  config.templates.push(t);
  editingTemplateId = id;
  renderTemplatePanel();
});

$('tpl-save').addEventListener('click', async () => {
  const text = $('template-text').value.trim();
  if (!text.includes('{{resume_text}}')) {
    addLog('模板必须包含 {{resume_text}} 占位符', 'error');
    return;
  }
  const i = config.templates.findIndex(t => t.id === editingTemplateId);
  if (i === -1) return;
  config.templates[i] = {
    ...config.templates[i],
    name: $('template-name').value.trim() || '未命名模板',
    version: Number($('template-version').value || 1),
    text,
  };
  await persistConfig();
  renderTemplatePanel();
  addLog('模板已保存', 'success');
});

$('tpl-use').addEventListener('click', async () => {
  config.activeTemplateId = editingTemplateId;
  await persistConfig();
  addLog('已设为当前模板', 'success');
});

$('api-save').addEventListener('click', async () => {
  config.ai.endpoint = $('api-endpoint').value.trim();
  config.ai.model = $('api-model').value.trim();
  config.ai.fallbackModels = $('api-fallback').value.split(',').map(s => s.trim()).filter(Boolean);
  config.ai.timeoutMs = Number($('api-timeout').value || 20000);
  config.ai.token = $('api-token').value.trim();
  await persistConfig();
  addLog('API配置已保存', 'success');
});

$('api-token-show').addEventListener('click', () => {
  $('api-token').type = $('api-token').type === 'password' ? 'text' : 'password';
});

$('api-rotate-hint').addEventListener('click', () => {
  addLog(`建议立即轮换Key：当前显示 ${maskToken(config.ai.token) || '未设置'}`, 'error');
});

$('btn-mode').addEventListener('click', async () => {
  config.safeTestMode = !config.safeTestMode;
  await persistConfig();
  renderApiPanel();
  addLog(`模式已切换：${config.safeTestMode ? '安全测试模式' : '真实模式'}`, 'success');
});

$('chat-save').addEventListener('click', async () => {
  config.autoChat.enabled = $('chat-enabled').checked;
  config.autoChat.askResume = $('chat-ask-resume').checked;
  config.autoChat.askWechat = $('chat-ask-wechat').checked;
  config.autoChat.humanConfirmBeforeWechat = $('chat-manual-wechat').checked;
  config.autoChat.waitAfterGreetMs = Number($('chat-wait').value || 2200);
  config.autoChat.templates.ask_resume = $('chat-tpl-resume').value.trim();
  config.autoChat.templates.ask_wechat = $('chat-tpl-wechat').value.trim();
  config.autoChat.templates.ack_wechat = $('chat-tpl-ack').value.trim();

  config.feishu.enabled = $('feishu-enabled').checked;
  config.feishu.mode = $('feishu-mode').value;
  config.feishu.webhookUrl = $('feishu-webhook').value.trim();
  config.feishu.appId = $('feishu-app-id').value.trim();
  config.feishu.appSecret = $('feishu-app-secret').value.trim();
  config.feishu.appToken = $('feishu-app-token').value.trim();
  config.feishu.tableId = $('feishu-table-id').value.trim();

  await persistConfig();
  addLog('聊天/飞书配置已保存', 'success');
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'log') {
    const level = msg.level || '';
    addLog(msg.msg, level === 'success' ? 'success' : level === 'error' ? 'error' : '');
  } else if (msg.type === 'stats') {
    updateStats(msg);
  } else if (msg.type === 'stopped') {
    setRunning(false);
  }
});

(async () => {
  const data = await chrome.storage.local.get([KEYS.config]);
  config = mergeConfig(DEFAULT_CONFIG, data[KEYS.config]);

  editingTemplateId = config.activeTemplateId || (config.templates[0] && config.templates[0].id) || DEFAULT_TEMPLATE.id;
  renderTemplatePanel();
  renderApiPanel();
  renderChatPanel();

  const stats = await sendToContent('getStats');
  if (stats) {
    updateStats(stats);
    if (stats.running) setRunning(true);
  }

  addLog('扩展就绪，请在推荐人才页面点击开始');
})();
