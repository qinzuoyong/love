<?php
/* ============================================================
   情侣网站 · 共享存储层（管理员后台配套）
   - JSON 原子读写（flock + 临时文件 + rename）
   - 路径常量、管理员会话 / CSRF / 登录限流
   说明：所有自定义数据只存放在服务器 data/ 目录，
   网站更新（上传覆盖）永远不会碰它。
   ============================================================ */

declare(strict_types=1);

/* ---------- 诊断信息一律不许进响应体 ----------
   所有 PHP 入口都 require 本文件。主机 display_errors=On 时，任何警告/提示
   都会先于响应头输出，后果是连锁的：
     - json 接口的 Content-Type/Cache-Control 发不出去（"headers already sent"），
       响应退化成 text/html，前端 r.json() 直接失败；
     - api/config.php 被每页以 <script src> 加载，警告插在 window.__SERVER_* 之前
       → 整个注入脚本语法错误 → 整站 JS 失效；
     - 警告正文里带着文件绝对路径，等于把服务器目录结构告诉访客。
   统一关掉显示：该进错误日志的照常进（是否记录由主机 php.ini 的 log_errors 决定，
   排查看服务器日志），只是不再往响应体里写。display_errors 属 INI_ALL、
   运行时可改，所以这一行不依赖主机配置。 */
@ini_set('display_errors', '0');

/* ---------- 时区 ----------
   主机（InfinityFree 等）默认多为 UTC，会让服务端的"今天"与你们（UTC+8）
   差 8 小时 —— 时间胶囊的开启日、每日一问的换题日都会跟着错。
   time() 与已存的 ts 是绝对时间戳，不受影响；这里只固定 date() 的口径。 */
date_default_timezone_set('Asia/Shanghai');

/* ---------- UTF-8 辅助（不依赖 mbstring，有则自动用） ---------- */
function u_len(string $s): int {
    return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}
function u_sub(string $s, int $n): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n, 'UTF-8');
    // 无 mbstring：按字节截断，只丢掉"被切断的那个不完整字符"
    // （旧实现无条件再退一个前导字节，导致每次截断都少最后一个完整汉字）
    if (function_exists('iconv')) {
        $t = @iconv('UTF-8', 'UTF-8//IGNORE', substr($s, 0, $n * 3));
        if ($t !== false) return $t;
    }
    $t = substr($s, 0, $n * 3);
    $len = strlen($t);
    if ($len === 0) return '';
    // 找到最后一个字符的前导字节位置
    $lead = $len - 1;
    while ($lead > 0 && (ord($t[$lead]) & 0xC0) === 0x80) $lead--;
    $b = ord($t[$lead]);
    if (($b & 0x80) === 0x00) return $t;                       // 末尾是 ASCII，完整
    $need = ($b & 0xE0) === 0xC0 ? 2 : (($b & 0xF0) === 0xE0 ? 3 : (($b & 0xF8) === 0xF0 ? 4 : 1));
    if ($len - $lead >= $need) return $t;                      // 最后一个字符完整
    return substr($t, 0, $lead);                               // 被切断 → 丢掉它
}

/* 客户端可控值 → 字符串。非标量（数组/对象）一律当空串。
   直接 (string)$v 遇到数组会抛 "Array to string conversion" 警告，而 PHP 8 下
   警告会先输出、抢在响应头之前 —— 接口契约与全站 JS 都会被它破坏（见文件头）。
   标量与 null 的转换结果与 (string)$v 完全一致（null → ''），只是不再产生警告。 */
function u_str($v): string {
    return is_scalar($v) ? (string)$v : '';
}

/* ---------- 路径 ---------- */
function love_data_dir(): string {
    return dirname(__DIR__) . '/data';
}
function love_uploads_dir(): string {
    return dirname(__DIR__) . '/assets/img/uploads';
}

/* ---------- 目录保护（不依赖部署脚本：建目录时顺手落 .htaccess） ----------
   Nginx / 手工上传 / 只跑 install.php 的场景下 deploy.py 的 EXTRA_FILES 不会执行，
   这里做一次幂等兜底，保证 data/ 与 uploads/ 不会因为"忘了传保护文件"而裸奔。 */
