/* ============================================================
   情侣网站 · 主题（浅色 / 深色 / 跟随系统）
   ------------------------------------------------------------
   必须在 <head> 里、样式表之前同步执行：先给 <html> 打上 data-theme，
   再让 CSS 生效，避免首屏白闪（FOUC）。
   参考 tech-kev/SharedMoments 的三态主题 + 防闪烁做法。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 强制走 https（必须最先执行）----------
     门禁/设备/会话三枚 Cookie 在 https 下都带 Secure，而浏览器**不允许 http 页面
     覆盖 Secure Cookie**（RFC6265bis「Leave Secure Cookies Alone」，Chromium 已实现）。
     于是"先在 https 解锁、之后用 http 打开"会出现：http 请求不发送 Secure Cookie →
     被弹回解锁页；在 http 下重新输对密码、接口也返回成功，但响应里的新 Cookie 被
     浏览器拒收 → 反复弹回、怎么输都进不去（2026-09-12 实测复现）。
     与其在 Cookie 属性上打补丁，不如从源头不让 http/https 混用：http 页面一进来就升级。
     本地预览（localhost / 127.0.0.1 / 局域网 / *.local）必须排除，否则本地 http 调试
     会被跳到不存在的 https。 */
  (function () {
    if (location.protocol !== "http:") return;
    var h = location.hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/.test(h)) return;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return;
    if (/\.local$/i.test(h)) return;
    location.replace(location.href.replace(/^http:/, "https:"));
  })();

  var KEY = "love-theme";
  var MODES = ["system", "light", "dark"];
  var LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };
  var ICON = { system: "🌗", light: "☀️", dark: "🌙" };

  var mode = "system";
  try {
    var saved = localStorage.getItem(KEY);
    if (MODES.indexOf(saved) !== -1) mode = saved;
  } catch (e) {}

  /* URL 参数优先：?theme=dark / light / system
     用于"分享一个指定主题的链接"（不写入 localStorage，刷新后仍按系统/已存偏好） */
  if (window.location && window.location.search) {
    var q = /[?&]theme=(light|dark|system)(?:&|$)/.exec(window.location.search);
    if (q) mode = q[1];
  }

  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var listeners = [];

  function systemDark() { return !!(mq && mq.matches); }
  function effective() { return mode === "system" ? (systemDark() ? "dark" : "light") : mode; }

  function apply() {
    var e = effective();
    var root = document.documentElement;
    root.setAttribute("data-theme", e);
    root.setAttribute("data-theme-mode", mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", e === "dark" ? "#14101a" : "#f06292");
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](mode, effective()); } catch (e) {}
    }
  }

  apply();

  if (mq) {
    var onChange = function () { apply(); notify(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  window.__loveTheme = {
    mode: function () { return mode; },
    theme: effective,
    set: function (m) {
      mode = MODES.indexOf(m) === -1 ? "system" : m;
      try { localStorage.setItem(KEY, mode); } catch (e) {}
      // 只在用户主动切换时加过渡，避免首屏动画
      document.documentElement.classList.add("theming");
      apply();
      notify();
      setTimeout(function () { document.documentElement.classList.remove("theming"); }, 320);
    },
    cycle: function () {
      this.set(mode === "system" ? "light" : (mode === "light" ? "dark" : "system"));
    },
    onChange: function (fn) { listeners.push(fn); },
    label: function () { return LABEL[mode] || ""; },
    icon: function () { return ICON[mode] || "🌗"; },
  };

  /* 导航上的三态切换按钮（所有前台页面都有） */
  function bind() {
    var btn = document.getElementById("themeBtn");
    if (!btn) return;
    function refresh() {
      btn.textContent = window.__loveTheme.icon();
      btn.title = "主题：" + window.__loveTheme.label();
      btn.setAttribute("aria-label", "切换主题（当前：" + window.__loveTheme.label() + "）");
    }
    btn.addEventListener("click", function () { window.__loveTheme.cycle(); });
    window.__loveTheme.onChange(refresh);
    refresh();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
