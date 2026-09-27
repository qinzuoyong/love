<?php
/* ============================================================
   情侣网站 · 每日一问接口
   - GET            → 今日题目下标 + 我的回答 + 对方是否已回答
   - POST {answer, text} → 提交今天的回答，返回最新视图
   安全：需要先解锁（门禁 Cookie）；按 IP **单独分桶**限流；
        对方答案只有在我已作答后才下发。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';
require __DIR__ . '/../lib/daily.php';

if (!love_gate_ok()) love_json(['ok' => false, 'error' => '需要先解锁', 'locked' => true], 401);

/* 限流：每日一答**单独一个桶** `daily`，额度与窗口的**唯一定义处**是
   lib/store.php 的 LOVE_RATE_DAILY_LIMIT / LOVE_RATE_WINDOW（经 love_rate_allowed
   统一判定）。旧实现写的是 `love_rate_ok('content', 30, 600)` —— 既把留言/情书那边
   的 30/600 又抄了一份（改一处忘另一处就漂），又和 api/content.php 共用同一个
   IP 桶。共用桶的两个后果都是现实可撞的（第七轮 S3-04）：
     ① 留言/情书的批量补传（letters.js 的本机旧数据迁移是逐条 POST，一次几十条）
        会把额度吃光，紧随其后的"今日回答"直接 429；
     ② 同一 wifi 下的两个人本来就该共用一个 IP 桶，但那是留言的取舍，
        不该顺带把"今日回答"也扣掉。
   这里只留桶名，额度一改就跟着 lib/store.php 变（改一处即全体生效）。 */

$deviceId = love_device_id();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    love_json(['ok' => true, 'data' => daily_view($deviceId)]);
}

$in = love_body();
if (u_str($in['action'] ?? '') !== 'answer') love_json(['ok' => false, 'error' => '未知操作'], 400);

if (!love_rate_allowed('daily')) {
    love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);
}

$r = daily_answer($in, $deviceId);
/* 参数级失败用 200 + {ok:false}，与 api/content.php 口径一致（本项目只对
   "未知操作 / 未授权 / 被限流" 用 4xx）。前端 daily.js 也是按 JSON 里的
   ok/error 字段处理的，不依赖状态码。 */
if (empty($r['ok'])) love_json($r);

love_json(['ok' => true, 'data' => daily_view($deviceId)]);
