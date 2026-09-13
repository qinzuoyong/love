/* ============================================================
   情侣网站 · 主页增强
   1. 恋爱进度环: 距下一个纪念日的年周期已过百分比
      (参考 yanhaijing/loveTimeline MIT 思路, 自写实现)
   2. 回忆闪现: 每 5 秒淡入切换一张相册照片
      (参考 First-Anniversary-of-Love playImg 思路, 自写实现)
   仅 home.html 加载, 依赖 CONFIG 与 #ringSvg/#ringPct/#ringText/#memoryImg
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 1. 恋爱进度环 ---------- */
  const ringSvg = document.getElementById("ringSvg");
  if (ringSvg && CONFIG.startDate) {
    const pctEl = document.getElementById("ringPct");
    const txtEl = document.getElementById("ringText");
    const ringFill = document.getElementById("ringFill");

    const start = new Date(CONFIG.startDate + "T00:00:00");
    if (!isNaN(start)) {
      const now = new Date();
      // 年周期锚点 = 第一个重复型(非农历/非一次性)纪念日的月-日
      // 农历条目排除: 农历月日对应的公历每年漂移, 不能当固定锚点
      // 「今天」按零点算: 与倒计时的"就是今天"口径一致(见下面的 cycleEnd 比较)
      const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let anchorMD = null;
      (CONFIG.anniversaries || []).forEach((item) => {
        if (item.type === "once" || item.lunar) return;
        // 容错误填的完整日期("2024-05-20" → 取 5-20 当锚点)
        const p = String(item.date || "").split("-").map((x) => +x);
        let m, d;
        if (p.length === 3 && p[0] > 31) { m = p[1]; d = p[2]; }
        else if (p.length === 2) { m = p[0]; d = p[1]; }
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && !anchorMD) anchorMD = [m, d];
      });
      // 周期终点 = 最近的未来锚点(无锚点则用"在一起周年"), 起点 = 它的一年前
      /* 比较用"今天零点"而不是"此刻": 纪念日当天 cycleEnd <= now 会命中，于是
         当场把周期推到明年 —— 环显示约 0%、"距离下次还有 365 天"，而同一页的
         倒计时横幅正写着"就是今天！"。 */
      let cycleEnd;
      if (anchorMD) {
        cycleEnd = new Date(now.getFullYear(), +anchorMD[0] - 1, +anchorMD[1]);
        if (cycleEnd < today0) cycleEnd = new Date(now.getFullYear() + 1, +anchorMD[0] - 1, +anchorMD[1]);
      } else {
        cycleEnd = new Date(now.getFullYear(), start.getMonth(), start.getDate());
        if (cycleEnd < today0) cycleEnd = new Date(now.getFullYear() + 1, start.getMonth(), start.getDate());
      }
      const cycleStart = new Date(cycleEnd.getFullYear() - 1, cycleEnd.getMonth(), cycleEnd.getDate());
      const total = cycleEnd - cycleStart;
      const done = now - cycleStart;
      const pct = Math.min(100, Math.max(0, (done / total) * 100));
      // 天数同样按零点相减，避免"还有 0 天"与"就是今天"两种说法并存
      const daysLeft = Math.max(0, Math.round((cycleEnd - today0) / 86400000));

      const C = 2 * Math.PI * 54; // r=54 周长
      ringFill.style.strokeDasharray = C;
      // 数字动画: 900ms 从 0 滚到目标百分比（开了"减少动态效果"直接出终值）
      const target = Math.round(pct * 10) / 10;
      if (window.__loveReduceMotion) {
        ringFill.style.strokeDashoffset = C * (1 - target / 100);
        if (pctEl) pctEl.textContent = target.toFixed(1) + "%";
      } else {
        const t0 = Date.now();
        const dur = 900;
        (function anim() {
          const k = Math.min(1, (Date.now() - t0) / dur);
          const cur = target * (1 - Math.pow(1 - k, 3)); // ease-out
          ringFill.style.strokeDashoffset = C * (1 - cur / 100);
          if (pctEl) pctEl.textContent = cur.toFixed(1) + "%";
          if (k < 1) animLoop(anim);
        })();
      }
      if (txtEl) {
        txtEl.innerHTML = "这一轮纪念日周期已走过 <b>" + pct.toFixed(1) + "%</b> · 距离下次还有 <b>" + daysLeft + "</b> 天";
      }
    }
  }

  /* ---------- 2. 回忆闪现 ---------- */
  const memImg = document.getElementById("memoryImg");
  if (memImg) {
    const memCap = document.getElementById("memoryCap");
    const photos = (CONFIG.gallery || []).filter((p) => p.src);
    if (photos.length) {
      // 首张用"按日期固定"选一张(每天不同), 之后随机不重复
      const doy = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      function show(idx) {
        const p = photos[idx];
        memImg.classList.remove("mem-in");
        // 首图也要淡入（旧代码 if (!first) 让首图永远停在 opacity:0，
        // 每次进首页前 5 秒只能看到空框）
        memImg.onload = () => memImg.classList.add("mem-in");
        memImg.onerror = () => memImg.classList.add("mem-in");
        memImg.src = (window.lovePhotoUrl ? window.lovePhotoUrl(p.src) : p.src);
        if (memCap) memCap.textContent = p.cap || "";
        // 预加载下一张(不重复当前), 返回给下轮使用; 只剩 1 张时没有"下一张"可换
        let nxt = idx;
        if (photos.length > 1) {
          do { nxt = (Math.random() * photos.length) | 0; } while (nxt === idx);
          new Image().src = (window.lovePhotoUrl ? window.lovePhotoUrl(photos[nxt].src) : photos[nxt].src);
        }
        return nxt;
      }
      let cur = show(doy % photos.length);
      setInterval(() => { cur = show(cur); }, 5000);
    } else {
      const card = memImg.closest(".memory-card");
      if (card) card.style.display = "none";
    }
  }
})();
