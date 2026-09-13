<?php
/* ============================================================
   情侣网站 · 配置注入（公开）
   输出: window.__SERVER_OVERRIDES__ = {...};
   前端 config.js 会把覆盖深合并进 DEFAULT_CONFIG。
   只输出白名单键（管理员账号、留言等敏感数据绝不外泄）。
   更新网站（上传覆盖）不会动 data/config.json，自定义内容永不丢失。

   同时注入访客内容与默契度状态：身份由服务端 HttpOnly Cookie 决定，
   接口只回传 mine 等布尔字段，deviceId 永不下发。

   ⚠️ 门禁分级（重要）：
   本文件被每个页面（含解锁页 index.html）以 <script src> 加载，
   所以在「未解锁」状态下它也是任何人可读的。因此输出分两层 ——
   只有 CFG_PUBLIC_KEYS 在未解锁时下发；其余私密内容
   （情话/相册/情书/时光轴/纪念日/题库…）必须解锁后才注入。
   解锁页只用到 names；其余键缺失由 config.js 的 DEFAULT_CONFIG 兜底，
   页面不会报错。
   ============================================================ */

require_once __DIR__ . '/../lib/store.php';
require_once __DIR__ . '/../lib/access.php';     // 服务端门禁（解锁状态）
require_once __DIR__ . '/../lib/config.php';     // sanitize_cfg / normalize_quiz（与后台共用）
require_once __DIR__ . '/../lib/compat.php';   // 默契度回合注入视图
require_once __DIR__ . '/../lib/daily.php';    // 每日一问视图

header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

/* 统一编码：HEX 系列把 < > & ' " 转成 \uXXXX，即使将来改成内联 <script>
   也不会因为内容里的 </script> 提前闭合（当前是外部脚本，属纵深防御）。 */
function love_js_json($v): string {
    return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
}

/* 未解锁也允许下发：解锁页只用来显示"这里是 XXX 的小世界" */
const CFG_PUBLIC_KEYS = ['names'];

/* 解锁后才下发：全部属于两个人的私密内容 */
const CFG_PRIVATE_KEYS = [
    'startDate', 'slogan', 'greeting',
    'messages', 'homeCards', 'anniversaries', 'timeline', 'gallery',
    'letters', 'wishes', 'quiz', 'compatQuiz', 'truthDares', 'dailyQuestions',
];

/* 注意：password 不在任何一组里 —— 解锁密码只存服务器，
   校验走 api/unlock.php，绝不下发给前端。 */

/* 访客身份（HttpOnly Cookie；没有则本次响应就发一个） */
$dev = love_device_id();

/* 门禁状态：未解锁时只注入"公开配置"，私密内容一律为空 */
$gateReq = love_gate_required();
$gateOk  = love_gate_ok();

$ov = love_read('config.json', []);
/* 结构校验：与后台保存走同一套 sanitize_cfg。
   README 建议「忘了密码就直接编辑 data/config.json」，那条路径没有后台
   校验，若把 names 写成字符串、anniversaries 写成非数组，前台会显示
   "undefined ♥ undefined" 甚至整段脚本抛错 —— 在这一层拦住。 */
$rejected = []; $skipped = [];
$ov = sanitize_cfg(is_array($ov) ? $ov : [], $rejected, $skipped);
$ov = normalize_quiz($ov);

$keys = $gateOk ? array_merge(CFG_PUBLIC_KEYS, CFG_PRIVATE_KEYS) : CFG_PUBLIC_KEYS;
$out = [];
foreach ($keys as $k) {
    if (array_key_exists($k, $ov)) $out[$k] = $ov[$k];
}
// 转成对象输出：空覆盖必须是 {}（若输出 []，前端合并会把整个配置替换成数组）
echo 'window.__SERVER_OVERRIDES__ = ' . love_js_json((object)$out) . ";\n";

/* 门禁状态注入：前端据此决定是否跳回解锁页 */
echo 'window.__SERVER_GATE__ = ' . love_js_json(['required' => $gateReq, 'ok' => $gateOk]) . ";\n";

/* 访客内容注入（留言/情书/照片记录）：与配置走同一条 script 注入链路，
   比 fetch 稳定（不会被防火墙/WAF 的请求挑战拦截导致内容静默丢失）。
   纯静态托管（无 PHP）时没有此注入，前端自动回退 fetch。 */
$ct = $gateOk ? love_read('content.json', []) : [];
echo 'window.__SERVER_CONTENT__ = ' . love_js_json($gateOk ? content_view([
    'photos'   => (array)($ct['photos'] ?? []),
    'letters'  => (array)($ct['letters'] ?? []),
    'messages' => (array)($ct['messages'] ?? []),
    'capsules' => (array)($ct['capsules'] ?? []),
], $dev) : ['photos' => [], 'letters' => [], 'messages' => [], 'capsules' => []]) . ";\n";

/* 默契度回合状态注入（小游戏页用）：active(进行中回合, 不含任何一方答案)
   + 完成历史（只含我参与过的）。走 script 注入链路,
   首次打开页面不依赖 fetch（避免 WAF 挑战拦截导致误判"服务器不可用"）。 */
echo 'window.__SERVER_COMPAT__ = ' . love_js_json($gateOk
    ? compat_inject_view($dev)
    : ['active' => null, 'history' => [], 'busy' => false]) . ";\n";

/* 每日一问：今天第几天 + 我的回答 + 对方是否已回答（对方答案在我答过之后才给） */
echo 'window.__SERVER_DAILY__ = ' . love_js_json($gateOk
    ? daily_view($dev)
    : ['enabled' => false, 'date' => date('Y-m-d'), 'dayNo' => 0, 'mine' => null, 'partnerAnswered' => false, 'partner' => []]) . ";\n";
