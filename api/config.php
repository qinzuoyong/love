<?php
/* ============================================================
   情侣网站 · 配置注入（公开）
   输出: window.__SERVER_OVERRIDES__ = {...};
   前端 config.js 会把覆盖深合并进 DEFAULT_CONFIG。
   只输出白名单键（管理员账号、留言等敏感数据绝不外泄）。
   更新网站（上传覆盖）不会动 data/config.json，自定义内容永不丢失。
   ============================================================ */

require_once __DIR__ . '/../lib/store.php';
require_once __DIR__ . '/../lib/compat.php';   // 默契度回合注入视图

header('Content-Type: application/javascript; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');

$ALLOWED = [
    'names', 'startDate', 'password', 'slogan', 'greeting',
    'messages', 'homeCards', 'anniversaries', 'timeline', 'gallery',
    'letters', 'wishes', 'quiz', 'compatQuiz', 'truthDares',
];

$ov = love_read('config.json', []);
$out = [];
foreach ($ALLOWED as $k) {
    if (array_key_exists($k, $ov)) $out[$k] = $ov[$k];
}
// 转成对象输出：空覆盖必须是 {}（若输出 []，前端合并会把整个配置替换成数组）
echo 'window.__SERVER_OVERRIDES__ = ' . json_encode((object)$out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ";\n";

/* 访客内容注入（留言/情书/照片记录）：与配置走同一条 script 注入链路，
   比 fetch 稳定（不会被防火墙/WAF 的请求挑战拦截导致内容静默丢失）。
   纯静态托管（无 PHP）时没有此注入，前端自动回退 fetch。 */
$ct = love_read('content.json', []);
echo 'window.__SERVER_CONTENT__ = ' . json_encode([
    'photos'   => (array)($ct['photos'] ?? []),
    'letters'  => (array)($ct['letters'] ?? []),
    'messages' => (array)($ct['messages'] ?? []),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ";\n";

/* 默契度回合状态注入（小游戏页用）：active(进行中回合, 不含任何一方答案,
   含 aDeviceId 由前端判断身份) + 完成历史。走 script 注入链路,
   首次打开页面不依赖 fetch（避免 WAF 挑战拦截导致误判"服务器不可用"）。 */
echo 'window.__SERVER_COMPAT__ = ' . json_encode(
    compat_inject_view(),
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
) . ";\n";
