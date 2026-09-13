/* ============================================================
   情侣网站 · 相册页
   瀑布流照片墙 / 分类筛选 / 灯箱放大(键盘←→、Esc)
   照片列表 = 配置照片(CONFIG.gallery) + 服务器照片(跨设备共享)
   + 本机旧照片(服务器不可用时兜底, 成功后自动迁移到服务器)
   ============================================================ */

(function () {
  "use strict";

  const grid = document.getElementById("galleryGrid");
  const filterBar = document.getElementById("filterBar");
  if (!grid) return;

  const PHOTOS_KEY = "love-photos"; // 网页里添加的照片（本机兜底/旧数据迁移源）
  const S = window.loveServer;

  function readLSP(key, fallback) {
    /* 解析结果必须是数组：被手工改坏成 "{}" 之类时，下面的 .map 会当场抛
       "is not a function"，整段脚本（含灯箱与上传）都起不来。 */
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) ? v : fallback;
    } catch (e) { return fallback; }
  }
  function writeLSP(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  // 防 HTML 注入：照片说明 cap 可经公开接口提交任意文本，拼 innerHTML 前必须转义
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 照片地址：PHP 主机上走 photo.php 代理（需要解锁 Cookie），静态托管保持原路径
  function photoUrl(src) {
    return window.lovePhotoUrl ? window.lovePhotoUrl(src) : src;
  }
  // 多来源照片（配置 gallery / 服务器 content.json / 本机）按 src 去重：
  // 旧版后台上传会把同一张同时写进两处，相册页会显示两次
  function dedupeBySrc(list) {
    const seen = new Set();
    return list.filter((p) => {
      if (!p.src || seen.has(p.src)) return false;
      seen.add(p.src);
      return true;
    });
  }

  /* 本机旧照片补 uid 并写回：删除按钮按 uid 定位（dataset 读出来永远是字符串），
     旧数据没有 uid 时 find 永远匹配不上 —— ✕ 点了没反应（只改了内存、刷新又回来）。
     顺手挡掉被改坏的非对象条目。 */
  function normalizeLocalPhotos() {
    const list = readLSP(PHOTOS_KEY, []);
    let changed = false;
    list.forEach((p, i) => {
      if (!p || typeof p !== "object") return;
      if (!p.uid) { p.uid = "p" + Date.now().toString(36) + "_" + i; changed = true; }
    });
    if (changed) writeLSP(PHOTOS_KEY, list);
    return list;
  }

  function localPhotos() {
    return normalizeLocalPhotos()
      .filter((p) => p && typeof p === "object" && p.src)
      .map((p) => ({
        src: p.src, cat: "照片", cap: p.cap || "我们的新照片", local: true, uid: p.uid,
      }));
  }

  /* 照片列表 = 配置照片 + 本机旧照片（服务器照片稍后异步并入） */
  let photos = dedupeBySrc((CONFIG.gallery || []).concat(localPhotos()));
  let currentCat = "全部";
  let currentList = [];
  let currentIndex = 0;

  /* ---------- 分类筛选 ---------- */
  function rebuildCats() {
    const cats = ["全部"].concat([...new Set(photos.map((p) => p.cat))]);
    filterBar.innerHTML = "";
    cats.forEach((cat) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (cat === currentCat ? " active" : "");
      chip.textContent = cat;
      chip.addEventListener("click", () => {
        currentCat = cat;
        filterBar.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        render();
      });
      filterBar.appendChild(chip);
    });
  }

  /* ---------- 瀑布流渲染 ---------- */
  function render() {
    currentList = photos.filter((p) => currentCat === "全部" || p.cat === currentCat);
    grid.innerHTML = "";
    currentList.forEach((p, i) => {
      const item = document.createElement("figure");
      item.className = "photo reveal";
      item.style.transitionDelay = (i % 6) * 60 + "ms";
      const showDel = p.local || (p.server && p.mine);
      item.innerHTML =
        '<img src="' + escapeHtml(photoUrl(p.src)) + '" alt="' + escapeHtml(p.cap) + '" loading="lazy">' +
        (showDel ? '<button class="photo-del" data-uid="' + escapeHtml(p.uid) + '" aria-label="删除照片">✕</button>' : "") +
        '<figcaption class="cap">' + escapeHtml(p.cap) + "</figcaption>";
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("photo-del")) return; // 删除按钮不打开灯箱
        openLightbox(i);
      });
      grid.appendChild(item);
    });

    // 触发滚动浮现
    if (window.revealNow) window.revealNow();
  }

  /* ---------- 删除照片（本机直接删；服务器照片只能删自己的） ---------- */
  grid.addEventListener("click", (e) => {
    const del = e.target.closest(".photo-del");
    if (!del) return;
    e.stopPropagation();
    const uid = del.dataset.uid;
    const p = photos.find((x) => x.uid === uid);
    if (!p) return;
    if (!window.confirm("删除这张照片吗？")) return;

    if (p.local) {
      const list = readLSP(PHOTOS_KEY, []);
      const idx = list.findIndex((x) => x.uid === uid);
      if (idx !== -1) { list.splice(idx, 1); writeLSP(PHOTOS_KEY, list); }
      photos = photos.filter((x) => x.uid !== uid);
      rebuildCats();
      render();
      if (window.toast) window.toast("已删除");
    } else if (p.server && p.mine && S) {
      S.post({ action: "delete", kind: "photos", uid: uid })
        .then(() => {
          photos = photos.filter((x) => x.uid !== uid);
          rebuildCats();
          render();
          if (window.toast) window.toast("已删除");
        })
        .catch((err) => { if (window.toast) window.toast("删除失败：" + err.message); });
    }
  });

  /* ---------- 添加照片（优先上传服务器, 失败存本机兜底） ---------- */
  const addBtn = document.getElementById("addPhotoBtn");
  const photoInput = document.getElementById("photoInput");
  if (addBtn && photoInput) {
    addBtn.addEventListener("click", () => photoInput.click());

    photoInput.addEventListener("change", () => {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = ""; // 允许重复选同一张
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        if (window.toast) window.toast("请选择图片文件");
        return;
      }
      compressImage(file).then((dataUrl) => {
        const uid = window.newUid ? window.newUid("p") : "p" + Date.now() + Math.floor(Math.random() * 1000);
        const item = { src: dataUrl, cap: "刚刚添加的照片", uid: uid };

        const pushLocal = (why) => {
          const list = readLSP(PHOTOS_KEY, []);
          list.push(item);
          if (!writeLSP(PHOTOS_KEY, list)) {
            if (window.toast) window.toast("本机存储空间不足，试试小一点的图片");
            return;
          }
          photos.push({ src: item.src, cat: "照片", cap: item.cap, local: true, uid: item.uid });
          rebuildCats();
          render();
          if (window.toast) window.toast(why || "已存到本机（服务器暂不可用）");
        };

        if (!S) { pushLocal(); return; }
        S.post({ action: "photo_add", dataUrl: dataUrl, cap: item.cap, uid: uid })
          .then((j) => {
            photos.push({ src: j.record.src, cat: "照片", cap: j.record.cap || item.cap, server: true, mine: j.record.mine !== false, uid: j.record.uid });
            rebuildCats();
            render();
            if (window.toast) window.toast("照片已上传到服务器 💕");
          })
          .catch((e) => {
            // 业务错误（服务端明确拒绝，如限流 429）要如实告诉用户，
            // 不能一律说"服务器暂不可用"；网络层失败才走兜底文案
            pushLocal(e && e.server ? "已暂存本机：" + e.message + "（下次打开自动补传）" : null);
          });
      }).catch(() => {
        if (window.toast) window.toast("图片读取失败，换一张试试");
      });
    });

    /** 图片压缩: 最长边 1200px, JPEG 质量 0.82 */
    function compressImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const MAX = 1200;
            let w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
              const s = Math.min(MAX / w, MAX / h);
              w = Math.round(w * s);
              h = Math.round(h * s);
            }
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            /* JPEG 没有透明通道：不铺底色的话，透明 PNG 的透明区会被浏览器
               默认填成黑色。统一铺白底再画。 */
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          };
          img.onerror = () => reject(new Error("decode"));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error("read"));
        reader.readAsDataURL(file);
      });
    }
  }

  /* ---------- 服务器同步：迁移本机旧照片 → 拉取服务器照片 ---------- */
  (function syncServer() {
    if (!S) return;
    const locals = readLSP(PHOTOS_KEY, []);
    const migrated = [];
    let chain = Promise.resolve();
    locals.forEach((item) => {
      chain = chain.then(() =>
        S.post({ action: "photo_add", dataUrl: item.src, cap: item.cap, uid: item.uid })
          .then((j) => {
            if (j && j.record) migrated.push(j.record);   // 记住刚迁移的记录
            // 迁移成功 → 从本机移除（uid 相同服务器会去重，重复打开不会传两遍）
            const list = readLSP(PHOTOS_KEY, []);
            const i = list.findIndex((x) => x.uid === item.uid);
            if (i !== -1) { list.splice(i, 1); writeLSP(PHOTOS_KEY, list); }
          })
          .catch(() => {})
      );
    });
    chain
      .then(() => S.fetchAll())
      .then((data) => {
        // __SERVER_CONTENT__ 是页面加载那一刻的快照，不含刚迁移的记录：
        // 必须按 uid 合并回来，否则刚迁移的照片会当场消失（刷新才出现）
        const server = data.photos || [];
        const seen = new Set(server.map((p) => p && p.uid));
        const merged = server.concat(migrated.filter((p) => p && p.uid && !seen.has(p.uid)));
        const extras = merged.map((p) => ({
          src: p.src, cat: "照片", cap: p.cap || "我们的新照片",
          server: true, mine: !!p.mine, uid: p.uid,
        }));
        photos = dedupeBySrc((CONFIG.gallery || []).concat(extras).concat(localPhotos()));
        rebuildCats();
        render();
      })
      .catch(() => { /* 服务器不可用：保持本机数据 */ });
  })();

  /* ---------- 灯箱 ---------- */
  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbCap = document.getElementById("lbCaption");

  function openLightbox(i) {
    currentIndex = i;
    lbImg.src = photoUrl(currentList[i].src);
    lbImg.alt = currentList[i].cap || "";
    updateCap();
    lb.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeLightbox() {
    lb.classList.remove("open");
    document.body.style.overflow = "";
  }
  function step(dir) {
    const n = currentList.length;
    currentIndex = (currentIndex + dir + n) % n;
    lbImg.src = photoUrl(currentList[currentIndex].src);
    lbImg.alt = currentList[currentIndex].cap || "";
    updateCap();
  }
  function updateCap() {
    lbCap.innerHTML =
      '<span class="lb-idx">' + (currentIndex + 1) + " / " + currentList.length + "</span>" +
      escapeHtml(currentList[currentIndex].cap);
  }

  document.getElementById("lbClose").addEventListener("click", closeLightbox);
  document.getElementById("lbPrev").addEventListener("click", () => step(-1));
  document.getElementById("lbNext").addEventListener("click", () => step(1));
  lb.addEventListener("click", (e) => {
    if (e.target === lb) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (!lb.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });

  // 触屏滑动切换
  let touchX = null;
  lb.addEventListener("touchstart", (e) => {
    touchX = e.touches[0].clientX;
  }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1); // 左滑下一张, 右滑上一张
  }, { passive: true });

  rebuildCats();
  render();
})();
