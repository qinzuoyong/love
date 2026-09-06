/* ============================================================
   情侣网站 · 时光轴页
   从 config.js 读取事件, 按时间正序、按年份分组渲染
   (年份分组参考 yanhaijing/loveTimeline MIT 思路, 自写实现)
   ============================================================ */

(function () {
  "use strict";

  const wrap = document.getElementById("timelineWrap");
  if (!wrap || !CONFIG.timeline || !CONFIG.timeline.length) return;

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
    yr.innerHTML = "<h2>" + year + "年</h2>";
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
        '<div class="tl-icon">' + (ev.icon || "💗") + "</div>" +
        '<span class="tl-date">' + ev.date + (isFuture ? " · 即将到来" : "") + "</span>" +
        "<h3>" + ev.title + "</h3>" +
        "<p>" + (ev.text || "") + "</p>" +
        "</div>";

      wrap.appendChild(item);
      i++;
    });
  });

  // 触发滚动浮现
  if (window.revealNow) window.revealNow();
})();
