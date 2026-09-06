<?php
/* ============================================================
   情侣网站 · 管理员接口
   除 login/whoami 外均需登录。所有状态变化都带 CSRF 校验。
   数据只读写服务器 data/ 目录（网站更新永不覆盖）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/content.php';

const CFG_KEYS = [
    'names', 'startDate', 'password', 'slogan', 'greeting',
    'messages', 'homeCards', 'anniversaries', 'timeline', 'gallery',
    'letters', 'wishes', 'quiz', 'compatQuiz', 'truthDares',
];

function admin_account(): array {
    $a = love_read('admin.json', []);
    return is_array($a) ? $a : [];
}

function require_csrf(array $in): void {
    if (!love_csrf_ok($in['csrf'] ?? null)) love_json(['ok' => false, 'error' => '页面已过期，请刷新后重试'], 403);
}

/* ---------- 无需登录 ---------- */
if (($_GET['action'] ?? '') === 'whoami') {
    love_session();
    love_json([
        'ok' => true,
        'logged_in' => love_logged_in(),
        'username' => $_SESSION['love_admin'] ?? '',
        'csrf' => love_csrf(),
        'installed' => love_admin_exists(),
    ]);
}

$in = love_body();
$action = (string)($in['action'] ?? '');

if ($action === 'whoami') {   // 面板端以 POST 携带 action=whoami 调用
    love_session();
    love_json([
        'ok' => true,
        'logged_in' => love_logged_in(),
        'username' => $_SESSION['love_admin'] ?? '',
        'csrf' => love_csrf(),
        'installed' => love_admin_exists(),
    ]);
}

if ($action === 'login') {
    if (love_logged_in()) love_json(['ok' => true, 'username' => $_SESSION['love_admin']]);
    if (love_throttle_blocked()) love_json(['ok' => false, 'error' => '失败次数过多，请 10 分钟后再试'], 429);
    require_csrf($in);
    $user = trim((string)($in['username'] ?? ''));
    $pass = (string)($in['password'] ?? '');
    if (love_admin_exists() && love_admin_verify($user, $pass)) {
        love_session();
        $_SESSION['love_admin'] = $user;
        $_SESSION['love_csrf'] = bin2hex(random_bytes(16));
        love_throttle_reset();
        love_json(['ok' => true, 'username' => $user, 'csrf' => love_csrf()]);
    }
    love_throttle_fail();
    love_json(['ok' => false, 'error' => '账号或密码不对'], 401);
}

if ($action === 'logout') {
    love_session();
    $_SESSION = [];
    @session_destroy();
    love_json(['ok' => true]);
}

/* ---------- 以下全部需要登录 ---------- */
love_require_login();
require_csrf($in);

switch ($action) {
    case 'get_config':
        love_json(['ok' => true, 'overrides' => love_read('config.json', [])]);

    case 'save_config':
        $ov = is_array($in['overrides'] ?? null) ? $in['overrides'] : [];
        $out = [];
        foreach (CFG_KEYS as $k) {
            if (array_key_exists($k, $ov)) $out[$k] = $ov[$k];
        }
        if (!love_write('config.json', $out)) love_json(['ok' => false, 'error' => '保存失败（data 目录不可写？）'], 500);
        love_json(['ok' => true, 'saved' => array_keys($out)]);

    case 'get_content':
        love_json(['ok' => true, 'data' => [
            'photos'   => love_read('content.json', [])['photos'] ?? [],
            'letters'  => love_read('content.json', [])['letters'] ?? [],
            'messages' => love_read('content.json', [])['messages'] ?? [],
        ]]);

    case 'content_delete':   // 管理员可删任意内容（含照片文件）
        $kind = (string)($in['kind'] ?? '');
        $uid = (string)($in['uid'] ?? '');
        if (!in_array($kind, ['photos', 'letters', 'messages'], true) || $uid === '') {
            love_json(['ok' => false, 'error' => '参数错误'], 400);
        }
        $c = love_read('content.json', []);
        $target = null;
        foreach ((array)($c[$kind] ?? []) as $r) {
            if (($r['uid'] ?? '') === $uid) { $target = $r; break; }
        }
        if ($target !== null) {
            $c[$kind] = array_values(array_filter((array)($c[$kind] ?? []), function ($r) use ($uid) {
                return ($r['uid'] ?? '') !== $uid;
            }));
            love_write('content.json', $c);
            if ($kind === 'photos' && !empty($target['src'])) {
                $src = (string)$target['src'];
                if (strpos($src, 'assets/img/uploads/') === 0) {
                    @unlink(love_uploads_dir() . '/' . basename($src));
                }
            }
        }
        love_json(['ok' => true]);

    case 'photo_upload':     // 管理员上传照片（存 uploads/，记录进 data/content.json）
        $in['deviceId'] = 'admin';
        $in['uid'] = 'a' . time() . substr(bin2hex(random_bytes(4)), 0, 8);
        $r = photo_add($in);
        if (empty($r['ok'])) love_json($r, 400);
        love_json(['ok' => true, 'record' => $r['record']]);

    case 'change_password':
        $old = (string)($in['old'] ?? '');
        $new = (string)($in['new'] ?? '');
        $a = admin_account();
        if (empty($a['pass_hash']) || !password_verify($old, $a['pass_hash'])) {
            love_json(['ok' => false, 'error' => '原密码不对'], 401);
        }
        if (strlen($new) < 6) love_json(['ok' => false, 'error' => '新密码至少 6 位'], 400);
        $a['pass_hash'] = password_hash($new, PASSWORD_DEFAULT);
        if (!love_write('admin.json', $a)) love_json(['ok' => false, 'error' => '保存失败'], 500);
        love_json(['ok' => true]);

    case 'backup':
        love_json(['ok' => true, 'backup' => [
            'version' => 1,
            'time' => date('c'),
            'config'  => love_read('config.json', []),
            'content' => [
                'photos'   => (array)(love_read('content.json', [])['photos'] ?? []),
                'letters'  => (array)(love_read('content.json', [])['letters'] ?? []),
                'messages' => (array)(love_read('content.json', [])['messages'] ?? []),
            ],
            'admin' => admin_account(),
        ]]);

    case 'restore':
        $b = is_array($in['backup'] ?? null) ? $in['backup'] : [];
        $ok = true;
        if (isset($b['config']) && is_array($b['config'])) {
            $cfg = [];
            foreach (CFG_KEYS as $k) if (array_key_exists($k, $b['config'])) $cfg[$k] = $b['config'][$k];
            $ok = $ok && love_write('config.json', $cfg);
        }
        if (isset($b['content']) && is_array($b['content'])) {
            $ct = ['photos' => [], 'letters' => [], 'messages' => []];
            foreach (['photos', 'letters', 'messages'] as $k) {
                if (isset($b['content'][$k]) && is_array($b['content'][$k])) $ct[$k] = $b['content'][$k];
            }
            $ok = $ok && love_write('content.json', $ct);
        }
        if (isset($b['admin']) && is_array($b['admin']) && !empty($b['admin']['username']) && !empty($b['admin']['pass_hash'])) {
            $ok = $ok && love_write('admin.json', ['username' => $b['admin']['username'], 'pass_hash' => $b['admin']['pass_hash'], 'created' => $b['admin']['created'] ?? time()]);
        }
        love_json(['ok' => $ok, 'error' => $ok ? null : '部分写入失败（data 目录不可写？）']);

    default:
        love_json(['ok' => false, 'error' => '未知操作'], 400);
}
