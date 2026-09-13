<?php
/* ============================================================
   情侣网站 · 服务端门禁（让"解锁密码"真正生效）
   ------------------------------------------------------------
   背景：原来的密码只在前端 index.html 里比对，任何人直接请求
   /api/config.php、/api/content.php 或猜照片地址都能绕过。
   现在改为：
     - 解锁页把密码 POST 给 api/unlock.php，服务端校验；
     - 成功后下发 HttpOnly Cookie `love_gate`（HMAC 签名 + 过期时间）；
     - 所有内容接口 / 图片代理先检查该 Cookie，未解锁一律 401/403。
   兼容：
     - config.json 里 password 为空（或纯静态托管、无 PHP）→ 门禁自动关闭，
       行为与以前完全一致（本地双击 file:// 打开也照常）。
     - 密码不下发给前端：api/config.php 已把 password 从白名单移除。

   安全：
     - 签名密钥存 data/gate_secret（0600，data/ 已被 .htaccess 拒绝访问）；
     - 改密码时轮换密钥 → 所有旧 Cookie 立即失效；
     - 解锁失败按 IP 计数，10 次锁 10 分钟（与后台登录同一套风格）。
   ============================================================ */

declare(strict_types=1);

const LOVE_GATE_COOKIE = 'love_gate';
const LOVE_GATE_DAYS   = 30;    // Cookie 有效期
const LOVE_GATE_FAILS  = 10;    // 连续失败次数
const LOVE_GATE_LOCK   = 600;   // 锁定时长（秒）

/** 服务端配置的解锁密码（空 = 不需要门禁） */
function love_gate_password(): string {
    /* 不做静态缓存：后台改密码后，同一进程的后续调用（含测试）要能立刻看到新值 */
    $c = love_read('config.json', []);
    if (!is_array($c)) return '';
    $pw = $c['password'] ?? '';
    /* 非标量（有人手改 config.json 把 password 写成数组/对象）时直接强转会抛
       "Array to string conversion" 警告；该函数在 api/config.php 里最先被调用，
       警告会插在注入语句之前 → 整站 JS 失效。这里一律按"无密码"处理。 */
    return is_scalar($pw) ? trim((string)$pw) : '';
}

/** 是否需要门禁（配了密码才需要） */
function love_gate_required(): bool {
    return love_gate_password() !== '';
}

/** 签名密钥缓存（用引用持有，轮换时能清掉） */
function &love_gate_secret_cache(): string {
    static $s = '';
    return $s;
}

/** 签名密钥（不存在则生成）。生成并落盘失败时返回 ''，
    调用方必须把这种状态当成「服务器故障」，绝不能当成「密码错误」。 */
function love_gate_secret(): string {
    $ref = &love_gate_secret_cache();
    if ($ref !== '') return $ref;

    $path = love_data_dir() . '/gate_secret';
    $s = @file_get_contents($path);
    if (is_string($s) && strlen(trim($s)) >= 32) { $ref = trim($s); return $ref; }

    $dir = love_data_dir();
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    love_protect_data_dir($dir);
    $s = bin2hex(random_bytes(32));
    if (@file_put_contents($path, $s, LOCK_EX) === false) {
        /* 关键：密钥无法持久化时，绝不能"就用这把内存密钥继续" ——
           那样每个请求都会重新生成一把新钥匙，已下发的解锁 Cookie 永远
           校验失败，用户会卡在「解锁成功 → 下一页又被弹回」的死循环，
           而页面只会说"密码不对"，根本查不出真正原因。
           返回空串，由 love_gate_storage_ready() 让接口给出明确报错。 */
        return '';
    }
    @chmod($path, 0600);
    $ref = $s;
    return $ref;
}

/** 解锁状态是否可持久化（data/ 可写且有可用密钥）。
    不可用时 api/unlock.php 应返回 500 而不是「密码不对」。 */
function love_gate_storage_ready(): bool {
    return love_gate_secret() !== '';
}

/** 生成令牌：`过期时间.签名`；密钥不可用时返回 ''（无法签发也无法校验） */
function love_gate_token(int $exp): string {
    $secret = love_gate_secret();
    if ($secret === '') return '';
    return $exp . '.' . hash_hmac('sha256', 'love|' . $exp, $secret);
}

