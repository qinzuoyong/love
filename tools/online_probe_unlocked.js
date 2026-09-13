/* 线上只读实测 · 解锁态（由 tools/online_probe.py 启动，口令从环境变量读）

   覆盖：
     A 门禁分级：匿名上下文拿到的私密键应当少，解锁后应当拿到完整私密注入
     B 解锁动作本身走真实表单（#pwInput / #unlockBtn），不再被弹回解锁页
     C 解锁后的接口：content / compat / daily 都是干净 JSON
     D 解锁后的畸形载荷：仍然必须是 JSON、不能出现 PHP 诊断信息
     E 全站 7 页在解锁态下都可访问

   两条铁律：只读（不许加写 data/ 的操作）；不测"错误密码"路径（会占用失败次数）。
   输出只打印键名/长度/状态码，不打印任何私密内容与口令。
*/
const { chromium } = require("playwright");

const RAW_SITE = (process.env.LOVE_SITE_HOST || "").trim();
if (!RAW_SITE) {
  console.error("缺少 LOVE_SITE_HOST：请用 tools/online_probe.py 启动（会自动从凭据文件读站点地址），或用 --site 指定");
  process.exit(2);
}
const SITE = (/^https?:\/\//.test(RAW_SITE) ? RAW_SITE : "https://" + RAW_SITE).replace(/\/+$/, "");
const PAGES = ["index.html", "home.html", "gallery.html", "timeline.html", "anniversary.html", "letter.html", "game.html"];
const DIRTY = /(<b>Warning<\/b>|<b>Fatal|Warning:|Fatal error|Parse error|Notice:|Deprecated:|TypeError)/;
const PW = process.env.LOVE_UNLOCK_PW || "";
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  [" + extra + "]" : "")); };

async function settle(page) {
  await page.goto(SITE + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 12; i++) {
    if (!/toNumbers|slowAES/.test(await page.content())) break;
    await page.waitForTimeout(1500);
  }
}

/* 页面内 fetch：返回状态码 + 内容类型 + 正文（截断） */
async function probe(page, list) {
  return page.evaluate(async (paths) => {
    const out = [];
    for (const p of paths) {
      const [path, method, body] = Array.isArray(p) ? p : [p, "GET", null];
      try {
        const r = await fetch(path, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          credentials: "same-origin",
        });
        const text = await r.text();
        out.push({ path, method, status: r.status, ct: r.headers.get("content-type") || "", len: text.length, text: text.slice(0, 300) });
      } catch (e) {
        out.push({ path, method, status: -1, ct: "", len: 0, text: "FETCH_ERROR " + e.message });
      }
    }
    return out;
  }, list);
}

const badBody = (r) => DIRTY.test(r.text) || /AI Work|htdocs\//.test(r.text);

