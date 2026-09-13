/* ============================================================
   情侣网站 · 时间胶囊（写给未来的信）
   ------------------------------------------------------------
   与情书不同：正文在"开启日"之前**只存在服务器上**，
   content_view 会把它剥掉（连标题都只给自己看），刷新、看源码、
   直接抓接口都拿不到 —— 必须等到那一天。
   参考 sailor0913/epoch-letter、QAbot-zh/timecapsule 的"到期解锁"，
   但它们都是纯前端（改系统时间就能提前看），这里是服务端说了算。

   服务器不可用时降级为本机存储（此时到期判断只能靠本机时间，
   仅作兜底，README 有说明）。
   ============================================================ */

(function () {
  "use strict";

  var grid = document.getElementById("capsuleGrid");
  if (!grid) return;

  var S = window.loveServer;
  var KEY = "love-capsules";
  var serverList = null;   // null = 还没拉到

  function readLS() {
    try { var v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function writeLS(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(msg) { if (window.toast) window.toast(msg); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function todayStr() {
    var n = new Date();
    return n.getFullYear() + "-" + pad2(n.getMonth() + 1) + "-" + pad2(n.getDate());
  }
  function daysBetween(a, b) {
    return Math.ceil((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);
  }
  function fmtDate(s) { return String(s || "").replace(/-/g, " / "); }

  /* 与服务端口径保持一致（lib/content.php：$openAt === '' 同样算未开启）：
     日期缺失时视为"还没到开启日"，绝不能把本该锁住的正文渲染出来。 */
  function localLocked(rec) {
    var d = String(rec.openAt || "");
    return !d || d > todayStr();
  }

  /** 服务器数据 + 仅存在于本机的数据（按 uid 去重） */
  function allCapsules() {
    var out = [];
    var seen = {};
    (serverList || []).forEach(function (r) {
      if (!r || !r.uid || seen[r.uid]) return;
      seen[r.uid] = 1;
      out.push({
        uid: r.uid, title: r.title || "", body: r.body || "", sign: r.sign || "",
        openAt: r.openAt || "", ts: r.ts || 0,
        locked: r.locked === true, daysLeft: r.daysLeft || 0, mine: r.mine === true,
      });
    });
    readLS().forEach(function (r) {
      if (!r || !r.uid || seen[r.uid]) return;
      seen[r.uid] = 1;
      out.push({
        uid: r.uid, title: r.title || "", body: r.body || "", sign: r.sign || "",
        openAt: r.openAt || "", ts: r.ts || 0,
        locked: localLocked(r), daysLeft: localLocked(r) ? daysBetween(r.openAt, todayStr()) : 0,
        mine: true, local: true,
      });
    });
    out.sort(function (a, b) { return String(a.openAt).localeCompare(String(b.openAt)); });
    return out;
  }

  function render() {
    var list = allCapsules();
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML = '<div class="capsule-empty muted">还没有时间胶囊。写一封给一年后的 TA 吧 ⏳</div>';
      if (window.revealNow) window.revealNow();
      return;
    }
    list.forEach(function (c, i) {
      var card = document.createElement("div");
      card.className = "capsule glass reveal" + (c.locked ? " locked" : " opened");
      card.style.transitionDelay = (i % 4) * 70 + "ms";

      var html = "";
      if (c.locked) {
        html += '<div class="capsule-badge">🔒 一封写给未来的信</div>';
        if (c.title) html += "<h3>" + escapeHtml(c.title) + "</h3>";
        html += '<div class="capsule-date">将于 ' + escapeHtml(fmtDate(c.openAt)) + " 开启";
        if (c.daysLeft > 0) html += " · 还有 <b>" + c.daysLeft + "</b> 天";
        html += "</div>";
        html += '<div class="capsule-hint">到那天才会打开，现在连自己也看不到内容 🤫</div>';
      } else {
        html += '<div class="capsule-badge">📖 已开启</div>';
        html += "<h3>" + escapeHtml(c.title || "写给未来的信") + "</h3>";
        html += '<div class="capsule-date">' + escapeHtml(fmtDate(c.openAt)) + "</div>";
        html += '<div class="capsule-body">' + escapeHtml(c.body).replace(/\n/g, "<br>") + "</div>";
        if (c.sign) html += '<div class="capsule-sign">—— ' + escapeHtml(c.sign) + "</div>";
      }
      if (c.mine) html += '<button class="btn btn-ghost capsule-del" type="button" data-del="' + escapeHtml(c.uid) + '">删除</button>';
      card.innerHTML = html;
      grid.appendChild(card);
    });
    if (window.revealNow) window.revealNow();
  }

  /* ---------- 删除 ---------- */
  grid.addEventListener("click", function (e) {
    var btn = e.target;
    while (btn && btn !== grid) {
      if (btn.getAttribute && btn.getAttribute("data-del")) {
        var uid = btn.getAttribute("data-del");
        if (!confirm("删除这个时间胶囊？")) return;
        var local = readLS();
        writeLS(local.filter(function (r) { return r.uid !== uid; }));
        if (S) {
          S.post({ action: "delete", kind: "capsules", uid: uid }).then(function () {
            toast("已删除");
            loadServer(true);      // 实时刷新：用快照会把刚删掉的那条带回来
          }).catch(function (err) {
            if (err && err.server) toast(err.message);
            else toast("已从本机删除，服务器暂不可用");
            render();
          });
        } else render();
        return;
      }
      btn = btn.parentNode;
    }
  });

  /* ---------- 写新的胶囊 ---------- */
  var modal = document.getElementById("capsuleModal");
  var openBtn = document.getElementById("newCapsuleBtn");
  var saveBtn = document.getElementById("cpSave");
  var cancelBtn = document.getElementById("cpCancel");
  var dateInput = document.getElementById("cpDate");

  function openModal() {
    if (!modal) return;
    if (dateInput && !dateInput.min) dateInput.min = todayStr();
    if (dateInput && !dateInput.value) {
      var d = new Date();
      d.setFullYear(d.getFullYear() + 1);
      dateInput.value = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    modal.classList.add("open");
  }
  function closeModal() { if (modal) modal.classList.remove("open"); }

  if (openBtn) openBtn.addEventListener("click", openModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  if (saveBtn) saveBtn.addEventListener("click", function () {
    var title = (document.getElementById("cpTitle").value || "").trim();
    var body = (document.getElementById("cpBody").value || "").trim();
    var sign = (document.getElementById("cpSign").value || "").trim();
    var openAt = (dateInput && dateInput.value) || "";
    if (!title || !body) { toast("标题和内容都要写哦"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(openAt)) { toast("选一个开启日期吧"); return; }
    if (openAt < todayStr()) { toast("开启日期不能早于今天"); return; }

    var rec = {
      title: title, body: body, sign: sign, openAt: openAt,
      uid: window.newUid ? window.newUid("c") : ("c" + Date.now()),
      ts: Math.floor(Date.now() / 1000),
    };
    saveBtn.disabled = true;

    function done(okMsg) {
      saveBtn.disabled = false;
      closeModal();
      document.getElementById("cpTitle").value = "";
      document.getElementById("cpBody").value = "";
      document.getElementById("cpSign").value = "";
      toast(okMsg);
      render();
    }

    if (S) {
      S.post({ action: "capsule_add", title: title, body: body, sign: sign, openAt: openAt, uid: rec.uid })
        .then(function () { done("已经封存好了，到那天才能打开 🔒"); loadServer(true); })
        .catch(function (err) {
          if (err && err.server) { saveBtn.disabled = false; toast(err.message); return; }
          var list = readLS(); list.push(rec); writeLS(list);
          done("服务器暂不可用，已存到本机（下次打开自动补传）");
        });
    } else {
      var list = readLS(); list.push(rec); writeLS(list);
      done("已存到本机（部署到 PHP 主机后可跨设备同步）");
    }
  });

  /* ---------- 从服务器拉取 + 本机数据迁移 ---------- */

  /* 实时拉取：不复用 window.__SERVER_CONTENT__ 那份"页面加载时"的快照。
     新增/删除胶囊后必须拿到最新列表 —— 否则刚封存的看不到、刚删掉的
     又会被旧快照带回列表里（看起来像删除失败）。 */
  function fetchFresh() {
    return fetch("api/content.php?action=all", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || "服务器错误");
        return j.data;
      });
  }

  /** @param {boolean} [fresh] true = 走实时接口（新增/删除后必须用它） */
  function loadServer(fresh) {
    if (!S) { render(); return; }
    (fresh ? fetchFresh() : S.fetchAll()).then(function (data) {
      serverList = (data && data.capsules) || [];
      var local = readLS();
      if (!local.length) { render(); return; }
      // 把本机旧胶囊逐条补传到服务器（uid 去重）
      var jobs = local.map(function (r) {
        return S.post({ action: "capsule_add", title: r.title, body: r.body, sign: r.sign, openAt: r.openAt, uid: r.uid })
          .then(function (j) { return j.record || null; })
          .catch(function () { return null; });
      });
      Promise.all(jobs).then(function (recs) {
        var ok = recs.filter(Boolean);
        if (ok.length) {
          writeLS(local.filter(function (r) {
            return !ok.some(function (x) { return x.uid === r.uid; });
          }));
          // 迁移完成后同样要用实时数据，否则刚补传的胶囊不会出现
          fetchFresh().then(function (d2) {
            serverList = (d2 && d2.capsules) || serverList;
            render();
          }).catch(function () { render(); });
        } else render();
      });
    }).catch(function () {
      /* 拉取失败不要清空：loadServer(true) 在每次新增/删除成功后都会重跑一次，
         一次网络抖动就会让页面上所有服务器胶囊凭空消失（数据其实还好好在服务器
         上）。保持上一次的结果渲染即可；只有从没成功拉到过时才退化为空列表。 */
      if (serverList === null) serverList = [];
      render();
    });
  }

  loadServer();
})();
