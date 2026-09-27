/* ============================================================
   情侣网站 · 计时器
   主页: 在一起第 N 天(实时 时/分/秒)
   纪念日页: 距离每个纪念日的倒计时
   ============================================================ */

(function () {
  "use strict";

  // 配置文案由管理员写入，拼 innerHTML 前必须转义
  const esc = window.escHtml || ((v) => String(v === null || v === undefined ? "" : v));
  /* 切页时本页脚本会被**重新执行**，而挂在 window 上的 load 监听与三个 setInterval
     不随视图内容一起消失 —— 一律登记给生命周期统一清理，否则一次一页地累积。
     非挂载期（直接打开本页）它退化成原生调用，行为不变。 */
  const LC = window.LoveLifecycle || { on: (t, y, f, o) => t.addEventListener(y, f, o), every: (f, m) => setInterval(f, m), after: (f, m) => setTimeout(f, m) };

  const START = new Date(CONFIG.startDate + "T00:00:00");
  /* startDate 解析不出来（"2023-2-3" 没补零、"2023/05/20" 用了斜杠、"2023-13-45"
     月份越界…）时 START 是 Invalid Date。旧写法在这里直接 `return`，把整个 IIFE 掐断 ——
     纪念日页除了一起天数以外**什么都不渲染**（卡片、横幅全没有），而真正的原因
     只是一个与本页大部分内容无关的字段写错了。
     现在只跳过依赖 START 的两小块（首页大数字计时、"已陪伴总天数"），
     纪念日列表本身照常渲染（calc() 走的是 item.date / CONFIG.anniversaries，用不到 START）。
     注意："2023-02-30" 不是触发条件 —— V8 会把它滚成 3-01，START 依然合法。 */
  const startOk = !isNaN(START);

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
      /* 夹到 0：startDate 填成未来（后台只校验格式与"是不是真实日期"，把 2023 打成
         2032 会被照常保存）时 ms 是负数，首页会显示"走过了 -2400 天"、
         纪念日页的总天数也是负的。sharecard.js 早就有这道 Math.max(0, …)，
         这里补上同一口径；显示 0 比显示负数清楚得多（真实原因还是去后台改日期）。 */
      if (ms < 0) ms = 0;
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
    /* START 非法时只跳过这一块（大数字 + 天数提示语都得从 START 算），
       "今日特殊日"横幅（checkToday）与 START 无关，load 之后照旧补判一次。 */
    if (startOk) {
      tick();
      LC.every(tick, 1000);
    }
    /* 兜底：首帧是同步跑的，若本文件排在 lunar.js / main.js 之前，那一刻
       window.Lunar 与 window.launchFireworks 都还没定义 —— 农历生日会退化成
       按公历月-日匹配（默认配置里那条农历生日会在公历 3-8 误报庆祝），烟花也
       不会放；而 checkToday 只在"天数变化"时重跑，整页都不会自愈。
       加载完成后再判一次，让结果与脚本顺序解耦。 */
    LC.on(window, "load", checkToday);
  }

  /* 该公历月是否真的存在这一天。按"某一年里存在即可"判断：2-29 放行
     （闰年存在，由 nextOccurrence 负责跳过平年），4-31 / 2-30 / 6-31 不放行。 */
  function dayExists(m, d) {
    const probe = new Date(2000, m - 1, d);   // 2000 是闰年，能容纳 2-29
    return probe.getMonth() === m - 1 && probe.getDate() === d;
  }

  /* 解析 repeat 型纪念日日期(月-日)；容错误填的完整日期（"2024-05-20"→5月20日） */
  function parseMD(dateStr) {
    const p = String(dateStr || "").split("-").map((x) => parseInt(x, 10));
    let m, d;
    if (p.length === 3 && p[0] > 31) { m = p[1]; d = p[2]; }   // 带年份的完整日期 → 取月-日
    else if (p.length >= 2) { m = p[0]; d = p[1]; }
    if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    /* 只查上界会放行 4-31 / 2-30 这类"这个月没有这一天"的写法：new Date 会静默进位到
       5-01 / 3-02，于是卡片日期行照抄「4-31」而倒计时在 5-01 归零、当天还报「就是今天」。
       口径与 calendar.js 一次性日期那条拒绝进位一致（农历条目不走这里）。 */
    if (!dayExists(m, d)) return null;
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

  /* 农历「三十」在该农历月只有 29 天时，这条纪念日的"当天"是哪一天？
     纪念日卡片那边会把它夹到该月最后一天（见 calc 的 clampDay），横幅必须用同一条
     口径 —— 否则同一天里两条路径结论相反：约一半的年份（该农历月只有 29 天时）
     生日当天打开首页毫无表示（横幅 display:none、也不放烟花），点进纪念日页却写着
     「🎉 就是今天!」。
     判据：① 配置的日子就是今天的农历日；或 ② 今天正好是该农历月的最后一天，
     而配置的日子比它大（即"三十"落在只有 29 天的月份里）。 */
  function lunarDayMatches(nowLunar, wantDay) {
    if (nowLunar.day === wantDay) return true;
    if (!(wantDay > nowLunar.day)) return false;
    const md = Lunar.monthDays ? Lunar.monthDays(nowLunar.year, nowLunar.month, nowLunar.isLeap) : 0;
    return md > 0 && nowLunar.day === md;
  }

  /* 剩余时间 → "整日数 + 时:分:秒" 的**唯一一份**算法：纪念日卡片（tickAll）与
     "下一个纪念日"横幅（renderNext）都从这里取数，免得两处各算一套再打架（F-S7-03）。
     口径：整日数 = floor(剩余毫秒 / 86400000)，时间部分 = 剩余毫秒减去整天 ——
     两者相加**恰好等于**真实剩余时间，这正是"还有 2 天 10:00:00"读起来不矛盾的原因。
     故意不用"两个零点相减"的日历日差：它在剩余不足一天时给出 1，配上午时秒会
     凭空多算一天（第三轮就是按这个口径改了横幅、没改卡片，于是同一天里
     卡片写"还有 0 天 14:00:00"、横幅写"还有 1 天"）。 */
  function splitRemaining(ms) {
    if (!(ms > 0)) return null;
    const days = Math.floor(ms / 86400000);
    let rest = ms - days * 86400000;
    const h = Math.floor(rest / 3600000); rest -= h * 3600000;
    const m = Math.floor(rest / 60000);   rest -= m * 60000;
    const s = Math.floor(rest / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return { days: days, hms: pad(h) + ":" + pad(m) + ":" + pad(s) };
  }
  window.__loveSplitRemaining = splitRemaining;   // 供套件直接断言口径

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
            leap === l.isLeap &&
            lunarDayMatches(l, parseInt(parts[1], 10))) {
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
      if (window.launchFireworks) LC.after(window.launchFireworks, 300);
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

  // 已陪伴总天数（负值夹到 0，理由见上面 tick() 里那段注释）；START 非法时整块跳过
  if (totalEl && startOk) {
    totalEl.textContent = Math.max(0, Math.floor((Date.now() - START) / 86400000));
  }

  if (grid) {
    /* 剩余整日数（**与卡片显示同一个数**）。calc 的 days 字段以前用"两个零点相减"，
       比卡片显示的大 1 —— 第三轮"同口径"正是照着它去改横幅的，于是同一天里
       卡片"还有 0 天 14:00:00"、横幅"还有 1 天"（F-S7-03）。 */
    const daysLeftOf = (t) => { const left = splitRemaining(t - Date.now()); return left ? left.days : 0; };

    // 计算某次纪念日距现在的状态
    function calc(item) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let target, passed;

      if (item.type === "once") {
        /* 与 repeat 分支 / calendar.js 的 parseYmd 同一份"存在性"校验：先按 年-月-日
           解析，再回读 getFullYear/getMonth/getDate 拒绝进位。旧写法
           new Date(item.date + "T00:00:00") 有两个坑：
           ① 不存在的日期不是 Invalid Date —— "2027-02-29" 被 V8 静默进位到 3-01，
              于是卡片日期行照抄「2027-02-29」而倒计时指向 3-01、当天横幅与卡片还报
              「就是今天」，同文件按字符串比对的 checkToday（item.date === ymd）
              却永远不会命中那条；
           ② 解析不出来的日期（"2026-9-27" 没补零、"2024-13-45" 越界、空值）会
              isNaN → return null，卡片**静默消失** —— 与 repeat 分支
              （会渲染"日期不合法：…"）口径相反。
           现在：不合法一律按 repeat 的口径照实说出来，不进位、也不丢卡。
           一次性日期的存储格式被后台钉成 `年-月-日`（admin 只校验这个形状），
           所以这里不猜"4-31"或"9-27"这类写法：一律算不合法。 */
        const om = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(item.date || "").trim());
        const oLabel = "日期不合法：" + String(item.date || "(空)");
        if (!om) return { skipped: true, label: oLabel };
        const oy = +om[1], omo = +om[2], od = +om[3];
        if (omo < 1 || omo > 12 || od < 1 || od > 31) return { skipped: true, label: oLabel };
        target = new Date(oy, omo - 1, od);
        // 回读拒进位：2027-02-29 → 3-01、2025-02-30 → 3-02 这类一律打回
        if (target.getFullYear() !== oy || target.getMonth() !== omo - 1 || target.getDate() !== od) {
          return { skipped: true, label: oLabel };
        }
        passed = target < today;
        return { target, passed, days: daysLeftOf(target) };
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
          days: daysLeftOf(target),
          lunar: true,
          lunarLabel: Lunar.dateCN(lm, ld, leap),
        };
      }

      // repeat: 今年这一次, 过了就算明年的(容错: 误填完整日期时取月-日)
      const md = parseMD(item.date);
      if (!md) {
        /* 配置里写了一个不存在的日子（4-31 / 2-30…）或空值：不许猜、也不许静默消失 ——
           照实把这张卡标成"日期不合法"，否则它会被算成一个进位到 5-01 的日期，
           当天横幅还会庆祝（后台那边现在也会拦下这种写法，见 admin 的校验）。 */
        return { skipped: true, label: "日期不合法：" + String(item.date || "(空)") };
      }
      let d = nextOccurrence(now.getFullYear(), md);
      if (d < today) d = nextOccurrence(now.getFullYear() + 1, md);
      return { target: d, passed: false, days: daysLeftOf(d) };
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
        if (totalEl && startOk) totalEl.textContent = Math.max(0, Math.floor((Date.now() - START) / 86400000));
      }
      lastYmd = ymd;
      document.querySelectorAll(".anniv-count").forEach((el) => {
        if (el.dataset.passedOnce === "1") {
          el.innerHTML = '<span style="color:#9a7b8a;font-size:0.95rem">已度过 这一天</span>';
          return;
        }
        if (!el.dataset.target) return; // 无目标日期(如今年无此闰月)
        /* 与"下一个纪念日"横幅共用同一份拆分（F-S7-03）：整日数 + 时:分:秒 相加
           恰好等于真实剩余时间，横幅再也不会写出比这里大 1 的日数 */
        const left = splitRemaining(new Date(el.dataset.target) - now);
        if (!left) {
          el.innerHTML = "🎉 <small>就是今天!</small>";
          return;
        }
        el.innerHTML =
          "还有 <b>" + left.days + "</b> <small>天</small> " +
          '<span class="hms">' + left.hms + "</span>";
      });
    }
    render();
    tickAll();
    LC.every(tickAll, 1000);
    LC.every(renderNext, 60000); // 横幅跨天自动刷新

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
        if (window.launchFireworks) LC.after(window.launchFireworks, 300);
      } else if (upcoming) {
        /* 与卡片倒计时共用同一份拆分（F-S7-03）。第三轮按"两个零点相减"算整天数，
           结果是纪念日前一整天横幅写"还有 1 天"、同一页的卡片写"还有 0 天 14:00:00" ——
           两个数字差 1；根因是"日历日差"配不上"时:分:秒"（两者相加会凭空多算一天）。
           现在统一用"整日数 + 时:分:秒"，不足一天时改说"明天"，不再报出 0 或 1 这种
           容易被读成"今天"的日数。 */
        const left = splitRemaining(dist(upcoming.r));
        html = '<span class="n-icon">💐</span> 下一个纪念日：<b>' + esc(upcoming.item.title) + "</b> · " +
          (!left ? "就是今天"
                 : (left.days === 0 ? "明天（还有 " + left.hms + "）"
                                    : "还有 <b>" + left.days + "</b> 天"));
      } else {
        html = "所有纪念日都已度过，去创造新的吧 💕";
      }
      el.innerHTML = html;
    }
    renderNext();
    /* 本文件在 anniversary.html 里排在 main.js 之前，renderNext() 首次执行时
       window.launchFireworks 尚未定义 —— 纪念日当天那一轮烟花要等 60 秒后的
       定时器才可能放出来（人早走了）。与 checkToday 同一招：加载完成后再判一次。 */
    LC.on(window, "load", renderNext);
  }
})();