/** 当前访客是否已解锁（未配置密码时恒为 true） */
function love_gate_ok(): bool {
    if (!love_gate_required()) return true;
    $v = u_str($_COOKIE[LOVE_GATE_COOKIE] ?? '');
    $p = explode('.', $v, 2);
    if (count($p) !== 2) return false;
    $exp = (int)$p[0];
    if ($exp <= time()) return false;
    $expect = love_gate_token($exp);
    if ($expect === '') return false;      // 密钥不可用 → 一律视为未解锁
    return hash_equals($expect, $v);
}

/** 下发解锁 Cookie；返回是否真的下发成功（headers 已发出 / 密钥不可用 → false）。
    注意顺序：必须"确认能下发"才写 $_COOKIE。若先写 $_COOKIE 再发现 headers 已发出，
    本请求内判定为已解锁、但浏览器实际没收到 Cookie，下一个请求又变回未解锁 ——
    表现为"解锁成功 → 下一页被弹回解锁页"的死循环，页面却只提示密码不对。 */
function love_gate_set(): bool {
    $exp = time() + 86400 * LOVE_GATE_DAYS;
    $val = love_gate_token($exp);
    if ($val === '') return false;
    if (headers_sent()) return false;
    $_COOKIE[LOVE_GATE_COOKIE] = $val;   // 同一请求内立即可用
    @setcookie(LOVE_GATE_COOKIE, $val, [
        'expires'  => $exp,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => love_is_https(),
    ]);
    return true;
}

/** 清除解锁 Cookie（退出） */
function love_gate_clear(): void {
    if (!headers_sent()) {
        @setcookie(LOVE_GATE_COOKIE, '', [
            'expires'  => time() - 3600,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure'   => love_is_https(),
        ]);
    }
    unset($_COOKIE[LOVE_GATE_COOKIE]);
}

/** 轮换密钥（改密码后调用）：所有旧 Cookie 立即失效 */
function love_gate_rotate(): bool {
    $ref = &love_gate_secret_cache();
    $ref = '';                                    // 清缓存，下次调用会重新生成
    $path = love_data_dir() . '/gate_secret';
    if (!is_file($path)) return true;             // 没有旧密钥 = 轮换目的已达成
    return @unlink($path);                        // false = data/ 不可写，旧密钥还在 → 旧 Cookie 依旧有效
}

/* ---------- 失败限流（按 IP，与后台登录同一套计数文件） ---------- */

/** 该 IP 是否已被锁定；返回剩余秒数（0 = 未锁定） */
function love_gate_locked_for(): int {
    $sec = love_read('security.json', []);
    $b = (array)($sec['gate_block'] ?? []);
    $until = (int)($b[love_client_ip()] ?? 0);
    $left = $until - time();
    return $left > 0 ? $left : 0;
}

/** 记一次失败；达到阈值则锁定 */
function love_gate_fail(): void {
    $now = time();
    $ip = love_client_ip();
    love_mutate('security.json', function ($sec) use ($now, $ip) {
        if (!is_array($sec)) $sec = [];
        $b = (array)($sec['gate_block'] ?? []);
        foreach ($b as $k => $t) if ((int)$t <= $now) unset($b[$k]);
        /* 与 lib/store.php 的登录限流同一口径：过期条目要全量清理，
           只清当前 IP 会让 security.json 随访问过的 IP 数无限增长。 */
        $f = (array)($sec['gate_fails'] ?? []);
        $cut = $now - LOVE_GATE_LOCK;
        foreach ($f as $k => $ts) {
            $keep = array_values(array_filter((array)$ts, function ($t) use ($cut) { return $t > $cut; }));
            if ($keep) $f[$k] = $keep; else unset($f[$k]);
        }
        $list = $f[$ip] ?? [];
        $list[] = $now;
        if (count($list) >= LOVE_GATE_FAILS) { $b[$ip] = $now + LOVE_GATE_LOCK; $f[$ip] = []; }
        else { $f[$ip] = $list; }
        $sec['gate_fails'] = $f;
        $sec['gate_block'] = $b;
        return $sec;
    }, []);
}

/** 解锁成功：清掉该 IP 的失败计数 */
function love_gate_reset(): void {
    $ip = love_client_ip();
    love_mutate('security.json', function ($sec) use ($ip) {
        if (!is_array($sec)) $sec = [];
        $f = (array)($sec['gate_fails'] ?? []); unset($f[$ip]);
        $b = (array)($sec['gate_block'] ?? []); unset($b[$ip]);
        $sec['gate_fails'] = $f;
        $sec['gate_block'] = $b;
        return $sec;
    }, []);
}
