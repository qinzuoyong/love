<?php
/* ============================================================
   情侣网站 · 访客内容接口（公开）
   留言板 / 手写情书 / 相册照片 的服务器端存取。
   设计：数据存服务器 data/content.json，照片文件存 assets/img/uploads/，
   网站更新（上传覆盖）永远不会动它们。
   接口失败时前端会自动降级为浏览器本地存储（原行为）。
   - 读取: GET  ?action=all
   - 写入: POST {action: photo_add|letter_add|message_add|delete, ...}
   安全：IP 限速、长度校验、照片类型/尺寸校验、访客只能删自己的。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/content.php';

const WRITE_LIMIT = 20;   // 每 IP 每 10 分钟最多写 20 次
const WRITE_WINDOW = 600;

function write_throttled(): bool {
    $key = 'c_' . ($_SERVER['REMOTE_ADDR'] ?? '?');
    $sec = love_read('security.json', []);
    $hits = (array)($sec['hits'] ?? []);
    $now = time();
    $hits = array_values(array_filter($hits, function ($t) use ($now) { return $t > $now - WRITE_WINDOW; }));
    if (count($hits) >= WRITE_LIMIT) return false;
    $hits[] = $now;
    $sec['hits'] = $hits;
    love_write('security.json', $sec);
    return true;
}

/* ---------- 删除（访客只能删自己的） ---------- */
function content_delete(array $in): array {
    $kind = (string)($in['kind'] ?? '');
    $uid = (string)($in['uid'] ?? '');
    $deviceId = clean_id((string)($in['deviceId'] ?? ''));
    if (!in_array($kind, ['photos', 'letters', 'messages'], true) || $uid === '') {
        return ['ok' => false, 'error' => '参数错误'];
    }
    $before = content_get();
    $target = null;
    foreach ($before[$kind] as $r) {
        if (($r['uid'] ?? '') === $uid) { $target = $r; break; }
    }
    if ($target === null) return ['ok' => true];                 // 已不存在
    if (($target['deviceId'] ?? '') !== $deviceId) return ['ok' => false, 'error' => '只能删除自己的内容'];

    $c = love_mutate(CONTENT_FILE, function ($c) use ($kind, $uid, $deviceId) {
        $c[$kind] = array_values(array_filter((array)($c[$kind] ?? []), function ($it) use ($uid, $deviceId) {
            return !((($it['uid'] ?? '') === $uid) && (($it['deviceId'] ?? '') === $deviceId));
        }));
        return $c;
    }, []);
    if (!is_array($c)) return ['ok' => false, 'error' => '服务器繁忙'];

    if ($kind === 'photos' && !empty($target['src'])) {
        $src = (string)$target['src'];
        if (strpos($src, 'assets/img/uploads/') === 0) {
            @unlink(love_uploads_dir() . '/' . basename($src));
        }
    }
    return ['ok' => true];
}

/* ---------- 路由 ---------- */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $action = (string)($_GET['action'] ?? 'all');
    if ($action === 'all') love_json(['ok' => true, 'data' => content_get()]);
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}

$in = love_body();
$action = (string)($in['action'] ?? '');
if (!in_array($action, ['photo_add', 'letter_add', 'message_add', 'delete'], true)) {
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}
if (!write_throttled()) love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);

switch ($action) {
    case 'photo_add':   love_json(photo_add($in));
    case 'letter_add':  love_json(letter_add($in));
    case 'message_add': love_json(message_add($in));
    case 'delete':      love_json(content_delete($in));
}
