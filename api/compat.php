<?php
/* ============================================================
   情侣网站 · 默契度测试接口（公开）
   回合状态机 + 无感自动配对 + 随机抽题
   ------------------------------------------------------------
   设计：
   - 全局同一时刻只有一个"进行中"回合（pending / waiting_b）。
   - 第一人创建回合（pending）→ 答完 a → waiting_b
     → 第二人（另一台设备）打开页面自动匹配到等待中的回合加入
     → 答完 b → done，双方才可见逐题对比。
   - 同一台设备接力：提交时只要对应槽位为空即可。
   - 双方都答完之前不下发对方答案（防偷看）。
   - 身份由服务端 HttpOnly Cookie 决定，前端不持有任何凭据。
   安全：按 IP 写入限速、长度/类型校验、题目快照由前端随机抽取后提交。
   页面加载时的状态由 api/config.php 注入（window.__SERVER_COMPAT__），
   本接口用于后续查询与写入（WAF 挑战 cookie 在页面加载后已建立）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';
require __DIR__ . '/../lib/content.php';   // clean_id
require __DIR__ . '/../lib/compat.php';     // 共享：compat_status_view / compat_result_view

/* 服务端门禁：未解锁一律拒绝 */
if (!love_gate_ok()) love_json(['ok' => false, 'error' => '需要先解锁', 'locked' => true], 401);

const COMPAT_WRITE_LIMIT = 20; // 每 IP 每 10 分钟最多写 20 次
const COMPAT_WRITE_WINDOW = 600;

/* ---------- 校验 ----------
   compat_sanitize_questions / compat_sanitize_answers 统一放在 lib/compat.php
   （本文件顶部已 require）：后台恢复备份要用同一套校验过滤历史数据，
   维护两份实现迟早会改漂。 */

/* ---------- POST create: 发起新回合 ----------
   注意：不再"无条件作废"进行中的回合——那会把对方正在作答的 10 题答案
   直接删掉。若已有活跃回合（600 秒内更新过），返回 busy 让前端提示/加入。 */
function compat_create(array $in, string $deviceId): array {
    $role = u_str($in['role'] ?? '');
    $questions = compat_sanitize_questions($in['questions'] ?? null);
    if (!in_array($role, ['boy', 'girl'], true) || $deviceId === '' || $questions === null) {
        return ['ok' => false, 'error' => '参数错误'];
    }
    $now = time();
    $busy = null;
    $created = null;
    $out = love_mutate(COMPAT_FILE, function ($d) use ($role, $deviceId, $questions, $now, &$busy, &$created) {
        $rounds = is_array($d['rounds'] ?? null) ? $d['rounds'] : [];
        $kept = [];
        foreach ($rounds as $r) {
            $s = u_str($r['status'] ?? '');
            if ($s === 'done' || $s === 'abandoned') { $kept[] = $r; continue; }
            $age = $now - (int)($r['updated'] ?? $r['created'] ?? 0);
            if ($age < COMPAT_ACTIVE_TTL) {          // 有人在作答 → 拒绝新建
                $busy = $r;
                return $d;
            }
            // 超过 TTL 的僵尸回合直接丢弃
        }
        $round = [
            'id' => 'c' . bin2hex(random_bytes(6)),
            'status' => 'pending',
            'questions' => $questions,
            'a' => ['role' => $role, 'answers' => null, 'deviceId' => $deviceId, 'ts' => null],
            'b' => ['role' => $role === 'boy' ? 'girl' : 'boy', 'answers' => null, 'deviceId' => null, 'ts' => null],
            'created' => $now,
            'updated' => $now,
        ];
        $kept[] = $round;
        $d['rounds'] = $kept;
        $created = $round;
        return $d;
    }, []);
    if (!is_array($out)) return ['ok' => false, 'error' => '服务器繁忙'];
    if ($busy !== null) {
        return [
            'ok' => false,
            'busy' => true,
            'error' => '对方正在作答中，先等 TA 答完吧（或刷新页面接手）',
        ];
    }
    if ($created === null) return ['ok' => false, 'error' => '服务器繁忙'];
    return ['ok' => true, 'round' => ['id' => $created['id'], 'role' => $role]];
}

/* ---------- POST submit: 提交答案（a → waiting_b, b → done） ---------- */
function compat_submit(array $in, string $deviceId): array {
    $id = clean_id(u_str($in['id'] ?? ''));
    $role = u_str($in['role'] ?? '');
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
        $s = u_str($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') { $err = '回合已结束'; return $d; }

        /* questions 必须真是数组：手工改坏的 compat.json 里它可能是字符串，
           直接传给 compat_sanitize_answers(array $questions) 会抛 TypeError
           （接口返回 HTML 错误页而不是 JSON）。 */
        $qset = is_array($r['questions'] ?? null) ? $r['questions'] : null;
        if ($qset === null) { $err = '回合数据异常，请重新发起'; return $d; }
        $answers = compat_sanitize_answers($in['answers'] ?? null, $qset);
        if ($answers === null) { $err = '答案格式不对'; return $d; }

        if (($r['a']['role'] ?? '') === $role) {
            // 发起人身份校验：回合 id 会随页面注入下发，不能只凭 id 就认人
            if (u_str($r['a']['deviceId'] ?? '') !== $deviceId) { $err = '这一轮不是这台设备发起的'; return $d; }
            if (is_array($r['a']['answers'] ?? null)) { $err = '你已经答过了'; return $d; }
            if ($s !== 'pending') { $err = '回合状态不对'; return $d; }
            $r['a']['answers'] = $answers;
            $r['a']['deviceId'] = $deviceId;
            $r['a']['ts'] = time();
            $r['status'] = 'waiting_b';
        } elseif (($r['b']['role'] ?? '') === $role) {
            // b 槽位按设计允许"接力"：但一旦已经有人接手，就不允许第三台设备覆盖
            $bDev = u_str($r['b']['deviceId'] ?? '');
            if ($bDev !== '' && $bDev !== $deviceId) { $err = '这一轮已经有人接手了'; return $d; }
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
$deviceId = love_device_id();     // 服务端权威身份（HttpOnly Cookie）

if ($method === 'GET') {
    $action = u_str($_GET['action'] ?? 'status');
    if ($action === 'status') {
        love_json(['ok' => true] + compat_status_view($deviceId));
    }
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}

$in = love_body();
$action = u_str($in['action'] ?? '');
if (!in_array($action, ['create', 'submit'], true)) {
    love_json(['ok' => false, 'error' => '未知操作'], 400);
}
if (!love_rate_ok('compat', COMPAT_WRITE_LIMIT, COMPAT_WRITE_WINDOW)) {
    love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);
}

switch ($action) {
    case 'create': love_json(compat_create($in, $deviceId));
    case 'submit': love_json(compat_submit($in, $deviceId));
}