function love_protect_dir(string $dir, string $body): void {
    if (!is_dir($dir)) return;
    /* 每次数据写入都会走到这里，而校验要读一遍 .htaccess —— 免费主机磁盘
       I/O 慢，同一请求内重复读同一份文件纯属浪费。用 static 记下"本请求
       已确认过该目录/该模板"，命中即跳过（只在成功后记，失败下次还会重试）。 */
    static $checked = [];
    $cacheKey = $dir . '|' . md5($body);
    if (isset($checked[$cacheKey])) return;
    $ht = $dir . '/.htaccess';
    /* 内容比对后再决定是否落盘（旧实现是"文件存在就直接 return"）。
       旧版本曾生成"只禁脚本执行、不禁止直链"的宽松保护，而"存在即跳过"
       让这类文件永远无法升级 —— 服务器上的上传照片就一直可以被直链
       访问，绕过 photo.php 的解锁校验。改成"内容不一致就覆盖"后，
       保护模板的更新才能真正生效，重复执行依然幂等。 */
    if (is_file($ht)) {
        $cur = @file_get_contents($ht);
        if (is_string($cur) && trim($cur) === trim($body)) { $checked[$cacheKey] = true; return; }
    }
    if (@file_put_contents($ht, $body, LOCK_EX) !== false) $checked[$cacheKey] = true;
}
function love_protect_data_dir(string $dir): void {
    love_protect_dir($dir,
        "# 情侣网站 data/ 保护（自动生成）\n" .
        "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n" .
        "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n");
}
function love_protect_uploads_dir(string $dir): void {
    /* 照片只能通过根目录 photo.php 代理读取（校验解锁 Cookie），
       所以这里直接整目录拒绝直链，而不是只禁脚本。 */
    love_protect_dir($dir,
        "# 情侣网站 uploads/ 保护（自动生成）\n" .
        "Options -Indexes\n" .
        "<IfModule mod_php.c>\n  php_flag engine off\n</IfModule>\n" .
        "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n" .
        "<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n");
}

/* ---------- 访客设备标识（HttpOnly Cookie，服务端权威） ----------
   安全说明：deviceId 是"删除自己内容"的凭据，绝不能下发给前端。
   由服务端在 Cookie 里保存，接口只回传布尔字段 mine。 */
const LOVE_DEV_COOKIE = 'love_dev';

/* 客户端提交的设备标识只接受"服务端签发过的形态"：'d' + 16 位小写字母数字。
     - 现行签发是 bin2hex(random_bytes(8))，即 'd' + 16 位小写 hex，属于该形态；
     - 线上还存有早期版本签发的 'd' + 16 位小写 base36（含 g-z），一并保留 ——
       收窄成纯 hex 会让那批历史记录认不出主人（默契度历史会凭空消失）；
     - 其它任何值（尤其 'admin' 这类可猜的字面量、或手工构造的短串）一律当作
       "没有 Cookie"重新签发。
   为什么必须收窄：deviceId 完全来自客户端 Cookie，却是"删除自己内容"的唯一凭据。
   后台上传照片曾把 deviceId 写死成字面量 'admin'，于是任何人只要把 love_dev 设成
   admin，就能通过 api/content.php 的归属校验删掉管理员上传的照片（连磁盘文件一起
   unlink）。形态校验把这类可猜值一次性挡在门外，包括将来新加的任何硬编码值。 */
const LOVE_DEV_PATTERN = '/^d[0-9a-z]{16}$/';

