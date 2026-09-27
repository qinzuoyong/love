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
  let saved = null;      // 这一轮的落盘结果（见 persistResult）；最后一题答完时立刻填上
  /* 切页时本页脚本会被**重新执行**，而"视图都换掉了还要跑的一次性定时器"不随视图
     内容消失 —— 一律登记给生命周期（archive 里的判据：有用户可见副作用的一次性
     定时器必须走账本，纯清理动作的才豁免）。非挂载期（直接打开本页）它退化成原生
     setTimeout，行为不变。 */
  const LC = window.LoveLifecycle || { after: (fn, ms) => setTimeout(fn, ms) };

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

    // 答案统一转数字再比较：后台旧数据可能把 a 存成字符串 "3"，
    // 严格 === 会静默判错（点正确选项也报错）
    const a = Number(q.a);
    const valid = Number.isInteger(a) && a >= 0 && a < q.opts.length;

    if (valid && i === a) {
      score++;
      btn.classList.add("correct");
      msgEl.textContent = "🎉 答对啦！";
    } else {
      btn.classList.add("wrong");
      if (valid) btns[a].classList.add("correct");
      msgEl.textContent = valid
        ? "😢 答错了…正确答案是「" + q.opts[a] + "」"
        : "😢 这道题的答案设置有误，先跳过吧";
    }
    btns.forEach((b) => (b.disabled = true));

    /* 最后一题答完就**立刻**落盘（S8-04）：界面推进改走 LC.after 之后，切页会把
       定时器连同回调一起作废；若落盘还挂在回调里，用户答完最后一题就切页
       = 这一轮成绩不入账（「玩一局默契问答」「答对八题」等成就当场显示未解锁，
       用户只能再切一次才看到）。 */
    if (index + 1 >= questions.length) saved = persistResult();

    LC.after(() => {
      index++;
      if (index < questions.length) {
        load();
      } else {
        finish();
      }
    }, 1400);
  }

  /* finish() 的"写盘段"抽成独立函数：由 answer() 在最后一题答完时立即调用，
     界面推进 / 礼花 / 文案复位留给 1400ms 后的 finish()（那个定时器走 LC.after，
     切页时自动作废）。返回值喂给 finish()，保证「新纪录 / 历史最高 / 写盘失败提示」
     用的都是真实状态 —— 定时器被取消也不会让这两件事互相打架。 */
  function persistResult() {
    const total = questions.length;   // "连题数一起存"要用它（A20 的源码切片把它当参数注入）
    // 历史最高分：连"当时的总题数"一起存，否则改题库后会显示成 "8 / 3"
    let best = { s: 0, t: 0 };
    try {
      const raw = localStorage.getItem(BEST_KEY);
      if (raw) {
        if (/^\d+$/.test(raw)) {
          best = { s: parseInt(raw, 10) || 0, t: 0 };   // 旧格式：只存了答对数，不知道当时题数
        } else {
          const o = JSON.parse(raw) || {};
          best = { s: parseInt(o.s, 10) || 0, t: parseInt(o.t, 10) || 0 };
        }
      }
    } catch (e) {}
    let newRecord = false;
    /* `bestSaved`/`playedSaved` 记录这两笔写盘到底成没成（R5-11）。
       触发条件是真实存在的：Safari 无痕、iOS 配额满、站点存储被禁用。
       旧码把 setItem 的异常吞掉之后照样按新值渲染「🏆 新纪录！」与"历史最高"，
       用户看到一个刷新就消失、而且盘上根本没有的纪录。 */
    let bestSaved = true;
    if (score > best.s) {
      const cand = { s: score, t: total };
      /* 先写盘、再认这条纪录：写不进去就什么也不宣称，best 保持盘上读到的旧值 */
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify(cand));
        best = cand;
        newRecord = true;
      } catch (e) { bestSaved = false; }
    }
    /* 「玩过一局」必须**单独**记一笔（第四轮 F-S8-3）：分数与"是否玩过"是两件事 ——
       首轮 0 分时 `score > best.s` 不成立，于是什么都不落盘，本机连痕迹都没有，
       成就「玩一局默契问答」按"玩过"判定就永远解不开（旧格式数据同理）。
       刻意不动 love-quiz-best 的语义：把本轮的 total 填进历史那一条，会造出上面注释里
       警告过的 "8 / 3" 那种错配（历史那轮的题数已经丢了，补不回来）。
       这一笔同样可能写不进去（成就系统靠它判定"玩过一局"）→ 单独记下成功与否。 */
    let playedSaved = true;
    try { localStorage.setItem("love-quiz-played", "1"); } catch (e) { playedSaved = false; }
    const bestLabel = best.t > 0 ? best.s + " / " + best.t : best.s + " 题";
    return { newRecord: newRecord, bestSaved: bestSaved, playedSaved: playedSaved, bestLabel: bestLabel };
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

    /* 写盘与结果判定已经在最后一题答完时做掉了（saved）—— 这里只负责界面：
       进度条、结果、礼花、文案复位。定时器被切页取消也不会把这些"事实"弄丢。
       兜底的 persistResult() 只在"没经过最后一题就跑到 finish"这种不可达路径上才可能
       命中；真发生了就现补一次写盘，绝不在界面上编一个盘上没有的纪录。 */
    const r = saved || persistResult();
    const newRecord = r.newRecord, bestSaved = r.bestSaved, playedSaved = r.playedSaved, bestLabel = r.bestLabel;

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
      '<br><span class="quiz-best">历史最高：' + bestLabel + "</span>";

    optsEl.appendChild(scoreEl);
    optsEl.appendChild(verdictEl);
    againBtn.style.display = "inline-flex";
    /* 写盘失败必须如实说一次（R5-11）：不能一边"没存下"、一边让人以为以后还能
       看到这个纪录；成就系统靠 love-quiz-played 判定"玩过一局"，那条失败更要说明白。
       文案里的"历史最高"取的是 bestLabel —— 它此时就是盘上真实的那个值。 */
    if (!bestSaved || !playedSaved) {
      let msg = "";
      if (!bestSaved) msg += "本机存储写不进去，这次成绩没存下（历史最高仍是 " + bestLabel + "）";
      if (!playedSaved) msg += (msg ? "；" : "") + "这局不会被记成「玩过一局」";
      if (typeof toast === "function") toast(msg);
      else if (window.toast) window.toast(msg);
    }
    window.burstConfetti(2800);
  }

  againBtn.addEventListener("click", () => {
    index = 0;
    score = 0;
    saved = null;             // 新一轮：上一轮的落盘结果不许被当成这一轮的（见 finish）
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
