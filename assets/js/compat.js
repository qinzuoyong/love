/* ============================================================
   情侣网站 · 默契度测试
   两人各答同一套题, 逐题对比算默契百分比
   (参考 couple-score / IYKYK 的思路, 自写实现, localStorage 双槽)
   仅 game.html 加载, 依赖 CONFIG.compatQuiz
   ============================================================ */

(function () {
  "use strict";

  const box = document.getElementById("compatBox");
  if (!box || !CONFIG.compatQuiz || !CONFIG.compatQuiz.length) return;

  const Q = CONFIG.compatQuiz;
  const KEY = "love-compat";
  const quesEl = document.getElementById("compatQues");
  const optsEl = document.getElementById("compatOpts");
  const msgEl = document.getElementById("compatMsg");
  const barEl = document.getElementById("compatBar");
  const barFill = document.getElementById("compatBarFill");
  const startBtn = document.getElementById("compatStart");

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }

  let slot = 1;      // 1 = 第一人, 2 = 第二人
  let index = 0;     // 当前题号
  let answers = [];  // 本槽答案
  let confirmReset = false;

  function renderStart() {
    const data = load();
    optsEl.innerHTML = "";
    msgEl.textContent = "";
    if (data.b) {
      // 双方都答过 → 直接看结果
      quesEl.textContent = "💞 上次结果：默契 " + calcPct(data.a, data.b) + "%";
      startBtn.textContent = "📊 查看详细结果";
      startBtn.dataset.mode = "result";
    } else if (data.a) {
      quesEl.textContent = "第一个人已经答完啦，轮到第二个人咯";
      startBtn.textContent = "💞 我来答（第二人）";
      startBtn.dataset.mode = "play2";
    } else {
      quesEl.textContent = "两个人各答一遍同样的题目，系统会逐题对比算出默契值";
      startBtn.textContent = "💞 开始测试（第一人）";
      startBtn.dataset.mode = "play1";
    }
    startBtn.style.display = "inline-flex";
  }

  function calcPct(a, b) {
    let same = 0;
    for (let i = 0; i < Q.length; i++) if (a[i] === b[i]) same++;
    return Math.round((same / Q.length) * 100);
  }

  function verdict(pct) {
    if (pct >= 90) return "👑 天生一对！你们的脑回路是同一个电路板";
    if (pct >= 75) return "💯 默契爆棚，连想法都长一个样";
    if (pct >= 60) return "😄 很有默契，再聊聊会更懂彼此";
    if (pct >= 40) return "🤔 小有默契，有些题值得聊一聊";
    return "💪 快去多聊聊天，默契是聊出来的";
  }

  function renderResult(a, b) {
    const pct = calcPct(a, b);
    quesEl.innerHTML = "默契值 <b class='compat-big'>" + pct + "%</b> · " + verdict(pct);
    msgEl.innerHTML = "共 " + Q.length + " 题，你们答对了一样 " +
      Q.filter((_, i) => a[i] === b[i]).length + " 题";
    optsEl.innerHTML = Q.map((q, i) => {
      const same = a[i] === b[i];
      return '<div class="compat-row' + (same ? " ok" : " no") + '">' +
        '<div class="compat-q">' + (i + 1) + ". " + q.q + " " + (same ? "✅" : "❌") + "</div>" +
        '<div class="compat-ans">第一人：' + q.opts[a[i]] + "</div>" +
        '<div class="compat-ans">第二人：' + q.opts[b[i]] + "</div>" +
        "</div>";
    }).join("");
    barEl.style.display = "none";
    startBtn.textContent = "🔄 重新测一次";
    startBtn.dataset.mode = "reset";
    startBtn.style.display = "inline-flex";
    if (window.revealNow) window.revealNow();
  }

  function ask(i, btn) {
    answers[index] = i;
    index++;
    if (index < Q.length) renderQ();
    else finishSlot();
  }

  function renderQ() {
    const q = Q[index];
    quesEl.textContent = "第 " + (index + 1) + " / " + Q.length + " 题 · 第" + (slot === 1 ? "一" : "二") + "个人作答";
    msgEl.textContent = q.q;
    barEl.style.display = "block";
    barFill.style.width = ((index / Q.length) * 100) + "%";
    optsEl.innerHTML = "";
    q.opts.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "quiz-opt compat-opt";
      btn.textContent = opt;
      btn.addEventListener("click", () => ask(i, btn));
      optsEl.appendChild(btn);
    });
  }

  function finishSlot() {
    barEl.style.display = "none";
    const data = load();
    if (slot === 1) {
      data.a = answers;
      save(data);
      quesEl.textContent = "✅ 第一人答完啦！请把手机/页面交给第二个人继续";
      msgEl.textContent = "";
      optsEl.innerHTML = "";
      startBtn.textContent = "💞 轮到第二个人作答";
      startBtn.dataset.mode = "play2";
      startBtn.style.display = "inline-flex";
      if (window.revealNow) window.revealNow();
    } else {
      data.b = answers;
      save(data);
      renderResult(data.a, data.b);
    }
  }

  startBtn.addEventListener("click", () => {
    const mode = startBtn.dataset.mode;
    if (mode === "result") {
      const data = load();
      renderResult(data.a, data.b);
    } else if (mode === "play2") {
      slot = 2; index = 0; answers = []; confirmReset = false;
      startBtn.style.display = "none";
      renderQ();
    } else if (mode === "play1") {
      slot = 1; index = 0; answers = []; confirmReset = false;
      startBtn.style.display = "none";
      renderQ();
    } else if (mode === "reset") {
      // 两步确认防误触(比 confirm 弹窗更顺滑)
      if (!confirmReset) {
        confirmReset = true;
        startBtn.textContent = "⚠️ 确认清空上次记录并重测？";
        setTimeout(() => {
          confirmReset = false;
          startBtn.textContent = "🔄 重新测一次";
        }, 3000);
        return;
      }
      confirmReset = false;
      localStorage.removeItem(KEY);
      renderStart();
    }
  });

  renderStart();
})();
