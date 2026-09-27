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

/* 限流按 IP 分桶（同一 wifi 的两个人共用一个桶）；**额度与窗口的唯一来源是
   lib/store.php 的 LOVE_RATE_* / love_rate_allowed()**，本文件不再自己写额度。
   照片一张一次请求，批量上传很容易超，所以那边单独给了更宽的额度；
   留言/情书/删除仍保持较严的额度（防刷屏）。桶名 content / photo 各自独立。 */

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
if (!love_rate_allowed($bucket)) {
    love_json(['ok' => false, 'error' => $action === 'photo_add'
        ? '上传太频繁了，先歇一会儿再继续吧'
        : '操作太频繁，请稍后再试'], 429);
}

// 身份以服务端 Cookie 为准，忽略请求体里的 deviceId（防伪造）
$in['deviceId'] = $deviceId;

/* uid 是"同一条内容"的去重键：lib/content.php 的四个 *_add 在同一把锁里先查同
   uid，命中就直接回吐已存在的那条（dup:true），不再落盘。请求体里没有 uid（或带的
   是个 clean_id 后为空的脏值，如 "!!!"）时，四个 *_add 会退化成 'm'.time() /
   'p'.time() 这类**秒级**兜底 —— 同一秒内的两次提交共用同一个去重键，第二次的新
   内容被静默并进第一次那条（接口仍回 ok:true + dup:true，照片路径更是连图都不写），
   前端会把本机副本删掉并提示"已存到服务器" → 静默丢内容（第七轮 S3-01）。
   去重键必须不可碰撞：在这里补一个随机 uid（前端三个调用方本来就都带 uid，这条
   只为 curl / 手写客户端 / 被中间层抹掉字段的请求兜底），并让它随响应回传，
   客户端据此能认出"这是我刚存的那一条"。
   只补写接口：delete 的 uid 是**目标**，绝不能替客户端编一个。 */
$UID_PREFIX = ['photo_add' => 'p', 'letter_add' => 'l', 'message_add' => 'm', 'capsule_add' => 'c'];
if (isset($UID_PREFIX[$action]) && clean_id(u_str($in['uid'] ?? '')) === '') {
    $in['uid'] = $UID_PREFIX[$action] . bin2hex(random_bytes(8));
}

switch ($action) {
    case 'photo_add':   $r = photo_add($in);   break;
    case 'letter_add':  $r = letter_add($in);  break;
    case 'message_add': $r = message_add($in); break;
    case 'capsule_add': $r = capsule_add($in); break;
    case 'delete':      love_json(content_delete($in, $deviceId));
    default:            love_json(['ok' => false, 'error' => '未知操作'], 400);
}
if (!empty($r['record']) && is_array($r['record'])) {
    /* mine 必须按记录的真实归属算，口径与 lib/content.php 的 content_view() 一致。
       为什么不能写死 true：uid 撞车时返回的是**已存在的那条**记录（例如 photo_add
       的去重分支是"本机数据迁移"用的），那条可能是另一台设备发的。写死 true 会让
       前端给别人的照片画出 ✕ 删除按钮，点下去必被服务端拒绝（"只能删除自己的内容"），
       用户只看到一句莫名其妙的"删除失败"。

       已经带了 mine 的（capsule_add 返回的是 capsule_view()，那里按服务端身份
       算好了）不许再覆盖：视图函数为了不泄漏删除凭据**必然**剥掉了 deviceId，
       下面用 deviceId 重算只会得出 false，把作者自己的胶囊误标成别人的
       —— 那正是第三轮修掉的那个症状。 */
    if (!array_key_exists('mine', $r['record'])) {
        $r['record']['mine'] = ($deviceId !== '' && u_str($r['record']['deviceId'] ?? '') === $deviceId);
    }
    unset($r['record']['deviceId']);        // 删除凭据不下发
}
love_json($r);
