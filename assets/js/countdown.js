/* ============================================================
   情侣网站 · 计时器
   主页: 在一起第 N 天(实时 时/分/秒)
   纪念日页: 距离每个纪念日的倒计时
   ============================================================ */

(function () {
  "use strict";

  // 配置文案由管理员写入，拼 innerHTML 前必须转义
  const esc = window.escHtml || ((v) => String(v === null || v === undefined ? "" : v));

  const START = new Date(CONFIG.startDate + "T00:00:00");
  if (isNaN(START)) return;

  /* ---------- 主页: 大数字计时 ---------- */
  const dayEl = document.getElementById("daysNum");
  const hrEl = document.getElementById("hoursNum");
  const minEl = document.getElementById("minsNum");
  const secEl = document.getElementById("secsNum");

  if (dayEl) {
    let lastDay = -1;
    function tick() {
      const now = new Date();
      let ms = now - START;
      const days = Math.floor(ms / 86400000);
      ms -= days * 86400000;
      const hours = Math.floor(ms / 3600000);
      ms -= hours * 3600000;
      const mins = Math.floor(ms / 60000);
      ms -= mins * 60000;
      const secs = Math.floor(ms / 1000);

      dayEl.textContent = days;
      hrEl.textContent = String(hours).padStart(2, "0");
      minEl.textContent = String(mins).padStart(2, "0");
      secEl.textContent = String(secs).padStart(2, "0");

      // 跨天时同步更新提示语 & 今日特殊日横幅
      if (days !== lastDay) {
        lastDay = days;
        const hint = document.getElementById("daysHint");
        if (hint) {
          hint.textContent =
            "自 " + CONFIG.startDate + " 起，我们已经手牵手走过了 " + days + " 天";
        }
        checkToday();
      }
    }
    tick();
    setInterval(tick, 1000);
    /* 兜底：首帧是同步跑的，若本文件排在 lunar.js / main.js 之前，那一刻
       window.Lunar 与 window.launchFireworks 都还没定义 —— 农历生日会退化成
       按公历月-日匹配（默认配置里那条农历生日会在公历 3-8 误报庆祝），烟花也
       不会放；而 checkToday 只在"天数变化"时重跑，整页都不会自愈。
       加载完成后再判一次，让结果与脚本顺序解耦。 */
    window.addEventListener("load", checkToday);
  }

  /* 解析 repeat 型纪念日日期(月-日)；容错误填的完整日期（"2024-05-20"→5月20日） */
  function parseMD(dateStr) {
    const p = String(dateStr || "").split("-").map((x) => parseInt(x, 10));
    let m, d;
    if (p.length === 3 && p[0] > 31) { m = p[1]; d = p[2]; }   // 带年份的完整日期 → 取月-日
    else if (p.length >= 2) { m = p[0]; d = p[1]; }
    if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return [m, d];
  }

  /* 平年没有 2 月 29 日：new Date(平年, 1, 29) 会静默滚成 3 月 1 日，卡片
     显示"还有 N 天"指向 3-01、当天还报"🎉 就是今天!"（错日）。口径与
     calendar.js 的 .ics 导出一致（BYMONTHDAY=29 平年不触发）：
     2-29 的下一次出现直接跳到下一个闰年。 */
  function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
  function nextOccurrence(y, md) {
    let yy = y;
    if (md[0] === 2 && md[1] === 29 && !isLeap(yy)) {
      do { yy++; } while (!isLeap(yy));
    }
    return new Date(yy, md[0] - 1, md[1]);
  }
  window.__loveNextRepeatOccurrence = nextOccurrence;   // 供 _test_anniv_next.js 直接断言

  /* ---------- 今日特殊日(主页横幅): 生日/纪念日当天自动庆祝 ---------- */
  function checkToday() {
    const el = document.getElementById("todayBanner");
    if (!el) return;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pad = (n) => String(n).padStart(2, "0");
    const found = [];

    (CONFIG.anniversaries || []).forEach((item) => {
      if (item.type === "once") {
        const ymd = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
        if (item.date === ymd) found.push(item);
        return;
      }
      if (item.lunar && window.Lunar) {
        const l = Lunar.toLunar(today.getFullYear(), today.getMonth() + 1, today.getDate());
        if (!l) return;
        let leap = false, ds = item.date;
        if (ds.charAt(0) === "闰") { leap = true; ds = ds.slice(1); }
        const parts = ds.split("-");
        if (parseInt(parts[0], 10) === l.month &&
            parseInt(parts[1], 10) === l.day &&
            leap === l.isLeap) {
          found.push(item);
        }
        return;
      }
      const md = parseMD(item.date);
      if (md && md[0] === today.getMonth() + 1 && md[1] === today.getDate()) {
        found.push(item);
      }
    });

    if (found.length) {
      const icons = found.map((f) => esc(f.icon)).join(" ");
      const titles = found.map((f) => esc(f.title)).join("、");
      el.style.display = "flex";
      el.innerHTML = icons + ' 今天是 <b>' + titles + "</b>！好好庆祝吧 " + icons;
      // 特殊日放烟花庆祝(每页会话只放一次)
      if (window.launchFireworks) setTimeout(window.launchFireworks, 300);
    } else {
      el.style.display = "none";
    }
  }

  /* ---------- 纪念日页 ---------- */
  const grid = document.getElementById("annivGrid");
  const totalEl = document.getElementById("annivTotalDays");

  function fmt(n) {
    return String(n).padStart(2, "0");
  }

  // 已陪伴总天数
  if (totalEl) {
    totalEl.textContent = Math.floor((Date.now() - START) / 86400000);
  }

  if (grid) {
    // 计算某次纪念日距现在的状态
    function calc(item) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let target, passed;

      if (item.type === "once") {
        target = new Date(item.date + "T00:00:00");
        if (isNaN(target)) return null;
        passed = target < today;
        return { target, passed, days: Math.round((target - today) / 86400000) };
      }

      // 农历生日: 自动换算成今年/明年对应的真实公历日期
      if (item.lunar && window.Lunar) {
        let leap = false;
        let ds = item.date;
        if (ds.charAt(0) === "闰") { leap = true; ds = ds.slice(1); }
        const parts = ds.split("-");
        const lm = parseInt(parts[0], 10);
        const ld = parseInt(parts[1], 10);
        if (!lm || !ld) return null;

        const nowLunar = Lunar.toLunar(today.getFullYear(), today.getMonth() + 1, today.getDate());
        if (!nowLunar) return null;

        if (leap) {
          // 闰月生日: 找下一个出现该闰月的农历年(最多看 8 年)。
          // 今年闰月已过的必须跳过，否则卡片会整年停在"就是今天"
          for (let y = nowLunar.year; y <= nowLunar.year + 8; y++) {
            if (Lunar.leapMonth(y) === lm) {
              const md = Lunar.monthDays ? Lunar.monthDays(y, lm, true) : 0;
              const day = md > 0 ? Math.min(ld, md) : ld;   // 该月只有 29 天时把"三十"夹到廿九
              const s = Lunar.toSolar(y, lm, day, true);
              if (!s) continue;
              const t = new Date(s.year, s.month - 1, s.day);
              if (t >= today) { target = t; break; }
            }
          }
          if (!target) {
            return {
              skipped: true, lunar: true,
              lunarLabel: Lunar.dateCN(lm, ld, leap),
              label: "今年无" + Lunar.monthCN(lm, leap),
            };
          }
        } else {
          // 农历"三十"在该月只有 29 天时会落到下月初一，这里夹到该月最后一天
          const clampDay = (y) => {
            const md = Lunar.monthDays ? Lunar.monthDays(y, lm, false) : 0;
            return md > 0 ? Math.min(ld, md) : ld;
          };
          const s1 = Lunar.toSolar(nowLunar.year, lm, clampDay(nowLunar.year), false);
          if (!s1) return null;
          target = new Date(s1.year, s1.month - 1, s1.day);
          if (target < today) { // 已过 → 下一农历年
            const s2 = Lunar.toSolar(nowLunar.year + 1, lm, clampDay(nowLunar.year + 1), false);
            if (s2) target = new Date(s2.year, s2.month - 1, s2.day);
          }
        }
        return {
          target, passed: false,
          days: Math.round((target - today) / 86400000),
          lunar: true,
          lunarLabel: Lunar.dateCN(lm, ld, leap),
        };
      }

      // repeat: 今年这一次, 过了就算明年的(容错: 误填完整日期时取月-日)
      const md = parseMD(item.date);
      if (!md) return null;
      let d = nextOccurrence(now.getFullYear(), md);
      if (d < today) d = nextOccurrence(now.getFullYear() + 1, md);
      return { target: d, passed: false, days: Math.round((d - today) / 86400000) };
    }

    function fmtSolar(d) {
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }

    function render() {
      grid.innerHTML = "";
      CONFIG.anniversaries.forEach((item, i) => {
        const r = calc(item);
        if (!r) return;

        const card = document.createElement("div");
        card.className = "anniv-card glass reveal";
        card.style.transitionDelay = (i * 80) + "ms";

        // 实时倒计时容器: 由 tickAll() 每秒刷新
        const countEl = document.createElement("div");
        countEl.className = "count anniv-count";
        if (r.skipped) {
          countEl.textContent = r.label;
          countEl.style.color = "#9a7b8a";
          countEl.style.fontSize = "0.95rem";
        } else {
          countEl.dataset.target = r.target.toISOString();
          if (r.passed && item.type === "once") countEl.dataset.passedOnce = "1";
        }

        // 日期行: 农历条目显示农历写法 + 换算出的当年公历日期
        let dateHtml = esc(item.date);
        if (r.lunar) {
          dateHtml =
            '<span class="lunar-badge">农历</span>' +
            esc(r.lunarLabel) +
            (r.skipped
              ? " · 今年无此闰月"
              : ' · 下次 <span class="lunar-solar">' + esc(fmtSolar(r.target)) + "</span>");
        }

        card.innerHTML =
          '<div class="icon">' + esc(item.icon) + "</div>" +
          "<h3>" + esc(item.title) + "</h3>" +
          '<div class="date">' + dateHtml + "</div>";
        card.appendChild(countEl);

        // 「加入日历」按钮：点击由 calendar.js 的事件委托处理（生成 .ics 下载）
        const icsBtn = document.createElement("button");
        icsBtn.type = "button";
        icsBtn.className = "btn btn-ghost anniv-ics";
        icsBtn.setAttribute("data-anniv-add", String(i));
        icsBtn.textContent = "📅 加入日历";
        card.appendChild(icsBtn);

        grid.appendChild(card);
      });
      // 触发滚动浮现
      if (window.revealNow) window.revealNow();
    }

    // 每秒刷新所有倒计时
    let lastYmd = "";
    function tickAll() {
      const now = new Date();
      const ymd = now.getFullYear() + "-" + now.getMonth() + "-" + now.getDate();
      if (lastYmd && ymd !== lastYmd) {
        // 跨天：卡片目标日、总天数、"下一个纪念日"都必须重算，
        // 否则纪念日当天过后会永远停在"🎉 就是今天!"
        render();
        renderNext();
        if (totalEl) totalEl.textContent = Math.floor((Date.now() - START) / 86400000);
      }
      lastYmd = ymd;
      document.querySelectorAll(".anniv-count").forEach((el) => {
        if (el.dataset.passedOnce === "1") {
          el.innerHTML = '<span style="color:#9a7b8a;font-size:0.95rem">已度过 这一天</span>';
          return;
        }
        if (!el.dataset.target) return; // 无目标日期(如今年无此闰月)
        let ms = new Date(el.dataset.target) - now;
        if (ms <= 0) {
          el.innerHTML = "🎉 <small>就是今天!</small>";
          return;
        }
        const d = Math.floor(ms / 86400000); ms -= d * 86400000;
        const h = Math.floor(ms / 3600000);  ms -= h * 3600000;
        const m = Math.floor(ms / 60000);    ms -= m * 60000;
        const s = Math.floor(ms / 1000);
        const pad = (n) => String(n).padStart(2, "0");
        el.innerHTML =
          "还有 <b>" + d + "</b> <small>天</small> " +
          '<span class="hms">' + pad(h) + ":" + pad(m) + ":" + pad(s) + "</span>";
      });
    }
    render();
    tickAll();
    setInterval(tickAll, 1000);
    setInterval(renderNext, 60000); // 横幅跨天自动刷新

    // 下一个纪念日高亮横幅
    function renderNext() {
      const el = document.getElementById("nextAnniv");
      if (!el) return;
      const now = Date.now();
      const rows = CONFIG.anniversaries
        .map((item) => ({ item, r: calc(item) }))
        .filter((x) => x.r && !x.r.skipped);
      // 与卡片倒计时同口径: 目标日 0 点已到(dist<=0)才算"就是今天"，
      // 否则前一天晚上横幅就提前宣告"就是今天"了
      const dist = (r) => new Date(r.target).getTime() - now;
      const remaining = rows.filter((x) => !x.r.passed);
      const today = remaining.find((x) => dist(x.r) <= 0);
      const upcoming = remaining
        .filter((x) => dist(x.r) > 0)
        .sort((a, b) => dist(a.r) - dist(b.r))[0];
      let html;
      if (today) {
        html = '<span class="n-icon">🎉</span> <b>' + esc(today.item.title) + "</b> 就是今天！好好庆祝吧";
        // 纪念日当天放烟花庆祝(每页会话只放一次)
        if (window.launchFireworks) setTimeout(window.launchFireworks, 300);
      } else if (upcoming) {
        /* 与卡片同口径：按"两个零点之间"算整天数。直接对 now 取 floor 的话，
           纪念日前一整天 dist 都 < 24 小时 → 横幅显示"还有 0 天"，而卡片写的是
           "还有 1 天"，同一天两个数字打架。 */
        const target0 = new Date(upcoming.r.target).setHours(0, 0, 0, 0);
        const today0 = new Date(now).setHours(0, 0, 0, 0);
        const d = Math.round((target0 - today0) / 86400000);
        html = '<span class="n-icon">💐</span> 下一个纪念日：<b>' + esc(upcoming.item.title) + "</b> · 还有 <b>" + d + "</b> 天";
      } else {
        html = "所有纪念日都已度过，去创造新的吧 💕";
      }
      el.innerHTML = html;
    }
    renderNext();
  }
})();
