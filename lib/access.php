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

/* 本文件用到的 u_len / u_len_utf16 / u_str / love_data_dir / love_read / love_mutate
   全在共享存储层里。所有入口目前都是"先 require store.php 再 require access.php"，
   但依赖入口的 require 顺序迟早会漏（新入口单独 require 本文件就是一个未定义函数致命错误），
   require_once 自带"已加载就跳过"，由本文件自己保定最省事。 */
require_once __DIR__ . '/store.php';

const LOVE_GATE_COOKIE = 'love_gate';
const LOVE_GATE_DAYS   = 30;    // Cookie 有效期
const LOVE_GATE_FAILS  = 10;    // 连续失败次数
const LOVE_GATE_LOCK   = 600;   // 锁定时长（秒）
/* 口令长度上限 LOVE_GATE_MAX_PW（= 解锁页输入框 index.html 的 #pwInput 的
   maxlength，两侧必须同一口径：超长的一方永远对不上，F-S1-02）的**唯一定义处**
   是 lib/store.php —— 本文件已 require 它，直接用即可。放那边是为了让只加载
   store.php 的入口（如 lib/config.php）也能引用到同一个值，杜绝再抄一份字面量
   （第七轮 S1「待证 5」/ S3-04 同族的"常量两处定义"）。 */

/* ---------- config.json 的"可用性"（门禁状态的地基） ----------
   为什么需要单独一层：`love_read()` 把「文件不存在 / 内容为空 / JSON 语法错 /
   顶层不是数组」四种情况一律折成同一个默认值，对绝大多数调用方这是对的（读不到
   就用默认），但**门禁不能这样**：把"数据故障"当成"没设密码"，等于一次配置写坏
   就把整站私密内容放出去（第四轮 F-S1-01 实测：config.json 少一个逗号 →
   `__SERVER_GATE__={"required":false,"ok":true}`，情话/相册/情书/留言全部内联下发）。
   所以这里把"没启用"与"坏了"分开，由门禁层按 fail-closed 处理。

   返回 [解析出的配置数组, 是否损坏]：
     - 文件不存在        → [[], false]  （没启用门禁：全新安装 / 纯静态托管 / 本地预览）
     - 读不出来 / 空文件 → [[], true]   （FTP 上传被截断、权限问题）
     - JSON 语法错 / 顶层不是数组 → [[], true]（手改多打一个逗号等）
   注意：只做"能不能用"的判断，不改 `love_read()` 的语义 —— 它还有几十个调用方，
   那里"读不到就用默认"是对的，不该被动到。

   ⚠️ 读法与 `love_read()` 同款（`rb` + 共享锁）。第六轮 R5-7 把 `love_read()`
   修成"进共享锁"，但**门禁的地基**当时漏了：写侧 `love_mutate()` 是"就地
   ftruncate(0) → 写回"，写窗口内不加锁的读者要么读到空串（Linux），要么直接读失败
   （Windows 上写者持 LOCK_EX 时普通读被拒）—— 两条都走 `[[], true]`，即"配置损坏"。
   后果是同一请求内自洽地错到底：required=true、password=''、ok=false、unusable=true，
   于是持有效 Cookie 的已解锁访客被判成未解锁（api/config.php 注入 {required:true,ok:false}
   → 前端把他弹回解锁页），真正提交解锁的请求还会拿到 500「数据文件异常，请先修复」。
   全是误报：配置完好，写一结束就自愈（第七轮 S1-01）。
   拿不到锁（老主机/文件系统不支持 flock）时与 `love_read()` 一样退回裸读 ——
   绝不因为加锁而让"能读的文件读不出来"。 */
function love_gate_config_raw(): array {
    $path = love_data_dir() . '/config.json';
    if (!is_file($path)) return [[], false];
    $fp = @fopen($path, 'rb');
    if ($fp === false) {
        $raw = @file_get_contents($path);
    } else {
        $locked = @flock($fp, LOCK_SH);
        $raw = stream_get_contents($fp);
        if ($locked) @flock($fp, LOCK_UN);
        fclose($fp);
    }
    if ($raw === false || trim($raw) === '') return [[], true];
    $data = json_decode($raw, true);
    if (!is_array($data)) return [[], true];
    return [$data, false];
}

