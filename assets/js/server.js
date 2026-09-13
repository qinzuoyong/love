/* ============================================================
   情侣网站 · 服务器数据同步助手（管理员后台配套）
   ------------------------------------------------------------
   留言板 / 手写情书 / 相册照片 现在存在服务器
   （data/content.json + assets/img/uploads/），跨设备可见。
   接口失败时调用方会自动降级为浏览器本地存储（原行为）。
   用法：
     loveServer.fetchAll().then(function (data) { ... })   // {photos, letters, messages}
     loveServer.post({action:'photo_add', dataUrl, cap, uid})  // → {ok, record}
     loveServer.post({action:'delete', kind, uid})   // 归属由服务端 Cookie 判定
   ============================================================ */

(function () {
  "use strict";

  var API = "api/content.php";

  /* 说明：早前版本在浏览器里生成 deviceId 并随请求提交，用于"只能删自己发的"。
     服务端已改为按 HttpOnly Cookie 判定归属（api/content.php 会忽略请求体里
     的 deviceId），前端不再持有、也不再发送任何设备凭据 —— 这里已彻底移除。 */

  window.loveServer = {
    fetchAll: function () {
      // 优先使用页面加载时随 api/config.php 注入的数据（script 注入链路稳定，
      // 不会被防火墙/WAF 的请求挑战拦截）。纯静态托管无注入时回退 fetch。
      if (window.__SERVER_CONTENT__) {
        return Promise.resolve(window.__SERVER_CONTENT__);
      }
      return fetch(API + "?action=all", { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || "服务器错误");
          return j.data;
        });
    },

    post: function (payload) {
      return fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || !j.ok) {
            var err = new Error(j.error || "http " + r.status);
            err.server = true;          // 服务端明确拒绝（业务错误，如限流；重试无用）
            err.payload = j;
            if (j && j.locked) err.locked = true;   // 需要先解锁（门禁）
            throw err;
          }
          return j;
        });
      });
    },
  };
})();
