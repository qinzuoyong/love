<?php
/* ============================================================
   情侣网站 · 配置注入（公开）
   输出: window.__SERVER_OVERRIDES__ = {...};
   前端 config.js 会把覆盖深合并进 DEFAULT_CONFIG。
   只输出白名单键（管理员账号、留言等敏感数据绝不外泄）。
   更新网站（上传覆盖）不会动 data/config.json，自定义内容永不丢失。
   ============================================================ */

require __DIR__ . '/../lib/store.php';

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
