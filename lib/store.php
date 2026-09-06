<?php
/* ============================================================
   情侣网站 · 共享存储层（管理员后台配套）
   - JSON 原子读写（flock + 临时文件 + rename）
   - 路径常量、管理员会话 / CSRF / 登录限流
   说明：所有自定义数据只存放在服务器 data/ 目录，
   网站更新（上传覆盖）永远不会碰它。
   ============================================================ */

declare(strict_types=1);

/* ---------- UTF-8 辅助（不依赖 mbstring，有则自动用） ---------- */
function u_len(string $s): int {
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}
function u_sub(string $s, int $n): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n, 'UTF-8');
    // 无 mbstring：按字节截断，并退掉尾部不完整的多字节字符（保持合法 UTF-8）
    $t = substr($s, 0, $n * 3);
    $i = strlen($t);
    while ($i > 0 && (ord($t[$i - 1]) & 0xC0) === 0x80) $i--;   // 跳过连续节字节
    if ($i > 0 && (ord($t[$i - 1]) & 0xC0) === 0xC0) $i--;      // 退掉多字节前导字节
    return substr($t, 0, $i);
}

/* ---------- 路径 ---------- */
function love_data_dir(): string {
    return dirname(__DIR__) . '/data';
}
function love_uploads_dir(): string {
    return dirname(__DIR__) . '/assets/img/uploads';
}

/* ---------- JSON 原子读写 ---------- */
function love_read(string $file, $default = null) {
    $path = love_data_dir() . '/' . $file;
    if (!is_file($path)) return $default;
    $raw = @file_get_contents($path);
    if ($raw === false || trim($raw) === '') return $default;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

function love_write(string $file, $data): bool {
    $dir = love_data_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return false;
    $path = $dir . '/' . $file;
    $tmp  = $path . '.tmp' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) return false;
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) return false;
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    @chmod($path, 0644);
    return true;
}

/** 加锁读改写（留言板/照片等并发追加场景） */
function love_mutate(string $file, callable $fn, $default = null) {
    $dir = love_data_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return null;
    $path = $dir . '/' . $file;
    $fp = @fopen($path, 'c+');
    if (!$fp) return null;
    if (!flock($fp, LOCK_EX)) { fclose($fp); return null; }
    $raw = stream_get_contents($fp);
    $data = (is_string($raw) && trim($raw) !== '') ? json_decode($raw, true) : null;
    if (!is_array($data)) $data = is_array($default) ? $default : [];
    $out = $fn($data);
    ftruncate($fp, 0);
    rewind($fp);
    $json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json !== false) fwrite($fp, $json);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return is_array($out) ? $out : null;
}

/* ---------- 输出 / 输入辅助 ---------- */
function love_json($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function love_body(): array {
    $raw = file_get_contents('php://input');
    $d = json_decode((string)$raw, true);
    return is_array($d) ? $d : [];
}

/* ---------- 管理员会话 / CSRF / 限流 ---------- */
function love_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name('loveadm');
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ]);
    @session_start();
}

function love_admin_exists(): bool {
    $a = love_read('admin.json');
    return is_array($a) && !empty($a['username']) && !empty($a['pass_hash']);
}

function love_admin_verify(string $user, string $pass): bool {
    $a = love_read('admin.json');
    if (!is_array($a) || empty($a['pass_hash'])) return false;
    $ok = password_verify($pass, $a['pass_hash'])
        && hash_equals((string)($a['username'] ?? ''), $user);
    if (!$ok) password_verify('x', $a['pass_hash']); // 恒定时间
    return $ok;
}

function love_logged_in(): bool {
    love_session();
    return !empty($_SESSION['love_admin']);
}

function love_require_login(): void {
    if (!love_logged_in()) love_json(['ok' => false, 'error' => '未登录'], 401);
}

function love_csrf(): string {
    love_session();
    if (empty($_SESSION['love_csrf'])) $_SESSION['love_csrf'] = bin2hex(random_bytes(16));
    return $_SESSION['love_csrf'];
}

function love_csrf_ok(?string $t): bool {
    love_session();
    return is_string($t) && $t !== '' && hash_equals($_SESSION['love_csrf'] ?? '', $t);
}

/* ---------- 登录限流：5 次失败锁 10 分钟 ---------- */
function love_throttle_blocked(): bool {
    $sec = love_read('security.json', []);
    return (int)($sec['block_until'] ?? 0) > time();
}

function love_throttle_fail(): void {
    $now = time();
    $sec = love_read('security.json', []);
    $fails = array_values(array_filter((array)($sec['fails'] ?? []), function ($t) use ($now) { return $t > $now - 600; }));
    $fails[] = $now;
    if (count($fails) >= 5) {
        love_write('security.json', ['fails' => [], 'block_until' => $now + 600]);
    } else {
        love_write('security.json', ['fails' => $fails, 'block_until' => 0]);
    }
}

function love_throttle_reset(): void {
    love_write('security.json', ['fails' => [], 'block_until' => 0]);
}
