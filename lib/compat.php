<?php
/* ============================================================
   情侣网站 · 默契度回合数据层（共享）
   api/compat.php（访客接口）与 api/config.php（页面注入）共用。
   可见性规则：进行中的回合不下发任何一方答案，双方都答完
   （status=done）才通过结果视图/历史公开；
   历史只对参与过该回合的浏览器可见（按服务端 Cookie 身份过滤）。
   身份：deviceId 只存在服务端（HttpOnly Cookie + 数据），绝不下发。
   ============================================================ */

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/content.php';   // clean_id

const COMPAT_FILE = 'compat.json';
const COMPAT_QUESTIONS = 10;   // 每回合题目数上限（题库不足时按实际数量进行）
const COMPAT_Q_MAX = 200;      // 单题最大字符数
const COMPAT_OPT_MAX = 60;     // 单选项最大字符数
const COMPAT_HISTORY = 10;     // 历史返回条数
const COMPAT_ACTIVE_TTL = 600; // 进行中的回合多久内视为"有人在作答"（秒）

function compat_read(): array {
    $d = love_read(COMPAT_FILE, []);
    return is_array($d['rounds'] ?? null) ? $d['rounds'] : [];
}

/* ---------- 结构清洗（访客提交 + 恢复备份共用） ----------
   同一套校验只能有一份：api/compat.php 用它过滤访客提交，admin/api.php
   恢复备份时用它过滤历史数据。复制两份的话，以后改一处忘另一处，畸形数据
   就会从没改的那条路灌进来 —— 而 compat.json 被 api/config.php（每页加载）
   读取，畸形字段足以让整站 JS 挂掉。 */

function compat_sanitize_questions($questions): ?array {
    // 题库被删到 10 题以下时，按实际数量照常进行（2~10 题），
    // 否则 create 永远失败、前端静默降级本地模式，看起来像服务器坏了
    if (!is_array($questions) || count($questions) < 2 || count($questions) > COMPAT_QUESTIONS) return null;
    $out = [];
    foreach ($questions as $q) {
        if (!is_array($q)) return null;
        $qs = trim(u_str($q['q'] ?? ''));
        $opts = is_array($q['opts'] ?? null) ? $q['opts'] : [];
        if ($qs === '' || u_len($qs) > COMPAT_Q_MAX) return null;
        $oc = [];
        foreach ($opts as $o) {
            $os = trim(u_str($o));
            if ($os === '' || u_len($os) > COMPAT_OPT_MAX) return null;
            $oc[] = $os;
        }
        if (count($oc) < 2 || count($oc) > 6) return null;
        $out[] = ['q' => $qs, 'opts' => $oc];
    }
    return $out;
}

function compat_sanitize_answers($answers, array $questions): ?array {
    if (!is_array($answers)) return null;
    /* 键名一律忽略、按下标取题：客户端可能把 answers 传成 JSON 对象
       （如 {"p":1,"q":0}）。旧实现直接拿 JSON 的键当 $questions 的下标，
       只要键不是 0..n-1，"数量对得上"就能过前置校验，随后
       count($questions[$i]['opts']) 会退化成 count(null) —— PHP 8 抛出
       未捕获 TypeError，接口返回 HTML 错误页而不是 JSON（实测可复现，
       且会向客户端暴露文件绝对路径）。 */
    $answers = array_values($answers);
    if (count($answers) !== count($questions)) return null;
    $out = [];
    foreach ($answers as $idx => $a) {
        /* 非标量（如 [[0],[1]]）直接判非法：旧写法 (string)$a 会先抛
           "Array to string conversion" 警告，把 JSON 响应体污染掉。 */
        if (!is_int($a) && (!is_scalar($a) || !ctype_digit((string)$a))) return null;
        $a = (int)$a;
        $n = count($questions[$idx]['opts'] ?? []);
        if ($n < 2 || $a < 0 || $a >= $n) return null;
        $out[] = $a;
    }
    return $out;
}

/** 恢复备份：逐条清洗 compat.json 的回合（形状对齐 api/compat.php 的写盘结构）。
    任一必需字段不合法就整条丢弃，绝不让畸形回合进入 compat.json。
    $dropped 出参回报丢弃条数，供后台提示。 */
function compat_sanitize_rounds($rounds, int &$dropped = 0): array {
    $dropped = 0;
    if (!is_array($rounds)) return [];
    $out = [];
    foreach ($rounds as $r) {
        $c = compat_sanitize_round($r);
        if ($c === null) { $dropped++; continue; }
        $out[] = $c;
    }
    return $out;
}

