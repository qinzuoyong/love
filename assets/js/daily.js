/* ============================================================
   情侣网站 · 每日一问（首页卡片）
   ------------------------------------------------------------
   参考 Paired 的每日一问：低压力、每天一句，久了就是一本对话集。
   规则：双方看到同一题（题目 = CONFIG.dailyQuestions[第几天 % 题数]），
        两个人都答完之后才能看到对方的答案。
   数据：服务端 data/daily.json（api/daily.php）；
        服务器不可用时降级为本机存储（此时看不到对方回答）。
   ============================================================ */

(function () {
  "use strict";

  var card = document.getElementById("dailyCard");
  if (!card) return;

  var LS = "love-daily";
  /* 作答日记（只记日期，不记事内容）：服务器模式下答案存在 data/daily.json、
     本机不再留痕，于是"一共答过多少天"这个数字在服务器模式下无从得知 ——
     成就页要按它算进度，所以这里两个分支都往本机记一笔。纯本机数据，不上传。 */
  var LOG_KEY = "love-daily-log";
  var LOG_MAX = 400;
  var view = null;

  /* config.js 里是 `const CONFIG`（不会挂到 window 上） */
  function loveCfg() { return (typeof CONFIG !== "undefined") ? CONFIG : null; }

  function esc(s) { return window.escHtml ? window.escHtml(s) : String(s == null ? "" : s); }
  function toast(msg) { if (window.toast) window.toast(msg); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function todayStr() {
    var n = new Date();
    return n.getFullYear() + "-" + pad2(n.getMonth() + 1) + "-" + pad2(n.getDate());
  }

  function readLocal() {
    try { var v = JSON.parse(localStorage.getItem(LS)); return v && typeof v === "object" ? v : {}; }
    catch (e) { return {}; }
  }
  function writeLocal(o) {
    try { localStorage.setItem(LS, JSON.stringify(o)); return true; } catch (e) { return false; }
  }

  /* 带超时的请求：没有超时兜底时，挂住的请求会让 .then/.catch 都不跑，
     提交按钮就永久禁用了（这个坑的完整说明见 config.js 的 loveTimedFetch）。 */
  function rf(url, opt) {
    return (typeof window.loveTimedFetch === "function") ? window.loveTimedFetch(url, opt) : fetch(url, opt);
  }

  /** 本机存着的"今天"的答案（提交时服务器连不上，被 localSave 存下来的草稿） */
  function todayDraft() {
    var v = readLocal()[todayStr()];
    return (typeof v === "string" && v.trim()) ? v : "";
  }
  /** 服务器已经收下今天的答案了 → 本机草稿别再回填（否则删掉服务器记录后又冒出来） */
  function clearLocalDraft() {
    var saved = readLocal();
    if (!saved[todayStr()]) return;
    delete saved[todayStr()];
    writeLocal(saved);
  }

  /** 记一笔"今天答过"（幂等；只留最近 LOG_MAX 天）。写不进去也不影响作答本身。 */
  function logAnswered() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOG_KEY));
      var list = Array.isArray(raw) ? raw : [];
      var d = todayStr();
      if (list.indexOf(d) === -1) list.push(d);
      if (list.length > LOG_MAX) list = list.slice(-LOG_MAX);
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
    } catch (e) { /* 存储不可用：成就页会退回按本机答案数统计 */ }
  }

  function questions() {
    var c = loveCfg();
    var q = (c && c.dailyQuestions) || [];
    return q.filter(function (x) { return x && String(x).trim(); });
  }

  function questionOf(dayNo) {
    var q = questions();
    if (!q.length) return null;
    var i = ((dayNo % q.length) + q.length) % q.length;
    return { text: String(q[i]), index: i };
  }

  /* 本地模式下的"第几天"：口径必须与服务端 lib/daily.php 的 daily_day_no() 完全一致
     （以 CONFIG.startDate 为零点、按整天数取差；没配置就退到 1970-01-01），
     否则同一对情侣在静态托管和 PHP 主机上看到的不是同一道题。
     旧实现这里写死 0：服务器不可用/纯静态托管时永远只出第 1 题。 */
  function localDayNo() {
    var c = loveCfg();
    var start = (c && typeof c.startDate === "string") ? c.startDate : "";
    var base = /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : "1970-01-01";
    var a = new Date(base + "T00:00:00");
    var b = new Date(todayStr() + "T00:00:00");
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
    return Math.floor((b - a) / 86400000);
  }

  function localView() {
    var d = todayStr();
    var saved = readLocal();
    var mine = saved[d] ? { text: String(saved[d]), ts: 0 } : null;
    /* 服务端注入且 enabled 为真时用它的 dayNo（那是服务端按 Asia/Shanghai 算的
       "今天"）；其余情况自己按同一口径算，不能写死 0。 */
    var sd = window.__SERVER_DAILY__;
    var dayNo = (sd && sd.enabled === true && typeof sd.dayNo === "number") ? sd.dayNo : localDayNo();
    return {
      enabled: true, local: true, date: d,
      dayNo: dayNo,
      mine: mine, partnerAnswered: false, partner: [],
    };
  }

  function render() {
    if (!view) return;
    var q = questionOf(view.dayNo || 0);
    if (!q) { card.innerHTML = '<div class="muted">还没有配置题目，去后台「题库与真心话 → 每日一问」加几条吧</div>'; return; }

    var html = '<div class="daily-q"><span class="daily-tag">今天的问题</span>' + esc(q.text) + "</div>";

    if (view.mine) {
      html += '<div class="daily-answer"><span class="daily-who">我</span>' + esc(view.mine.text) + "</div>";
      if (view.partner && view.partner.length) {
        view.partner.forEach(function (p, i) {
          html += '<div class="daily-answer partner"><span class="daily-who">TA</span>' + esc(p.text) + "</div>";
        });
      } else if (view.partnerAnswered) {
        html += '<div class="daily-wait">TA 也答完了，正在同步…</div>';
      } else if (view.local) {
        /* 本机模式（纯静态托管 / 服务器不可用）下对方的回答根本不会到这里 ——
           旧文案写着"等 TA 回答就能互相看到 💌"，是一句永远兑现不了的承诺，
           两句提示自相矛盾。这里如实说清"只在这台设备上"，并给出正确的出路。 */
        html += '<div class="daily-wait">已经答好啦 ✅</div>' +
          '<div class="daily-note">本机模式：这句话只保存在这台设备上（看不到 TA 的回答）。' +
          '部署到 PHP 主机后，两个人才会看到同一题，而且都答完就能互相看到。</div>';
      } else {
        html += '<div class="daily-wait">已经答好啦，等 TA 回答就能互相看到 💌</div>';
      }
    } else {
      /* 本机草稿回填：服务器说"我"今天还没答，但本机存着一条 —— 那是上次提交时
         服务器连不上、被 localSave() 存到本机的。旧实现完全不管它：界面摆回空白
         输入框，用户多半重打一遍，原来那句就永远躺在 localStorage 里（谁也看不见、
         也没人清），而成就页还把它算成"答过的一天"，两个页面口径互相打架。
         回填一次几乎零成本，提交一下就补传上去了。 */
      var draft = (view.enabled === true && !view.local) ? todayDraft() : "";
      html +=
        '<textarea class="field daily-input" id="dailyInput" rows="2" maxlength="200" ' +
        'placeholder="写下你的答案（200 字以内）…">' + esc(draft) + "</textarea>" +
        '<div class="daily-actions"><button class="btn" id="dailySend" type="button">💬 提交回答</button></div>';
      if (draft) html += '<div class="daily-note">这条是上次服务器连不上时存在本机的，点「提交回答」就能补传上去。</div>';
    }

    card.innerHTML = html;

    var send = document.getElementById("dailySend");
    if (send) send.addEventListener("click", submit);
    var input = document.getElementById("dailyInput");
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault(); submit();
        }
      });
      /* 聚焦是为了让人进来就能直接打字，但浏览器会把新获得焦点的元素滚进视口：
         卡片在首屏之下，于是"进入首页"变成"被拉到每日一问"（用户 2026-09-23 反馈，
         实测手机 scrollY=1803）。preventScroll 保住聚焦、不碰滚动位置；
         老浏览器不认这个参数时退回旧行为，不会更糟。 */
      input.focus({ preventScroll: true });
    }
  }

  function submit() {
    var input = document.getElementById("dailyInput");
    var btn = document.getElementById("dailySend");
    if (!input || !btn) return;
    /* 按钮本身点不动，但输入框上的回车处理器会直接调到这里 —— 没有这道判断，
       点完提交再按回车就再发一次请求（撞上限流会弹"操作太频繁"，用户以为没提交上）。
       index.html 的解锁按钮早就有同款 `if (btn.disabled) return;`。 */
    if (btn.disabled) return;
    var text = (input.value || "").trim();
    if (!text) { toast("写点什么再提交吧"); return; }
    btn.disabled = true;

    function localSave(msg) {
      var saved = readLocal();
      saved[todayStr()] = text;
      /* writeLocal 一直有回传布尔值，但以前没人看：写失败（浏览器禁用站点存储 / 配额满）
         照样渲染并提示"已存到本机"，而 render() 又从 localStorage 读，于是界面回到
         "未回答"，用户那句答案就这么没了。写失败就如实说、并把输入框留着。 */
      if (!writeLocal(saved)) {
        btn.disabled = false;
        toast("本机存储空间不足或被浏览器禁用，这句话没能保存 —— 先复制一下");
        return;
      }
      view = localView();
      render();
      logAnswered();
      toast(msg);
    }

    rf("api/daily.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer", text: text }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.data) {
          view = j.data;
          logAnswered();
          clearLocalDraft();      // 服务器收下了，本机草稿不用再回填
          render();
          toast("已提交，等 TA 回答 💌");
          return;
        }
        if (j && j.locked) { btn.disabled = false; toast("需要先解锁"); return; }
        btn.disabled = false;
        if (j && j.error) { toast(j.error); return; }
        localSave("服务器暂不可用，已存到本机");
      })
      .catch(function () { localSave("服务器暂不可用，已存到本机"); });
  }

  /* ---------- 初始化 ----------
     数据源优先级（第七轮 S6-04 的修法）：**先**用注入快照 / 本机视图把卡片画出来
     （首屏不空等，请求挂住也不会让卡片长时间空着），**再**问一次服务器 ——
     拿到新数据、且用户还没开始输入时重画一次。
     window.__SERVER_DAILY__ 是 api/config.php 在"文档加载那一刻"注入的，外壳换视图
     不会再刷新它：旧实现只要它在就永远不问服务器，于是本会话刚提交的答案切页回来
     变成空白输入框（本机草稿已被 clearLocalDraft 清掉）、跨零点后回到首页还是昨天
     的题号与日期。 */
  function viewFromSnapshot() {
    var sd = window.__SERVER_DAILY__;
    if (sd && sd.enabled !== false) return sd;
    return localView();
  }

  /* 用户已经在输入框里写了东西吗（相对"回填的本机草稿"而言）？
     是的话不重画：否则服务器数据晚一两百毫秒回来，会把他正在打的那句话冲掉。 */
  function userIsTyping() {
    var el = document.getElementById("dailyInput");
    if (!el || typeof el.value !== "string") return false;
    var typed = el.value.trim();
    return !!typed && typed !== todayDraft();
  }

  view = viewFromSnapshot();
  render();                                   // 第一版：注入快照 / 本机视图（立即出现）

  rf("api/daily.php", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var fresh = (j && j.ok && j.data) ? j.data : null;
      if (!fresh) return;                     // 拿不到就保持第一版
      if (fresh.enabled === false) fresh = localView();
      if (userIsTyping()) return;
      view = fresh;
      render();
    })
    .catch(function () { /* 服务器不可用：保持第一版（快照/本机视图） */ });
})();
