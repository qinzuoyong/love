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

  /* 切页时本页脚本会被**重新执行**，而全局监听与定时器不随视图内容一起消失
     —— 一律登记给生命周期统一清理，否则一次一页地累积。
     非挂载期（直接打开本页）它退化成原生调用，行为不变。 */
  const LC = window.LoveLifecycle || { on: (t, y, f, o) => t.addEventListener(y, f, o), every: (f, m) => setInterval(f, m), after: (f, m) => setTimeout(f, m), clear: (i) => { clearInterval(i); clearTimeout(i); } };

  var box = document.getElementById("compatBox");
  if (!box || !CONFIG.compatQuiz || !CONFIG.compatQuiz.length) return;

  var Q = CONFIG.compatQuiz;
  var N_PER_ROUND = 10;          // 每回合题目数（与 api/compat.php 一致）
  var POLL_MS = 5000;            // 等待页轮询间隔
  var POLL_FAIL_MAX = 3;         // 连续失败多少次就停止轮询、给出"重试"出口
  var API = "api/compat.php";

  var quesEl = document.getElementById("compatQues");
  var optsEl = document.getElementById("compatOpts");
  var msgEl = document.getElementById("compatMsg");
  var barEl = document.getElementById("compatBar");
  var barFill = document.getElementById("compatBarFill");
  var startBtn = document.getElementById("compatStart");
  var histEl = document.getElementById("compatHist");
  /* 回合进行中时历史列表必须锁住（第四轮 F-S8-2）：它不是只读展示 —— 每行都是按钮，
     点一下会用旧结果顶掉当前题面（renderResult），而作答页没有回到作答的入口，
     刷新又会把 index/answers 清零（已答的题全丢）。 */
  var historyLocked = false;

  /* 身份由服务端 HttpOnly Cookie 决定，前端不再持有任何设备号/凭据 */
  var myRole = null;      // 'boy' | 'girl'（当前回合我的身份）
  var roundId = null;     // 当前回合 id
  var questions = [];     // 当前回合题目快照
  var index = 0;          // 当前题号
  var answers = [];       // 本回合我的答案
  var pollTimer = null;
  var pollFails = 0;      // 轮询连续失败次数（见 startPolling 的出口）
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
  /* 注入的 active 已由服务端按 Cookie 身份换算好（myRole/iAnswered/canJoin），
     前端不需要、也拿不到任何设备凭据 */
  function adaptInjected(a) {
    if (!a) return null;
    return {
      id: a.id,
      status: a.status,
      questions: a.questions,
      myRole: a.myRole || "",
      iAnswered: !!a.iAnswered,
      canJoin: !!a.canJoin,
      waitingFor: a.waitingFor || null,
    };
  }
  /* 带超时的请求（实现见 config.js）。game.html 不加载 server.js，所以不能用
     那边的 timedFetch；裸 fetch 一旦挂住，下面负责复位界面的 .then/.catch
     全都不会跑 —— 页面就永久停在"⏳ 正在创建回合…/⏳ 正在提交…"，而
     renderBusyWait / 初始化的"加载中"还会把唯一的按钮藏起来，用户只能刷新
     （答到第 10 题时刷新等于把整轮答案丢掉）。 */
  function rf(url, opt) {
    return (typeof window.loveTimedFetch === "function") ? window.loveTimedFetch(url, opt) : fetch(url, opt);
  }
  function fetchStatus() {
    return rf(API + "?action=status", { cache: "no-store" })
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
        busy: !!inj.busy,     // 注入视图带 busy（对方正在作答）；漏掉它会把首屏
      });                     // 的"忙"渲染成身份选择，要等点创建被拒才恢复
    }
    return fetchStatus();
  }
  function post(payload) {
    return rf(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.ok) {
          var err = new Error(j.error || "http " + r.status);
          err.server = true;          // 服务端明确拒绝（业务错误，重试无用）
          err.payload = j;
          throw err;
        }
        return j;
      }, function (parseErr) {
        /* r.json() 解析失败：和 assets/js/server.js::post() 同一条口径（第五轮 R5-9②）。
           这里比那边更要紧，因为 submitRound 的 catch 会把 e.message **原样渲染进界面**：
           旧码把解析异常照原样抛出去，用户看到的是
           「提交失败（Unexpected token '<', "<html><bo"... is not valid JSON），请检查网络后重试」
           —— 既是一句英文技术噪音，又把"宿主/WAF 返回了 HTML 错误页"说成网络问题，
           还给一个"重新提交"按钮让他反复试一件永远试不成的事（答案还全押在内存里）。

           ① **不置 err.server**：那边表示"服务端明确拒绝这次业务请求，重试无用，按钮应给
              『重新开始一轮』"。而 HTML 错误页恰恰是**没受理**，重试/等待才是对的动作，
              restart 会把用户刚答完的一整轮答案丢掉 —— 方向反了，代价很大。
           ② 只补 err.status + err.badResponse，让调用方能问清"到底拿到响应没有"。
           注意只接管 r.json() 的失败：成功路径与"非 2xx 但 JSON 正常"那条业务错误分支
           的判据与字段保持原样。 */
        var err = new Error("服务器返回了无法解析的内容（HTTP " + r.status + "），稍等一下再试");
        err.badResponse = true;       // 拿到了响应，但不是 JSON（宿主/WAF 错误页、挑战页）
        err.status = r.status;
        err.parseError = parseErr;
        throw err;
      });
    });
  }

  /* ---------------- 界面渲染 ---------------- */
  function renderRolePick() {
    /* 回到空闲界面：历史解锁（回合进行中的锁必须在这里放开，否则"重开一轮"之后
       列表仍是锁的 —— 第七轮 S8-02 的 (a)/(b) 两个方向都靠这一处收口）。 */
    setRoundActive(false);
    submitting = false;
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
    submitting = false;              // 新的一题：解除上一题的提交锁（若有）
    setRoundActive(true);            // 正在作答 → 历史锁上
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

  /* 双击的第二击会落在重建后的"下一题"同位置按钮上 → 同一序号连答两题。
     时间窗只需吞掉双击（<250ms）；真人在两题之间的阅读间隔不可能这么短。
     （game.js 用 locked+1400ms，这里题目节奏快，用时间戳更合适。）

     提交在途标志（第七轮 S8-01）：submitRound() 只改了 quesEl/barEl，最后一题的
     选项按钮原样留在屏幕上、没有 disabled —— 250ms 只吞得掉双击，真人"点错了想改"
     是 300-800ms，第二次点击会再进 ask()（answers 长度变成 11）并发出第二笔注定被
     拒绝的 submit，响应回来把刚渲染出来的结果页整屏换成"回合已结束"错误屏。 */
  var submitting = false;
  var lastAskAt = 0;
  function ask(i) {
    if (submitting) return;
    var now = Date.now();
    if (now - lastAskAt < 250) return;
    lastAskAt = now;
    answers[index] = i;
    index++;
    if (index < questions.length) renderQ();
    else if (localMode) localFinish();
    else submitRound();
  }

  function renderWaiting() {
    setRoundActive(true);            // 等对方作答中 → 历史仍锁着
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var ta = esc(nameOf(otherRole(myRole)));
    quesEl.innerHTML = "✅ 你已答完！<b>" + ta + "</b> 还在作答…";
    msgEl.innerHTML = "答案已安全保存到服务器，等 TA 答完后，你们就能一起看到逐题对比啦。<br>（TA 打开游戏页面会自动接到这一轮）";
    startBtn.textContent = "📱 把手机给 TA 作答";
    startBtn.dataset.mode = "handover";
    startBtn.style.display = "inline-flex";
    startPolling();
    if (window.revealNow) window.revealNow();
  }

  function renderJoinable() {
    setRoundActive(true);            // 等我作答的这一轮没结束 → 历史锁着
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var meRaw = nameOf(myRole);     // textContent 用原值
    var me = esc(meRaw);            // innerHTML 才需要转义
    quesEl.innerHTML = "🥰 <b>" + esc(nameOf(otherRole(myRole))) + "</b> 正在等你作答！";
    msgEl.innerHTML = "TA 已经答完了这一轮，就差你了。开始后你会以「" + me + "」的身份作答，答完立刻出结果。";
    startBtn.textContent = "💞 开始作答（我是 " + meRaw + "）";
    startBtn.dataset.mode = "join";
    startBtn.style.display = "inline-flex";
    if (window.revealNow) window.revealNow();
  }

  /* 对方正在逐题作答（服务端只告知"有人在做"，不含任何答案） */
  function renderBusyWait() {
    setRoundActive(true);            // 有人正在作答 → 历史锁着
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    quesEl.textContent = "⏳ 对方正在作答中…";
    msgEl.innerHTML = "TA 正在答这一轮的 " + N_PER_ROUND + " 道题，答完后这个页面会自动接手，请稍候。";
    startBtn.style.display = "none";
    if (window.revealNow) window.revealNow();
  }

  function renderResult(res, title) {
    setRoundActive(false);           // 回合结束/看历史结果 → 解锁历史
    barEl.style.display = "none";
    optsEl.innerHTML = "";
    var aName = nameOf(res.roles.a), bName = nameOf(res.roles.b);
    quesEl.innerHTML = (title || "💞 默契值") + " <b class='compat-big' data-count=" + esc(res.pct) + ">" + esc(res.pct) + "%</b> · " + verdict(res.pct);
    msgEl.innerHTML = "共 " + esc(res.total) + " 题，你们答对了一样 " + esc(res.same) + " 题";
    optsEl.innerHTML = res.detail.map(function (d, i) {
      return '<div class="compat-row' + (d.match ? " ok" : " no") + '">' +
        '<div class="compat-q">' + (i + 1) + ". " + esc(d.q) + " " + (d.match ? "✅" : "❌") + "</div>" +
        '<div class="compat-ans"><b>' + esc(aName) + "</b>：" + esc(d.opts[d.a]) + "</div>" +
        '<div class="compat-ans"><b>' + esc(bName) + "</b>：" + esc(d.opts[d.b]) + "</div>" +
        "</div>";
    }).join("");
    /* 按钮文案里的身份必须与点下去真正用的身份同源。
       旧实现文案取 `myRole || res.roles.a`（对从"历史"点进来的那台设备，
       roles.a 是**对方**），而动作取 `myRole || "boy"` —— 写着"还是 <对方名字>"、
       点下去却以 boy 开局，作答页随即显示另一个名字，前后矛盾。
       身份未知时不替用户选，回到身份选择。 */
    startBtn.textContent = myRole ? "🔄 再测一轮（还是 " + nameOf(myRole) + "）" : "🔄 再测一轮";
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
    LC.after(function () { el.textContent = target + "%"; }, 1200);
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
      /* r.pct/same/total 是服务端算好的数字，这里按"拼 innerHTML 一律转义"
         的项目约定统一走 esc —— 兜住 compat.json 被手工改坏成字符串的情况 */
      row.innerHTML = "<span class='compat-hist-pct'>" + esc(r.pct) + "%</span>" +
        "<span class='compat-hist-info'>" + esc(nameOf(r.roles.a)) + " ♥ " + esc(nameOf(r.roles.b)) +
        " · 相同 " + esc(r.same) + "/" + esc(r.total) + " 题</span>" +
        "<span class='compat-hist-time'>" + esc(fmtRel(r.at)) + "</span>";
      row.addEventListener("click", function () {
        if (historyLocked) return;      // 回合进行中：不许用旧结果顶掉当前题面（F-S8-2）
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
    /* 每次重建历史列表都按「当前是否在回合中」重新上锁（第七轮 S8-02）。
       旧实现只在 dispatch() 里赋一次值，于是三条路径上锁与显示/可用性不同步：
       (a) 重开一轮（选身份 → 作答）不经过 dispatch → 列表仍可见、行按钮可点，
           点一下就用旧结果顶掉当前题面（F-S8-2 原症状复活）；
       (b) 自己提交后服务端立刻 done 的那条路径只 renderResult + renderHistory，
           从不解锁 → 整场访问历史都点不动，刷新才恢复；
       (c) 等待屏每 5s 一次 renderHistory 会把 display/disabled 两层冲掉。 */
    lockHistory(roundActive);
  }

  /* 「回合进行中」的单一状态：由各界面渲染函数维护（见各自的 setRoundActive 调用），
     renderHistory 每次都按它重新上锁 —— 锁是"当前界面状态"的函数，不是一次性的开关。 */
  var roundActive = false;

  /* 锁/解锁整块历史：隐藏 + 行按钮 disabled + 点击处理器早退（三层一起上 ——
     第一层是给视觉的，第二层是给键盘/辅助技术的，第三层保证"就算有人拿到了
     那个按钮引用去 .click()"也顶不掉题面）。 */
  function lockHistory(on) {
    historyLocked = !!on;
    if (!histEl) return;
    if (on) histEl.style.display = "none";
    var rows = histEl.querySelectorAll(".compat-hist-row");
    for (var i = 0; i < rows.length; i++) rows[i].disabled = !!on;
  }

  function setRoundActive(on) {
    roundActive = !!on;
    lockHistory(roundActive);
  }

  /* ---------------- 状态分发 ---------------- */
  function dispatch(j) {
    renderHistory(j.history || []);
    var a = j.active;
    /* 只要"回合还没结束/正在等对方/对方在答/待加入"就把历史锁起来。
       注意必须在 renderHistory() **之后**调用：那一步会把它重新显示出来。 */
    var inRound = (!a && j.busy)
      || !!(a && a.status !== "done" && (a.canJoin || a.status === "pending" || a.status === "waiting_b"));
    setRoundActive(inRound);
    if (!a) {
      // 有人在作答（服务端只给"忙"这个信号，不给任何内容）→ 等待并轮询
      if (j.busy) { renderBusyWait(); startPolling(); return; }
      // 无活跃回合 → 发起界面（含身份选择）
      setRoundActive(false);
      renderRolePick();
      return;
    }
    if (a.status === "done") {
      // 我参与的回合已完成（轮询/刷新检测到）→ 直接出结果
      stopPolling();
      myRole = a.myRole;
      lockHistory(false);      // 回合已结束：历史恢复可用（点它看旧结果才是正当用法）
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
    post({ action: "create", role: role, questions: questions })
      .then(function (j) {
        roundId = j.round.id;
        renderAnswering();
      })
      .catch(function (e) {
        if (e && e.server) {
          // 服务端明确拒绝：不要静默退回本地模式（那会让人以为服务器坏了）
          if (e.payload && e.payload.busy) {
            // 对方正在作答：等待并轮询，等 TA 答完自动接手
            renderBusyWait();
            startPolling();
            return;
          }
          /* 服务端说"你自己还有一轮没答完"（F-S8-1）：绝不能停在这一屏 ——
             上一版把这种情况也当成"对方在作答"（服务端那边没排除自己的回合），
             于是盖掉作答界面进了无按钮的等待屏，而轮询的三个出口
             （done / canJoin / 无活跃）一个都不命中 → 只能刷新，
             刷新后内存里已答的题全丢。现在直接把那一轮拉回来继续答。 */
          if (e.payload && e.payload.mine) {
            msgEl.innerHTML = "↩️ " + esc(e.message);
            getStatus(true).then(function (j) {
              stopPolling();
              dispatch(j);
            }).catch(function () {
              msgEl.innerHTML = "⚠️ 拉取你那轮没答完的回合失败，请刷新页面重试";
            });
            return;
          }
          msgEl.innerHTML = "⚠️ " + esc(e.message);
          quesEl.textContent = "💞 默契度测试";
          startBtn.textContent = "🔄 重新选择身份";
          startBtn.dataset.mode = "restart";
          startBtn.style.display = "inline-flex";
          return;
        }
        fallbackLocal();   // 网络/服务器不可用 → 回退本地双槽
      });
  }

  function submitRound() {
    /* 提交在途：把最后一题留在屏幕上的选项按钮一并禁用（见 ask 上方 S8-01 的说明），
       并让 ask() 直接早退。失败分支恢复可点状态，由"重新提交/重新开始"按钮接手。 */
    submitting = true;
    barEl.style.display = "none";
    quesEl.textContent = "⏳ 正在提交…";
    var lastBtns = optsEl.querySelectorAll("button");
    for (var bi = 0; bi < lastBtns.length; bi++) lastBtns[bi].disabled = true;
    post({ action: "submit", id: roundId, role: myRole, answers: answers })
      .then(function (j) {
        if (j.done) {
          stopPolling();
          renderResult(j.result);
          // 只静默刷新历史（强制实时 fetch，注入是页面加载时的旧数据）；
          // 不要用注入的旧状态重新 dispatch，否则会把结果页覆盖回"等待加入"界面
          getStatus(true).then(function (j2) {
            renderHistory(j2.history || []);   // renderHistory 会按 roundActive=false 解锁
          }).catch(function () {});
        } else {
          renderWaiting();
        }
      })
      .catch(function (e) {
        submitting = false;      // 允许"重新提交"（走 startBtn 分支，不经过 ask）
        var isServer = !!(e && e.server);
        /* badResponse：宿主/WAF 返回了 HTML 错误页（拿到了响应但不可解析）。
           e.message 已经是一句人话（"服务器返回了无法解析的内容（HTTP 500）…"），
           别再套一层"提交失败（…），请检查网络后重试" —— 那句会把它说成网络问题。
           按钮仍然给"重新提交"：挑战页/中间层抖动是**暂时**的，重试才是对的动作；
           给"重新开始一轮"会把用户刚答完的一整轮答案丢掉。 */
        var badResp = !!(e && e.badResponse);
        optsEl.innerHTML = "";
        msgEl.innerHTML = "⚠️ " + (isServer || badResp
          ? esc(e && e.message)
          : "提交失败（" + esc(e && e.message) + "），请检查网络后重试");
        quesEl.textContent = "已答完 " + questions.length + " / " + questions.length + " 题";
        if (isServer) {
          // 业务错误（回合已被对方作废 / 已经答过）：重试没有意义，只能重新开始
          startBtn.textContent = "🔄 重新开始一轮";
          startBtn.dataset.mode = "restart";
        } else {
          startBtn.textContent = "🔄 重新提交";
          startBtn.dataset.mode = "retry";
        }
        startBtn.style.display = "inline-flex";
      });
  }

  function startPolling() {
    stopPolling();
    pollFails = 0;
    pollTimer = LC.every(function () {
      // 必须强制实时 fetch：注入的 __SERVER_COMPAT__ 是页面加载那一刻的
      // 快照，拿它轮询永远等不到对方答完（刷新过页面就中招）
      getStatus(true).then(function (j) {
        pollFails = 0;
        var a = j.active;
        if (a && a.status === "done") { stopPolling(); dispatch(j); return; }
        if (a && a.canJoin) { stopPolling(); dispatch(j); return; }
        if (!a && !j.busy) { stopPolling(); dispatch(j); return; }   // 对方放弃了/回合过期
        renderHistory(j.history || []);
      }).catch(function () {
        /* 网络抖动继续等下一次，但**不能永远静默**：等待页（含"对方正在作答"那一屏）
           没有任何按钮，如果轮询一直失败（中间层挑战页/长期断网），用户会永远停在
           "答完后这个页面会自动接手，请稍候"，除了刷新没有别的办法。
           连续几次都失败就给一个明确的出口：停止轮询 + 一个"重试"按钮
           （复用已有的 restart 分支：重新拉状态，失败则回到身份选择）。 */
        if (++pollFails < POLL_FAIL_MAX) return;
        stopPolling();
        quesEl.textContent = "⚠️ 暂时连不上服务器";
        msgEl.innerHTML = "已经连续 " + pollFails + " 次没拿到回应（网络或中间层的问题，不是你操作错了）。" +
          "网络恢复后点下面的按钮重试；TA 那边答完的内容不会丢。";
        startBtn.textContent = "🔄 重试";
        startBtn.dataset.mode = "restart";
        startBtn.style.display = "inline-flex";
      });
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { LC.clear(pollTimer); pollTimer = null; } }

  /* ---------------- 降级：localStorage 双槽（原行为） ---------------- */
  var LOCAL_KEY = "love-compat";
  /* 可见提示的统一出口：优先用全站 toast（main.js 提供）；它还没加载 / 不可用时，
     往区块顶部插一行常驻文案。"降级到本机模式""丢弃半截记录"这类事必须看得见，
     不能只 console.log —— 用户看不到就等于没提示。 */
  function notify(msg) {
    if (typeof toast === "function") { toast(msg); return; }
    if (window.toast) { window.toast(msg); return; }
    var note = document.createElement("div");
    note.className = "compat-mode-note";
    note.textContent = "ℹ️ " + msg;
    if (box.insertBefore) box.insertBefore(note, box.firstChild || null);
    else box.appendChild(note);
  }
  /* removeItem 在"站点存储被禁用"时同样会抛：别让异常把整条降级流程打断 */
  function dropLocal() {
    try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
  }
  function localLoad() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch (e) { return {}; } }
  /* 返回是否真的写成功：本机双槽要靠它把"第一人的成绩"存下来给第二个人用。
     旧写法把异常吞掉之后照样宣布"✅ 第一人答完啦"，第二个人的结果计算随即拿到
     undefined 抛 TypeError、页面卡死（第四轮 F-S6-03）。口径与其它页面的 writeLS 一致。 */
  function localSave(d) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); return true; } catch (e) { return false; }
  }
  /* 只有两边都是**数组**（且长度与题目数一致）才能算结果：本机数据可能被手工改坏、
     也可能是"写了一半"（只有 b 没有 a）。旧码直接 a[i] → 必抛。 */
  function localReady(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === Q.length && b.length === Q.length;
  }
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
      /* 存不下就别宣布"答完啦"：第二个人接着答时算不出结果（`data.a` 是 undefined），
         用户会被"答完啦 → 轮到第二个人 → 一片空白/卡死"耍一遍（第四轮 F-S6-03）。 */
      if (!localSave(data)) {
        quesEl.textContent = "⚠️ 本机存储写不进去，第一人的成绩没能存下来";
        msgEl.innerHTML = "（空间满或被浏览器禁用站点存储）现在交给第二个人会算不出默契值。" +
          "请先清理一点存储空间，或等服务器恢复后再测。";
        optsEl.innerHTML = "";
        startBtn.textContent = "🔄 我明白了，重新测一次";
        startBtn.dataset.mode = "local_reset";
        startBtn.style.display = "inline-flex";
        if (window.revealNow) window.revealNow();
        return;
      }
      quesEl.textContent = "✅ 第一人答完啦！请把手机/页面交给第二个人继续";
      msgEl.innerHTML = "（服务器不可用，结果只存本机）";
      optsEl.innerHTML = "";
      startBtn.textContent = "💞 轮到第二个人作答";
      startBtn.dataset.mode = "local_play2";
      startBtn.style.display = "inline-flex";
    } else {
      data.b = answers;
      var saved = localSave(data);
      /* 第二人的结果照样算得出来（a 在存储里、b 在内存里），但**a 缺失时绝不能算**：
         旧码 `localCalc(undefined, b)` 抛 TypeError，点击处理器整个中断、没有结果也没有提示。 */
      if (!localReady(data.a, data.b)) {
        quesEl.textContent = "⚠️ 第一人的成绩不在本机，算不出默契值";
        msgEl.innerHTML = "（本机存储里没有第一人的答案）抱歉，需要两个人重新测一次。";
        optsEl.innerHTML = "";
        startBtn.textContent = "🔄 重新测一次";
        startBtn.dataset.mode = "local_reset";
        startBtn.style.display = "inline-flex";
        if (window.revealNow) window.revealNow();
        return;
      }
      localRenderResult(data.a, data.b);
      if (!saved) toast("本机存储写不进去，这次结果只是临时的，刷新就没有了");
    }
    if (window.revealNow) window.revealNow();
  }
  function fallbackLocal() {
    // 服务器不可用：完整回退到旧的 localStorage 双槽玩法
    localMode = true;
    var data = localLoad();
    /* 半截记录（只有 b、没有 a / 长度与题库不符）既算不出结果，留着还会在
       "本机第一人答完"之后跟新的 a 拼出一个**假结果**：旧码这里只判 `data.b`，
       于是 localCalc(undefined, b) 在 a[i] 处抛 TypeError，异常冒泡成未处理的
       拒绝，界面停在"⏳ 正在创建回合…"且无按钮、无提示（R5-8）。
       所以不能只是"不崩"——整条丢弃，并如实提示一次。 */
    var dropped = false;
    if (data.b && !localReady(data.a, data.b)) { dropLocal(); data = {}; dropped = true; }
    localSlot = data.a ? 2 : 1;
    /* 降级必须是**可见**的（R5-9a）：否则用户以为在玩双机回合，答案其实只写在本机，
       等第二个人答完才发现白答两轮。 */
    notify("服务器暂时不可用，已切换为本机模式：这一轮的结果只存在这台设备上"
      + (dropped ? "（本机那条不完整的旧记录已清掉）" : ""));
    if (localReady(data.a, data.b)) { localRenderResult(data.a, data.b); return; }
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
    } else if (mode === "restart") {
      // 回合已被作废/已经答过：重试无意义，回到身份选择重新开始
      startBtn.style.display = "none";
      getStatus(true).then(dispatch).catch(function () { renderRolePick(); });
    } else if (mode === "again") {
      if (!confirmReset) {
        confirmReset = true;
        /* 文案不再说"当前回合将作废"：服务端在 TTL 内**根本不会作废**任何回合
           （它只是拒绝新建；若你自己还有一轮没答完，会把你带回那一轮继续答）。
           原先那句是假的，会让人以为点了就开始删数据（第四轮 F-S8-1 旁证）。 */
        startBtn.textContent = "⚠️ 确认开新一轮？";
        LC.after(function () { confirmReset = false; startBtn.textContent = "🔄 再测一轮"; }, 3000);
        return;
      }
      confirmReset = false;
      // 身份未知（从"历史"点进来时 myRole 还是 null）→ 不替用户选，回到身份选择
      if (myRole) createRound(myRole);
      else renderRolePick();
    } else if (mode === "local_reset") {
      if (!confirmReset) {
        confirmReset = true;
        startBtn.textContent = "⚠️ 确认清空本地记录并重测？";
        LC.after(function () { confirmReset = false; startBtn.textContent = "🔄 重新测一次"; }, 3000);
        return;
      }
      confirmReset = false;
      // removeItem 在"站点存储被禁用"时同样会抛：别让点击处理器半路中断、界面停在确认态
      try { localStorage.removeItem(LOCAL_KEY); } catch (e) { toast("本机存储被禁用，清不掉本地记录"); }
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
      /* 本机数据可能只有一半（写了一半 / 被手工改坏）：旧码 `if (data.b)` 就直接算，
         `localCalc(undefined, b)` 抛 TypeError，页面永远停在"⏳ 加载中…"（第四轮 F-S6-03）。 */
      if (localReady(data.a, data.b)) { localRenderResult(data.a, data.b); return; }
      renderRolePick();
    });
})();