function compat_sanitize_round($r): ?array {
    if (!is_array($r)) return null;
    $id = clean_id(u_str($r['id'] ?? ''));
    if ($id === '') return null;
    $status = u_str($r['status'] ?? '');
    if (!in_array($status, ['pending', 'waiting_b', 'done', 'abandoned'], true)) return null;
    $questions = compat_sanitize_questions($r['questions'] ?? null);
    if ($questions === null) return null;
    $a = compat_sanitize_side($r['a'] ?? null, $questions);
    $b = compat_sanitize_side($r['b'] ?? null, $questions);
    if ($a === null || $b === null) return null;
    return [
        'id' => $id, 'status' => $status, 'questions' => $questions,
        'a' => $a, 'b' => $b,
        'created' => is_numeric($r['created'] ?? null) ? (int)$r['created'] : 0,
        'updated' => is_numeric($r['updated'] ?? null) ? (int)$r['updated'] : 0,
    ];
}

function compat_sanitize_side($s, array $questions): ?array {
    if (!is_array($s)) return null;
    $role = u_str($s['role'] ?? '');
    if (!in_array($role, ['boy', 'girl'], true)) return null;
    $answers = $s['answers'] ?? null;
    if ($answers !== null) {
        $answers = compat_sanitize_answers($answers, $questions);
        if ($answers === null) return null;
    }
    $dev = clean_id(u_str($s['deviceId'] ?? ''));
    $ts = $s['ts'] ?? null;
    return [
        'role' => $role,
        'answers' => $answers,
        'deviceId' => $dev !== '' ? $dev : null,
        'ts' => is_numeric($ts) ? (int)$ts : null,
    ];
}

/* 逐题比较。两侧的下标/长度可能因旧版本数据、恢复旧备份或人工编辑而
   不一致（历史里出现过非连续下标的答案），所以先归一成 0 起列表，再用
   array_key_exists 兜底 —— 旧写法直接 $a[$i] === $b[$i]，越界会抛
   "Undefined array key" 警告，PHP 8 下会混进响应体、破坏 JSON 契约。 */
function compat_pct(array $a, array $b): array {
    $a = array_values($a);
    $b = array_values($b);
    $same = 0;
    $total = count($a);
    for ($i = 0; $i < $total; $i++) {
        if (array_key_exists($i, $a) && array_key_exists($i, $b) && $a[$i] === $b[$i]) $same++;
    }
    return [$same, $total];
}

function compat_is_mine(array $r, string $deviceId): bool {
    if ($deviceId === '') return false;
    return u_str($r['a']['deviceId'] ?? '') === $deviceId
        || u_str($r['b']['deviceId'] ?? '') === $deviceId;
}

/* 安全读取回合某一侧的角色：旧数据 / 手工改过的 compat.json 缺 role、
   或 a/b 本身不是数组时，直接 $r['a']['role'] 会抛 "Undefined array key"
   甚至 TypeError。本文件被 api/config.php（以 <script src> 加载）调用，
   任何警告/致命错误都会插在注入语句前 → 整站 JS 失效。 */
function compat_role(array $r, string $side): string {
    $s = $r[$side] ?? null;
    return is_array($s) ? u_str($s['role'] ?? '') : '';
}

/* 完成回合 → 结果视图（双方答案公开） */
function compat_result_view(array $r): array {
    $a = is_array($r['a']['answers'] ?? null) ? array_values($r['a']['answers']) : [];
    $b = is_array($r['b']['answers'] ?? null) ? array_values($r['b']['answers']) : [];
    [$same, $total] = compat_pct($a, $b);
    $detail = [];
    foreach (array_values((array)($r['questions'] ?? [])) as $i => $q) {
        $qs = is_array($q) ? $q : [];
        $qa = $a[$i] ?? null;
        $qb = $b[$i] ?? null;
        $detail[] = [
            'q' => u_str($qs['q'] ?? ''), 'opts' => (array)($qs['opts'] ?? []),
            'a' => $qa, 'b' => $qb, 'match' => ($qa !== null && $qa === $qb),
        ];
    }
    return [
        'pct' => (int)round($same / max(1, $total) * 100),
        'same' => $same, 'total' => $total, 'detail' => $detail,
        'roles' => ['a' => compat_role($r, 'a'), 'b' => compat_role($r, 'b')],
    ];
}

/* 完成历史视图：只给"参与过该回合的浏览器"看（别人看不到你们的答案） */
function compat_history_view(array $rounds, string $deviceId): array {
    $history = [];
    $done = array_values(array_filter($rounds, function ($r) use ($deviceId) {
        return ($r['status'] ?? '') === 'done' && compat_is_mine($r, $deviceId);
    }));
    /* (int) 兜底：updated 被手工改成数组/非数字字符串时，PHP 8 的 - 运算会抛
       TypeError。本函数被 api/config.php（每页加载）调用，一次致命错误就会让
       整页的 __SERVER_* 注入全部缺失。转成 int 最坏只是排序不准。 */
    usort($done, function ($x, $y) { return (int)($y['updated'] ?? 0) - (int)($x['updated'] ?? 0); });
    foreach (array_slice($done, 0, COMPAT_HISTORY) as $r) {
        $ar = is_array($r['a']['answers'] ?? null) ? array_values($r['a']['answers']) : [];
        $br = is_array($r['b']['answers'] ?? null) ? array_values($r['b']['answers']) : [];
        [$same, $total] = compat_pct($ar, $br);
        $history[] = [
            'id' => u_str($r['id'] ?? ''),
            'pct' => (int)round($same / max(1, $total) * 100),
            'same' => $same, 'total' => $total,
            'at' => (int)($r['updated'] ?? 0),
            'roles' => ['a' => compat_role($r, 'a'), 'b' => compat_role($r, 'b')],
            'questions' => array_values((array)($r['questions'] ?? [])),
            'answers' => ['a' => $ar, 'b' => $br],
        ];
    }
    return $history;
}

