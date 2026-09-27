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

/* ---------- UTF-8 辅助（不依赖 mbstring，有则自动用） ----------
   ⚠️ 这两个函数的口径**必须完全一致**，而且必须是"字符数"而不是"字节数"：
   校验层（lib/config.php 的 cfg_s、各处的 `u_len(...) > 上限`）与截断层用的是
   同一把尺，量出来的必须是同一个东西。历史上不是 —— 无 mbstring 的主机上
   `u_len()` 数的是**字节**，而 `cfg_s()` 退化成"最多截 n*3 字节"，
   于是后台能存下 200 个汉字的题干（600 字节）并注入前端，运行层
   `COMPAT_Q_MAX` 一量却是 600 > 200 → `api/compat.php` 的 create 一律
   「参数错误」，两个人永远开不了局，前端只看到一个查不到根因的提示
   （第五轮 R5-6，实测证据见 _test_round6_fixes.py 的红/绿两跑）。 */
function u_len(string $s): int {
    if (function_exists('mb_strlen')) return mb_strlen($s, 'UTF-8');
    /* 无 mbstring：数 UTF-8 码点 = 「字节数 − 续字节数（0x80~0xBF）」。
       对合法 UTF-8 这正好等于字符数；对畸形字节也只会高估，不会漏数。 */
    $cont = preg_match_all('/[\x80-\xBF]/', $s);
    return strlen($s) - (is_int($cont) ? $cont : 0);
}
function u_sub(string $s, int $n): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n, 'UTF-8');
    if ($n <= 0) return '';
    /* 无 mbstring：按**码点**截断，恰好留前 n 个字符（与 u_len 同尺）。
       旧实现是 `substr($s, 0, $n * 3)` —— 对 ASCII 就等于放行 3n 个字符，
       明明只允许 20 个字符的字段能存下 60 个 ASCII 字符，切完再交给
       `u_len()` 一量又超限，又绕回上面那个"存得下、用不了"的死结。
       末尾若是被切断的半个字符，直接丢掉（不留豆腐块）。 */
    $len = strlen($s);
    $i = 0;
    $count = 0;
    while ($i < $len && $count < $n) {
        $b = ord($s[$i]);
        $step = ($b < 0x80) ? 1
            : ((($b & 0xE0) === 0xC0) ? 2
            : ((($b & 0xF0) === 0xE0) ? 3
            : ((($b & 0xF8) === 0xF0) ? 4 : 1)));   // 非法前导字节当单字节，保证前进
        if ($i + $step > $len) break;               // 末尾是不完整的字符 → 丢掉
        $i += $step;
        $count++;
    }
    return substr($s, 0, $i);
}

/* 长度按 **UTF-16 码元**数 —— 只给"上限由浏览器输入框决定"的那一格用
   （目前只有解锁口令：index.html 的 #pwInput 是 maxlength=40）。

   为什么不能直接用 u_len()：HTML 的 maxlength 与 JS 的 `.length` 数的是
   UTF-16 码元，非 BMP 字符（emoji）占 2 个；而 u_len() 数的是**码点**。
   两者只在纯 BMP 文本上相等。于是"21 个 emoji 的口令"在 u_len 眼里是
   21 ≤ 40（判"可用"），而解锁页输入框物理上最多只敲得进 20 个 ——
   主人拿自己设的口令永远解不开，界面只会说「密码不对哦」，还要白扣 10 次
   失败、锁 10 分钟（第七轮 S1-04）。口令的上限判据必须与输入框同尺：
   输入框放得下的（≤40 码元）才算可用，放不下的一律按"配置故障"报出来。
   非法 UTF-8（PCRE 数不出来）时返回字节数，只会高估 → 宁拒不放（fail-closed）。 */
