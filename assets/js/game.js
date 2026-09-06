/* ============================================================
   情侣网站 · 默契问答小游戏
   逐题作答 → 即时反馈 → 得分评价 → 通关彩带
   ============================================================ */

(function () {
  "use strict";

  const box = document.getElementById("quizBox");
  if (!box || !CONFIG.quiz || !CONFIG.quiz.length) return;

  const questions = CONFIG.quiz;
  const bar = document.getElementById("quizBar");
  const quesEl = document.getElementById("quizQues");
  const optsEl = document.getElementById("quizOpts");
  const msgEl = document.getElementById("quizMsg");
  const againBtn = document.getElementById("quizAgain");

  let index = 0;
  let score = 0;
  let locked = false;

  const BEST_KEY = "love-quiz-best";

  function load() {
    locked = false;
    const q = questions[index];
    bar.style.width = ((index / questions.length) * 100) + "%";
    quesEl.textContent = "第 " + (index + 1) + " / " + questions.length + " 题 · " + q.q;
    msgEl.textContent = "";
    optsEl.innerHTML = "";

    q.opts.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "quiz-opt";
      btn.textContent = opt;
      btn.addEventListener("click", () => answer(i, btn));
      optsEl.appendChild(btn);
    });
  }

  function answer(i, btn) {
    if (locked) return;
    locked = true;
    const q = questions[index];
    const btns = optsEl.querySelectorAll(".quiz-opt");

    if (i === q.a) {
      score++;
      btn.classList.add("correct");
      msgEl.textContent = "🎉 答对啦！";
    } else {
      btn.classList.add("wrong");
      btns[q.a].classList.add("correct");
      msgEl.textContent = "😢 答错了…正确答案是「" + q.opts[q.a] + "」";
    }
    btns.forEach((b) => (b.disabled = true));

    setTimeout(() => {
      index++;
      if (index < questions.length) {
        load();
      } else {
        finish();
      }
    }, 1400);
  }

  function finish() {
    bar.style.width = "100%";
    const total = questions.length;
    const pct = Math.round((score / total) * 100);
    let verdict, emoji;
    if (pct === 100)       { verdict = "满分默契！你们简直是彼此的复制粘贴"; emoji = "👑"; }
    else if (pct >= 80)    { verdict = "默契度超高，继续了解彼此吧"; emoji = "💯"; }
    else if (pct >= 60)    { verdict = "还不错，再聊聊天会更好哦"; emoji = "😄"; }
    else if (pct >= 40)    { verdict = "看来还需要多一点交流呢"; emoji = "🤔"; }
    else                   { verdict = "快去多陪陪 TA 吧！"; emoji = "💪"; }

    // 历史最高分
    let best = 0;
    try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) {}
    let newRecord = false;
    if (score > best) {
      best = score;
      newRecord = true;
      try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {}
    }

    quesEl.textContent = emoji + " 考验结束！";
    optsEl.innerHTML = "";
    msgEl.textContent = "";
    const scoreEl = document.createElement("div");
    scoreEl.className = "quiz-score";
    scoreEl.textContent = score + " / " + total;
    const verdictEl = document.createElement("div");
    verdictEl.className = "quiz-verdict";
    verdictEl.innerHTML =
      verdict + (newRecord ? '<br><span class="quiz-record">🏆 新纪录！</span>' : "") +
      '<br><span class="quiz-best">历史最高：' + best + " / " + total + "</span>";

    optsEl.appendChild(scoreEl);
    optsEl.appendChild(verdictEl);
    againBtn.style.display = "inline-flex";
    window.burstConfetti(2800);
  }

  againBtn.addEventListener("click", () => {
    index = 0;
    score = 0;
    againBtn.style.display = "none";
    load();
  });

  load();

  /* ---------- 真心话卡片 ---------- */
  const truthCard = document.getElementById("truthCard");
  const truthBtn = document.getElementById("truthBtn");
  if (truthCard && truthBtn && CONFIG.truthDares && CONFIG.truthDares.length) {
    let lastIdx = -1;
    truthBtn.addEventListener("click", () => {
      let idx;
      do {
        idx = (Math.random() * CONFIG.truthDares.length) | 0;
      } while (idx === lastIdx && CONFIG.truthDares.length > 1);
      lastIdx = idx;
      truthCard.classList.remove("flip");
      void truthCard.offsetWidth; // 重启动画
      truthCard.textContent = CONFIG.truthDares[idx];
      truthCard.classList.add("flip");
    });
  }
})();
