/* 线上只读实测 · 未解锁阶段（真实主机 + 真实 PHP + 真实 WAF）

   用浏览器打开站点（自动过 WAF 挑战），然后在页面内 fetch 关键接口，
   验证"PHP 诊断信息不再污染响应体"这一类修复在真机上确实生效。

   不需要门禁密码：用到的都是匿名可达的路径（index.html / api/config.php /
   api/unlock.php 的 GET 与畸形动作 / admin whoami / 未解锁时的 401 接口）。

   两条铁律：
     - 只读：这里只做「读 + 畸形载荷被拒」，不许加任何会写 data/ 的操作
       （线上是两人真实数据，不是沙箱）；
     - 故意不发送"错误密码"请求，避免占用服务器的解锁失败次数额度。

   站点地址从环境变量取（域名不入库），口令走环境变量不入库，
   所以请用启动器运行：python tools/online_probe.py --creds "<凭据文件>"
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
/* 打印前脱敏：config.php 会带上真实姓名（服务器 data/config.json），不进日志 */
const mask = (s) => String(s).replace(/("(?:boy|girl|a|b)"\s*:\s*")([^"]*)(")/g, "$1***$3");
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  [" + mask(extra) + "]" : "")); };

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext();
  const P = await ctx.newPage();

  console.log("=== 打开站点（含 WAF 挑战）===");
  await P.goto(SITE + "/index.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 12; i++) {
    const html = await P.content();
    if (!/toNumbers|slowAES/.test(html)) break;
    await P.waitForTimeout(1500);
  }
  const gate = await P.evaluate(() => window.__SERVER_GATE__ || null);
  const html0 = await P.content();
  ok("WAF 挑战已通过（拿到站点自身页面）", !/toNumbers/.test(html0) && /unlockBtn/.test(html0));
  ok("api/config.php 注入的 __SERVER_GATE__ 存在", gate !== null, JSON.stringify(gate));
  ok("未解锁状态符合预期", gate && gate.required === true && gate.ok === false, JSON.stringify(gate));

  // 页面内 fetch：带上 WAF cookie，逐项检查响应体是否干净
  const probes = await P.evaluate(async (paths) => {
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
        out.push({ path, method, status: r.status, ct: r.headers.get("content-type") || "", text: (await r.text()).slice(0, 400) });
      } catch (e) {
        out.push({ path, method, status: -1, ct: "", text: "FETCH_ERROR " + e.message });
      }
    }
    return out;
  }, [
    ["/api/config.php", "GET", null],
    ["/api/unlock.php", "GET", null],
    ["/api/unlock.php", "POST", { action: [] }],            // 数组当字符串用 → 修复前会抛警告
    ["/api/unlock.php?action%5B%5D=status", "GET", null],   // query 里放数组
    ["/api/compat.php?action=status", "GET", null],         // 未解锁 → 401，但必须是干净 JSON
    ["/admin/api.php?action=whoami", "GET", null],
  ]);

  console.log("\n=== 接口响应体检查 ===");
  for (const r of probes) {
    const clean = !DIRTY.test(r.text) && !/AI Work|htdocs\/|:\/\//.test(r.text.replace(/https?:\/\//g, ""));
    ok(`${r.method} ${r.path} → ${r.status} 无 PHP 诊断信息`, clean, r.text.slice(0, 160));
  }

  const cfg = probes.find((r) => r.path === "/api/config.php");
  const haveAll = ["__SERVER_OVERRIDES__", "__SERVER_GATE__", "__SERVER_CONTENT__", "__SERVER_COMPAT__", "__SERVER_DAILY__"]
    .filter((k) => cfg && cfg.text.includes(k));
  ok("注入语句完整（5/5）", haveAll.length === 5, haveAll.join(","));
  /* api/config.php 是以 <script src> 加载的，按设计返回 application/javascript；
     其余接口必须返回 application/json（丢了 Content-Type 正是警告污染的症状之一）。 */
  const ctBad = probes.filter((r) => (r.path.startsWith("/admin/") || (r.path.startsWith("/api/") && r.path !== "/api/config.php")))
    .filter((r) => !/application\/json/.test(r.ct));
  ok("JSON 接口都带着 application/json 头", ctBad.length === 0, ctBad.map((r) => r.path + "→" + r.ct).join(" | "));
  ok("config.php 是 JS 内容类型（按设计，非 JSON）", /javascript/.test(cfg.ct), cfg.ct);

  const who = probes.find((r) => r.path.startsWith("/admin/api.php"));
  let whoJ = null;
  try { whoJ = JSON.parse(who.text); } catch (e) {}
  ok("whoami 匿名调用正常（限流改动未破坏它）",
    whoJ && whoJ.ok === true && whoJ.logged_in === false && typeof whoJ.csrf === "string" && whoJ.csrf.length > 0,
    who ? who.text.slice(0, 160) : "no response");

  console.log("\n=== 全站 7 个页面 ===");
  for (const p of PAGES) {
    const resp = await P.goto(SITE + "/" + p, { waitUntil: "domcontentloaded", timeout: 60000 });
    const html = await P.content();
    ok(`${p} 可访问且无 PHP 报错`, resp && resp.status() === 200 && !DIRTY.test(html),
      "status=" + (resp && resp.status()));
  }

  await browser.close();
  console.log(`\n线上实测结果: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("脚本异常:", e.message); process.exit(2); });
