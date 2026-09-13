/* ============================================================
   情侣网站 · 纪念卡（一键生成竖版卡片图片）
   ------------------------------------------------------------
   参考 funnyzak/love-page 的「一键生成竖版纪念卡」。
   为什么做这个：本站在 InfinityFree 上，社交平台爬虫会被安全系统
   403 拦掉，链接分享预览（OG 图）用不了 —— 那就自己生成一张图，
   保存下来发微信 / 发朋友圈都行。

   纯 Canvas 2D，无第三方库。窗口比例 1080×1620（2:3，竖版）。
   window.LoveCard.model() 是纯函数，Node 单测直接调用。
   ============================================================ */

(function () {
  "use strict";

  var W = 1080, H = 1620;

  /* config.js 里是 `const CONFIG`（不会挂到 window 上） */
  function loveCfg() { return (typeof CONFIG !== "undefined") ? CONFIG : null; }

  /* ---------- 纯数据模型 ---------- */
  function pad2(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function dayIndex(d) { return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); }

  /** 下一个即将到来的纪念日（复用 calendar.js 的 occurrences；没有则回退"在一起周年"） */
  function nextAnniversary(cfg, today) {
    var items = (cfg && cfg.anniversaries) || [];
    var best = null;
    items.forEach(function (item) {
      var occ = [];
      if (window.LoveIcs && window.LoveIcs.occurrences) {
        occ = window.LoveIcs.occurrences(item, today, 2);
      } else {
        var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(item.date || ""));
        if (m) { var d = new Date(+m[1], +m[2] - 1, +m[3]); if (d >= today) occ = [{ date: d }]; }
      }
      occ.forEach(function (o) {
        if (!o || !o.date) return;
        /* 只认"还没到的"日期。occurrences() 对一次性的纪念日会连过去的日期一起
           返回（.ics 导出要用它把历史事件也写进日历），这里若不过滤，取最小值
           必然选中已经过去的那条 —— 默认配置下卡片会长期印着
           "相恋100天 · 还有 0 天 · 2023-08-28"。过滤放在本函数而不是
           occurrences() 里，是为了不把日历导出改坏。 */
        if (o.date < today) return;
        if (!best || o.date < best.date) best = { date: o.date, title: item.title || "纪念日", icon: item.icon || "🎉" };
      });
    });
    if (!best) {
      var start = cfg && cfg.startDate ? new Date(cfg.startDate + "T00:00:00") : null;
      if (start && !isNaN(start)) {
        var y = new Date(today.getFullYear(), start.getMonth(), start.getDate());
        if (y < today) y = new Date(today.getFullYear() + 1, start.getMonth(), start.getDate());
        best = { date: y, title: "在一起周年", icon: "💞" };
      }
    }
    if (!best) return null;
    return {
      icon: best.icon,
      title: best.title,
      dateText: ymd(best.date),
      days: Math.max(0, Math.round((best.date - today) / 86400000)),
    };
  }

  /**
   * 卡片内容模型（纯函数）
   * @param cfg window.CONFIG
   * @param now 当前时间（可注入，便于测试）
   */
  function model(cfg, now) {
    cfg = cfg || {};
    now = now || new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    var start = cfg.startDate ? new Date(cfg.startDate + "T00:00:00") : null;
    var validStart = start && !isNaN(start.getTime());
    var days = validStart ? Math.max(0, Math.floor((today - new Date(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000)) : null;

    var msgs = (cfg.messages || []).filter(function (m) { return m && String(m).trim(); });
    var quote = msgs.length ? String(msgs[dayIndex(today) % msgs.length]) : "";

    var names = cfg.names || {};
    return {
      boy: String(names.boy || "我"),
      girl: String(names.girl || "你"),
      slogan: String(cfg.slogan || ""),
      startText: validStart ? ymd(start) : "",
      days: days,
      daysText: days === null ? "" : String(days),
      quote: quote,
      next: nextAnniversary(cfg, today),
      dateText: ymd(today),
      brand: "我们的家",
    };
  }

  /* ---------- Canvas 绘制 ---------- */
  function wrapText(ctx, text, maxWidth) {
    var out = [], line = "";
    var chars = String(text || "").split("");
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line !== "") {
        out.push(line); line = chars[i];
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
    return out;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function heartPath(ctx, cx, cy, size) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + size * 0.75);
    ctx.bezierCurveTo(cx - size * 1.6, cy - size * 0.5, cx - size * 0.4, cy - size * 1.5, cx, cy - size * 0.45);
    ctx.bezierCurveTo(cx + size * 0.4, cy - size * 1.5, cx + size * 1.6, cy - size * 0.5, cx, cy + size * 0.75);
    ctx.closePath();
  }

  function draw(canvas, m) {
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';

    // 底色渐变
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#fff8fb");
    g.addColorStop(0.55, "#ffeef5");
    g.addColorStop(1, "#ffe1ec");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // 两个柔光
    function glow(x, y, r, color) {
      var rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color); rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    glow(120, 180, 520, "rgba(255,190,214,0.75)");
    glow(980, 1320, 560, "rgba(255,214,231,0.7)");

    // 装饰爱心
    ctx.fillStyle = "rgba(240,98,146,0.16)";
    [[140, 1380, 26], [900, 300, 20], [820, 1480, 16], [220, 340, 14]].forEach(function (h) {
      heartPath(ctx, h[0], h[1], h[2]); ctx.fill();
    });

    // 顶部小爱心
    ctx.fillStyle = "#f06292";
    heartPath(ctx, W / 2, 150, 26); ctx.fill();

    ctx.textAlign = "center";

    // 名字
    ctx.fillStyle = "#5c4150";
    ctx.font = "600 54px " + FONT;
    ctx.fillText(m.boy + "  ♥  " + m.girl, W / 2, 250);

    // 天数
    if (m.days !== null) {
      ctx.fillStyle = "#d81b60";
      ctx.font = "700 210px " + FONT;
      ctx.fillText(m.daysText, W / 2, 540);
      ctx.fillStyle = "#9a7b8a";
      ctx.font = "500 44px " + FONT;
      ctx.fillText("在 一 起 的 第  天", W / 2, 620);
      ctx.fillStyle = "#f06292";
      ctx.font = "400 34px " + FONT;
      ctx.fillText("从 " + m.startText + " 开始", W / 2, 686);
    } else {
      ctx.fillStyle = "#9a7b8a";
      ctx.font = "500 44px " + FONT;
      ctx.fillText("我们的故事", W / 2, 520);
    }

    // 标语
    if (m.slogan) {
      ctx.fillStyle = "#5c4150";
      ctx.font = "400 40px " + FONT;
      var sl = wrapText(ctx, m.slogan, 820).slice(0, 2);
      sl.forEach(function (line, i) { ctx.fillText(line, W / 2, 800 + i * 60); });
    }

    // 情话卡片
    if (m.quote) {
      var cardY = 960, cardH = 300;
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      roundRect(ctx, 90, cardY, W - 180, cardH, 44); ctx.fill();
      ctx.strokeStyle = "rgba(240,98,146,0.25)"; ctx.lineWidth = 2; ctx.stroke();

      ctx.fillStyle = "#9a7b8a";
      ctx.font = "400 30px " + FONT;
      ctx.fillText("今日情话", W / 2, cardY + 70);

      ctx.fillStyle = "#5c4150";
      ctx.font = "400 42px " + FONT;
      var q = wrapText(ctx, m.quote, W - 260).slice(0, 3);
      q.forEach(function (line, i) { ctx.fillText(line, W / 2, cardY + 150 + i * 62); });
    }

    // 下一个纪念日
    if (m.next) {
      ctx.fillStyle = "#d81b60";
      ctx.font = "500 40px " + FONT;
      ctx.fillText(m.next.icon + " " + m.next.title, W / 2, 1400);
      ctx.fillStyle = "#9a7b8a";
      ctx.font = "400 34px " + FONT;
      ctx.fillText("还有 " + m.next.days + " 天 · " + m.next.dateText, W / 2, 1456);
    }

    // 底部
    ctx.fillStyle = "#c9a8b6";
    ctx.font = "400 28px " + FONT;
    ctx.fillText(m.brand + " · " + m.dateText, W / 2, 1540);
  }

  /** 生成 PNG dataURL */
  function renderToDataUrl(m) {
    var canvas = document.createElement("canvas");
    draw(canvas, m);
    return canvas.toDataURL("image/png");
  }

  function fileName(m) {
    return "我们的纪念卡-" + String(m.dateText).replace(/-/g, "") + ".png";
  }

  /** 保存为文件（返回 Promise<bool>） */
  function save(m) {
    return new Promise(function (resolve) {
      var canvas = document.createElement("canvas");
      draw(canvas, m);
      var name = fileName(m);
      if (!canvas.toBlob) {
        try {
          var a = document.createElement("a");
          a.href = canvas.toDataURL("image/png"); a.download = name;
          (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
          resolve(true);
        } catch (e) { resolve(false); }
        return;
      }
      canvas.toBlob(function (blob) {
        if (!blob) { resolve(false); return; }
        try {
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url; a.download = name;
          (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          resolve(true);
        } catch (e) { resolve(false); }
      }, "image/png");
    });
  }

  window.LoveCard = { model: model, draw: draw, renderToDataUrl: renderToDataUrl, save: save, fileName: fileName, W: W, H: H };

  /* ---------- 页面接线（只有首页有 #cardBtn） ---------- */
  var btn = document.getElementById("cardBtn");
  if (!btn) return;

  var modal = document.getElementById("cardModal");
  var img = document.getElementById("cardImg");
  var saveBtn = document.getElementById("cardSaveBtn");
  var shareBtn = document.getElementById("cardShareBtn");
  var lastModel = null;

  function toast(msg) { if (window.toast) window.toast(msg); }

  function close() { if (modal) modal.classList.remove("open"); }

  function open() {
    var cfg = loveCfg();
    if (!cfg) return;
    lastModel = model(cfg, new Date());
    var url;
    try { url = renderToDataUrl(lastModel); } catch (e) { toast("这台设备生成不了图片，换个浏览器试试"); return; }
    if (img) img.src = url;
    if (shareBtn) shareBtn.style.display = (navigator.share ? "" : "none");
    if (modal) modal.classList.add("open");
  }

  btn.addEventListener("click", open);

  if (saveBtn) saveBtn.addEventListener("click", function () {
    if (!lastModel) return;
    /* draw() 在 canvas 不可用的环境会抛异常 → save 的 Promise reject；
       不接住的话用户点了"保存"没有任何反馈（open() 路径有 try/catch，
       这条路径原来没有）。 */
    save(lastModel)
      .then(function (ok) { toast(ok ? "已保存到相册/下载 📷" : "保存失败，试试长按图片保存"); })
      .catch(function () { toast("这台设备生成不了图片，换个浏览器试试"); });
  });

  if (shareBtn) shareBtn.addEventListener("click", function () {
    if (!lastModel) return;
    var canvas = document.createElement("canvas");
    try { draw(canvas, lastModel); } catch (e) { toast("这台设备生成不了图片，换个浏览器试试"); return; }
    var name = fileName(lastModel);
    if (!canvas.toBlob || !window.File) { save(lastModel).catch(function () { toast("这台设备生成不了图片，换个浏览器试试"); }); return; }
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], name, { type: "image/png" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) { save(lastModel); return; }
      navigator.share({ files: [file], title: "我们的纪念卡" }).catch(function () { /* 用户取消 */ });
    }, "image/png");
  });

  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal || (e.target.getAttribute && e.target.getAttribute("data-close") !== null)) close();
    });
  }
})();
