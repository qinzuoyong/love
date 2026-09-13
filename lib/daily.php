<?php
/* ============================================================
   情侣网站 · 每日一问（数据层）
   ------------------------------------------------------------
   设计要点：
   - 题目本身不下发到服务器：服务端只算「今天是第几天」，
     前端用 CONFIG.dailyQuestions[dayNo % 题目数] 取题 ——
     双方打开同一页看到的一定是同一题，也不会把题库复制两份。
   - 答案存 data/daily.json，按日期分桶、按设备标识存；
     **对方答案只有在自己也答过之后才会出现在响应里**（防偷看）。
   - 换题日期按服务端 Asia/Shanghai 的"今天"算（见 lib/store.php）。
   ============================================================ */

declare(strict_types=1);

const DAILY_FILE = 'daily.json';
const DAILY_MAX  = 200;   // 单条回答长度上限
const DAILY_KEEP = 400;   // 最多保留多少天的记录

function daily_read(): array {
    $d = love_read(DAILY_FILE, null);
    return is_array($d) ? $d : [];
}

/** 今天是"第几天"：以 startDate 为 0，双方一致（没填则用 1970-01-01 起算） */
function daily_day_no(string $date): int {
    $c = love_read('config.json', []);
    $start = is_array($c) ? u_str($c['startDate'] ?? '') : '';
    $base = preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) ? $start : '1970-01-01';
    $a = strtotime($base . ' 00:00:00');
    $b = strtotime($date . ' 00:00:00');
    if ($a === false || $b === false) return 0;
    return (int)floor(($b - $a) / 86400);
}

/** 今日视图（对方答案在我答过之后才给） */
function daily_view(string $deviceId): array {
    $date = date('Y-m-d');
    $all = daily_read();
    $answers = (isset($all[$date]) && is_array($all[$date]['answers'] ?? null)) ? $all[$date]['answers'] : [];

    $mine = null; $others = []; $partnerAnswered = false;
    foreach ($answers as $dev => $a) {
        if (!is_array($a)) continue;
        $item = ['text' => u_str($a['text'] ?? ''), 'ts' => (int)($a['ts'] ?? 0)];
        if ((string)$dev === $deviceId && $deviceId !== '') $mine = $item;
        else { $partnerAnswered = true; $others[] = $item; }
    }

    return [
        'enabled'          => true,
        'date'             => $date,
        'dayNo'            => daily_day_no($date),
        'mine'             => $mine,
        'partnerAnswered'  => $partnerAnswered,
        'partner'          => $mine !== null ? $others : [],
    ];
}

/** 提交今天的回答（日期由服务端决定，不接受前端传入） */
function daily_answer(array $in, string $deviceId): array {
    $text = u_sub(trim(u_str($in['text'] ?? '')), DAILY_MAX);
    if ($text === '') return ['ok' => false, 'error' => '写点什么再提交吧'];
    if ($deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    $date = date('Y-m-d');
    $result = ['ok' => false, 'error' => '服务器繁忙'];
    $out = love_mutate(DAILY_FILE, function ($d) use ($date, $deviceId, $text, &$result) {
        if (!is_array($d)) $d = [];
        if (!isset($d[$date]) || !is_array($d[$date])) $d[$date] = ['answers' => []];
        if (!isset($d[$date]['answers']) || !is_array($d[$date]['answers'])) $d[$date]['answers'] = [];
        $d[$date]['answers'][$deviceId] = ['text' => $text, 'ts' => time()];

        // 控制文件体积：只留最近 DAILY_KEEP 天
        if (count($d) > DAILY_KEEP) {
            ksort($d);
            $d = array_slice($d, -DAILY_KEEP, null, true);
        }
        $result = ['ok' => true];
        return $d;
    }, []);
    if (!is_array($out)) return ['ok' => false, 'error' => '服务器繁忙'];
    return $result;
}

/** 管理员视图：全部记录（含题目下标，方便后台显示） */
function daily_admin_view(): array {
    $out = [];
    foreach (daily_read() as $date => $rec) {
        if (!is_array($rec)) continue;
        $answers = is_array($rec['answers'] ?? null) ? $rec['answers'] : [];
        $list = [];
        foreach ($answers as $dev => $a) {
            if (!is_array($a)) continue;
            $list[] = ['dev' => u_str($dev), 'text' => u_str($a['text'] ?? ''), 'ts' => (int)($a['ts'] ?? 0)];
        }
        $out[] = ['date' => u_str($date), 'dayNo' => daily_day_no(u_str($date)), 'answers' => $list];
    }
    usort($out, function ($x, $y) { return strcmp($y['date'], $x['date']); });
    return $out;
}
