/* ============================================================
   情侣网站 · 相册页
   瀑布流照片墙 / 分类筛选 / 灯箱放大(键盘←→、Esc)
   ============================================================ */

(function () {
  "use strict";

  const grid = document.getElementById("galleryGrid");
  const filterBar = document.getElementById("filterBar");
  if (!grid) return;

  const PHOTOS_KEY = "love-photos"; // 网页里添加的照片(本地存储)

  function readLSP(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function writeLSP(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  /* 照片列表 = 配置照片 + 本地添加的照片 */
  let photos = (CONFIG.gallery || []).concat(readLSP(PHOTOS_KEY, []).map((p) => ({
    src: p.src, cat: "照片", cap: p.cap || "我们的新照片", local: true, uid: p.uid,
  })));
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
      item.innerHTML =
        '<img src="' + p.src + '" alt="' + (p.cap || "") + '" loading="lazy">' +
        (p.local ? '<button class="photo-del" data-uid="' + p.uid + '" aria-label="删除照片">✕</button>' : "") +
        '<figcaption class="cap">' + (p.cap || "") + "</figcaption>";
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("photo-del")) return; // 删除按钮不打开灯箱
        openLightbox(i);
      });
      grid.appendChild(item);
    });

    // 触发滚动浮现
    if (window.revealNow) window.revealNow();
  }

  /* ---------- 删除本地照片(事件委托) ---------- */
  grid.addEventListener("click", (e) => {
    const del = e.target.closest(".photo-del");
    if (!del) return;
    e.stopPropagation();
    const uid = del.dataset.uid;
    const list = readLSP(PHOTOS_KEY, []);
    const idx = list.findIndex((p) => p.uid === uid);
    if (idx === -1) return;
    if (window.confirm("删除这张照片吗？")) {
      list.splice(idx, 1);
      writeLSP(PHOTOS_KEY, list);
      photos = (CONFIG.gallery || []).concat(list.map((p) => ({
        src: p.src, cat: "照片", cap: p.cap || "我们的新照片", local: true, uid: p.uid,
      })));
      rebuildCats();
      render();
      if (window.toast) window.toast("已删除");
    }
  });

  /* ---------- 添加照片(压缩后存本地) ---------- */
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
        const list = readLSP(PHOTOS_KEY, []);
        const item = { src: dataUrl, cap: "刚刚添加的照片", uid: "p" + Date.now() + Math.floor(Math.random() * 1000) };
        list.push(item);
        if (!writeLSP(PHOTOS_KEY, list)) {
          if (window.toast) window.toast("本地存储空间不足，试试小一点的图片");
          return;
        }
        photos.push({ src: item.src, cat: "照片", cap: item.cap, local: true, uid: item.uid });
        rebuildCats();
        render();
        if (window.toast) window.toast("照片已添加 💕");
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
      (currentList[currentIndex].cap || "");
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