function love_is_https(): bool {
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') return true;
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') return true;
    if (strtolower((string)($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on') return true;
    return false;
}

/** 输出「http 自动升级到 https」的小脚本（后台页面用；前台 7 个页面在 assets/js/theme.js
    里有一份等价实现，那是全站最早执行、且每页都加载的脚本）。
    为什么需要：门禁/设备/会话三枚 Cookie 在 https 下都带 Secure，而浏览器**不允许
    http 页面覆盖 Secure Cookie**（RFC6265bis「Leave Secure Cookies Alone」）。于是
    "先在 https 解锁/登录、之后用 http 打开"会：http 请求不带 Secure Cookie → 被弹回
    解锁页或登录页；在 http 下重新输对密码、接口也返回成功，但响应里的新 Cookie 被浏览器
    拒收 → 反复弹回、怎么输都进不去（2026-09-12 实测复现）。从源头不让两种协议混用最省事。
    本地预览（localhost / 127.0.0.1 / 局域网 / *.local）必须排除，否则本地 http 调试会被
    跳到不存在的 https。 */
function love_emit_https_upgrade(): void {
    echo "\n  <script>\n"
       . "  (function () {\n"
       . "    if (location.protocol !== \"http:\") return;\n"
       . "    var h = location.hostname;\n"
       . "    if (/^(localhost|127\\.|0\\.0\\.0\\.0|10\\.|192\\.|169\\.254\\.)/.test(h)) return;\n"
       . "    if (/^172\\.(1[6-9]|2\\d|3[01])\\./.test(h)) return;\n"
       . "    if (/\\.local$/i.test(h)) return;\n"
       . "    location.replace(location.href.replace(/^http:/, \"https:\"));\n"
       . "  })();\n"
       . "  </script>\n";
}

function love_set_device_cookie(string $v): void {
    if (headers_sent()) return;
    @setcookie(LOVE_DEV_COOKIE, $v, [
        'expires'  => time() + 86400 * 365,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => love_is_https(),
    ]);
}

/** 当前访客的设备标识（没有就发一个；只存在于 HttpOnly Cookie，前端读不到） */
function love_device_id(): string {
    static $cached = null;
    if ($cached !== null) return $cached;
    $v = preg_replace('/[^A-Za-z0-9_-]/', '', u_str($_COOKIE[LOVE_DEV_COOKIE] ?? ''));
    /* 非服务端签发形态一律视为"没有 Cookie"（含伪造值）→ 重新签发。
       长度也由这条正则兜住，不再需要单独 substr。 */
    if (!preg_match(LOVE_DEV_PATTERN, $v)) $v = '';
    if ($v === '') {
        $v = 'd' . bin2hex(random_bytes(8));
        love_set_device_cookie($v);
        $_COOKIE[LOVE_DEV_COOKIE] = $v;   // 同一请求内立即可用
    }
    $cached = $v;
    return $cached;
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
    love_protect_data_dir($dir);
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
    love_protect_data_dir($dir);
    $path = $dir . '/' . $file;
    $fp = @fopen($path, 'c+');
    if (!$fp) return null;
    if (!flock($fp, LOCK_EX)) { fclose($fp); return null; }
    $raw = stream_get_contents($fp);
    $data = (is_string($raw) && trim($raw) !== '') ? json_decode($raw, true) : null;
    if (!is_array($data)) $data = is_array($default) ? $default : [];
    $out = $fn($data);
    /* 先编码成功、再截断落盘。
       旧实现是"先 ftruncate 清空、再判断 json_encode 是否成功"，
       一旦编码失败（非法 UTF-8 字节、NAN/INF、超深递归等），文件已被
       清空且不写回 —— content/compat/daily/security 会整份不可逆丢失。
       这里把编码提到截断之前，失败时原文件保持不动、返回 null。 */
    $json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        flock($fp, LOCK_UN);
        fclose($fp);
        return null;
    }
    /* 落盘：先截断再写，写不完整（磁盘写满 / I/O 错误）必须回滚，
       否则会留下一个被清空的文件 —— 与旧版"编码失败就清空"是同一类事故，
       只是触发条件换到了写入侧。 */
    $orig = is_string($raw) ? $raw : '';
    $failed = false;
    if (@ftruncate($fp, 0) === false || @rewind($fp) === false) {
        $failed = true;
    } else {
        $written = @fwrite($fp, $json);
        if ($written === false || $written < strlen($json)) $failed = true;
    }
    if ($failed) {
        @ftruncate($fp, 0);
        @rewind($fp);
        if ($orig !== '') @fwrite($fp, $orig);
        @fflush($fp);
        flock($fp, LOCK_UN);
        fclose($fp);
        return null;
    }
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
        'secure'   => love_is_https(),
    ]);
    @session_start();
}

