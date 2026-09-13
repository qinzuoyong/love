/* ============================================================
   情侣网站 · 默认配置（唯一配置文件）
   ------------------------------------------------------------
   这里是"默认值"。管理员后台（/admin/）修改的内容会存在
   服务器 data/config.json，并通过 api/config.php 在页面加载时
   自动覆盖这里的默认值 —— 所以改配置请用后台，更新网站
   （上传覆盖文件）永远不会丢失后台改过的内容。

   手动改这里仍然有效（作为默认值），只是会被后台覆盖。
   ============================================================ */

/* 老浏览器兜底：iOS Safari ≤10 / WebView <57 没有 padStart，
   而全站计时、留言时间、倒计时都在用它（缺失会直接抛异常中断整段脚本）。
   放在最前面、所有脚本之前，保证后续文件都能用。 */
if (!String.prototype.padStart) {
  String.prototype.padStart = function (len, pad) {
    var s = String(this);
    pad = pad === undefined ? " " : String(pad);
    while (s.length < len) s = pad + s;
    return s.length > len ? s.slice(s.length - len) : s;
  };
}

/* 全局 HTML 转义：配置文案是管理员可写的，拼 innerHTML 前统一走这里
   （gallery.js / letters.js 各有一份行为一致的局部实现，保持不动）。 */
window.escHtml = function (v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};

/* 照片地址统一出口：PHP 主机上照片被 .htaccess 禁止直链，
   只能通过根目录 photo.php 代理读取（服务端校验解锁 Cookie）。
   纯静态托管 / 双击本地打开时没有 photo.php，保持原路径。
   admin/ 页面用 window.__PHOTO_BASE__ = "../" 指定相对前缀。 */
window.lovePhotoUrl = function (src) {
  if (!src) return "";
  var s = String(src);
  if (/^data:/i.test(s)) return s;                            // 本机兜底照片是内联 dataURL：
                                                              // 必须原样直出，送进 photo.php 只会 404
                                                              // （代理的白名单只收 assets/… 路径）
  if (/\.svg(\?|$)/i.test(s)) return s;                       // SVG 占位图仍直链
  if (typeof window.__SERVER_GATE__ === "undefined") return s; // 无 PHP：保持原路径
  var base = (typeof window.__PHOTO_BASE__ === "string") ? window.__PHOTO_BASE__ : "";
  return base + "photo.php?f=" + encodeURIComponent(s);
};

/* 唯一 id 生成：原来的 Date.now() + Math.random()*1000 在同一毫秒内
   并发提交时会撞车，服务端按 uid 去重会静默丢掉新内容。
   加进程内自增序号，同一毫秒内也绝不重复。 */
window.newUid = (function () {
  var seq = 0;
  return function (prefix) {
    seq = (seq + 1) % 1296;
    return String(prefix || "u") + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 8) + "-" + seq.toString(36);
  };
})();

