/* ============================================================
   情侣网站 · 站内视图外壳（切页不换文档 → 背景音乐不断）
   ------------------------------------------------------------
   背景：音乐由 main.js 在每个文档里 `new Audio(...)` 建一次；站内点导航链接是**真实
   导航**，旧文档连同它的 audio 元素一起被销毁，新文档重新下载音频、重新 play()、
   再从 localStorage 续上位置 —— 用户听到的"音乐停了"就是这段空档（快网 1.9-2.7 秒，
   弱网 8 秒以上，被策略拦下时一直静音到用户点一下）。

   做法（静态优先，不引入框架/构建链，8 个 HTML 仍是各自独立的入口）：
     · 直接打开任何一页 → 内容照旧静态渲染在 <main id="view"> 里，首屏不依赖任何 fetch；
     · 站内点导航链接 → 被这里拦下，改成 fetch 目标页 → 只取它的 #view 内容换进来
       → 重新执行**该页的页面脚本** → pushState 改地址栏。文档从头到尾没导航过，
       所以 audio 元素一直活着、currentTime 一直往前走。

   两条纪律：
     1. **外壳的脚本不再重复执行**（SHELL_SCRIPTS）—— main.js 就是音乐模块的家，
        重复执行会造出第二个 audio 元素，正好毁掉本改造要达成的东西。
     2. **视图里登记的东西随视图一起清**（lifecycle.js）—— 页面脚本会被重新执行，
        它们挂在 document/window 上的监听与定时器必须登记、切页时统一清理，
        否则一次一页地累积。
   ============================================================ */

