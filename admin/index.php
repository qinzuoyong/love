<?php
/* ============================================================
   情侣网站 · 管理员后台
   登录后可修改全部配置与数据（名字/日期/纪念日/时间线/情书/
   心愿瓶/题库/真心话/相册照片/留言板/手写情书）+ 备份恢复。
   所有修改存到服务器 data/ 目录，网站更新（上传覆盖）不会动它。
   ============================================================ */
require __DIR__ . '/../lib/store.php';
love_session();
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<?php love_emit_https_upgrade(); ?>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>管理员后台 · 情侣网站</title>
<style>
  :root { --pink:#f06292; --pink-d:#d6457e; --ink:#5a3b47; --sub:#9a7b8a; --line:#f0c9d8; --bg:#fdf2f6; }
  * { box-sizing: border-box; }
  body { font-family:"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); margin:0; font-size:14px; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:14px 22px; display:flex; align-items:center; gap:14px; position:sticky; top:0; z-index:20; }
  header h1 { font-size:17px; margin:0; color:var(--pink-d); }
  header .who { color:var(--sub); font-size:13px; flex:1; }
  .tabs { display:flex; flex-wrap:wrap; gap:6px; padding:12px 22px 0; }
  .tabs button { border:1px solid var(--line); background:#fff; color:var(--ink); padding:7px 14px; border-radius:20px; cursor:pointer; font-size:13px; }
  .tabs button.active { background:var(--pink); border-color:var(--pink); color:#fff; }
  main { padding:16px 22px 90px; max-width: 980px; }
  .tab { display:none; }
  .tab.active { display:block; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:16px; }
  .panel h2 { margin:0 0 4px; font-size:15px; color:var(--pink-d); }
  .panel .desc { color:var(--sub); font-size:12px; margin-bottom:12px; }
  label.f { display:block; font-size:12px; color:var(--sub); margin:8px 0 3px; }
  input[type=text], input[type=password], input[type=date], textarea, select {
    width:100%; padding:8px 10px; border:1px solid #f0c9d8; border-radius:8px; font-size:13px; font-family:inherit; outline:none; background:#fff; color:var(--ink);
  }
  input:focus, textarea:focus, select:focus { border-color:var(--pink); }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; border-bottom:1px dashed #f7dfe9; padding:10px 0; }
  .row > div { flex:1; min-width:110px; }
  .row .wide { flex:2.4; min-width:200px; }
  .row .opts { flex:2.4; display:flex; gap:6px; }
  .row .opts input { flex:1; }
  .row-btns { display:flex; gap:4px; align-items:center; flex:0 0 auto; }
  .row-btns button { width:30px; height:30px; border:1px solid var(--line); background:#fff; border-radius:8px; cursor:pointer; color:var(--sub); }
  .row-btns button:hover { color:var(--pink-d); border-color:var(--pink); }
  .row-btns button.del:hover { color:#c2365f; border-color:#c2365f; }
  .btn { background:var(--pink); color:#fff; border:0; border-radius:10px; padding:9px 18px; cursor:pointer; font-size:13px; }
  .btn:hover { background:var(--pink-d); }
  .btn.ghost { background:#fff; color:var(--pink-d); border:1px solid var(--pink); }
  .add-btn { margin:10px 0 0; }
  .savebar { position:fixed; left:0; right:0; bottom:0; background:#fff; border-top:1px solid var(--line); padding:10px 22px; display:flex; align-items:center; gap:12px; z-index:30; }
  .savebar .state { color:var(--sub); font-size:12px; flex:1; }
  .savebar .state.dirty { color:#e08f2e; }
  .savebar .state.ok { color:#2e9e5b; }

  /* ---------- 顶部通知横幅 ----------
     每次保存/上传/删除的结果都在这里弹出：带图标、带底色、左侧色条，
     成功绿、警告琥珀、失败红；失败不自动消失，必须点一下才关。 */
  .toastbox { position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:120;
    display:flex; flex-direction:column; gap:8px; width:min(560px,94vw); pointer-events:none; }
  .toast { pointer-events:auto; display:flex; align-items:flex-start; gap:10px;
    background:#fff; border:1px solid var(--line); border-left:6px solid var(--pink);
    border-radius:12px; padding:12px 14px; font-size:14px; line-height:1.5; color:var(--ink);
    box-shadow:0 12px 34px rgba(214,69,126,.26); cursor:pointer;
    animation:toastIn .22s ease-out; }
  .toast.ok   { border-left-color:#2e9e5b; background:#f2fbf6; color:#1f6b41; }
  .toast.warn { border-left-color:#e08f2e; background:#fff8ec; color:#8a5a10; }
  .toast.err  { border-left-color:#c2365f; background:#fff1f5; color:#a52a4d; }
  .toast .ico { flex:0 0 auto; font-size:17px; line-height:1.35; }
  .toast .txt { flex:1; white-space:pre-line; word-break:break-word; }
  .toast .x   { flex:0 0 auto; border:0; background:transparent; color:inherit; opacity:.55;
    font-size:15px; line-height:1.4; cursor:pointer; padding:0 2px; }
  .toast .x:hover { opacity:1; }
  .toast.out  { animation:toastOut .18s ease-in forwards; }
  @keyframes toastIn  { from { opacity:0; transform:translateY(-18px); } to { opacity:1; transform:none; } }
  @keyframes toastOut { to { opacity:0; transform:translateY(-10px); } }

  /* 有未保存改动时，保存按钮轻微呼吸 */
  @keyframes savePulse { 0%,100% { box-shadow:0 0 0 0 rgba(240,98,146,.5); } 50% { box-shadow:0 0 0 7px rgba(240,98,146,0); } }
  .savebar .btn.dirty { animation:savePulse 1.6s ease-out infinite; }

  @media (prefers-reduced-motion: reduce) {
    .toast, .toast.out, .savebar .btn.dirty { animation:none; }
  }
  @media (max-width:700px){ .toast { font-size:13.5px; padding:11px 12px; } }
  .msg { padding:8px 10px; border-radius:8px; font-size:13px; margin:8px 0; }
  .msg.err { background:#ffe9ef; color:#c2365f; }
  .msg.ok { background:#e8f7ee; color:#2e7d4f; }
  #loginView { max-width:380px; margin:9vh auto; background:#fff; border:1px solid var(--line); border-radius:16px; padding:28px; box-shadow:0 8px 30px rgba(240,98,146,.15); }
  #loginView h1 { font-size:18px; color:var(--pink-d); margin:0 0 4px; }
  #loginView .sub { color:var(--sub); font-size:12px; margin-bottom:16px; }
  .mini-thumb { width:44px; height:44px; object-fit:cover; border-radius:8px; border:1px solid var(--line); }
  table.ct { width:100%; border-collapse:collapse; }
  table.ct td, table.ct th { border-bottom:1px solid #f7dfe9; padding:8px 6px; text-align:left; vertical-align:top; font-size:13px; }
  table.ct th { color:var(--sub); font-weight:normal; font-size:12px; }
  .muted { color:var(--sub); font-size:12px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0 24px; }
  @media (max-width:700px){ .grid2 { grid-template-columns:1fr; } }
</style>
</head>
<body>

<!-- ================= 登录 ================= -->
<div id="loginView" style="display:none">
  <h1>🔐 管理员后台</h1>
  <p class="sub" id="loginSub">登录后可修改网站的全部配置与数据</p>
  <label class="f">用户名</label>
  <input type="text" id="lgUser" maxlength="20" autocomplete="username">
  <label class="f">密码</label>
  <input type="password" id="lgPass" maxlength="64" autocomplete="current-password">
  <div id="lgMsg"></div>
  <button class="btn" id="lgBtn" style="width:100%;margin-top:16px">登 录</button>
</div>

<!-- ================= 主界面 ================= -->
<div id="appView" style="display:none">
  <header>
    <h1>💗 情侣网站 · 管理员后台</h1>
    <span class="who" id="whoLine"></span>
    <button class="btn ghost" id="logoutBtn">退出登录</button>
  </header>

  <div class="tabs" id="tabs">
    <button data-tab="basic">基本设置</button>
    <button data-tab="texts">情话与卡片</button>
    <button data-tab="dates">纪念日与时光轴</button>
    <button data-tab="letters">情书与心愿</button>
    <button data-tab="quiz">题库与真心话</button>
    <button data-tab="gallery">相册管理</button>
    <button data-tab="content">留言与手写情书</button>
    <button data-tab="backup">备份与恢复</button>
    <button data-tab="account">账号设置</button>
  </div>

  <main>
    <!-- 基本设置 -->
    <section class="tab" data-panel="basic">
      <div class="panel">
        <h2>你们的名字</h2>
        <p class="desc">⭐ 只改这里即可：生日标题、情书署名、题库选项等所有引用名字的地方会自动同步。</p>
        <div class="grid2">
          <div><label class="f">男生昵称（显示在标题/问候语/署名）</label><input type="text" id="f_names_boy"></div>
          <div><label class="f">女生昵称</label><input type="text" id="f_names_girl"></div>
        </div>
      </div>
      <div class="panel">
        <h2>重要日期</h2>
        <p class="desc">⭐ 只改"在一起的日期"即可：相恋100天、相恋一周年、第一次相遇的日期会自动计算（列表里对应项显示为灰色不可改）。</p>
        <div class="grid2">
          <div><label class="f">在一起的日期（startDate）</label><input type="date" id="f_startDate"></div>
          <div><label class="f">解锁页密码（留空 = 直接进入）</label><input type="text" id="f_password" maxlength="20" placeholder="如 520520"><div class="muted">首尾空格会被自动忽略（保存前去掉）；想关掉门禁请把此框清空，而不是填空格。</div></div>
        </div>
      </div>
      <div class="panel">
        <h2>主页文案</h2>
        <div><label class="f">标语 slogan（如：遇见你之后，所有的日子都有了光。）</label><input type="text" id="f_slogan"></div>
        <div><label class="f">固定问候语 greeting（留空 = 按时间自动说"早上好/晚上好…"）</label><input type="text" id="f_greeting"></div>
      </div>
    </section>

    <!-- 情话与卡片 -->
    <section class="tab" data-panel="texts">
      <div class="panel">
        <h2>情话轮播 messages</h2>
        <p class="desc">主页自动播放的情话，每条一行</p>
        <div id="ed_messages"></div>
        <button class="btn ghost add-btn" data-add="messages">＋ 加一条情话</button>
      </div>
      <div class="panel">
        <h2>首页介绍卡片 homeCards</h2>
        <p class="desc">主页"关于我们"的卡片，icon 填 emoji</p>
        <div id="ed_homeCards"></div>
        <button class="btn ghost add-btn" data-add="homeCards">＋ 加一张卡片</button>
      </div>
    </section>

    <!-- 纪念日与时光轴 -->
    <section class="tab" data-panel="dates">
      <div class="panel">
        <h2>纪念日列表 anniversaries</h2>
        <p class="desc">type：once=一次性（过了显示已度过）；repeat=每年都过。农历勾上时 date 写农历月-日（如 3-8，闰月写 闰4-15）</p>
        <div id="ed_anniversaries"></div>
        <button class="btn ghost add-btn" data-add="anniversaries">＋ 加一个纪念日</button>
      </div>
      <div class="panel">
        <h2>时光轴 timeline</h2>
        <p class="desc">date 晚于今天的会显示"即将到来"样式</p>
        <div id="ed_timeline"></div>
        <button class="btn ghost add-btn" data-add="timeline">＋ 加一件大事</button>
      </div>
    </section>

    <!-- 情书与心愿 -->
    <section class="tab" data-panel="letters">
      <div class="panel">
        <h2>情书 letters</h2>
        <p class="desc">点开信封阅读的情书；body 支持换行</p>
        <div id="ed_letters"></div>
        <button class="btn ghost add-btn" data-add="letters">＋ 写一封</button>
      </div>
      <div class="panel">
        <h2>许愿瓶 wishes</h2>
        <p class="desc">心愿瓶里的心愿</p>
        <div id="ed_wishes"></div>
        <button class="btn ghost add-btn" data-add="wishes">＋ 加一个心愿</button>
      </div>
    </section>

    <!-- 题库与真心话 -->
    <section class="tab" data-panel="quiz">
      <div class="panel">
        <h2>默契问答 quiz（带标准答案）</h2>
        <p class="desc">答案下拉框直接选正确选项（会跟随选项文字实时更新）</p>
        <div id="ed_quiz"></div>
        <button class="btn ghost add-btn" data-add="quiz">＋ 加一题</button>
      </div>
      <div class="panel">
        <h2>默契度测试题 compatQuiz（无标准答案）</h2>
        <div id="ed_compatQuiz"></div>
        <button class="btn ghost add-btn" data-add="compatQuiz">＋ 加一题</button>
      </div>
      <div class="panel">
        <h2>真心话卡片 truthDares</h2>
        <p class="desc">每条一句，抽一张轮流回答</p>
        <div id="ed_truthDares"></div>
        <button class="btn ghost add-btn" data-add="truthDares">＋ 加一张</button>
      </div>
      <div class="panel">
        <h2>每日一问 dailyQuestions</h2>
        <p class="desc">每天按日期轮一题，双方看到同一题；两个人都答完才能看到对方的答案。想加题就往下加。</p>
        <div id="ed_dailyQuestions"></div>
        <button class="btn ghost add-btn" data-add="dailyQuestions">＋ 加一题</button>
      </div>
    </section>

    <!-- 相册管理 -->
    <section class="tab" data-panel="gallery">
      <div class="panel">
        <h2>上传照片</h2>
        <p class="desc">照片会存到服务器 assets/img/uploads/（更新网站不会删除），并自动加入相册"照片"分类</p>
        <input type="file" id="admPhotoInput" accept="image/*" multiple hidden>
        <button class="btn" id="admPhotoBtn">📷 选择照片上传</button>
        <span class="muted" id="admPhotoHint"></span>
      </div>
      <div class="panel">
        <h2>相册列表 gallery（含分类与说明）</h2>
        <div id="ed_gallery"></div>
        <button class="btn ghost add-btn" data-add="gallery">＋ 手动加一条（填已有图片路径）</button>
      </div>
      <div class="panel">
        <h2>访客上传的照片（服务器存储）</h2>
        <div id="visitorPhotos"></div>
      </div>
    </section>

    <!-- 留言与手写情书 -->
    <section class="tab" data-panel="content">
      <div class="panel">
        <h2>悄悄话留言板（服务器存储，跨设备可见）</h2>
        <div id="ctMessages"></div>
      </div>
      <div class="panel">
        <h2>手写情书（服务器存储）</h2>
        <div id="ctLetters"></div>
      </div>
      <div class="panel">
        <h2>时间胶囊（服务器存储）</h2>
        <p class="desc">写给未来的信：开启日之前前台看不到标题和正文，这里（管理员）可以看到全部。</p>
        <div id="ctCapsules"></div>
      </div>
      <div class="panel">
        <h2>每日一问的回答（服务器存储）</h2>
        <p class="desc">按日期列出双方的回答，可整日删除</p>
        <div id="ctDaily"></div>
      </div>
      <div class="panel">
        <h2>默契度测试回合（服务器存储）</h2>
        <p class="desc">双方都答完的回合会进入这里的历史，可查看或删除</p>
        <div id="ctCompat"></div>
      </div>
    </section>

    <!-- 备份与恢复 -->
    <section class="tab" data-panel="backup">
      <div class="panel">
        <h2>备份</h2>
        <p class="desc">把全部自定义数据（配置/留言/情书/照片记录/管理员账号）下载为一个 JSON 文件，妥善保存。</p>
        <button class="btn" id="backupBtn">⬇ 下载备份</button>
      </div>
      <div class="panel">
        <h2>恢复</h2>
        <p class="desc">选择之前下载的备份文件，覆盖恢复全部数据（谨慎操作）。</p>
        <input type="file" id="restoreInput" accept=".json,application/json" hidden>
        <button class="btn ghost" id="restoreBtn">⤴ 选择备份文件恢复</button>
      </div>
    </section>

    <!-- 账号 -->
    <section class="tab" data-panel="account">
      <div class="panel">
        <h2>修改管理员密码</h2>
        <div class="grid2">
          <div><label class="f">原密码</label><input type="password" id="pwOld" autocomplete="current-password"></div>
          <div><label class="f">新密码（至少 6 位）</label><input type="password" id="pwNew" autocomplete="new-password"></div>
        </div>
        <div><label class="f">再次输入新密码</label><input type="password" id="pwNew2" autocomplete="new-password" style="max-width:300px"></div>
        <button class="btn" id="pwBtn" style="margin-top:12px">修改密码</button>
      </div>
      <div class="panel">
        <h2>高级：直接编辑 JSON</h2>
        <p class="desc">不想用表单时，可在此直接改全部配置（与表单实时联动）。修改后点"应用"，再点右下角保存。</p>
        <textarea id="rawJson" rows="14" style="font-family:Consolas,monospace;font-size:12px"></textarea>
        <button class="btn ghost" id="rawApply" style="margin-top:8px">应用 JSON（校验后载入表单）</button>
      </div>
    </section>
  </main>

  <div class="savebar">
    <span class="state" id="saveState">就绪</span>
    <button class="btn" id="saveBtn">💾 保存全部修改</button>
  </div>

  <!-- 通知横幅容器：最新的在最上面，失败提示点一下才关 -->
  <div id="toastBox" class="toastbox" role="status" aria-live="polite"></div>
</div>

<script src="../api/config.php"></script>
<script>window.__PHOTO_BASE__ = "../";</script>
<script src="../assets/js/config.js"></script>
<script>
(function () {
  "use strict";

  /* ---------------- 状态 ---------------- */
  var DEFAULT_CONFIG = window.DEFAULT_CONFIG || {};
  var cfg = JSON.parse(JSON.stringify(CONFIG || {}));   // 工作副本（表单编辑这个）
  var cfgBaseline = {};                                 // 打开面板时的快照：用于"只保存改动过的键"
  var baseOverrides = {};                               // 打开面板时 config.json 里的原始覆盖（已修复历史遗留）
  var csrf = "";
  var loggedIn = false;
  var dirty = false;

  function esc(s) { return String(s == null ? "" : s); }
  // HTML 转义：拼进 innerHTML 的内容（访客留言/情书/照片说明）必须用它。
  // esc() 只做 null 兜底，用于 input.value 赋值（那边不能转义）
  function escHtml(s) {
    return esc(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }

  /* ---------------- 顶部通知横幅 ----------------
     toast(msg, kind)：kind = "ok"(默认) / "warn" / "err"，
     兼容旧的 toast(msg, true) → 错误。成功/警告会自动消失，
     失败必须点一下才关（重要提示不能被 2 秒自动吃掉）。 */
  var TOAST_META = {
    ok:   { ico: "✅", ms: 3200 },
    warn: { ico: "⚠️", ms: 6000 },
    err:  { ico: "⛔", ms: 0 }        // 0 = 不自动关闭
  };
  var TOAST_MAX = 4;

  function toast(msg, kind) {
    if (kind === true) kind = "err";                       // 旧调用点兼容
    if (kind !== "ok" && kind !== "warn" && kind !== "err") kind = "ok";
    var box = $("toastBox");
    if (!box) return;
    var meta = TOAST_META[kind];

    var el = document.createElement("div");
    el.className = "toast " + kind;
    var ico = document.createElement("span");
    ico.className = "ico"; ico.textContent = meta.ico;
    var txt = document.createElement("span");
    txt.className = "txt"; txt.textContent = msg;          // textContent：不解析 HTML
    var x = document.createElement("button");
    x.type = "button"; x.className = "x"; x.textContent = "✕";
    x.setAttribute("aria-label", "关闭提示");
    el.appendChild(ico); el.appendChild(txt); el.appendChild(x);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      el.classList.add("out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }
    el.addEventListener("click", close);
    x.addEventListener("click", function (e) { e.stopPropagation(); close(); });

    box.insertBefore(el, box.firstChild);                  // 最新一条在最上面
    while (box.children.length > TOAST_MAX) box.removeChild(box.lastChild);
    if (meta.ms) setTimeout(close, meta.ms);
    return el;
  }

  function closeAllToasts() {
    var box = $("toastBox");
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
  }

  /* ---------------- 底部状态栏 + 未保存提醒 ---------------- */
  function setState(kind, text) {
    var el = $("saveState");
    if (!el) return;
    el.textContent = text;
    el.className = "state" + (kind ? " " + kind : "");
  }
  function syncTitle() {
    document.title = (dirty ? "● " : "") + "管理员后台 · 情侣网站";
  }
  function markDirty() {
    dirty = true;
    setState("dirty", "有未保存的修改");
    var btn = $("saveBtn");
    if (btn) btn.classList.add("dirty");
    syncTitle();
  }
  function clearDirty(stamp) {
    dirty = false;
    setState("ok", stamp || "✅ 已保存");
    var btn = $("saveBtn");
    if (btn) btn.classList.remove("dirty");
    syncTitle();
  }
  /** 保存按钮上的即时反馈：显示一句话，过一会儿恢复 */
  function flashSaveBtn(text, ms) {
    var btn = $("saveBtn");
    if (!btn) return;
    btn.textContent = text;
    clearTimeout(flashSaveBtn._t);
    flashSaveBtn._t = setTimeout(function () { btn.textContent = "💾 保存全部修改"; }, ms);
  }
  function nowHM() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // 有未保存修改时离开页面 → 浏览器原生确认框（防误关丢修改）
  window.addEventListener("beforeunload", function (e) {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });

  // 服务端逐条校验：某条内容没填完整/格式错会被跳过（不会清空整组），这里汇总提示
  function skippedNote(j) {
    var sk = (j && j.skipped) || {};
    var keys = Object.keys(sk);
    if (!keys.length) return "";
    var n = keys.reduce(function (a, k) { return a + (sk[k] || 0); }, 0);
    return "；有 " + n + " 条内容没填完整或格式不对已跳过（" + keys.join("、") + "）";
  }

  function api(action, data, withCsrf) {
    var body = data || {};
    body.action = action;
    if (withCsrf !== false) body.csrf = csrf;
    return fetch("api.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status); return j; }); });
  }

  /* ---------------- 登录 ---------------- */
  function showLogin(installed) {
    $("appView").style.display = "none";
    $("loginView").style.display = "block";
    $("loginSub").textContent = installed ? "登录后可修改网站的全部配置与数据" : "请先访问 install.php 创建管理员账号";
    if (!installed) { $("lgUser").disabled = true; $("lgPass").disabled = true; $("lgBtn").disabled = true; }
  }
  $("lgBtn").addEventListener("click", function () {
    $("lgMsg").innerHTML = "";
    api("login", { username: $("lgUser").value.trim(), password: $("lgPass").value }, true)
      .then(function (j) {
        csrf = j.csrf; loggedIn = true;
        closeAllToasts();                       // 清掉登录前可能残留的提示
        $("whoLine").textContent = "已登录：" + j.username;
        bootApp();
      })
      .catch(function (e) { $("lgMsg").innerHTML = '<div class="msg err">' + escHtml(e.message) + "</div>"; });
  });
  $("lgPass").addEventListener("keydown", function (e) { if (e.key === "Enter") $("lgBtn").click(); });

  $("logoutBtn").addEventListener("click", function () {
    dirty = false;                 // 主动退出＝放弃修改，不要被"未保存"提醒拦住
    api("logout", {}, true).finally(function () { location.reload(); });
  });

  /* ---------------- 表单构建 ---------------- */
  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultRow(key) {
    switch (key) {
      case "messages": case "truthDares": case "dailyQuestions": return "";
      case "homeCards": return { icon: "💗", title: "", text: "", link: "home.html", linkText: "去看看 →" };
      case "anniversaries": return { icon: "🎉", title: "", date: "01-01", type: "repeat", lunar: false };
      case "timeline": return { date: "2026-01-01", icon: "⭐", title: "", text: "" };
      case "letters": return { date: "2026-01-01", title: "", body: "", sign: "" };
      case "wishes": return { title: "", text: "" };
      case "quiz": return { q: "", opts: ["", "", "", ""], a: 0 };
      case "compatQuiz": return { q: "", opts: ["", "", "", ""] };
      case "gallery": return { src: "assets/img/photo-1.svg", cat: "日常", cap: "" };
      default: return {};
    }
  }

  var FIELD_DEFS = {
    homeCards: [
      { k: "icon", label: "图标", type: "text" },
      { k: "title", label: "标题", type: "text" },
      { k: "text", label: "文字", type: "text", wide: true },
      { k: "link", label: "链接", type: "text" },
      { k: "linkText", label: "按钮文字", type: "text" },
    ],
    anniversaries: [
      { k: "icon", label: "图标", type: "text" },
      { k: "title", label: "名称", type: "text" },
      { k: "date", label: "日期", type: "text", ph: "05-20 或 2024-05-20 或 3-8" },
      { k: "type", label: "类型", type: "select", opts: [{ v: "repeat", t: "每年都过" }, { v: "once", t: "一次性" }] },
      { k: "lunar", label: "农历", type: "checkbox" },
    ],
    timeline: [
      { k: "date", label: "日期", type: "date" },
      { k: "icon", label: "图标", type: "text" },
      { k: "title", label: "标题", type: "text" },
      { k: "text", label: "内容", type: "text", wide: true },
    ],
    letters: [
      { k: "date", label: "日期", type: "date" },
      { k: "title", label: "标题", type: "text" },
      { k: "body", label: "正文（支持换行）", type: "textarea", wide: true },
      { k: "sign", label: "署名", type: "text" },
    ],
    wishes: [
      { k: "title", label: "心愿名", type: "text" },
      { k: "text", label: "说明", type: "text", wide: true },
    ],
    quiz: [
      { k: "q", label: "题目", type: "text", wide: true },
      { k: "opts", label: "选项", type: "opts" },
      { k: "a", label: "答案", type: "answer" },
    ],
    compatQuiz: [
      { k: "q", label: "题目", type: "text", wide: true },
      { k: "opts", label: "选项", type: "opts" },
    ],
    gallery: [
      { k: "src", label: "图片路径", type: "text", wide: true },
      { k: "cat", label: "分类", type: "text" },
      { k: "cap", label: "说明", type: "text" },
    ],
  };

  function buildList(containerId, key, fieldDefs) {
    var box = $(containerId);
    box.innerHTML = "";
    var list = cfg[key] || [];
    list.forEach(function (row, i) { appendRow(box, key, row, i, fieldDefs); });

    // 添加按钮
    document.querySelectorAll('[data-add="' + key + '"]').forEach(function (btn) {
      btn.onclick = function () {
        if (!cfg[key]) cfg[key] = [];
        cfg[key].push(defaultRow(key));
        appendRow(box, key, cfg[key][cfg[key].length - 1], cfg[key].length - 1, fieldDefs);
        markDirty();
      };
    });

    function appendRow(box, key, row, i, defs) {
      var div = document.createElement("div");
      div.className = "row";
      var controls = [];

      if (defs === null) {   // 纯字符串列表
        var cell = document.createElement("div");
        cell.className = "wide";
        var inp = document.createElement("input");
        inp.type = "text"; inp.value = esc(row);
        inp.addEventListener("input", function () { cfg[key][i] = inp.value; markDirty(); });
        cell.appendChild(inp);
        div.appendChild(cell);
      } else {
        defs.forEach(function (fd) {
          var cell = document.createElement("div");
          if (fd.wide) cell.className = "wide";
          var lab = document.createElement("label");
          lab.className = "f"; lab.textContent = fd.label;
          cell.appendChild(lab);
          var ctl;
          if (fd.type === "select") {
            ctl = document.createElement("select");
            fd.opts.forEach(function (o) {
              var op = document.createElement("option");
              op.value = o.v; op.textContent = o.t;
              ctl.appendChild(op);
            });
            ctl.value = esc(row[fd.k]);
            if (row.auto && fd.k === "type") { ctl.disabled = true; ctl.title = "自动计算：随'在一起的日期'变化"; }
            ctl.addEventListener("change", function () { row[fd.k] = ctl.value; markDirty(); });
          } else if (fd.type === "answer") {
            // quiz 正确答案下拉：直接显示选项内容（如「1 · 红玫瑰」）。
            // 值统一存数字下标——select.value 是字符串，直接存会让
            // 前台 game.js 的 === 严格比较静默判错（点对也判错）
            ctl = document.createElement("select");
            var syncAnswer = function () {
              var opts = (row.opts && row.opts.length) ? row.opts : ["", "", "", ""];
              var ai = parseInt(row[fd.k], 10);
              if (isNaN(ai) || ai < 0 || ai >= opts.length) ai = 0;
              ctl.innerHTML = "";
              opts.forEach(function (o, oi) {
                var op = document.createElement("option");
                op.value = String(oi);
                op.textContent = (oi + 1) + " · " + (o ? o : "（选项" + (oi + 1) + " 未填）");
                ctl.appendChild(op);
              });
              ctl.value = String(ai);
              row[fd.k] = ai;   // 旧数据存过字符串的，在此归一为数字
            };
            syncAnswer();
            ctl.addEventListener("change", function () { row[fd.k] = parseInt(ctl.value, 10) || 0; markDirty(); });
            // 选项文字改动时同步下拉框里的答案文案
            div.addEventListener("input", function (e) {
              if (e.target && e.target.closest && e.target.closest(".opts")) syncAnswer();
            });
          } else if (fd.type === "checkbox") {
            ctl = document.createElement("input");
            ctl.type = "checkbox"; ctl.checked = !!row[fd.k];
            ctl.addEventListener("change", function () { row[fd.k] = ctl.checked; markDirty(); });
            lab.style.display = "block";
          } else if (fd.type === "textarea") {
            ctl = document.createElement("textarea");
            ctl.rows = 4; ctl.value = esc(row[fd.k]);
            ctl.addEventListener("input", function () { row[fd.k] = ctl.value; markDirty(); });
          } else if (fd.type === "date") {
            ctl = document.createElement("input");
            ctl.type = "date"; ctl.value = esc(row[fd.k]);
            if (row.auto) { ctl.disabled = true; ctl.title = "自动计算：随'在一起的日期'变化"; }
            ctl.addEventListener("change", function () { row[fd.k] = ctl.value; markDirty(); });
          } else if (fd.type === "opts") {
            // 四个选项输入框
            var wrap = document.createElement("div");
            wrap.className = "opts";
            for (var oi = 0; oi < 4; oi++) {
              (function (oi) {
                var oin = document.createElement("input");
                oin.type = "text"; oin.placeholder = "选项" + oi;
                oin.value = esc(row[fd.k] && row[fd.k][oi]);
                oin.addEventListener("input", function () {
                  if (!row[fd.k]) row[fd.k] = ["", "", "", ""];
                  row[fd.k][oi] = oin.value; markDirty();
                });
                wrap.appendChild(oin);
              })(oi);
            }
            cell.appendChild(wrap);
            ctl = wrap;
          } else {
            ctl = document.createElement("input");
            ctl.type = "text"; ctl.value = esc(row[fd.k]);
            if (fd.ph) ctl.placeholder = fd.ph;
            if (row.auto && (fd.k === "date" || fd.k === "type")) { ctl.disabled = true; ctl.title = "自动计算：随'在一起的日期'变化"; }
            ctl.addEventListener("input", function () { row[fd.k] = ctl.value; markDirty(); });
          }
          if (fd.type !== "opts") cell.appendChild(ctl);
          div.appendChild(cell);
          controls.push(ctl);
        });
      }

      var btns = document.createElement("div");
      btns.className = "row-btns";
      var up = document.createElement("button"); up.textContent = "↑"; up.title = "上移";
      var dn = document.createElement("button"); dn.textContent = "↓"; dn.title = "下移";
      var del = document.createElement("button"); del.textContent = "✕"; del.title = "删除"; del.className = "del";
      up.addEventListener("click", function () { move(i, -1); });
      dn.addEventListener("click", function () { move(i, 1); });
      del.addEventListener("click", function () {
        if (!confirm("删除这一条吗？")) return;
        cfg[key].splice(i, 1);
        buildList(containerId, key, defs);
        markDirty();
      });
      btns.appendChild(up); btns.appendChild(dn); btns.appendChild(del);
      div.appendChild(btns);
      box.appendChild(div);

      function move(idx, dir) {
        var arr = cfg[key];
        var to = idx + dir;
        if (to < 0 || to >= arr.length) return;
        var t = arr[idx]; arr[idx] = arr[to]; arr[to] = t;
        buildList(containerId, key, defs);
        markDirty();
      }
    }
  }

  function bindBasic() {
    function bind(id, fn) {
      var el = $(id);
      el.addEventListener("input", function () { fn(el.value); markDirty(); });
    }
    bind("f_names_boy", function (v) { cfg.names.boy = v; });
    bind("f_names_girl", function (v) { cfg.names.girl = v; });
    bind("f_startDate", function (v) { cfg.startDate = v; });
    bind("f_password", function (v) { cfg.password = v; });
    bind("f_slogan", function (v) { cfg.slogan = v; });
    bind("f_greeting", function (v) { cfg.greeting = v; });
  }
  function fillBasic() {
    $("f_names_boy").value = esc(cfg.names && cfg.names.boy);
    $("f_names_girl").value = esc(cfg.names && cfg.names.girl);
    $("f_startDate").value = esc(cfg.startDate);
    $("f_password").value = esc(cfg.password);
    $("f_slogan").value = esc(cfg.slogan);
    $("f_greeting").value = esc(cfg.greeting);
  }

  /* ---------------- 保存（只传真正改动过的键） ----------------
     注意：cfg 是"已派生"的（名字已替换成真名、auto 日期已算好），
     直接与 DEFAULT_CONFIG 比较会把派生结果整体写进 data/config.json，
     从此占位名「待定A/待定B」被写死，改名字就再也不同步了。
     正确做法：以"打开面板时 config.json 里的覆盖"为底，
     只把用户这次真正改过的键覆盖上去。 */
  function refreezeValue(v, dv, names) {
    if (typeof v === "string") {
      if (typeof dv === "string") {
        var boy = (names && names.boy) || "";
        var girl = (names && names.girl) || "";
        if (dv.indexOf("待定A") !== -1 && boy) v = v.split(boy).join("待定A");
        if (dv.indexOf("待定B") !== -1 && girl) v = v.split(girl).join("待定B");
      }
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(function (x, i) { return refreezeValue(x, Array.isArray(dv) ? dv[i] : undefined, names); });
    }
    if (v && typeof v === "object") {
      var o = {};
      for (var k in v) o[k] = refreezeValue(v[k], (dv && typeof dv === "object") ? dv[k] : undefined, names);
      return o;
    }
    return v;
  }
  function collectOverrides() {
    var ov = deepClone(baseOverrides);        // 保留服务器上已有的自定义
    /* 反向冻结（refreezeValue）必须用"派生时实际用过的名字"：
       cfgBaseline 是 __deriveConfig 之后的快照，记的正是那些旧名字。
       不能用 cfg.names —— 那是用户此刻在表单里改成的新名字，拿它去匹配
       旧派生值必然匹配不上，旧真名会被原样写进磁盘，以后再改名就不同步了。 */
    var curNames = (cfgBaseline.names && typeof cfgBaseline.names === "object") ? cfgBaseline.names : null;
    Object.keys(DEFAULT_CONFIG).forEach(function (k) {
      if (JSON.stringify(cfg[k]) === JSON.stringify(cfgBaseline[k])) return;   // 这次没动过这个键
      if (cfg[k] === undefined) return;                                        // 该键已被移除 → 不提交
      // names 是唯一不参与占位名替换的键（见 __deriveConfig）；
      // 其余键拿到的是"已派生"的值（待定A/待定B 已换成真名），直接写盘会把
      // 占位名永久写死 —— 以后改名，这些地方就再也不跟着同步了。写回前先反向冻结。
      ov[k] = (k === "names") ? cfg[k] : refreezeValue(cfg[k], DEFAULT_CONFIG[k], curNames);
    });
    // 与默认值完全相同的键不必存（留空即回退到默认值）
    // 例外：解锁密码必须显式提交 —— 服务端把"缺 password 键"当异常并沿用
    // 磁盘现值，若这里按默认值省略，"把密码改回默认值"就会静默不生效。
    Object.keys(ov).forEach(function (k) {
      if (k === "password") return;
      if (JSON.stringify(ov[k]) === JSON.stringify(DEFAULT_CONFIG[k])) delete ov[k];
    });
    return ov;
  }
  $("saveBtn").addEventListener("click", function () {
    var btn = $("saveBtn");
    // 保存前校验：startDate 清空/纪念日日期格式错会让前台计时与卡片静默失效
    var problems = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate || "")) {
      problems.push("「在一起的日期」必须选完整日期（清空它会让全站计时和纪念日失效）");
    }
    (cfg.anniversaries || []).forEach(function (item) {
      if (!item) return;
      var title = item.title || "（未命名纪念日）";
      var ds = String(item.date || "");
      if (item.type === "once") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
          problems.push("纪念日「" + title + "」是一次性的，日期要填完整日期（如 2024-05-20）");
        }
      } else {
        var md = ds.replace(/^闰/, "").split("-");
        var mdOk = md.length === 2 && +md[0] >= 1 && +md[0] <= 12 && +md[1] >= 1 && +md[1] <= 31;
        if (!mdOk) {
          problems.push("纪念日「" + title + "」是每年都过，日期要填 月-日（如 05-20，农历闰月写 闰4-15）");
        }
      }
    });
    if (problems.length) {
      toast("无法保存：" + problems[0] + (problems.length > 1 ? "（还有 " + (problems.length - 1) + " 处问题，逐条修正）" : ""), "err");
      return;
    }
    btn.disabled = true; btn.textContent = "保存中…";
    setState("dirty", "保存中…");
    api("save_config", { overrides: collectOverrides() })
      .then(function (j) {
        var msg = "已保存（共 " + j.saved.length + " 项），前台页面刷新即可看到";
        var partial = (j.rejected && j.rejected.length) || (j.skipped && Object.keys(j.skipped).length);
        if (j.rejected && j.rejected.length) {
          msg += "；以下 " + j.rejected.length + " 项格式不对已忽略：" + j.rejected.join("、");
        }
        msg += skippedNote(j);
        if (j.warning) { msg += "；⚠️ " + j.warning; }
        clearDirty("✅ 已保存（" + nowHM() + "）");
        toast(msg, (partial || j.warning) ? "warn" : "ok");
        flashSaveBtn("✅ 已保存", 1600);
      })
      .catch(function (e) {
        setState("err", "⚠️ 保存失败");
        toast("保存失败：" + e.message, "err");
        flashSaveBtn("⚠️ 保存失败", 2500);
      })
      .finally(function () { btn.disabled = false; });
  });

  /* ---------------- 页签 ---------------- */
  document.querySelectorAll("#tabs button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.remove("active"); });
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      btn.classList.add("active");
      document.querySelector('[data-panel="' + btn.dataset.tab + '"]').classList.add("active");
      // 切到「账号设置」时刷新 JSON 预览：它只在 renderAll() 里写过一次，表单改动
      // 后不同步会让"与表单实时联动"这句话落空。放在页签切换而不是 markDirty()，
      // 是为了不打断正在这个文本域里输入的人。
      if (btn.dataset.tab === "account") $("rawJson").value = JSON.stringify(cfg, null, 2);
    });
  });

  /* ---------------- 相册：上传 / 访客照片 ---------------- */
  $("admPhotoBtn").addEventListener("click", function () { $("admPhotoInput").click(); });
  $("admPhotoInput").addEventListener("change", function () {
    var files = Array.prototype.slice.call($("admPhotoInput").files || []);
    $("admPhotoInput").value = "";
    if (!files.length) return;
    var done = 0;
    $("admPhotoHint").textContent = "上传中 0/" + files.length + " …";
    files.forEach(function (file) {
      if (!/^image\//.test(file.type)) { done++; return; }
      compressImage(file).then(function (dataUrl) {
        return api("photo_upload", { dataUrl: dataUrl, cap: "管理员上传" });
      }).then(function (j) {
        // 照片已记录进服务器 content.json（与访客上传同一条链路），
        // 相册页据此显示，在下方"访客上传的照片"里管理/删除。
        // 不再写进 config.gallery：两路拼接会让相册页同一张显示两次。
      }).catch(function (e) { toast("上传失败：" + e.message, true); }).finally(function () {
        done++;
        $("admPhotoHint").textContent = "上传中 " + done + "/" + files.length + " …";
        if (done === files.length) {
          $("admPhotoHint").textContent = "";
          loadContent();   // 刷新"访客上传的照片"列表（管理员上传的也在这里）
          toast("照片已上传，相册页即刻可见");
        }
      });
    });
  });

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var MAX = 1200, w = img.width, h = img.height;
          if (w > MAX || h > MAX) { var s = Math.min(MAX / w, MAX / h); w = Math.round(w * s); h = Math.round(h * s); }
          var canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.onerror = function () { reject(new Error("图片读取失败")); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error("图片读取失败")); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------------- 访客内容：留言 / 情书 / 照片 ---------------- */
  function fmtTs(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function loadContent() {
    api("get_content", {}).then(function (j) {
      renderVisitorPhotos(j.data.photos || []);
      renderCT(j.data.messages || [], "ctMessages", "留言", "messages");
      renderCT(j.data.letters || [], "ctLetters", "情书", "letters");
      renderCapsules(j.data.capsules || []);
      renderDaily(j.data.daily || []);
      renderCompat(j.data.compat || []);
    }).catch(function () { $("visitorPhotos").innerHTML = '<div class="msg err">加载失败</div>'; });
  }
  function renderCompat(list) {
    var box = $("ctCompat");
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="muted">还没有默契度回合</div>'; return; }
    var table = document.createElement("table");
    table.className = "ct";
    list.slice().reverse().forEach(function (r) {
      var st = r.status || "";
      var stLabel = st === "done" ? "✅ 已完成" : st === "waiting_b" ? "⏳ 等第二人" : "✍️ 等第一人";
      var roles = (r.a && r.b) ? r.a.role + " ♥ " + r.b.role : "";
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.innerHTML = stLabel + " <span class='muted'>" + escHtml(roles) + "</span>";
      if (st === "done" && r.a && r.b) {
        var same = 0, total = r.questions ? r.questions.length : 0;
        for (var i = 0; i < total; i++) if (r.a.answers[i] === r.b.answers[i]) same++;
        td1.innerHTML += " <b>" + Math.round(same / Math.max(1, total) * 100) + "%</b>";
      }
      var td2 = document.createElement("td");
      td2.className = "muted"; td2.textContent = fmtTs(r.updated || r.created || 0);
      var td3 = document.createElement("td");
      var del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除这个默契度回合？")) return;
        api("content_delete", { kind: "compat", uid: r.id })
          .then(function () { loadContent(); toast("已删除"); })
          .catch(function (e) { toast("删除失败：" + e.message, true); });
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }
  function renderVisitorPhotos(list) {
    var box = $("visitorPhotos");
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="muted">还没有访客上传的照片</div>'; return; }
    var table = document.createElement("table");
    table.className = "ct";
    list.slice().reverse().forEach(function (p) {
      var tr = document.createElement("tr");
      tr.innerHTML = "";
      var td1 = document.createElement("td");
      var img = document.createElement("img");
      img.className = "mini-thumb";
      img.src = window.lovePhotoUrl ? window.lovePhotoUrl(p.src) : p.src;
      img.loading = "lazy";
      td1.appendChild(img);
      var td2 = document.createElement("td");
      td2.innerHTML = escHtml(p.cap || "—") + '<div class="muted">' + fmtTs(p.ts) + "</div>";
      var td3 = document.createElement("td");
      var del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除这张照片（含服务器文件）？")) return;
        api("content_delete", { kind: "photos", uid: p.uid })
          .then(function () { loadContent(); toast("已删除"); })
          .catch(function (e) { toast("删除失败：" + e.message, true); });
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }
  function renderCT(list, boxId, label, kind) {
    var box = $(boxId);
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="muted">暂无' + label + "</div>"; return; }
    var table = document.createElement("table");
    table.className = "ct";
    list.slice().reverse().forEach(function (r) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.innerHTML = kind === "messages"
        ? "<b>" + escHtml(r.name) + "</b>：" + escHtml(r.text)
        : "<b>" + escHtml(r.title) + "</b> <span class='muted'>" + escHtml(r.date) + "</span><br>" + escHtml(r.sign ? "—— " + r.sign : "");
      var td2 = document.createElement("td");
      td2.className = "muted"; td2.textContent = fmtTs(r.ts);
      var td3 = document.createElement("td");
      var del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除这条" + label + "？")) return;
        api("content_delete", { kind: kind, uid: r.uid })
          .then(function () { loadContent(); toast("已删除"); })
          .catch(function (e) { toast("删除失败：" + e.message, true); });
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  /* ---------------- 备份 / 恢复 ---------------- */
  $("backupBtn").addEventListener("click", function () {
    api("backup", {}).then(function (j) {
      var blob = new Blob([JSON.stringify(j.backup, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      var d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = "love-backup-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + ".json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast("备份已下载");
    }).catch(function (e) { toast("备份失败：" + e.message, true); });
  });
  $("restoreBtn").addEventListener("click", function () { $("restoreInput").click(); });
  $("restoreInput").addEventListener("change", function () {
    var file = $("restoreInput").files && $("restoreInput").files[0];
    $("restoreInput").value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var backup;
      try { backup = JSON.parse(reader.result); } catch (e) { toast("备份文件解析失败", true); return; }
      if (!backup || typeof backup !== "object" || !("config" in backup)) { toast("不是有效的备份文件", true); return; }
      if (!confirm("确定用这个备份覆盖恢复全部数据？此操作不可撤销。")) return;
      var alsoAdmin = confirm(
        "备份里还含管理员账号与密码。\n\n" +
        "点「确定」= 同时恢复账号密码（如果你忘了旧密码会把自己锁在外面）；\n" +
        "点「取消」= 保留当前账号密码，只恢复内容。"
      );
      api("restore", { backup: backup, restore_admin: alsoAdmin })
        .then(function (j) {
          var msg = "✅ 恢复完成";
          if (j.missing_photos) {
            msg += "；" + j.missing_photos + " 张照片的图片文件不在服务器上已跳过（备份只存记录，不存图片文件）";
          }
          if (j.admin_skipped) msg += "；管理员账号密码未改动";
          if (j.compat_dropped) {
            msg += "；默契度记录里有 " + j.compat_dropped + " 条结构不合法已丢弃（避免整站脚本被畸形数据打断）";
          }
          if (j.rejected && j.rejected.length) {
            msg += "；以下 " + j.rejected.length + " 项配置格式不对已忽略：" + j.rejected.join("、");
          }
          msg += skippedNote(j);
          if (j.warning) msg += "；⚠️ " + j.warning;
          toast(msg, !!j.warning);
        })
        .catch(function (e) { toast("恢复失败：" + e.message, true); });
    };
    reader.readAsText(file);
  });

  /* ---------------- 账号 ---------------- */
  $("pwBtn").addEventListener("click", function () {
    var o = $("pwOld").value, n = $("pwNew").value, n2 = $("pwNew2").value;
    if (!o || !n) { toast("请填写原密码和新密码", true); return; }
    if (n !== n2) { toast("两次新密码不一致", true); return; }
    if (n.length < 6) { toast("新密码至少 6 位", true); return; }
    api("change_password", { old: o, new: n })
      .then(function () { toast("✅ 密码已修改"); $("pwOld").value = $("pwNew").value = $("pwNew2").value = ""; })
      .catch(function (e) { toast("修改失败：" + e.message, true); });
  });

  /* ---------------- 原始 JSON ---------------- */
  $("rawApply").addEventListener("click", function () {
    var parsed;
    try { parsed = JSON.parse($("rawJson").value); } catch (e) { toast("JSON 格式错误：" + e.message, true); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { toast("必须是配置对象", true); return; }
    // 只接受已知键
    var allowed = Object.keys(DEFAULT_CONFIG);
    var bad = Object.keys(parsed).filter(function (k) { return allowed.indexOf(k) === -1; });
    if (bad.length) { toast("包含未知键：" + bad.join(", "), true); return; }
    // 取"当前生效的解锁密码"：cfg 是 bootApp 从 get_config 拿到的真实配置；
    // 全局 CONFIG.password 只是内置默认值（密码从不下发给前端，见 api/config.php）
    var curPw = (typeof cfg.password === "string") ? cfg.password : "";
    cfg = parsed;
    baseOverrides = {};    // 显式整份替换 → 以这份 JSON 为准
    cfgBaseline = {};
    /* 缺 password 键就补回当前值：必须区分「键缺失=没写」与「值为空串=关闭门禁」。
       不补的话保存时该键不会被提交，服务端会沿用磁盘旧值（门禁不会误关），
       但表单里显示的值与实际不一致，容易让人误判。 */
    var pwFilled = false;
    if (!("password" in cfg)) { cfg.password = curPw; pwFilled = true; }
    renderAll();
    markDirty();
    toast(pwFilled ? "已载入表单（原 JSON 缺少 password 键，已补回当前解锁密码）" : "已载入表单，请检查后保存");
  });

  /* 时间胶囊：管理员能看到未开启的正文（前台在开启日前拿不到） */
  function renderCapsules(list) {
    var box = $("ctCapsules");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="muted">还没有时间胶囊</div>'; return; }
    var now = new Date();
    var todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    var table = document.createElement("table");
    table.className = "ct";
    list.slice().sort(function (a, b) { return String(a.openAt).localeCompare(String(b.openAt)); }).forEach(function (c) {
      var locked = String(c.openAt || "") > todayStr;
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.innerHTML =
        (locked ? "🔒 " : "📖 ") + "<b>" + escHtml(c.title || "") + "</b>" +
        ' <span class="muted">开启于 ' + escHtml(c.openAt || "") + (locked ? "（还没到）" : "（已开启）") + "</span>" +
        '<div class="muted" style="white-space:pre-wrap">' + escHtml(c.body || "") + "</div>" +
        (c.sign ? '<div class="muted">—— ' + escHtml(c.sign) + "</div>" : "");
      var td2 = document.createElement("td");
      td2.className = "muted"; td2.textContent = fmtTs(c.ts);
      var td3 = document.createElement("td");
      var del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除这个时间胶囊？")) return;
        api("content_delete", { kind: "capsules", uid: c.uid })
          .then(function () { loadContent(); toast("已删除"); })
          .catch(function (e) { toast("删除失败：" + e.message, true); });
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  /* 每日一问：按日期列出双方回答（题目由 dayNo 在前端解析） */
  function renderDaily(list) {
    var box = $("ctDaily");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<div class="muted">还没有回答记录</div>'; return; }
    var qs = (cfg && cfg.dailyQuestions) || [];
    var table = document.createElement("table");
    table.className = "ct";
    list.forEach(function (d) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      var qText = "";
      if (qs.length) {
        var i = ((d.dayNo % qs.length) + qs.length) % qs.length;
        qText = String(qs[i] || "");
      }
      var html = "<b>" + escHtml(d.date) + "</b>";
      if (qText) html += ' <span class="muted">' + escHtml(qText) + "</span>";
      (d.answers || []).forEach(function (a, i) {
        html += '<div class="muted" style="white-space:pre-wrap">答案 ' + (i + 1) + "：" + escHtml(a.text) + "</div>";
      });
      td1.innerHTML = html;
      var td2 = document.createElement("td");
      td2.className = "muted";
      td2.textContent = (d.answers && d.answers[0]) ? fmtTs(d.answers[0].ts) : "";
      var td3 = document.createElement("td");
      var del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("删除 " + d.date + " 的回答？")) return;
        api("content_delete", { kind: "daily", uid: d.date })
          .then(function () { loadContent(); toast("已删除"); })
          .catch(function (e) { toast("删除失败：" + e.message, true); });
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  /* ---------------- 初始化 ---------------- */
  function renderAll() {
    fillBasic();
    buildList("ed_messages", "messages", null);
    buildList("ed_homeCards", "homeCards", FIELD_DEFS.homeCards);
    buildList("ed_anniversaries", "anniversaries", FIELD_DEFS.anniversaries);
    buildList("ed_timeline", "timeline", FIELD_DEFS.timeline);
    buildList("ed_letters", "letters", FIELD_DEFS.letters);
    buildList("ed_wishes", "wishes", FIELD_DEFS.wishes);
    buildList("ed_quiz", "quiz", FIELD_DEFS.quiz);
    buildList("ed_compatQuiz", "compatQuiz", FIELD_DEFS.compatQuiz);
    buildList("ed_truthDares", "truthDares", null);
  buildList("ed_dailyQuestions", "dailyQuestions", null);
    buildList("ed_gallery", "gallery", FIELD_DEFS.gallery);
    $("rawJson").value = JSON.stringify(cfg, null, 2);
  }

  function bootApp() {
    api("get_config", {}).then(function (j) {
      var ovs = (j.overrides && typeof j.overrides === "object") ? j.overrides : {};
      var names = (ovs.names && typeof ovs.names === "object")
        ? { boy: ovs.names.boy || DEFAULT_CONFIG.names.boy, girl: ovs.names.girl || DEFAULT_CONFIG.names.girl }
        : DEFAULT_CONFIG.names;

      // 历史遗留修复：config.json 里若已把「待定A/待定B」写死成真名，先还原成占位名，
      // 这样以后改名仍能全站同步（显示效果不变，只是不再写死）
      var repaired = {};
      Object.keys(ovs).forEach(function (k) {
        if (k === "names" || !(k in DEFAULT_CONFIG)) return;
        var fixed = refreezeValue(ovs[k], DEFAULT_CONFIG[k], names);
        if (JSON.stringify(fixed) !== JSON.stringify(ovs[k])) repaired[k] = fixed;
      });

      // 以"服务器已有覆盖（修复后）"为底，派生出一份用于显示的工作副本
      var merged = deepClone(DEFAULT_CONFIG);
      Object.keys(ovs).forEach(function (k) { if (k in DEFAULT_CONFIG) merged[k] = deepClone(ovs[k]); });
      Object.keys(repaired).forEach(function (k) { merged[k] = deepClone(repaired[k]); });

      baseOverrides = {};
      Object.keys(merged).forEach(function (k) {
        if (JSON.stringify(merged[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) baseOverrides[k] = deepClone(merged[k]);
      });

      cfg = window.__deriveConfig ? window.__deriveConfig(merged) : merged;
      cfgBaseline = deepClone(cfg);

      $("loginView").style.display = "none";
      $("appView").style.display = "block";
      document.querySelector('#tabs button[data-tab="basic"]').click();
      renderAll();
      loadContent();
      if (Object.keys(repaired).length) {
        markDirty();
        toast("检测到历史上被写死的名字，点一次「保存全部修改」即可修复同步", "warn");
      }
    }).catch(function (e) { toast("加载配置失败：" + e.message, true); });
  }

  api("whoami", {}, false).then(function (j) {
    csrf = j.csrf;
    if (j.logged_in) {
      loggedIn = true;
      $("whoLine").textContent = "已登录：" + j.username;
      bootApp();
    } else {
      showLogin(j.installed);
    }
  }).catch(function (e) {
    showLogin(false);
    $("loginSub").textContent = "后台接口不可用：" + e.message;
  });

  bindBasic();
})();
</script>
</body>
</html>
