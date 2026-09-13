/* ============================================================
   情侣网站 · 纪念日 → 手机日历（.ics 导出）
   ------------------------------------------------------------
   为什么是「下载导入」而不是「订阅」：
   本项目部署在 InfinityFree，它的浏览器安全系统会拦掉所有非浏览器
   请求（日历 App 抓取订阅源会拿到挑战页），所以 webcal 订阅在这台
   主机上不可用。改成生成 .ics 文件让用户导入一次，
   导入后事件就在系统日历里，提醒由日历自己负责 —— 更可靠。

   导入后每条事件自带 4 个提醒：提前 7 天 / 3 天 / 1 天 / 当天上午 9 点。

   实现要点（RFC 5545）：
   - UTF-8、无 BOM、行分隔必须 CRLF；
   - 单行 ≤ 75 octets，超出用「CRLF + 空格」折叠，且不能切断多字节字符；
   - 全天事件用 DTSTART;VALUE=DATE（彻底绕开时区），DTEND 为次日；
   - 农历生日 / 2 月 29 日：各客户端对 RRULE 的处理不一致，
     直接生成未来 N 年的离散事件最稳；
   - 文本里的 \ ; , 换行必须转义。

   本文件里的纯函数挂在 window.LoveIcs 上，方便 Node 单测直接调用。
   ============================================================ */

