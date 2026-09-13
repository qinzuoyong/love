<?php
/* ============================================================
   情侣网站 · 管理员接口
   除 login/whoami 外均需登录。所有状态变化都带 CSRF 校验。
   数据只读写服务器 data/ 目录（网站更新永不覆盖）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';
require __DIR__ . '/../lib/content.php';
require __DIR__ . '/../lib/daily.php';
require __DIR__ . '/../lib/config.php';  // CFG_KEYS / cfg_* / sanitize_cfg（与 api/config.php 共用一套口径）
require __DIR__ . '/../lib/compat.php';  // compat_sanitize_rounds：恢复备份时清洗默契度回合

function admin_account(): array {
    $a = love_read('admin.json', []);
    return is_array($a) ? $a : [];
}

/** 整份替换一个 JSON 数据文件（带锁）。
    恢复备份期间访客可能正在写 content.json / compat.json / daily.json，
    必须与访客侧的 love_mutate 共用同一把 flock —— 旧的 love_write 是
    "临时文件 + rename"的原子替换、不参与加锁，两者并发时 rename 会让
    访客持有的旧 inode 变成孤儿，他那次提交（留言/照片记录）会整体丢失。 */
function admin_replace(string $file, array $data): bool {
    $res = love_mutate($file, function () use ($data) { return $data; }, []);
    return is_array($res);
}

/* 恢复备份时逐条清洗 content.json 的条目：只保留已知字段且类型正确，
   uid 必须是合法 id。损坏或手工拼凑的备份不会把非法结构灌进数据文件。 */
function content_sanitize_item(string $kind, $r): ?array {
    if (!is_array($r)) return null;
    $uid = clean_id(u_str($r['uid'] ?? ''));
    if ($uid === '') return null;
    $dev = clean_id(u_str($r['deviceId'] ?? ''));
    $ts  = (int)($r['ts'] ?? 0);
    switch ($kind) {
        case 'photos': {
            $src = u_str($r['src'] ?? '');
            if (strpos($src, 'assets/img/') !== 0) return null;
            return ['src' => $src, 'cap' => u_sub(u_str($r['cap'] ?? ''), 60),
                    'uid' => $uid, 'deviceId' => $dev, 'ts' => $ts];
        }
        case 'letters': {
            $t = u_sub(u_str($r['title'] ?? ''), 30);
            $b = u_sub(u_str($r['body'] ?? ''), 2000);
            if ($t === '' || $b === '') return null;
            /* 日期必须是真实存在的日期：旧实现只滤掉非数字字符，'2026-13-45'
               或空串都会原样写进 content.json，前台排序与格式化随即出 NaN。
               与 letter_add 同口径：不合法就回退到今天（保住这封信的内容）。 */
            $d = preg_replace('/[^0-9-]/', '', u_str($r['date'] ?? ''));
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $dm)
                || !checkdate((int)$dm[2], (int)$dm[3], (int)$dm[1])) {
                $d = date('Y-m-d');
            }
            return ['date' => $d, 'title' => $t, 'body' => $b,
                    'sign' => u_sub(u_str($r['sign'] ?? ''), 20),
                    'uid' => $uid, 'deviceId' => $dev, 'ts' => $ts];
        }
        case 'messages': {
            $x = u_sub(u_str($r['text'] ?? ''), 100);
            if ($x === '') return null;
            $name = u_sub(u_str($r['name'] ?? ''), 10);
            return ['name' => $name === '' ? '匿名' : $name, 'text' => $x,
                    'ts' => $ts, 'uid' => $uid, 'deviceId' => $dev];
        }
        case 'capsules': {
            $t = u_sub(u_str($r['title'] ?? ''), 30);
            $b = u_sub(u_str($r['body'] ?? ''), 2000);
            $oa = preg_replace('/[^0-9-]/', '', u_str($r['openAt'] ?? ''));
            if ($t === '' || $b === '' || $oa === '') return null;
            /* 开启日必须是真实日期。这里丢掉整条，而不是像情书那样回退到今天：
               胶囊的前提是"到期才能读"，把坏日期改成今天等于就地拆封、
               反而泄露了本该封着的内容（内容本身还留在备份文件里）。 */
            if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $oa, $om)
                || !checkdate((int)$om[2], (int)$om[3], (int)$om[1])) {
                return null;
            }
            return ['title' => $t, 'body' => $b,
                    'sign' => u_sub(u_str($r['sign'] ?? ''), 20), 'openAt' => $oa,
                    'uid' => $uid, 'deviceId' => $dev, 'ts' => $ts];
        }
        default:
            return null;
    }
}