(function () {
  "use strict";

  /* 属于"外壳"的页面（站内切页走换视图）。
     解锁页 index.html 故意不在内：它没有音乐，而且是门禁入口，保持整页导航最稳。

     ⚠️ 这张表是**逐页放行**的开关：改造按"一次只迁一页"推进，每放行一页就跑一次
     全量套件 + 真机走查 + 复验此前已迁的页面。表里没有的页面照旧走整页导航
     （音乐断一次，但功能与改造前完全一致）—— 所以这张表为空时整个外壳是**惰性**的。

     ⚠️ 现在**支持子目录页了**：挂载时页面脚本的 src 与片段里的相对 src/href 都按
     **目标页自己的 URL** 解析（S15-06），不是按外壳文档解析 —— 所以 `pages/letter.html`
     这类子目录页不会整排 404。但表里仍**只放同源页**：`shellLink` 只拦同源链接，
     跨源页放行给浏览器；这里加一个非同源的地址没有任何意义（也拦不住）。 */
  var PAGES = ["timeline.html", "gallery.html", "letter.html", "game.html", "anniversary.html", "home.html", "achievements.html"];

  /* 外壳自己已经加载过的脚本：换视图时不再重复执行（见文件头纪律 1） */
  var SHELL_SCRIPTS = ["api/config.php",
                       "assets/js/theme.js", "assets/js/config.js", "assets/js/gate.js",
                       "assets/js/main.js", "assets/js/lifecycle.js", "assets/js/shell.js"];

  var view = document.getElementById("view");
  if (!view) return;                                  // 不是外壳页（如解锁页）→ 什么都不做
  /* 本地双击打开（file://）：没有服务器，fetch 取不到别的页面，
     硬拦导航只会变成"先失败一次再真导航"。维持整页导航，与今天完全一致。 */
  if (location.protocol === "file:") return;

  var LC = window.LoveLifecycle || null;
  var mounting = false;      // 一次挂载正在进行
  var gen = 0;               // 挂载代次：后发起的导航作废在途的那次
  var pending = null;        // 挂载期间又来了一次导航 → 排队
  var mountedOnce = false;   // 外壳是否已经挂过视图（没挂过时历史条目与改造前一样）
  var scrollStore = {};      // 每个视图离开时的滚动位置（回退时还原）
  var currentUrl = location.pathname + location.search;

  /* ---------- 换视图的读屏播报（S15-05） ----------
     换视图没有换文档，浏览器不会念新页标题；焦点虽然被搬进 #view，读屏用户也听不出
     "内容换了"。这里挂一个 role=status / aria-live=polite 的容器：礼貌播报（不打断
     当前朗读），.sr-only 让它视觉隐藏但仍在无障碍树里。
     只在启动时建一次（页面里已经有就复用，避免重复容器）。内容一律 textContent 写。 */
  var announceEl = document.getElementById("viewAnnounce");
  if (!announceEl && document.body) {
    announceEl = document.createElement("p");
    announceEl.id = "viewAnnounce";
    announceEl.className = "sr-only";
    announceEl.setAttribute("role", "status");
    announceEl.setAttribute("aria-live", "polite");
    document.body.appendChild(announceEl);
  }
  var lastAnnounced = "";

  /* 播报内容 = 新页标题。外壳文档的 <title> 是 main.js 的 loveSetTitle 拼的
     "男 ♥ 女 · 页面标题"，目标页的 doc.title 一般已经是纯净的页面标题；为稳妥起见
     按"·"切开、扔掉带 ♥ 的那一段（品牌名），剩下的就是页面自己的标题。
     取不到标题就退回文件名。同一标题不重复写（连点导航不反复播报）。 */
  function announceView(doc, url) {
    if (!announceEl) return;
    var title = String((doc && doc.title) || "");
    title = title.split("·")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.indexOf("\u2665") < 0; })   // \u2665 = ♥
      .join(" · ");
    if (!title) title = basename(url) || "";
    if (!title || title === lastAnnounced) return;
    lastAnnounced = title;
    announceEl.textContent = title;
  }

  function basename(p) {
    return String(p || "").split("#")[0].split("?")[0].split("/").pop();
  }

  /* 门禁复核（见 applyView 第 0 步的说明）。
     ⚠️ 探测失败按"放行"处理（fail-open）：一次网络抖动不该把两个人一起踢出网站；
     真正的数据仍然由服务端按 Cookie 判（未解锁一律 401），这一层只是体验层的门。 */
  function recheckGate() {
    var url = "api/unlock.php";
    var opt = { timeoutMs: 8000 };
    var p = (typeof window.loveTimedFetch === "function")
      ? window.loveTimedFetch(url, opt)
      : fetch(url, opt);
    return p
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.required && !j.unlocked) {
          location.replace("index.html?need=1");
          return false;
        }
        return true;
      })
      .catch(function () { return true; });
  }

  /* ---------- 判断"这一下点击该不该被拦" ---------- */
  function shellLink(a) {
    if (!a) return false;
    if (a.target && a.target !== "_self") return false;   // 新窗口/新标签
    if (a.hasAttribute("download")) return false;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return false;    // 页内锚点
    var u;
    try { u = new URL(href, location.href); } catch (e) { return false; }
    if (u.origin !== location.origin) return false;       // 站外
    return PAGES.indexOf(basename(u.pathname)) >= 0;
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // 用户想开新标签
    var t = e.target;
    var a = t && t.closest ? t.closest("a[href]") : null;
    if (!shellLink(a)) return;
    e.preventDefault();
    navigate(a.getAttribute("href"));
  }

  /* ---------- 站内锚点 ----------
     pushState 不会滚动到 fragment（规范如此），改造前是真实导航、浏览器会自己滚 ——
     换了视图之后必须显式补上，否则「打开心愿瓶 →」（letter.html#wish）落在页面顶部
     （第七轮 S15-01）。选择器非法或目标不存在时安静退回顶部。 */
  function scrollToHash(hash) {
    if (!hash || hash === "#") return false;
    var el = null;
    try { el = document.querySelector(hash); } catch (e) { return false; }
    if (!el) return false;
    try { el.scrollIntoView(); return true; } catch (e) { return false; }
  }

  /* ---------- 站内导航（不换文档） ---------- */
  function navigate(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { location.href = url; return; }
    var target = u.pathname + u.search + u.hash;
    var cur = null;
    try { cur = new URL(currentUrl, location.href); } catch (e) { cur = null; }
    if (cur && basename(u.pathname) === basename(currentUrl) && u.search === cur.search) {
      /* 点的是当前这一页（含页内锚点，例如在首页点"首页"）：只更新地址栏 + 滚到锚点，
         不重建视图。旧行为是整页重载一次，等于白扔一次音乐。
         ⚠️ 判据必须连 query 一起比：只比 basename 会把"同路径不同 query"的链接
         静默吞掉（点了什么都不发生，第七轮 S15-07）—— 那种情况落到下面的挂载分支。 */
      if (u.hash !== location.hash) {
        try { history.pushState({ love: 1 }, "", target); } catch (e) {}
      }
      scrollToHash(u.hash);
      return;
    }
    scrollStore[currentUrl] = window.scrollY;
    try {
      history.pushState({ love: 1 }, "", target);
    } catch (e) {
      location.href = url;                 // pushState 不可用（沙箱/跨源）→ 退回整页导航
      return;
    }
    currentUrl = u.pathname + u.search;
    mountedOnce = true;
    /* pushed: 上面已经压过一条历史条目 —— 挂载失败时用 location.replace 把它换掉，
       不能再 href 一次（那会给同一个 URL 多留一条相邻条目，用户要多按一次返回才走掉，
       见第七轮 S15-04）。hash 交给 applyView 在内容落地后处理（S15-01）。 */
    mount(currentUrl, { scroll: 0, pushed: true, hash: u.hash });
  }

  /* ---------- 挂载一个视图 ---------- */
  /* 取目标页 HTML 必须带超时（全站静态锁 F1 的同一条口径）：
     裸 fetch 挂住时 .then/.catch 一个都不跑 → 点了导航什么都不发生、也没有兜底出口。
     超时/失败一律走下面的 catch → 退回整页导航，用户至少能看到浏览器自己的加载。 */
  var VIEW_FETCH_TIMEOUT_MS = 15000;
  function fetchViewHtml(url) {
    var opt = { cache: "no-cache", timeoutMs: VIEW_FETCH_TIMEOUT_MS };
    if (typeof window.loveTimedFetch === "function") return window.loveTimedFetch(url, opt);
    return fetch(url, opt);      // config.js 没加载（异常场景）时的兜底
  }

  function mount(url, opts) {
    opts = opts || {};
    var myGen = ++gen;
    if (mounting) { pending = { url: url, opts: opts }; return; }
    mounting = true;
    fetchViewHtml(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (html) {
        if (myGen !== gen) return;                       // 已被更新的导航取代
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresh = doc.getElementById("view");
        if (!fresh) throw new Error("目标页里没有 #view（不是外壳页？）");
        /* applyView 返回"页面脚本全部执行完"的 promise：挂载期要一直算到那一刻
           （见下面的 then），否则脚本还在下载时 mounting 就放开了 —— 第二次导航
           会立刻并行开挂，两次挂载的脚本交错，旧页的尾巴（合成 load / 挂载钩子 /
           错位的 scrollTo）落在新视图上（第七轮 S15-02）。 */
        return applyView(doc, fresh, url, opts, myGen);
      })
      .catch(function (err) {
        if (myGen !== gen) return;
        /* 取不到就把这一下退回成真实导航 —— 宁可音乐断一次，绝不白屏。
           已经 pushState 过的那次用 replace：同一个 URL 不留两条相邻历史条目
           （第七轮 S15-04：否则用户要多按一次返回才走得掉）。 */
        console.error("[love-shell] 视图挂载失败，退回整页导航：", err);
        if (opts.pushed) location.replace(url);
        else location.href = url;
      })
      .then(function () {
        mounting = false;
        if (pending) { var p = pending; pending = null; mount(p.url, p.opts); }
      });
  }

  function applyView(doc, fresh, url, opts, myGen) {
    /* 0) 每次换视图都复核一次门禁状态。
       改造前是"每次真实导航都重新跑一遍 gate.js"，换成换视图之后若只在启动时判一次，
       解锁 Cookie 中途过期（30 天有效期到了、或在后台改了口令导致签名密钥轮换）
       就再也不会被弹回解锁页 —— 这一条是 goal 的【已知风险】里点名的，必须处理。
       `GET api/unlock.php` 是**纯读**（api/unlock.php 里写明"只判 POST；GET 是页面
       探测状态用的，无副作用"，不消耗失败计数），代价约 200 字节。 */
    recheckGate();

    /* 1) 卸载旧视图：清掉上一个视图登记的全部监听/定时器/观察者（见文件头纪律 2） */
    if (LC) LC.end();
    try { window.dispatchEvent(new CustomEvent("love:view-unmount")); } catch (e) {}
    document.body.style.overflow = "";      // 灯箱/弹窗可能把整页滚动锁住了

    /* 目标页自己的 URL（S15-06）：片段里的相对 src/href 与页面脚本都按它解析 ——
       真实导航时浏览器就是这么算的，换成换视图不能改成按外壳文档算。 */
    var baseUrl;
    try { baseUrl = new URL(url, location.href).href; } catch (e) { baseUrl = url; }

    /* 2) 先把内容落地，再执行脚本 —— 脚本出错也不会白屏。
          拷贝之前把片段里的相对 src/href 绝对化：改的是这份解析出来的文档片段，
          目标页的其它东西不受影响（S15-06）。 */
    absolutizeDocUrls(fresh, baseUrl);
    view.innerHTML = fresh.innerHTML;
    document.body.dataset.page = (doc.body && doc.body.dataset.page) || "";
    var title = doc.title || "";
    if (title && window.loveSetTitle) window.loveSetTitle(title);
    else if (title) document.title = title;
    var metaNew = doc.querySelector('meta[name="description"]');
    var metaCur = document.querySelector('meta[name="description"]');
    if (metaNew && metaCur) metaCur.setAttribute("content", metaNew.getAttribute("content") || "");

    /* 2b) 换视图的播报（S15-05）：内容已经落地，把新页标题写进 role=status 容器，
           读屏用户才"听得出"页面换了。同标题不重复写（连点导航不反复播报）。 */
    announceView(doc, url);

    /* 3) 从这里开始，页面脚本的登记都记进新账本 */
    if (LC) LC.begin();

    return runScripts(collectScripts(doc, baseUrl), function () { return myGen === gen; })
      .then(function () {
        /* 这一步之后的所有动作都带代次判据：脚本加载期间用户又导航了一次的话，
           前一次挂载的"尾巴"一律不做 —— 否则它的合成 load / 挂载钩子 / scrollTo
           会落在新视图上（第七轮 S15-02：最常见的一组是"切页后马上按返回"，
           还原好的滚动位置被旧那次挂载的 scrollTo(0,0) 顶回顶部）。 */
        if (myGen !== gen) return;
        /* 4) 脚本都加载完了 = 这一页"加载完成"。补发一次 load：
              countdown.js 的两处"等 load 再判一次"兜底（农历换算与烟花都要等
              main.js 就绪）因此在换视图的场景里照旧生效。全站只有它监听 window 的 load。 */
        try { window.dispatchEvent(new Event("load")); } catch (e) {}
        /* 5) 外壳跟着新视图要重做的事（品牌名回填 / 导航高亮 / 浮现动画） */
        if (window.loveOnViewMounted) {
          try { window.loveOnViewMounted(); } catch (e) { console.error("[love-shell] 挂载钩子出错：", e); }
        }
        /* 6) 位置：本次导航带锚点就滚到锚点（S15-01）；否则前进到新页回顶部、
              浏览器后退还原离开时的位置 */
        if (!(opts.hash && scrollToHash(opts.hash))) {
          try { window.scrollTo(0, opts.scroll || 0); } catch (e) {}
        }
        /* 6b) 焦点搬进新视图（S15-05）：被激活的链接往往就在被换掉的 #view 里，
               它随 innerHTML 一起消失 → 焦点掉回 body，下一次 Tab 从文档最开头重来。
               preventScroll 保住上面刚定好的滚动位置；tabindex=-1 让容器可聚焦但不入 Tab 序。 */
        try {
          if (view) {
            view.setAttribute("tabindex", "-1");
            view.focus({ preventScroll: true });
          }
        } catch (e) {}
        /* 7) 让外壳的滚动相关状态（导航阴影、返回顶部、进度条、浮现）按新高度重算 */
        try { window.dispatchEvent(new Event("scroll")); } catch (e) {}
      })
      .catch(function (e) { console.error("[love-shell] 页面脚本执行出错：", e); });
  }

  /* ---------- 相对 URL 绝对化（S15-06） ----------
     目标页的 HTML 是解析出来的片段；真实导航时片段里的相对 src/href 以**目标页**为
     基准，但换视图是把这些节点拷进外壳文档，浏览器会按**外壳文档**解析 —— 子目录页
     的脚本/图片会整体 404 或裂图。所以拷进 #view 之前先按目标页 URL 绝对化。
     只处理"能安全绝对化"的值，其余一律原样留下：
       · 空值 / 以 # 开头（页内锚点）
       · 带 javascript:/mailto:/tel:/data: 等非 http(s) 方案（module/协议相对除外，
         协议相对 //host/x 仍按 base 正常解析）
       · <a download>（改 href 会改变下载文件名）
       · 解析失败（保留原值，记一行日志，不静默）
     返回 null 表示"保持原样"。 */
  function absoluteUrlOrNull(value, base) {
    if (!value) return null;                       // 空值 / 缺失
    if (value.charAt(0) === "#") return null;      // 页内锚点
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
    if (m) {
      var scheme = m[1].toLowerCase();
      if (scheme !== "http" && scheme !== "https") return null;   // 非 http(s) 方案
    }
    var abs = null;
    try { abs = new URL(value, base).href; }
    catch (e) {
      console.error("[love-shell] 资源地址解析失败，按原样保留：" + value);
      return null;
    }
    return abs === value ? null : abs;             // 已经是同一个绝对地址 → 不必改
  }

  function absolutizeDocUrls(fresh, base) {
    if (!base || !fresh || !fresh.querySelectorAll) return;
    var nodes = fresh.querySelectorAll("[src],[href]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || !el.getAttribute) continue;
      if (el.hasAttribute && el.hasAttribute("download")) continue;   // <a download>
      var absSrc = absoluteUrlOrNull(el.getAttribute("src"), base);
      if (absSrc) el.setAttribute("src", absSrc);
      var absHref = absoluteUrlOrNull(el.getAttribute("href"), base);
      if (absHref) el.setAttribute("href", absHref);
    }
  }

  /* ---------- 目标页要执行哪些脚本 ----------
     从目标页自己的 <script> 列表里取（而不是写一张硬编码表：那样页面以后加脚本
     就会漂移），只剔掉外壳自己已经加载过的那几个。
     base = 目标页 URL：src 是相对路径时按它解析（S15-06），由 loadScript 落地。 */
  /* 这个 src 是不是"外壳自己已经加载过的脚本"？
     不能只做字面量比较：S15-06 之后目标页可以位于子目录，引用外壳脚本会写成
     `../assets/js/main.js` 这类相对路径，字面量比不中 → main.js 被**第二次执行**，
     造出第二个 audio 元素（正好毁掉本改造要达成的东西）。
     所以先按目标页 URL 解析成路径再比：既认"解析后与名单完全一致"（根目录 /
     子目录 ../ 回指），也认"以 `/名单条目` 结尾"（站点部署在子路径时，解析结果会
     带上那一段前缀）。解析失败就退回原来的字面量比较。 */
  function isShellScript(src, base) {
    var path = String(src || "").split("?")[0].split("#")[0];
    if (base) {
      try { path = new URL(path, base).pathname; } catch (e) { /* 解析不了就用原样 */ }
    }
    var clean = path.replace(/^\/+/, "");
    for (var i = 0; i < SHELL_SCRIPTS.length; i++) {
      var name = SHELL_SCRIPTS[i];
      if (clean === name) return true;
      if (clean.length > name.length + 1 && clean.slice(-(name.length + 1)) === "/" + name) return true;
    }
    return false;
  }

  function collectScripts(doc, base) {
    var out = [];
    var all = doc.querySelectorAll("script");
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      var src = s.getAttribute("src");
      if (src) {
        if (isShellScript(src, base)) continue;
        out.push({ src: src, base: base });
      } else {
        var code = s.textContent || "";
        if (code.replace(/\s+/g, "")) out.push({ code: code });
      }
    }
    return out;
  }

  function runInline(code) {
    /* 内联脚本（页脚年号 / 首页问候语与标语）：innerHTML 插进来的 <script> 不会执行，
       所以显式建一个元素挂上去 —— 与浏览器原生执行语义一致（都是全局作用域）。 */
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.textContent = code;
      try { view.appendChild(s); }
      catch (e) { console.error("[love-shell] 内联脚本插入失败：", e); }
      resolve();
    });
  }

  function loadScript(src, base) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      /* 相对路径按**目标页 URL** 解析（S15-06）：s.src = src 会按外壳文档算，
         子目录页的 assets/js/*.js 会被解析到根目录 → 404、页面静默不初始化。
         解析失败退回原样并记一行日志（绝不静默吞掉）。 */
      var url = src;
      try { url = new URL(src, base || location.href).href; }
      catch (e) {
        console.error("[love-shell] 页面脚本路径解析失败，按原样加载：" + src);
        url = src;
      }
      s.src = url;
      /* 动态插入的 <script> 默认 async=true，执行顺序不保证；
         页面脚本之间是有依赖的（lunar → countdown 等），必须保序。 */
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        /* 一个脚本挂了不该让整页白屏：记一笔、继续把剩下的跑完 */
        console.error("[love-shell] 页面脚本加载失败：" + url);
        resolve();
      };
      view.appendChild(s);
    });
  }

  /* 严格按原顺序串行执行（内联与 src 混排时也不乱）。
     alive 回调：调用方给的代次判据 —— 过期就立刻停下，不再把旧页剩余的脚本
     插进新视图（脚本元素一旦插入过就不会因为被摘除而取消执行，见 S15-02）。 */
  function runScripts(list, alive) {
    var i = 0;
    function step() {
      if (i >= list.length) return Promise.resolve();
      if (alive && !alive()) return Promise.resolve();
      var it = list[i++];
      return (it.code ? runInline(it.code) : loadScript(it.src, it.base)).then(step);
    }
    return step();
  }

  /* ---------- 浏览器前进 / 后退 ---------- */
  function onPop() {
    var file = basename(location.pathname);
    if (PAGES.indexOf(file) < 0) {
      /* 回退到了"不由外壳托管"的页面（例如解锁页）。
         只有在外壳**曾经挂过视图**时才需要真正加载那个文档 ——
         没挂过的话历史条目与改造前一模一样，这里什么都不该做，
         否则会把浏览器自己的前进/后退（含 bfcache）搅乱。 */
      if (mountedOnce) location.reload();
      return;
    }
    /* 离开当前页之前先把位置记下来：scrollStore 原来只在 navigate() 里写，
       于是"用返回/前进离开一页"时那一页的位置丢了 —— 后退回去正确、再前进就
       回到顶部（第七轮 S15-03）。 */
    scrollStore[currentUrl] = window.scrollY;
    var url = location.pathname + location.search;
    if (url === currentUrl) {
      /* 同 URL 的历史条目（hash 切换留下的、或失败回退留下的）：视图已经在位，
         重建只会让内容闪一下、浮现动画重放、位置被 store 重置。只处理锚点。 */
      scrollToHash(location.hash);
      return;
    }
    currentUrl = url;
    mount(url, { scroll: scrollStore[url] || 0, hash: location.hash });
  }

  /* ---------- 启动 ---------- */
  /* 当前这一页就是入口：内容已经在文档里静态渲染好了，这里不碰它，
     只把地址栏条目打上标记并装上拦截。 */
  scrollStore[currentUrl] = 0;
  document.addEventListener("click", onClick, true);
  window.addEventListener("popstate", onPop);

  window.LoveShell = {
    pages: PAGES.slice(),
    shellScripts: SHELL_SCRIPTS.slice(),
    navigate: navigate,
    mount: mount,
    stats: function () {
      return {
        mounting: mounting, generation: gen, pending: !!pending, mountedOnce: mountedOnce,
        currentUrl: currentUrl, scrollStore: scrollStore,
        lifecycle: LC ? LC.stats() : null,
      };
    },
  };
})();