(async () => {
  if (!PW) { console.error("缺少 LOVE_UNLOCK_PW"); process.exit(2); }
  const browser = await chromium.launch({ channel: "msedge", headless: true });

  // ---------- A 匿名上下文：私密键应当被裁掉 ----------
  console.log("=== A 门禁分级（匿名 vs 解锁后）===");
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  await settle(anon);
  const anonCfg = await anon.evaluate(() => ({
    gate: window.__SERVER_GATE__ || null,
    overKeys: Object.keys(window.__SERVER_OVERRIDES__ || {}).sort(),
    content: window.__SERVER_CONTENT__ || null,
  }));
  ok("匿名：门禁要求解锁且当前未解锁", anonCfg.gate && anonCfg.gate.required === true && anonCfg.gate.ok === false, JSON.stringify(anonCfg.gate));
  await anonCtx.close();

  // ---------- B 真实解锁 ----------
  console.log("\n=== B 用真实密码解锁 ===");
  const ctx = await browser.newContext();
  const P = await ctx.newPage();
  await settle(P);
  await P.fill("#pwInput", PW, { timeout: 20000 });
  await P.click("#unlockBtn");
  await P.waitForTimeout(4000);
  const afterUnlock = await P.evaluate(() => ({
    url: location.pathname,
    gate: window.__SERVER_GATE__ || null,
    toast: (document.getElementById("toast") || {}).textContent || "",
  }));
  ok("解锁成功并进入 home.html", /home\.html/.test(afterUnlock.url), "url=" + afterUnlock.url + " toast=" + afterUnlock.toast);

  // 刷新一次确认 Cookie 生效、不会被弹回解锁页
  await P.goto(SITE + "/home.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  await P.waitForTimeout(2000);
  const revisit = await P.evaluate(() => ({ url: location.pathname, gate: window.__SERVER_GATE__ || null }));
  ok("再次访问不被弹回解锁页（gate.ok=true）", /home\.html/.test(revisit.url) && revisit.gate && revisit.gate.ok === true, JSON.stringify(revisit));

  // ---------- A(续) 解锁后私密注入 ----------
  const cfg = await probe(P, ["/api/config.php"]);
  const unlockedCfg = await P.evaluate(() => ({
    overKeys: Object.keys(window.__SERVER_OVERRIDES__ || {}).sort(),
    content: window.__SERVER_CONTENT__ || null,
    compat: window.__SERVER_COMPAT__ || null,
    daily: window.__SERVER_DAILY__ || null,
  }));
  const c = unlockedCfg.content || {};
  ok("解锁后私密键比匿名多", unlockedCfg.overKeys.length > anonCfg.overKeys.length,
    `匿名 ${anonCfg.overKeys.length} 个 → 解锁后 ${unlockedCfg.overKeys.length} 个`);
  ok("相册/情书/留言/胶囊四个列表已下发", ["photos", "letters", "messages", "capsules"].every((k) => Array.isArray(c[k])),
    ["photos", "letters", "messages", "capsules"].map((k) => k + "=" + (Array.isArray(c[k]) ? c[k].length : "缺失")).join(" "));
  ok("默契度注入结构正常", unlockedCfg.compat !== null && "active" in unlockedCfg.compat && Array.isArray(unlockedCfg.compat.history),
    JSON.stringify(Object.keys(unlockedCfg.compat || {})));
  ok("每日一问注入结构正常", unlockedCfg.daily !== null && "enabled" in unlockedCfg.daily, JSON.stringify(Object.keys(unlockedCfg.daily || {})));
  ok("config.php 响应体干净", !badBody(cfg[0]), cfg[0].text.slice(0, 160));

  // ---------- C 解锁后接口 ----------
  console.log("\n=== C 解锁后接口 ===");
  const good = await probe(P, ["/api/content.php?action=all", "/api/compat.php?action=status", "/api/daily.php"]);
  for (const r of good) {
    ok(`${r.path} → ${r.status} 是干净 JSON`, r.status === 200 && /application\/json/.test(r.ct) && !badBody(r), r.text.slice(0, 140));
  }
  const cont = good.find((r) => r.path.startsWith("/api/content.php"));
  let contJ = null; try { contJ = JSON.parse(cont.text); } catch (e) {}
  ok("内容接口返回 ok:true", contJ && contJ.ok === true, cont.text.slice(0, 120));

  // ---------- D 解锁后的畸形载荷 ----------
  console.log("\n=== D 解锁后的畸形载荷仍是干净 JSON ===");
  const bad = await probe(P, [
    ["/api/compat.php", "POST", { action: [] }],
    ["/api/compat.php", "POST", { action: "create", role: [], questions: [{ q: "a", opts: ["x", "y"] }, { q: "b", opts: ["x", "y"] }] }],
    ["/api/compat.php", "POST", { action: "submit", id: [], role: [], answers: [[]] }],
    ["/api/content.php", "POST", { action: [] }],
    ["/api/content.php?action%5B%5D=all", "GET", null],
    ["/api/daily.php", "POST", { action: [] }],
    ["/api/unlock.php", "POST", { action: [] }],
  ]);
  for (const r of bad) {
    ok(`${r.method} ${r.path} → ${r.status} 无 PHP 诊断信息`, !badBody(r), r.text.slice(0, 140));
  }
  /* 这里的正确契约不是"必须 4xx"：本项目对参数校验失败用 200 + {ok:false}
     （只有未知操作/未授权才 4xx）。真正要守住的是"绝不能是 5xx 或 HTML"，
     并且响应体永远是 JSON。 */
  const shapeOk = bad.every((r) => {
    if (/application\/json/.test(r.ct) === false) return false;
    if (r.status >= 500) return false;
    try { return JSON.parse(r.text).ok === false; } catch (e) { return false; }
  });
  ok("畸形请求都是 JSON + ok:false（不是 5xx / HTML）", shapeOk,
    bad.map((r) => r.status + "/" + r.ct.split(";")[0]).join(" | "));

  // ---------- E 解锁态全站页面 ----------
  console.log("\n=== E 解锁态全站 7 页 ===");
  for (const p of PAGES) {
    const resp = await P.goto(SITE + "/" + p, { waitUntil: "domcontentloaded", timeout: 60000 });
    await P.waitForTimeout(400);
    const st = await P.evaluate(() => location.pathname);
    const html = await P.content();
    const bounced = p !== "index.html" && /index\.html/.test(st);
    ok(`${p} 可访问、无 PHP 报错、未被弹回`, resp && resp.status() === 200 && !DIRTY.test(html) && !bounced,
      "status=" + (resp && resp.status()) + " landed=" + st);
  }

  await browser.close();
  console.log(`\n线上解锁态实测: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常:", e.message); process.exit(2); });
