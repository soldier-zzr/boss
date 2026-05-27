function mapErrorCode(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('abort')) return 'E_TIMEOUT';
  if (msg.includes('failed to fetch')) return 'E_FETCH';
  return 'E_UNKNOWN';
}

async function getFeishuTenantToken(appId, appSecret) {
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!resp.ok) throw new Error(`FEISHU_AUTH_HTTP_${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`FEISHU_AUTH_${data.code || 'FAIL'}`);
  }
  return data.tenant_access_token;
}

function buildFeishuFields(fieldMap = {}, data = {}) {
  return {
    [fieldMap.name || '候选人']: data.candidate_name || '',
    [fieldMap.wechat || '微信']: data.wechat || '',
    [fieldMap.resume_status || '简历状态']: data.resume_status || '',
    [fieldMap.status || '阶段']: data.status || '',
    [fieldMap.note || '备注']: data.note || '',
    [fieldMap.source || '来源']: data.source || '',
    [fieldMap.updated_at || '更新时间']: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

async function feishuUpsert(payload = {}) {
  const { config = {}, data = {} } = payload;
  if (!config.enabled) return { skipped: true, code: 'FEISHU_DISABLED' };

  if (config.mode === 'webhook') {
    if (!config.webhookUrl) return { error: 'Webhook未配置', code: 'FEISHU_WEBHOOK_MISSING' };
    const body = {
      msg_type: 'text',
      content: {
        text: [
          `候选人：${data.candidate_name || '-'}`,
          `微信：${data.wechat || '-'}`,
          `简历状态：${data.resume_status || '-'}`,
          `阶段：${data.status || '-'}`,
          `来源：${data.source || 'BOSS直聘'}`,
          `备注：${data.note || '-'}`,
        ].join('\n'),
      },
    };
    const resp = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, code: `FEISHU_WEBHOOK_HTTP_${resp.status}` };
    return { ok: true, mode: 'webhook' };
  }

  const required = ['appId', 'appSecret', 'appToken', 'tableId'];
  for (const k of required) {
    if (!config[k]) return { error: `${k}未配置`, code: `FEISHU_PARAM_${k.toUpperCase()}` };
  }

  const tenantToken = await getFeishuTenantToken(config.appId, config.appSecret);
  const fields = buildFeishuFields(config.fieldMap || {}, data);

  const resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({ fields }),
    }
  );
  if (!resp.ok) return { error: `HTTP ${resp.status}`, code: `FEISHU_BITABLE_HTTP_${resp.status}` };
  const d = await resp.json();
  if (d.code !== 0) return { error: d.msg || 'Bitable失败', code: `FEISHU_BITABLE_${d.code}` };
  return { ok: true, mode: 'bitable', recordId: d.data?.record?.record_id || '' };
}

async function runBenchmarkCheck(payload = {}) {
  const repos = Array.isArray(payload.repos) ? payload.repos : [];
  const activeDays = Number(payload.activeDays || 60);
  const cutoff = Date.now() - activeDays * 24 * 3600 * 1000;

  const results = [];
  for (const repo of repos) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { 'User-Agent': 'boss-auto-greet-benchmark' },
      });
      if (!resp.ok) {
        results.push({ repo, ok: false, error: `HTTP ${resp.status}` });
        continue;
      }
      const d = await resp.json();
      const pushedTs = new Date(d.pushed_at || 0).getTime();
      results.push({
        repo,
        ok: true,
        active: pushedTs >= cutoff,
        pushed_at: d.pushed_at,
        stars: d.stargazers_count || 0,
      });
    } catch (err) {
      results.push({ repo, ok: false, error: err?.message || 'FETCH_ERROR' });
    }
  }

  const activeRepos = results.filter(r => r.ok && r.active).map(r => r.repo);
  const summary = `活跃仓库 ${activeRepos.length}/${results.length}（阈值 ${activeDays} 天）`;
  return {
    generated_at: new Date().toISOString(),
    active_days: activeDays,
    summary,
    repos: results,
    active_repos: activeRepos,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'aiFilter') {
    (async () => {
      const { endpoint, token, model, prompt, timeoutMs } = msg.payload || {};
      if (!endpoint || !token || !model || !prompt) {
        sendResponse({ error: 'AI参数缺失', code: 'E_PARAM' });
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 20000);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': token,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 240,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          sendResponse({ error: `HTTP ${resp.status}`, code: `E_HTTP_${resp.status}` });
          return;
        }

        const data = await resp.json();
        sendResponse({ data });
      } catch (err) {
        sendResponse({ error: err?.message || '请求失败', code: mapErrorCode(err) });
      } finally {
        clearTimeout(timer);
      }
    })();
    return true;
  }

  if (msg.type === 'benchmarkCheck') {
    (async () => {
      const report = await runBenchmarkCheck(msg.payload || {});
      sendResponse({ report });
    })();
    return true;
  }

  if (msg.type === 'feishuUpsert') {
    (async () => {
      try {
        const result = await feishuUpsert(msg.payload || {});
        sendResponse(result);
      } catch (err) {
        sendResponse({
          error: err?.message || '飞书入库失败',
          code: mapErrorCode(err),
        });
      }
    })();
    return true;
  }

  sendResponse({ ok: true });
  return true;
});
