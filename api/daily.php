<?php
/* ============================================================
   情侣网站 · 每日一问接口
   - GET            → 今日题目下标 + 我的回答 + 对方是否已回答
   - POST {answer, text} → 提交今天的回答，返回最新视图
   安全：需要先解锁（门禁 Cookie）；限流复用留言的 content 桶；
        对方答案只有在我已作答后才下发。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';
require __DIR__ . '/../lib/daily.php';

if (!love_gate_ok()) love_json(['ok' => false, 'error' => '需要先解锁', 'locked' => true], 401);

$deviceId = love_device_id();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    love_json(['ok' => true, 'data' => daily_view($deviceId)]);
}

$in = love_body();
if (u_str($in['action'] ?? '') !== 'answer') love_json(['ok' => false, 'error' => '未知操作'], 400);

if (!love_rate_ok('content', 30, 600)) {
    love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);
}

$r = daily_answer($in, $deviceId);
/* 参数级失败用 200 + {ok:false}，与 api/content.php 口径一致（本项目只对
   "未知操作 / 未授权 / 被限流" 用 4xx）。前端 daily.js 也是按 JSON 里的
   ok/error 字段处理的，不依赖状态码。 */
if (empty($r['ok'])) love_json($r);

love_json(['ok' => true, 'data' => daily_view($deviceId)]);