const DEFAULT_CONFIG = {
  /* ---------- 你们的名字 ----------
     ★★★ 把"待定A / 待定B"改成你们的真名/昵称 ★★★
     全站所有显示（导航、主页标题、问候语、页面标题…）都会跟着变 */
  names: {
    boy: "待定A",       // 男生昵称
    girl: "待定B",      // 女生昵称
  },

  /* ---------- 重要日期 ---------- */
  startDate: "2023-05-20",   // 在一起的日期（格式：年-月-日）
  password: "520520",        // 解锁页密码（想取消密码就留空 ""，会直接进入）

  /* ---------- 主页标语 ---------- */
  slogan: "遇见你之后，所有的日子都有了光。",

  /* ---------- 主页时段问候 ----------
     留空 "" 时按打开时间自动说"早上好/晚上好…，我的 XX"
     想固定一句话就写在这里（如 "亲爱的，欢迎回家"）              */
  greeting: "",

  /* ---------- 情话轮播（主页自动播放） ---------- */
  messages: [
    "第一次见你，风都变甜了",
    "你是我平淡生活里的那颗糖",
    "想陪你看很多很多次日落",
    "世界很大，我的眼里只有你",
    "和你在一起的每一天，都值得纪念",
    "余生很长，请多指教",
  ],

  /* ---------- 首页四个介绍卡片 ---------- */
  homeCards: [
    { icon: "🌅", title: "我们的相遇", text: "那天阳光刚好，你也刚好出现在我的世界里。", link: "timeline.html", linkText: "看我们的故事 →" },
    { icon: "📸", title: "照片回忆录", text: "每一张照片都是一段舍不得忘掉的时光。", link: "gallery.html", linkText: "翻翻相册 →" },
    { icon: "🎂", title: "特别的日子", text: "纪念日、生日、每一个属于我们的节日。", link: "anniversary.html", linkText: "看看纪念日 →" },
    { icon: "💌", title: "想对你说的话", text: "有些话写在信里，比说出来更长久。", link: "letter.html", linkText: "读信去 →" },
    { icon: "🎮", title: "默契大考验", text: "来测一测，我们对彼此有多了解。", link: "game.html", linkText: "开始挑战 →" },
    { icon: "🌙", title: "小小心愿瓶", text: "把心愿装进瓶子里，等风来，等花开。", link: "letter.html#wish", linkText: "打开心愿瓶 →" },
  ],

  /* ---------- 纪念日列表 ----------
     type: "once"   一次性纪念日（如结婚纪念日），过了显示已度过
           "repeat" 每年都过（如生日、恋爱纪念日），自动算下一次
     date: 格式 "月-日"（repeat）或 "年-月-日"（once）
     lunar: true   表示农历生日！date 写农历月-日（如 "8-15" 中秋）
                   闰月生日写 "闰4-15"（自动找下一个有该闰月的年份）
                   网站会自动换算成今年/明年对应的真实公历日期来倒计时     */
  anniversaries: [
    { icon: "💘", title: "恋爱纪念日", date: "05-20",  type: "repeat" },
    { icon: "🎂", title: "待定A的生日", date: "10-24",  type: "repeat" },
    { icon: "🍰", title: "待定B的生日", date: "3-8",   type: "repeat", lunar: true },
    { icon: "❤️", title: "相恋100天",  date: "2023-08-28", type: "once", auto: "days100" },
    { icon: "💍", title: "相恋一周年", date: "2024-05-20", type: "once", auto: "year1" },
    { icon: "🎄", title: "圣诞节",     date: "12-25",  type: "repeat" },
  ],

  /* ---------- 时光轴（按时间顺序自动排列） ----------
     date 晚于今天的事件会显示"即将到来"样式（如未来的计划/约会） */
  timeline: [
    { date: "2023-05-20", icon: "👀", title: "第一次相遇", text: "在朋友的聚会上，一眼就注意到了你。那天你说的话不多，我却记了很久。", auto: "start" },
    { date: "2023-06-11", icon: "💬", title: "第一次约会", text: "一起看了场电影，散场后走了很远的路，路灯下我们谁都不舍得先说再见。" },
    { date: "2023-08-28", icon: "💖", title: "在一起 100 天", text: "一百天很短，短到感觉昨天才刚认识；一百天很长，长到我们已经习惯了彼此。", auto: "days100" },
    { date: "2024-02-14", icon: "🌹", title: "第一个情人节", text: "你收到花的时候眼睛亮晶晶的，那个表情我记到现在。" },
    { date: "2024-05-20", icon: "🏠", title: "相恋一周年", text: "一起布置了属于我们的小家，你说‘这里以后就是我们的窝了’。", auto: "year1" },
    { date: "2025-07-12", icon: "✈️", title: "第一次旅行", text: "去了海边，日出的时候你在旁边睡着了，海风和你的呼吸声一样温柔。" },
    { date: "2026-12-31", icon: "🎆", title: "跨年之夜", text: "和你一起倒数，迎接新一年的第一秒。" },
  ],

  /* ---------- 相册 ----------
     src: 图片路径（assets/img/ 下，支持 jpg/png/webp/svg）
     cat: 分类（用于筛选，自定义即可）
     cap: 照片说明
     建议尺寸: 宽 800px 以上，手机竖图也可以，自动瀑布流排列   */
  gallery: [
    { src: "assets/img/photo-1.svg", cat: "日常", cap: "甜甜的日常" },
    { src: "assets/img/photo-2.svg", cat: "旅行", cap: "第一次旅行的海边" },
    { src: "assets/img/photo-3.svg", cat: "日常", cap: "一起吃饭的快乐" },
    { src: "assets/img/photo-4.svg", cat: "纪念日", cap: "一周年纪念" },
    { src: "assets/img/photo-5.svg", cat: "旅行", cap: "山上的日落" },
    { src: "assets/img/photo-6.svg", cat: "美食", cap: "你做的爱心早餐" },
    { src: "assets/img/photo-7.svg", cat: "纪念日", cap: "节日的小惊喜" },
    { src: "assets/img/photo-8.svg", cat: "日常", cap: "最平凡也最幸福的周末" },
  ],

  /* ---------- 情书 ---------- */
  letters: [
    {
      date: "2026-05-20",
      title: "给最亲爱的你",
      body: `遇见你之前，我以为日子就是这样平平淡淡地过。
遇见你之后，才发现原来平凡的生活里，藏着这么多想分享的瞬间。

谢谢你包容我的小脾气，也谢谢你总是第一个站在我这边。
未来的路还很长，我想牵着你的手，慢慢走。

我爱你，不止今天。`,
      sign: "永远爱你的 待定A",
    },
    {
      date: "2026-01-01",
      title: "写给新的一年",
      body: `新年快乐，我的宝贝。
新的一年，我的愿望很简单：你健康，你开心，我们一直在一起。

去年和你一起看了很多次日落，今年想和你去看更多风景。
不管去哪里，有你在就是最好的旅程。`,
      sign: "你的 待定B",
    },
    {
      date: "2025-08-28",
      title: "相识纪念日",
      body: `认识你的那天，只是普通的一天。
可是后来，这一天变成了我人生里最重要的日子之一。

谢谢你选择了我，也谢谢你一直以来的陪伴。
我会用所有的温柔，守护我们的以后。`,
      sign: "爱你的 待定A",
    },
  ],

  /* ---------- 许愿瓶 ---------- */
  wishes: [
    { title: "环游世界", text: "想和你一起去看全世界的日出" },
    { title: "养只猫", text: "一只叫奶糖的橘猫，一家三口" },
    { title: "学做饭", text: "学会你最爱吃的那道菜" },
    { title: "去看海", text: "夏天的时候，去海边住一周" },
    { title: "拍婚纱照", text: "把幸福定格成照片" },
    { title: "一起老去", text: "牵手走到白发苍苍" },
  ],

  /* ---------- 默契问答（小游戏） ----------
     q: 题目  opts: 选项数组  a: 正确答案下标(从0开始)      */
  quiz: [
    { q: "我们的纪念日是哪一天？", opts: ["5月20日", "6月11日", "8月28日", "2月14日"], a: 0 },
    { q: "TA最喜欢什么颜色的花？", opts: ["红玫瑰", "粉玫瑰", "向日葵", "满天星"], a: 1 },
    { q: "谁先表白的？", opts: ["待定A", "待定B", "一起说的", "这是个秘密"], a: 0 },
    { q: "第一次约会看的什么电影？", opts: ["爱情片", "科幻片", "动画片", "其实没看电影"], a: 3 },
    { q: "TA最怕什么？", opts: ["打雷", "蟑螂", "黑", "冷"], a: 1 },
    { q: "我们的共同梦想是？", opts: ["开家小店", "环游世界", "养猫养狗", "一起看演唱会"], a: 1 },
    { q: "我最常说的一句话是？", opts: ["你饿不饿", "哈哈哈哈", "我错了", "想你了"], a: 3 },
    { q: "未来最想去的国家是？", opts: ["日本", "冰岛", "意大利", "新西兰"], a: 1 },
  ],

  /* ---------- 默契度测试题（小游戏页 · 双方各答一遍） ----------
     没有标准答案, 两人各自作答, 系统逐题对比算默契百分比
     每次发起随机抽 10 题（题库建议保持 10 题以上）
     想换题直接改这里的 q/opts, 选项数量建议 4 个            */
  compatQuiz: [
    { q: "周末最想怎么过？", opts: ["宅家看电影", "出去逛街", "短途旅行", "一起做饭"] },
    { q: "你最喜欢的季节是？", opts: ["春天", "夏天", "秋天", "冬天"] },
    { q: "理想中的旅行目的地？", opts: ["海边", "雪山", "古城", "大都市"] },
    { q: "你更偏爱哪种口味的菜？", opts: ["辣", "甜", "咸鲜", "清淡"] },
    { q: "睡前最后的习惯是？", opts: ["刷手机", "看会儿书", "和对方聊天", "倒头就睡"] },
    { q: "你最怕的小动物是？", opts: ["蜘蛛", "蟑螂", "老鼠", "蛇"] },
    { q: "心情不好的时候会？", opts: ["自己静静", "找人倾诉", "大吃一顿", "出去走走"] },
    { q: "最喜欢的电影类型？", opts: ["爱情片", "科幻片", "喜剧片", "悬疑片"] },
    { q: "理想的纪念日庆祝方式？", opts: ["烛光晚餐", "一起旅行", "在家安静过", "叫上朋友庆祝"] },
    { q: "将来最想养什么宠物？", opts: ["猫", "狗", "都不想养", "仓鼠兔子小宠"] },
    { q: "最想在哪座城市生活？", opts: ["海边小城", "繁华都市", "有烟火气的老城", "宁静的乡村"] },
    { q: "周末睡到几点算幸福？", opts: ["自然醒", "9 点前", "中午", "想睡多久睡多久"] },
    { q: "你觉得我们最像哪种组合？", opts: ["欢喜冤家", "细水长流", "轰轰烈烈", "互相成就"] },
    { q: "吵架之后你希望怎样和好？", opts: ["抱一下就好", "认真谈清楚", "给我点时间冷静", "用美食哄我"] },
    { q: "你觉得爱情里最重要的是？", opts: ["信任", "陪伴", "新鲜感", "理解"] },
    { q: "你最想和对方一起学什么？", opts: ["做饭", "跳舞", "一门乐器", "拍视频记录生活"] },
    { q: "你理想中的约会地点？", opts: ["电影院", "咖啡馆", "公园草地", "在家窝着"] },
    { q: "你更接受哪种表达爱的方式？", opts: ["直接说出来", "行动证明", "小礼物", "默默陪伴"] },
    { q: "睡前你会想些什么？", opts: ["明天的事", "今天的事", "关于对方", "什么也不想"] },
    { q: "你觉得我们多久该来一场小旅行？", opts: ["每个月", "每个季度", "一年一次", "说走就走"] },
    { q: "你更喜欢被夸哪方面？", opts: ["外貌", "能力", "性格", "品味"] },
    { q: "你最想改掉自己哪个小毛病？", opts: ["熬夜", "拖延", "脾气急", "想太多"] },
    { q: "你更喜欢哪种天气？", opts: ["阳光明媚", "下雨天", "下雪天", "多云微风"] },
    { q: "如果中了彩票，第一件事做什么？", opts: ["买房", "环游世界", "存起来", "给家人"] },
    { q: "你更怀念我们哪段时光？", opts: ["刚认识时", "热恋期", "现在的每天", "一起旅行时"] },
    { q: "你觉得默契是？", opts: ["天生就有", "相处久了自然有", "需要用心培养", "一个眼神就懂"] },
    { q: "你最想收到什么生日礼物？", opts: ["亲手做的东西", "惊喜旅行", "实用好物", "一场聚会"] },
    { q: "你眼里的「浪漫」是？", opts: ["仪式感惊喜", "平凡日常里的用心", "说走就走", "记得我说过的每句话"] },
    { q: "将来家里谁管钱？", opts: ["我管", "对方管", "一起管", "各管各的"] },
    { q: "你觉得我们之间谁更会哄人？", opts: ["我", "对方", "互相哄", "都不太会"] },
  ],

  /* ---------- 真心话卡片（小游戏页） ----------
     抽一张，轮流回答，看看谁先说真心话           */
  truthDares: [
    "说出你第一次见到我时的真实想法",
    "你最喜欢我身上的哪个优点？",
    "如果明天是世界末日，你想和我做什么？",
    "说出你心里最想让我改掉的一个小毛病",
    "你最近一次想我是什么时候？",
    "如果只能记住关于我的三件事，是哪三件？",
    "你偷偷学过什么，只是为了让我开心？",
    "你最喜欢的我们的共同回忆是哪一段？",
    "讲一件你从来没告诉过我的小事",
    "你希望我们的十年后是什么样子？",
    "你第一眼看到我时，心里在想什么？",
    "如果给我准备一个惊喜，会是什么？",
  ],

  /* ---------- 每日一问 ----------
     每天从下面这些题里轮一题（按日期固定，双方看到的是同一题）；
     两个人都答完才能看到对方的答案。想加题就往数组里加。
     参考 Paired 的「每日一问」：低压力、每天一句，久了就是一本对话集 */
  dailyQuestions: [
    "今天有什么小事让你想到我？",
    "最近有什么事让你压力很大？我能帮上什么吗？",
    "如果这周我们可以空出一整天，你想怎么过？",
    "我做的哪件小事你其实很在意，但从没说过？",
    "你现在最想要的一个拥抱是什么时候？",
    "最近有没有什么想尝试但一直没开始的事？",
    "在你眼里，我们最像哪个电影/小说里的情侣？",
    "今天最想对我说的一句话是什么？",
    "你最近睡得好吗？有没有什么在偷偷担心？",
    "如果我们现在去旅行，你第一个想去哪？",
    "有没有哪一刻你觉得特别为我骄傲？",
    "你希望我多问你的一个问题是什么？",
    "最近有没有一首歌让你想起我们？",
    "如果给我们现在的生活加一件小事，你想加什么？",
    "你小时候的梦想是什么？现在变了吗？",
    "最近有什么事让你偷偷开心了很久？",
    "你觉得我们之间最默契的一次是什么时候？",
    "有什么话你一直想听我说，但还没听到？",
    "今天想让我陪你做的一件小事是什么？",
    "你觉得我们现在最需要一起改掉的一个习惯？",
    "如果给这一年起个标题，你会写什么？",
    "你最近一次觉得被我理解，是什么时候？",
    "有没有什么旧照片/旧东西你舍不得扔？",
    "如果明天可以任性一次，你想做什么？",
    "你希望我们十年后的周末是什么样子？",
    "今天有什么让你觉得被爱着的瞬间？",
    "最近有没有想对我说但怕我多想的？",
    "你最想和我一起完成的一个小目标是什么？",
    "如果现在写一封一年后才会打开的信，第一句会写什么？",
    "今天，你最想谢谢我什么？",
  ],
};

