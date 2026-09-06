/* ============================================================
   情侣网站 · 服务器数据同步助手（管理员后台配套）
   ------------------------------------------------------------
   留言板 / 手写情书 / 相册照片 现在存在服务器
   （data/content.json + assets/img/uploads/），跨设备可见。
   接口失败时调用方会自动降级为浏览器本地存储（原行为）。
   用法：
     loveServer.fetchAll().then(function (data) { ... })   // {photos, letters, messages}
     loveServer.post({action:'photo_add', dataUrl, cap, uid})  // → {ok, record}
     loveServer.post({action:'delete', kind, uid, deviceId})
   ============================================================ */

(function () {
  "use strict";

  var API = "api/content.php";

  /* 每个浏览器一个稳定设备号：用于"只能删自己发的" */
  function deviceId() {
    var d = null;
    try { d = localStorage.getItem("love-device"); } catch (e) {}
    if (!d) {
      d = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem("love-device", d); } catch (e) {}
    }
    return d;
  }

  window.loveServer = {
    deviceId: deviceId(),

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
          if (!r.ok || !j.ok) throw new Error(j.error || "http " + r.status);
          return j;
        });
      });
    },
  };
})();