function require_csrf(array $in): void {
    if (!love_csrf_ok($in['csrf'] ?? null)) love_json(['ok' => false, 'error' => '页面已过期，请刷新后重试'], 403);
}

/* ---------- 无需登录 ---------- */
if (($_GET['action'] ?? '') === 'whoami') {
    /* 面板启动时匿名问一次。限流只针对**未登录**请求：它的作用是让"这个站
       有没有装后台"不那么容易被批量探测，而探测请求都是匿名的。反过来，
       同一出口 IP（校园网 / 公司 NAT）被刷满额度时，真正的管理员开面板会一起
       吃 429 —— 已持有登录会话本身就证明是自己人，不必再按 IP 计数。 */
    love_session();
    if (!love_logged_in() && !love_rate_ok('whoami', 120, 60)) {
        love_json(['ok' => false, 'error' => '请求太频繁，请稍后再试'], 429);
    }
    love_json([
        'ok' => true,
        'logged_in' => love_logged_in(),
        'username' => $_SESSION['love_admin'] ?? '',
        'csrf' => love_csrf(),
        'installed' => love_admin_exists(),
    ]);
}

$in = love_body();
$action = u_str($in['action'] ?? '');

if ($action === 'whoami') {   // 面板端以 POST 携带 action=whoami 调用
    love_session();           // 限流口径同上：只拦未登录的探测请求
    if (!love_logged_in() && !love_rate_ok('whoami', 120, 60)) {
        love_json(['ok' => false, 'error' => '请求太频繁，请稍后再试'], 429);
    }
    love_json([
        'ok' => true,
        'logged_in' => love_logged_in(),
        'username' => $_SESSION['love_admin'] ?? '',
        'csrf' => love_csrf(),
        'installed' => love_admin_exists(),
    ]);
}

if ($action === 'login') {
    if (love_logged_in()) {
        love_json(['ok' => true, 'username' => $_SESSION['love_admin'], 'csrf' => love_csrf()]);
    }
    if (love_throttle_blocked()) love_json(['ok' => false, 'error' => '失败次数过多，请 10 分钟后再试'], 429);
    require_csrf($in);
    $user = trim(u_str($in['username'] ?? ''));
    $pass = u_str($in['password'] ?? '');
    if (love_admin_exists() && love_admin_verify($user, $pass)) {
        love_session_login($user);            // 换新 Session ID，防会话固定
        love_throttle_reset();
        love_gate_set();                      // 后台是更强的认证 → 顺手下发解锁 Cookie，
                                              // 否则后台里的照片缩略图会被 photo.php 拒掉
        love_json(['ok' => true, 'username' => $user, 'csrf' => love_csrf()]);
    }
    love_throttle_fail();
    love_json(['ok' => false, 'error' => '账号或密码不对'], 401);
}