/* ============================================================
   服务器自定义覆盖合并
   ------------------------------------------------------------
   api/config.php 会在本文件之前注入 window.__SERVER_OVERRIDES__，
   内容是管理员后台保存的修改（存在服务器 data/config.json）。
   合并规则：对象按 key 递归覆盖，数组整体替换。
   本地开发没有 PHP 时不会注入，直接用默认配置。
   ============================================================ */
window.DEFAULT_CONFIG = DEFAULT_CONFIG;
window.__mergeConfig = __mergeConfig;

function __mergeConfig(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over;
  if (typeof base === "object" && typeof over === "object") {
    var out = {};
    for (var k in base) out[k] = __mergeConfig(base[k], over[k]);
    // 服务器覆盖里"默认配置没有"的键也要留住：只遍历 base 会把它们静默丢掉，
    // 以后后台新增配置项时前台就永远看不到（现在 CFG_KEYS 与默认值一致，只是没踩到）。
    for (var k2 in over) if (!(k2 in out)) out[k2] = over[k2];
    return out;
  }
  return over;
}

/* ============================================================
   派生层：强相关日期自动计算 + 名字全站自动同步
   ------------------------------------------------------------
   只需要改 names（你们的名字）和 startDate（在一起的日期），
   其余强相关内容自动跟随：
   - auto 标记（条目里加 auto 字段即可）：
       "start"  = 在一起的日期
       "daysN"  = 在一起第 N 天（如 days100）
       "yearN"  = 在一起 N 周年（如 year1）
   - 所有文案里的"待定A / 待定B"自动替换成当前名字
     （手动改过、不含占位名的地方不受影响）
   面板后台加载配置时也会执行本函数，保证表单与前台一致。
   ============================================================ */
