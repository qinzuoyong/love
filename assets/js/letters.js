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
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  // 防 HTML 注入: 所有用户输入内容一律转义后插入
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  // 本机旧数据补 uid（服务器去重靠 uid，重复打开不会传两遍）
  function normalizeLocal(key, prefix) {
    const list = readLS(key, []);
    let changed = false;
    list.forEach((it, i) => {
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
        ? '<button class="env-del" data-uid="' + lt.uid + '" data-kind="' + (lt.server ? "server" : "local") + '">🗑 删除这封信</button>'
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
      const canDel = lt.local || (lt.server && lt.deviceId === S.deviceId);
      const env = document.createElement("div");
      env.className = "envelope reveal handwritten";
      env.innerHTML = letterHTML(lt, true, canDel);
      env.addEventListener("click", () => env.classList.toggle("open"));
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
        S.post({ action: "delete", kind: "letters", uid: uid, deviceId: S.deviceId })
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
        uid: "l" + Date.now() + Math.floor(Math.random() * 1000),
      };
      if (S) {
        S.post({ action: "letter_add", date: rec.date, title: title, body: body, sign: sign, uid: rec.uid, deviceId: S.deviceId })
          .then((j) => {
            serverLetters.push(j.record);
            closeModal();
            renderLetters();
            toast("情书写好啦，已存到服务器 💌");
          })
          .catch(() => saveLocalLetter(rec));
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
        '<div class="w-title">' + w.title + "</div>" +
        '<div class="w-text">' + w.text + "</div>";
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
  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts < 1e12 ? ts * 1000 : ts); // 服务器存秒，本机旧数据存毫秒
    return (d.getMonth() + 1) + "-" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function allMessages() {
    return normalizeLocal(BOARD_KEY, "m").map((m) => Object.assign({}, m, { local: true }))
      .concat(serverMessages.map((m) => Object.assign({}, m, { server: true })))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
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
      const canDel = m.local || (m.server && m.deviceId === S.deviceId);
      const item = document.createElement("div");
      item.className = "msg-item";
      item.innerHTML =
        '<div class="msg-main"><b>' + escapeHtml(m.name) + "</b> " +
        '<span class="msg-text">' + escapeHtml(m.text) + "</span></div>" +
        '<div class="msg-side"><span class="msg-time">' + fmtTime(m.ts) + "</span>" +
        (canDel ? '<button class="msg-del" data-uid="' + m.uid + '" data-kind="' + (m.server ? "server" : "local") + '">✕</button>' : "") +
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
      const rec = { name: name || "匿名", text: text, ts: Date.now(), uid: "m" + Date.now() + Math.floor(Math.random() * 1000) };
      if (S) {
        S.post({ action: "message_add", name: rec.name, text: text, uid: rec.uid, deviceId: S.deviceId })
          .then((j) => {
            serverMessages.push(j.record);
            nameEl.value = ""; textEl.value = "";
            renderBoard();
            toast("已悄悄写下，存到服务器 💌");
          })
          .catch(() => saveLocalMessage(rec));
      } else {
        saveLocalMessage(rec);
      }
    });
    textEl.addEventListener("keydown", (e) => {
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
        S.post({ action: "delete", kind: "messages", uid: uid, deviceId: S.deviceId })
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
    const migrate = (payload, key, prefix) => {
      chain = chain.then(() =>
        S.post(payload)
          .then(() => {
            const list = normalizeLocal(key, prefix);
            const i = list.findIndex((x) => x.uid === payload.uid);
            if (i !== -1) { list.splice(i, 1); writeLS(key, list); }
          })
          .catch(() => {})
      );
    };
    letters.forEach((lt) => migrate(
      { action: "letter_add", date: lt.date, title: lt.title, body: lt.body, sign: lt.sign, uid: lt.uid, deviceId: S.deviceId },
      EXTRA_KEY, "l"
    ));
    msgs.forEach((m) => migrate(
      { action: "message_add", name: m.name, text: m.text, uid: m.uid, deviceId: S.deviceId },
      BOARD_KEY, "m"
    ));

    chain
      .then(() => S.fetchAll())
      .then((data) => {
        serverLetters = data.letters || [];
        serverMessages = data.messages || [];
        renderLetters();
        renderBoard();
      })
      .catch(() => { /* 服务器不可用：保持本机数据 */ });
  })();

  // 触发滚动浮现（动态生成的内容统一在这里处理）
  if (window.revealNow) window.revealNow();
})();
