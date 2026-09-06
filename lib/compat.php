<?php
/* ============================================================
   情侣网站 · 默契度回合数据层（共享）
   api/compat.php（访客接口）与 api/config.php（页面注入）共用。
   可见性规则：进行中的回合不下发任何一方答案，双方都答完
   （status=done）才通过结果视图/历史公开。
   ============================================================ */

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/content.php';   // clean_id

const COMPAT_FILE = 'compat.json';
const COMPAT_QUESTIONS = 10;   // 每回合题目数上限（题库不足时按实际数量进行）
const COMPAT_Q_MAX = 200;      // 单题最大字符数
const COMPAT_OPT_MAX = 60;     // 单选项最大字符数
const COMPAT_HISTORY = 10;     // 历史返回条数

function compat_read(): array {
    $d = love_read(COMPAT_FILE, []);
    return is_array($d['rounds'] ?? null) ? $d['rounds'] : [];
}

function compat_pct(array $a, array $b): array {
    $same = 0;
    $total = count($a);
    for ($i = 0; $i < $total; $i++) if ($a[$i] === $b[$i]) $same++;
    return [$same, $total];
}

/* 完成回合 → 结果视图（双方答案公开） */
function compat_result_view(array $r): array {
    $a = $r['a']['answers'];
    $b = $r['b']['answers'];
    [$same, $total] = compat_pct($a, $b);
    $detail = [];
    foreach ($r['questions'] as $i => $q) {
        $match = $a[$i] === $b[$i];
        $detail[] = [
            'q' => $q['q'], 'opts' => $q['opts'],
            'a' => $a[$i], 'b' => $b[$i], 'match' => $match,
        ];
    }
    return [
        'pct' => (int)round($same / max(1, $total) * 100),
        'same' => $same, 'total' => $total, 'detail' => $detail,
        'roles' => ['a' => $r['a']['role'], 'b' => $r['b']['role']],
    ];
}

/* 完成历史视图（注入与接口共用） */
function compat_history_view(array $rounds): array {
    $history = [];
    $done = array_values(array_filter($rounds, function ($r) { return ($r['status'] ?? '') === 'done'; }));
    usort($done, function ($x, $y) { return ($y['updated'] ?? 0) - ($x['updated'] ?? 0); });
    foreach (array_slice($done, 0, COMPAT_HISTORY) as $r) {
        [$same, $total] = compat_pct($r['a']['answers'], $r['b']['answers']);
        $history[] = [
            'id' => (string)$r['id'],
            'pct' => (int)round($same / max(1, $total) * 100),
            'same' => $same, 'total' => $total,
            'at' => (int)($r['updated'] ?? 0),
            'roles' => ['a' => (string)$r['a']['role'], 'b' => (string)$r['b']['role']],
            'questions' => $r['questions'],
            'answers' => ['a' => $r['a']['answers'], 'b' => $r['b']['answers']],
        ];
    }
    return $history;
}

/* 页面注入视图（api/config.php 用）：不知道访客 deviceId，
   注入"通用"active（含 aDeviceId 供前端自行判断身份），
   依旧不含任何一方的答案（防偷看）。 */
function compat_inject_view(): array {
    $rounds = compat_read();
    $active = null;
    foreach ($rounds as $r) {
        $s = (string)($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') continue;
        $active = [
            'id' => (string)$r['id'],
            'status' => $s,
            'questions' => $r['questions'],
            'aRole' => (string)$r['a']['role'],
            'bRole' => (string)$r['b']['role'],
            'aDeviceId' => (string)$r['a']['deviceId'],
            'aAnswered' => is_array($r['a']['answers'] ?? null),
            'bAnswered' => is_array($r['b']['answers'] ?? null),
        ];
        break;
    }
    return ['active' => $active, 'history' => compat_history_view($rounds)];
}

/* 状态视图（接口用）：active 回合(不含任何答案) + 完成历史 */
function compat_status_view(string $deviceId): array {
    $rounds = compat_read();
    $active = null;
    foreach ($rounds as $r) {
        $s = (string)($r['status'] ?? '');
        if ($s === 'done' || $s === 'abandoned') continue;
        $aDev = (string)($r['a']['deviceId'] ?? '');
        if ($aDev === $deviceId) { $active = $r; break; }          // 我创建的（继续作答 / 等对方）
        if ($s === 'waiting_b') { $active = $r; break; }           // 别人等待中 → 我可加入
    }
    $view = null;
    if ($active !== null) {
        $s = (string)$active['status'];
        $aDev = (string)($active['a']['deviceId'] ?? '');
        $myRole = '';
        $iAnswered = false;
        $canJoin = false;
        if ($aDev === $deviceId) {
            $myRole = (string)$active['a']['role'];
            $iAnswered = is_array($active['a']['answers'] ?? null);
        } elseif ($s === 'waiting_b') {
            $myRole = (string)$active['b']['role'];
            $canJoin = true;
        }
        if ($myRole !== '' || $canJoin) {
            $view = [
                'id' => (string)$active['id'],
                'status' => $s,
                'questions' => $active['questions'],
                'myRole' => $myRole,
                'iAnswered' => $iAnswered,
                'canJoin' => $canJoin,
                'waitingFor' => ($s === 'waiting_b' && $aDev === $deviceId) ? 'b' : null,
            ];
        }
    }

    /* 无进行中回合时：我参与过的最近一个完成回合 → 返回结果（轮询/刷新可见结果页） */
    if ($view === null) {
        $mine = array_values(array_filter($rounds, function ($r) use ($deviceId) {
            if (($r['status'] ?? '') !== 'done') return false;
            return (string)($r['a']['deviceId'] ?? '') === $deviceId
                || (string)($r['b']['deviceId'] ?? '') === $deviceId;
        }));
        usort($mine, function ($x, $y) { return ($y['updated'] ?? 0) - ($x['updated'] ?? 0); });
        if (!empty($mine)) {
            $r = $mine[0];
            $view = [
                'id' => (string)$r['id'],
                'status' => 'done',
                'myRole' => (string)($r['a']['deviceId'] ?? '') === $deviceId ? (string)$r['a']['role'] : (string)$r['b']['role'],
                'result' => compat_result_view($r),
            ];
        }
    }

    return ['active' => $view, 'history' => compat_history_view($rounds)];
}
