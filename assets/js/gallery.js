/* ============================================================
   情侣网站 · 相册页
   瀑布流照片墙 / 分类筛选 / 灯箱放大(键盘←→、Esc)
   照片列表 = 配置照片(CONFIG.gallery) + 服务器照片(跨设备共享)
   + 本机旧照片(服务器不可用时兜底, 成功后自动迁移到服务器)
   ============================================================ */

(function () {
  "use strict";

  /* 切页时本页脚本会被**重新执行**，而挂在 document/window 上的监听不随视图内容
     一起消失 —— 一律登记给生命周期统一清理，否则一次一页地累积。
     非挂载期（直接打开本页）它退化成原生调用，行为不变。 */
  const LC = window.LoveLifecycle || { on: (t, y, f, o) => t.addEventListener(y, f, o) };

  const grid = document.getElementById("galleryGrid");
  const filterBar = document.getElementById("filterBar");
  if (!grid) return;

  const PHOTOS_KEY = "love-photos"; // 网页里添加的照片（本机兜底/旧数据迁移源）
  /* 照片上传的超时预算（毫秒）。默认的 45 秒只适合文本类请求：照片是 base64，
     压缩后仍有几百 KB，在免费主机 7–13KB/s 的链路上要几十秒到几分钟 —— 用默认值
     会把正常上传掐断（比"挂住"更糟）。这里给 4 分钟，目的只是"别永远挂住"。 */
  const PHOTO_TIMEOUT_MS = 240000;
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
  /* 迁移在途期间用户的新增/删除登记簿（消费方见文件末尾的 syncServer）：
       touchedAdd = 服务器刚返回的记录（按 uid），touchedDel = 已从服务器删掉的 uid。
     为什么要有：syncServer 最后拿到的 S.fetchAll() 是**页面加载那一刻**的快照，而它用
     整体替换的方式写回 photos —— 不登记的话，迁移期间刚上传的会当场消失、刚删除的
     会被快照带回列表里（用户再传一次就在服务器留下重复记录与 uploads/ 孤儿文件）。
     与 letters.js 的 mergeByUid() 是同一件事的对称写法。 */
  const touchedAdd = new Map();
  const touchedDel = new Set();
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
      /* 图片加载失败要说清楚：不处理的话格子里只剩浏览器默认的"碎裂图标"+一行 alt，
         用户分不清是网慢、照片被删了、还是需要重新解锁（photo.php 在门禁 Cookie 缺失时
         回 403；记录还在 content.json 里但 uploads 下的文件被清掉时回 404）。 */
      const picture = item.querySelector("img");
      if (picture) {
        picture.addEventListener("error", () => {
          picture.style.display = "none";                     // 别让浏览器画那个碎裂图标
          item.classList.add("photo-broken");
          const cap = item.querySelector(".cap");
          if (cap) cap.textContent = "🖼 图片加载失败：" + (p.cap || "这张照片") + "（可能已被删除，或需要重新解锁）";
        });
      }
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
      /* 本机照片删除是「读-改-写」两步。写入失败（配额满 / 站点存储被禁用）时旧码
         照样从内存里剔掉、并弹「已删除」—— 而 render() 渲染的是内存数组，
         所以**当场看不出任何异常**，只有下次刷新才带着那张照片回来。
         写不进去就照实说，并把照片留在网格里：屏幕上看到的就是存储里的事实。 */
      const list = normalizeLocalPhotos();
      const idx = list.findIndex((x) => x && typeof x === "object" && x.uid === uid);
      const next = idx === -1 ? null : list.slice(0, idx).concat(list.slice(idx + 1));
      if (!next || !writeLSP(PHOTOS_KEY, next)) {
        if (window.toast) window.toast("本机存储写不进去（空间满或被浏览器禁用），这张照片没能删除");
        return;
      }
      photos = photos.filter((x) => x.uid !== uid);
      rebuildCats();
      render();
      if (window.toast) window.toast("已删除");
    } else if (p.server && p.mine && S) {
      S.post({ action: "delete", kind: "photos", uid: uid })
        .then(() => {
          touchedDel.add(uid);   // 登记：合并时别让页面加载快照把它带回来
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

    /* 上传在途标记（第七轮 S7-03）：照片上传的超时预算是 4 分钟，慢网下选完图后界面
       可能长时间毫无变化 —— 不知情的人会再选一次（上面 `photoInput.value=""` 本来就
       允许重选同一张），第二次是**另一个 uid 的并发上传**，而服务端只按 uid 去重
       （lib/content.php），于是同一张照片留下两条服务器记录 + uploads/ 两份文件。
       在途期间：按钮禁用并显示"上传中…"，新的选图直接忽略。 */
    let uploading = false;
    function setUploading(on) {
      uploading = on;
      addBtn.disabled = on;
      addBtn.textContent = on ? "⏳ 上传中…" : "📷 添加照片";
    }

    photoInput.addEventListener("change", () => {
      if (uploading) { photoInput.value = ""; return; }   // 在途期间不接受新的选图
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = ""; // 允许重复选同一张
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        if (window.toast) window.toast("请选择图片文件");
        return;
      }
      setUploading(true);
      compressImage(file).then((dataUrl) => {
        const uid = window.newUid ? window.newUid("p") : "p" + Date.now() + Math.floor(Math.random() * 1000);
        const item = { src: dataUrl, cap: "刚刚添加的照片", uid: uid };

        const pushLocal = (why) => {
          const list = readLSP(PHOTOS_KEY, []);
          list.push(item);
          if (!writeLSP(PHOTOS_KEY, list)) {
            if (window.toast) window.toast("本机存储空间不足，试试小一点的图片");
            setUploading(false);
            return;
          }
          photos.push({ src: item.src, cat: "照片", cap: item.cap, local: true, uid: item.uid });
          rebuildCats();
          render();
          setUploading(false);
          if (window.toast) window.toast(why || "已存到本机（服务器暂不可用）");
        };

        if (!S) { pushLocal(); return; }
        /* 第二个参数 = 超时毫秒数。照片（base64 最大 3MB）在 7–13KB/s 的链路上要
           几十秒到几分钟，用默认的 45 秒会把**正常但慢**的上传掐断，所以给 4 分钟：
           这里要的只是"别永远挂住"，不是限制传输时间。 */
        S.post({ action: "photo_add", dataUrl: dataUrl, cap: item.cap, uid: uid }, PHOTO_TIMEOUT_MS)
          .then((j) => {
            photos.push({ src: j.record.src, cat: "照片", cap: j.record.cap || item.cap, server: true, mine: j.record.mine !== false, uid: j.record.uid });
            // 登记：迁移还在途时这一步之后会被 syncServer 的整体替换合并覆盖，
            // 不登记就会当场消失（服务器上其实还在）
            if (j.record && j.record.uid) touchedAdd.set(j.record.uid, j.record);
            rebuildCats();
            render();
            setUploading(false);
            if (window.toast) window.toast("照片已上传到服务器 💕");
          })
          .catch((e) => {
            // 业务错误（服务端明确拒绝，如限流 429）要如实告诉用户，
            // 不能一律说"服务器暂不可用"；网络层失败才走兜底文案
            pushLocal(e && e.server ? "已暂存本机：" + e.message + "（下次打开自动补传）" : null);
          });
      }).catch(() => {
        setUploading(false);
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
    let migrateStuck = 0;   // 已传到服务器、但本机副本删不掉（存储写不进去）的张数
    let chain = Promise.resolve();
    locals.forEach((item) => {
      chain = chain.then(() =>
        S.post({ action: "photo_add", dataUrl: item.src, cap: item.cap, uid: item.uid }, PHOTO_TIMEOUT_MS)
          .then((j) => {
            if (j && j.record) migrated.push(j.record);   // 记住刚迁移的记录
            // 迁移成功 → 从本机移除（uid 相同服务器会去重，重复打开不会传两遍）
            const list = readLSP(PHOTOS_KEY, []);
            const i = list.findIndex((x) => x && typeof x === "object" && x.uid === item.uid);
            if (i !== -1) {
              /* 移除失败不能说成成功：本机副本还在 → 下次打开会白传一遍
                 （屏幕上不会重复显示，是这个 src 的去重挡住的，所以只剩"白传"这一个后果） */
              const next = list.slice(0, i).concat(list.slice(i + 1));
              if (!writeLSP(PHOTOS_KEY, next)) migrateStuck++;
            }
          })
          .catch(() => {})
      );
    });
    chain
      .then(() => S.fetchAll())
      .then((data) => {
        // __SERVER_CONTENT__ 是页面加载那一刻的快照，不含刚迁移/刚新增的记录：
        // 必须按 uid 合并回来，否则刚迁移的照片会当场消失（刷新才出现）。
        // 同时要先剔掉"迁移期间已被删除"的 uid，否则刚删掉的会被快照（或新增登记）
        // 复活 —— 用户再传一次就在服务器留下重复记录 + uploads/ 孤儿文件。
        const server = (data.photos || []).filter((p) => !(p && p.uid && touchedDel.has(p.uid)));
        const seen = new Set(server.map((p) => p && p.uid));
        const merged = server.concat(
          migrated.concat(Array.from(touchedAdd.values()))
            .filter((p) => p && p.uid && !touchedDel.has(p.uid) && !seen.has(p.uid))
        );
        const extras = merged.map((p) => ({
          src: p.src, cat: "照片", cap: p.cap || "我们的新照片",
          server: true, mine: !!p.mine, uid: p.uid,
        }));
        /* 服务器记录与本机副本 uid 相同时，只留服务器那份：本机兜底照片存的是 base64
           dataURL，而服务器记录的 src 是 assets/img/uploads/… —— dedupeBySrc 按 src
           去重根本不命中，同一张照片会显示两遍。旧注释里"屏幕上不会重复显示"的断言
           只对**旧版**路径型本机条目成立（第七轮 S7-04）。 */
        const serverUids = new Set(extras.map((p) => p && p.uid).filter(Boolean));
        photos = dedupeBySrc(
          (CONFIG.gallery || []).concat(extras)
            .concat(localPhotos().filter((p) => !(p && p.uid && serverUids.has(p.uid))))
        );
        rebuildCats();
        render();
      })
      .catch(() => { /* 服务器不可用：保持本机数据 */ })
      .then(() => {
        if (migrateStuck && window.toast) {
          window.toast(migrateStuck + " 张照片已上传到服务器，但本机副本删不掉（存储写不进去）");
        }
      });
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
  /* 灯箱里那张大图加载失败时，原来只留一张空白大图和正常的"3 / 12"说明，
     看起来就像"灯箱坏了"。只在"当前这张确实加载失败"时才改说明 —— 用户
     翻了页就会先 setAttribute 新 src，此时旧图的 error 事件不该再改说明。 */
  lbImg.addEventListener("error", () => {
    const want = currentList[currentIndex] ? photoUrl(currentList[currentIndex].src) : "";
    if (lbImg.getAttribute("src") !== want) return;    // 已经翻到别的照片了
    lbImg.classList.add("lb-broken");
    lbCap.textContent = "🖼 这张图加载失败（可能已被删除，或需要重新解锁）";
  });
  lb.addEventListener("click", (e) => {
    if (e.target === lb) closeLightbox();
  });
  LC.on(document, "keydown", (e) => {
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