function u_len_utf16(string $s): int {
    $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
    if (!is_int($astral)) return strlen($s);
    return u_len($s) + $astral;
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
   这里做一次幂等兜底，保证 data/ 与 uploads/ 不会因为"忘了传保护文件"而裸奔。

   归属判据（第七轮 S12-03）：本函数只维护**自己写的**那份 —— 带下面这个标记、
   或历史版本留下的「自动生成」抬头的，才允许按模板升级（旧版宽松规则要能被覆盖修好）；
   没有标记的一律不碰：那是 tools/deploy.py 传上去的模板（带同源约束注释）或手工写的
   规则，运行时绝不静默覆盖部署侧的内容。 */
const LOVE_PROTECT_MARK = '# love-protect: managed by lib/store.php';
function love_protect_dir(string $dir, string $body): void {
    if (!is_dir($dir)) return;
    $body = LOVE_PROTECT_MARK . "\n" . $body;
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
       保护模板的更新才能真正生效，重复执行依然幂等。
       ⚠️ 覆盖只针对我们自己的文件（见上面 LOVE_PROTECT_MARK 的归属判据）。 */
    if (is_file($ht)) {
        $cur = @file_get_contents($ht);
        if (is_string($cur)) {
            if (trim($cur) === trim($body)) { $checked[$cacheKey] = true; return; }
            $ours = (strpos($cur, LOVE_PROTECT_MARK) !== false) || (strpos($cur, '自动生成') !== false);
            if (!$ours) { $checked[$cacheKey] = true; return; }   // 部署侧/手工文件：不动
        }
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
       . "    if (/^(localhost|127\\.|0\\.0\\.0\\.0|10\\.|192\\.168\\.|169\\.254\\.)/.test(h)) return;\n"
       . "    if (/^172\\.(1[6-9]|2\\d|3[01])\\./.test(h)) return;\n"
       . "    if (/\\.local$/i.test(h)) return;\n"
       /* IPv6 字面量同上："[::1]" 带方括号，上面的 IPv4/域名规则都匹配不到。
          与 assets/js/theme.js 里那份实现保持一致（两处必须同口径）。 */
       . "    if (/^\\[?(::1|::|f[cd][0-9a-f]{2}:|fe80:)/i.test(h)) return;\n"
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
    /* 读也要拿**共享锁**。写侧（love_mutate）是"就地 ftruncate(0) → 写回"，
       中间存在一个"文件是空的"窗口；不加锁的读者正好落在那一瞬就会读到空串，
       love_read() 把它当成"文件不存在"回 default —— 表现为 config.json 被
       `love_config_status()` 判成 broken：已解锁的访客被弹回解锁页，
       `api/unlock.php` 直接 500（第五轮 R5-7）。共享锁只在写者持有排他锁
       期间阻塞，读-读之间互不影响。
       拿不到锁（老主机/文件系统不支持 flock）就退回裸读 —— 与旧行为一致，
       绝不因为加锁而让"能读的文件读不出来"。 */
    $fp = @fopen($path, 'rb');
    if ($fp === false) {
        $raw = @file_get_contents($path);
    } else {
        $locked = @flock($fp, LOCK_SH);
        $raw = stream_get_contents($fp);
        if ($locked) @flock($fp, LOCK_UN);
        fclose($fp);
    }
    if ($raw === false || trim($raw) === '') return $default;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

/** 整份写一个 JSON 文件（临时文件 + rename，原子替换）。
    ⚠️ **它不参与 flock**：如果这个文件还有别的写者（访客侧的 love_mutate、
    后台的 admin_replace），并发时 rename 会让对方手里那个 inode 变成孤儿 ——
    对方那次写整体丢失，而它照样报成功。所以：**凡是有并发写者的文件，整份替换
    也必须走 love_mutate**（后台 save_config 与 admin_replace 都这么做了，F-S2-03）。
    本函数保留给"只可能有一个写者"的场景（目前只剩 lib/content.php 里那处未使用的
    迁移辅助代码）。 */
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

/** love_mutate() 失败退出前的收尾：若那个文件是**本次调用新建**的、且最终没写成
    任何内容（仍为 0 字节），就把它删掉。

    为什么需要：`fopen($path, 'c+')` 在文件不存在时会**先创建**一个空文件。此后任何
    一条失败路径（"解析不出对象且非空"守卫、加锁失败、json_encode 失败、写入失败回滚）
    都会 `return null` 而把这个新建的空文件留在磁盘上。最现实的后果是 install.php：
    建号时一次 json_encode 失败（非法 UTF-8 用户名）留下 0 字节 `data/admin.json`，
    它自己的 `$broken` 判据从此成立 → 页面永久显示"已存在但内容不完整或不合法，
    不能安装"，站主按提示改权限永远修不好，只能手删文件（第七轮 S4-08 顺带发现 ①）。

    ⚠️ 绝不删原本就存在的文件：判据是调用前 `is_file()` 的结果（$existedBefore），
    且删除**前再确认它仍为 0 字节**（并发写者/其它进程可能已经填进内容）。
    空文件被删掉后，下一次写入会重新创建并按 default 处理，语义与"从未写过"一致。 */
function love_mutate_drop_new_file(string $path, bool $existedBefore, $fp): void {
    if (is_resource($fp)) {
        @flock($fp, LOCK_UN);
        @fclose($fp);
    }
    if ($existedBefore) return;
    if (is_file($path) && (int)@filesize($path) === 0) @unlink($path);
}

/** 加锁读改写（留言板/照片等并发追加场景）。
    $replace=true 表示"整份替换"：不看旧内容，只有 $default 会被用到（后台恢复备份走它）。 */
function love_mutate(string $file, callable $fn, $default = null, bool $replace = false) {
    $dir = love_data_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return null;
    love_protect_data_dir($dir);
    $path = $dir . '/' . $file;
    /* 记下"本次调用之前文件在不在"：失败收尾时据此决定要不要删掉新建的空文件
       （见 love_mutate_drop_new_file）。 */
    $existedBefore = is_file($path);
    $fp = @fopen($path, 'c+');
    if (!$fp) return null;
    if (!flock($fp, LOCK_EX)) { love_mutate_drop_new_file($path, $existedBefore, $fp); return null; }
    $raw = stream_get_contents($fp);
    $data = (is_string($raw) && trim($raw) !== '') ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        /* "有内容但解析不出对象"和"文件不存在/是空的"必须分开：后者是全新安装或
           尚未写入过（的 default 就是真相），前者几乎都是事故 —— FTP 上传被截断、
           手改 config 少写一个逗号、磁盘写满留下的半截文件。旧实现把两者一律按
           default 处理，于是 content.json 一损坏，任意访客再发一条留言就把
           letters / photos / 旧 messages 整份抹掉，而这一次调用照样返回 ok:true
           （= 静默全量数据丢失）。这里放锁什么都不写地返回 null：调用方的
           `if (!is_array($out)) → 服务器繁忙` 会如实报错，损坏的原文件保持原样。
           $replace=true 走不到这道闸 —— 恢复备份正是修好损坏文件的唯一入口，
           被拦住就再也没有修的手段了。 */
        if (!$replace && trim((string)$raw) !== '') {
            love_mutate_drop_new_file($path, $existedBefore, $fp);
            return null;
        }
        $data = is_array($default) ? $default : [];
    }
    $out = $fn($data);
    /* 先编码成功、再截断落盘。
       旧实现是"先 ftruncate 清空、再判断 json_encode 是否成功"，
       一旦编码失败（非法 UTF-8 字节、NAN/INF、超深递归等），文件已被
       清空且不写回 —— content/compat/daily/security 会整份不可逆丢失。
       这里把编码提到截断之前，失败时原文件保持不动、返回 null。 */
    $json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) {
        love_mutate_drop_new_file($path, $existedBefore, $fp);
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
        /* 写失败回滚：新建的文件（$orig === ''）回滚后仍是 0 字节，必须删掉，
           否则与上面几条失败路径同病（留下一个卡死 install.php 的空文件）。 */
        love_mutate_drop_new_file($path, $existedBefore, $fp);
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

/** 这个 POST 是不是从本站页面发出的（跨站请求过滤器）。
    为什么要有：有些入口不需要登录就能打到，而它们会改状态或消耗限流计数
    （api/unlock.php 就是：10 次失败锁 10 分钟，手机运营商 NAT 下会连带同出口的人）。
    任何第三方页面都能用最简单的表单 POST 驱动它们，这正是 CSRF 的典型形状。
    判据：带 Origin 必须是本站；没有 Origin 时退回看 Referer；两者都没有
    （curl、本站自己的套件）放行 —— 浏览器发 POST 一定会带 Origin，
    所以「两缺」那一格不是 CSRF 能利用的路径。
    **只比 host、不比 scheme**：本站走 https 而反向代理没有透出 X-Forwarded-Proto 时，
    比 scheme 会把正常解锁一起堵掉；这条判据绝不允许把正常路径堵掉。 */
function love_origin_ok(): bool {
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '') return true;                       // 推不出本站 host → 不误伤
    $src = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($src === '') $src = trim((string)($_SERVER['HTTP_REFERER'] ?? ''));
    if ($src === '') return true;                        // 非浏览器客户端
    if (strtolower($src) === 'null') return false;       // 沙箱 iframe / file:// 页面
    $parts = parse_url($src);
    if (!is_array($parts) || empty($parts['host'])) return false;
    $srcHost = strtolower((string)$parts['host']);
    $hostNoPort = preg_replace('/:\d+$/', '', $host);
    return $srcHost !== '' && $srcHost === $hostNoPort;
}

/* ---------- 管理员会话 / CSRF / 限流 ---------- */

/** 会话空闲超时（秒）：8 小时，按站主"边写边查资料"的实际节奏定。
    ⚠️ 必须与 `love_session()` 里交给 PHP 的 `session.gc_maxlifetime` 同源：
    只写注释/常量、不告诉 PHP 的话，会话文件会按 php.ini 的默认值（1440 秒）
    就被 GC 收走，`love_session_touch()` 里那个 8 小时**永远执行不到**
    （文件没了 → 下一个请求拿到空会话 → 直接判定未登录，F-S4-03）。 */
const LOVE_SESSION_TTL = 28800;

function love_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name('loveadm');
    /* GC 判据按"会话文件多久没被写过"算，所以把它提到与上面同一个 8 小时。
       放在 session_start() 之前：PHP 的 GC 是在启动会话时按这个值执行的，
       启动之后再设只对"本请求之后启动的会话"有效。 */
    @ini_set('session.gc_maxlifetime', (string)LOVE_SESSION_TTL);
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
    $_SESSION['love_pwgens'] = [];
    love_session_rebind();
}

/** 当前口令的"代次"指纹：admin.json 里的 pass_hash 一变，指纹就变。
    为什么需要它：会话里只存了用户名，改口令后旧会话照样有效 ——
    口令泄露之后站主「改密码」这个动作**踢不掉已经登录的对方**（F-S4-02），
    而那正是改口令唯一的意义。指纹取自哈希本身，所以不用往 admin.json 加新键
    （手改数据文件、恢复旧备份进来的记录都照样对得上）。 */
function love_admin_pwgen(): string {
    $a = love_read('admin.json');
    $h = is_string($a['pass_hash'] ?? null) ? $a['pass_hash'] : '';
    return $h === '' ? '' : hash('sha256', 'love-admin-pwgen|' . $h);
}

/** 一条会话"连续有效期间见过"的口令指纹上限。
    为什么是**一组**而不是一个：站主手改或恢复 data/admin.json 时哈希会前后变动，
    而这次变动发生在**这条会话一直有效**的期间内（比如后台的"恢复备份"，
    或者站主按 README 手动改文件救急），它就该继续有效 —— 否则"自己动配置文件"
    会把自己踢出去。集合只装这条会话亲身经历过的值，第 5 个进来就把最早的挤掉，
    所以它不会无限膨胀，也不给会话任何"新口令的访问权"：
    口令一变，别处的会话集合里没有这个新值，立刻失效。 */
const LOVE_PWGEN_KEEP = 4;

/** 让当前会话按服务器上的**最新**口令重新认账。
    两处会改到 admin.json 的入口在写完之后调用它：
      - change_password：操作者本人不该被自己刚设的口令踢出去（别人该被踢）
      - restore（admin_restored=true）：恢复一份备份之后站主还要接着用面板
    它只重挂当前这一条会话，别的会话拿不到这次重挂 —— 失效语义因此不受影响。 */
function love_session_rebind(): void {
    love_session();
    if (empty($_SESSION['love_admin'])) return;
    $g = love_admin_pwgen();
    if ($g === '') return;
    $seen = love_session_pwgens();
    if (!in_array($g, $seen, true)) $seen[] = $g;
    if (count($seen) > LOVE_PWGEN_KEEP) $seen = array_slice($seen, -LOVE_PWGEN_KEEP);
    $_SESSION['love_pwgens'] = $seen;
}

/** 会话里记着的口令指纹（只保留字符串，脏值一律丢掉） */
function love_session_pwgens(): array {
    $seen = $_SESSION['love_pwgens'] ?? null;
    if (!is_array($seen)) return [];
    return array_values(array_filter($seen, function ($v) { return is_string($v) && $v !== ''; }));
}

/** 会话空闲超时（默认 8 小时，与 LOVE_SESSION_TTL 同源）；超时即视为未登录 */
function love_session_touch(int $ttl = LOVE_SESSION_TTL): bool {
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
    if (!love_admin_exists()) return false;
    /* 口令代次：口令一旦被改掉，全部旧会话立即失效（F-S4-02）。会话里没有这份
       记录（本次改动之前就存在的旧会话）同样按失效处理，要求重新登录。 */
    $g = love_admin_pwgen();
    if ($g === '' || !in_array($g, love_session_pwgens(), true)) {
        $_SESSION = [];
        return false;
    }
    return true;
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

/* ---------- 解锁口令长度上限（**唯一来源**） ----------
   值 = 解锁页输入框的 maxlength（index.html 的 #pwInput），两侧必须同一口径：
   超长的一方永远对不上（F-S1-02）。放在共享存储层（所有入口都 require 本文件）
   而不是 lib/access.php，是为了让**只加载 store.php 的入口**（lib/config.php 由
   admin/api.php 引入时先于 access.php；将来任何新入口也一样）也能引用到同一个值，
   不必再抄一份字面量。lib/access.php 与 lib/config.php 都直接引用这里，禁止各写一份。 */
const LOVE_GATE_MAX_PW = 40;

/* ---------- 访客写接口限流额度（**唯一来源**） ----------
   三个写入口（api/content.php 的留言/情书/删除与照片、api/daily.php 的每日一答、
   api/compat.php 的默契度）都从这里取额度，不再各写一份常量 ——
   改一处即全体生效（第七轮 S3-04 残留：额度曾分散在三个 api 文件里，改一处忘另一处就漂）。
   桶名各自独立（content / photo / daily / compat），互不挤占额度。 */
const LOVE_RATE_CONTENT_LIMIT = 30;    // 留言/情书/删除：每 IP 每窗口
const LOVE_RATE_PHOTO_LIMIT   = 120;   // 照片：一张一次请求，批量上传很容易超
const LOVE_RATE_DAILY_LIMIT   = 30;    // 每日一答
const LOVE_RATE_COMPAT_LIMIT  = 20;    // 默契度写入
const LOVE_RATE_WINDOW        = 600;   // 所有访客写接口共用同一窗口（秒）

/** 取某桶的 [额度, 窗口]；未知桶返回 [null, 窗口]（= 不限流）。
    单独成函数是为了让"判定"只有一处口径：新增桶只改这张表。 */
function love_rate_profile(string $bucket): array {
    $limit = [
        'content' => LOVE_RATE_CONTENT_LIMIT,
        'photo'   => LOVE_RATE_PHOTO_LIMIT,
        'daily'   => LOVE_RATE_DAILY_LIMIT,
        'compat'  => LOVE_RATE_COMPAT_LIMIT,
    ][$bucket] ?? null;
    return [$limit, LOVE_RATE_WINDOW];
}

/** 访客写接口限流的统一判定：三个写入口都调它。
    未知桶 fail-open（与 love_rate_ok 的存储不可用契约一致），但**已知桶**一律按
    额度表判 —— 调用方不许再自己传 limit/window。 */
function love_rate_allowed(string $bucket): bool {
    [$limit, $window] = love_rate_profile($bucket);
    if ($limit === null) return true;
    return love_rate_ok($bucket, $limit, $window);
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
            /* 桶值必须是数组：hits 被手改/外部写入成标量时（{"hits":{"compat":0}}、
               {"hits":"123"} 这类"桶被写成值"的形态），下面那层 `foreach ((array)$ips ...)`
               会把标量当成 [0 => 标量] 展开，过滤判它过期后走 unset($all[$b][$k]) ——
               在标量上下标 unset 在 PHP 8 是**未捕获的致命 Error**（不是警告），
               而全仓库没有 try/catch 兜底：love_rate_ok() 的每个调用点一起 500
               （留言/情书/胶囊/照片写入、默契度、每日一问、后台状态查询全部不可用，
               必须手工改 security.json 才能恢复），与函数注释写明的 fail-open 相反。
               父级不是数组就直接重建该桶（与 lib/access.php 的失败计数同一口径）。 */
            if (!is_array($ips)) { unset($all[$b]); continue; }
            foreach ($ips as $k => $ts) {
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
