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
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
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

  function localPhotos() {
    return readLSP(PHOTOS_KEY, []).map((p) => ({
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
        '<img src="' + escapeHtml(p.src) + '" alt="' + escapeHtml(p.cap) + '" loading="lazy">' +
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
      S.post({ action: "delete", kind: "photos", uid: uid, deviceId: S.deviceId })
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
        const uid = "p" + Date.now() + Math.floor(Math.random() * 1000);
        const item = { src: dataUrl, cap: "刚刚添加的照片", uid: uid };

        const pushLocal = () => {
          const list = readLSP(PHOTOS_KEY, []);
          list.push(item);
          if (!writeLSP(PHOTOS_KEY, list)) {
            if (window.toast) window.toast("本机存储空间不足，试试小一点的图片");
            return;
          }
          photos.push({ src: item.src, cat: "照片", cap: item.cap, local: true, uid: item.uid });
          rebuildCats();
          render();
          if (window.toast) window.toast("已存到本机（服务器暂不可用）");
        };

        if (!S) { pushLocal(); return; }
        S.post({ action: "photo_add", dataUrl: dataUrl, cap: item.cap, uid: uid, deviceId: S.deviceId })
          .then((j) => {
            photos.push({ src: j.record.src, cat: "照片", cap: j.record.cap || item.cap, server: true, mine: true, uid: j.record.uid });
            rebuildCats();
            render();
            if (window.toast) window.toast("照片已上传到服务器 💕");
          })
          .catch(() => pushLocal());
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
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
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
    let chain = Promise.resolve();
    locals.forEach((item) => {
      chain = chain.then(() =>
        S.post({ action: "photo_add", dataUrl: item.src, cap: item.cap, uid: item.uid, deviceId: S.deviceId })
          .then(() => {
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
        const extras = (data.photos || []).map((p) => ({
          src: p.src, cat: "照片", cap: p.cap || "我们的新照片",
          server: true, mine: p.deviceId === S.deviceId, uid: p.uid,
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
    lbImg.src = currentList[i].src;
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
    lbImg.src = currentList[currentIndex].src;
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
