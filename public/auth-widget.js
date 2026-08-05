/**
 * 仙宝统一登录组件 v2
 */
(function(w){
  var AUTH = "https://auth.xianbao.online";
  var isWechat = /MicroMessenger/i.test(navigator.userAgent);
  var state = { loggedIn: false, user: null, initEl: null, _ready: false, _readyCbs: [], _authChangeCbs: [] };
checkAuth();
  function api(path, opts) {
    opts = opts || {};
    var url = AUTH + "/api/auth" + path;
    return fetch(url, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: opts.body ? JSON.stringify(opts.body) : void 0
    }).then(function(r){
      return r.json();
    }).then(function(j){
      return j;
    });
  }
  function render() {
    if (!state.initEl) return;
    if (state.loggedIn && state.user) {
      var name = state.user.nickname || state.user.email || "用户";
      var ava = state.user.avatar_url ? '<img src="'+state.user.avatar_url+'" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0">' : '<span style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;flex-shrink:0">' + (name.charAt(0).toUpperCase()) + '</span>';
      state.initEl.innerHTML =
        '<div class="xianbao-auth-user" style="display:flex;align-items:center;gap:6px;position:relative;cursor:pointer">' +
          ava +
          '<span style="color:#94a3b8;font-size:13px">' + e(name) + '</span>' +
          '<span style="font-size:10px;color:#64748b">&#9660;</span>' +
          '<div class="xianbao-auth-dd" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;background:#14141e;border:1px solid #1e1e2a;border-radius:10px;padding:6px;min-width:100px;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.4)">' +
            '<a href="https://auth.xianbao.online/account" style="display:block;padding:8px 12px;border-radius:6px;color:#e0e0e0;text-decoration:none;font-size:13px">&#9881;&#65039; 账号</a>' +
            '<div style="height:1px;background:#1e1e2a;margin:4px 6px"></div>' +
            '<a href="#" id="xianbao-auth-logout" style="display:block;padding:8px 12px;border-radius:6px;color:#f87171;text-decoration:none;font-size:13px">&#128682; 退出</a>' +
          '</div>' +
        '</div>';
      state.initEl.querySelector(".xianbao-auth-user").onclick = function(e){
        var dd = this.lastElementChild;
        dd.style.display = dd.style.display === "none" ? "block" : "none";
        e.stopPropagation();
      };
      state.initEl.querySelector("#xianbao-auth-logout").onclick = function(e){
        e.preventDefault(); logout();
      };
    } else {
      state.initEl.innerHTML =
        '<button id="xianbao-auth-login" style="padding:5px 14px;background:transparent;border:1px solid rgba(148,163,184,0.2);border-radius:8px;color:#94a3b8;font-size:13px;cursor:pointer">登录 / 注册</button>';
      state.initEl.querySelector("#xianbao-auth-login").onclick = function(e){
        e.preventDefault(); showModal();
      };
    }
  }
  function closeDropdown(e) {
    var dd = document.querySelector(".xianbao-auth-dd");
    if (dd && !e.target.closest(".xianbao-auth-user")) dd.style.display = "none";
  }
  function checkAuth() {
    return api("/me").then(function(res){
      state.loggedIn = !!res.success;
      state.user = res.success ? res.data : null;
      render();
      state._authChangeCbs.forEach(function(fn){fn({loggedIn:state.loggedIn,user:state.user});});
    }).catch(function(e){
      state.loggedIn = false; state.user = null;
      render();
      state._authChangeCbs.forEach(function(fn){fn({loggedIn:false,user:null});});
    });
  }
  function init(opts) {
    opts = opts || {};
    if (opts.el) state.initEl = typeof opts.el === "string" ? document.querySelector(opts.el) : opts.el;
    checkAuth();
  }
  // === Modal ===
  var modalEl = null;
  function closeModal() { if (modalEl) modalEl.style.display = "none"; }
  function showModal(tab) {
    if (!modalEl) {
      modalEl = document.createElement("div");
      modalEl.id = "xianbao-auth-modal";
      modalEl.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)";
      modalEl.onclick = function(e){ if(e.target===modalEl) closeModal(); };
      document.body.appendChild(modalEl);
    }
    modalEl.style.display = "flex";
    showLogin(tab||"password");
  }
  function showLogin(tab) {
    modalEl.innerHTML =
      '<div style="background:#14141e;border:1px solid #1e1e2a;border-radius:16px;padding:32px;width:360px;max-width:90vw">' +
        '<div style="display:flex;gap:12px;margin-bottom:20px">' +
          '<span id="tab-pwd" style="cursor:pointer;padding:4px 0;font-size:15px;'+(tab==="password"?"color:#e0e0e0;border-bottom:2px solid #7c3aed":"color:#64748b")+'">密码登录</span>' +
          '<span id="tab-code" style="cursor:pointer;padding:4px 0;font-size:15px;'+(tab==="code"?"color:#e0e0e0;border-bottom:2px solid #7c3aed":"color:#64748b")+'">验证码登录</span>' +
          '<span id="tab-wx" style="cursor:pointer;padding:4px 0;font-size:15px;'+(tab==="wechat"?"color:#e0e0e0;border-bottom:2px solid #7c3aed":"color:#64748b")+'">微信登录</span>' +
          '<span style="flex:1"></span>' +
          '<span onclick="XianbaoAuth.closeModal()" style="cursor:pointer;color:#64748b;font-size:18px">&#10005;</span>' +
        '</div>' +
        (tab==="password" ? loginPwdHtml() : (tab==="code" ? loginCodeHtml() : loginWechatHtml())) +
      '</div>';
    document.getElementById("tab-pwd").onclick = function(){ showLogin("password"); };
    document.getElementById("tab-code").onclick = function(){ showLogin("code"); };
    document.getElementById("tab-wx").onclick = function(){ showLogin("wechat"); };
    if (tab==="password") {
      document.getElementById("lp-btn").onclick = doPasswordLogin;
      document.getElementById("go-register").onclick = showRegister;
    }
    if (tab==="code") {
      document.getElementById("lc-btn").onclick = doCodeLogin;
      document.getElementById("lc-send").onclick = sendCode;
    }
    if (tab==="wechat") {
      if (isWechat) {
        var ob = document.getElementById("wx-oauth-btn");
        if (ob) ob.onclick = function() {
          location.href = "https://auth.xianbao.online/wechat/oauth-authorize?returnUrl=" + encodeURIComponent(location.href);
        };
      } else {
        startWechatLogin();
      }
    }
  }
  function loginPwdHtml() {
    return '<div id="login-pwd">' +
      '<input id="lp-email" placeholder="手机号/邮箱" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box">' +
      '<input id="lp-pwd" type="password" placeholder="密码" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:16px;box-sizing:border-box">' +
      '<button id="lp-btn" style="width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:15px;font-weight:600;cursor:pointer">登录</button>' +
      '<div id="lp-err" style="color:#f87171;font-size:13px;margin-top:10px;display:none"></div>' +
      '<div style="text-align:center;margin-top:12px"><a href="https://auth.xianbao.online/reset-password" style="color:#64748b;font-size:13px;text-decoration:none">忘记密码？</a></div>' +
      '<div style="text-align:center;margin-top:8px"><span style="color:#64748b;font-size:13px">还没有账号？</span><a href="#" id="go-register" style="color:#7c3aed;font-size:13px;text-decoration:none">立即注册</a></div>' +
    '</div>';
  }
  function loginCodeHtml() {
    return '<div id="login-code">' +
      '<input id="lc-phone" placeholder="手机号" type="tel" maxlength="11" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box">' +
      '<div style="display:flex;gap:8px;margin-bottom:16px">' +
        '<input id="lc-code" placeholder="验证码" style="flex:1;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;box-sizing:border-box">' +
        '<button id="lc-send" style="padding:10px 14px;border:none;border-radius:8px;background:#1e1e2a;color:#94a3b8;font-size:13px;cursor:pointer;white-space:nowrap">发送</button>' +
      '</div>' +
      '<button id="lc-btn" style="width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:15px;font-weight:600;cursor:pointer">登录</button>' +
      '<div id="lc-err" style="color:#f87171;font-size:13px;margin-top:10px;display:none"></div>' +
    '</div>';
  }
  function loginWechatHtml() {
    if (isWechat) {
      return '<div id="login-wechat" style="text-align:center">' +
        '<div style="width:64px;height:64px;margin:0 auto 12px;border-radius:14px;background:linear-gradient(135deg,#07c160,#06ad56);display:flex;align-items:center;justify-content:center;font-size:32px">&#128172;</div>' +
        '<button id="wx-oauth-btn" style="width:100%;padding:12px;border:none;border-radius:8px;background:linear-gradient(135deg,#07c160,#06ad56);color:#fff;font-size:15px;font-weight:600;cursor:pointer">微信一键登录</button>' +
        '<p style="margin:10px 0 0;color:#64748b;font-size:12px">授权后将使用你的微信头像和昵称</p>' +
        '<div id="wx-err" style="color:#f87171;font-size:13px;margin-top:10px;display:none"></div>' +
      '</div>';
    }
    return '<div id="login-wechat" style="text-align:center">' +
      '<div id="wx-qr-wrap" style="width:220px;height:220px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:10px">' +
        '<span id="wx-qr-loading" style="color:#94a3b8;font-size:13px">加载二维码中...</span>' +
        '<img id="wx-qr" alt="微信扫码" style="width:200px;height:200px;display:none" />' +
      '</div>' +
      '<p style="margin:0 0 6px;color:#94a3b8;font-size:13px">使用微信扫码关注「仙宝心灵成长」即可登录</p>' +
      '<p style="margin:0;color:#64748b;font-size:12px">已关注用户扫码后自动登录</p>' +
      '<div id="wx-err" style="color:#f87171;font-size:13px;margin-top:10px;display:none"></div>' +
    '</div>';
  }
  var wechatTimer = null;
  function stopWechatTimer() { if (wechatTimer) { clearInterval(wechatTimer); wechatTimer = null; } }
  function startWechatLogin() {
    stopWechatTimer();
    var errEl = document.getElementById("wx-err");
    var loadingEl = document.getElementById("wx-qr-loading");
    var imgEl = document.getElementById("wx-qr");
    if (errEl) errEl.style.display = "none";
    api("/wechat/qrcode", { method: "POST" }).then(function(res) {
      if (!res.success) {
        if (loadingEl) loadingEl.textContent = "获取二维码失败";
        if (errEl) { errEl.textContent = res.error || "获取二维码失败"; errEl.style.display = "block"; }
        return;
      }
      if (loadingEl) loadingEl.style.display = "none";
      if (imgEl) { imgEl.src = res.data.img; imgEl.style.display = "block"; }
      var sid = res.data.sid;
      var tried = 0;
      wechatTimer = setInterval(function() {
        tried++;
        if (tried > 60) { stopWechatTimer(); if (errEl) { errEl.textContent = "二维码已过期，请关闭重试"; errEl.style.display = "block"; } return; }
        api("/wechat/status?sid=" + sid).then(function(r2) {
          if (r2.pending) return;
          stopWechatTimer();
          if (r2.success) {
            state.loggedIn = true;
            state.user = r2.data.user;
            render();
            closeModal();
          } else {
            if (errEl) { errEl.textContent = r2.error || "登录失败"; errEl.style.display = "block"; }
          }
        }).catch(function(){});
      }, 2000);
    }).catch(function() {
      if (loadingEl) loadingEl.textContent = "网络错误";
      if (errEl) { errEl.textContent = "网络错误，请重试"; errEl.style.display = "block"; }
    });
  }
  function showErr(id, msg) {
    var el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }
  function doPasswordLogin() {
    var account = document.getElementById("lp-email").value.trim();
    var pwd = document.getElementById("lp-pwd").value;
    if (!account || !pwd) { showErr("lp-err", "请填写完整"); return; }
    var body = /^1[3-9]\d{9}$/.test(account) ? { phone: account, password: pwd } : { email: account, password: pwd };
    api("/login", { method: "POST", body: body }).then(function(res){
      if (res.success) { closeModal(); checkAuth(); }
      else { showErr("lp-err", res.error || "登录失败"); }
    });
  }
  function doCodeLogin() {
    var phone = document.getElementById("lc-phone").value;
    var code = document.getElementById("lc-code").value;
    if (!phone || !code) { showErr("lc-err", "请填写完整"); return; }
    if (!/^1[3-9]\d{9}$/.test(phone)) { showErr("lc-err", "手机号格式不正确"); return; }
    api("/login-with-phone", { method: "POST", body: { phone: phone, code: code } }).then(function(res){
      if (res.success) { closeModal(); checkAuth(); }
      else { showErr("lc-err", res.error || "登录失败"); }
    });
  }
  function sendCode() {
    var phone = document.getElementById("lc-phone").value;
    if (!phone) { showErr("lc-err", "请输入手机号"); return; }
    if (!/^1[3-9]\d{9}$/.test(phone)) { showErr("lc-err", "手机号格式不正确"); return; }
    api("/send-phone-code", { method: "POST", body: { phone: phone } }).then(function(res){
      if (res.success) {
        showErr("lc-err", "验证码已发送");
        var btn = document.getElementById("lc-send");
        var n = 60;
        btn.disabled = true;
        btn.style.opacity = "0.5";
        var timer = setInterval(function(){
          n--;
          btn.textContent = n + "s";
          if (n <= 0) { clearInterval(timer); btn.disabled = false; btn.style.opacity = "1"; btn.textContent = "发送"; }
        }, 1000);
      } else {
        showErr("lc-err", res.error || "发送失败");
      }
    });
  }
  function showRegister() {
    modalEl.innerHTML =
      '<div style="background:#14141e;border:1px solid #1e1e2a;border-radius:16px;padding:32px;width:360px;max-width:90vw">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
          '<span style="font-size:18px;font-weight:600;color:#e0e0e0">注册账号</span>' +
          '<span onclick="XianbaoAuth.closeModal()" style="cursor:pointer;color:#64748b;font-size:18px">&#10005;</span>' +
        '</div>' +
        '<input id="rg-email" placeholder="邮箱" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box">' +
        '<input id="rg-nick" placeholder="昵称（可选）" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box">' +
        '<input id="rg-pwd" type="password" placeholder="密码（至少6位）" style="width:100%;padding:10px 14px;border:1px solid #1e1e2a;border-radius:8px;background:#0d0d12;color:#e0e0e0;font-size:14px;outline:none;margin-bottom:16px;box-sizing:border-box">' +
        '<button id="rg-btn" style="width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:15px;font-weight:600;cursor:pointer">注册</button>' +
        '<div id="rg-err" style="color:#f87171;font-size:13px;margin-top:10px;display:none"></div>' +
        '<div style="text-align:center;margin-top:12px"><span style="color:#64748b;font-size:13px">已有账号？</span><a href="#" id="go-login" style="color:#7c3aed;font-size:13px;text-decoration:none">立即登录</a></div>' +
      '</div>';
    document.getElementById("go-login").onclick = function(){ showLogin("password"); };
    document.getElementById("rg-btn").onclick = function(){
      var email = document.getElementById("rg-email").value;
      var nick = document.getElementById("rg-nick").value;
      var pwd = document.getElementById("rg-pwd").value;
      if (!email || !pwd) { showErr("rg-err", "请填写邮箱和密码"); return; }
      if (pwd.length < 6) { showErr("rg-err", "密码至少6位"); return; }
      api("/register", { method: "POST", body: { email: email, password: pwd, nickname: nick } }).then(function(res){
        if (res.success) { closeModal(); checkAuth(); }
        else { showErr("rg-err", res.error || "注册失败"); }
      });
    };
  }
  function logout() {
    api("/logout", { method: "POST" }).then(function(){ checkAuth(); });
  }
  function e(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }
  document.addEventListener("click", closeDropdown);
  w.XianbaoAuth = {
    init: init, closeModal: closeModal,
    isLoggedIn: function(){ return state.loggedIn; },
    getUser: function(){ return state.user; },
    onAuthChange: function(cb){ if(typeof cb==='function'){state._authChangeCbs.push(cb);checkAuth().then(function(){cb({loggedIn:state.loggedIn,user:state.user});});} },
    showLogin: showModal, logout: logout, checkAuth: checkAuth
  };
})(window);