/** 登录成功后调用：换新 Session ID，防会话固定攻击 */
function love_session_login(string $user): void {
    love_session();
    @session_regenerate_id(true);
    $_SESSION['love_admin'] = $user;
    $_SESSION['love_csrf'] = bin2hex(random_bytes(16));
    $_SESSION['love_seen'] = time();
}

/** 会话空闲超时（默认 8 小时）；超时即视为未登录 */
function love_session_touch(int $ttl = 28800): bool {
    love_session();
    $now = time();
    $seen = (int)($_SESSION['love_seen'] ?? 0);
    if (!empty($_SESSION['love_admin']) && $seen > 0 && $now - $seen > $ttl) {
        $_SESSION = [];
        return false;
    }
    if (!empty($_SESSION['love_admin'])) $_SESSION['love_seen'] = $now;
    return true;
}

function love_admin_exists(): bool {
    $a = love_read('admin.json');
    /* username/pass_hash 都必须是**非空字符串**：数组型的哈希一旦落盘（历史
       漏洞/手改文件），空的 !empty 检查拦不住它，登录侧 password_verify(数组)
       会在 PHP 8 抛 TypeError → 500。读取侧这道闸保证最坏情况只是"登录不上"。 */
    return is_array($a)
        && is_string($a['username'] ?? null) && $a['username'] !== ''
        && is_string($a['pass_hash'] ?? null) && $a['pass_hash'] !== '';
}

function love_admin_verify(string $user, string $pass): bool {
    $a = love_read('admin.json');
    if (!is_array($a)) return false;
    $hash = is_string($a['pass_hash'] ?? null) ? $a['pass_hash'] : '';
    if ($hash === '') return false;
    $ok = password_verify($pass, $hash)
        && hash_equals(is_string($a['username'] ?? null) ? $a['username'] : '', $user);
    if (!$ok) password_verify('x', $hash); // 恒定时间，避免用户名枚举侧信道
    return $ok;
}

function love_logged_in(): bool {
    love_session();
    if (!love_session_touch()) return false;
    if (empty($_SESSION['love_admin'])) return false;
    /* 光看 session 不够：admin.json 被删/被清空后旧 session 依然"有效"，
       后台接口会继续可用（表现为"删了管理员账号，别人还能操作"）。
       这里要求账号确实还在服务器上。 */
    return love_admin_exists();
}

function love_require_login(): void {
    if (!love_logged_in()) love_json(['ok' => false, 'error' => '未登录'], 401);
}

function love_csrf(): string {
    love_session();
    if (empty($_SESSION['love_csrf'])) $_SESSION['love_csrf'] = bin2hex(random_bytes(16));
    return $_SESSION['love_csrf'];
}

/* 参数不声明 string：客户端把 csrf 传成数组/对象时，PHP 会按类型声明直接抛
   TypeError（致命错误、500），而不是老老实实返回"校验失败"。这里自己收窄。 */
function love_csrf_ok($t): bool {
    love_session();
    $t = u_str($t);
    return $t !== '' && hash_equals($_SESSION['love_csrf'] ?? '', $t);
}

/* ---------- 限流 ---------- */

/* 是否采信反向代理/CDN 传来的 X-Forwarded-For。
   默认 false —— 该头部客户端可随意伪造，无条件采信等于把限流和封禁
   交给攻击者（换个 IP 就能绕过锁定、或反过来栽赃别人）。
   只有当站点确实部署在可信代理之后（如 Cloudflare + Nginx 回源）才打开。
   本项目默认部署在 InfinityFree（无自建反代），保持关闭。 */
const LOVE_TRUST_PROXY = false;

