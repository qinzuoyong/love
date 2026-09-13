/* ============================================================
   情侣网站 · 情书 & 许愿瓶 & 留言板
   信封点击翻开 / 心愿点击展开 / 写新情书 / 悄悄话留言板
   手写情书与留言现在存在服务器（跨设备共享，管理员可管理），
   服务器不可用时自动降级为浏览器本地存储（原行为）。
   ============================================================ */

(function () {
  "use strict";

  const EXTRA_KEY = "love-letters-extra";   // 手写情书（本机兜底/旧数据迁移源）
  const BOARD_KEY = "love-messages";        // 留言板（本机兜底/旧数据迁移源）
  const S = window.loveServer;

  function readLS(key, fallback) {
    /* 解析结果必须是数组：被手工改坏成 "{}" 之类时，下面的 forEach/filter 会立刻
       抛 "is not a function"，整个 IIFE 随之中断 —— 许愿瓶、留言板、服务器同步
       全都起不来。非数组一律回退到调用方给的缺省值。 */
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  // 防 HTML 注入: 所有用户输入内容一律转义后插入
  function escapeHtml(str) {
    // null/undefined 兜底：老数据缺字段时不该渲染成字面量 "undefined"
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 本机旧数据补 uid（服务器去重靠 uid，重复打开不会传两遍）
  function normalizeLocal(key, prefix) {
    const list = readLS(key, []);
    let changed = false;
    list.forEach((it, i) => {
      // 本机存储被写成字符串数组（或被手工改坏）时，给原始值赋属性在严格模式下
      // 会直接抛 TypeError，整段脚本随之中断 —— 先挡掉非对象条目。
      if (!it || typeof it !== "object") return;
      if (!it.uid) { it.uid = prefix + Date.now().toString(36) + "_" + i; changed = true; }
    });
    if (changed) writeLS(key, list);
    return list;
  }
  function toast(msg) { if (window.toast) window.toast(msg); }

  /* ---------- 服务器数据 ---------- */
  let serverLetters = [];
  let serverMessages = [];

  /* ---------- 情书列表（配置 + 手写[服务器+本机]） ---------- */
  const letterGrid = document.getElementById("letterGrid");

  function letterHTML(lt, handwritten, canDel) {
    const title = escapeHtml(lt.title);
    const body = escapeHtml(lt.body);
    const sign = escapeHtml(lt.sign);
    return (
      '<div class="env-inner">' +
      '  <div class="env-face env-front">' +
      (handwritten ? '<span class="env-badge">✍️ 手写</span>' : "") +
      '    <div class="seal">✉️</div>' +
      "    <h3>" + title + "</h3>" +
      '    <div class="hint">点击翻开这封信</div>' +
      "  </div>" +
      '  <div class="env-face env-back">' +
      '    <div class="letter-date">' + escapeHtml(lt.date) + "</div>" +
      "    <h4>" + title + "</h4>" +
      '    <div class="letter-body">' + body + "</div>" +
      '    <div class="sign">—— ' + sign + "</div>" +
      (canDel
        ? '<button class="env-del" data-uid="' + escapeHtml(lt.uid) + '" data-kind="' + (lt.server ? "server" : "local") + '">🗑 删除这封信</button>'
        : "") +
      "  </div>" +
      "</div>"
    );
  }

  function allLetters() {
    return normalizeLocal(EXTRA_KEY, "l").map((lt) => Object.assign({}, lt, { local: true }))
      .concat(serverLetters.map((lt) => Object.assign({}, lt, { server: true })))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function renderLetters() {
    if (!letterGrid) return;
    const all = allLetters();

    letterGrid.innerHTML = "";
    all.forEach((lt) => {
      const canDel = !!lt.local || !!lt.mine;   // 归属由服务器判定（前端拿不到任何凭据）
      const env = document.createElement("div");
      env.className = "envelope reveal handwritten";
      env.innerHTML = letterHTML(lt, true, canDel);
      /* 点"删除这封信"时不翻信封：信封自己的 click（冒泡先于 letterGrid 的
         委托）会把 open 切换一次，随后删除重渲染掩盖 —— 视觉上闪一下。
         委托层的 e.stopPropagation 挡不住这里，必须在信封侧放行删除按钮。 */
      env.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest(".env-del")) return;
        env.classList.toggle("open");
      });
      letterGrid.appendChild(env);
    });
    (CONFIG.letters || []).forEach((lt) => {
      const env = document.createElement("div");
      env.className = "envelope reveal";
      env.innerHTML = letterHTML(lt, false, false);
      env.addEventListener("click", () => env.classList.toggle("open"));
      letterGrid.appendChild(env);
    });

    if (window.revealNow) window.revealNow();
  }

  // 删除手写情书（事件委托, 只绑一次）
  if (letterGrid) {
    letterGrid.addEventListener("click", (e) => {
      const del = e.target.closest(".env-del");
      if (!del) return;
      e.stopPropagation();
      const uid = del.dataset.uid;
      const kind = del.dataset.kind;
      const target = allLetters().find((x) => x.uid === uid);
      if (!target) return;
      if (!window.confirm("确定删除这封手写的情书吗？")) return;

      if (kind === "local") {
        const list = normalizeLocal(EXTRA_KEY, "l");
        const i = list.findIndex((x) => x.uid === uid);
        if (i !== -1) { list.splice(i, 1); writeLS(EXTRA_KEY, list); }
        renderLetters();
        toast("已删除");
      } else if (kind === "server" && S) {
        S.post({ action: "delete", kind: "letters", uid: uid })
          .then(() => {
            serverLetters = serverLetters.filter((x) => x.uid !== uid);
            renderLetters();
            toast("已删除");
          })
          .catch((err) => toast("删除失败：" + err.message));
      }
    });
    renderLetters();
  }

  /* ---------- 写新情书弹窗 ---------- */
  const modal = document.getElementById("letterModal");
  const newLetterBtn = document.getElementById("newLetterBtn");

  if (modal && newLetterBtn) {
    const t = document.getElementById("lmTitle");
    const b = document.getElementById("lmBody");
    const s = document.getElementById("lmSign");

    function openModal() {
      modal.classList.add("open");
      document.body.style.overflow = "hidden";
      t.value = ""; b.value = ""; s.value = "";
      setTimeout(() => t.focus(), 100);
    }
    function closeModal() {
      modal.classList.remove("open");
      document.body.style.overflow = "";
    }

    newLetterBtn.addEventListener("click", openModal);
    document.getElementById("lmCancel").addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

    function saveLocalLetter(rec) {
      const list = normalizeLocal(EXTRA_KEY, "l");
      list.push(rec);
      writeLS(EXTRA_KEY, list);
      closeModal();
      renderLetters();
      toast("已存到本机（服务器暂不可用）");
    }

    document.getElementById("lmSave").addEventListener("click", () => {
      const title = t.value.trim();
      const body = b.value.trim();
      const sign = s.value.trim() || CONFIG.names.boy;
      if (!title || !body) {
        toast("标题和内容都要写哦");
        return;
      }
      const now = new Date();
      const rec = {
        date: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0"),
        title: title, body: body, sign: sign,
        uid: window.newUid ? window.newUid("l") : "l" + Date.now() + Math.floor(Math.random() * 1000),
      };
      if (S) {
        S.post({ action: "letter_add", date: rec.date, title: title, body: body, sign: sign, uid: rec.uid })
          .then((j) => {
            serverLetters.push(j.record);
            closeModal();
            renderLetters();
            toast("情书写好啦，已存到服务器 💌");
          })
          .catch((err) => {
            /* 服务端明确拒绝（429 限流 / 未解锁 / 参数错）不等于"服务器不可用"：
               如实提示，别静默转存本地 —— 否则用户以为存上了，而那条记录会在
               每次打开页面时被反复重传。口径与 capsules.js 一致。 */
            if (err && err.server) {
              toast(err.locked ? "还没解锁，请先回首页解锁 🔒" : (err.message || "服务器拒绝了这次提交"));
              return;
            }
            saveLocalLetter(rec);
          });
      } else {
        saveLocalLetter(rec);
      }
    });
  }

  /* ---------- 许愿瓶 ---------- */
  const wishGrid = document.getElementById("wishGrid");
  if (wishGrid && CONFIG.wishes && CONFIG.wishes.length) {
    const bottles = ["🏺", "🍾", "🥛", "🧴", "🍶", "🥤", "🧃", "🍹", "☕"];
    CONFIG.wishes.forEach((w, i) => {
      const item = document.createElement("div");
      item.className = "wish glass reveal";
      item.style.transitionDelay = (i % 6) * 60 + "ms";
      item.innerHTML =
        '<span class="bottle">' + bottles[i % bottles.length] + "</span>" +
        '<div class="w-title">' + escapeHtml(w.title) + "</div>" +
        '<div class="w-text">' + escapeHtml(w.text) + "</div>";
      item.addEventListener("click", () => {
        // 同时只能打开一个
        wishGrid.querySelectorAll(".wish.open").forEach((x) => x.classList.remove("open"));
        item.classList.add("open");
      });
      wishGrid.appendChild(item);
    });
  }

  /* ---------- 悄悄话留言板 ---------- */
  const boardList = document.getElementById("boardList");

  function pad(n) { return String(n).padStart(2, "0"); }
  // 时间戳归一成秒：服务器存秒，本机旧数据存毫秒。
  // 排序必须统一单位，否则毫秒时间戳的旧留言永远排在所有服务器留言之上
  function normTs(ts) { return ts > 1e12 ? Math.floor(ts / 1000) : (ts || 0); }
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts < 1e12 ? ts * 1000 : ts); // 服务器存秒，本机旧数据存毫秒
    return (d.getMonth() + 1) + "-" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function allMessages() {
    return normalizeLocal(BOARD_KEY, "m").map((m) => Object.assign({}, m, { local: true }))
      .concat(serverMessages.map((m) => Object.assign({}, m, { server: true })))
      .sort((a, b) => normTs(b.ts) - normTs(a.ts));
  }

  function renderBoard() {
    if (!boardList) return;
    const list = allMessages();
    if (!list.length) {
      boardList.innerHTML = '<div class="board-empty">还没有留言，来说第一句吧 💕</div>';
      return;
    }
    boardList.innerHTML = "";
    list.forEach((m) => {
      const canDel = !!m.local || !!m.mine;     // 归属由服务器判定
      const item = document.createElement("div");
      item.className = "msg-item";
      item.innerHTML =
        '<div class="msg-main"><b>' + escapeHtml(m.name) + "</b> " +
        '<span class="msg-text">' + escapeHtml(m.text) + "</span></div>" +
        '<div class="msg-side"><span class="msg-time">' + fmtTime(m.ts) + "</span>" +
        (canDel ? '<button class="msg-del" data-uid="' + escapeHtml(m.uid) + '" data-kind="' + (m.server ? "server" : "local") + '">✕</button>' : "") +
        "</div>";
      boardList.appendChild(item);
    });
  }

  if (boardList) {
    const nameEl = document.getElementById("msgName");
    const textEl = document.getElementById("msgText");

    function saveLocalMessage(rec) {
      const list = normalizeLocal(BOARD_KEY, "m");
      list.push(rec);
      writeLS(BOARD_KEY, list);
      renderBoard();
      toast("已存到本机（服务器暂不可用）");
    }

    document.getElementById("msgSend").addEventListener("click", () => {
      const name = nameEl.value.trim();
      const text = textEl.value.trim();
      if (!text) { toast("写点什么再发送吧"); return; }
      const rec = { name: name || "匿名", text: text, ts: Date.now(), uid: (window.newUid ? window.newUid("m") : "m" + Date.now() + Math.floor(Math.random() * 1000)) };
      if (S) {
        S.post({ action: "message_add", name: rec.name, text: text, uid: rec.uid })
          .then((j) => {
            serverMessages.push(j.record);
            nameEl.value = ""; textEl.value = "";
            renderBoard();
            toast("已悄悄写下，存到服务器 💕");
          })
          .catch((err) => {
            // 同上：限流/未解锁如实提示，不静默落本机
            if (err && err.server) {
              toast(err.locked ? "还没解锁，请先回首页解锁 🔒" : (err.message || "服务器拒绝了这次留言"));
              return;
            }
            saveLocalMessage(rec);
          });
      } else {
        saveLocalMessage(rec);
      }
    });
    textEl.addEventListener("keydown", (e) => {
      // 中文输入法选词时的回车是"确认候选词"，不能当成发送
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") document.getElementById("msgSend").click();
    });

    // 删除留言（委托，只绑一次）
    boardList.addEventListener("click", (e) => {
      const del = e.target.closest(".msg-del");
      if (!del) return;
      const uid = del.dataset.uid;
      const kind = del.dataset.kind;
      const target = allMessages().find((x) => x.uid === uid);
      if (!target) return;
      if (!window.confirm("删除这条留言吗？")) return;

      if (kind === "local") {
        const list = normalizeLocal(BOARD_KEY, "m");
        const i = list.findIndex((x) => x.uid === uid);
        if (i !== -1) { list.splice(i, 1); writeLS(BOARD_KEY, list); }
        renderBoard();
      } else if (kind === "server" && S) {
        S.post({ action: "delete", kind: "messages", uid: uid })
          .then(() => {
            serverMessages = serverMessages.filter((x) => x.uid !== uid);
            renderBoard();
          })
          .catch((err) => toast("删除失败：" + err.message));
      }
    });

    renderBoard();
  }

  /* ---------- 服务器同步：迁移本机旧数据 → 拉取服务器数据 ---------- */
  (function syncServer() {
    if (!S) return;
    const letters = normalizeLocal(EXTRA_KEY, "l");
    const msgs = normalizeLocal(BOARD_KEY, "m");

    let chain = Promise.resolve();
    const migratedLetters = [];
    const migratedMessages = [];
    const migrate = (payload, key, prefix, sink) => {
      chain = chain.then(() =>
        S.post(payload)
          .then((j) => {
            if (j && j.record) sink.push(j.record);   // 记住刚迁移的记录，稍后合并
            const list = normalizeLocal(key, prefix);
            const i = list.findIndex((x) => x.uid === payload.uid);
            if (i !== -1) { list.splice(i, 1); writeLS(key, list); }
          })
          .catch(() => {})
      );
    };
    letters.forEach((lt) => migrate(
      { action: "letter_add", date: lt.date, title: lt.title, body: lt.body, sign: lt.sign, uid: lt.uid },
      EXTRA_KEY, "l", migratedLetters
    ));
    msgs.forEach((m) => migrate(
      { action: "message_add", name: m.name, text: m.text, uid: m.uid },
      BOARD_KEY, "m", migratedMessages
    ));

    // __SERVER_CONTENT__ 是"页面加载那一刻"的快照，不含刚迁移的记录，
    // 所以必须把迁移返回的记录按 uid 合并回来，否则刚迁移的内容会当场消失
    const mergeByUid = (server, extra) => {
      const seen = new Set((server || []).map((x) => x && x.uid));
      return (server || []).concat((extra || []).filter((x) => x && x.uid && !seen.has(x.uid)));
    };

    chain
      .then(() => S.fetchAll())
      .then((data) => {
        /* 迁移期间用户可能又新发了一条（它只存在于内存的 serverX 里，既不在
           页面加载快照 data 里、也不在 migrated 里）—— 三个来源都要并进来，
           少并一个就会让刚发出去的内容当场从页面上消失（服务器上其实还在）。 */
        serverLetters = mergeByUid(mergeByUid(data.letters, migratedLetters), serverLetters);
        serverMessages = mergeByUid(mergeByUid(data.messages, migratedMessages), serverMessages);
        renderLetters();
        renderBoard();
      })
      .catch(() => { /* 服务器不可用：保持本机数据 */ });
  })();

  // 触发滚动浮现（动态生成的内容统一在这里处理）
  if (window.revealNow) window.revealNow();
})();
