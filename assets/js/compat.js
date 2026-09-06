/* ============================================================
   情侣网站 · 默契度测试（服务器版）
   ------------------------------------------------------------
   回合制 + 无感自动配对：
   - 发起人随机抽 10 题作答，提交后等对方
   - 对方（另一台设备）打开页面自动匹配到等待中的回合，直接作答
   - 同一台设备接力：答完点"把手机给 TA"继续
   - 双方都答完才展示逐题对比 + 默契百分比（服务器在完成前
     不下发对方答案，防偷看）
   - 完成的回合保存在服务器，页面下方可回顾历史
   服务器不可用（纯静态托管）时回退 localStorage 双槽（原行为）。
   参考：couple-score 的思路 + 结果数字滚动动画（Mirrai 启发）
   ============================================================ */

(function () {
  "use strict";

  var box = document.getElementById("compatBox");
  if (!box || !CONFIG.compatQuiz || !CONFIG.compatQuiz.length) return;

  var Q = CONFIG.compatQuiz;
  var N_PER_ROUND = 10;          // 每回合题目数（与 api/compat.php 一致）
  var POLL_MS = 5000;            // 等待页轮询间隔
  var API = "api/compat.php";

  var quesEl = document.getElementById("compatQues");
  var optsEl = document.getElementById("compatOpts");
  var msgEl = document.getElementById("compatMsg");
  var barEl = document.getElementById("compatBar");
  var barFill = document.getElementById("compatBarFill");
  var startBtn = document.getElementById("compatStart");
  var histEl = document.getElementById("compatHist");

  /* 设备号：优先复用 loveServer（server.js 可能未在本页加载，
     故自带生成逻辑兜底，与 server.js 共用同一个 localStorage key） */
  function myDeviceId() {
    var d = "";
    if (window.loveServer && window.loveServer.deviceId) return window.loveServer.deviceId;
    try { d = localStorage.getItem("love-device") || ""; } catch (e) {}
    if (!d) {
      d = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem("love-device", d); } catch (e) {}
    }
    return d;
  }
  var deviceId = myDeviceId();
  var myRole = null;      // 'boy' | 'girl'（当前回合我的身份）
  var roundId = null;     // 当前回合 id
  var questions = [];     // 当前回合题目快照
  var index = 0;          // 当前题号
  var answers = [];       // 本回合我的答案
  var pollTimer = null;
  var confirmReset = false;
  var localMode = false;  // 服务器不可用 → 本地双槽
  var localSlot = 1;

  function nameOf(role) { return role === "boy" ? CONFIG.names.boy : CONFIG.names.girl; }
  function otherRole(role) { return role === "boy" ? "girl" : "boy"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function fmtRel(ts) {
    if (!ts) return "";
    var diff = Date.now() / 1000 - ts;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 604800) return Math.floor(diff / 86400) + " 天前";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function verdict(pct) {
    if (pct >= 90) return "👑 天生一对！你们的脑回路是同一个电路板";
    if (pct >= 75) return "💯 默契爆棚，连想法都长一个样";
    if (pct >= 60) return "😄 很有默契，再聊聊会更懂彼此";
    if (pct >= 40) return "🤔 小有默契，有些题值得聊一聊";
    return "💪 快去多聊聊天，默契是聊出来的";
  }

  /* ---------------- 服务器请求 ---------------- */
  /* 注入的通用 active → 接口标准视图（含 aDeviceId，前端判断身份） */
  function adaptInjected(a) {
    if (!a) return null;
    var mine = a.aDeviceId === deviceId;
    return {
      id: a.id,
      status: a.status,
      questions: a.questions,
      myRole: mine ? a.aRole : (a.status === "waiting_b" ? a.bRole : ""),
      iAnswered: mine ? a.aAnswered : false,
      canJoin: !mine && a.status === "waiting_b",
      waitingFor: mine && a.status === "waiting_b" ? "b" : null,
    };
  }
  function fetchStatus() {
    return fetch(API + "?action=status&deviceId=" + encodeURIComponent(deviceId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || "服务器错误"); return j; });
  }
  function getStatus(force) {
    // 优先使用页面加载时随 api/config.php 注入的状态（script 注入链路稳定，
    // 首次打开不依赖 fetch，避免防火墙/WAF 请求挑战拦截）。
    // 注入的 active 为空时不可直接判定"无事发生"——服务器可能刚完成
    // 一局我参与的回合（注入无法按设备过滤 done 回合），故用实时 fetch 确认。
    if (!force && window.__SERVER_COMPAT__ && window.__SERVER_COMPAT__.active) {
      var inj = window.__SERVER_COMPAT__;
      return Promise.resolve({
        active: adaptInjected(inj.active),
        history: inj.history || [],
      });
    }
    return fetchStatus();
  }
  function post(payload) {
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
  }

  /* ---------------- 界面渲染 ---------------- */
  function renderRolePick() {
    optsEl.innerHTML = "";
    msgEl.innerHTML = "两个人各自答同一套随机题目，都答完后一起看逐题对比。<br>第一人开始前先选一下身份：";
    barEl.style.display = "none";
    quesEl.textContent = "💞 默契度测试";
    startBtn.style.display = "none";
    var wrap = document.createElement("div");
    wrap.className = "compat-rolepick";
    ["boy", "girl"].forEach(function (role) {
      var b = document.createElement("button");
      b.className = "btn compat-role-btn";
      b.textContent = "我是 " + nameOf(role);
      b.addEventListener("click", function () { createRound(role); });
      wrap.appendChild(b);
    });
    optsEl.appendChild(wrap);
    if (window.revealNow) window.revealNow();
  }

  function renderAnswering() {
    startBtn.style.display = "none";
    renderQ();
  }

  function renderQ() {
    var q = questions[index];
    var who = localMode ? "第" + (localSlot === 1 ? "一" : "二") + "个人" : nameOf(myRole);
    quesEl.textContent = "第 " + (index + 1) + " / " + questions.length + " 题 · " + who + " 作答";
    msgEl.textContent = q.q;
    barEl.style.display = "block";
    barFill.style.width = ((index / questions.length) * 100) + "%";
    optsEl.innerHTML = "";
    q.opts.forEach(function (opt, i) {
      var btn = document.createElement("button");
      btn.className = "quiz-opt compat-opt";
      btn.textContent = opt;
      btn.addEventListener("click", function () { ask(i, btn); });
      optsEl.appendChild(btn);
    });
  }

  function ask(i) {
    answers[index] = i;
    index++;
    if (index < questions.length) renderQ();
    else if (localMode) localFinish();
    else submitRound();
  }

  function renderWaiting() {
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var ta = nameOf(otherRole(myRole));
    quesEl.innerHTML = "✅ 你已答完！<b>" + ta + "</b> 还在作答…";
    msgEl.innerHTML = "答案已安全保存到服务器，等 TA 答完后，你们就能一起看到逐题对比啦。<br>（TA 打开游戏页面会自动接到这一轮）";
    startBtn.textContent = "📱 把手机给 TA 作答";
    startBtn.dataset.mode = "handover";
    startBtn.style.display = "inline-flex";
    startPolling();
    if (window.revealNow) window.revealNow();
  }

  function renderJoinable() {
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var me = nameOf(myRole);
    quesEl.innerHTML = "🥰 <b>" + nameOf(otherRole(myRole)) + "</b> 正在等你作答！";
    msgEl.innerHTML = "TA 已经答完了这一轮，就差你了。开始后你会以「" + me + "」的身份作答，答完立刻出结果。";
    startBtn.textContent = "💞 开始作答（我是 " + me + "）";
    startBtn.dataset.mode = "join";
    startBtn.style.display = "inline-flex";
    if (window.revealNow) window.revealNow();
  }

  function renderResult(res, title) {
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var aName = nameOf(res.roles.a), bName = nameOf(res.roles.b);
    quesEl.innerHTML = (title || "💞 默契值") + " <b class='compat-big' data-count=" + res.pct + ">" + res.pct + "%</b> · " + verdict(res.pct);
    msgEl.innerHTML = "共 " + res.total + " 题，你们答对了一样 " + res.same + " 题";
    optsEl.innerHTML = res.detail.map(function (d, i) {
      return '<div class="compat-row' + (d.match ? " ok" : " no") + '">' +
        '<div class="compat-q">' + (i + 1) + ". " + esc(d.q) + " " + (d.match ? "✅" : "❌") + "</div>" +
        '<div class="compat-ans"><b>' + esc(aName) + "</b>：" + esc(d.opts[d.a]) + "</div>" +
        '<div class="compat-ans"><b>' + esc(bName) + "</b>：" + esc(d.opts[d.b]) + "</div>" +
        "</div>";
    }).join("");
    startBtn.textContent = "🔄 再测一轮（还是 " + nameOf(myRole || res.roles.a) + "）";
    startBtn.dataset.mode = "again";
    startBtn.style.display = "inline-flex";
    animateCount();
    if (window.revealNow) window.revealNow();
  }

  /* 结果大数字滚动动画（参考 Mirrai 的 count-up 思路） */
  function animateCount() {
    var el = optsEl.parentNode.querySelector(".compat-big");
    if (!el || el.dataset.counted) return;
    el.dataset.counted = "1";
    var target = parseInt(el.dataset.count, 10) || 0;
    var start = 0, dur = 800, t0 = null;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased) + "%";
      if (p < 1) requestAnimationFrame(step);
    }
    if (window.requestAnimationFrame) requestAnimationFrame(step);
    // 兜底：动画不可用（受限环境 rAF 失效）时也要显示最终值
    setTimeout(function () { el.textContent = target + "%"; }, 1200);
  }

  function renderHistory(list) {
    if (!histEl) return;
    histEl.style.display = "none";
    histEl.innerHTML = "";
    if (!list || !list.length) return;
    histEl.style.display = "block";
    var h = document.createElement("h3");
    h.className = "compat-hist-title";
    h.textContent = "📜 默契历史";
    histEl.appendChild(h);
    list.forEach(function (r) {
      var row = document.createElement("button");
      row.className = "compat-hist-row";
      row.innerHTML = "<span class='compat-hist-pct'>" + r.pct + "%</span>" +
        "<span class='compat-hist-info'>" + esc(nameOf(r.roles.a)) + " ♥ " + esc(nameOf(r.roles.b)) +
        " · 相同 " + r.same + "/" + r.total + " 题</span>" +
        "<span class='compat-hist-time'>" + fmtRel(r.at) + "</span>";
      row.addEventListener("click", function () {
        renderResult({
          pct: r.pct, same: r.same, total: r.total, roles: r.roles,
          detail: r.questions.map(function (q, i) {
            return { q: q.q, opts: q.opts, a: r.answers.a[i], b: r.answers.b[i], match: r.answers.a[i] === r.answers.b[i] };
          }),
        }, "📜 " + fmtRel(r.at) + " 的默契值");
        startBtn.dataset.mode = "again";
      });
      histEl.appendChild(row);
    });
  }

  /* ---------------- 状态分发 ---------------- */
  function dispatch(j) {
    renderHistory(j.history || []);
    var a = j.active;
    if (!a) {
      // 无活跃回合 → 发起界面（含身份选择）
      renderRolePick();
      return;
    }
    if (a.status === "done") {
      // 我参与的回合已完成（轮询/刷新检测到）→ 直接出结果
      stopPolling();
      myRole = a.myRole;
      renderResult(a.result);
      return;
    }
    if (a.canJoin) {
      myRole = a.myRole;          // 服务器已给"第二人"身份
      roundId = a.id;
      questions = a.questions;
      renderJoinable();
      return;
    }
    if (a.status === "pending") {
      // 仅创建者可继续作答；注入视图无法按设备过滤，
      // 非创建者看到的 pending 按"无活跃回合"处理
      if (!a.myRole) { renderRolePick(); return; }
      myRole = a.myRole;
      roundId = a.id;
      questions = a.questions;
      index = 0; answers = [];
      renderAnswering();
      return;
    }
    if (a.status === "waiting_b") {
      myRole = a.myRole;
      roundId = a.id;
      questions = a.questions;
      if (a.iAnswered) {
        renderWaiting();
      } else {
        // 同设备接力场景：a 由本设备答过，现在以 b 身份继续
        renderAnswering();
      }
    }
  }

  /* ---------------- 动作 ---------------- */
  function createRound(role) {
    myRole = role;
    questions = shuffle(Q).slice(0, N_PER_ROUND);
    index = 0; answers = [];
    quesEl.innerHTML = "⏳ 正在创建回合…";
    optsEl.innerHTML = "";
    startBtn.style.display = "none";
    post({ action: "create", role: role, questions: questions, deviceId: deviceId })
      .then(function (j) {
        roundId = j.round.id;
        renderAnswering();
      })
      .catch(function (e) {
        fallbackLocal();   // 服务器不可用 → 回退本地双槽
      });
  }

  function submitRound() {
    barEl.style.display = "none";
    quesEl.textContent = "⏳ 正在提交…";
    post({ action: "submit", id: roundId, role: myRole, answers: answers, deviceId: deviceId })
      .then(function (j) {
        if (j.done) {
          stopPolling();
          renderResult(j.result);
          // 只静默刷新历史（强制实时 fetch，注入是页面加载时的旧数据）；
          // 不要用注入的旧状态重新 dispatch，否则会把结果页覆盖回"等待加入"界面
          getStatus(true).then(function (j2) {
            renderHistory(j2.history || []);
          }).catch(function () {});
        } else {
          renderWaiting();
        }
      })
      .catch(function (e) {
        // 提交失败：保留答案，按钮恢复让用户重试
        optsEl.innerHTML = "";
        msgEl.innerHTML = "⚠️ 提交失败（" + esc(e.message) + "），请检查网络后重试";
        quesEl.textContent = "已答完 " + questions.length + " / " + questions.length + " 题";
        startBtn.textContent = "🔄 重新提交";
        startBtn.dataset.mode = "retry";
        startBtn.style.display = "inline-flex";
      });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      // 必须强制实时 fetch：注入的 __SERVER_COMPAT__ 是页面加载那一刻的
      // 快照，拿它轮询永远等不到对方答完（刷新过页面就中招）
      getStatus(true).then(function (j) {
        if (j.active && j.active.status === "done") {
          stopPolling();
          dispatch(j);
        } else {
          renderHistory(j.history || []);
        }
      }).catch(function () { /* WAF/网络抖动时静默，等下一次 */ });
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  /* ---------------- 降级：localStorage 双槽（原行为） ---------------- */
  var LOCAL_KEY = "love-compat";
  function localLoad() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch (e) { return {}; } }
  function localSave(d) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); } catch (e) {} }
  function localCalc(a, b) {
    var same = 0;
    for (var i = 0; i < Q.length; i++) if (a[i] === b[i]) same++;
    return Math.round(same / Q.length * 100);
  }
  function localRenderResult(a, b) {
    var pct = localCalc(a, b);
    quesEl.innerHTML = "💞 本地模式 默契值 <b class='compat-big' data-count=" + pct + ">" + pct + "%</b> · " + verdict(pct);
    msgEl.innerHTML = "共 " + Q.length + " 题，你们答对了一样 " + Q.filter(function (_, i) { return a[i] === b[i]; }).length + " 题（服务器不可用，结果只存在本机）";
    optsEl.innerHTML = Q.map(function (q, i) {
      var same = a[i] === b[i];
      return '<div class="compat-row' + (same ? " ok" : " no") + '">' +
        '<div class="compat-q">' + (i + 1) + ". " + esc(q.q) + " " + (same ? "✅" : "❌") + "</div>" +
        '<div class="compat-ans"><b>' + esc(CONFIG.names.boy) + "</b>：" + esc(q.opts[a[i]]) + "</div>" +
        '<div class="compat-ans"><b>' + esc(CONFIG.names.girl) + "</b>：" + esc(q.opts[b[i]]) + "</div>" +
        "</div>";
    }).join("");
    barEl.style.display = "none";
    startBtn.textContent = "🔄 重新测一次";
    startBtn.dataset.mode = "local_reset";
    startBtn.style.display = "inline-flex";
    animateCount();
    if (window.revealNow) window.revealNow();
  }
  function localFinish() {
    barEl.style.display = "none";
    var data = localLoad();
    if (localSlot === 1) {
      data.a = answers;
      localSave(data);
      quesEl.textContent = "✅ 第一人答完啦！请把手机/页面交给第二个人继续";
      msgEl.innerHTML = "（服务器不可用，结果只存本机）";
      optsEl.innerHTML = "";
      startBtn.textContent = "💞 轮到第二个人作答";
      startBtn.dataset.mode = "local_play2";
      startBtn.style.display = "inline-flex";
    } else {
      data.b = answers;
      localSave(data);
      localRenderResult(data.a, data.b);
    }
    if (window.revealNow) window.revealNow();
  }
  function fallbackLocal() {
    // 服务器不可用：完整回退到旧的 localStorage 双槽玩法
    localMode = true;
    var data = localLoad();
    localSlot = data.a ? 2 : 1;
    if (data.b) { localRenderResult(data.a, data.b); return; }
    questions = Q;
    myRole = null;
    roundId = null;
    index = 0; answers = [];
    renderQ();
    quesEl.textContent = "第 1 / " + questions.length + " 题 · 第" + (localSlot === 1 ? "一" : "二") + "个人作答（本地模式）";
  }

  /* ---------------- 主按钮 ---------------- */
  startBtn.addEventListener("click", function () {
    var mode = startBtn.dataset.mode;
    if (mode === "join") {
      index = 0; answers = [];
      renderAnswering();
    } else if (mode === "handover") {
      // 同设备接力：身份换成另一方，直接开答
      myRole = otherRole(myRole);
      index = 0; answers = [];
      renderAnswering();
    } else if (mode === "local_play2") {
      localSlot = 2; index = 0; answers = [];
      renderAnswering();
    } else if (mode === "retry") {
      // 重新提交：答案还在内存里，直接重发当前回合（绝不能开新回合丢答案）
      startBtn.style.display = "none";
      submitRound();
    } else if (mode === "again") {
      if (!confirmReset) {
        confirmReset = true;
        startBtn.textContent = "⚠️ 确认开新一轮？（当前回合将作废）";
        setTimeout(function () { confirmReset = false; startBtn.textContent = "🔄 再测一轮"; }, 3000);
        return;
      }
      confirmReset = false;
      createRound(myRole || "boy");
    } else if (mode === "local_reset") {
      if (!confirmReset) {
        confirmReset = true;
        startBtn.textContent = "⚠️ 确认清空本地记录并重测？";
        setTimeout(function () { confirmReset = false; startBtn.textContent = "🔄 重新测一次"; }, 3000);
        return;
      }
      confirmReset = false;
      localStorage.removeItem(LOCAL_KEY);
      renderRolePick();
    }
  });

  /* ---------------- 启动 ---------------- */
  quesEl.textContent = "⏳ 加载中…";
  startBtn.style.display = "none";
  getStatus()
    .then(dispatch)
    .catch(function () {
      // 服务器不可用 → 本地双槽（有"上次结果"直接展示）
      var data = localLoad();
      if (data.b) { localRenderResult(data.a, data.b); return; }
      renderRolePick();
    });
})();