function __deriveConfig(cfg) {
  var out = {};
  var boy = (cfg.names && cfg.names.boy) || "";
  var girl = (cfg.names && cfg.names.girl) || "";

  /* 1) 名字自动同步：除 names 本身外，所有字符串里的占位名替换成当前名字 */
  function walk(v) {
    if (typeof v === "string") {
      if (boy) v = v.split("待定A").join(boy);
      if (girl) v = v.split("待定B").join(girl);
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) o[k] = walk(v[k]);
      return o;
    }
    return v;
  }
  for (var key in cfg) {
    out[key] = key === "names" ? cfg[key] : walk(cfg[key]);
  }

  /* 2) 强相关日期自动计算 */
  var start = out.startDate;
  var base = null;
  if (typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    var d = new Date(start + "T00:00:00");
    if (!isNaN(d.getTime())) base = d;
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function calc(auto) {
    if (!base) return null;
    var m;
    if (auto === "start") return fmt(base);
    if ((m = /^days(\d+)$/.exec(auto))) {
      var x = new Date(base); x.setDate(x.getDate() + parseInt(m[1], 10)); return fmt(x);
    }
    if ((m = /^year(\d+)$/.exec(auto))) {
      var y = new Date(base); y.setFullYear(y.getFullYear() + parseInt(m[1], 10)); return fmt(y);
    }
    return null;
  }
  function process(list, isAnniv) {
    if (!Array.isArray(list)) return list;
    return list.map(function (item) {
      if (!item || !item.auto) return item;
      var v = calc(item.auto);
      if (!v) return item;               // startDate 缺失/非法：保留原值
      var o = {};
      for (var k in item) o[k] = item[k];
      o.date = v;
      if (isAnniv) o.type = "once";
      return o;
    });
  }
  out.anniversaries = process(out.anniversaries, true);
  out.timeline = process(out.timeline, false);
  return out;
}
window.__deriveConfig = __deriveConfig;

const CONFIG = __deriveConfig(__mergeConfig(DEFAULT_CONFIG, window.__SERVER_OVERRIDES__ || null));

/* 注入自检：部署环境(http/https)下若没拿到服务器覆盖，提示刷新排查
   （本地 file:// 直接打开不算失败，不提示） */
if (typeof window.__SERVER_OVERRIDES__ === "undefined" && /^https?:$/.test(location.protocol)) {
  console.warn("[love] 服务器配置注入失败：页面将显示默认配置。请刷新页面重试；若仍复现，检查主机防火墙/WAF 是否拦截 api/config.php");
}
