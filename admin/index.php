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
<?php /* 与 8 个前台页面同一枚内联图标：不声明 icon 时浏览器会去要 /favicon.ico，
   而仓库里没有这个文件 → 每次打开后台都留一条 404 + 一条控制台错误
   （第四轮 F-S4-05）。内联 data: URI，不新增文件、也不多发一次请求。 */ ?>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23f06292' d='M12 21s-6.7-4.35-9.33-8.11C.9 10.2 1.6 6.5 4.5 5.3c2.5-1.04 5.05.03 6.5 2.17 1.45-2.14 4-3.21 6.5-2.17 2.9 1.2 3.6 4.9 1.83 7.59C18.7 16.65 12 21 12 21z'/%3E%3C/svg%3E">
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
          <div><label class="f">解锁页密码（留空 = 直接进入）</label><input type="text" id="f_password" maxlength="40" placeholder="如 520520"><div class="muted">首尾空格会被自动忽略（保存前去掉）；想关掉门禁请把此框清空，而不是填空格。</div></div>
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
          <?php /* maxlength=64 必须与登录框（#lgPass）和服务端（change_password /
                   install.php）同一口径：长于 64 的口令存下去以后，登录框里根本
                   输不进那么长的串（粘贴也会被浏览器截断），password_verify() 必然
                   false —— 后台当场自锁，唯一出路是手改 data/admin.json（S4-01）。 */ ?>
          <div><label class="f">新密码（6-64 位）</label><input type="password" id="pwNew" maxlength="64" autocomplete="new-password"></div>
        </div>
        <div><label class="f">再次输入新密码</label><input type="password" id="pwNew2" maxlength="64" autocomplete="new-password" style="max-width:300px"></div>
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

  /* 会话中途失效（401）时的重新登录通道（F-S4-03）。
     旧行为：点保存 → 401 → 只弹一句"保存失败：未登录"，页面上没有重新登录入口，
     唯一的出路是刷新，而刷新会把刚敲的改动全丢掉。
     现在的行为：把被拦下的那次调用**挂起**，就地切到登录界面（带一句说明），
     登录成功后自动把刚才那次请求原样重放 —— 表单 DOM 一直没被重渲染，
     所以 collectOverrides() 读到的还是站主改过的值。 */
  var reauthWait = null;

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

  /* 这个公历月是否真的存在这一天（2000 是闰年，所以 2-29 会放行）。
     保存前的纪念日校验用它拦住 4-31 / 2-30 这类"这个月没有这一天"的写法 ——
     旧行为是放行，前台 new Date 静默进位到 5-01，卡片写 4-31 而倒计时在 5-01 归零。 */
  function dayExists(m, d) {
    var probe = new Date(2000, m - 1, d);
    return probe.getMonth() === m - 1 && probe.getDate() === d;
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

  /* 请求超时兜底（毫秒）。必须有：保存/上传按钮是"点下去先 disabled、请求回来再解开"，
     而移动网络下连接可能挂住（既不成功也不失败、没有 RST）—— 没有超时的话
     `.finally(...)` 永远不跑，按钮就永久禁用了，只能刷新页面重来（前端解锁按钮、
     loveServer 都踩过同一个坑）。文本类请求给 60 秒；照片是 base64（压缩后几百 KB），
     在免费主机 7–13KB/s 的链路上要几十秒到几分钟，所以上传那条路径显式给 4 分钟。 */
  var API_TIMEOUT_MS = 60000;
  var PHOTO_TIMEOUT_MS = 240000;

  /* 把 Response 包一层，让超时定时器**活到响应体读完**。
     为什么：fetch() 在**响应头**到达时就 resolve，若此时就 clearTimeout，调用方
     之后在 r.json() 上等响应体时（服务端/中间层只发头、body 挂在半开连接上）既没有
     超时也没有 abort，`.then/.catch` 一个都不跑 —— 提交按钮永久 disabled、界面永远
     停在"正在提交…"，正是超时兜底要消灭的那个故障（第七轮 S5-03 的同族第三份）。
     现在 json/text/arrayBuffer/blob settle（成功或失败）时才 clearTimeout；
     abort 落在 body 读取期会 reject 这些方法，调用方照常拿到 rejection。
     口径与前台两份实现（assets/js/config.js、assets/js/server.js 的 loveTimedFetch）
     互相点名、保持一致 —— 那两份由前台批次同口径修改。 */
  var aliveResponse = function (r, timer) {
    var settle = function () { clearTimeout(timer); };
    var wrap = function (p) {
      return p.then(function (v) { settle(); return v; },
                    function (e) { settle(); throw e; });
    };
    return {
      ok: r.ok, status: r.status, url: r.url, headers: r.headers,
      json:        function () { return wrap(r.json()); },
      text:        function () { return wrap(r.text()); },
      arrayBuffer: function () { return wrap(r.arrayBuffer()); },
      blob:        function () { return wrap(r.blob()); },
    };
  };

  /* 没有 AbortController 的内核（Chrome 42–65 / Firefox 39–56 / Safari 10.1–12.0）：
     旧实现直接退回裸 fetch ⇒ **连超时兜底一起消失**，负责复位界面的 .then/.catch 一个都不跑，
     "提交按钮永久 disabled、界面永远停在正在提交…"的老故障整站复活（第四轮 F-S5-02）。
     这里改成 Promise.race 的纯本地超时：只 reject 本地 Promise、不 abort 请求
     （没有 AbortController 也没法 abort），错误名与真 abort 一致，调用方不必分支。
     ⚠️ 这一支既然没有 signal，就**无法**中断响应体读取；它只覆盖到"连接+响应头"，
     口径与上面 aliveResponse 不同（能力所限），与前台两份实现的注释互相点名。 */
  var raceTimeout = function (p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        var err = new Error("请求超时（" + ms + "ms，本机不支持 AbortController）");
        err.name = "AbortError";
        reject(err);
      }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); },
             function (e) { clearTimeout(t); reject(e); });
    });
  };

  function api(action, data, withCsrf, timeoutMs, isRetry) {
    var body = data || {};
    body.action = action;
    if (withCsrf !== false) body.csrf = csrf;
    var ms = (timeoutMs === undefined) ? API_TIMEOUT_MS : timeoutMs;
    var opt = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    var p;
    if (ms && typeof AbortController === "function") {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
      opt.signal = ctrl.signal;
      /* 定时器不在头部到达时清掉 —— 交给 aliveResponse，在响应体 settle 时才 clearTimeout。 */
      p = fetch("api.php", opt).then(function (r) { return aliveResponse(r, timer); },
                                     function (e) { clearTimeout(timer); throw e; });
    } else if (ms) {
      /* 老浏览器没有 AbortController：旧实现直接退回裸 fetch，连超时兜底一起消失
         （按钮永久 disabled）。改成纯本地超时（第四轮 F-S5-02）。 */
      p = raceTimeout(fetch("api.php", opt), ms);
    } else {
      p = fetch("api.php", opt);      // 显式传 0：退回原行为（调用方自己负责）
    }
    return p.then(function (r) {
      return r.json().then(function (j) {
        /* 401＝会话中途失效（超时 / 口令被改过 / 服务器上的会话文件被清）。
           先走重新登录，登录成功后把这次调用**原样重放**（isRetry 防止死循环）。
           判据必须收窄到 error==="未登录"（服务端 love_require_login() 的唯一出口）：
           旧实现把**除 login 外的一切 401** 都当会话过期，而 change_password 的
           "原密码不对"当时也用 401 —— 管理员手误一次就被弹到登录页、看到"口令在
           别处被改过"，重新登录后还会把那个注定失败的请求重放一遍（第七轮 S4-02）。
           服务端现在用 400 + code=bad_old_password 表达业务错误，前端再按错误码
           收一道窄：会话失效的语义只由"未登录"承载。 */
        var sessionGone = (r.status === 401 && j && j.error === "未登录");
        if (sessionGone && action !== "login" && !isRetry) {
          return askReauth().then(function () { return api(action, data, withCsrf, timeoutMs, true); });
        }
        if (!r.ok || !j.ok) {
          /* 把响应体挂在 error 上再抛：`ok:false` 的响应往往带着**只有服务端才知道**的
             明细（restore 的 steps / *_dropped / admin_restored …）。旧实现只抛
             `j.error` 那一句话，调用方再想看明细也无从下手 —— 恢复备份"部分失败"
             时管理员正是靠这些字段才知道哪个文件已经写进去了（F-S4-04）。 */
          var err = new Error(j.error || "HTTP " + r.status);
          err.payload = j;
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  /** 挂起当前调用，切到"登录已过期"界面；登录成功后 resolve（调用方接着重放） */
  function askReauth() {
    if (reauthWait) return reauthWait.promise;      // 多个请求同时 401：只切一次、只等一次
    setState("err", "登录已过期");
    showLogin(true);
    $("lgMsg").innerHTML = '<div class="msg err">登录已过期（会话超时，或口令在别处被改过）。' +
      "页面上的改动**还留着** —— 重新登录后会自动接着保存。</div>";
    /* 旧会话已经死了，手里那个 csrf 也跟着作废：**登录请求自己**也要带一份新会话的 csrf
       （服务端的 require_csrf 比对的是当前会话里的值），否则站主输对密码也只会拿到
       "页面已过期，请刷新后重试" —— 那就又回到"只能刷新"的老路了。
       所以先匿名问一次 whoami（isRetry=true，避免自己再触发一次 askReauth）。 */
    api("whoami", {}, false, API_TIMEOUT_MS, true).then(function (j) {
      if (j && j.csrf) csrf = j.csrf;
    }).catch(function () {});
    var res;
    var promise = new Promise(function (r) { res = r; });
    reauthWait = { promise: promise, resolve: res };
    return promise;
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
        if (reauthWait) {
          /* 这是"会话过期后重新登录"：面板 DOM 里还压着没保存的改动，
             所以**不能** bootApp()（重渲染会把改动冲掉）。只把视图切回去，
             然后放行被挂起的那次请求 —— 它会带着新的 csrf 接着保存。 */
          var w = reauthWait;
          reauthWait = null;
          $("loginView").style.display = "none";
          $("appView").style.display = "";
          setState("dirty", "有未保存的修改");
          toast("已重新登录，正在继续刚才的操作…");
          w.resolve();
          return;
        }
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
    /* 解锁口令的长度上限必须与解锁页输入框（maxlength=40）一致：超长口令存进
       config.json 以后，界面上根本输不进那么长的串 —— 等于把自己关在门外
       （服务器侧 sanitize_cfg 现在也会拒绝并报「格式不对已忽略」，F-S1-02）。
       计数口径用 **String(...).length（UTF-16 码元）**，与 HTML maxlength 同尺 ——
       非 BMP 字符（emoji）算 2 个，输入框放不下的就判超长。旧实现用
       `Array.from(...).length` 按**码点**数（emoji 算 1），21 个 emoji 面板会放过、
       服务端却拒，两边打对台（第七轮 S1-04 尾巴）。文案也说明"按输入框字符数算"。 */
    if (String(cfg.password || "").trim() !== "" && String(cfg.password).trim().length > 40) {
      problems.push("解锁口令最多 40 个字符（按解锁页输入框能输入的字符数算，一个 emoji 记 2 个字符），当前是 " +
        String(cfg.password).trim().length + " 个 —— 超长的口令存下去会永远解不开锁");
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
        } else if (!item.lunar && !dayExists(+md[0], +md[1])) {
          /* 4-31 / 2-30 / 6-31 这类"这个月没有这一天"：以前放行，前台会静默进位到 5-01
             （卡片照抄 4-31、倒计时却在 5-01 归零并报"就是今天"），导出的 .ics 里
             DTSTART 与 RRULE 还会自相矛盾、客户端一年都不触发。农历条目不走这条判据
             （农历「三十」在只有 29 天的月份里是合法的，前台按该月最后一天夹取）。 */
          problems.push("纪念日「" + title + "」填的 " + ds + " 这个月没有这一天。" +
            "农历三十请直接写 30（该农历月只有 29 天时前台按该月最后一天算）");
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
    var done = 0, skipped = 0, upOk = 0;
    $("admPhotoHint").textContent = "上传中 0/" + files.length + " …";
    /* 每个文件都必须走一次 settle()。非图片那条路径原来只 `done++; return;`，
       而"清空提示 + 刷新列表 + 收尾提示"整块写在**图片 Promise 的 .finally 里**
       —— 于是「只选非图片文件」时 done 当场等于 files.length，提示却永远停在
       「上传中 0/N …」，选文件的人不知道到底传没传（第五轮 N11）。
       收尾逻辑抽成一处，跳过与完成两条路径共用。 */
    function settle() {
      done++;
      if (done < files.length) {
        $("admPhotoHint").textContent = "上传中 " + done + "/" + files.length + " …";
        return;
      }
      $("admPhotoHint").textContent = "";
      if (upOk > 0) {
        loadContent();   // 刷新"访客上传的照片"列表（管理员上传的也在这里）
        toast("照片已上传，相册页即刻可见");
      } else if (skipped === files.length) {
        toast("选中的不是图片文件，没有上传", "warn");
      }
    }
    files.forEach(function (file) {
      if (!/^image\//.test(file.type)) { skipped++; settle(); return; }
      compressImage(file).then(function (dataUrl) {
        return api("photo_upload", { dataUrl: dataUrl, cap: "管理员上传" }, true, PHOTO_TIMEOUT_MS);
      }).then(function (j) {
        upOk++;
        // 照片已记录进服务器 content.json（与访客上传同一条链路），
        // 相册页据此显示，在下方"访客上传的照片"里管理/删除。
        // 不再写进 config.gallery：两路拼接会让相册页同一张显示两次。
      }).catch(function (e) { toast("上传失败：" + e.message, true); }).finally(settle);
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
        /* 答案可能是 null（lib/compat.php 的 compat_sanitize_side 允许，从简化备份恢复
           也可能只带状态不带答案）。旧写法直接 r.a.answers[i] 会抛 TypeError，把
           loadContent 整个中断，相册/留言/胶囊/每日/默契几个面板一起停在那不渲染。
           光加 `|| []` 不够 —— 两边都是空数组时 `undefined === undefined` 为真，
           会把缺失答案的回合算成 100%「完全一致」，比不显示更误导。所以**只有两侧
           都是数组才计算百分比**，否则如实标注答案缺失。

           ⚠️ 分母/命中的口径必须与接口（lib/compat.php 的 compat_pct()）**同源**：
           那边 `total = count(a侧答案)`、且只在下标**两侧都有**时才计数（`array_key_exists`）；
           旧实现这里取 `r.questions.length` 当分母、并只判 `ansA[i] === ansB[i]`，
           于是一旦 a 侧答案比题数短（历史/旧备份数据），面板给出的百分比与结果页
           对不上（第七轮 PHP-B 残留：renderCompat 与 compat_pct 不同源）。
           这里改成与 compat_pct 逐字同口径：分母 = a 侧答案数，命中要求 b 侧也有该下标。 */
        var ansA = Array.isArray(r.a.answers) ? r.a.answers : null;
        var ansB = Array.isArray(r.b.answers) ? r.b.answers : null;
        var total = ansA ? ansA.length : 0;
        if (ansA && ansB && total > 0) {
          var same = 0;
          for (var i = 0; i < total; i++) {
            if (i < ansB.length && ansA[i] === ansB[i]) same++;
          }
          td1.innerHTML += " <b>" + Math.round(same / Math.max(1, total) * 100) + "%</b>";
        } else {
          td1.innerHTML += " <span class='muted'>（答案缺失）</span>";
        }
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
          /* 备份里 admin 块**结构不合法**（例如 pass_hash 是数组）时会被整块跳过：
             单独说一句 —— 站主勾了"确定＝同时恢复账号密码"却什么都没发生，
             旧实现对此一个字都不提（第七轮 S4-05）。 */
          if (j.admin_skipped_invalid) {
            msg += "；备份里的管理员账号结构不合法已跳过，账号密码仍是当前这份（没变）";
          }
          if (j.compat_dropped) {
            msg += "；默契度记录里有 " + j.compat_dropped + " 条结构不合法已丢弃（避免整站脚本被畸形数据打断）";
          }
          /* 留言/情书/胶囊/每日一问里被丢掉的条目也必须说出来：恢复是覆盖语义，
             磁盘上的旧数据此刻已经不可逆地没了，只回一句"恢复完成"会把数据损失
             藏起来（照片的缺图与默契度的丢弃早就各自报了数字，只有这两类没报）。 */
          if (j.content_dropped && typeof j.content_dropped === "object") {
            var KIND_LABEL = { messages: "留言", letters: "情书", capsules: "时间胶囊", photos: "照片" };
            var dropParts = [];
            ["messages", "letters", "capsules", "photos"].forEach(function (k) {
              if (j.content_dropped[k]) dropParts.push(KIND_LABEL[k] + " " + j.content_dropped[k] + " 条");
            });
            if (dropParts.length) msg += "；" + dropParts.join("、") + "结构不合法已丢弃";
          }
          /* 备份里某一类**整块**不是数组（null / 字符串 / 少写了那个键）时，它会
             被当成空列表恢复 —— 磁盘上那一类原有的记录全部被覆盖清空，且不可逆。
             这一格过去连数字都不计（第七轮 S4-03），必须点名说出来。 */
          if (j.content_blocks_bad && j.content_blocks_bad.length) {
            var BAD_LABEL = { messages: "留言", letters: "情书", capsules: "时间胶囊", photos: "照片" };
            msg += "；⚠️ 备份里 " + j.content_blocks_bad.map(function (k) { return BAD_LABEL[k] || k; }).join("、")
                 + " 整块格式不对，已按空列表恢复（磁盘上原有的这部分记录已被覆盖清空）";
          }
          if (j.daily_dropped) {
            msg += "；每日一问里有 " + j.daily_dropped + " 项记录结构不合法已丢弃";
          }
          if (j.rejected && j.rejected.length) {
            msg += "；以下 " + j.rejected.length + " 项配置格式不对已忽略：" + j.rejected.join("、");
          }
          msg += skippedNote(j);
          /* 备份里**没有**这一块（老备份缺 daily / 手工精简过的备份缺 compat / 没有
             admin 块）时，服务端一个字节都不写、磁盘保持原样 —— 成功路径过去对此
             完全不提，站主以为"覆盖恢复全部数据"已经兑现（第七轮 S4-05）。 */
          if (j.not_written && j.not_written.length) {
            msg += "；未写入（备份里没有或格式不对，磁盘上原有的保持原样）：" + j.not_written.join("、");
          }
          if (j.warning) msg += "；⚠️ " + j.warning;
          /* 有任何"丢了东西/没写进去"的项时按警告展示（6 秒后自动消失的那一档），
             纯成功才是绿色。否则这些损失会跟在一句绿字后面被顺手忽略。 */
          var lossy = !!(j.missing_photos || j.compat_dropped || j.daily_dropped
            || (j.content_dropped && Object.keys(j.content_dropped).length)
            || (j.content_blocks_bad && j.content_blocks_bad.length)
            || (j.not_written && j.not_written.length)
            || j.admin_skipped_invalid);
          toast(msg, (j.warning || lossy) ? "warn" : "ok");
        })
        .catch(function (e) {
          /* 恢复是**逐文件覆盖**的：`ok:false` 只说明"没全成"，不说明"什么都没变"。
             后端现在会逐项回报每个文件的真实结果（steps），这里必须把它显示出来 ——
             旧实现只弹一句"恢复失败：部分写入失败"，管理员据此以为一切照旧，
             而 config.json（含解锁口令）很可能已经换掉了（F-S4-04）。 */
          var p = e && e.payload;
          if (p && p.steps && typeof p.steps === "object") {
            var done = [], bad = [];
            Object.keys(p.steps).forEach(function (k) { (p.steps[k] ? done : bad).push(k); });
            var m = "⚠️ 恢复未全部完成：";
            m += done.length ? "已写进服务器：" + done.join("、") + "；" : "一个文件都没写进去；";
            if (bad.length) m += "写失败：" + bad.join("、") + "；";
            m += p.admin_restored ? "管理员账号已换成备份里那份（请用备份里的口令登录）"
                                  : "管理员账号仍是当前这份（口令没变）";
            toast(m, "err");
            var extra = [];
            if (p.missing_photos) extra.push(p.missing_photos + " 张照片的图片文件不在服务器上已跳过");
            if (p.content_dropped && typeof p.content_dropped === "object") {
              var KIND_LABEL = { messages: "留言", letters: "情书", capsules: "时间胶囊", photos: "照片" };
              var parts = [];
              Object.keys(p.content_dropped).forEach(function (k) {
                if (p.content_dropped[k]) parts.push((KIND_LABEL[k] || k) + " " + p.content_dropped[k] + " 条");
              });
              if (parts.length) extra.push(parts.join("、") + "结构不合法已丢弃");
            }
            if (p.content_blocks_bad && p.content_blocks_bad.length) {
              var BAD_LABEL = { messages: "留言", letters: "情书", capsules: "时间胶囊", photos: "照片" };
              extra.push(p.content_blocks_bad.map(function (k) { return BAD_LABEL[k] || k; }).join("、")
                + " 整块格式不对，已按空列表恢复（磁盘上原有的这部分记录已被覆盖清空）");
            }
            if (p.not_written && p.not_written.length) {
              extra.push("未写入（备份里没有或格式不对，磁盘上原有的保持原样）：" + p.not_written.join("、"));
            }
            if (p.admin_skipped_invalid) extra.push("备份里的管理员账号结构不合法已跳过，账号密码仍是当前这份");
            if (p.daily_dropped) extra.push("每日一问 " + p.daily_dropped + " 项结构不合法已丢弃");
            if (p.compat_dropped) extra.push("默契度 " + p.compat_dropped + " 条结构不合法已丢弃");
            if (p.warning) extra.push(String(p.warning));
            if (extra.length) toast(extra.join("；"), "warn");
            return;
          }
          toast("恢复失败：" + e.message, true);
        });
    };
    reader.readAsText(file);
  });

  /* ---------------- 账号 ---------------- */
  $("pwBtn").addEventListener("click", function () {
    var o = $("pwOld").value, n = $("pwNew").value, n2 = $("pwNew2").value;
    if (!o || !n) { toast("请填写原密码和新密码", true); return; }
    if (n !== n2) { toast("两次新密码不一致", true); return; }
    /* 长度口径与登录框（#lgPass maxlength=64）、服务端（change_password 与
       install.php）三处同一把尺。上限这一侧尤其重要：设出一个 >64 字符的口令，
       登录框永远输不进那么长的串 → password_verify() 必然 false → 后台自锁，
       只能手改 data/admin.json 才救得回来（第七轮 S4-01）。前端先拦一道（省一次
       往返、文案更直白），服务端仍是权威（u_len($new) > 64 → 400）。 */
    if (n.length < 6) { toast("新密码至少 6 位", true); return; }
    if (n.length > 64) { toast("新密码最多 64 位（登录框也就能输入 64 个字符）", true); return; }
    api("change_password", { old: o, new: n })
      .then(function () { toast("✅ 密码已修改"); $("pwOld").value = $("pwNew").value = $("pwNew2").value = ""; })
      .catch(function (e) { toast("修改失败：" + e.message, true); });
  });

  /* ---------------- 原始 JSON ---------------- */
  /* 形状判据直接取自 DEFAULT_CONFIG 自己（数组 / 对象 / 标量），不另建一张
     会漂移的类型表；只比"类别"、不细究字符串还是数字 —— 后者面板照样能渲染，
     最终口径由服务端 sanitize_cfg 收口。要挡的是"会让面板抛错"的那几类。 */
  function cfgShape(v) {
    if (Array.isArray(v)) return "array";
    if (v === null) return "null";
    if (typeof v === "object") return "object";
    return "scalar";
  }
  var CFG_SHAPE_NAME = { array: "列表", object: "对象", scalar: "字符串/数字", null: "空值" };
  function cfgShapeErrors(parsed) {
    var bad = [];
    Object.keys(parsed).forEach(function (k) {
      var def = DEFAULT_CONFIG[k], want = cfgShape(def), got = cfgShape(parsed[k]);
      if (want !== got) {
        bad.push(k + "（应为" + CFG_SHAPE_NAME[want] + "，实际是" + CFG_SHAPE_NAME[got] + "）");
        return;
      }
      /* 数组还要看元素类别：homeCards/quiz 这类是"对象列表"，粘成字符串数组
         （["abc"]）会让 appendRow 去读写 row 的属性 → 编辑时又抛一次错。 */
      if (want === "array" && def.length && parsed[k].length) {
        var wantEl = cfgShape(def[0]);
        for (var i = 0; i < parsed[k].length; i++) {
          if (cfgShape(parsed[k][i]) !== wantEl) {
            bad.push(k + " 第 " + (i + 1) + " 项（应为" + CFG_SHAPE_NAME[wantEl]
                     + "，实际是" + CFG_SHAPE_NAME[cfgShape(parsed[k][i])] + "）");
            break;
          }
        }
      }
    });
    return bad;
  }

  $("rawApply").addEventListener("click", function () {
    var parsed;
    try { parsed = JSON.parse($("rawJson").value); } catch (e) { toast("JSON 格式错误：" + e.message, true); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { toast("必须是配置对象", true); return; }
    // 只接受已知键
    var allowed = Object.keys(DEFAULT_CONFIG);
    var bad = Object.keys(parsed).filter(function (k) { return allowed.indexOf(k) === -1; });
    if (bad.length) { toast("包含未知键：" + bad.join(", "), true); return; }
    /* 键的名字对还不够，**类型**也得对：{"messages":"abc"} 这种键名合法但类型错的
       JSON 会让 renderAll() 在 buildList 里对字符串调 .forEach → TypeError 抛到
       回调外，而抛错点在 markDirty()/toast() 之前 —— 用户看到的是"点了一下没反应、
       下面几块内容凭空没了"，一条提示都没有；更糟的是 cfg 那时已被换成坏对象，
       再点「保存全部修改」就会把没粘进去的键整键从磁盘削掉（第四轮 F-S4-01）。 */
    var wrong = cfgShapeErrors(parsed);
    if (wrong.length) { toast("这些键的类型不对：" + wrong.join("；"), true); return; }
    // 取"当前生效的解锁密码"：cfg 是 bootApp 按 get_config 的磁盘覆盖算出来的当前值，
    // 磁盘上没有 password 键时它已被显式置成空串（= 门禁关闭），不会沿用内置默认口令。
    // 空串的语义就是"关闭门禁"（与 config.js 的说明、服务端 love_gate_password() 一致）。
    var curPw = (typeof cfg.password === "string") ? cfg.password : "";
    /* 先记下旧状态：万一 renderAll() 仍因未预料到的形状抛错（校验器不可能穷尽
       前端每一处读取），也要把 cfg 原样退回并重画一遍 —— 绝不能让面板停在
       "配置已被换坏、界面还半渲染"的状态，那是最难排查的一种。 */
    var prevCfg = cfg, prevBase = baseOverrides, prevBaseline = cfgBaseline;
    cfg = parsed;
    baseOverrides = {};    // 显式整份替换 → 以这份 JSON 为准
    cfgBaseline = {};
    /* 缺 password 键就补回当前值：必须区分「键缺失=没写」与「值为空串=关闭门禁」。
       不补的话保存时该键不会被提交，服务端会沿用磁盘旧值（门禁不会误关），
       但表单里显示的值与实际不一致，容易让人误判。 */
    var pwFilled = false;
    if (!("password" in cfg)) { cfg.password = curPw; pwFilled = true; }
    try {
      renderAll();
    } catch (e) {
      cfg = prevCfg; baseOverrides = prevBase; cfgBaseline = prevBaseline;
      try { renderAll(); } catch (e2) { /* 退不回去也不能再抛，界面保持可用 */ }
      toast("这份 JSON 无法载入（" + e.message + "），已保持原配置", true);
      return;
    }
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
    /* 与前台（assets/js/daily.js）和服务端（lib/config.php 的 dailyQuestions
       清洗）同一口径：空/空白题一律不算题。面板这里若不筛，题库里只要有一个
       空项，往下的下标就整体错位 —— 标出来的"当天题目"不是两人实际看到的那道。 */
    var qs = ((cfg && cfg.dailyQuestions) || []).filter(function (x) { return x && String(x).trim(); });
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
      /* 解锁密码：磁盘上没有这个键 = 门禁关闭（服务端 love_gate_password() 读不到
         键就返回空串）。绝不能让它沿用 DEFAULT_CONFIG 里的内置默认值 "520520"，
         否则会出现两个错：
           ① 面板密码框显示 520520，管理员以为站点受保护，其实门禁是关的；
           ② rawApply 会把 curPw="520520" 当成"当前值"补回，一个不含 password 的
              配置粘进去再保存，就把公开文档里的默认口令写进 config.json 并轮换
              密钥 —— 门禁被"打开"，口令却是谁都知道的那个。
         （磁盘上真存着 password 键时 ovs 里就有，上面这行不会覆盖它。） */
      if (!Object.prototype.hasOwnProperty.call(ovs, "password")) merged.password = "";

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
      /* get_config 现在与前台同一套净化口径：结构不合法（例如手改 config.json 把
         messages 写成字符串）的键会被丢弃并回退默认值。必须把这件事讲出来 ——
         否则管理员看到的是"我填的内容变成了默认值"，却没有任何线索。
         注意这里只提示、不自动保存：要不要把净化后的版本落盘由管理员决定。 */
      var badCfg = [];
      if (j.rejected && j.rejected.length) badCfg.push("格式不对已回退默认值：" + j.rejected.join("、"));
      if (j.skipped && typeof j.skipped === "object") {
        Object.keys(j.skipped).forEach(function (k) {
          if (j.skipped[k]) badCfg.push(k + " 里有 " + j.skipped[k] + " 条被丢弃");
        });
      }
      if (badCfg.length) toast("配置里有 " + badCfg.join("；") + "（多为手工编辑 data/config.json 造成）", "warn");
      /* config.json **解析不出来**时，服务端只能回默认值：下面这段表单里显示的
         名字/日期/情话/纪念日/题库全部是默认值，不是站主填过的内容。旧实现对此
         一声不响（rejected/skipped 都是空的，上面那条也不会触发），站主看到的是
         "我的配置全变回去了"，然后重新填一遍去保存 —— 而服务端为了保护数据会
         拒绝覆盖，只回一句"保存失败（data 目录不可写？）"，把人引去查主机权限
         （第七轮 S4-07）。所以这里必须明确说是文件坏了。 */
      if (j.broken) {
        toast("data/config.json 内容损坏（读不出合法的配置对象），下面显示的是**默认值**，不是你的配置。\n" +
              "请用备份恢复，或按 README 手工修正该文件；在修好之前保存会被拒绝（不会覆盖你的数据）。", "err");
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
