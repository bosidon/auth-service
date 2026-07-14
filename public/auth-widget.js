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
  var COOKIE_NAME = 'xianbao_token';

  var state = {
    user: null,
    loggedIn: false,
    listeners: [],
    modalEl: null,
    initEl: null
  };

  // ===== 工具 =====
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

  // ===== 核心API =====

  // 检查登录状态
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

  // 注册
  function register(data) {
    return api('/register', { method: 'POST', body: data }).then(function (res) {
      if (res.success) {
        state.user = res.data.user;
        state.loggedIn = true;
        notifyListeners();
      }
      return res;
    });
  }

  // 登录
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

  // 退出登录
  function logout() {
    return api('/logout', { method: 'POST' }).then(function (res) {
      state.user = null;
      state.loggedIn = false;
      notifyListeners();
      renderWidget();
      return res;
    });
  }

  // 记录操作日志
  function logAction(action, detail) {
    if (!state.loggedIn) return Promise.resolve({ success: false });
    return api('/log', {
      method: 'POST',
      body: { action: action, detail: detail }
    }).catch(function () {});
  }

  // 获取用户日志
  function getLogs(page) {
    return fetch(USER_API + '/logs?page=' + (page || 1), { credentials: 'include' })
      .then(function (r) { return r.json(); });
  }

  // ===== 事件监听 =====
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

  // ===== UI渲染 =====

  function showModal() {
    if (state.modalEl) {
      state.modalEl.style.display = 'flex';
      return;
    }

    var modal = document.createElement('div');
    modal.className = 'xianbao-auth-modal';
    modal.style.cssText = [
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
      'background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;'
    ].join('');

    modal.innerHTML = [
      '<div class="xianbao-auth-panel" style="',
        'background:#111827;border-radius:16px;padding:32px;width:360px;max-width:90vw;',
        'border:1px solid rgba(148,163,184,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.5);',
        'position:relative;color:#e2e8f0;',
      '">',
        '<button class="xianbao-auth-close" style="',
          'position:absolute;top:12px;right:16px;background:none;border:none;',
          'color:#64748b;font-size:22px;cursor:pointer;padding:4px;line-height:1;',
        '">&times;</button>',
        // 登录表单
        '<div class="xianbao-auth-login">',
          '<h2 style="font-size:20px;font-weight:700;margin:0 0 4px;background:linear-gradient(135deg,#38bdf8,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">欢迎回来</h2>',
          '<p style="color:#64748b;font-size:13px;margin:0 0 24px;">登录仙宝账号，同步你的所有记录</p>',
          '<div class="xianbao-auth-error" style="color:#f87171;font-size:13px;margin-bottom:12px;display:none;"></div>',
          '<input type="email" placeholder="邮箱" class="auth-input login-email" style="',
            'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
            'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;',
          '">',
          '<div style="position:relative;margin-bottom:20px;">',
            '<input type="password" placeholder="密码" class="auth-input login-password" style="',
              'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
              'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;box-sizing:border-box;padding-right:40px;',
            '">',
            '<button type="button" class="pwd-toggle" style="',
              'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;',
              'color:#64748b;cursor:pointer;font-size:16px;padding:4px;',
            '">  </button>',
          '</div>',
          '<button class="auth-btn auth-btn-login" style="',
            'width:100%;padding:12px;background:linear-gradient(135deg,#38bdf8,#818cf8);border:none;',
            'border-radius:10px;color:white;font-size:15px;font-weight:600;cursor:pointer;transition:.2s;',
          '">登录</button>',
          '<p style="text-align:center;margin-top:12px;font-size:13px;color:#64748b;">',
            '<a href="#" class="auth-forgot-pwd" style="color:#64748b;text-decoration:none;">忘记密码？</a>',
          '</p>',
          '<p style="text-align:center;margin-top:8px;font-size:13px;color:#64748b;">',
            '还没有账号？<a href="#" class="auth-switch-to-reg" style="color:#38bdf8;text-decoration:none;">立即注册</a>',
          '</p>',
        '</div>',
        // 注册表单
        '<div class="xianbao-auth-register" style="display:none;">',
          '<h2 style="font-size:20px;font-weight:700;margin:0 0 4px;background:linear-gradient(135deg,#38bdf8,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">创建账号</h2>',
          '<p style="color:#64748b;font-size:13px;margin:0 0 24px;">加入仙宝，探索更多可能</p>',
          '<div class="xianbao-auth-error" style="color:#f87171;font-size:13px;margin-bottom:12px;display:none;"></div>',
          '<input type="text" placeholder="用户名" class="auth-input reg-username" style="',
            'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
            'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;',
          '">',
          '<input type="email" placeholder="邮箱" class="auth-input reg-email" style="',
            'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
            'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box;',
          '">',
          '<div style="position:relative;margin-bottom:20px;">',
            '<input type="password" placeholder="密码（至少6位）" class="auth-input reg-password" style="',
              'width:100%;padding:12px 14px;background:#1e293b;border:1px solid rgba(148,163,184,0.12);',
              'border-radius:10px;color:#e2e8f0;font-size:14px;outline:none;box-sizing:border-box;padding-right:40px;',
            '">',
            '<button type="button" class="pwd-toggle" style="',
              'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;',
              'color:#64748b;cursor:pointer;font-size:16px;padding:4px;',
            '">  </button>',
          '</div>',
          '<button class="auth-btn auth-btn-register" style="',
            'width:100%;padding:12px;background:linear-gradient(135deg,#38bdf8,#818cf8);border:none;',
            'border-radius:10px;color:white;font-size:15px;font-weight:600;cursor:pointer;transition:.2s;',
          '">注册</button>',
          '<p style="text-align:center;margin-top:16px;font-size:13px;color:#64748b;">',
            '已有账号？<a href="#" class="auth-switch-to-login" style="color:#38bdf8;text-decoration:none;">立即登录</a>',
          '</p>',
        '</div>',
      '</div>'
    ].join('\n');

    document.body.appendChild(modal);
    state.modalEl = modal;

    // 事件绑定
    var loginForm = modal.querySelector('.xianbao-auth-login');
    var regForm = modal.querySelector('.xianbao-auth-register');
    var errEl = modal.querySelector('.xianbao-auth-error');

    modal.querySelector('.xianbao-auth-close').onclick = function () { modal.style.display = 'none'; };
    modal.onclick = function (e) { if (e.target === modal) modal.style.display = 'none'; };

    // 切换表单
    modal.querySelector('.auth-switch-to-reg').onclick = function (e) {
      e.preventDefault();
      loginForm.style.display = 'none';
      regForm.style.display = 'block';
      errEl.style.display = 'none';
    };
    modal.querySelector('.auth-switch-to-login').onclick = function (e) {
      e.preventDefault();
      loginForm.style.display = 'block';
      regForm.style.display = 'none';
      errEl.style.display = 'none';
    };

    // 登录
    modal.querySelector('.auth-btn-login').onclick = function () {
      var email = modal.querySelector('.login-email').value.trim();
      var password = modal.querySelector('.login-password').value;
      if (!email || !password) {
        showError(errEl, '请填写邮箱和密码');
        return;
      }
      var loginBtn = modal.querySelector('.auth-btn-login');
      var origText = loginBtn.textContent;
      loginBtn.textContent = '登录中...';
      loginBtn.disabled = true;
      login({ email: email, password: password }).then(function (res) {
        loginBtn.textContent = origText;
        loginBtn.disabled = false;
        if (res.success) {
          modal.style.display = 'none';
          renderWidget();
        } else {
          showError(errEl, res.error || '登录失败');
        }
      }).catch(function() {
        loginBtn.textContent = origText;
        loginBtn.disabled = false;
        showError(errEl, '网络错误');
      });
    };

    // 注册
    modal.querySelector('.auth-btn-register').onclick = function () {
      var username = modal.querySelector('.reg-username').value.trim();
      var email = modal.querySelector('.reg-email').value.trim();
      var password = modal.querySelector('.reg-password').value;
      if (!username || !email || !password) {
        showError(errEl, '请填写所有字段');
        return;
      }
      if (password.length < 6) {
        showError(errEl, '密码至少6位');
        return;
      }
      var regBtn = modal.querySelector('.auth-btn-register');
      var origRegText = regBtn.textContent;
      regBtn.textContent = '注册中...';
      regBtn.disabled = true;
      register({ username: username, email: email, password: password }).then(function (res) {
        regBtn.textContent = origRegText;
        regBtn.disabled = false;
        if (res.success) {
          modal.style.display = 'none';
          renderWidget();
        } else {
          showError(errEl, res.error || '注册失败');
        }
      }).catch(function() {
        regBtn.textContent = origRegText;
        regBtn.disabled = false;
        showError(errEl, '网络错误');
      });
    };

    // 密码可见切换
    modal.querySelectorAll('.pwd-toggle').forEach(function(btn) {
      btn.onclick = function() {
        var input = btn.previousElementSibling;
        if (input.type === 'password') {
          input.type = 'text';
          btn.textContent = '  ';
        } else {
          input.type = 'password';
          btn.textContent = '  ';
        }
      };
    });

    // Enter键提交
    modal.querySelectorAll('.auth-input').forEach(function (el) {
      el.onkeydown = function (e) {
        if (e.key === 'Enter') {
          if (loginForm.style.display !== 'none') {
            modal.querySelector('.auth-btn-login').click();
          } else {
            modal.querySelector('.auth-btn-register').click();
          }
        }
      };
    });

    // 忘记密码
    var forgotLink = modal.querySelector('.auth-forgot-pwd');
    if (forgotLink) {
      forgotLink.onclick = function(e) {
        e.preventDefault();
        var email = modal.querySelector('.login-email').value.trim();
        if (!email) {
          showError(errEl, '请先输入邮箱地址');
          return;
        }
        var link = e.target;
        var origText = link.textContent;
        link.textContent = '发送中...';
        fetch('https://auth.xianbao.online/api/password/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function(r) { return r.json(); }).then(function(res) {
          link.textContent = origText;
          if (res.success) {
            showError(errEl, '重置链接已发送到你的邮箱');
            errEl.style.color = '#34d399';
            setTimeout(function() { errEl.style.display = 'none'; errEl.style.color = '#f87171'; }, 5000);
          } else {
            showError(errEl, res.error || '发送失败');
          }
        }).catch(function() {
          link.textContent = origText;
          showError(errEl, '网络错误');
        });
      };
    }

    // 聚焦第一个输入框
    setTimeout(function () {
      var first = modal.querySelector('.auth-input:not([style*="display:none"])');
      if (first) first.focus();
    }, 100);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 3000);
  }

  // 渲染小部件
  function renderWidget() {
    if (!state.initEl) return;

    if (state.loggedIn && state.user) {
      state.initEl.innerHTML = [
        '<div class="xianbao-auth-user" style="display:flex;align-items:center;gap:8px;">',
          '<span style="color:#64748b;font-size:13px;">' + escapeHtml(state.user.nickname || state.user.username) + '</span>',
          '<a href="#" class="xianbao-auth-logout-btn" style="color:#64748b;font-size:12px;text-decoration:none;padding:3px 8px;border:1px solid rgba(148,163,184,0.15);border-radius:6px;">退出</a>',
        '</div>'
      ].join('\n');

      state.initEl.querySelector('.xianbao-auth-logout-btn').onclick = function (e) {
        e.preventDefault();
        if (confirm('确定退出登录？')) {
          logout();
        }
      };

    } else {
      state.initEl.innerHTML = [
        '<div class="xianbao-auth-guest" style="display:flex;align-items:center;gap:8px;">',
          '<button class="xianbao-auth-login-btn" style="',
            'padding:5px 14px;background:transparent;border:1px solid rgba(148,163,184,0.2);',
            'border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer;transition:.2s;',
          '">登录 / 注册</button>',
        '</div>'
      ].join('\n');

      state.initEl.querySelector('.xianbao-auth-login-btn').onclick = function (e) {
        e.preventDefault();
        showModal();
      };
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ===== 初始化 =====
  function init(options) {
    options = options || {};

    if (options.el) {
      state.initEl = (typeof options.el === 'string')
        ? document.querySelector(options.el)
        : options.el;
    }

    // 检查登录状态
    checkAuth().then(function () {
      renderWidget();
    });
  }

  // ===== 导出 =====
  w.XianbaoAuth = {
    init: init,
    isLoggedIn: function () { return state.loggedIn; },
    getUser: function () { return state.user; },
    showLogin: showModal,
    logout: logout,
    login: login,
    register: register,
    logAction: logAction,
    getLogs: getLogs,
    onAuthChange: onAuthChange,
    checkAuth: checkAuth
  };

})(window);
