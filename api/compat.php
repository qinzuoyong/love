<?php
/* ============================================================
   情侣网站 · 默契度测试接口（公开）
   回合状态机 + 无感自动配对 + 随机抽题
   ------------------------------------------------------------
   设计：
   - 全局同一时刻只有一个"进行中"回合（pending / waiting_b），
     发起新回合时旧的未完成回合自动作废（全局单活跃，免配对码）。
   - 第一人创建回合（pending）→ 答完 a → waiting_b
     → 第二人（另一台设备）打开页面自动匹配到等待中的回合加入
     → 答完 b → done，双方才可见逐题对比。
   - 同一台设备接力：提交时只要对应槽位为空即可，不限制 deviceId。
   - 双方都答完之前不下发对方答案（防偷看）。
   安全：IP 写入限速、长度/类型校验、题目快照由前端随机抽取后提交。
   页面加载时的状态由 api/config.php 注入（window.__SERVER_COMPAT__），
   本接口用于后续查询与写入（WAF 挑战 cookie 在页面加载后已建立）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/content.php';   // clean_id
require __DIR__ . '/../lib/compat.php';     // 共享：compat_status_view / compat_result_view

const COMPAT_WRITE_LIMIT = 20; // 每 IP 每 10 分钟最多写 20 次
const COMPAT_WRITE_WINDOW = 600;

function compat_write_rounds(array $rounds): bool {
    return love_write(COMPAT_FILE, ['rounds' => $rounds]);
}

/* 写入限流（与 content.php 分开计数，互不干扰） */
function compat_throttled(): bool {
    $key = 'cpt_' . ($_SERVER['REMOTE_ADDR'] ?? '?');
    $sec = love_read('security.json', []);
    $hits = (array)($sec['hits_cpt'] ?? []);
    $now = time();
    $hits = array_values(array_filter($hits, function ($t) use ($now) { return $t > $now - COMPAT_WRITE_WINDOW; }));
    if (count($hits) >= COMPAT_WRITE_LIMIT) return false;
    $hits[] = $now;
    $sec['hits_cpt'] = $hits;
    love_write('security.json', $sec);
    return true;
}

/* ---------- 校验 ---------- */
function compat_sanitize_questions($questions): ?array {
    if (!is_array($questions) || count($questions) !== COMPAT_QUESTIONS) return null;
    $out = [];
    foreach ($questions as $q) {
        if (!is_array($q)) return null;
        $qs = trim((string)($q['q'] ?? ''));
        $opts = is_array($q['opts'] ?? null) ? $q['opts'] : [];
        if ($qs === '' || u_len($qs) > COMPAT_Q_MAX) return null;
        $oc = [];
        foreach ($opts as $o) {
            $os = trim((string)$o);
            if ($os === '' || u_len($os) > COMPAT_OPT_MAX) return null;
            $oc[] = $os;
        }
        if (count($oc) < 2 || count($oc) > 6) return null;
        $out[] = ['q' => $qs, 'opts' => $oc];
    }
    return $out;
}

function compat_sanitize_answers($answers, array $questions): ?array {
    if (!is_array($answers) || count($answers) !== count($questions)) return null;
    $out = [];
    foreach ($answers as $i => $a) {
        if (!is_int($a) && !ctype_digit((string)$a)) return null;
        $a = (int)$a;
        if ($a < 0 || $a >= count($questions[$i]['opts'])) return null;
        $out[] = $a;
    }
    return $out;
}

