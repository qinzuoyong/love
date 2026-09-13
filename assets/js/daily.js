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

  function localView() {
    var d = todayStr();
    var saved = readLocal();
    var mine = saved[d] ? { text: String(saved[d]), ts: 0 } : null;
    return {
      enabled: true, local: true, date: d,
      dayNo: window.__SERVER_DAILY__ ? window.__SERVER_DAILY__.dayNo : 0,
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
      } else {
        html += '<div class="daily-wait">已经答好啦，等 TA 回答就能互相看到 💌</div>';
      }
      if (view.local) html += '<div class="daily-note">本机模式：暂时看不到对方的回答（部署到 PHP 主机后可跨设备同步）</div>';
    } else {
      html +=
        '<textarea class="field daily-input" id="dailyInput" rows="2" maxlength="200" ' +
        'placeholder="写下你的答案（200 字以内）…"></textarea>' +
        '<div class="daily-actions"><button class="btn" id="dailySend" type="button">💬 提交回答</button></div>';
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
      input.focus();
    }
  }

  function submit() {
    var input = document.getElementById("dailyInput");
    var btn = document.getElementById("dailySend");
    if (!input || !btn) return;
    var text = (input.value || "").trim();
    if (!text) { toast("写点什么再提交吧"); return; }
    btn.disabled = true;

    function localSave(msg) {
      var saved = readLocal();
      saved[todayStr()] = text;
      writeLocal(saved);
      view = localView();
      render();
      toast(msg);
    }

    fetch("api/daily.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer", text: text }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok && j.data) {
          view = j.data;
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

  /* ---------- 初始化 ---------- */
  if (window.__SERVER_DAILY__) {
    view = window.__SERVER_DAILY__;
    if (view.enabled === false) view = localView();
    render();
  } else {
    fetch("api/daily.php", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { view = (j && j.ok && j.data) ? j.data : localView(); render(); })
      .catch(function () { view = localView(); render(); });
  }
})();
