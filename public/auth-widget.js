/**
 * 仙宝统一登录组件
 * 所有站点通过 <script src="https://auth.xianbao.online/auth-widget.js"></script> 引入
 * 
 * 用法：
 *   XianbaoAuth.init({ el: '#auth-area' })  // 在DOM中显示登录/用户信息
 * 
 * API：
 *   XianbaoAuth.isLoggedIn()  // 检查登录状态
 *   XianbaoAuth.getUser()     // 获取当前用户
 *   XianbaoAuth.showLogin()   // 显示登录弹窗
 *   XianbaoAuth.logout()      // 退出登录
 *   XianbaoAuth.logAction()   // 记录操作日志
 *   XianbaoAuth.onAuthChange(callback)  // 监听登录状态变化
 */
(function (w) {
  'use strict';

  var AUTH_API = 'https://auth.xianbao.online/api/auth';
  var USER_API = 'https://auth.xianbao.online/api/users';

  var state = {
    user: null,
    loggedIn: false,
    listeners: [],
    modalEl: null,
    initEl: null,
    codeTimer: null,
    codeCountdown: 0
  };

  function getCookie(name) {
    var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return match ? decodeURIComponent(match[2]) : null;
  }

  function api(path, options) {
    options = options || {};
    return fetch(AUTH_API + path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      credentials: 'include',
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (r) { return r.json(); });
  }

  function checkAuth() {
    return api('/me').then(function (res) {
      if (res.success) {
        state.user = res.data;
        state.loggedIn = true;
      } else {
        state.user = null;
        state.loggedIn = false;
      }
      notifyListeners();
      return state;
    }).catch(function () {
      state.user = null;
      state.loggedIn = false;
      notifyListeners();
      return state;
    });
  }

  function login(data) {
    return api('/login', { method: 'POST', body: data }).then(function (res) {
      if (res.success) {
        state.user = res.data.user;
        state.loggedIn = true;
        notifyListeners();
      }
      return res;
    });
  }

  function logout() {
    return api('/logout', { method: 'POST' }).then(function (res) {
      state.user = null;
      state.loggedIn = false;
      notifyListeners();
      renderWidget();
      return res;
    });
  }

  function logAction(action, detail) {
    if (!state.loggedIn) return Promise.resolve({ success: false });
    return api('/log', {
      method: 'POST',
      body: { action: action, detail: detail }
    }).catch(function () {});
  }

  function notifyListeners() {
    state.listeners.forEach(function (fn) {
      try { fn(state); } catch (e) {}
    });
  }

  function onAuthChange(fn) {
    state.listeners.push(fn);
    return function () {
      state.listeners = state.listeners.filter(function (f) { return f !== fn; });
    };
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  var MODAL_STYLE = [
    'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
    'background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;'
  ].join('');
  var PANEL_STYLE = [
    'background:#111827;border-radius:16px;padding:32px;width:380px;max-width:90vw;',
    'border:1px solid rgba(148,163,184,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.5);',
    'position:relative;color:#e2e8f0;'
  ].join('');
  var INPUT_STYLE = [
    'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
    'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;'
  ].join('');
  var BTN_STYLE = [
    'width:100%;padding:12px;background:linear-gradient(135deg,#38bdf8,#818cf8);border:none;',
    'border-radius:10px;color:white;font-size:15px;font-weight:600;cursor:pointer;transition:.2s;'
  ].join('');
  var TAB_STYLE = [
    'flex:1;padding:10px;text-align:center;font-size:14px;font-weight:600;cursor:pointer;',
    'border:none;background:none;transition:.2s;'
  ].join('');
  var TAB_ACTIVE = 'color:#38bdf8;border-bottom:2px solid #38bdf8;';
  var TAB_INACTIVE = 'color:#64748b;';

  function showModal(tab) {
    tab = tab || 'code';
    if (state.modalEl) { state.modalEl.style.display = 'flex'; return; }

    var modal = document.createElement('div');
    modal.className = 'xianbao-auth-modal';
    modal.style.cssText = MODAL_STYLE;

    modal.innerHTML = [
      '<div class="xianbao-auth-panel" style="' + PANEL_STYLE + '">',
        '<button class="xianbao-auth-close" style="position:absolute;top:12px;right:16px;background:none;border:none;color:#64748b;font-size:22px;cursor:pointer;padding:4px;line-height:1;">&times;</button>',
        '<div style="display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid rgba(148,163,184,0.1);">',
          '<button class="auth-tab tab-code" style="' + TAB_STYLE + TAB_ACTIVE + '">验证码登录</button>',
          '<button class="auth-tab tab-login" style="' + TAB_STYLE + TAB_INACTIVE + '">密码登录</button>',
        '</div>',
        // 验证码登录表单（默认）
        '<div class="xianbao-auth-code-form">',
          '<div class="xianbao-auth-error-2" style="color:#f87171;font-size:13px;margin-bottom:8px;display:none;"></div>',
          '<input type="email" placeholder="邮箱" class="auth-input code-email" style="' + INPUT_STYLE + '">',
          '<p style="font-size:12px;color:#64748b;margin:-6px 0 12px 2px;">验证码将发送到你的邮箱，5分钟内有效，新用户自动注册</p>',
          '<div style="display:flex;gap:8px;margin-bottom:20px;">',
            '<input type="text" placeholder="验证码" class="auth-input code-input" style="' + INPUT_STYLE.replace('margin-bottom:12px;', 'margin-bottom:0;flex:1;') + '" maxlength="6">',
            '<button class="auth-btn auth-btn-send-code" style="padding:12px 16px;background:#7c3aed;border:none;border-radius:10px;color:white;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;transition:.2s;flex-shrink:0;">发送验证码</button>',
          '</div>',
          '<button class="auth-btn auth-btn-code-login" style="' + BTN_STYLE + '">登录 / 注册</button>',
        '</div>',
        // 密码登录表单
        '<div class="xianbao-auth-login-form" style="display:none;">',
          '<div class="xianbao-auth-error" style="color:#f87171;font-size:13px;margin-bottom:12px;display:none;"></div>',
          '<input type="email" placeholder="邮箱" class="auth-input login-email" style="' + INPUT_STYLE + '">',
          '<div style="position:relative;margin-bottom:20px;">',
            '<input type="password" placeholder="密码" class="auth-input login-password" style="' + INPUT_STYLE.replace('margin-bottom:12px;', 'padding-right:40px;margin-bottom:0;') + '">',
            '<button type="button" class="pwd-toggle" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;padding:4px;"> 👁 </button>',
          '</div>',
          '<button class="auth-btn auth-btn-login" style="' + BTN_STYLE + '">登录</button>',
        '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(modal);
    state.modalEl = modal;

    var loginForm = modal.querySelector('.xianbao-auth-login-form');
    var codeForm = modal.querySelector('.xianbao-auth-code-form');
    var tabLogin = modal.querySelector('.tab-login');
    var tabCode = modal.querySelector('.tab-code');

    modal.querySelector('.xianbao-auth-close').onclick = function () { modal.style.display = 'none'; };
    modal.onclick = function (e) { if (e.target === modal) modal.style.display = 'none'; };

    // Tab切换
    function switchTab(name) {
      if (name === 'login') {
        loginForm.style.display = 'block';
        codeForm.style.display = 'none';
        tabLogin.style.cssText = TAB_STYLE + TAB_ACTIVE;
        tabCode.style.cssText = TAB_STYLE + TAB_INACTIVE;
      } else {
        loginForm.style.display = 'none';
        codeForm.style.display = 'block';
        tabLogin.style.cssText = TAB_STYLE + TAB_INACTIVE;
        tabCode.style.cssText = TAB_STYLE + TAB_ACTIVE;
      }
    }
    tabLogin.onclick = function () { switchTab('login'); };
    tabCode.onclick = function () { switchTab('code'); };
    if (tab === 'code') switchTab('code');

    // 密码登录
    modal.querySelector('.auth-btn-login').onclick = function () {
      var email = modal.querySelector('.login-email').value.trim();
      var password = modal.querySelector('.login-password').value;
      var errEl = modal.querySelector('.xianbao-auth-error');
      if (!email || !password) { showError(errEl, '请填写邮箱和密码'); return; }
      var btn = this;
      var origText = btn.textContent;
      btn.textContent = '登录中...';
      btn.disabled = true;
      login({ email: email, password: password }).then(function (res) {
        btn.textContent = origText;
        btn.disabled = false;
        if (res.success) {
          modal.style.display = 'none';
          renderWidget();
        } else {
          showError(errEl, res.error || '登录失败');
        }
      }).catch(function() {
        btn.textContent = origText;
        btn.disabled = false;
        showError(errEl, '网络错误');
      });
    };

    // 密码可见切换
    modal.querySelectorAll('.pwd-toggle').forEach(function(btn) {
      btn.onclick = function() {
        var input = btn.previousElementSibling;
        input.type = input.type === 'password' ? 'text' : 'password';
      };
    });

    // 发送验证码
    modal.querySelector('.auth-btn-send-code').onclick = function () {
      var email = modal.querySelector('.code-email').value.trim();
      var errEl = modal.querySelector('.xianbao-auth-error-2');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError(errEl, '请输入有效的邮箱地址');
        return;
      }
      var btn = this;
      btn.textContent = '发送中...';
      btn.disabled = true;
      fetch('https://auth.xianbao.online/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.success) {
          showError(errEl, '验证码已发送');
          errEl.style.color = '#34d399';
          startCountdown(btn, 60);
        } else {
          btn.textContent = '发送验证码';
          btn.disabled = false;
          showError(errEl, res.error || '发送失败');
        }
      }).catch(function() {
        btn.textContent = '发送验证码';
        btn.disabled = false;
        showError(errEl, '网络错误');
      });
    };

    // 验证码登录/注册
    modal.querySelector('.auth-btn-code-login').onclick = function () {
      var email = modal.querySelector('.code-email').value.trim();
      var code = modal.querySelector('.code-input').value.trim();
      var errEl = modal.querySelector('.xianbao-auth-error-2');
      if (!email || !code) { showError(errEl, '请填写邮箱和验证码'); return; }
      var btn = this;
      var origText = btn.textContent;
      btn.textContent = '验证中...';
      btn.disabled = true;
      fetch('https://auth.xianbao.online/api/auth/login-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code }),
        credentials: 'include'
      }).then(function(r) { return r.json(); }).then(function(res) {
        btn.textContent = origText;
        btn.disabled = false;
        if (res.success) {
          state.user = res.data.user;
          state.loggedIn = true;
          notifyListeners();
          modal.style.display = 'none';
          renderWidget();
        } else {
          showError(errEl, res.error || '登录失败');
        }
      }).catch(function() {
        btn.textContent = origText;
        btn.disabled = false;
        showError(errEl, '网络错误');
      });
    };



    // Enter键
    modal.querySelectorAll('.auth-input').forEach(function (el) {
      el.onkeydown = function (e) {
        if (e.key === 'Enter') {
          var loginVisible = loginForm.style.display !== 'none';
          if (loginVisible) {
            modal.querySelector('.auth-btn-login').click();
          } else {
            modal.querySelector('.auth-btn-code-login').click();
          }
        }
      };
    });

    setTimeout(function () {
      var first = modal.querySelector('.auth-input:not([style*="display:none"])');
      if (first) first.focus();
    }, 100);
  }

  function startCountdown(btn, seconds) {
    state.codeCountdown = seconds;
    btn.textContent = seconds + 's';
    btn.disabled = true;
    if (state.codeTimer) clearInterval(state.codeTimer);
    state.codeTimer = setInterval(function() {
      state.codeCountdown--;
      if (state.codeCountdown <= 0) {
        clearInterval(state.codeTimer);
        state.codeTimer = null;
        btn.textContent = '重新发送';
        btn.disabled = false;
      } else {
        btn.textContent = state.codeCountdown + 's';
      }
    }, 1000);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
    el.style.color = '#f87171';
    setTimeout(function () { el.style.display = 'none'; }, 3000);
  }

  function renderWidget() {
    if (!state.initEl) return;
    if (state.loggedIn && state.user) {
      state.initEl.innerHTML = [
        '<div class="xianbao-auth-user" style="display:flex;align-items:center;gap:8px;">',
          '<span style="color:#64748b;font-size:13px;">' + escapeHtml(state.user.nickname || state.user.username) + '</span>',
          '<a href="#" class="xianbao-auth-logout-btn" style="color:#64748b;font-size:12px;text-decoration:none;padding:3px 8px;border:1px solid rgba(148,163,184,0.15);border-radius:6px;">退出</a>',
        '</div>'
      ].join('');
      state.initEl.querySelector('.xianbao-auth-logout-btn').onclick = function (e) {
        e.preventDefault();
        if (confirm('确定退出登录？')) { logout(); }
      };
    } else {
      state.initEl.innerHTML = [
        '<div class="xianbao-auth-guest" style="display:flex;align-items:center;gap:8px;">',
          '<button class="xianbao-auth-login-btn" style="padding:5px 14px;background:transparent;border:1px solid rgba(148,163,184,0.2);border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer;transition:.2s;">登录 / 注册</button>',
        '</div>'
      ].join('');
      state.initEl.querySelector('.xianbao-auth-login-btn').onclick = function (e) {
        e.preventDefault();
        showModal();
      };
    }
  }

  function init(options) {
    options = options || {};
    if (options.el) {
      state.initEl = (typeof options.el === 'string')
        ? document.querySelector(options.el)
        : options.el;
    }
    checkAuth().then(function () { renderWidget(); });
  }

  w.XianbaoAuth = {
    init: init,
    isLoggedIn: function () { return state.loggedIn; },
    getUser: function () { return state.user; },
    showLogin: showModal,
    logout: logout,
    login: login,
    logAction: logAction,
    onAuthChange: onAuthChange,
    checkAuth: checkAuth
  };
})(window);