function love_client_ip(): string {
    $ip = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    if (LOVE_TRUST_PROXY) {
        $fwd = (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
        if ($fwd !== '') {
            $first = trim(explode(',', $fwd)[0]);   // 代理链里最靠近客户端的一跳
            if ($first !== '') $ip = $first;
        }
    }
    $ip = preg_replace('/[^0-9a-fA-F:.]/', '', $ip);
    return $ip !== '' ? $ip : '?';
}

/* 登录限流：按 IP 计 5 次失败锁 10 分钟。
   （旧版是全站共享一个计数：任何人都能连错 5 次把管理员锁死） */
function love_throttle_blocked(?string $ip = null): bool {
    $ip = $ip ?? love_client_ip();
    $sec = love_read('security.json', []);
    $b = (array)($sec['login_block'] ?? []);
    return (int)($b[$ip] ?? 0) > time();
}

function love_throttle_fail(): void {
    $now = time();
    $ip = love_client_ip();
    love_mutate('security.json', function ($sec) use ($now, $ip) {
        if (!is_array($sec)) $sec = [];
        $b = (array)($sec['login_block'] ?? []);
        foreach ($b as $k => $t) if ((int)$t <= $now) unset($b[$k]);
        /* 过期记录必须"全量"清理：旧实现只过滤当前 IP 的列表，别的 IP 的条目
           会永久留在 security.json 里（每个失败过一次的 IP 一条）。被扫描/刷
           的时候文件会持续膨胀，而它每个写请求都要整份读写。
           口径与 love_rate_ok() 里 hits 桶的处理保持一致。 */
        $f = (array)($sec['login_fails'] ?? []);
        $cut = $now - 600;
        foreach ($f as $k => $ts) {
            $keep = array_values(array_filter((array)$ts, function ($t) use ($cut) { return $t > $cut; }));
            if ($keep) $f[$k] = $keep; else unset($f[$k]);
        }
        $list = $f[$ip] ?? [];
        $list[] = $now;
        if (count($list) >= 5) { $b[$ip] = $now + 600; $f[$ip] = []; }
        else { $f[$ip] = $list; }
        $sec['login_fails'] = $f;
        $sec['login_block'] = $b;
        return $sec;
    }, []);
}

function love_throttle_reset(): void {
    $ip = love_client_ip();
    love_mutate('security.json', function ($sec) use ($ip) {
        if (!is_array($sec)) $sec = [];
        $f = (array)($sec['login_fails'] ?? []); unset($f[$ip]);
        $b = (array)($sec['login_block'] ?? []); unset($b[$ip]);
        $sec['login_fails'] = $f;
        $sec['login_block'] = $b;
        return $sec;
    }, []);
}

/** 访客写接口限流：按 IP + 桶名分桶计数（旧版 $key 算了没用，实际是全站共享一份额度） */
function love_rate_ok(string $bucket, int $limit, int $window): bool {
    $now = time();
    $ip = love_client_ip();
    $ok = true;
    $res = love_mutate('security.json', function ($sec) use ($bucket, $ip, $limit, $window, $now, &$ok) {
        if (!is_array($sec)) $sec = [];
        $all = (array)($sec['hits'] ?? []);
        // 先清理过期计数，避免文件无限增长
        foreach ($all as $b => $ips) {
            foreach ((array)$ips as $k => $ts) {
                $keep = array_values(array_filter((array)$ts, function ($t) use ($now, $window) {
                    return $t > $now - $window;
                }));
                if ($keep) $all[$b][$k] = $keep; else unset($all[$b][$k]);
            }
            if (empty($all[$b])) unset($all[$b]);
        }
        $list = (array)($all[$bucket][$ip] ?? []);
        if (count($list) >= $limit) {
            $ok = false;
        } else {
            $list[] = $now;
        }
        $all[$bucket][$ip] = array_values($list);
        $sec['hits'] = $all;
        return $sec;
    }, []);
    /* 存储不可用时放行（fail-open）：这是刻意的取舍 —— 情侣小站里
       "限流文件写不进去就干脆不让留言"的代价（服务直接不可用）远大于
       "限流暂时失效"。若将来需要严格的防刷场景，应改成 return false。 */
    if (!is_array($res)) return true;
    return $ok;
}
