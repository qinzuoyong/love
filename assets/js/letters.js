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
    /* 返回是否真的写成功。必须回传：本机存储会抛 SecurityError（浏览器禁用站点存储）
       或 QuotaExceededError（配额满，相册的 base64 照片很容易撑爆），
       旧写法把异常吞掉之后照样提示"已存到本机"，用户写的信/留言就此消失且没有痕迹。
       走的是和 gallery.js 同一套口径。 */
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }
  // 防 HTML 注入: 所有用户输入内容一律转义后插入
  function escapeHtml(str) {
    // null/undefined 兜底：老数据缺字段时不该渲染成字面量 "undefined"
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  /* 本机条目的 uid 必须**确定性生成**：本机存储可能读得到、写不进（配额满 —— 相册的
     base64 照片很容易撑爆；或被浏览器禁用）。旧实现用 `prefix + Date.now() + "_" + i`，
     写失败时这个 uid 只活在内存里，下一次 normalizeLocal() 又换一个新的 → 迁移时
     服务端按 uid 去重彻底失效，同一封信/留言会累积成多份；页面上"本机一份 + 服务端
     若干份"也会同时显示（第七轮 S6-02）。
     改成按内容哈希：同一条本机记录在任何时候算出的 uid 都一样，写失败也不再产生
     新身份，服务端第一次收下之后就会认它是同一条。 */
  function stableLocalUid(prefix, it, i) {
    const seed = [it.date, it.title, it.body, it.sign, it.name, it.text, it.ts]
      .map((v) => (v === null || v === undefined ? "" : String(v))).join("\u0001");
    let h = 5381;
    for (let k = 0; k < seed.length; k++) h = ((h * 33) ^ seed.charCodeAt(k)) >>> 0;
    return prefix + "h" + h.toString(36) + "_" + i;
  }
  // 本机旧数据补 uid（服务器去重靠 uid，重复打开不会传两遍）
  function normalizeLocal(key, prefix) {
    const list = readLS(key, []);
    let changed = false;
    list.forEach((it, i) => {
      // 本机存储被写成字符串数组（或被手工改坏）时，给原始值赋属性在严格模式下
      // 会直接抛 TypeError，整段脚本随之中断 —— 先挡掉非对象条目。
      if (!it || typeof it !== "object") return;
      if (!it.uid) { it.uid = stableLocalUid(prefix, it, i); changed = true; }
    });
    if (changed) writeLS(key, list);   // 写失败也安全：uid 是确定性的，见上
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
    const local = normalizeLocal(EXTRA_KEY, "l");
    /* 按 uid 去重：迁移时"服务器已收到、但本机副本没删掉"（writeLS 失败）会让同一条
       在页面上出现两次 —— 本机一份 + 服务端一份，uid 相同。许愿瓶那边一直有这道
       去重（capsules.js 的 seen 表），情书/留言漏了（第四轮 F-S6-01）。 */
    const seen = {};
    local.forEach((lt) => { if (lt && lt.uid) seen[lt.uid] = true; });
    return local.map((lt) => Object.assign({}, lt, { local: true }))
      .concat(serverLetters.filter((lt) => !(lt && lt.uid && seen[lt.uid]))
        .map((lt) => Object.assign({}, lt, { server: true })))
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
        if (i !== -1) {
          list.splice(i, 1);
          /* 写不进去就别报"已删除"：renderLetters() 会重新从 localStorage 读回原列表，
             旧写法于是"toast 说删了、信封同一帧又回来了"，用户反复点也删不掉
             （第四轮 F-S6-01）。口径与上面 saveLocalLetter() 一致。 */
          if (!writeLS(EXTRA_KEY, list)) {
            renderLetters();
            toast("本机存储写不进去（空间满或被浏览器禁用），这封信没能删除");
            return;
          }
        }
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
      if (!writeLS(EXTRA_KEY, list)) {
        // 写不进去就别关弹窗、别报成功：让用户能把内容复制走
        toast("本机存储空间不足或被浏览器禁用，这封情书没能保存 —— 先复制一下内容");
        return;
      }
      closeModal();
      renderLetters();
      toast("已存到本机（服务器暂不可用）");
    }

    /* 提交中标志：手机慢网下一次 POST 要好几秒，而输入框是**拿到响应后**才清空的。
       没有这个标志时，连点两下「保存」会发两条 uid 不同的请求 —— 服务端的去重
       只认 uid，于是两封一模一样的情书都被存下。*/
    let saving = false;
    const lmSaveBtn = document.getElementById("lmSave");

    function endSave() {
      saving = false;
      lmSaveBtn.disabled = false;
    }

    lmSaveBtn.addEventListener("click", () => {
      if (saving) return;
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
        saving = true;
        lmSaveBtn.disabled = true;
        S.post({ action: "letter_add", date: rec.date, title: title, body: body, sign: sign, uid: rec.uid })
          .then((j) => {
            endSave();
            serverLetters.push(j.record);
            closeModal();
            renderLetters();
            toast("情书写好啦，已存到服务器 💌");
          })
          .catch((err) => {
            /* 服务端明确拒绝（429 限流 / 未解锁 / 参数错）不等于"服务器不可用"：
               如实提示，别静默转存本地 —— 否则用户以为存上了，而那条记录会在
               每次打开页面时被反复重传。口径与 capsules.js 一致。 */
            endSave();
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
    const local = normalizeLocal(BOARD_KEY, "m");
    // 同 allLetters()：按 uid 去重，避免"迁移后本机副本没删掉"让同一条留言出现两次
    const seen = {};
    local.forEach((m) => { if (m && m.uid) seen[m.uid] = true; });
    return local.map((m) => Object.assign({}, m, { local: true }))
      .concat(serverMessages.filter((m) => !(m && m.uid && seen[m.uid]))
        .map((m) => Object.assign({}, m, { server: true })))
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

    /* 发送成功后清输入框：**只清"里面还是我刚发出去的那份"的框**。
       慢网下一次请求要好几秒，用户常在等待时接着写第二条（文件的超时预算自己就按
       "最多 45 秒"假设了慢链路）—— 无条件置空会把那条还没保存的字一起抹掉，
       没有提示、没有撤销。反过来本机分支原来**不清**，连点两次就把同一句话存成
       两条（uid 不同，服务端去重无效）。两个方向统一到这一条口径上。 */
    function clearSentFields(sentText, sentName) {
      if (textEl.value.trim() === sentText) textEl.value = "";
      if (nameEl.value.trim() === sentName) nameEl.value = "";
    }

    function saveLocalMessage(rec) {
      const list = normalizeLocal(BOARD_KEY, "m");
      list.push(rec);
      if (!writeLS(BOARD_KEY, list)) {
        // 同上：输入框里的字留着，别让用户以为发出去了
        toast("本机存储空间不足或被浏览器禁用，这条悄悄话没能保存 —— 先复制一下内容");
        return;
      }
      clearSentFields(rec.text, rec.name);   // 存下来了才清（与服务器分支同口径）
      renderBoard();
      toast("已存到本机（服务器暂不可用）");
    }

    /* 同上：慢网下连点「发送」/连按回车会发出两条 uid 不同的留言（服务端只按 uid 去重），
       所以在途期间直接不再受理，输入框也要等响应回来才清空。 */
    let sending = false;
    const msgSendBtn = document.getElementById("msgSend");

    msgSendBtn.addEventListener("click", () => {
      if (sending) return;
      const name = nameEl.value.trim();
      const text = textEl.value.trim();
      if (!text) { toast("写点什么再发送吧"); return; }
      const rec = { name: name || "匿名", text: text, ts: Date.now(), uid: (window.newUid ? window.newUid("m") : "m" + Date.now() + Math.floor(Math.random() * 1000)) };
      if (S) {
        sending = true;
        msgSendBtn.disabled = true;
        S.post({ action: "message_add", name: rec.name, text: text, uid: rec.uid })
          .then((j) => {
            sending = false; msgSendBtn.disabled = false;
            serverMessages.push(j.record);
            clearSentFields(text, name);   // 只清"还是这份"的框：在途期间新写的第二条要留住
            renderBoard();
            toast("已悄悄写下，存到服务器 💕");
          })
          .catch((err) => {
            sending = false; msgSendBtn.disabled = false;
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
        if (i !== -1) {
          list.splice(i, 1);
          // 同情书那条：写不进去就如实说，别让 renderBoard() 把留言"读回来"却装作删掉了
          if (!writeLS(BOARD_KEY, list)) {
            renderBoard();
            toast("本机存储写不进去（空间满或被浏览器禁用），这条留言没能删除");
            return;
          }
        }
        renderBoard();
        /* 与情书本机删除（renderLetters 那条 toast("已删除")）同口径：删除成功要有
           确认，否则用户分不清"删掉了"和"点了没反应"（第七轮 S6-06）。 */
        toast("已删除");
      } else if (kind === "server" && S) {
        S.post({ action: "delete", kind: "messages", uid: uid })
          .then(() => {
            serverMessages = serverMessages.filter((x) => x.uid !== uid);
            renderBoard();
            toast("已删除");
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
    let migrateStuck = 0;      // 服务器收到了、但本机副本没删掉的条数
    const migrate = (payload, key, prefix, sink) => {
      chain = chain.then(() =>
        S.post(payload)
          .then((j) => {
            if (j && j.record) sink.push(j.record);   // 记住刚迁移的记录，稍后合并
            const list = normalizeLocal(key, prefix);
            const i = list.findIndex((x) => x.uid === payload.uid);
            if (i !== -1) {
              list.splice(i, 1);
              /* 移除失败不是致命的（内容已经在服务器上了，两个列表也有 uid 去重、
                 不会重复渲染），但必须记账：否则用户以为本机清干净了，
                 实际上每次进页面都会看到"本机那一份"还在（第四轮 F-S6-01）。 */
              if (!writeLS(key, list)) migrateStuck++;
            }
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
        /* 迁移"上传成功、但本机副本没删掉"时如实说一声：内容没丢（服务器上有，
           列表也按 uid 去重了），但本机那份还在，下次进来还会看到它被当作本机记录。 */
        if (migrateStuck > 0) {
          toast("有 " + migrateStuck + " 条本机记录没能从本机清掉（存储写不进去），已按服务器数据去重显示");
        }
      })
      .catch(() => { /* 服务器不可用：保持本机数据 */ });
  })();

  // 触发滚动浮现（动态生成的内容统一在这里处理）
  if (window.revealNow) window.revealNow();
})();