/* ---------- POST create: 发起新回合（作废旧回合, 全局单活跃） ---------- */
function compat_create(array $in): array {
    $role = (string)($in['role'] ?? '');
    $deviceId = clean_id((string)($in['deviceId'] ?? ''));
    $questions = compat_sanitize_questions($in['questions'] ?? null);
    if (!in_array($role, ['boy', 'girl'], true) || $deviceId === '' || $questions === null) {
        return ['ok' => false, 'error' => '参数错误'];
    }
    $rounds = compat_read();
    $rounds = array_values(array_filter($rounds, function ($r) {
        $s = (string)($r['status'] ?? '');
        return $s === 'done' || $s === 'abandoned';
    }));
    $round = [
        'id' => 'c' . bin2hex(random_bytes(6)),
        'status' => 'pending',
        'questions' => $questions,
        'a' => ['role' => $role, 'answers' => null, 'deviceId' => $deviceId, 'ts' => null],
        'b' => ['role' => $role === 'boy' ? 'girl' : 'boy', 'answers' => null, 'deviceId' => null, 'ts' => null],
        'created' => time(),
        'updated' => time(),
    ];
    $rounds[] = $round;
    if (!compat_write_rounds($rounds)) return ['ok' => false, 'error' => '服务器繁忙'];
    return ['ok' => true, 'round' => ['id' => $round['id'], 'role' => $role]];
}

/* ---------- POST submit: 提交答案（a → waiting_b, b → done） ---------- */
function compat_submit(array $in): array {
    $id = clean_id((string)($in['id'] ?? ''));
    $role = (string)($in['role'] ?? '');
    $deviceId = clean_id((string)($in['deviceId'] ?? ''));
    if ($id === '' || !in_array($role, ['boy', 'girl'], true) || $deviceId === '') {
        return ['ok' => false, 'error' => '参数错误'];
    }

    $result = null;
    $err = null;
    $rounds = love_mutate(COMPAT_FILE, function ($d) use ($id, $role, $deviceId, $in, &$result, &$err) {
        $rounds = is_array($d['rounds'] ?? null) ? $d['rounds'] : [];
        $idx = -1;
        foreach ($rounds as $i => $r) {
            if (($r['id'] ?? '') === $id) { $idx = $i; break; }
        }
        if ($idx < 0) { $err = '回合不存在或已结束'; return $d; }
        $r = $rounds[$idx];
        $s = (string)($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') { $err = '回合已结束'; return $d; }

        $answers = compat_sanitize_answers($in['answers'] ?? null, $r['questions']);
        if ($answers === null) { $err = '答案格式不对'; return $d; }

        if (($r['a']['role'] ?? '') === $role) {
            if (is_array($r['a']['answers'] ?? null)) { $err = '你已经答过了'; return $d; }
            if ($s !== 'pending') { $err = '回合状态不对'; return $d; }
            $r['a']['answers'] = $answers;
            $r['a']['deviceId'] = $deviceId;
            $r['a']['ts'] = time();
            $r['status'] = 'waiting_b';
        } elseif (($r['b']['role'] ?? '') === $role) {
            if (is_array($r['b']['answers'] ?? null)) { $err = '你已经答过了'; return $d; }
            if ($s !== 'waiting_b') { $err = '对方还没答完，你答早了'; return $d; }
            $r['b']['answers'] = $answers;
            $r['b']['deviceId'] = $deviceId;
            $r['b']['ts'] = time();
            $r['status'] = 'done';
        } else {
            $err = '这个身份不在本回合中'; return $d;
        }
        $r['updated'] = time();
        $rounds[$idx] = $r;
        $d['rounds'] = $rounds;
        $result = $r;
        return $d;
    }, []);

    if (!is_array($rounds)) return ['ok' => false, 'error' => '服务器繁忙'];
    if ($err !== null) return ['ok' => false, 'error' => $err];

    $out = ['ok' => true, 'done' => ($result['status'] ?? '') === 'done'];
    if (!empty($out['done'])) $out['result'] = compat_result_view($result);
    return $out;
}

/* ---------- 路由 ---------- */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $action = (string)($_GET['action'] ?? 'status');
    if ($action === 'status') {
        $deviceId = clean_id((string)($_GET['deviceId'] ?? ''));
        love_json(['ok' => true] + compat_status_view($deviceId));
    }
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}

$in = love_body();
$action = (string)($in['action'] ?? '');
if (!in_array($action, ['create', 'submit'], true)) {
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}
if (!compat_throttled()) love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);

switch ($action) {
    case 'create': love_json(compat_create($in));
    case 'submit': love_json(compat_submit($in));
}
