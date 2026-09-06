/* ============================================================
   情侣网站 · 情书 & 许愿瓶 & 留言板
   信封点击翻开 / 心愿点击展开 /
   写新情书(localStorage 持久化) / 悄悄话留言板
   ============================================================ */

(function () {
  "use strict";

  const EXTRA_KEY = "love-letters-extra";   // 手写情书
  const BOARD_KEY = "love-messages";        // 留言板

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

  /* ---------- 情书列表（配置 + 手写） ---------- */
  const letterGrid = document.getElementById("letterGrid");

  function letterHTML(lt, handwritten, idx) {
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
      (handwritten
        ? '<button class="env-del" data-i="' + idx + '">🗑 删除这封信</button>'
        : "") +
      "  </div>" +
      "</div>"
    );
  }

  function renderLetters() {
    if (!letterGrid) return;
    const extra = readLS(EXTRA_KEY, []);
    // 手写情书: 按日期倒序（最新的排最前）
    const extras = extra.slice().sort((a, b) => new Date(b.date) - new Date(a.date));

    letterGrid.innerHTML = "";
    extras.forEach((lt, i) => {
      const env = document.createElement("div");
      env.className = "envelope reveal handwritten";
      env.innerHTML = letterHTML(lt, true, i);
      env.addEventListener("click", () => env.classList.toggle("open"));
      letterGrid.appendChild(env);
    });
    (CONFIG.letters || []).forEach((lt) => {
      const env = document.createElement("div");
      env.className = "envelope reveal";
      env.innerHTML = letterHTML(lt, false, -1);
      env.addEventListener("click", () => env.classList.toggle("open"));
      letterGrid.appendChild(env);
    });

    // 删除手写情书（事件委托, 避免误触发信封翻开）
    letterGrid.addEventListener("click", (e) => {
      const del = e.target.closest(".env-del");
      if (!del) return;
      e.stopPropagation();
      const idx = parseInt(del.dataset.i, 10);
      const list = readLS(EXTRA_KEY, []);
      if (idx >= 0 && idx < list.length) {
        if (window.confirm("确定删除这封手写的情书吗？")) {
          list.splice(idx, 1);
          writeLS(EXTRA_KEY, list);
          renderLetters();
          if (window.toast) window.toast("已删除");
        }
      }
    });

    if (window.revealNow) window.revealNow();
  }
  if (letterGrid) renderLetters();

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

    document.getElementById("lmSave").addEventListener("click", () => {
      const title = t.value.trim();
      const body = b.value.trim();
      const sign = s.value.trim() || CONFIG.names.boy;
      if (!title || !body) {
        if (window.toast) window.toast("标题和内容都要写哦");
        return;
      }
      const list = readLS(EXTRA_KEY, []);
      const now = new Date();
      list.push({
        date: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0"),
        title: title,
        body: body,
        sign: sign,
      });
      writeLS(EXTRA_KEY, list);
      closeModal();
      renderLetters();
      if (window.toast) window.toast("情书写好啦 💌");
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
  if (boardList) {
    const nameEl = document.getElementById("msgName");
    const textEl = document.getElementById("msgText");

    function pad(n) { return String(n).padStart(2, "0"); }
    function fmtTime(ts) {
      const d = new Date(ts);
      return (d.getMonth() + 1) + "-" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function renderBoard() {
      const list = readLS(BOARD_KEY, []);
      if (!list.length) {
        boardList.innerHTML = '<div class="board-empty">还没有留言，来说第一句吧 💕</div>';
        return;
      }
      boardList.innerHTML = "";
      list.slice().reverse().forEach((m, i) => {
        const item = document.createElement("div");
        item.className = "msg-item";
        item.innerHTML =
          '<div class="msg-main"><b>' + escapeHtml(m.name) + "</b> " +
          '<span class="msg-text">' + escapeHtml(m.text) + "</span></div>" +
          '<div class="msg-side"><span class="msg-time">' + fmtTime(m.ts) + '</span>' +
          '<button class="msg-del" data-i="' + (list.length - 1 - i) + '">✕</button></div>';
        boardList.appendChild(item);
      });
    }

    document.getElementById("msgSend").addEventListener("click", () => {
      const name = nameEl.value.trim();
      const text = textEl.value.trim();
      if (!text) { if (window.toast) window.toast("写点什么再发送吧"); return; }
      const list = readLS(BOARD_KEY, []);
      list.push({ name: name || "匿名", text: text, ts: Date.now() });
      writeLS(BOARD_KEY, list);
      nameEl.value = ""; textEl.value = "";
      renderBoard();
      if (window.toast) window.toast("已悄悄写下 💕");
    });
    textEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("msgSend").click();
    });

    // 删除留言（委托）
    boardList.addEventListener("click", (e) => {
      const del = e.target.closest(".msg-del");
      if (!del) return;
      const idx = parseInt(del.dataset.i, 10);
      const list = readLS(BOARD_KEY, []);
      if (idx >= 0 && idx < list.length) {
        if (window.confirm("删除这条留言吗？")) {
          list.splice(idx, 1);
          writeLS(BOARD_KEY, list);
          renderBoard();
        }
      }
    });

    renderBoard();
  }

  // 触发滚动浮现（动态生成的内容统一在这里处理）
  if (window.revealNow) window.revealNow();
})();