(function () {
  "use strict";

  var YEARS_AHEAD = 10;   // 农历/闰日离散事件生成年数

  /* config.js 里是 `const CONFIG`（不会挂到 window 上），这里统一取一次 */
  function loveCfg() { return (typeof CONFIG !== "undefined") ? CONFIG : null; }

  /* ---------- 基础工具 ---------- */
  function pad2(n) { return String(n).padStart(2, "0"); }
  function fmtYmd(d) { return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function utcStamp(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }

  function escIcs(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n|\r|\n/g, "\\n");
  }

  function utf8Len(ch) {
    var c = ch.codePointAt ? ch.codePointAt(0) : ch.charCodeAt(0);
    if (c < 0x80) return 1;
    if (c < 0x800) return 2;
    if (c < 0x10000) return 3;
    return 4;
  }

  /** 折叠到 75 octets：第一行 75，续行前导空格占 1 字节故为 74 */
  function foldLine(line) {
    var out = [], cur = "", len = 0;
    for (var i = 0; i < line.length;) {
      var cp = line.codePointAt ? line.codePointAt(i) : line.charCodeAt(i);
      var ch = line.slice(i, i + (cp > 0xFFFF ? 2 : 1));
      var b = utf8Len(ch);
      var limit = out.length === 0 ? 75 : 74;
      if (len + b > limit) { out.push(cur); cur = ""; len = 0; }
      cur += ch; len += b; i += ch.length;
    }
    out.push(cur);
    return out.join("\r\n ");
  }

  function parseYmd(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || ""));
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, mo - 1, d);
    // 拒绝 2027-02-30 这类会被 JS 自动进位的日期
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  function parseMD(dateStr) {
    var p = String(dateStr || "").split("-").map(function (x) { return parseInt(x, 10); });
    var m, d;
    if (p.length === 3 && p[0] > 31) { m = p[1]; d = p[2]; }
    else if (p.length >= 2) { m = p[0]; d = p[1]; }
    if (!m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return [m, d];
  }
  function todayLocal() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  /* ---------- 农历换算（复用 lunar.js） ---------- */
  function lunarSolarFor(y, lm, ld, leap) {
    if (!window.Lunar) return null;
    var day = ld;
    if (window.Lunar.monthDays) {
      var md = window.Lunar.monthDays(y, lm, leap);
      if (md > 0) day = Math.min(ld, md);      // 该月只有 29 天时把"三十"夹到廿九
    }
    var s = window.Lunar.toSolar(y, lm, day, leap);
    return s ? new Date(s.year, s.month - 1, s.day) : null;
  }

  /** 农历条目 → 未来 N 年的公历日期数组 */
  function lunarOccurrences(item, today, years) {
    var out = [];
    if (!window.Lunar || !window.Lunar.toLunar) return out;
    var leap = false, ds = String(item.date || "");
    if (ds.charAt(0) === "闰") { leap = true; ds = ds.slice(1); }
    var parts = ds.split("-");
    var lm = parseInt(parts[0], 10), ld = parseInt(parts[1], 10);
    if (!lm || !ld) return out;

    var nowLunar = window.Lunar.toLunar(today.getFullYear(), today.getMonth() + 1, today.getDate());
    if (!nowLunar) return out;
    var from = nowLunar.year;
    /* 闰月很稀疏（同一个闰月可能隔 19~38 年才再出现一次），按 years 当上界扫会
       直接扫不到 —— 那种条目在 .ics 里静默消失（"加入日历"提示算不出来）。
       给闰月留足搜索窗口；普通农历月第一年就能凑够 years 个，不受影响。 */
    var span = leap ? 60 : years + 1;
    for (var y = from; y <= from + span; y++) {
      if (leap && window.Lunar.leapMonth && window.Lunar.leapMonth(y) !== lm) continue;
      var d = lunarSolarFor(y, lm, ld, leap);
      if (d && d >= today && out.length < years) out.push(d);
      if (out.length >= years) break;
    }
    return out;
  }

  /**
   * 某个纪念日要导出的事件列表
   * → [{ date: Date, repeat: bool }]
   */
  function occurrences(item, today, years) {
    today = today || todayLocal();
    years = years || YEARS_AHEAD;
    var out = [];
    if (!item) return out;

    if (item.type === "once") {
      var once = parseYmd(item.date);
      if (once) out.push({ date: once, repeat: false });
      return out;
    }

    if (item.lunar) {
      lunarOccurrences(item, today, years).forEach(function (d) {
        out.push({ date: d, repeat: false });
      });
      return out;
    }

    var md = parseMD(item.date);
    if (!md) return out;

    // 2 月 29 日：RRULE 在平年被各客户端处理得不一致 → 离散
    if (md[0] === 2 && md[1] === 29) {
      for (var y = today.getFullYear(); y < today.getFullYear() + years; y++) {
        var cand = new Date(y, 1, 29);
        if (cand.getMonth() === 1 && cand >= today) out.push({ date: cand, repeat: false });
      }
      return out;
    }

    var start = new Date(today.getFullYear(), md[0] - 1, md[1]);
    if (start < today) start = new Date(today.getFullYear() + 1, md[0] - 1, md[1]);
    out.push({ date: start, repeat: true, month: md[0], day: md[1] });
    return out;
  }

  /* ---------- ICS 组装 ---------- */
  function alarmLines(title, trigger, when) {
    return [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:" + escIcs(title + " " + when),
      "TRIGGER:" + trigger,
      "END:VALARM",
    ];
  }

  function eventLines(item, occ, uidSeed, stamp, names) {
    var title = String(item.title || "纪念日");
    var desc = title;
    if (names && (names.boy || names.girl)) desc += " · " + (names.boy || "") + " ♥ " + (names.girl || "");
    if (item.lunar) desc += "（农历）";

    var lines = [
      "BEGIN:VEVENT",
      "UID:anniv-" + uidSeed + "-" + fmtYmd(occ.date) + "@love.local",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + fmtYmd(occ.date),
      "DTEND;VALUE=DATE:" + fmtYmd(addDays(occ.date, 1)),
      "SUMMARY:" + escIcs(title),
      "DESCRIPTION:" + escIcs(desc),
      "TRANSP:TRANSPARENT",
      "STATUS:CONFIRMED",
      "SEQUENCE:0",
    ];
    if (occ.repeat) {
      lines.push("RRULE:FREQ=YEARLY;BYMONTH=" + occ.month + ";BYMONTHDAY=" + occ.day);
    }
    lines = lines.concat(alarmLines(title, "-P7D", "还有 7 天"));
    lines = lines.concat(alarmLines(title, "-P3D", "还有 3 天"));
    lines = lines.concat(alarmLines(title, "-P1D", "就是明天"));
    lines = lines.concat(alarmLines(title, "PT9H", "就是今天"));
    lines.push("END:VEVENT");
    return lines;
  }

  function uidSeedOf(item, idx) {
    var s = String(item.title || "anniv").replace(/[^A-Za-z0-9]/g, "");
    if (!s) s = "anniv";
    return s.slice(0, 20).toLowerCase() + "-" + idx;
  }

  /**
   * 生成整份 .ics
   * @param items CONFIG.anniversaries
   * @param opts  {calName, names, today, years}
   */
  function build(items, opts) {
    opts = opts || {};
    var today = opts.today || todayLocal();
    var years = opts.years || YEARS_AHEAD;
    var stamp = utcStamp(new Date());
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//love//anniversaries//CN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + escIcs(opts.calName || "我们的纪念日"),
      "X-WR-TIMEZONE:Asia/Shanghai",
    ];
    var count = 0;
    (items || []).forEach(function (item, i) {
      occurrences(item, today, years).forEach(function (occ) {
        lines = lines.concat(eventLines(item, occ, uidSeedOf(item, i), stamp, opts.names));
        count++;
      });
    });
    lines.push("END:VCALENDAR");
    return { text: lines.map(foldLine).join("\r\n") + "\r\n", events: count };
  }

  /** 单个纪念日 → .ics */
  function buildOne(item, opts) {
    opts = opts || {};
    return build([item], opts);
  }

  /* ---------- 下载 ---------- */
  function saveText(filename, text) {
    try {
      var blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      var host = document.body || document.documentElement;
      if (host && host.appendChild) host.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function fileName(one) {
    var base = one ? String(one.title || "纪念日") : "我们的纪念日";
    base = base.replace(/[\\/:*?"<>|]/g, "").slice(0, 20);
    return base + "-" + fmtYmd(new Date()) + ".ics";
  }

  window.LoveIcs = {
    build: build,
    buildOne: buildOne,
    occurrences: occurrences,
    lunarOccurrences: lunarOccurrences,
    foldLine: foldLine,
    escIcs: escIcs,
    fmtYmd: fmtYmd,
    parseMD: parseMD,
    parseYmd: parseYmd,
    saveText: saveText,
    fileName: fileName,
    YEARS_AHEAD: YEARS_AHEAD,
  };

  /* ---------- 页面接线（只有纪念日页有 #annivGrid） ---------- */
  var grid = document.getElementById("annivGrid");
  var allBtn = document.getElementById("icsAllBtn");
  var guideBtn = document.getElementById("icsGuideBtn");
  var guide = document.getElementById("icsGuide");
  if (!grid && !allBtn) return;

  function toast(msg) { if (window.toast) window.toast(msg); }

  function opts() {
    var c = loveCfg() || {};
    return {
      calName: "我们的纪念日",
      names: c.names,
    };
  }

  function exportAll() {
    var items = ((loveCfg() || {}).anniversaries) || [];
    if (!items.length) { toast("还没有纪念日，先去后台加一条吧"); return; }
    var r = build(items, opts());
    if (!r.events) { toast("这些日子暂时算不出可导入的日期"); return; }
    if (saveText(fileName(null), r.text)) toast("已生成 " + r.events + " 个日历事件，打开文件即可导入 📅");
    else toast("这台设备不支持直接下载，请换个浏览器试试");
  }

  function exportOne(i) {
    var items = ((loveCfg() || {}).anniversaries) || [];
    var item = items[i];
    if (!item) return;
    var r = buildOne(item, opts());
    if (!r.events) { toast("这个日子暂时算不出可导入的日期"); return; }
    if (saveText(fileName(item), r.text)) toast("已生成「" + (item.title || "纪念日") + "」的日历事件 📅");
    else toast("这台设备不支持直接下载，请换个浏览器试试");
  }

  if (allBtn) allBtn.addEventListener("click", exportAll);

  if (grid) {
    grid.addEventListener("click", function (e) {
      var el = e.target;
      while (el && el !== grid) {
        if (el.getAttribute && el.getAttribute("data-anniv-add") !== null) {
          exportOne(parseInt(el.getAttribute("data-anniv-add"), 10));
          return;
        }
        el = el.parentNode;
      }
    });
  }

  if (guideBtn && guide) {
    guideBtn.addEventListener("click", function () { guide.classList.add("open"); });
    guide.addEventListener("click", function (e) {
      if (e.target === guide || (e.target.getAttribute && e.target.getAttribute("data-close") !== null)) {
        guide.classList.remove("open");
      }
    });
  }
})();
