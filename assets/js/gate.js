/* ============================================================
   情侣网站 · 前台门禁守卫（除解锁页外的所有页面加载）
   ------------------------------------------------------------
   由 api/config.php 注入的 window.__SERVER_GATE__ 决定：
     - 没有这个对象  → 纯静态托管 / file:// 本地打开：不做任何事
     - required=false → 服务器没设解锁密码：不做任何事
     - ok=true        → 已解锁：放行
     - ok=false       → 未解锁：跳回解锁页（避免陌生人直接打开 home.html）
   注意：这只是体验层的第一道门；真正的数据由接口按 Cookie 判定，
        未解锁时接口一律 401，注入的内容也是空的。
   ============================================================ */

(function () {
  "use strict";
  var g = window.__SERVER_GATE__;
  if (!g || !g.required) return;
  if (g.ok) {
    try { sessionStorage.setItem("love-unlocked", "1"); } catch (e) {}
    return;
  }
  try { sessionStorage.removeItem("love-unlocked"); } catch (e) {}
  location.replace("index.html?need=1");
})();
