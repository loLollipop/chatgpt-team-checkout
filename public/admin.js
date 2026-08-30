(function () {
  'use strict';

  var adminToken = '';
  var lastGeneratedCodes = [];
  var dom = {};
  var countries = [
    { code: 'US', name: '美国', flag: '🇺🇸' },
    { code: 'EG', name: '埃及', flag: '🇪🇬' },
    { code: 'GB', name: '英国', flag: '🇬🇧' },
    { code: 'PH', name: '菲律宾', flag: '🇵🇭' },
    { code: 'JP', name: '日本', flag: '🇯🇵' },
    { code: 'TH', name: '泰国', flag: '🇹🇭' },
    { code: 'IN', name: '印度', flag: '🇮🇳' },
    { code: 'SE', name: '瑞典', flag: '🇸🇪' }
  ];

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
      proxy_service_not_configured: 'D1 或 PROXY_ENCRYPTION_KEY 尚未配置',
      proxy_database_error: '代理数据库不可用，请执行最新 D1 迁移',
      proxy_decryption_failed: '代理无法解密，请确认 PROXY_ENCRYPTION_KEY 未被更换',
      relay_not_configured: '尚未配置 RELAY_CONFIG，无法使用或测试代理',
      relay_config_invalid: 'RELAY_CONFIG 格式或地址不正确',
      invalid_proxy_url: '代理地址格式不正确，请使用完整 URL',
      unsupported_proxy_protocol: '代理仅支持 http:// 或 https://',
      invalid_proxy_import: '导入内容为空、重复或格式不正确',
      proxy_not_found: '该国家尚未保存代理',
      proxy_test_failed: '代理连通性测试失败，请检查地址、凭据和 Relay',
      unsupported_country: '国家代码不在支持清单中',
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
      dom.proxyUrl.value = '';
      dom.proxyBatch.value = '';
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
    return api('/api/admin/cdks?limit=500', { method: 'GET' })
      .then(function (data) {
        renderStats(data.stats || {});
        renderRecords(data.records || []);
      });
  }

  function testStatusMeta(record) {
    if (!record || record.testStatus === 'untested') return { label: '未测试', cls: 'is-untested' };
    if (record.testStatus === 'healthy') return { label: '连接正常', cls: 'is-healthy' };
    return { label: '测试失败', cls: 'is-failed' };
  }

  function testProxy(country, button) {
    button.disabled = true;
    button.textContent = '测试中…';
    api('/api/admin/proxies/' + country.code + '/test', { method: 'POST' })
      .then(function (data) {
        setMessage(dom.proxyMessage, country.name + '代理可用，出口 IP ' + data.exitIp + '，延迟 ' + data.latencyMs + 'ms。', 'success');
      })
      .catch(function (error) {
        setMessage(dom.proxyMessage, country.name + '：' + friendlyError(error), 'error');
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = '测试连接';
        return loadProxyRoutes().catch(function (error) {
          setMessage(dom.proxyMessage, friendlyError(error), 'error');
        });
      });
  }

  function deleteProxy(country, record, button) {
    if (!window.confirm('确认删除 ' + country.name + ' 的代理 ' + record.displayUrl + '？')) return;
    button.disabled = true;
    api('/api/admin/proxies/' + country.code, { method: 'DELETE' })
      .then(function () {
        setMessage(dom.proxyMessage, country.name + '代理已删除。', 'success');
        return loadProxyRoutes();
      })
      .catch(function (error) {
        button.disabled = false;
        setMessage(dom.proxyMessage, friendlyError(error), 'error');
      });
  }

  function renderProxyRoutes(records) {
    var byCountry = {};
    records.forEach(function (record) { byCountry[record.country] = record; });
    dom.proxyCount.textContent = records.length + ' / ' + countries.length + ' 已配置';
    dom.proxyRouteGrid.textContent = '';

    countries.forEach(function (country) {
      var record = byCountry[country.code];
      var status = testStatusMeta(record);
      var card = el('article', { cls: 'proxy-route-card ' + (record ? 'is-configured' : 'is-empty') });
      var heading = el('div', { cls: 'proxy-route-heading', children: [
        el('span', { cls: 'proxy-flag', text: country.flag }),
        el('div', { children: [el('strong', { text: country.name }), el('small', { text: country.code })] }),
        el('span', { cls: 'proxy-test-state ' + status.cls, text: record ? status.label : '未配置' })
      ] });
      card.appendChild(heading);

      if (record) {
        card.appendChild(el('code', { cls: 'proxy-display-url', text: record.displayUrl }));
        var testDetail = record.lastTestedAt
          ? (record.exitIp ? '出口 ' + record.exitIp + ' · ' : '') +
            (record.latencyMs == null ? '' : record.latencyMs + 'ms · ') + formatDate(record.lastTestedAt)
          : '保存于 ' + formatDate(record.updatedAt) + '，等待连通性测试';
        card.appendChild(el('p', { cls: 'proxy-route-meta', text: testDetail }));
        var testButton = el('button', { cls: 'proxy-test-btn', text: '测试连接', attrs: { type: 'button' } });
        var deleteButton = el('button', { cls: 'proxy-delete-btn', text: '删除', attrs: { type: 'button' } });
        testButton.addEventListener('click', function (event) {
          event.stopPropagation();
          testProxy(country, testButton);
        });
        deleteButton.addEventListener('click', function (event) {
          event.stopPropagation();
          deleteProxy(country, record, deleteButton);
        });
        card.appendChild(el('div', { cls: 'proxy-route-actions', children: [testButton, deleteButton] }));
      } else {
        card.appendChild(el('p', { cls: 'proxy-empty-copy', text: '点击卡片，在上方导入这个国家的代理。' }));
      }
      card.addEventListener('click', function () {
        dom.proxyCountry.value = country.code;
        dom.proxyUrl.focus();
      });
      dom.proxyRouteGrid.appendChild(card);
    });
  }

  function loadProxyRoutes() {
    return api('/api/admin/proxies', { method: 'GET' }).then(function (data) {
      renderProxyRoutes(data.records || []);
    });
  }

  function loadDashboard() {
    dom.refreshBtn.disabled = true;
    dom.refreshBtn.textContent = '正在刷新…';
    return loadRecords()
      .then(function () {
        return loadProxyRoutes().catch(function (error) {
          renderProxyRoutes([]);
          setMessage(dom.proxyMessage, friendlyError(error), 'error');
        });
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
    loadDashboard()
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

  function onSaveProxy(event) {
    event.preventDefault();
    var country = dom.proxyCountry.value;
    var proxyUrl = dom.proxyUrl.value.trim();
    dom.saveProxyBtn.disabled = true;
    dom.saveProxyBtn.textContent = '保存中…';
    setMessage(dom.proxyMessage, '');
    api('/api/admin/proxies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: country, proxyUrl: proxyUrl })
    })
      .then(function () {
        dom.proxyUrl.value = '';
        setMessage(dom.proxyMessage, country + ' 代理已加密保存，明文已从输入框清除。', 'success');
        return loadProxyRoutes();
      })
      .catch(function (error) { setMessage(dom.proxyMessage, friendlyError(error), 'error'); })
      .finally(function () {
        dom.saveProxyBtn.disabled = false;
        dom.saveProxyBtn.textContent = '加密保存';
      });
  }

  function parseProxyBatch(raw) {
    var text = raw.trim();
    if (!text) throw new Error('invalid_proxy_import');
    var routes = {};
    if (text.charAt(0) === '{') {
      var parsed;
      try { parsed = JSON.parse(text); } catch (error) { throw new Error('invalid_proxy_import'); }
      var source = parsed && parsed.routes ? parsed.routes : parsed;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid_proxy_import');
      Object.keys(source).forEach(function (country) {
        routes[country.toUpperCase()] = source[country];
      });
    } else {
      text.split(/\r?\n/).forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#') return;
        var separator = trimmed.indexOf('=');
        if (separator < 1) throw new Error('invalid_proxy_import');
        routes[trimmed.slice(0, separator).trim().toUpperCase()] = trimmed.slice(separator + 1).trim();
      });
    }
    var allowed = countries.map(function (country) { return country.code; });
    var keys = Object.keys(routes);
    if (!keys.length || keys.some(function (country) {
      return allowed.indexOf(country) < 0 || typeof routes[country] !== 'string' || !routes[country].trim();
    })) throw new Error('invalid_proxy_import');
    return routes;
  }

  function onBatchProxy(event) {
    event.preventDefault();
    var routes;
    try {
      routes = parseProxyBatch(dom.proxyBatch.value);
    } catch (error) {
      setMessage(dom.proxyBatchMessage, friendlyError(error), 'error');
      return;
    }
    dom.batchProxyBtn.disabled = true;
    dom.batchProxyBtn.textContent = '导入中…';
    setMessage(dom.proxyBatchMessage, '');
    api('/api/admin/proxies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes: routes })
    })
      .then(function (data) {
        dom.proxyBatch.value = '';
        setMessage(dom.proxyBatchMessage, '已加密导入 ' + data.savedCountries.length + ' 个国家，明文已清除。', 'success');
        return loadProxyRoutes();
      })
      .catch(function (error) { setMessage(dom.proxyBatchMessage, friendlyError(error), 'error'); })
      .finally(function () {
        dom.batchProxyBtn.disabled = false;
        dom.batchProxyBtn.textContent = '批量加密导入';
      });
  }

  function bind() {
    dom.loginForm.addEventListener('submit', onLogin);
    dom.generateForm.addEventListener('submit', onGenerate);
    dom.proxyForm.addEventListener('submit', onSaveProxy);
    dom.proxyBatchForm.addEventListener('submit', onBatchProxy);
    dom.refreshBtn.addEventListener('click', function () {
      loadDashboard().catch(function (error) { window.alert(friendlyError(error)); });
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
      tableBody: $('cdk-table-body'), tableEmpty: $('table-empty'), proxyCount: $('proxy-count'),
      proxyForm: $('proxy-form'), proxyCountry: $('proxy-country'), proxyUrl: $('proxy-url'),
      saveProxyBtn: $('save-proxy-btn'), proxyMessage: $('proxy-message'),
      proxyBatchForm: $('proxy-batch-form'), proxyBatch: $('proxy-batch'),
      batchProxyBtn: $('batch-proxy-btn'), proxyBatchMessage: $('proxy-batch-message'),
      proxyRouteGrid: $('proxy-route-grid')
    };
    bind();
    setAuthenticated(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