if ($action === 'logout') {
    love_session();
    require_csrf($in);                        // 退出同样要 CSRF（防被第三方页面强制登出）
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
        $rejected = []; $skipped = [];
        $oldCfg = love_read('config.json', []);
        /* 与 sanitize_cfg / love_gate_password() 同一口径：一律比较 trim 后的值。
           若磁盘上存着历史遗留的 "520520 "（带空格），用未 trim 的值当"旧口令"
           会让下面的 $newPw !== $oldPw 恒为真 —— 于是每次保存都轮换签名密钥，
           把所有已解锁的浏览器踢下线。 */
        $oldPw = is_array($oldCfg) ? trim(u_str($oldCfg['password'] ?? '')) : '';
        $out = sanitize_cfg($ov, $rejected, $skipped);
        $out = normalize_quiz($out);              // 双保险（sanitize 已归一 a）
        /* 解锁密码兜底：净化结果里没有 password 键 → 沿用磁盘现值。
           本接口是"整体替换"语义，未提交的键会从 data/config.json 里消失。
           而前端在「账号设置 → 高级：直接编辑 JSON」粘一份不含 password 的
           配置时，payload 里根本没有这个键 —— 旧实现会把已设的解锁密码删掉，
           门禁静默失效、情书/相册/留言对所有访客公开（实测可复现）。
           注意用「净化后」而不是「原始输入」判断：客户端传 password:null
           会被 sanitize 拒掉，同样会落到"缺键"这条路上。
           想主动关闭门禁请显式提交 password:""（空串能通过净化、不会被覆盖）。 */
        if (!array_key_exists('password', $out)) $out['password'] = $oldPw;
        if (!love_write('config.json', $out)) love_json(['ok' => false, 'error' => '保存失败（data 目录不可写？）'], 500);
        /* 解锁密码变了 → 轮换签名密钥，所有旧 Cookie 立即失效；
           再给当前管理员发一张新的，免得自己也被踢出去 */
        $newPw = trim(u_str($out['password'] ?? ''));
        $warn = null;
        if ($newPw !== $oldPw) {
            /* 轮换签名密钥 → 所有旧 Cookie 立即失效。删不掉（data/ 不可写）时必须
               明确回传，不能静默 —— 否则就成了"密码改了但别人还能进"。 */
            if (!love_gate_rotate()) $warn = '解锁密码已更新，但签名密钥删不掉（data/ 目录不可写）：已解锁的浏览器在 Cookie 有效期内仍能访问';
            love_gate_set();
        }
        love_json(['ok' => true, 'saved' => array_keys($out), 'rejected' => $rejected, 'skipped' => $skipped, 'warning' => $warn]);

    case 'get_content':
        love_json(['ok' => true, 'data' => [
            'photos'   => love_read('content.json', [])['photos'] ?? [],
            'letters'  => love_read('content.json', [])['letters'] ?? [],
            'messages' => love_read('content.json', [])['messages'] ?? [],
            'capsules' => love_read('content.json', [])['capsules'] ?? [],
            'daily'    => daily_admin_view(),
            'compat'   => love_read('compat.json', [])['rounds'] ?? [],
        ]]);

    case 'content_delete':   // 管理员可删任意内容（含照片文件）
        $kind = u_str($in['kind'] ?? '');
        $uid = u_str($in['uid'] ?? '');
        if (!in_array($kind, ['photos', 'letters', 'messages', 'capsules', 'daily', 'compat'], true) || $uid === '') {
            love_json(['ok' => false, 'error' => '参数错误'], 400);
        }
        if ($kind === 'daily') {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $uid)) love_json(['ok' => false, 'error' => '参数错误'], 400);
            $ok = love_mutate('daily.json', function ($d) use ($uid) {
                if (is_array($d)) unset($d[$uid]);
                return is_array($d) ? $d : [];
            }, []);
            love_json(['ok' => is_array($ok)]);
        }
        if ($kind === 'compat') {
            $ok = love_mutate('compat.json', function ($d) use ($uid) {
                $d['rounds'] = array_values(array_filter((array)($d['rounds'] ?? []), function ($r) use ($uid) {
                    return ($r['id'] ?? '') !== $uid;
                }));
                return $d;
            }, []);
            love_json(['ok' => is_array($ok)]);
        }
        /* 与访客侧（api/content.php）口径一致，走 love_mutate 加锁读改写。
           旧实现是 love_read → 过滤 → love_write，全程无锁：管理员删除与
           访客新增并发时，会有一方的改动被旧副本整个覆盖（丢记录）。 */
        $target = null;
        $c = love_mutate(CONTENT_FILE, function ($c) use ($kind, $uid, &$target) {
            $list = is_array($c[$kind] ?? null) ? $c[$kind] : [];
            foreach ($list as $r) {
                if (($r['uid'] ?? '') === $uid) { $target = $r; break; }
            }
            $c[$kind] = array_values(array_filter($list, function ($r) use ($uid) {
                return ($r['uid'] ?? '') !== $uid;
            }));
            return $c;
        }, []);
        if (!is_array($c)) love_json(['ok' => false, 'error' => '服务器繁忙'], 500);
        if ($target !== null && $kind === 'photos' && !empty($target['src'])) {
            $src = u_str($target['src']);
            if (strpos($src, 'assets/img/uploads/') === 0) {
                @unlink(love_uploads_dir() . '/' . basename($src));
            }
        }
        love_json(['ok' => true]);

    case 'photo_upload':     // 管理员上传照片（存 uploads/，记录进 data/content.json）
        /* 身份用服务端随机值，不再写死字面量 'admin'：deviceId 完全来自客户端
           Cookie，写死成可猜的字符串等于把"删除这张照片"的权限公开（见
           lib/store.php 里 LOVE_DEV_PATTERN 的说明）。随机值同时通不过访客侧的
           形态校验，双重保险。 */
        $in['deviceId'] = 'd' . bin2hex(random_bytes(8));
        $in['uid'] = 'a' . time() . substr(bin2hex(random_bytes(4)), 0, 8);
        $r = photo_add($in);
        if (empty($r['ok'])) love_json($r, 400);
        unset($r['record']['deviceId']);        // 删除凭据不下发（与访客侧口径一致）
        love_json(['ok' => true, 'record' => $r['record']]);

    case 'change_password':
        $old = u_str($in['old'] ?? '');
        $new = u_str($in['new'] ?? '');
        $a = admin_account();
        /* 哈希必须是字符串再进 password_verify：数组型脏哈希会让 PHP 8 抛
           TypeError（500），与 restore 侧的收窄（is_string）同一道闸。 */
        $oldHash = is_string($a['pass_hash'] ?? null) ? $a['pass_hash'] : '';
        if ($oldHash === '' || !password_verify($old, $oldHash)) {
            love_json(['ok' => false, 'error' => '原密码不对'], 401);
        }
        /* 长度口径与前端（n.length）和 install.php 保持一致：按"字符"而不是字节，
           否则一个 6 字节的 2 字中文密码会在后台被拒、在 install 却被放行。 */
        if (u_len($new) < 6) love_json(['ok' => false, 'error' => '新密码至少 6 位'], 400);
        /* 加锁读改写：与 restore（可能同时在恢复 admin.json）并发时不互相覆盖。 */
        $saved = love_mutate('admin.json', function ($cur) use ($new) {
            $rec = is_array($cur) ? $cur : [];
            $rec['pass_hash'] = password_hash($new, PASSWORD_DEFAULT);
            return $rec;
        }, []);
        if (!is_array($saved)) love_json(['ok' => false, 'error' => '保存失败'], 500);
        love_json(['ok' => true]);

    case 'backup':
        $bct = content_get();     // 结构化的 {photos,letters,messages,capsules}
        love_json(['ok' => true, 'backup' => [
            'version' => 3,       // v3: 补上每日一问（v2 及更早的备份没有这个键）
            'time' => date('c'),
            'config'  => love_read('config.json', []),
            'content' => [
                'photos'   => $bct['photos'],
                'letters'  => $bct['letters'],
                'messages' => $bct['messages'],
                'capsules' => $bct['capsules'],
            ],
            'daily'  => daily_read(),
            'compat' => love_read('compat.json', []),
            'admin'  => admin_account(),
        ]]);

    case 'restore':
        $b = is_array($in['backup'] ?? null) ? $in['backup'] : [];
        $ok = true;
        $missing_photos = 0;
        $rejected = []; $skipped = []; $compat_dropped = 0;
        if (isset($b['config']) && is_array($b['config'])) {
            $oldRestorePw = trim(u_str(love_read('config.json', [])['password'] ?? ''));
            $cfg = sanitize_cfg($b['config'], $rejected, $skipped);
            /* 与 save_config 同一道兜底：备份里没有 password 键时沿用现值，
               否则恢复一份手工精简过的备份就会把解锁门禁整个删掉。 */
            if (!array_key_exists('password', $cfg)) $cfg['password'] = $oldRestorePw;
            $ok = $ok && admin_replace('config.json', $cfg);
            /* 解锁密码变了要轮换签名密钥：旧 Cookie 必须立即失效，
               否则"恢复了旧备份"这件事在已解锁的浏览器上根本不生效。
               与 save_config 同一口径：密钥删不掉（data/ 不可写）时必须回传
               warning，不能静默 —— 否则就成了"密码改了但别人还能进"。 */
            if (trim(u_str($cfg['password'] ?? '')) !== $oldRestorePw) {
                $rotated = love_gate_rotate();
                love_gate_set();
                if (!$rotated) {
                    $warn = trim((string)($warn ?? '') . ' 解锁密码已恢复，但签名密钥删不掉（data/ 目录不可写）：已解锁的浏览器在 Cookie 有效期内仍能访问。');
                }
            }
        }
        if (isset($b['content']) && is_array($b['content'])) {
            /* 逐条结构清洗：备份文件可能损坏或被手工改过，整块写入会把非法
               结构灌进 content.json（字段类型错会让前台渲染崩掉）。 */
            $ct = ['photos' => [], 'letters' => [], 'messages' => [], 'capsules' => []];
            foreach (['photos', 'letters', 'messages', 'capsules'] as $k) {
                $raw = is_array($b['content'][$k] ?? null) ? $b['content'][$k] : [];
                foreach ($raw as $r) {
                    $item = content_sanitize_item($k, $r);
                    if ($item !== null) $ct[$k][] = $item;
                }
            }
            /* 备份只含照片记录、不含图片文件本身：换服务器恢复后这些 src 会全 404。
               逐条校验文件是否存在，丢掉缺失的并回报数量（避免相册一片破图）。 */
            $dir = love_uploads_dir();
            $kept = [];
            foreach ($ct['photos'] as $p) {
                $src = is_array($p) ? u_str($p['src'] ?? '') : '';
                if ($src !== '' && strpos($src, 'assets/img/uploads/') === 0
                    && is_file($dir . '/' . basename($src))) {
                    $kept[] = $p;
                } else {
                    $missing_photos++;
                }
            }
            $ct['photos'] = $kept;
            $ok = $ok && admin_replace('content.json', $ct);
        }
        if (isset($b['compat']) && is_array($b['compat']) && is_array($b['compat']['rounds'] ?? null)) {
            /* 逐条清洗：备份可能损坏或被手工改过，而畸形回合不只让默契度页面
               出错 —— compat.json 会被 api/config.php（每页加载）读取，一个
               updated 为数组的回合就足以让 usort 抛 TypeError，整页的
               __SERVER_* 注入全部缺失。清洗口径与访客提交共用 lib/compat.php。 */
            $rounds = compat_sanitize_rounds($b['compat']['rounds'], $compat_dropped);
            $ok = $ok && admin_replace('compat.json', ['rounds' => $rounds]);
        }
        /* 每日一问（v3 起备份才有这个键）：逐日校验形状后写入，
           daily.json 的形状是 日期 => {answers: {设备id: {text, ts}}}。 */
        if (isset($b['daily']) && is_array($b['daily'])) {
            $daily = [];
            foreach ($b['daily'] as $date => $rec) {
                if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
                if (!is_array($rec) || !is_array($rec['answers'] ?? null)) continue;
                $ans = [];
                foreach ($rec['answers'] as $dev => $a) {
                    if (!is_array($a)) continue;
                    $dev = clean_id((string)$dev);
                    if ($dev === '') continue;
                    $ans[$dev] = ['text' => u_sub(u_str($a['text'] ?? ''), DAILY_MAX),
                                  'ts'   => (int)($a['ts'] ?? 0)];
                }
                $daily[$date] = ['answers' => $ans];
            }
            $ok = $ok && admin_replace('daily.json', $daily);
        }
        /* 管理员账号默认不覆盖：恢复一份旧备份就把密码换回旧的，
           是很容易把人锁在门外的坑，必须显式确认（restore_admin=true）。 */
        /* 管理员账号默认不覆盖：恢复一份旧备份就把密码换回旧的，
           是很容易把人锁在门外的坑，必须显式确认（restore_admin=true）。
           两个键都必须是**非空字符串**：旧实现只做 !empty，而 !empty(数组)
           也为真 —— 备份文件损坏/被手工改过时，数组型的 pass_hash 会原样
           写进 admin.json，此后 password_verify(哈希, 数组) 在 PHP 8 抛
           TypeError（500），管理员永远登录不进去（实测可复现，2026-09-13）。 */
        $admin_restored = false;
        $admin_skipped = false;
        $admUser = is_array($b['admin'] ?? null) ? ($b['admin']['username'] ?? null) : null;
        $admHash = is_array($b['admin'] ?? null) ? ($b['admin']['pass_hash'] ?? null) : null;
        if (is_string($admUser) && $admUser !== '' && is_string($admHash) && $admHash !== '') {
            if (empty($in['restore_admin'])) {
                $admin_skipped = true;
            } else {
                $ok = $ok && admin_replace('admin.json', ['username' => $b['admin']['username'], 'pass_hash' => $b['admin']['pass_hash'], 'created' => $b['admin']['created'] ?? time()]);
                $admin_restored = true;
            }
        }
        love_json([
            'ok' => $ok,
            'missing_photos' => $missing_photos,
            'rejected' => $rejected,
            'skipped' => $skipped,
            'compat_dropped' => $compat_dropped,
            'admin_restored' => $admin_restored,
            'admin_skipped' => $admin_skipped,
            'warning' => $warn ?? null,
            'error' => $ok ? null : '部分写入失败（data 目录不可写？）',
        ]);

    default:
        love_json(['ok' => false, 'error' => '未知操作'], 400);
}
