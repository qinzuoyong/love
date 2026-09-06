/* ============================================================
   情侣网站 · 计时器
   主页: 在一起第 N 天(实时 时/分/秒)
   纪念日页: 距离每个纪念日的倒计时
   ============================================================ */

(function () {
  "use strict";

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
      const icons = found.map((f) => f.icon).join(" ");
      const titles = found.map((f) => f.title).join("、");
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
              const s = Lunar.toSolar(y, lm, ld, true);
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
          const s1 = Lunar.toSolar(nowLunar.year, lm, ld, false);
          if (!s1) return null;
          target = new Date(s1.year, s1.month - 1, s1.day);
          if (target < today) { // 已过 → 下一农历年
            const s2 = Lunar.toSolar(nowLunar.year + 1, lm, ld, false);
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
      let d = new Date(now.getFullYear(), md[0] - 1, md[1]);
      if (d < today) d = new Date(now.getFullYear() + 1, md[0] - 1, md[1]);
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
        let dateHtml = item.date;
        if (r.lunar) {
          dateHtml =
            '<span class="lunar-badge">农历</span>' +
            r.lunarLabel +
            (r.skipped
              ? " · 今年无此闰月"
              : ' · 今年 <span class="lunar-solar">' + fmtSolar(r.target) + "</span>");
        }

        card.innerHTML =
          '<div class="icon">' + item.icon + "</div>" +
          "<h3>" + item.title + "</h3>" +
          '<div class="date">' + dateHtml + "</div>";
        card.appendChild(countEl);

        grid.appendChild(card);
      });
      // 触发滚动浮现
      if (window.revealNow) window.revealNow();
    }

    // 每秒刷新所有倒计时
    function tickAll() {
      const now = new Date();
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
        html = '<span class="n-icon">🎉</span> <b>' + today.item.title + "</b> 就是今天！好好庆祝吧";
        // 纪念日当天放烟花庆祝(每页会话只放一次)
        if (window.launchFireworks) setTimeout(window.launchFireworks, 300);
      } else if (upcoming) {
        const d = Math.floor(dist(upcoming.r) / 86400000);
        html = '<span class="n-icon">💐</span> 下一个纪念日：<b>' + upcoming.item.title + "</b> · 还有 <b>" + d + "</b> 天";
      } else {
        html = "所有纪念日都已度过，去创造新的吧 💕";
      }
      el.innerHTML = html;
    }
    renderNext();
  }
})();
