/* ============================================================
   情侣网站 · 成就墙 / 关系看板
   ------------------------------------------------------------
   参考 GitHub 上开源情侣项目的两个长处（只借鉴玩法，不复制代码）：
     · ivanusto/couple-achievement-list（MIT）：100 项关系成就 + 等级称号 +
       原生 Canvas 雷达图 + 一键分享成就卡（800×1200）
     · 404-creator/love-time：按"参与度"解锁内容，而不是只按日期解锁

   本页与它们的区别（也是这个站点的规矩）：
   1. **不新增任何采集**：所有进度都从你们已经产生的数据里推导 —— 在一起天数、
      相册、留言、情书、时间胶囊、时光轴、纪念日、问答最高分、默契度历史。
      没有埋点、没有统计上报，离线也算得出来。
   2. **纯函数 + 无依赖**：推导逻辑挂在 window.LoveAchievements 上，Node 里
      直接调用即可单测（见 tools/_test_achievements.js）。
   3. **服务器不可用时如实降级**：纯静态托管只有本机数据，页面会明说哪些进度
      记不到（默契度、每日一问的一部分），而不是假装 0。

   分享长图 1080×1920（微信朋友圈竖图比例），纯 Canvas 2D，无第三方库。
   ============================================================ */

(function () {
  "use strict";

  /* 与 assets/js/sharecard.js 同一套写法（字体回退、圆角、渐变），
     不抽公共模块是为了让每个页面按需加载，避免首页多背一份用不到的代码。 */
  /* 切页时本页脚本会被**重新执行**，而全局监听与定时器不随视图内容一起消失
     —— 一律登记给生命周期统一清理，否则一次一页地累积。
     非挂载期（直接打开本页）它退化成原生调用，行为不变。 */
  const LC = window.LoveLifecycle || { on: (t, y, f, o) => t.addEventListener(y, f, o), every: (f, m) => setInterval(f, m), after: (f, m) => setTimeout(f, m), clear: (i) => { clearInterval(i); clearTimeout(i); } };

  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';
  var CARD_W = 1080, CARD_H = 1920;

  var DOMAINS = [
    { id: "time",    name: "时光累积", icon: "⏳" },
    { id: "romance", name: "日常浪漫", icon: "💌" },
    { id: "heart",   name: "心意相通", icon: "💞" },
    { id: "memory",  name: "足迹影像", icon: "📸" },
    { id: "play",    name: "玩乐默契", icon: "🎮" }
  ];

  /* 等级：每 8 个成就 1 级。最高一级要集满全部成就才算到（见 levelOf）。 */
  var LEVELS = [
    { at: 0,  icon: "🥚", title: "初坠爱河" },
    { at: 8,  icon: "💗", title: "热恋情侣" },
    { at: 16, icon: "💞", title: "心意相通" },
    { at: 24, icon: "🔒", title: "信任港湾" },
    { at: 32, icon: "🎇", title: "灵魂伴侣" },
    { at: 40, icon: "💍", title: "誓言相伴" },
    { at: 48, icon: "♾️", title: "永恒誓言大宗师" }
  ];

  /* ---------- 推导用的小工具（对畸形数据必须免疫：进度算错只是少解锁一条，
                  抛异常会让整页白屏） ---------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return v === null || v === undefined ? "" : String(v); }

  function readLS(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function lsLen(key) { return arr(readLS(key)).length; }

  function ymd(d) {
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /* ============================================================
     一、从现有数据推导"事实"（facts）
     每一项都是页面里已经存在的数字，不新采集任何东西。
     ============================================================ */
  function buildFacts(cfg, opts) {
    cfg = cfg || {};
    opts = opts || {};
    var now = opts.now || new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    /* ---- 在一起天数（与 countdown.js 同口径：只按日期算，负值夹 0） ---- */
    var start = cfg.startDate ? new Date(str(cfg.startDate) + "T00:00:00") : null;
    var days = 0;
    if (start && !isNaN(start.getTime())) {
      var s0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      days = Math.max(0, Math.floor((today - s0) / 86400000));
    }

    /* ---- 内容：服务器注入优先（跨设备共享的那份），否则用本机兜底 ---- */
    var serverContent = opts.serverContent !== undefined ? opts.serverContent : window.__SERVER_CONTENT__;
    var hasServer = !!(serverContent && typeof serverContent === "object");
    var sc = hasServer ? serverContent : {};

    var myPhotos = hasServer ? arr(sc.photos).length : lsLen("love-photos");
    var myLetters = hasServer ? arr(sc.letters).length : lsLen("love-letters-extra");
    var messages = hasServer ? arr(sc.messages).length : lsLen("love-messages");
    var capsulesAll = hasServer ? arr(sc.capsules) : arr(readLS("love-capsules"));

    /* 胶囊：已到期=可以读了；"寄往一年后"=开启日距封存日 ≥365 天 */
    var capsules = capsulesAll.length;
    var capsulesOpened = 0, capsuleFar = 0;
    capsulesAll.forEach(function (c) {
      if (!c || typeof c !== "object") return;
      var openAt = str(c.openAt);
      if (c.locked === false || (openAt && openAt <= ymd(today))) capsulesOpened++;
      if (openAt) {
        var d = new Date(openAt + "T00:00:00");
        if (!isNaN(d.getTime()) && Math.round((d - today) / 86400000) >= 365) capsuleFar++;
      }
    });

    /* ---- 站点里"看得见"的内容（配置里已有的，算总盘子） ---- */
    var gallery = arr(cfg.gallery).filter(function (p) { return p && p.src; });
    var photos = gallery.length + myPhotos;
    var cats = {};
    gallery.forEach(function (p) { if (p.cat) cats[str(p.cat)] = 1; });
    if (myPhotos > 0) cats["照片"] = 1;
    var photoCats = Object.keys(cats).length;

    var seedLetters = arr(cfg.letters).filter(function (l) { return l && (l.title || l.body); });
    var letters = seedLetters.length + myLetters;
    var timeline = arr(cfg.timeline).filter(function (t) { return t && (t.title || t.text); });
    var timelineFuture = 0;
    timeline.forEach(function (t) {
      var d = str(t.date);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > ymd(today)) timelineFuture++;
    });
    var annivs = arr(cfg.anniversaries).filter(function (a) { return a && a.date; });
    var hasLunar = annivs.some(function (a) { return !!a.lunar; });
    var wishes = arr(cfg.wishes).filter(function (w) { return w && (w.title || w.text); }).length;

    /* ---- 小游戏：默契问答最高分（本机记的） ---- */
    var best = readLS("love-quiz-best");
    var quizBest = 0, quizTotal = 0;
    if (best && typeof best === "object") {
      quizBest = num(best.s); quizTotal = num(best.t);
    } else if (best !== null && best !== undefined) {
      quizBest = num(best);            // 旧格式：只存了答对数
    }
    /* 「玩过一局」与"最高分"是两件事（第四轮 F-S8-3）：首轮 0 分时 `score > best.s` 不成立，
       game.js 旧实现**什么都不落盘** —— 本机连痕迹都没有，「玩一局默契问答」就永远解不开。
       game.js 现在无条件写一个 love-quiz-played 标记；旧数据没有这个标记时，
       用 quizBest>0 兜底（答对过至少一题 ⇒ 一定玩过）。 */
    var quizPlayed = (readLS("love-quiz-played") ? 1 : 0)
                     || ((quizTotal > 0 || quizBest > 0) ? 1 : 0);

    /* ---- 默契度测试：服务器有历史（含百分比），本机模式只能知道"做过一轮" ---- */
    var serverCompat = opts.serverCompat !== undefined ? opts.serverCompat : window.__SERVER_COMPAT__;
    var compatDone = 0, compatBestPct = 0;
    if (serverCompat && typeof serverCompat === "object") {
      arr(serverCompat.history).forEach(function (h) {
        if (!h || typeof h !== "object") return;
        compatDone++;
        compatBestPct = Math.max(compatBestPct, num(h.pct));
      });
    } else {
      var lc = readLS("love-compat");
      if (lc && typeof lc === "object" && arr(lc.a).length && arr(lc.b).length) {
        compatDone = 1;                // 本机模式不保存历史，只算"测过一次"
      }
    }

    /* ---- 每日一问：本机作答日记（服务器模式下也记一笔，见 daily.js） ---- */
    /* 必须按**日期去重**再计数：日报本来就做了幂等，但手工改过/迁移来的数据
       可能带重复日期，直接取 length 会把同一天算两次（进度显示会虚高）。 */
    var dailyLog = arr(readLS("love-daily-log"));
    var localDaily = readLS("love-daily");
    var seenDay = {};
    var dailyDays = 0;
    dailyLog.forEach(function (d) {
      d = str(d);
      if (d && !seenDay[d]) { seenDay[d] = 1; dailyDays++; }
    });
    if (localDaily && typeof localDaily === "object") {
      Object.keys(localDaily).forEach(function (d) {
        if (d && !seenDay[d]) { seenDay[d] = 1; dailyDays++; }   // 日记之前的老数据也要算上
      });
    }
    var serverDaily = opts.serverDaily !== undefined ? opts.serverDaily : window.__SERVER_DAILY__;
    var bothAnswered = 0;
    if (serverDaily && typeof serverDaily === "object" && serverDaily.mine && serverDaily.partnerAnswered) {
      bothAnswered = 1;
    }

    return {
      days: days,
      photos: photos, myPhotos: myPhotos, photoCats: photoCats,
      letters: letters, myLetters: myLetters,
      messages: messages, wishes: wishes,
      anniversaries: annivs.length, hasLunar: hasLunar ? 1 : 0,
      capsules: capsules, capsulesOpened: capsulesOpened, capsuleFar: capsuleFar,
      timeline: timeline.length, timelineFuture: timelineFuture,
      quizBest: quizBest, quizTotal: quizTotal, quizPlayed: quizPlayed,
      quizPerfect: (quizTotal > 0 && quizBest >= quizTotal) ? 1 : 0,
      compatDone: compatDone, compatBestPct: compatBestPct,
      dailyDays: dailyDays, bothAnswered: bothAnswered,
      serverContent: hasServer,
      serverCompat: !!(serverCompat && typeof serverCompat === "object"),
    };
  }

  /* ============================================================
     二、成就清单
     of(facts) 返回"当前进度"，达到 need 即解锁。
     阈值刻意压在常见节奏上：早期几条几天内就能拿到（有正反馈），
     1314 天、五个胶囊这种是长期钩子。
     ============================================================ */
  var A = function (id, icon, name, domain, need, hint, of) {
    return { id: id, icon: icon, name: name, domain: domain, need: need, hint: hint, of: of };
  };

  var ACHIEVEMENTS = [
    /* --- 时光累积 --- */
    A("t1",  "🌱", "故事开始", "time", 1, "在一起第 1 天", function (f) { return f.days; }),
    A("t2",  "📅", "一周", "time", 7, "在一起满 7 天", function (f) { return f.days; }),
    A("t3",  "🌕", "满月", "time", 30, "在一起满 30 天", function (f) { return f.days; }),
    A("t4",  "💯", "百日", "time", 100, "在一起满 100 天", function (f) { return f.days; }),
    A("t5",  "🎂", "一周年", "time", 365, "在一起满 365 天", function (f) { return f.days; }),
    A("t6",  "💗", "520 天", "time", 520, "在一起满 520 天", function (f) { return f.days; }),
    A("t7",  "🌟", "999 天", "time", 999, "在一起满 999 天", function (f) { return f.days; }),
    A("t8",  "🏅", "1000 天", "time", 1000, "在一起满 1000 天", function (f) { return f.days; }),
    A("t9",  "🌹", "三周年", "time", 1095, "在一起满 3 年", function (f) { return f.days; }),
    A("t10", "💞", "1314 天", "time", 1314, "在一起满 1314 天", function (f) { return f.days; }),
    A("t11", "👑", "五周年", "time", 1826, "在一起满 5 年", function (f) { return f.days; }),

    /* --- 日常浪漫 --- */
    A("r1",  "📮", "第一句悄悄话", "romance", 1, "在留言板写过话", function (f) { return f.messages; }),
    A("r2",  "💬", "十句悄悄话", "romance", 10, "留言板累计 10 条", function (f) { return f.messages; }),
    A("r3",  "🗣️", "五十句悄悄话", "romance", 50, "留言板累计 50 条", function (f) { return f.messages; }),
    A("r4",  "✍️", "第一封手写情书", "romance", 1, "网页里写过一封情书", function (f) { return f.myLetters; }),
    A("r5",  "💌", "五封情书", "romance", 5, "情书累计 5 封", function (f) { return f.letters; }),
    A("r6",  "📜", "十封情书", "romance", 10, "情书累计 10 封", function (f) { return f.letters; }),
    A("r7",  "📚", "二十封情书", "romance", 20, "情书累计 20 封", function (f) { return f.letters; }),
    A("r8",  "🎉", "第一个纪念日", "romance", 1, "挂起了 1 个纪念日", function (f) { return f.anniversaries; }),
    A("r9",  "🎊", "五个纪念日", "romance", 5, "挂起了 5 个纪念日", function (f) { return f.anniversaries; }),
    A("r10", "🌙", "记得你的农历生日", "romance", 1, "有农历生日纪念日", function (f) { return f.hasLunar; }),
    A("r11", "🏺", "许愿瓶", "romance", 1, "写下一个心愿", function (f) { return f.wishes; }),
    A("r12", "🧞", "五个心愿", "romance", 5, "写下 5 个心愿", function (f) { return f.wishes; }),

    /* --- 心意相通 --- */
    A("h1",  "⏳", "第一封时间胶囊", "heart", 1, "封存了一封给未来的信", function (f) { return f.capsules; }),
    A("h2",  "🗄️", "五个胶囊", "heart", 5, "封存 5 封给未来的信", function (f) { return f.capsules; }),
    A("h3",  "🔓", "打开过去的信", "heart", 1, "有一封胶囊到期打开了", function (f) { return f.capsulesOpened; }),
    A("h4",  "🕰️", "寄往一年后", "heart", 1, "封存到 ≥1 年后的胶囊", function (f) { return f.capsuleFar; }),
    A("h5",  "❓", "第一次每日一问", "heart", 1, "回答过每日一问", function (f) { return f.dailyDays; }),
    A("h6",  "🔤", "每日一问 · 一周", "heart", 7, "累计回答 7 天", function (f) { return f.dailyDays; }),
    A("h7",  "📖", "每日一问 · 一月", "heart", 30, "累计回答 30 天", function (f) { return f.dailyDays; }),
    A("h8",  "🤝", "同一天都答了", "heart", 1, "今天两个人都答了每日一问", function (f) { return f.bothAnswered; }),

    /* --- 足迹影像 --- */
    A("m1",  "📷", "第一张自己拍的照片", "memory", 1, "网页里上传过照片", function (f) { return f.myPhotos; }),
    A("m2",  "🖼️", "十张照片", "memory", 10, "相册累计 10 张", function (f) { return f.photos; }),
    A("m3",  "🎞️", "三十张照片", "memory", 30, "相册累计 30 张", function (f) { return f.photos; }),
    A("m4",  "🌈", "五十张照片", "memory", 50, "相册累计 50 张", function (f) { return f.photos; }),
    A("m5",  "🏛️", "一百张照片", "memory", 100, "相册累计 100 张", function (f) { return f.photos; }),
    A("m6",  "🗂️", "足迹分类", "memory", 3, "相册有 3 个分类", function (f) { return f.photoCats; }),
    A("m7",  "🕰️", "第一条时光轴", "memory", 1, "记下第一件大事", function (f) { return f.timeline; }),
    A("m8",  "📖", "十条时光轴", "memory", 10, "记下 10 件大事", function (f) { return f.timeline; }),
    A("m9",  "🗺️", "二十条时光轴", "memory", 20, "记下 20 件大事", function (f) { return f.timeline; }),
    A("m10", "🔭", "写下一个未来计划", "memory", 1, "时光轴里有还没到的日子", function (f) { return f.timelineFuture; }),

    /* --- 玩乐默契 --- */
    A("p1",  "🎲", "玩一局默契问答", "play", 1, "玩过 quiz 小游戏", function (f) { return f.quizPlayed; }),
    A("p2",  "🎯", "答对八题", "play", 8, "默契问答答对 8 题", function (f) { return f.quizBest; }),
    A("p3",  "🏆", "问答满分", "play", 1, "默契问答全对", function (f) { return f.quizPerfect; }),
    A("p4",  "💞", "第一次默契度测试", "play", 1, "完成过 1 轮默契度测试", function (f) { return f.compatDone; }),
    A("p5",  "🔁", "五次默契度测试", "play", 5, "完成过 5 轮", function (f) { return f.compatDone; }),
    A("p6",  "🧠", "默契 80%", "play", 80, "单轮默契度到 80%", function (f) { return f.compatBestPct; }),
    A("p7",  "✨", "心有灵犀", "play", 100, "单轮默契度 100%", function (f) { return f.compatBestPct; })
  ];

  /* ============================================================
     三、纯函数：评估 / 等级 / 雷达
     ============================================================ */
  function evaluate(facts) {
    facts = facts || {};
    return ACHIEVEMENTS.map(function (a) {
      var cur = 0;
      try { cur = num(a.of(facts)); } catch (e) { cur = 0; }
      var need = a.need || 1;
      if (cur < 0) cur = 0;
      return {
        id: a.id, icon: a.icon, name: a.name, domain: a.domain,
        hint: a.hint, need: need, cur: Math.min(cur, need),
        raw: cur, unlocked: cur >= need
      };
    });
  }

  function unlockedCount(results) {
    return arr(results).filter(function (r) { return r && r.unlocked; }).length;
  }

  function levelOf(n) {
    n = num(n);
    var idx = 0;
    for (var i = 0; i < LEVELS.length; i++) if (n >= LEVELS[i].at) idx = i;
    var next = LEVELS[idx + 1] || null;
    return {
      index: idx + 1,
      icon: LEVELS[idx].icon,
      title: LEVELS[idx].title,
      next: next ? { at: next.at, need: next.at - n } : null,
      size: ACHIEVEMENTS.length
    };
  }

  /** 五个维度的完成度（0..1），供雷达图使用 */
  function radarOf(results) {
    return DOMAINS.map(function (d) {
      var list = arr(results).filter(function (r) { return r && r.domain === d.id; });
      var got = list.filter(function (r) { return r.unlocked; }).length;
      return {
        id: d.id, name: d.name, icon: d.icon,
        got: got, total: list.length,
        ratio: list.length ? got / list.length : 0
      };
    });
  }

  /* ---------- 卡片数据模型（纯函数，Node 单测直接调） ---------- */
  function model(cfg, facts, results, now) {
    cfg = cfg || {};
    results = arr(results);
    now = now || new Date();
    var names = cfg.names || {};
    var got = unlockedCount(results);
    var lv = levelOf(got);
    /* 已解锁的徽章：按**门槛高低**排序（越难拿的越靠前，卡片上才有分量）。
       显式排一次，不要依赖后面挑"最自豪"时那次 sort 的副作用 —— 那属于
       "改一行就静默变样"的写法。 */
    var harder = function (a, b) { return (b.need - a.need) || (b.raw - a.raw); };
    var unlocked = results.filter(function (r) { return r.unlocked; }).slice().sort(harder);
    /* "最自豪的一条" = 门槛最高的那条。不能比 raw/need：天数类成就的 raw 是原始
       天数，"故事开始"就是 1214/1 —— 会把最难的那条挤掉，卡片上写成
       「最骄傲的一件事：故事开始」，看着像没做完。一条都没解锁时退化为
       进度比例最高的那条（此时全部 < 1，比例排序是有意义的）。 */
    var proud = unlocked[0] || results.slice().sort(function (a, b) {
      return (b.raw / b.need) - (a.raw / a.need);
    })[0] || null;
    return {
      boy: str(names.boy || "我"),
      girl: str(names.girl || "你"),
      days: facts ? facts.days : 0,
      level: lv,
      got: got,
      total: results.length,
      radar: radarOf(results),
      unlocked: unlocked,
      proud: proud,
      slogan: str(cfg.slogan || ""),
      dateText: ymd(now),
      brand: "我们的家"
    };
  }

  /* ============================================================
     四、Canvas 绘制
     ============================================================ */
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

  function wrapText(ctx, text, maxWidth) {
    var out = [], line = "";
    /* 断行单位必须是**码点**而不是 UTF-16 码元：split("") 会把一个 emoji（代理对）
       劈成两个孤立半区，拼进行里量宽度时得到的是"豆腐块"、还可能从代理对中间断开。
       与 sharecard.js wrapText 同一口径（那边第五轮修过，这里是同族漏网的一处）。
       本站的名字/称号是用户可填的，emoji 很常见。 */
    var chars = Array.from(str(text));
    for (var i = 0; i < chars.length; i++) {
      var test = line + chars[i];
      if (ctx.measureText(test).width > maxWidth && line !== "") { out.push(line); line = chars[i]; }
      else { line = test; }
    }
    if (line) out.push(line);
    return out;
  }

  /** 雷达图（页面内嵌版与分享卡共用）。axes = radarOf() 的结果 */
  function drawRadar(ctx, cx, cy, radius, axes, opt) {
    opt = opt || {};
    var n = axes.length;
    if (!n) return;
    var ringColor = opt.ring || "rgba(240,98,146,0.28)";
    var fillColor = opt.fill || "rgba(240,98,146,0.28)";
    var lineColor = opt.line || "#f06292";
    var labelColor = opt.label || "#8a6b7a";
    var labelSize = opt.labelSize || 22;

    var pt = function (i, ratio) {
      var ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [cx + Math.cos(ang) * radius * ratio, cy + Math.sin(ang) * radius * ratio];
    };

    // 网格：内外各画几圈，便于肉眼比较
    ctx.lineWidth = 1;
    for (var ring = 1; ring <= 4; ring++) {
      var rr = ring / 4;
      ctx.strokeStyle = ringColor;
      ctx.beginPath();
      for (var k = 0; k < n; k++) {
        var p = pt(k, rr);
        k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.stroke();
    }
    // 轴线
    ctx.strokeStyle = ringColor;
    for (var a = 0; a < n; a++) {
      var e = pt(a, 1);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(e[0], e[1]); ctx.stroke();
    }
    // 数据多边形
    ctx.beginPath();
    axes.forEach(function (ax, i) {
      var p2 = pt(i, Math.max(0.04, num(ax.ratio)));   // 0 时留一丁点，形状不塌成一点
      i ? ctx.lineTo(p2[0], p2[1]) : ctx.moveTo(p2[0], p2[1]);
    });
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = opt.lineWidth || 3;
    ctx.stroke();
    // 顶点
    ctx.fillStyle = lineColor;
    axes.forEach(function (ax, i) {
      var p3 = pt(i, Math.max(0.04, num(ax.ratio)));
      ctx.beginPath(); ctx.arc(p3[0], p3[1], opt.dot || 5, 0, Math.PI * 2); ctx.fill();
    });
    // 维度标签
    if (opt.labels !== false) {
      ctx.fillStyle = labelColor;
      ctx.font = "500 " + labelSize + "px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      axes.forEach(function (ax, i) {
        var ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        var lx = cx + Math.cos(ang) * (radius + labelSize * 1.5);
        var ly = cy + Math.sin(ang) * (radius + labelSize * 1.5);
        ctx.fillText(ax.name + " " + Math.round(num(ax.ratio) * 100) + "%", lx, ly);
      });
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
    }
  }

  /** 分享长图：1080×1920 */
  function draw(canvas, m) {
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    var ctx = canvas.getContext("2d");

    var g = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    g.addColorStop(0, "#fff8fb");
    g.addColorStop(0.5, "#ffeef5");
    g.addColorStop(1, "#ffe0ec");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    function glow(x, y, r, color) {
      var rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, color);
      rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    glow(120, 260, 560, "rgba(255,190,214,0.7)");
    glow(980, 1560, 620, "rgba(255,214,231,0.65)");

    ctx.fillStyle = "rgba(240,98,146,0.14)";
    [[120, 1560, 26], [930, 420, 22], [860, 1700, 16], [200, 520, 14]].forEach(function (h) {
      heartPath(ctx, h[0], h[1], h[2]); ctx.fill();
    });

    ctx.textAlign = "center";
    ctx.fillStyle = "#f06292";
    heartPath(ctx, CARD_W / 2, 130, 26); ctx.fill();

    // 名字
    ctx.fillStyle = "#5c4150";
    ctx.font = "600 50px " + FONT;
    ctx.fillText(m.boy + "  ♥  " + m.girl, CARD_W / 2, 232);

    // 等级徽章
    ctx.fillStyle = "#d81b60";
    ctx.font = "700 46px " + FONT;
    ctx.fillText(m.level.icon + " 第 " + m.level.index + " 级 · " + m.level.title, CARD_W / 2, 330);
    ctx.fillStyle = "#9a7b8a";
    ctx.font = "400 34px " + FONT;
    ctx.fillText("已点亮 " + m.got + " / " + m.total + " 个成就", CARD_W / 2, 390);

    // 天数
    ctx.fillStyle = "#d81b60";
    ctx.font = "700 150px " + FONT;
    ctx.fillText(String(m.days), CARD_W / 2, 570);
    ctx.fillStyle = "#9a7b8a";
    ctx.font = "500 40px " + FONT;
    ctx.fillText("在 一 起 的 第  天", CARD_W / 2, 630);

    // 雷达图
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    roundRect(ctx, 80, 700, CARD_W - 160, 470, 44); ctx.fill();
    ctx.strokeStyle = "rgba(240,98,146,0.22)"; ctx.lineWidth = 2; ctx.stroke();
    drawRadar(ctx, CARD_W / 2, 935, 145, m.radar, { labelSize: 26, dot: 6 });

    // 徽章墙：已解锁的成就名（两列）
    ctx.fillStyle = "#9a7b8a";
    ctx.font = "500 32px " + FONT;
    ctx.fillText("点亮的成就", CARD_W / 2, 1240);

    ctx.textAlign = "left";
    var shown = m.unlocked.slice(0, 14);
    var colW = (CARD_W - 200) / 2;
    shown.forEach(function (a, i) {
      var col = i % 2, row = Math.floor(i / 2);
      var x = 120 + col * colW;
      var y = 1300 + row * 56;
      ctx.fillStyle = "#f06292";
      ctx.font = "400 30px " + FONT;
      ctx.fillText("✅", x, y);
      ctx.fillStyle = "#5c4150";
      ctx.font = "400 30px " + FONT;
      var name = a.icon + " " + a.name;
      var lines = wrapText(ctx, name, colW - 60);
      ctx.fillText(lines[0], x + 44, y);
    });
    if (m.unlocked.length > shown.length) {
      ctx.fillStyle = "#9a7b8a";
      ctx.font = "400 28px " + FONT;
      ctx.fillText("…还有 " + (m.unlocked.length - shown.length) + " 个", 120, 1300 + Math.ceil(shown.length / 2) * 56);
    }
    ctx.textAlign = "center";

    // 最自豪的一条
    if (m.proud) {
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      roundRect(ctx, 90, 1720, CARD_W - 180, 120, 36); ctx.fill();
      ctx.fillStyle = "#9a7b8a";
      ctx.font = "400 28px " + FONT;
      ctx.fillText("最骄傲的一件事", CARD_W / 2, 1762);
      ctx.fillStyle = "#d81b60";
      ctx.font = "600 38px " + FONT;
      ctx.fillText(m.proud.icon + " " + m.proud.name, CARD_W / 2, 1812);
    }

    // 底部
    ctx.fillStyle = "#c9a8b6";
    ctx.font = "400 26px " + FONT;
    ctx.fillText(m.brand + " · " + m.dateText, CARD_W / 2, 1885);
  }

  function renderToDataUrl(m) {
    var canvas = document.createElement("canvas");
    draw(canvas, m);
    return canvas.toDataURL("image/png");
  }

  function fileName(m) {
    return "我们的成就卡-" + str(m && m.dateText).replace(/-/g, "") + ".png";
  }

  /** 保存为文件（返回 Promise<bool>，与 sharecard.js 同契约） */
  function save(m) {
    return new Promise(function (resolve) {
      var canvas = document.createElement("canvas");
      draw(canvas, m);
      var name = fileName(m);
      if (!canvas.toBlob) {
        try {
          var a = document.createElement("a");
          a.href = canvas.toDataURL("image/png");
          a.download = name;
          (document.body || document.documentElement).appendChild(a);
          a.click(); a.remove();
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
          (document.body || document.documentElement).appendChild(a);
          a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          resolve(true);
        } catch (e) { resolve(false); }
      }, "image/png");
    });
  }

  window.LoveAchievements = {
    DOMAINS: DOMAINS, LEVELS: LEVELS, ACHIEVEMENTS: ACHIEVEMENTS,
    buildFacts: buildFacts, evaluate: evaluate, unlockedCount: unlockedCount,
    levelOf: levelOf, radarOf: radarOf, model: model,
    draw: draw, drawRadar: drawRadar, renderToDataUrl: renderToDataUrl,
    save: save, fileName: fileName, W: CARD_W, H: CARD_H
  };

  /* ============================================================
     五、页面接线（只有 achievements.html 有 #achLevel；其它页加载本文件只取纯函数）
     ============================================================ */
  var levelEl = document.getElementById("achLevel");
  if (!levelEl) return;

  function loveCfg() { return (typeof CONFIG !== "undefined") ? CONFIG : null; }
  function esc(s) { return window.escHtml ? window.escHtml(s) : str(s); }
  function toast(msg) { if (window.toast) window.toast(msg); }

  var facts = null, results = null, lastModel = null;
  /* 挂载时实时取到的一份数据（见文件末尾 loadLive）：拿不到就是 null，
     buildFacts 会退回注入快照 / 本机数据，口径与改造前一致。 */
  var liveOpts = null;

  function compute() {
    facts = buildFacts(loveCfg() || {}, liveOpts || {});
    results = evaluate(facts);
    return { facts: facts, results: results };
  }

  function render() {
    compute();
    var got = unlockedCount(results);
    var lv = levelOf(got);

    levelEl.innerHTML =
      '<div class="ach-level-icon">' + esc(lv.icon) + "</div>" +
      '<div class="ach-level-main">' +
        '<div class="ach-level-title">第 ' + lv.index + " 级 · " + esc(lv.title) + "</div>" +
        '<div class="ach-level-sub">已点亮 <b>' + got + "</b> / " + results.length + " 个成就" +
          (lv.next ? "　距离下一级还差 <b>" + lv.next.need + "</b> 个" : "　已经集满啦") +
        "</div>" +
        '<div class="ach-bar"><i style="width:' + Math.round(got / Math.max(1, results.length) * 100) + '%"></i></div>' +
      "</div>";

    var daysEl = document.getElementById("achDays");
    if (daysEl) daysEl.textContent = String(facts.days);

    // 雷达图：按 CSS 尺寸的 2 倍做后台缓冲，手机上不糊
    var cv = document.getElementById("achRadar");
    if (cv && cv.getContext) {
      var cssW = cv.clientWidth || 320;
      var cssH = Math.round(cssW * 0.78);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.style.height = cssH + "px";
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
      var ctx = cv.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        drawRadar(ctx, cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.3, radarOf(results),
                  { labelSize: Math.max(10, Math.round(cssW / 26)) });
      }
    }

    // 按维度分组列出
    var grid = document.getElementById("achGrid");
    if (grid) {
      grid.innerHTML = DOMAINS.map(function (d) {
        var list = results.filter(function (r) { return r.domain === d.id; });
        var on = list.filter(function (r) { return r.unlocked; }).length;
        return '<div class="ach-group glass reveal">' +
          '<h3 class="ach-group-title">' + esc(d.icon) + " " + esc(d.name) +
            '<span class="ach-group-count">' + on + " / " + list.length + "</span></h3>" +
          '<div class="ach-list">' +
            list.map(function (r) {
              return '<div class="ach-item' + (r.unlocked ? " on" : "") + '">' +
                '<span class="ach-item-icon">' + (r.unlocked ? esc(r.icon) : "🔒") + "</span>" +
                '<span class="ach-item-name">' + esc(r.name) + "</span>" +
                '<span class="ach-item-hint">' + (r.unlocked ? "已点亮" : esc(r.hint) +
                  "（" + r.cur + "/" + r.need + "）") + "</span>" +
              "</div>";
            }).join("") +
          "</div></div>";
      }).join("");
      if (window.revealNow) window.revealNow();
    }

    // 数据来源说明：纯静态托管下有些进度真的记不到，明说，别让人以为没解锁是 bug
    var note = document.getElementById("achNote");
    if (note) {
      var tips = [];
      if (!facts.serverContent) tips.push("现在用的是**本机**数据（服务器未启用）：换台设备打开，网页里加的留言/情书/照片不会算进来。");
      if (!facts.serverCompat) tips.push("默契度测试的历史需要服务器存储才会保留，本机模式只能记下“测过一次”。");
      tips.push("「每日一问」按本机作答日记统计（服务器模式下也会在本机记一笔，不上传）。");
      note.innerHTML = tips.map(function (t) {
        return "<li>" + esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + "</li>";
      }).join("");
    }
  }

  /* ---------- 分享卡弹窗 ---------- */
  var modal = document.getElementById("achModal");
  var img = document.getElementById("achImg");
  var shareBtn = document.getElementById("achShareBtn");
  var saveBtn = document.getElementById("achSaveBtn");
  var openBtn = document.getElementById("achCardBtn");
  var closeBtn = document.getElementById("achClose");

  function openCard() {
    if (!facts) compute();
    lastModel = model(loveCfg() || {}, facts, results, new Date());
    var url;
    try { url = renderToDataUrl(lastModel); }
    catch (e) { toast("这台设备生成不了图片，换个浏览器试试"); return; }
    if (img) img.src = url;
    if (shareBtn) shareBtn.style.display = (navigator.share ? "" : "none");
    if (modal) modal.classList.add("open");
  }
  function closeCard() { if (modal) modal.classList.remove("open"); }

  if (openBtn) openBtn.addEventListener("click", openCard);
  if (closeBtn) closeBtn.addEventListener("click", closeCard);
  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal || (e.target.getAttribute && e.target.getAttribute("data-close") !== null)) closeCard();
    });
  }

  if (saveBtn) saveBtn.addEventListener("click", function () {
    if (!lastModel) return;
    /* draw() 在 canvas 不可用的环境会抛异常 → 这个 Promise 会 reject；
       不接住的话点了"保存"没有任何反馈（sharecard.js 的同一处踩过） */
    save(lastModel)
      .then(function (ok) { toast(ok ? "已保存到相册/下载 📷" : "保存失败，试试长按图片保存"); })
      .catch(function () { toast("这台设备生成不了图片，换个浏览器试试"); });
  });

  if (shareBtn) shareBtn.addEventListener("click", function () {
    if (!lastModel) return;
    var canvas = document.createElement("canvas");
    try { draw(canvas, lastModel); }
    catch (e) { toast("这台设备生成不了图片，换个浏览器试试"); return; }
    var name = fileName(lastModel);
    if (!canvas.toBlob || !window.File) {
      save(lastModel).catch(function () { toast("这台设备生成不了图片，换个浏览器试试"); });
      return;
    }
    canvas.toBlob(function (blob) {
      /* blob 为 null = 这台设备的画布编码不出 PNG（画布太大/被系统拒绝）。
         旧写法这里是裸 `return`：用户点了「↗ 分享」什么都没发生，只会以为按钮坏了。
         与上面两处（:738 draw 抛异常、:741 没有 toBlob）走同一句话，口径保持一致 ——
         注意不能改用 save().catch()：save() 编码失败是 **resolve(false)** 不是 reject，
         挂 .catch 抓不到，等于又静默一次（sharecard.js 的同一处就是这么修的）。 */
      if (!blob) { toast("这台设备生成不了图片，换个浏览器试试"); return; }
      var file = new File([blob], name, { type: "image/png" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        save(lastModel).catch(function () { toast("这台设备生成不了图片，换个浏览器试试"); });
        return;
      }
      navigator.share({ files: [file], title: "我们的成就卡" }).catch(function () { /* 用户取消 */ });
    }, "image/png");
  });

  /* ---------- 首屏取数 + 渲染 ----------
     外壳会话里 window.__SERVER_CONTENT__ / __SERVER_COMPAT__ 是 api/config.php 在
     "文档加载那一刻"注入的快照，换视图不会再刷新（见 server.js 的 fetchAll 说明）。
     成就是"随时打开看看"的页面，直接拿冻结快照算，本会话刚打完的默契度、刚发的
     照片/情书都不计（第七轮 S8-03）。

     所以：先用快照立刻画一版（首屏不空等），同时实时拉一次内容与默契度历史，
     拿到就重画。本页是只读页面（没有输入框、没有未提交状态），重画没有丢数据
     的风险；拉取失败就保持第一版，口径与改造前一致。 */
  function loadLive() {
    var jobs = [];
    var S = window.loveServer;
    jobs.push((S && S.fetchAll)
      ? S.fetchAll().then(function (d) { return d || null; }, function () { return null; })
      : Promise.resolve(null));

    var compatUrl = "api/compat.php?action=status";
    /* 取数口子统一成 loveTimedFetch（全站静态锁）；它和裸 fetch 都不存在时
       （vm 沙箱、极受限环境）不能抛同步异常 —— 那会把整个 IIFE 打断，
       连本机兜底的渲染都没有（第七轮自审：_test_achievements.js 的沙箱里
       就是没有 fetch，旧写法在脚本求值阶段直接 ReferenceError）。 */
    var req = null;
    if (typeof window.loveTimedFetch === "function") req = window.loveTimedFetch(compatUrl, { cache: "no-store" });
    else if (typeof fetch === "function") req = fetch(compatUrl, { cache: "no-store" });
    jobs.push(req
      ? req.then(function (r) { return r.json().catch(function () { return null; }); },
                 function () { return null; })
           /* 顶层就是 status 视图（{ok:true, active, busy, history…}），与注入的
              __SERVER_COMPAT__ 同形状 —— 不是 {ok, data} 包装。 */
           .then(function (j) { return (j && j.ok) ? j : null; })
      : Promise.resolve(null));

    return Promise.all(jobs).then(function (rs) {
      var o = {};
      if (rs[0]) o.serverContent = rs[0];
      if (rs[1]) o.serverCompat = rs[1];
      return o;
    });
  }

  render();                       // 第一版：注入快照 / 本机数据（立即出现，不空等）
  loadLive().then(function (o) {
    if (!o || (!o.serverContent && !o.serverCompat)) return;   // 拿不到就保持第一版
    liveOpts = o;
    render();
  });

  // 旋转/缩放后重画雷达（尺寸变了会糊）
  LC.on(window, "resize", function () {
    LC.clear(window.__achResizeTimer);
    window.__achResizeTimer = LC.after(render, 200);
  });

  /* 数据在页内不会自己变（没有轮询），但每次挂载都会重新取一次 —— 换视图回来
     看到的就是当下的数据了（见上面 loadLive 的说明）。 */
})();
