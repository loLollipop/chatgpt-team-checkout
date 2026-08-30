/* ChatGPT Team 支付长链生成器 - 前端逻辑
 * 零依赖；不持久化；国家和代理状态由 /api/config 下发。
 */
(function () {
  'use strict';

  var DEFAULT_WORKSPACE = 'myWorkspace';
  var MIN_SEATS = 2;
  var MAX_SEATS = 999;
  var BILLING_LABELS = { month: '按月付', year: '按年付' };
  var MIN_TOKEN_LENGTH = 40;
  var API_BASE = (typeof location !== 'undefined' && location.hostname === 'localhost')
    ? 'http://127.0.0.1:8787'
    : '';

  var dom = {};
  var appConfig = null;
  var selectedCountry = null;
  var configurationReady = false;
  var requestBusy = false;
  var cdkVerified = false;
  var cdkValue = '';
  var cdkVerifyBusy = false;
  var cdkAccessMeta = null;

  function $(id) { return document.getElementById(id); }

  function el(tag, options) {
    var node = document.createElement(tag);
    if (!options) return node;
    if (options.cls) node.className = options.cls;
    if (options.text != null) node.textContent = String(options.text);
    if (options.attrs) {
      Object.keys(options.attrs).forEach(function (key) {
        node.setAttribute(key, options.attrs[key]);
      });
    }
    if (options.children) {
      options.children.forEach(function (child) { node.appendChild(child); });
    }
    return node;
  }

  function maskToken(token) {
    return token ? String(token).slice(0, 12) + '…' : '';
  }

  function parseAccessToken(raw) {
    if (raw == null) return { token: '', source: 'unknown' };
    var trimmed = String(raw).trim();
    if (!trimmed) return { token: '', source: 'unknown' };
    if (/^bearer\s+/i.test(trimmed)) {
      return { token: trimmed.replace(/^bearer\s+/i, '').trim(), source: 'bearer' };
    }
    if (trimmed.charAt(0) === '{') {
      try {
        var value = JSON.parse(trimmed);
        var inner = (value && (value.accessToken || value.access_token)) || '';
        if (inner) return { token: String(inner), source: 'json' };
      } catch (error) {
        return { token: '', source: 'unknown' };
      }
      return { token: '', source: 'unknown' };
    }
    var cleaned = trimmed.replace(/\s+/g, '');
    return { token: cleaned, source: /^eyJ/i.test(cleaned) ? 'raw' : 'unknown' };
  }

  function normalizeCdk(raw) {
    var compact = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    var groups = [];
    for (var index = 0; index < compact.length; index += 4) groups.push(compact.slice(index, index + 4));
    return groups.join('-');
  }

  function setCdkStatus(state, message) {
    dom.cdkStatus.dataset.state = state;
    dom.cdkStatusText.textContent = message;
  }

  function setToolUnlocked(unlocked) {
    cdkVerified = Boolean(unlocked);
    dom.toolContent.classList.toggle('is-locked', !cdkVerified);
    dom.toolContent.setAttribute('aria-disabled', String(!cdkVerified));
    Array.prototype.forEach.call(
      dom.toolContent.querySelectorAll('input, textarea, button'),
      function (control) { control.disabled = !cdkVerified; }
    );
    if (dom.countryTrigger) dom.countryTrigger.disabled = !cdkVerified || !configurationReady;
    updateSeatControls();
    updateGenerateState();
  }

  function setCdkVerifyBusy(busy) {
    cdkVerifyBusy = Boolean(busy);
    dom.cdkInput.disabled = cdkVerifyBusy;
    dom.cdkVerifyBtn.disabled = cdkVerifyBusy;
    dom.cdkVerifyBtn.classList.toggle('is-busy', cdkVerifyBusy);
    dom.cdkVerifyLabel.textContent = cdkVerifyBusy ? '正在校核…' : (cdkVerified ? '重新校核' : '校核 CDK');
  }

  function cdkStatusSummary(data) {
    var parts = ['验证通过', '剩余 ' + data.remainingUses + '/' + data.maxUses + ' 次'];
    if (data.expiresAt) parts.push('有效期至 ' + new Date(data.expiresAt).toLocaleDateString('zh-CN'));
    else parts.push('长期有效');
    if (data.label) parts.push(data.label);
    return parts.join(' · ');
  }

  function friendlyCdkError(error, retryAfterSec) {
    var messages = {
      cdk_invalid_format: 'CDK 格式不正确，请输入 16 位授权码',
      cdk_invalid: 'CDK 不存在或输入有误',
      cdk_revoked: '该 CDK 已被管理员吊销',
      cdk_expired: '该 CDK 已过期',
      cdk_exhausted: '该 CDK 的可用次数已耗尽',
      cdk_service_not_configured: 'CDK 服务尚未完成后台配置',
      cdk_database_error: 'CDK 数据库不可用，请联系管理员检查 D1 迁移',
      cdk_verify_rate_limited: '校核过于频繁，请在 ' + (retryAfterSec || 60) + ' 秒后重试'
    };
    return messages[error] || 'CDK 校核失败，请稍后重试';
  }

  function invalidateCdk(error, retryAfterSec) {
    cdkValue = '';
    cdkAccessMeta = null;
    setToolUnlocked(false);
    setCdkStatus('invalid', friendlyCdkError(error, retryAfterSec));
    setCdkVerifyBusy(false);
  }

  function verifyCdkAccess() {
    if (cdkVerifyBusy) return;
    var normalized = normalizeCdk(dom.cdkInput.value);
    dom.cdkInput.value = normalized;
    if (normalized.length !== 19) {
      invalidateCdk('cdk_invalid_format');
      return;
    }

    setCdkVerifyBusy(true);
    setCdkStatus('checking', '正在通过服务端校核授权状态…');
    fetch(API_BASE + '/api/cdk/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cdk: normalized }),
      credentials: 'omit'
    })
      .then(function (response) {
        return response.json()
          .then(function (data) { return { ok: response.ok, data: data }; })
          .catch(function () { return { ok: false, data: { error: 'invalid_response' } }; });
      })
      .then(function (response) {
        if (!response.ok || !response.data.ok) {
          invalidateCdk(response.data.error, response.data.retryAfterSec);
          return;
        }
        cdkValue = normalized;
        cdkAccessMeta = response.data;
        setToolUnlocked(true);
        setCdkStatus('valid', cdkStatusSummary(response.data));
        setCdkVerifyBusy(false);
      })
      .catch(function () {
        invalidateCdk('network_error');
        setCdkStatus('invalid', 'CDK 校核请求失败，请检查网络后重试');
      });
  }

  function updateGenerateState() {
    if (!dom.generateBtn) return;
    dom.generateBtn.disabled = requestBusy || !configurationReady || !cdkVerified;
    var label = dom.generateBtn.querySelector('.label-text');
    if (label) {
      label.textContent = requestBusy
        ? '正在生成…'
        : configurationReady && cdkVerified
          ? '生成 Team 支付长链'
          : !cdkVerified
            ? '请先校核 CDK'
            : '正在读取配置…';
    }
  }

  function setBusy(busy) {
    requestBusy = Boolean(busy);
    if (dom.generateBtn) dom.generateBtn.classList.toggle('is-busy', requestBusy);
    updateGenerateState();
  }

  function clearResult() {
    if (!dom.result) return;
    dom.result.textContent = '';
    dom.result.removeAttribute('data-kind');
  }

  function copyToClipboard(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      window.prompt('请手动复制下面的链接：', text);
      return true;
    } catch (error) {
      return false;
    }
  }

  function proxyStatusFor(country) {
    if (country.proxyConfigInvalid) {
      return { label: '配置有误', state: 'invalid' };
    }
    if (country.proxyConfigured) {
      return { label: '代理已就绪', state: 'ready' };
    }
    if (appConfig && !appConfig.proxyRequired) {
      return { label: '允许直连', state: 'direct' };
    }
    return { label: '待配置代理', state: 'missing' };
  }

  function countrySearchText(country) {
    return [country.name, country.code, country.currency, country.pinyin, country.localPrice]
      .join(' ')
      .toLowerCase();
  }

  function sortedCountries() {
    return (appConfig.countries || []).slice().sort(function (left, right) {
      return Number(left.usdPrice) - Number(right.usdPrice);
    });
  }

  function countryFlag(country) {
    return el('img', {
      cls: 'country-flag',
      attrs: {
        src: 'https://flagcdn.com/w80/' + country.code.toLowerCase() + '.png',
        alt: country.name + '国旗',
        width: '42',
        height: '28'
      }
    });
  }

  function renderCountryTrigger() {
    if (!selectedCountry) return;
    var status = proxyStatusFor(selectedCountry);
    dom.countryTrigger.textContent = '';
    dom.countryTrigger.appendChild(countryFlag(selectedCountry));
    dom.countryTrigger.appendChild(el('span', {
      cls: 'country-trigger-copy',
      children: [
        el('strong', { text: selectedCountry.name + '（' + selectedCountry.code + '）' }),
        el('small', { text: '结算货币 ' + selectedCountry.currency + ' · 本地 ' + selectedCountry.localPrice })
      ]
    }));
    dom.countryTrigger.appendChild(el('span', {
      cls: 'country-trigger-price',
      children: [
        el('strong', { text: '$' + selectedCountry.usdPrice }),
        el('small', { text: '美元参考' })
      ]
    }));
    dom.countryTrigger.appendChild(el('span', {
      cls: 'proxy-state',
      text: status.label,
      attrs: { 'data-state': status.state }
    }));
    dom.countryTrigger.appendChild(el('span', { cls: 'country-chevron', attrs: { 'aria-hidden': 'true' } }));
  }

  function renderCountryOptions(query) {
    var normalizedQuery = String(query || '').trim().toLowerCase();
    var matches = sortedCountries().filter(function (country) {
      return !normalizedQuery || countrySearchText(country).indexOf(normalizedQuery) >= 0;
    });
    dom.countryOptions.textContent = '';
    if (!matches.length) {
      dom.countryOptions.appendChild(el('div', { cls: 'country-empty', text: '没有找到匹配的国家或货币' }));
      return;
    }
    matches.forEach(function (country) {
      var status = proxyStatusFor(country);
      var option = el('button', {
        cls: 'country-option-row',
        attrs: {
          type: 'button',
          role: 'option',
          'aria-selected': String(Boolean(selectedCountry && selectedCountry.code === country.code)),
          'data-country': country.code
        },
        children: [
          countryFlag(country),
          el('span', {
            cls: 'country-option-identity',
            children: [
              el('strong', { text: country.name + '（' + country.code + '）' }),
              el('small', { text: country.currency + ' · ' + status.label, attrs: { 'data-state': status.state } })
            ]
          }),
          el('span', {
            cls: 'country-option-price',
            children: [
              el('strong', { text: '$' + country.usdPrice }),
              el('small', { text: country.localPrice })
            ]
          }),
          el('span', { cls: 'country-option-check', text: '✓', attrs: { 'aria-hidden': 'true' } })
        ]
      });
      option.disabled = !cdkVerified;
      option.addEventListener('click', function () {
        selectCountry(country);
        clearResult();
      });
      dom.countryOptions.appendChild(option);
    });
  }

  function closeCountryMenu() {
    dom.countryMenu.hidden = true;
    dom.countryTrigger.setAttribute('aria-expanded', 'false');
    dom.countryPicker.classList.remove('is-open');
  }

  function openCountryMenu() {
    if (!cdkVerified || !configurationReady) return;
    dom.countrySearch.value = '';
    renderCountryOptions('');
    dom.countryMenu.hidden = false;
    dom.countryTrigger.setAttribute('aria-expanded', 'true');
    dom.countryPicker.classList.add('is-open');
    dom.countrySearch.focus();
  }

  function selectCountry(country) {
    selectedCountry = country;
    renderCountryTrigger();
    renderCountryOptions(dom.countrySearch.value);
    updateCountrySelection();
    closeCountryMenu();
  }

  function renderCountryPicker() {
    dom.countryPicker.classList.remove('is-loading');
    var defaultCode = appConfig.defaultCountry;
    selectedCountry = appConfig.countries.find(function (country) { return country.code === defaultCode; }) || appConfig.countries[0];
    renderCountryTrigger();
    renderCountryOptions('');
    updateCountrySelection();
  }

  function updateCountrySelection() {
    if (!selectedCountry) {
      dom.countrySelection.textContent = '请选择一个地区';
      dom.countrySelection.dataset.state = 'empty';
      return;
    }
    var status = proxyStatusFor(selectedCountry);
    var routeText = selectedCountry.proxyConfigured
      ? '结算请求将通过' + selectedCountry.name + '代理转发'
      : (appConfig && !appConfig.proxyRequired)
        ? '当前后台允许直接请求'
        : '生成前需要先在后台配置该国家代理';
    dom.countrySelection.textContent = '已选择 ' + selectedCountry.code + ' · ' + selectedCountry.currency + ' — ' + routeText;
    dom.countrySelection.dataset.state = status.state;
  }

  function updateProxyOverview() {
    var countries = appConfig.countries || [];
    var configured = countries.filter(function (country) { return country.proxyConfigured; }).length;
    if (!appConfig.configValid) {
      dom.proxyOverview.textContent = '后台代理 JSON 配置有误';
      dom.proxyOverview.dataset.state = 'invalid';
      return;
    }
    if (!appConfig.proxyRequired) {
      dom.proxyOverview.textContent = configured + '/' + countries.length + ' 个代理已就绪 · 允许直连';
      dom.proxyOverview.dataset.state = 'direct';
      return;
    }
    dom.proxyOverview.textContent = configured + '/' + countries.length + ' 个国家代理已就绪';
    dom.proxyOverview.dataset.state = configured === countries.length ? 'ready' : 'partial';
  }

  function loadConfiguration() {
    configurationReady = false;
    updateGenerateState();
    return fetch(API_BASE + '/api/config', { method: 'GET', credentials: 'omit', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.countries) || !data.countries.length) {
          throw new Error('国家配置为空');
        }
        appConfig = data;
        if (!data.cdkServiceReady) {
          invalidateCdk('cdk_service_not_configured');
        }
        renderCountryPicker();
        updateProxyOverview();
        configurationReady = true;
        dom.countryTrigger.disabled = !cdkVerified;
        updateSeatControls();
        updateGenerateState();
      })
      .catch(function (error) {
        dom.countryPicker.classList.remove('is-loading');
        dom.countryTrigger.textContent = '无法读取国家与代理配置：' + (error && error.message ? error.message : String(error));
        dom.countryTrigger.disabled = true;
        closeCountryMenu();
        dom.proxyOverview.textContent = '配置读取失败';
        dom.proxyOverview.dataset.state = 'invalid';
        configurationReady = false;
        updateGenerateState();
      });
  }

  function updateTokenMeta(raw) {
    if (raw == null || String(raw).trim() === '') {
      dom.tokenMeta.textContent = '未输入';
      dom.tokenMeta.dataset.state = 'empty';
      return;
    }
    var parsed = parseAccessToken(raw);
    if (!parsed.token) {
      dom.tokenMeta.textContent = '无法识别 Token 格式，请粘贴 eyJ… 或 session JSON';
      dom.tokenMeta.dataset.state = 'invalid';
      return;
    }
    if (parsed.token.length < MIN_TOKEN_LENGTH) {
      dom.tokenMeta.textContent = 'Token 过短：当前 ' + parsed.token.length + ' 字符';
      dom.tokenMeta.dataset.state = 'invalid';
      return;
    }
    dom.tokenMeta.textContent = '已识别 ' + maskToken(parsed.token) + ' · ' + parsed.token.length + ' 字符';
    dom.tokenMeta.dataset.state = 'ok';
  }

  function generateDeviceId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
      var values = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(values);
      var hex = '';
      for (var index = 0; index < values.length; index += 1) {
        hex += (values[index] < 16 ? '0' : '') + values[index].toString(16);
      }
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    } catch (error) {
      return 'produced-' + Date.now().toString(36);
    }
  }
  var DEVICE_ID = generateDeviceId();

  function readSeatCount(input) {
    return Number(input.value);
  }

  function selectedBillingPeriod() {
    var selected = document.querySelector('input[name="billing-period"]:checked');
    return selected ? selected.value : 'month';
  }

  function updateSeatControls() {
    if (!dom.seatDefault || !dom.seatProlite || !dom.seatTotal) return;
    var seatDefault = readSeatCount(dom.seatDefault);
    var seatProlite = readSeatCount(dom.seatProlite);
    var safeDefault = Number.isInteger(seatDefault) && seatDefault >= 0 ? seatDefault : 0;
    var safeProlite = Number.isInteger(seatProlite) && seatProlite >= 0 ? seatProlite : 0;
    var total = safeDefault + safeProlite;
    dom.seatTotal.textContent = '合计 ' + total + ' 席';
    dom.seatTotal.dataset.state = total >= MIN_SEATS && total <= MAX_SEATS ? 'valid' : 'invalid';
    Array.prototype.forEach.call(dom.seatStepButtons || [], function (button) {
      var input = $(button.dataset.seatTarget);
      var value = readSeatCount(input);
      var nextValue = value + Number(button.dataset.step);
      button.disabled = !cdkVerified || !Number.isInteger(value) || nextValue < 0 || nextValue > MAX_SEATS;
    });
  }

  function changeSeatCount(button) {
    var input = $(button.dataset.seatTarget);
    var current = readSeatCount(input);
    if (!Number.isInteger(current)) current = 0;
    var next = Math.max(0, Math.min(MAX_SEATS, current + Number(button.dataset.step)));
    input.value = String(next);
    updateSeatControls();
    clearResult();
  }

  function buildPayload() {
    var parsed = parseAccessToken(dom.tokenInput.value);
    var promoCode = String(dom.promoInput.value || '').trim();
    var payload = {
      accessToken: parsed.token,
      country: selectedCountry.code,
      currency: selectedCountry.currency,
      workspaceName: String(dom.workspaceName.value || DEFAULT_WORKSPACE).slice(0, 80),
      seatDefault: readSeatCount(dom.seatDefault),
      seatProlite: readSeatCount(dom.seatProlite),
      billingPeriod: selectedBillingPeriod(),
      deviceId: DEVICE_ID
    };
    payload.cdk = cdkValue;
    if (promoCode) payload.promoCode = promoCode;
    return payload;
  }

  function validateForm() {
    if (!cdkVerified || !cdkValue) return '请先输入并校核有效的 CDK';
    if (!configurationReady || !selectedCountry) return '国家配置尚未加载完成';
    if (selectedCountry.proxyConfigInvalid) return selectedCountry.code + ' 的后台代理配置格式有误';
    if (appConfig.proxyRequired && !selectedCountry.proxyConfigured) {
      return selectedCountry.code + ' 尚未配置国家代理，请先在 Worker 后台完成配置';
    }
    var parsed = parseAccessToken(dom.tokenInput.value);
    if (!parsed.token) return '请先粘贴有效的 Access Token';
    if (parsed.token.length < MIN_TOKEN_LENGTH) return 'Access Token 过短（少于 ' + MIN_TOKEN_LENGTH + ' 字符）';
    var seatDefault = readSeatCount(dom.seatDefault);
    var seatProlite = readSeatCount(dom.seatProlite);
    if (
      !Number.isInteger(seatDefault) || seatDefault < 0 || seatDefault > MAX_SEATS ||
      !Number.isInteger(seatProlite) || seatProlite < 0 || seatProlite > MAX_SEATS
    ) {
      return '标准席位和高级席位都必须是 0–' + MAX_SEATS + ' 之间的整数';
    }
    var totalSeats = seatDefault + seatProlite;
    var minSeats = Number(appConfig.minSeats) || MIN_SEATS;
    if (totalSeats < minSeats || totalSeats > MAX_SEATS) {
      return '标准席位与高级席位合计必须是 ' + minSeats + '–' + MAX_SEATS + ' 席';
    }
    if (!BILLING_LABELS[selectedBillingPeriod()]) return '请选择按月付或按年付';
    return '';
  }

  function onGenerate(event) {
    if (event) event.preventDefault();
    clearResult();
    var validationError = validateForm();
    if (validationError) {
      showError(validationError);
      return;
    }

    var payload = buildPayload();
    window.App = window.App || {};
    window.App._lastPayload = {
      country: payload.country,
      currency: payload.currency,
      workspaceName: payload.workspaceName,
      seatDefault: payload.seatDefault,
      seatProlite: payload.seatProlite,
      billingPeriod: payload.billingPeriod,
      promoCode: payload.promoCode || '',
      deviceId: maskToken(payload.deviceId),
      accessTokenPreview: maskToken(payload.accessToken)
    };

    setBusy(true);
    fetch(API_BASE + '/api/checkout/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit'
    })
      .then(function (response) {
        return response.json()
          .then(function (data) { return { status: response.status, ok: response.ok, data: data }; })
          .catch(function () { return { status: response.status, ok: response.ok, data: {} }; });
      })
      .then(function (response) {
        var data = response.data || {};
        if (response.ok && data.ok && data.url) {
          renderSuccess(data);
          if (typeof data.cdkRemainingUses === 'number') {
            cdkAccessMeta = cdkAccessMeta || {};
            cdkAccessMeta.remainingUses = data.cdkRemainingUses;
            cdkAccessMeta.expiresAt = data.cdkExpiresAt || cdkAccessMeta.expiresAt || '';
            cdkAccessMeta.label = cdkAccessMeta.label || '本次使用已计入';
            setCdkStatus('valid', cdkStatusSummary(cdkAccessMeta));
          }
          if (dom.autoOpen.checked) {
            try {
              var opened = window.open(data.url, '_blank', 'noopener,noreferrer');
              if (!opened) appendWarning('浏览器拦截了弹窗，请点击“打开支付”');
            } catch (error) {
              appendWarning('自动打开失败，请点击“打开支付”');
            }
          }
        } else {
          renderFailure(response.status, data);
        }
      })
      .catch(function (error) {
        showError('网络请求失败：' + (error && error.message ? error.message : String(error)));
      })
      .then(function () { setBusy(false); });
  }

  function showError(message) {
    clearResult();
    dom.result.dataset.kind = 'error';
    dom.result.appendChild(el('div', {
      cls: 'result-panel',
      children: [
        el('div', { cls: 'result-icon', text: '!' }),
        el('div', {
          children: [
            el('div', { cls: 'result-title', text: '暂时无法生成' }),
            el('div', { cls: 'result-message', text: message })
          ]
        })
      ]
    }));
  }

  function appendWarning(message) {
    dom.result.appendChild(el('div', { cls: 'result-warning', text: message }));
  }

  function renderSuccess(data) {
    var seatSummary = '标准 ' + data.seatDefault + ' + 高级 ' + data.seatProlite + '（共 ' + data.seatQuantity + ' 席）';
    var billingLabel = BILLING_LABELS[data.billingPeriod] || data.billingPeriod || '按月付';
    var summary = '空间 ' + (data.workspaceName || '') + ' · ' + seatSummary + ' · ' + billingLabel + ' · ' + data.country + '/' + data.currency;
    if (data.promoCode) summary += ' · 优惠码 ' + data.promoCode;

    var details = [
      el('div', { cls: 'result-title', text: '支付长链已生成' }),
      el('div', { cls: 'result-message', text: summary }),
      el('div', {
        cls: 'route-confirmation',
        text: data.proxyUsed ? '✓ 已通过 ' + data.country + ' 国家代理转发' : '当前请求使用直连模式'
      })
    ];
    if (data.sessionId) {
      details.push(el('div', {
        cls: 'result-code-line',
        children: [el('span', { text: 'SESSION' }), el('code', { text: data.sessionId })]
      }));
    }

    var link = el('a', {
      cls: 'result-url',
      text: data.url,
      attrs: { href: data.url, target: '_blank', rel: 'noopener noreferrer' }
    });
    details.push(link);

    var copyButton = el('button', { cls: 'primary result-button', text: '复制链接', attrs: { type: 'button' } });
    copyButton.addEventListener('click', function () {
      copyToClipboard(data.url).then(function (copied) {
        copyButton.textContent = copied ? '已复制' : '复制失败';
        setTimeout(function () { copyButton.textContent = '复制链接'; }, 1500);
      });
    });
    var openButton = el('button', { cls: 'ghost result-button', text: '打开支付', attrs: { type: 'button' } });
    openButton.addEventListener('click', function () {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    });
    details.push(el('div', { cls: 'result-actions', children: [copyButton, openButton] }));

    clearResult();
    dom.result.dataset.kind = 'success';
    dom.result.appendChild(el('div', {
      cls: 'result-panel',
      children: [
        el('div', { cls: 'result-icon', text: '✓' }),
        el('div', { cls: 'result-content', children: details })
      ]
    }));
  }

  function friendlyError(status, data) {
    if (/^cdk_/.test(data.error || '')) return friendlyCdkError(data.error, data.retryAfterSec);
    if (data.error === 'proxy_not_configured') return data.country + ' 尚未配置国家代理';
    if (data.error === 'proxy_config_invalid') return data.country + ' 的国家代理配置格式有误';
    if (data.error === 'unsupported_country') return '所选国家不在后台允许列表中';
    if (data.error === 'rate_limited') return '请求过于频繁，请在 ' + data.retryAfterSec + ' 秒后重试';
    if (data.error === 'invalid_seat_quantity') return '席位数量必须是 ' + data.min + '–' + data.max + ' 之间的整数';
    if (data.error === 'invalid_seat_type') return '请选择标准席位或高级席位';
    if (data.error === 'invalid_billing_period') return '请选择按月付或按年付';
    if (data.message) return data.message;
    if (data.error) return '错误码：' + data.error;
    return 'HTTP ' + status;
  }

  function renderFailure(status, data) {
    if (/^cdk_/.test((data && data.error) || '')) {
      invalidateCdk(data.error, data.retryAfterSec);
    }
    var message = friendlyError(status, data || {});
    var detailChildren = [
      el('div', { cls: 'result-title', text: '生成失败' }),
      el('div', { cls: 'result-message', text: message })
    ];
    var attempts = (data && data.attempts) || [];
    if (attempts.length) {
      var details = el('details', { cls: 'attempts' });
      details.appendChild(el('summary', { text: '查看请求记录（' + attempts.length + '）' }));
      var list = el('ul');
      attempts.forEach(function (attempt) {
        list.appendChild(el('li', {
          text: (attempt.origin || '-') + ' → ' + (attempt.status === 0 ? '网络错误' : 'HTTP ' + attempt.status) + (attempt.viaProxy ? ' · 国家代理' : ' · 直连')
        }));
      });
      details.appendChild(list);
      detailChildren.push(details);
    }

    clearResult();
    dom.result.dataset.kind = 'error';
    dom.result.appendChild(el('div', {
      cls: 'result-panel',
      children: [
        el('div', { cls: 'result-icon', text: '!' }),
        el('div', { cls: 'result-content', children: detailChildren })
      ]
    }));
  }

  function onClear() {
    dom.checkoutForm.reset();
    cdkValue = '';
    cdkAccessMeta = null;
    setToolUnlocked(false);
    setCdkStatus('locked', '等待验证，下面的工具暂未解锁');
    setCdkVerifyBusy(false);
    dom.workspaceName.value = DEFAULT_WORKSPACE;
    dom.seatDefault.value = '2';
    dom.seatProlite.value = '0';
    dom.countrySearch.value = '';
    var defaultCode = appConfig && appConfig.defaultCountry;
    if (appConfig) {
      selectedCountry = appConfig.countries.find(function (country) { return country.code === defaultCode; }) || selectedCountry;
      renderCountryTrigger();
      renderCountryOptions('');
    }
    closeCountryMenu();
    updateCountrySelection();
    updateSeatControls();
    updateTokenMeta('');
    clearResult();
  }

  function bind() {
    dom.cdkInput.addEventListener('input', function () {
      dom.cdkInput.value = normalizeCdk(dom.cdkInput.value);
      if (cdkVerified && dom.cdkInput.value !== cdkValue) {
        cdkValue = '';
        setToolUnlocked(false);
        setCdkStatus('locked', 'CDK 已变更，请重新校核');
      }
    });
    dom.cdkInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        verifyCdkAccess();
      }
    });
    dom.cdkVerifyBtn.addEventListener('click', verifyCdkAccess);
    dom.tokenInput.addEventListener('input', function () { updateTokenMeta(dom.tokenInput.value); });
    dom.countryTrigger.addEventListener('click', function () {
      if (dom.countryMenu.hidden) openCountryMenu();
      else closeCountryMenu();
    });
    dom.countrySearch.addEventListener('input', function () { renderCountryOptions(dom.countrySearch.value); });
    dom.countryMenu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeCountryMenu();
        dom.countryTrigger.focus();
      }
    });
    document.addEventListener('click', function (event) {
      if (!dom.countryPicker.contains(event.target)) closeCountryMenu();
    });
    Array.prototype.forEach.call(dom.seatStepButtons, function (button) {
      button.addEventListener('click', function () { changeSeatCount(button); });
    });
    [dom.seatDefault, dom.seatProlite].forEach(function (input) {
      input.addEventListener('input', function () {
        updateSeatControls();
        clearResult();
      });
      input.addEventListener('change', function () {
        var value = readSeatCount(input);
        if (!Number.isFinite(value)) value = 0;
        input.value = String(Math.max(0, Math.min(MAX_SEATS, Math.trunc(value))));
        updateSeatControls();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="billing-period"]'), function (input) {
      input.addEventListener('change', clearResult);
    });
    dom.checkoutForm.addEventListener('submit', onGenerate);
    dom.clearBtn.addEventListener('click', onClear);
  }

  function init() {
    dom = {
      checkoutForm: $('checkout-form'),
      toolContent: $('tool-content'),
      cdkInput: $('cdk-input'),
      cdkVerifyBtn: $('cdk-verify-btn'),
      cdkVerifyLabel: document.querySelector('.cdk-verify-label'),
      cdkStatus: $('cdk-status'),
      cdkStatusText: document.querySelector('.cdk-status-text'),
      countryPicker: $('country-picker'),
      countryTrigger: $('country-trigger'),
      countryMenu: $('country-menu'),
      countrySearch: $('country-search'),
      countryOptions: $('country-options'),
      countrySelection: $('country-selection'),
      proxyOverview: $('proxy-overview'),
      tokenInput: $('token-input'),
      tokenMeta: $('token-meta'),
      workspaceName: $('workspace-name'),
      seatDefault: $('seat-default'),
      seatProlite: $('seat-prolite'),
      seatTotal: $('seat-total'),
      seatStepButtons: document.querySelectorAll('.seat-step'),
      promoInput: $('promo-input'),
      autoOpen: $('auto-open'),
      generateBtn: $('generate-btn'),
      clearBtn: $('clear-btn'),
      result: $('result')
    };
    bind();
    setToolUnlocked(false);
    updateTokenMeta('');
    updateGenerateState();
    loadConfiguration();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
