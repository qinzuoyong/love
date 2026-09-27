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

/* 限流额度（每 IP / 窗口）的唯一定义处是 lib/store.php 的
   LOVE_RATE_COMPAT_LIMIT / LOVE_RATE_WINDOW；本接口只声明桶名，经 love_rate_allowed
   统一判定（第七轮 S3-04：三个写接口的额度不再各写一份）。 */

/* ---------- 校验 ----------
   compat_sanitize_questions / compat_sanitize_answers 统一放在 lib/compat.php
   （本文件顶部已 require）：后台恢复备份要用同一套校验过滤历史数据，
   维护两份实现迟早会改漂。 */

/* ---------- POST create: 发起新回合 ----------
   注意：不再"无条件作废"进行中的回合——那会把对方正在作答的 10 题答案
   直接删掉。若已有活跃回合（COMPAT_ACTIVE_TTL 内更新过），返回 busy 让前端提示/加入。 */
function compat_create(array $in, string $deviceId): array {
    $role = u_str($in['role'] ?? '');
    $questions = compat_sanitize_questions($in['questions'] ?? null);
    if (!in_array($role, ['boy', 'girl'], true) || $deviceId === '' || $questions === null) {
        return ['ok' => false, 'error' => '参数错误'];
    }
    $now = time();
    $busy = null;
    $mine = null;
    $created = null;
    $out = love_mutate(COMPAT_FILE, function ($d) use ($role, $deviceId, $questions, $now, &$busy, &$mine, &$created) {
        $rounds = compat_rounds_of($d);
        $kept = [];
        foreach ($rounds as $r) {
            $s = u_str($r['status'] ?? '');
            if ($s === 'done' || $s === 'abandoned') { $kept[] = $r; continue; }
            $age = $now - (int)($r['updated'] ?? $r['created'] ?? 0);
            if ($age < COMPAT_ACTIVE_TTL) {          // 有人在作答 → 拒绝新建
                /* **排除自己的回合**（口径必须与 compat_busy() 一致：那里有一句
                   `if (compat_is_mine($r, $deviceId)) continue;`）。
                   不排除的话："我手上还有一轮没答完，再点一次开始"会被自己判成
                   busy → 前端盖掉作答界面、进无按钮的"对方正在作答中"，
                   而轮询三个出口（done / canJoin / 无活跃）一个都不命中 →
                   只能刷新，刷新后内存里已答的题全丢（第四轮 F-S8-1）。
                   自己的活跃回合要如实报成 `mine`，让前端把那一轮带回来继续答。 */
                if (compat_is_mine($r, $deviceId)) { $mine = $r; } else { $busy = $r; }
                /* 活跃回合原样收进 $kept，并**继续扫完剩下的回合**：这一轮已经算出的
                   "陈旧回合 → abandoned"必须落盘（第七轮 S3-03）。
                   旧实现是就地 `return $d`（未修改的原始数据），于是只要存在一个
                   TTL 内的活跃回合，比它更旧的进行中回合就永远保持 pending /
                   waiting_b：既不会被清账，又会以 canJoin 形式出现在别人页面上
                   （compat_pick_active 的 fallback 不看 age），与文件头"全局同一
                   时刻只有一个进行中回合"及 _test_compat.py 的"全局单活跃"断言相左。 */
                $kept[] = $r;
                continue;
            }
            /* 超过 TTL 的回合**不再直接删掉**：对面那个人可能正拿着 10 题答案在路上，
               删掉就等于把 TA 的工作静默销毁（TA 提交时只会看到"回合不存在或已结束"）。
               改成标成 abandoned —— 记录留在文件里（答案也留着），线上会通过
               COMPAT_ABANDONED_KEEP 只保留最近几条，答不了新题但不至于丢证据。 */
            $r['status'] = 'abandoned';
            $r['abandoned_at'] = $now;
            $kept[] = $r;
        }
        /* abandoned 只留最近几条（数组是最旧→最新，所以从头删）：
           它只是"提示用料"，留着无限长会让 compat.json 与页面注入一起变胖。 */
        $abandonedIdx = [];
        foreach ($kept as $i => $r) {
            if (u_str($r['status'] ?? '') === 'abandoned') $abandonedIdx[] = $i;
        }
        $dropCount = count($abandonedIdx) - COMPAT_ABANDONED_KEEP;
        if ($dropCount > 0) {
            for ($i = 0; $i < $dropCount; $i++) unset($kept[$abandonedIdx[$i]]);
            $kept = array_values($kept);
        }
        /* 早退（有活跃回合 → busy / mine）：上面的"陈旧回合标 abandoned + 裁剪"
           同样要写回，否则这一轮的计算全白做（第七轮 S3-03）。
           注意 $kept 此刻已含本轮扫过的**全部**回合（活跃的也原样收了进去），
           所以写回不会丢任何一条。 */
        if ($busy !== null || $mine !== null) {
            $d['rounds'] = $kept;
            return $d;
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
    if ($mine !== null) {
        /* 自己的回合：不是"别人在忙"，而是"你自己还没答完"。带上 id/status，
           让前端能直接回到那一轮（而不是停在无按钮的等待屏）。 */
        return [
            'ok' => false,
            'mine' => true,
            'round' => [
                'id' => u_str($mine['id'] ?? ''),
                'role' => $role,
                'status' => u_str($mine['status'] ?? ''),
            ],
            'error' => '你自己还有一轮没答完，先把它答完吧',
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
        $rounds = compat_rounds_of($d);
        $idx = -1;
        foreach ($rounds as $i => $r) {
            if (($r['id'] ?? '') === $id) { $idx = $i; break; }
        }
        if ($idx < 0) { $err = '回合不存在或已结束'; return $d; }
        $r = $rounds[$idx];
        $s = u_str($r['status'] ?? '');
        if ($s === 'abandoned') {
            /* 这一轮是被"对方重新开始了一轮"顶掉的。旧文案统一说"回合已结束"，
               答题人只会以为自己看错了；这里如实告诉他答案没保住，好让 TA 决定重答。
               （作废不再删除记录，就是为了能分辨出这种情况。） */
            $err = '这一轮已被对方重新开始，刚才的答案没能保存，需要重答一轮';
            return $d;
        }
        if ($s === 'done') { $err = '回合已结束'; return $d; }

        /* questions 必须真是数组：手工改坏的 compat.json 里它可能是字符串，
           直接传给 compat_sanitize_answers(array $questions) 会抛 TypeError
           （接口返回 HTML 错误页而不是 JSON）。 */
        $qset = is_array($r['questions'] ?? null) ? $r['questions'] : null;
        if ($qset === null) { $err = '回合数据异常，请重新发起'; return $d; }
        /* 再过一遍与 create / 恢复备份同一套严格校验。为什么不能只判 is_array：
           题目里 opts 是标量时 compat_sanitize_answers 只会返回 null（判非法），
           于是用户会看到"答案格式不对"——可这次错的**不是用户的答案**，是回合
           本身的数据坏了（那一题永远答不了）。用同一个校验器得到准确文案，
           也避免"答案格式"这条路径把畸形回合当成正常回合继续推状态机。 */
        $qset = compat_sanitize_questions($qset);
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
            /* done ⇒ 双方都答过 —— 这条不变量不能只由 status 字面值承载。
               手工按 README 救急改过、或恢复一份旧备份进来的 compat.json 可能是
               "status=waiting_b 但 a.answers 为 null"（lib/compat.php 的
               compat_sanitize_side 允许 answers=null，且不校验 status 与答案的一致性）。
               旧实现只凭 status 就放行：这一局被推成 done，结果页算出
               total=0（"共 0 题"）、detail 里第一人一栏全空，这一局还会进入双方的
               默契历史，配对记录被永久污染（第七轮 S3-02）。
               判据直接用与 create / 恢复备份同一套 compat_sanitize_answers
               （它要求"是列表且条数与题数一致、每个下标都在选项范围内"），
               不满足就按"回合数据异常"拒绝，并保持原状态不动。 */
            if (compat_sanitize_answers($r['a']['answers'] ?? null, $qset) === null) {
                $err = '回合数据异常，请重新发起';
                return $d;
            }
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
if (!love_rate_allowed('compat')) {
    love_json(['ok' => false, 'error' => '操作太频繁，请稍后再试'], 429);
}

switch ($action) {
    case 'create': love_json(compat_create($in, $deviceId));
    case 'submit': love_json(compat_submit($in, $deviceId));
}
