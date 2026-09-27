/* ============================================================
   情侣网站 · 服务器数据同步助手（管理员后台配套）
   ------------------------------------------------------------
   留言板 / 手写情书 / 相册照片 现在存在服务器
   （data/content.json + assets/img/uploads/），跨设备可见。
   接口失败时调用方会自动降级为浏览器本地存储（原行为）。
   用法：
     loveServer.fetchAll().then(function (data) { ... })   // {photos, letters, messages}
     loveServer.post({action:'photo_add', dataUrl, cap, uid}, 240000)  // → {ok, record}
     loveServer.post({action:'delete', kind, uid})   // 归属由服务端 Cookie 判定
     （第二个参数是超时毫秒数，省略 = 45 秒；0 = 不设超时，大照片上传用）
   ============================================================ */

(function () {
  "use strict";

  var API = "api/content.php";

  /* ---------- 单次请求的超时兜底 ----------
     为什么必须有：这些请求的结果负责**释放 UI 上的"提交中"状态**（按钮 disabled、
     在途标志、相册的"上传中"提示），而移动网络下连接可能挂住 —— 既不成功也不失败、
     没有 RST。没有超时的话 Promise 永不 settle，catch/finally 都不跑，按钮就永久
     禁用了，用户只能刷新页面（解锁按钮上踩过同一个坑，见 index.html）。
     45 秒对文本类请求非常宽松（一封信最大 2000 字，慢链路也就几秒）；共享主机偶尔
     很慢，所以别压得更短。照片载荷最大 3MB（base64），在 7–13KB/s 的链路上要几十秒
     到几分钟，那条路径由调用方显式给更大的预算（gallery.js / admin 的 photo_upload）。 */
  var DEFAULT_TIMEOUT_MS = 45000;

  /* 把超时"续"到响应体（第七轮 S5-03，与 config.js 那份 loveBodyDeadline 同口径）：
     fetch() 在**响应头**到达时就 resolve，旧实现那一刻就 clearTimeout，而调用方随后还要
     读 body（r.json()/r.text()）。若服务端只发头、body 挂在半开连接上（挑战页/网关/弱网），
     既没有 abort 也没有超时，.then/.catch 一个都不跑 —— 提交按钮永久禁用、界面永远停在
     "正在提交…"，正是这个 helper 存在的理由。定时器改由 body 读取 settle 时才清。 */
  function bodyDeadline(res, finish, ms, noAbort) {
    if (!res || typeof res !== "object") return res;
    var done = false;
    var settle = function () { if (!done) { done = true; finish(); } };
    ["json", "text", "arrayBuffer", "blob", "formData"].forEach(function (k) {
      var orig = res[k];
      if (typeof orig !== "function") return;
      res[k] = function () {
        var p;
        try { p = orig.apply(res, arguments); }
        catch (e) { settle(); throw e; }
        if (!p || typeof p.then !== "function") { settle(); return p; }
        if (!noAbort) {
          return p.then(function (v) { settle(); return v; },
                        function (e) { settle(); throw e; });
        }
        return Promise.race([p, new Promise(function (_res, rej) {
          setTimeout(function () {
            var err = new Error("请求超时（" + ms + "ms，本机不支持 AbortController）");
            err.name = "AbortError";
            settle();
            rej(err);
          }, ms);
        })]);
      };
    });
    return res;
  }

  function timedFetch(url, opt) {
    opt = opt || {};
    var ms = (opt.timeoutMs === undefined) ? DEFAULT_TIMEOUT_MS : opt.timeoutMs;
    var plain = { method: opt.method, headers: opt.headers, body: opt.body, cache: opt.cache };
    if (!ms) return fetch(url, plain);
  /* 没有 AbortController 的内核（Chrome 42–65 / Firefox 39–56 / Safari 10.1–12.0）：
     旧实现直接退回裸 fetch ⇒ **连超时兜底一起消失**，负责复位界面的 .then/.catch 一个都不跑，
     "提交按钮永久 disabled、界面永远停在正在提交…"的老故障整站复活（第四轮 F-S5-02）。
     这里改成 Promise.race 的纯本地超时：只 reject 本地 Promise、不 abort 请求
     （没有 AbortController 也没法 abort），错误名与真 abort 一致，调用方不必分支。 */
    var raceTimeout = function (p) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () {
          var err = new Error("请求超时（" + ms + "ms，本机不支持 AbortController）");
          err.name = "AbortError";
          reject(err);
        }, ms);
        p.then(function (v) { resolve(v); },        // ← 不在头部到达时 clearTimeout
               function (e) { clearTimeout(t); reject(e); });
      }).then(function (res) {
        return bodyDeadline(res, function () {}, ms, true);
      });
    };
    if (typeof AbortController !== "function") return raceTimeout(fetch(url, plain));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
    var clearT = function () { clearTimeout(timer); };
    plain.signal = ctrl.signal;
    return fetch(url, plain)
      .then(function (res) { return bodyDeadline(res, clearT, ms, false); },
            function (e) { clearT(); throw e; });
  }

  /* 说明：早前版本在浏览器里生成 deviceId 并随请求提交，用于"只能删自己发的"。
     服务端已改为按 HttpOnly Cookie 判定归属（api/content.php 会忽略请求体里
     的 deviceId），前端不再持有、也不再发送任何设备凭据 —— 这里已彻底移除。 */

  /* 拉一次实时内容（带超时；失败向上抛，由调用方决定回退） */
  function fetchContent(budgetMs) {
    return timedFetch(API + "?action=all", { cache: "no-store", timeoutMs: budgetMs })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || "服务器错误");
        return j.data;
      });
  }

  /* 注入快照在本会话里是否已经被消费过（见 fetchAll 的说明）。
     整份前端只在这里读写，不挂 window 以免与别的脚本撞名。 */
  var snapshotUsed = false;

  window.loveServer = {
    fetchAll: function () {
      /* 优先级（第七轮 P1 / S5-01、S6-01、S9-01 的修法）：
         外壳化之后站内切页不再加载文档，而 api/config.php 被 shell.js 的
         SHELL_SCRIPTS 挡在"换视图重跑的脚本"之外 —— window.__SERVER_CONTENT__
         在整个会话里冻结。继续无条件优先用它，就会出现"刚写的内容切页回来消失、
         已删除的又原地复活"（旧注释担心的 WAF 挑战页只是它的另一半理由）。

         ① 本次文档还没消费过这份快照 → 直接返回：它正是文档加载这一刻注入的，
            省一次请求，也保住"注入链路不被 WAF 挑战页拦"的原始价值；
         ② 已消费过（= 这是一次换视图之后的重新挂载）→ 真实拉取：成功即用，
            并顺手回写 window.__SERVER_CONTENT__（直接读全局的消费方，例如
            achievements.js，因此也跟着变新）；失败再退回快照。
         有兜底时才给短预算（10s），避免拿不到新的又让界面干等满 45 秒。 */
      var snap = window.__SERVER_CONTENT__ || null;
      if (snap && !snapshotUsed) {
        snapshotUsed = true;
        return Promise.resolve(snap);
      }
      return fetchContent(snap ? 10000 : undefined)
        .then(function (data) {
          if (data) window.__SERVER_CONTENT__ = data;
          return data;
        })
        .catch(function (err) {
          if (snap) return snap;
          throw err;
        });
    },

    /** @param timeoutMs 省略用默认 45 秒；0 = 不设超时（大载荷上传用） */
    post: function (payload, timeoutMs) {
      return timedFetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: timeoutMs,
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
        }, function (parseErr) {
          /* r.json() 解析失败：我们**确实拿到了 HTTP 响应**（r.status 是有的），
             只是响应体不是 JSON —— 真实形态是主机/WAF 返回的 HTML 错误页或挑战页。
             旧码把这个解析异常原样抛出：既没有 err.status 也不标明"拿到了响应"，
             调用方只能把它当"网络断了"（可重试），于是反复重试也永远试不出来。
             注意只接管 r.json() 的失败：成功路径与"非 2xx 但 JSON 正常"那条
             业务错误分支的判据与字段保持原样。

             ★ 这里刻意**不置 err.server**。调用方（letters.js:247、capsules.js:229）
             把 err.server 读作"服务端明确拒绝这次业务请求（限流/未解锁/参数错），
             重试无用，所以**不要**静默转存本机"。而主机/WAF 的 HTML 错误页恰好相反：
             服务端根本没受理这条内容，必须保留本机副本、下次自动补传 —— 否则用户
             刚写完的信就真丢了。把"误标成网络问题"换成"丢内容"是更糟的 bug，
             所以这里用 err.badResponse 表达"拿到响应但不可解析"，err.server 语义不动。 */
          var err = new Error("服务器返回了无法解析的内容（HTTP " + r.status + "），请稍后重试");
          err.badResponse = true;       // 拿到了响应，但不是 JSON（主机/WAF 错误页、挑战页）
          err.status = r.status;
          err.parseError = parseErr;
          throw err;
        });
      });
    },
  };
})();
