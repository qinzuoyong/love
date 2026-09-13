/* ============================================================
   情侣网站 · 时光轴页
   从 config.js 读取事件, 按时间正序、按年份分组渲染
   (年份分组参考 yanhaijing/loveTimeline MIT 思路, 自写实现)
   ============================================================ */

(function () {
  "use strict";

  const wrap = document.getElementById("timelineWrap");
  if (!wrap || !CONFIG.timeline || !CONFIG.timeline.length) return;

  // 配置文案由管理员写入，拼 innerHTML 前必须转义
  const esc = window.escHtml || ((v) => String(v === null || v === undefined ? "" : v));

  // 按日期排序（旧 → 新）
  const events = CONFIG.timeline.slice().sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  // 按年份分组
  const groups = new Map();
  events.forEach((ev) => {
    const y = String(new Date(ev.date + "T00:00:00").getFullYear());
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(ev);
  });

  let i = 0;
  groups.forEach((list, year) => {
    // 年份吸顶标签(参考 loveTimeline 的年块)
    const yr = document.createElement("div");
    yr.className = "tl-year";
    yr.innerHTML = "<h2>" + esc(year) + "年</h2>";
    wrap.appendChild(yr);

    list.forEach((ev) => {
      // 未来事件(date 晚于今天)显示"即将到来"样式, 排在时间线末尾
      const isFuture = new Date(ev.date + "T00:00:00") > new Date();
      const item = document.createElement("div");
      item.className = "tl-item reveal" + (isFuture ? " tl-future" : "") + (i % 2 ? " tl-right" : " tl-left");
      item.style.transitionDelay = (i % 4) * 70 + "ms";

      item.innerHTML =
        '<span class="dot"></span>' +
        '<div class="tl-card glass">' +
        '<div class="tl-icon">' + esc(ev.icon || "💗") + "</div>" +
        '<span class="tl-date">' + esc(ev.date) + (isFuture ? " · 即将到来" : "") + "</span>" +
        "<h3>" + esc(ev.title) + "</h3>" +
        "<p>" + esc(ev.text || "") + "</p>" +
        "</div>";

      wrap.appendChild(item);
      i++;
    });
  });

  // 触发滚动浮现
  if (window.revealNow) window.revealNow();

  /* 时间轴竖线：进视口时从上往下"画"出来（参考 Codrops 的 SVG 描边思路，
     这里用纯 CSS 的 scaleY，走合成层、不触发重排） */
  const timeline = (wrap.querySelector ? wrap.querySelector(".timeline") : null) || wrap;
  /* __loveReduceMotion 由 main.js 定义，而本文件在 timeline.html 里排在
     main.js 之前 —— 在这里直接读它恒为 undefined，检查形同虚设（开了
     "减少动态效果"竖线动画照放）。main.js 是 body 末尾的同步脚本，
     DOMContentLoaded 之后标志必然已就绪，所以把决定推迟到那一刻再做。 */
  function startDraw() {
    if (window.__loveReduceMotion || !("IntersectionObserver" in window)) {
      timeline.classList.add("drawn");
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("drawn"); io.disconnect(); }
      });
    }, {
      /* 阈值是"可见面积 ÷ 整条时间轴面积"：条目一多（约 80 条以上、整条比视口
         高 12 倍以上），这个比例永远达不到 0.08，竖线就永远不"画"出来。
         0.01 兼顾"刚露头就触发"与长列表可用。 */
      threshold: 0.01,
    });
    io.observe(timeline);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startDraw);
  else startDraw();
})();