/** config.json 在，但读不出可用配置（数据故障） */
function love_gate_config_broken(): bool {
    [$c, $broken] = love_gate_config_raw();
    return $broken;
}

/** 服务端配置的解锁密码（空 = 不需要门禁） */
function love_gate_password(): string {
    /* 不做静态缓存：后台改密码后，同一进程的后续调用（含测试）要能立刻看到新值 */
    [$c, $broken] = love_gate_config_raw();
    if ($broken) return '';
    $pw = $c['password'] ?? '';
    /* 非标量（有人手改 config.json 把 password 写成数组/对象）时直接强转会抛
       "Array to string conversion" 警告；该函数在 api/config.php 里最先被调用，
       警告会插在注入语句之前 → 整站 JS 失效。这里一律按"无密码"处理。 */
    return is_scalar($pw) ? trim((string)$pw) : '';
}

/** 是否需要门禁（配了密码才需要）。
    fail-closed 的三种情形都必须算"需要门禁"，绝不能算"不需要"：
      1. config.json 损坏（解析不了 / 读不出来）；
      2. password 是非标量（写成了数组/对象）；
      3. password 是**纯空白**（既不是明确的 ""，也给不出可用口令）。
    第三种与第三轮对保存路径的要求同口径（`lib/config.php` 拒绝纯空白口令），
    否则"手写一个空格进磁盘"就成了绕过门禁的后门。 */
function love_gate_required(): bool {
    [$c, $broken] = love_gate_config_raw();
    if ($broken) return true;
    if (!array_key_exists('password', $c)) return false;   // 没配过密码
    $pw = $c['password'];
    /* 布尔也算故障态：`is_scalar(false)` 为真，而 `(string)false === ''` ——
       旧实现在这一格上漏出去，config.json 里写一句 `"password": false` 就能让
       love_gate_required() 返回 false、love_gate_password() 返回空串，
       整站门禁被一个手改的值关掉（私密配置/留言/情书/照片对所有人可见）。 */
    if (!is_scalar($pw) || is_bool($pw)) return true;  // 布尔 / 数组 / 对象 = 故障态
    /* 只有**显式空串**才等于"关闭门禁"（既有约定：本地夹具与 README 都这么写）。
       非空标量一律算门禁开着 —— 包括纯空白（下面 love_gate_password() 会 trim 成空，
       于是进入"口令不可得"的故障态，谁都不能解锁）。反过来写就漏了纯空白这一格：
       第一次实现写成 `trim($raw) !== ''`，等于"给个空格就绕开门禁"，被 D10 抓住。 */
    return (string)$pw !== '';
}

/** 门禁开着，但口令不可得（配置损坏 / 口令写着纯空白 / 非标量）：
    此时谁都无法解锁，属于**故障态**，必须如实告诉用户去修配置，
    而不是把他引到"密码不对"那条路（还会白扣失败次数、10 次锁 10 分钟）。 */
