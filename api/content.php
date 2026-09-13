<?php
/* ============================================================
   情侣网站 · 访客内容接口（公开）
   留言板 / 手写情书 / 相册照片 的服务器端存取。
   设计：数据存服务器 data/content.json，照片文件存 assets/img/uploads/，
   网站更新（上传覆盖）永远不会动它们。
   接口失败时前端会自动降级为浏览器本地存储（原行为）。
   - 读取: GET  ?action=all
   - 写入: POST {action: photo_add|letter_add|message_add|capsule_add|delete, ...}
   安全：按 IP 限速、长度校验、照片类型/尺寸校验；
        deviceId 只存在服务端 HttpOnly Cookie 与数据里，绝不下发给前端，
        访客只能删自己的内容（服务端按 Cookie 判定，前端只看 mine）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';
require __DIR__ . '/../lib/content.php';

/* 服务端门禁：未解锁一律拒绝（读和写都拦）。
   密码为空 / 纯静态托管时 love_gate_ok() 恒为 true，行为与以前一致。 */
if (!love_gate_ok()) love_json(['ok' => false, 'error' => '需要先解锁', 'locked' => true], 401);

/* 限流按 IP 分桶（同一 wifi 的两个人共用一个桶）。
   照片一张一次请求，批量上传很容易超过 20 次，所以单独放宽；
   留言/情书/删除仍保持较严的额度（防刷屏）。 */
const WRITE_LIMIT = 30;    // 留言/情书/删除：每 IP 每 10 分钟
const PHOTO_LIMIT = 120;   // 照片：每 IP 每 10 分钟
const WRITE_WINDOW = 600;

/* ---------- 删除（访客只能删自己的：按服务端 Cookie 判定） ---------- */
function content_delete(array $in, string $deviceId): array {
    $kind = u_str($in['kind'] ?? '');
    $uid = clean_id(u_str($in['uid'] ?? ''));
    if (!in_array($kind, ['photos', 'letters', 'messages', 'capsules'], true) || $uid === '') {
        return ['ok' => false, 'error' => '参数错误'];
    }
    $before = content_get();
    $target = null;
    foreach ($before[$kind] as $r) {
        if (($r['uid'] ?? '') === $uid) { $target = $r; break; }
    }
    if ($target === null) return ['ok' => true];                 // 已不存在
    if (u_str($target['deviceId'] ?? '') !== $deviceId) {
        return ['ok' => false, 'error' => '只能删除自己的内容'];
    }

    $c = love_mutate(CONTENT_FILE, function ($c) use ($kind, $uid, $deviceId) {
        $c[$kind] = array_values(array_filter((array)($c[$kind] ?? []), function ($it) use ($uid, $deviceId) {
            return !((($it['uid'] ?? '') === $uid) && (($it['deviceId'] ?? '') === $deviceId));
        }));
        return $c;
    }, []);
    if (!is_array($c)) return ['ok' => false, 'error' => '服务器繁忙'];

    if ($kind === 'photos' && !empty($target['src'])) {
        $src = u_str($target['src']);
        if (strpos($src, 'assets/img/uploads/') === 0) {
            @unlink(love_uploads_dir() . '/' . basename($src));
        }
    }
    return ['ok' => true];
}

/* ---------- 路由 ---------- */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$deviceId = love_device_id();     // 服务端权威身份（HttpOnly Cookie）

if ($method === 'GET') {
    $action = u_str($_GET['action'] ?? 'all');
    if ($action === 'all') love_json(['ok' => true, 'data' => content_view(content_get(), $deviceId)]);
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}

$in = love_body();
$action = u_str($in['action'] ?? '');
if (!in_array($action, ['photo_add', 'letter_add', 'message_add', 'capsule_add', 'delete'], true)) {
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}
$bucket = $action === 'photo_add' ? 'photo' : 'content';
$limit  = $action === 'photo_add' ? PHOTO_LIMIT : WRITE_LIMIT;
if (!love_rate_ok($bucket, $limit, WRITE_WINDOW)) {
    love_json(['ok' => false, 'error' => $action === 'photo_add'
        ? '上传太频繁了，先歇一会儿再继续吧'
        : '操作太频繁，请稍后再试'], 429);
}

// 身份以服务端 Cookie 为准，忽略请求体里的 deviceId（防伪造）
$in['deviceId'] = $deviceId;

switch ($action) {
    case 'photo_add':   $r = photo_add($in);   break;
    case 'letter_add':  $r = letter_add($in);  break;
    case 'message_add': $r = message_add($in); break;
    case 'capsule_add': $r = capsule_add($in); break;
    case 'delete':      love_json(content_delete($in, $deviceId));
    default:            love_json(['ok' => false, 'error' => '未知操作'], 400);
}
if (!empty($r['record']) && is_array($r['record'])) {
    unset($r['record']['deviceId']);        // 删除凭据不下发
    $r['record']['mine'] = true;
}
love_json($r);