/* 进行中的回合 → 按当前访客身份换算视图（不含任何一方答案） */
function compat_active_view(array $r, string $deviceId): ?array {
    $s = u_str($r['status'] ?? '');
    if ($s === 'done' || $s === 'abandoned') return null;
    $aDev = u_str($r['a']['deviceId'] ?? '');
    $bDev = u_str($r['b']['deviceId'] ?? '');
    $myRole = '';
    $iAnswered = false;
    $canJoin = false;
    if ($aDev !== '' && $aDev === $deviceId) {
        $myRole = compat_role($r, 'a');
        $iAnswered = is_array($r['a']['answers'] ?? null);
    } elseif ($bDev !== '' && $bDev === $deviceId) {
        $myRole = compat_role($r, 'b');
        $iAnswered = is_array($r['b']['answers'] ?? null);
    } elseif ($s === 'waiting_b') {
        $myRole = compat_role($r, 'b');   // 等待中的回合：任何设备都可以接力作答
        $canJoin = true;
    }
    return [
        'id' => u_str($r['id'] ?? ''),
        'status' => $s,
        'questions' => array_values((array)($r['questions'] ?? [])),
        'aRole' => compat_role($r, 'a'),
        'bRole' => compat_role($r, 'b'),
        'myRole' => $myRole,
        'iAnswered' => $iAnswered,
        'canJoin' => $canJoin,
        'waitingFor' => ($s === 'waiting_b' && $aDev === $deviceId) ? 'b' : null,
        'aIsMe' => ($aDev !== '' && $aDev === $deviceId),
    ];
}

/* 找到与当前访客相关的进行中回合 */
function compat_pick_active(array $rounds, string $deviceId): ?array {
    $fallback = null;
    foreach ($rounds as $r) {
        $s = u_str($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') continue;
        if (compat_is_mine($r, $deviceId)) return $r;          // 我参与的（继续作答 / 等对方）
        if ($s === 'waiting_b' && $fallback === null) $fallback = $r;  // 别人等待中 → 我可加入
    }
    return $fallback;
}

/* 是否有"别人正在作答"的活跃回合（只回传这个信号，不含任何内容） */
function compat_busy(array $rounds, string $deviceId): bool {
    $now = time();
    foreach ($rounds as $r) {
        $s = u_str($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') continue;
        if (compat_is_mine($r, $deviceId)) continue;           // 我自己参与的，不算"别人在忙"
        $age = $now - (int)($r['updated'] ?? $r['created'] ?? 0);
        if ($age < COMPAT_ACTIVE_TTL) return true;
    }
    return false;
}

/* 页面注入视图（api/config.php 用）：身份由服务端 Cookie 决定 */
function compat_inject_view(string $deviceId): array {
    $rounds = compat_read();
    $active = compat_pick_active($rounds, $deviceId);
    return [
        'active'  => $active !== null ? compat_active_view($active, $deviceId) : null,
        'history' => compat_history_view($rounds, $deviceId),
        'busy'    => $active === null ? compat_busy($rounds, $deviceId) : false,
    ];
}

/* 状态视图（接口用）：active 回合(不含任何答案) + 完成历史 */
function compat_status_view(string $deviceId): array {
    $rounds = compat_read();
    $active = compat_pick_active($rounds, $deviceId);
    $view = $active !== null ? compat_active_view($active, $deviceId) : null;

    /* 无进行中回合时：我参与过的最近一个完成回合 → 返回结果（轮询/刷新可见结果页） */
    if ($view === null) {
        $mine = array_values(array_filter($rounds, function ($r) use ($deviceId) {
            return ($r['status'] ?? '') === 'done' && compat_is_mine($r, $deviceId);
        }));
        usort($mine, function ($x, $y) { return (int)($y['updated'] ?? 0) - (int)($x['updated'] ?? 0); });
        if (!empty($mine)) {
            $r = $mine[0];
            $view = [
                'id' => u_str($r['id'] ?? ''),
                'status' => 'done',
                'myRole' => u_str($r['a']['deviceId'] ?? '') === $deviceId ? compat_role($r, 'a') : compat_role($r, 'b'),
                'result' => compat_result_view($r),
            ];
        }
    }

    return [
        'active'  => $view,
        'history' => compat_history_view($rounds, $deviceId),
        'busy'    => $view === null ? compat_busy($rounds, $deviceId) : false,
    ];
}