function love_gate_unusable(): bool {
    if (!love_gate_required()) return false;
    $pw = love_gate_password();
    if ($pw === '') return true;
    /* 手改 data/config.json 塞进一个比解锁页能输入的更长的口令时也一样进不去：
       输入框是 maxlength=40，界面上根本敲不进更长的串。
       这属于配置故障态，必须照实说是配置问题，别让人一遍遍打「自己设的那串」
       再被计 10 次失败锁在门外（F-S1-02）。
       ⚠️ 这里必须用 **u_len_utf16**（与输入框同尺的 UTF-16 码元），不能用 u_len：
       u_len 数的是码点，21 个 emoji 只算 21 ≤ 40 → 判"可用"，而输入框数的是
       码元（42 > 40）根本敲不进这么长 —— 判可用却永远输不进，同一格的老毛病
       换到非 BMP 字符上（第七轮 S1-04）。u_len_utf16 只在纯 BMP 文本上等于 u_len。 */
    return u_len_utf16($pw) > LOVE_GATE_MAX_PW;
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
    /* 门禁开着、但口令读不出来（配置损坏 / 纯空白 / 非标量）→ 谁都不算解锁。
       少了这一句，故障态下判"需要门禁"却仍会让持有旧 Cookie 的人进来；
       更要紧的是它与 love_gate_required() 的 fail-closed 必须成对出现，
       否则"required=true 但 ok=true"这种自相矛盾的组合会漏出去。 */
    if (love_gate_password() === '') return false;
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

/** security.json 的可用性三态：返回 [解析出的数组, 是否损坏]。
    读法与 love_read()/love_gate_config_raw() 同款（rb + 共享锁），语义：
      - 文件不存在        → [[], false]  全新站点 / 还没写过任何计数：没有可保护的东西
      - 读不出来 / 空文件 → [[], false]  与 love_read 一致，当"还没写过"
      - JSON 语法错 / 顶层不是数组（非空）→ [[], true]   **损坏**

    为什么必须和 love_read() 分开：`love_read('security.json', [])` 把"文件损坏"
    和"没锁过"折成同一个默认值，于是 security.json 一旦被写坏，
    `love_gate_locked_for()` 一律判"未锁定"、"10 次锁 10 分钟"这条保护**永久静默
    失效**（fail-open；口令本身仍要正确，不是提权，但防爆破名存实亡）——
    第七轮 S2 待证 1 / S1 待证 1。探测失败必须 fail-closed，与门禁读 config.json
    同一把尺（那边是 love_gate_config_raw）。 */
function love_security_raw(): array {
    $path = love_data_dir() . '/security.json';
    if (!is_file($path)) return [[], false];
    $fp = @fopen($path, 'rb');
    if ($fp === false) {
        $raw = @file_get_contents($path);
    } else {
        $locked = @flock($fp, LOCK_SH);
        $raw = stream_get_contents($fp);
        if ($locked) @flock($fp, LOCK_UN);
        fclose($fp);
    }
    if ($raw === false || trim($raw) === '') return [[], false];   // 读不出/空 → 当作"还没写过"
    $data = json_decode($raw, true);
    if (!is_array($data)) return [[], true];                       // 非空但解析不出对象 → 损坏
    return [$data, false];
}

/** security.json 存在但读不出可用计数（数据故障） */
function love_security_broken(): bool {
    [, $broken] = love_security_raw();
    return $broken;
}

/** 该 IP 是否已被锁定；返回剩余秒数（0 = 未锁定）。
    ⚠️ 返回 **-1** 表示 security.json **损坏**：调用方必须按 fail-closed 处理
    （拒绝解锁并如实报"安全计数文件损坏"），**绝不能**把 -1 当成"未锁定"放行。
    旧实现读损坏文件时得到空数组，与"从没失败过"无法区分 → 防爆破静默消失。 */
function love_gate_locked_for(): int {
    [$sec, $broken] = love_security_raw();
    if ($broken) return -1;
    $b = (array)($sec['gate_block'] ?? []);
    $until = (int)($b[love_client_ip()] ?? 0);
    $left = $until - time();
    return $left > 0 ? $left : 0;
}

/** 记一次失败；达到阈值则锁定。
    返回是否**确实记上了** —— 旧实现返回 void 且不看 love_mutate() 的返回值，
    写不进去（文件损坏 / data 不可写）时计数直接消失，调用方以为记上了，
    防护静默失效。现在由调用方（api/unlock.php）据此如实提示（第七轮 S2 待证 1）。 */
function love_gate_fail(): bool {
    $now = time();
    $ip = love_client_ip();
    $res = love_mutate('security.json', function ($sec) use ($now, $ip) {
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
    return is_array($res);
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
