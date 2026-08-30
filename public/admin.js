(function () {
  'use strict';

  var adminToken = '';
  var lastGeneratedCodes = [];
  var dom = {};

  function $(id) { return document.getElementById(id); }

  function el(tag, options) {
    var node = document.createElement(tag);
    if (!options) return node;
    if (options.cls) node.className = options.cls;
    if (options.text != null) node.textContent = String(options.text);
    if (options.attrs) {
      Object.keys(options.attrs).forEach(function (key) { node.setAttribute(key, options.attrs[key]); });
    }
    if (options.children) options.children.forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function setMessage(node, message, state) {
    node.textContent = message || '';
    if (state) node.dataset.state = state;
    else node.removeAttribute('data-state');
  }

  function api(path, options) {
    var init = options || {};
    init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + adminToken });
    init.credentials = 'omit';
    init.cache = 'no-store';
    return fetch(path, init).then(function (response) {
      return response.json()
        .catch(function () { return { ok: false, error: 'invalid_response' }; })
        .then(function (data) {
          if (!response.ok || !data.ok) {
            var error = new Error(data.error || 'request_failed');
            error.status = response.status;
            throw error;
          }
          return data;
        });
    });
  }

  function friendlyError(error) {
    var code = error && error.message ? error.message : String(error || '');
    var messages = {
      admin_unauthorized: '管理 Token 不正确',
      admin_not_configured: 'Worker 尚未配置 ADMIN_TOKEN',
      cdk_service_not_configured: 'D1 或 CDK_HASH_PEPPER 尚未配置',
      cdk_database_error: 'CDK 数据库不可用，请检查是否已执行 D1 迁移',
      invalid_cdk_count: '生成数量必须是 1–50',
      invalid_cdk_max_uses: '可用次数必须是 1–100000',
      invalid_cdk_expiry_days: '有效天数必须是 0–3650',
      cdk_not_found_or_revoked: '记录不存在或已被吊销',
      request_failed: '请求失败，请稍后重试',
      invalid_response: '后台返回了无法识别的响应'
    };
    return messages[code] || '操作失败：' + code;
  }

  function setAuthenticated(authenticated) {
    dom.loginPanel.hidden = authenticated;
    dom.dashboard.hidden = !authenticated;
    dom.adminSession.hidden = !authenticated;
    dom.logoutBtn.hidden = !authenticated;
    if (!authenticated) {
      adminToken = '';
      dom.adminToken.value = '';
      lastGeneratedCodes = [];
      dom.generatedCodes.textContent = '';
      dom.generatedPanel.hidden = true;
    }
  }

  function formatDate(value) {
    if (!value) return '长期有效';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function stateMeta(state) {
    var values = {
      active: { label: '有效', cls: 'is-active' },
      exhausted: { label: '已耗尽', cls: 'is-exhausted' },
      expired: { label: '已过期', cls: 'is-expired' },
      revoked: { label: '已吊销', cls: 'is-revoked' }
    };
    return values[state] || { label: state, cls: '' };
  }

  function renderStats(stats) {
    dom.statTotal.textContent = stats.total || 0;
    dom.statActive.textContent = stats.active || 0;
    dom.statExhausted.textContent = stats.exhausted || 0;
    dom.statInactive.textContent = (stats.expired || 0) + (stats.revoked || 0);
  }

  function revokeRecord(record, button) {
    if (!window.confirm('确认吊销 ' + record.maskedCode + '？吊销后立即无法使用。')) return;
    button.disabled = true;
    button.textContent = '处理中…';
    api('/api/admin/cdks/' + record.id, { method: 'DELETE' })
      .then(loadRecords)
      .catch(function (error) {
        button.disabled = false;
        button.textContent = '吊销';
        window.alert(friendlyError(error));
      });
  }

  function renderRecords(records) {
    dom.tableBody.textContent = '';
    dom.tableEmpty.hidden = records.length > 0;
    records.forEach(function (record) {
      var meta = stateMeta(record.state);
      var usage = el('div', { cls: 'usage-cell' });
      usage.appendChild(el('strong', { text: record.useCount + ' / ' + record.maxUses }));
      var progress = el('span', { cls: 'usage-track' });
      var fill = el('i', { cls: 'usage-fill' });
      fill.style.width = Math.min(100, Math.round(record.useCount / record.maxUses * 100)) + '%';
      progress.appendChild(fill);
      usage.appendChild(progress);

      var action = el('td');
      if (record.state === 'active') {
        var revokeButton = el('button', { cls: 'revoke-btn', text: '吊销', attrs: { type: 'button' } });
        revokeButton.addEventListener('click', function () { revokeRecord(record, revokeButton); });
        action.appendChild(revokeButton);
      } else {
        action.appendChild(el('span', { cls: 'no-action', text: '—' }));
      }

      dom.tableBody.appendChild(el('tr', { children: [
        el('td', { children: [el('code', { cls: 'masked-code', text: record.maskedCode })] }),
        el('td', { text: record.label || '—' }),
        el('td', { children: [usage] }),
        el('td', { children: [
          el('span', { text: formatDate(record.expiresAt) }),
          record.lastUsedAt ? el('small', { cls: 'last-used', text: '最近使用 ' + formatDate(record.lastUsedAt) }) : el('span')
        ] }),
        el('td', { children: [el('span', { cls: 'record-state ' + meta.cls, text: meta.label })] }),
        action
      ] }));
    });
  }

  function loadRecords() {
    dom.refreshBtn.disabled = true;
    dom.refreshBtn.textContent = '正在刷新…';
    return api('/api/admin/cdks?limit=500', { method: 'GET' })
      .then(function (data) {
        renderStats(data.stats || {});
        renderRecords(data.records || []);
      })
      .finally(function () {
        dom.refreshBtn.disabled = false;
        dom.refreshBtn.textContent = '↻ 刷新数据';
      });
  }

  function onLogin(event) {
    event.preventDefault();
    var token = dom.adminToken.value.trim();
    if (!token) {
      setMessage(dom.loginMessage, '请输入管理 Token', 'error');
      return;
    }
    adminToken = token;
    dom.loginBtn.disabled = true;
    dom.loginBtn.textContent = '正在验证…';
    setMessage(dom.loginMessage, '');
    loadRecords()
      .then(function () {
        setAuthenticated(true);
      })
      .catch(function (error) {
        adminToken = '';
        setMessage(dom.loginMessage, friendlyError(error), 'error');
      })
      .finally(function () {
        dom.loginBtn.disabled = false;
        dom.loginBtn.textContent = '进入控制台';
      });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    window.prompt('请手动复制：', text);
    return Promise.resolve();
  }

  function renderGenerated(codes) {
    lastGeneratedCodes = codes.map(function (item) { return item.code; });
    dom.generatedCodes.textContent = '';
    codes.forEach(function (item) {
      var copyButton = el('button', { cls: 'copy-code-btn', text: '复制', attrs: { type: 'button' } });
      copyButton.addEventListener('click', function () {
        copyText(item.code).then(function () {
          copyButton.textContent = '已复制';
          setTimeout(function () { copyButton.textContent = '复制'; }, 1200);
        });
      });
      dom.generatedCodes.appendChild(el('div', { cls: 'generated-code-row', children: [
        el('code', { text: item.code }),
        copyButton
      ] }));
    });
    dom.generatedPanel.hidden = false;
  }

  function onGenerate(event) {
    event.preventDefault();
    var payload = {
      label: dom.cdkLabel.value.trim(),
      count: Number(dom.cdkCount.value),
      maxUses: Number(dom.cdkMaxUses.value),
      expiresDays: Number(dom.cdkExpiry.value)
    };
    dom.generateBtn.disabled = true;
    dom.generateBtn.textContent = '正在签发…';
    setMessage(dom.generateMessage, '');
    api('/api/admin/cdks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (data) {
        renderGenerated(data.codes || []);
        setMessage(dom.generateMessage, '已生成 ' + data.codes.length + ' 个 CDK，请立即保存明文。', 'success');
        return loadRecords();
      })
      .catch(function (error) {
        setMessage(dom.generateMessage, friendlyError(error), 'error');
      })
      .finally(function () {
        dom.generateBtn.disabled = false;
        dom.generateBtn.textContent = '生成 CDK';
      });
  }

  function bind() {
    dom.loginForm.addEventListener('submit', onLogin);
    dom.generateForm.addEventListener('submit', onGenerate);
    dom.refreshBtn.addEventListener('click', function () {
      loadRecords().catch(function (error) { window.alert(friendlyError(error)); });
    });
    dom.logoutBtn.addEventListener('click', function () { setAuthenticated(false); });
    dom.copyAllBtn.addEventListener('click', function () {
      copyText(lastGeneratedCodes.join('\n')).then(function () {
        dom.copyAllBtn.textContent = '已复制';
        setTimeout(function () { dom.copyAllBtn.textContent = '复制全部'; }, 1200);
      });
    });
  }

  function init() {
    dom = {
      loginPanel: $('login-panel'), dashboard: $('admin-dashboard'), adminSession: $('admin-session'),
      logoutBtn: $('logout-btn'), loginForm: $('login-form'), adminToken: $('admin-token'),
      loginBtn: $('login-btn'), loginMessage: $('login-message'), refreshBtn: $('refresh-btn'),
      statTotal: $('stat-total'), statActive: $('stat-active'), statExhausted: $('stat-exhausted'),
      statInactive: $('stat-inactive'), generateForm: $('generate-form'), cdkLabel: $('cdk-label'),
      cdkCount: $('cdk-count'), cdkMaxUses: $('cdk-max-uses'), cdkExpiry: $('cdk-expiry'),
      generateBtn: $('generate-cdk-btn'), generateMessage: $('generate-message'),
      generatedPanel: $('generated-panel'), generatedCodes: $('generated-codes'), copyAllBtn: $('copy-all-btn'),
      tableBody: $('cdk-table-body'), tableEmpty: $('table-empty')
    };
    bind();
    setAuthenticated(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
