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
    /* $replace=true：恢复备份不看旧内容 —— 目标文件若已损坏，这道恢复恰恰是
       唯一能把它修好的入口，不能被 love_mutate 的"损坏拒绝覆盖"闸拦住。 */
    $res = love_mutate($file, function () use ($data) { return $data; }, [], true);
    return is_array($res);
}

/** 恢复备份失败时那句话：说清**哪些文件已经写进去了、哪些没有**。
    旧实现只回一句"部分写入失败（data 目录不可写？）"，而恢复是逐文件覆盖的 ——
    最坏的一种是 config.json（含解锁口令）已经换掉、content.json 写失败，
    管理员却完全无法从界面上知道"口令已经变了"，只会以为"什么都没发生"（F-S4-04）。 */
function restore_result_note(array $steps): string {
    $done = []; $failed = [];
    if ($steps === []) return '这份备份没认出任何数据块（config / content / compat / daily / admin 都不是对象）：磁盘未做任何改动';
    foreach ($steps as $file => $wrote) { if ($wrote) { $done[] = $file; } else { $failed[] = $file; } }
    /* 没有任何失败项 = 全部写成功。旧实现在这一支上返回的是"部分写入失败
       （data 目录不可写？）"——判据与文案正好相反（第七轮 S4-06）。
       当前调用点保证"$ok=false 时必有失败项或 $steps 为空"，所以这一支今天走不到；
       但它是含义相反的兜底，任何一次改动（比如"缺块也计入 steps"）都会立刻
       把"其实全写成功"回报成"部分写入失败"，把管理员引到权限方向去排查。 */
    if (!$failed) return $done ? ('已恢复：' . implode('、', $done)) : '';
    $msg = $done ? ('已恢复：' . implode('、', $done) . '；') : '一个文件都没写进去；';
    return $msg . '写失败：' . implode('、', $failed) . '（data 目录不可写或磁盘已满）';
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

/** 后台内容视图：逐条剥掉 deviceId（访客"删除自己内容"的唯一凭据）。
    与 lib/content.php 的 content_view()（访客侧）、photo_upload 的 unset
    同一口径 —— lib/store.php 把这条写成硬规则："deviceId 绝不能下发给前端"。
    admin/index.php 全文**不使用** deviceId（删除走 uid、每日一问走 date），
    旧实现却把 photos/letters/messages/capsules 每一条的删除凭据原样下发；
    后台是全站最敏感的一页，一旦出现任何脚本注入，泄露的就是"能定向删掉/改写
    站主看到的历史"（第七轮 S4-04）。
    ⚠️ backup 不走这里：备份必须保留 deviceId，恢复时才认得出每条是谁的。 */
function content_strip_device($list): array {
    $out = [];
    foreach ((array)$list as $r) {
        if (!is_array($r)) continue;
        unset($r['deviceId']);
        $out[] = $r;
    }
    return $out;
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
        /* 与前台 api/config.php 完全同一套净化口径后才回传。
           README 明确建议「忘了密码就直接编辑 data/config.json」，那条路没有后台
           校验：裸读会让面板吃下和前台不一样的数据 —— 把 messages 写成字符串时，
           前台会整键丢弃并回退默认值，面板却在 renderAll() 里对字符串调 forEach
           抛 TypeError，后面的相册/留言/备份/账号面板全部渲染不出来，连「高级：
           直接编辑 JSON」这个自救入口本身都不会被填值。
           被丢弃的键一并回报，让管理员知道"有几项格式不对、已回退默认值"，
           而不是静默换掉他看到的内容。 */
        $rawCfg = love_read('config.json', []);
        $cfgRejected = []; $cfgSkipped = [];
        $cfgOut = normalize_quiz(sanitize_cfg(is_array($rawCfg) ? $rawCfg : [], $cfgRejected, $cfgSkipped));
        /* 「文件不存在」与「文件在但解析不出来」必须分开回话：love_read() 对两者
           返回同一个默认值 []，于是 config.json 语法坏了（少一个逗号 / FTP 上传被
           截断 / 磁盘写满留半截）时，面板把名字、日期、情话、纪念日、题库**全部**
           按默认值展示，而 rejected/skipped 都是空的 → bootApp 的两条提示一条都不
           触发，管理员只看到"我的配置全变回去了"，页面对原因一个字都不提
           （第七轮 S4-07）。判据复用门禁层已有的 love_gate_config_broken()
           （= 文件在 && 读不出数组），两边同一口径，不再各写一份。 */
        $cfgBroken = love_gate_config_broken();
        love_json(['ok' => true, 'overrides' => $cfgOut, 'broken' => $cfgBroken,
                   'rejected' => $cfgRejected, 'skipped' => $cfgSkipped]);

    case 'save_config':
        /* 本接口是「整体替换」语义：没提交的键会从 data/config.json 里消失。
           因此 overrides 缺失/不是对象/是列表时必须直接拒绝 —— 旧实现一律窄化成 []，
           净化后只剩兜底的 password，于是 POST 一个 {action:save_config}（或
           overrides:"x" / null / 7 / [1,2,3]）会把整份配置抹掉且回报 ok:true，
           前台随即回落默认值（名字变回"待定A/待定B"、自定义情话/纪念日/题库全没了）。
           坏输入的正确回应是报错，不是把数据删干净。

           「是列表」也要挡住：JSON 的 [1,2,3] 和 [] / {} 解码出来都是 list
           （空数组也算 list），同样会被 sanitize_cfg 洗成空配置。
           不用 array_is_list() 是为了不把 PHP 版本下限拉到 8.1 —— 宿主环境未必给。
           面板从不发空对象：collectOverrides() 至少会带上 password 键。 */
        $ovIn = $in['overrides'] ?? null;
        $ovIsMap = is_array($ovIn) && $ovIn !== []
            && array_keys($ovIn) !== range(0, count($ovIn) - 1);
        if (!$ovIsMap) {
            love_json(['ok' => false, 'error' => '参数错误（overrides 必须是配置对象）'], 400);
        }
        $ov = $ovIn;
        $rejected = []; $skipped = [];
        /* 「读当前配置 → 合成结果 → 落盘」必须在**同一把 flock 内**完成，且与
           restore 的 admin_replace()、访客侧的所有 love_mutate 共用同一把锁。
           旧实现在锁外用 love_read 读、再用 love_write（tmp + rename，**不参与加锁**）写：
           只要与 admin_replace 重叠，rename 会把恢复那份配置写进一个已变成孤儿的
           inode（接口照样回 ok:true），表现为「保存成功、恢复也成功，盘上却只剩一份」
           —— 静默丢配置（F-S2-03）。
           $oldPw 在锁内取：它既是"缺键时沿用"的来源，也是下面判断要不要轮换密钥的基准；
           与 sanitize_cfg / love_gate_password() 同口径一律比较 trim 后的值 ——
           磁盘上若存着历史遗留的 "520520 "（带空格），用未 trim 的值当"旧口令"会让
           $newPw !== $oldPw 恒为真，于是每次保存都轮换签名密钥、把已解锁的浏览器全踢下线。 */
        $oldPw = '';
        $out = love_mutate('config.json', function ($cur) use ($ov, &$rejected, &$skipped, &$oldPw) {
            $oldPw = is_array($cur) ? trim(u_str($cur['password'] ?? '')) : '';
            return cfg_merge_overrides($ov, $cur, $rejected, $skipped);
        }, []);
        if (!is_array($out)) {
            /* 失败原因必须分开说：love_mutate() 对"有内容但解析不出对象"的文件
               **故意拒绝覆盖**（防静默全量丢失，见 lib/store.php），而 config.json
               坏掉是最常见的一种。旧实现一律回"保存失败（data 目录不可写？）"，
               管理员会去改目录权限 —— 而同一页 install.php 的自检写着"✅ 可写"，
               两句自相矛盾、真正的病因一次都没被说出来（第七轮 S4-07）。 */
            love_json(['ok' => false, 'error' => love_gate_config_broken()
                ? '保存失败：data/config.json 内容损坏（不是合法的配置对象），本次没有覆盖它。请用备份恢复，或手工修正该文件后再保存'
                : '保存失败（data 目录不可写？）'], 500);
        }
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
        /* 四个列表必须在**服务端**兜成数组：love_read() 只保证顶层是数组，嵌套值原样返回，
           而 `?? []` 挡不住标量 —— content.json 被手改成 `"messages":"x"` 时，
           这个字符串会原样下发，面板的 `j.data.messages || []` 对非空字符串不生效 →
           renderCT() 里 `list.slice().reverse()` 抛 TypeError，loadContent 的 catch
           只把「访客照片」写成加载失败，**后面的留言/情书/胶囊/每日/默契面板全空白**，
           错误只在控制台（与第三轮修掉的 get_config 那一格同类症状）。
           修法不是再加一层判断，而是复用同文件里已有的 content_get() ——
           它逐键 `is_array` 兜底，backup 与 content_delete 都走它，
           只有这一支自己手写了一遍读取（F-S2-04）。 */
        $ct = content_get();
        /* 每日一问的 `dev` 与内容里的 deviceId 是同一个东西（设备标识），
           面板只用 text/ts（renderDaily 也只读这两项）。 */
        $daily = daily_admin_view();
        foreach ($daily as $i => $d) {
            if (!is_array($d['answers'] ?? null)) continue;
            foreach ($d['answers'] as $j => $a) {
                if (is_array($a)) unset($daily[$i]['answers'][$j]['dev']);
            }
        }
        love_json(['ok' => true, 'data' => [
            'photos'   => content_strip_device($ct['photos']),
            'letters'  => content_strip_device($ct['letters']),
            'messages' => content_strip_device($ct['messages']),
            'capsules' => content_strip_device($ct['capsules']),
            'daily'    => $daily,
            /* 与访客侧同一个 helper：手改坏的 compat.json 里若混进非数组元素，
               后台表格渲染到那一条就会 TypeError（整块面板半渲染），
               这里的口径必须与 lib/compat.php 的 compat_read() 完全一致。 */
            'compat'   => compat_rounds_of(love_read('compat.json', [])),
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
            /* 这里是**业务**错误（原密码输错），不是"会话失效"。
               旧实现回 401，而面板的 api() 会把除 login 外的一切 401 当成
               "会话中途失效"：输错一次原密码 → 跳登录页 + 提示"口令在别处被改过"
               （最容易被误读成账号被盗）→ 逼着再输一遍主口令 → 登录成功后又把这次
               注定失败的改口令请求**原样重放**（第七轮 S4-02）。
               401 的语义由 love_require_login() 独占；业务错误一律 400 + 稳定错误码，
               面板据此只提示、不跳转、不重放。 */
            love_json(['ok' => false, 'error' => '原密码不对', 'code' => 'bad_old_password'], 400);
        }
        /* 长度口径与前端（n.length）和 install.php 保持一致：按"字符"而不是字节，
           否则一个 6 字节的 2 字中文密码会在后台被拒、在 install 却被放行。 */
        if (u_len($new) < 6) love_json(['ok' => false, 'error' => '新密码至少 6 位'], 400);
        /* 上限必须与登录框同尺：admin/index.php 的 #lgPass 是 maxlength="64"，
           install.php 的建号表单也是 64。旧实现只有下限，于是"在账号设置里粘贴一个
           ≥65 字符的强口令"会被接受并落盘 password_hash()，此后**任何人（包括站主）**
           都无法在登录框里输入这串口令（浏览器把输入截到 64 字符，password_verify()
           必然 false）—— 后台永久锁死，唯一出路是手改 data/admin.json。
           与"解锁口令超 40 字符"（F-S1-02）同族，只是代价更大（第七轮 S4-01）。 */
        if (u_len($new) > 64) love_json(['ok' => false, 'error' => '新密码最多 64 位（登录框也就能输入 64 个字符）'], 400);
        /* bcrypt 不接受 NUL 字节：password_hash() 碰到 "\0" 在 PHP 8 抛
           ValueError（未捕获 → 500 + 空响应体，前端只看到一句
           "Unexpected end of JSON input"，查不出原因）。客户端完全可以用 JSON 的
           \u0000 把它送进来，所以必须自己先挡。install.php 的同一行也要挡（未安装
           状态下匿名就能打到），两边口径保持一致。 */
        if (strpos($new, "\0") !== false) love_json(['ok' => false, 'error' => '新密码不能包含空字符'], 400);
        /* 加锁读改写：与 restore（可能同时在恢复 admin.json）并发时不互相覆盖。 */
        $saved = love_mutate('admin.json', function ($cur) use ($new) {
            $rec = is_array($cur) ? $cur : [];
            $rec['pass_hash'] = password_hash($new, PASSWORD_DEFAULT);
            return $rec;
        }, []);
        if (!is_array($saved)) love_json(['ok' => false, 'error' => '保存失败'], 500);
        /* 口令换了 → 全部旧会话立刻失效（F-S4-02）；但**操作者本人**不该被自己
           刚设的口令踢出去（否则面板会在他眼前变成"未登录"，见 F-S4-03），
           所以只把当前这一条会话按新哈希重挂。 */
        love_session_rebind();
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
        /* 每一步写入的**真实结果**（文件名 => 是否写成功）。
           旧实现是 `$ok = $ok && admin_replace(...)`：只要前面某个文件写失败，
           `$ok` 变 false，后面所有写入被短路**一个都不执行** —— 一次"部分失败"
           实际是"写到失败点为止"，而响应里除了一句"部分写入失败"什么都没有。
           五个文件现在都必定尝试，结果逐项回报给面板（F-S4-04）。 */
        $steps = [];
        $note_step = function (string $file, $okFlag) use (&$steps, &$ok): void {
            $steps[$file] = (bool)$okFlag;
            if (!$okFlag) $ok = false;
        };
        $missing_photos = 0;
        $rejected = []; $skipped = []; $compat_dropped = 0;
        $content_dropped = []; $daily_dropped = 0;
        $content_blocks_bad = [];      // content 里整块形状不对的类别（该类的磁盘记录会被清空）
        /* 磁盘上每个数据块**现在有多少东西**：只用来判断"这一块没被写入、磁盘上原有
           的还在"要不要提（两块都空时提它纯属噪音）。必须在任何写入之前取好 ——
           写在后面取到的是被这次恢复改过一半的状态。 */
        $diskContent = content_get();
        $diskHas = [
            'config.json'  => count(love_read('config.json', [])) > 0,
            'content.json' => array_sum(array_map('count', $diskContent)) > 0,
            'compat.json'  => count(compat_rounds_of(love_read('compat.json', []))) > 0,
            'daily.json'   => count(daily_read()) > 0,
            'admin.json'   => count(admin_account()) > 0,
        ];
        if (isset($b['config']) && is_array($b['config'])) {
            $oldRestorePw = trim(u_str(love_read('config.json', [])['password'] ?? ''));
            $cfg = sanitize_cfg($b['config'], $rejected, $skipped);
            /* 与 save_config 同一道兜底：备份里没有 password 键时沿用现值，
               否则恢复一份手工精简过的备份就会把解锁门禁整个删掉。 */
            if (!array_key_exists('password', $cfg)) $cfg['password'] = $oldRestorePw;
            $note_step('config.json', admin_replace('config.json', $cfg));
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
                $rawIn = $b['content'][$k] ?? null;
                if (!is_array($rawIn)) {
                    /* 整块形状不对（null / 字符串 / 数字）或整键缺失：$ct[$k] 保持空列表，
                       而 admin_replace() 是**覆盖**语义 —— 磁盘上那一类的记录在这一瞬
                       全部消失，且不可逆。旧实现只在内层循环里计数，这一格一次都不跑，
                       于是 content_dropped 里没有它、steps 照报成功，管理员看到的是
                       「✅ 恢复完成」而留言板已经空了（第七轮 S4-03）。
                       按"磁盘上原有几条就丢几条"如实计数，并单独回报是哪一块。 */
                    $content_blocks_bad[] = $k;
                    $content_dropped[$k] = ($content_dropped[$k] ?? 0) + count($diskContent[$k]);
                    continue;
                }
                foreach ($rawIn as $r) {
                    $item = content_sanitize_item($k, $r);
                    if ($item !== null) { $ct[$k][] = $item; continue; }
                    /* 被丢掉的条目必须计数并回报：恢复是「覆盖」语义，磁盘上原有的
                       留言/情书/胶囊此刻已经不可逆地没了。旧实现只在照片这一支
                       （missing_photos）和默契度（compat_dropped）上报了数字，
                       体量最大的这几类却一声不响，管理员看到的是"✅ 恢复完成"。 */
                    $content_dropped[$k] = ($content_dropped[$k] ?? 0) + 1;
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
            $note_step('content.json', admin_replace('content.json', $ct));
        }
        if (isset($b['compat']) && is_array($b['compat']) && is_array($b['compat']['rounds'] ?? null)) {
            /* 逐条清洗：备份可能损坏或被手工改过，而畸形回合不只让默契度页面
               出错 —— compat.json 会被 api/config.php（每页加载）读取，一个
               updated 为数组的回合就足以让 usort 抛 TypeError，整页的
               __SERVER_* 注入全部缺失。清洗口径与访客提交共用 lib/compat.php。 */
            $rounds = compat_sanitize_rounds($b['compat']['rounds'], $compat_dropped);
            $note_step('compat.json', admin_replace('compat.json', ['rounds' => $rounds]));
        }
        /* 每日一问（v3 起备份才有这个键）：逐日校验形状后写入，
           daily.json 的形状是 日期 => {answers: {设备id: {text, ts}}}。 */
        if (isset($b['daily']) && is_array($b['daily'])) {
            $daily = [];
            foreach ($b['daily'] as $date => $rec) {
                if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) { $daily_dropped++; continue; }
                if (!is_array($rec) || !is_array($rec['answers'] ?? null)) { $daily_dropped++; continue; }
                $ans = [];
                foreach ($rec['answers'] as $dev => $a) {
                    if (!is_array($a)) { $daily_dropped++; continue; }
                    $dev = clean_id((string)$dev);
                    if ($dev === '') { $daily_dropped++; continue; }
                    $ans[$dev] = ['text' => u_sub(u_str($a['text'] ?? ''), DAILY_MAX),
                                  'ts'   => (int)($a['ts'] ?? 0)];
                }
                $daily[$date] = ['answers' => $ans];
            }
            $note_step('daily.json', admin_replace('daily.json', $daily));
        }
        /* 管理员账号默认不覆盖：恢复一份旧备份就把密码换回旧的，
           是很容易把人锁在门外的坑，必须显式确认（restore_admin=true）。
           两个键都必须是**非空字符串**：旧实现只做 !empty，而 !empty(数组)
           也为真 —— 备份文件损坏/被手工改过时，数组型的 pass_hash 会原样
           写进 admin.json，此后 password_verify(哈希, 数组) 在 PHP 8 抛
           TypeError（500），管理员永远登录不进去（实测可复现，2026-09-13）。 */
        $admin_restored = false;
        $admin_skipped = false;
        /* 备份里有 admin 块、但两个键不是非空字符串（例如 admin 是 {} 或数组型哈希）：
           这一块会被整块跳过。旧实现既不置 $admin_skipped 也不报任何东西 ——
           管理员勾了"确定＝同时恢复账号密码"却什么都没发生，界面对此一个字都不提
           （第七轮 S4-05）。单独一个标志，别和"你选择了不恢复"混在一句话里。 */
        $admin_skipped_invalid = false;
        $admUser = is_array($b['admin'] ?? null) ? ($b['admin']['username'] ?? null) : null;
        $admHash = is_array($b['admin'] ?? null) ? ($b['admin']['pass_hash'] ?? null) : null;
        if (is_string($admUser) && $admUser !== '' && is_string($admHash) && $admHash !== '') {
            /* 开关必须是**严格布尔真**才恢复账号。
               旧实现用 empty()，而 empty("false") 与 empty([]) 都是 false ——
               也就是说 `restore_admin:"false"`（字符串）或 `[]` 会被读成"要恢复"，
               于是本该"只恢复内容、保留当前账号密码"的请求把密码换成了备份里的哈希，
               管理员当场被锁在后台外面，提示却还是一句轻描淡写的"恢复完成"。
               漏的方向恰好是最危险的一侧，所以这里按 === true 收窄。 */
            if (($in['restore_admin'] ?? null) !== true) {
                $admin_skipped = true;
            } else {
                $note_step('admin.json', admin_replace('admin.json', ['username' => $admUser, 'pass_hash' => $admHash, 'created' => $b['admin']['created'] ?? time()]));
                /* 写失败了就不能报"已恢复" —— 旧实现无条件置 true，管理员会以为
                   账号已经换成备份里那份，其实还是当前这份（F-S4-04 同族）。 */
                $admin_restored = !empty($steps['admin.json']);
                /* 备份把口令哈希换了 → 按 F-S4-02 的代次判据，本会话原本会立刻失效，
                   而站主刚点完"恢复"就发现自己被踢出去（还得知道备份里那份口令）——
                   旧实现正是靠"会话不校验口令"才没暴露这个问题。恢复是有登录才做得成的
                   动作，所以让操作者本人按新哈希重新认账，别把功能改坏。 */
                love_session_rebind();
            }
        } elseif (is_array($b['admin'] ?? null)) {
            $admin_skipped_invalid = true;
        }
        /* 一个数据块都没认出来（$steps 为空）时，$ok 还是初始值 true ——
           管理员会看到「✅ 恢复完成」，而磁盘一个字节都没动。他是带着"数据已经
           被换掉"的预期去做后续操作的，这比"部分失败"更误导（F-S4-04 修的是
           部分失败那一格，零写入这一格没盖住）。这种备份只能算"没认出来"。 */
        if ($steps === []) $ok = false;
        /* 「备份里没有（或形状不对）→ 一个字节都没写、磁盘保持原样」的块：
           成功路径过去完全不提（恢复的承诺是"覆盖恢复全部数据"，实际只兑现了一部分），
           只有失败路径才显示 steps（第七轮 S4-05）。steps 里出现的文件都算"写过"，
           成功与否由 ok / 上面的计数表达。
           只在磁盘上确实有东西时才列出来：两边都空时提它纯属噪音
           （例如全新站点的备份里 compat 是 []）。$admin_skipped 的那一格有专门的
           "管理员账号密码未改动"文案，不在这里重复。 */
        $not_written = [];
        foreach (['config.json', 'content.json', 'compat.json', 'daily.json', 'admin.json'] as $f) {
            if (isset($steps[$f])) continue;
            if ($f === 'admin.json' && $admin_skipped) continue;
            if (!empty($diskHas[$f])) $not_written[] = $f;
        }
        love_json([
            'ok' => $ok,
            'steps' => $steps,
            'not_written' => $not_written,
            'content_blocks_bad' => $content_blocks_bad,
            'admin_skipped_invalid' => $admin_skipped_invalid,
            'missing_photos' => $missing_photos,
            'rejected' => $rejected,
            'skipped' => $skipped,
            'compat_dropped' => $compat_dropped,
            'content_dropped' => $content_dropped,
            'daily_dropped' => $daily_dropped,
            'admin_restored' => $admin_restored,
            'admin_skipped' => $admin_skipped,
            'warning' => $warn ?? null,
            'error' => $ok ? null : restore_result_note($steps),
        ]);

    default:
        love_json(['ok' => false, 'error' => '未知操作'], 400);
}
