<?php
/* ============================================================
   情侣网站 · 配置校验与清洗（共享层）
   ------------------------------------------------------------
   被 admin/api.php（保存 / 恢复配置）与 api/config.php（下发配置）共用。

   为什么单独成文：后台保存路径一直有下面这两层校验，但「前台下发」
   （api/config.php）只做键白名单、不做结构检查 —— 而 README 恰恰建议
   用户「忘了密码就直接编辑 data/config.json」。一旦有人把 names 写成
   字符串、或把 anniversaries 写成非数组，前台就会显示
   "undefined ♥ undefined" 甚至直接抛错中断整段脚本。
   统一到这一层后，两条路径的口径完全一致。

   校验分两层：
     - 结构 / 类型错 → 整个键丢弃，记入 $rejected（前台回退到默认值）
     - 数组里某一条格式错 → 只丢这一条，记入 $skipped（不影响其它条目）
   这样「加了一条还没填完的题目」不会把整个题库清空。
   ============================================================ */

declare(strict_types=1);

require_once __DIR__ . '/store.php';   // u_sub

const CFG_KEYS = [
    'names', 'startDate', 'password', 'slogan', 'greeting',
    'messages', 'homeCards', 'anniversaries', 'timeline', 'gallery',
    'letters', 'wishes', 'quiz', 'compatQuiz', 'truthDares', 'dailyQuestions',
];

/* quiz 答案归一：后台旧版/手改 JSON 可能把 a 存成字符串或越界下标，
   写盘前统一校正为 0..opts-1 内的整数（前台 game.js 用 === 严格比较，
   字符串 "3" 会静默判错——点对正确选项也报错）。 */
function normalize_quiz(array $cfg): array {
    if (!is_array($cfg['quiz'] ?? null)) return $cfg;
    foreach ($cfg['quiz'] as $i => $q) {
        if (!is_array($q)) continue;
        $n = is_array($q['opts'] ?? null) ? count($q['opts']) : 0;
        /* a 必须是标量再转 int：直接 (int)数组 会得到 1（非空数组），手改的
           JSON/畸形备份会把"正确答案"悄悄改到下标 1 而不是被归一回 0。 */
        $rawA = $q['a'] ?? 0;
        $a = is_scalar($rawA) ? (int)$rawA : 0;
        if ($a < 0 || $a >= max(1, $n)) $a = 0;
        $cfg['quiz'][$i]['a'] = $a;
    }
    return $cfg;
}

function cfg_s($v, int $max): ?string {
    if (is_string($v)) return u_sub($v, $max);
    if (is_int($v) || is_float($v)) return u_sub((string)$v, $max);
    return null;
}

function cfg_date($v, bool $anniv): ?string {
    $s = cfg_s($v, 12);
    if ($s === null) return null;
    $s = trim($s);
    if (preg_match('/^(\d{4})-(\d{1,2})-(\d{1,2})$/', $s, $m)) {
        return checkdate((int)$m[2], (int)$m[3], (int)$m[1]) ? $s : null;
    }
    if (!$anniv) return null;
    // 每年都过：05-20 / 农历 8-15 / 闰月 闰4-15
    if (preg_match('/^(闰)?(\d{1,2})-(\d{1,2})$/u', $s, $m)) {
        $mo = (int)$m[2]; $dy = (int)$m[3];
        return ($mo >= 1 && $mo <= 12 && $dy >= 1 && $dy <= 31) ? $s : null;
    }
    return null;
}

/* 站内相对链接：拒绝协议相对外链与带 scheme 的地址（javascript: 等） */
function cfg_link($v): ?string {
    $s = cfg_s($v, 200);
    if ($s === null) return null;
    $s = trim($s);
    if ($s === '') return '';
    if (strpos($s, '//') === 0) return null;
    return preg_match('#^[A-Za-z0-9_\-./\#?=&%~]+$#', $s) ? $s : null;
}

function cfg_arr($v, int $max): ?array {
    return is_array($v) ? array_slice(array_values($v), 0, $max) : null;
}

function cfg_optlist($v): ?array {
    $a = cfg_arr($v, 8);
    if ($a === null) return null;
    $out = [];
    foreach ($a as $o) {
        $s = cfg_s($o, 60);
        if ($s === null) return null;
        $out[] = $s;
    }
    return $out;
}

function cfg_auto($v): ?string {
    $s = u_str($v);          // 数组/对象一律当空串：直接强转会产生警告（见 lib/store.php 文件头）
    return preg_match('/^(start|days\d{1,4}|year\d{1,2})$/', $s) ? $s : null;
}

/** @param array $rejected 出参：整个键被丢弃的键名
 *  @param array $skipped  出参：键 => 被丢弃的条目数 */
function sanitize_cfg(array $ov, array &$rejected, array &$skipped): array {
    $out = [];
    foreach (CFG_KEYS as $k) {
        if (!array_key_exists($k, $ov)) continue;
        $v = $ov[$k];
        $val = null;
        $keep = false;

        switch ($k) {
            case 'names': {
                if (!is_array($v)) break;
                $n = [];
                foreach (['boy', 'girl'] as $f) {
                    if (!array_key_exists($f, $v)) continue;
                    $s = cfg_s($v[$f], 20);
                    if ($s === null) { $n = null; break; }
                    $n[$f] = $s;
                }
                if (is_array($n) && $n) { $val = $n; $keep = true; }
                break;
            }

            case 'startDate': {
                $s = cfg_date($v, false);
                if ($s !== null) { $val = $s; $keep = true; }
                break;
            }

            /* 解锁口令：只做「去首尾空白」的归一，与比对端 love_gate_password()
               的 trim 口径严格一致。不这样处理有两个真实的坑（都让人以为"密码设好了"）：
                 - 存成纯空格 → 比对端 trim 成空串 → 门禁静默关闭，后台却照着显示"已设"；
                 - 存成 "520520 " → 后台与备份里带着空格，真正生效的却是去掉空格的
                   版本，照后台显示去输的人必然永远失败。
               纯空白输入按「拒绝该键」处理（保留磁盘原值），而不是当成关闭门禁 ——
               关闭门禁有显式的空串写法，不需要靠打空格来表达。 */
            case 'password': {
                $s = cfg_s($v, 40);
                if ($s === null) break;
                $t = trim($s);
                if ($t === '' && $s !== '') break;    // 纯空白 → 丢弃该键，沿用磁盘现值
                $val = $t; $keep = true;
                break;
            }

            case 'slogan':
            case 'greeting': {
                $max = $k === 'slogan' ? 120 : 60;
                $s = cfg_s($v, $max);
                if ($s !== null) { $val = $s; $keep = true; }
                break;
            }

            case 'dailyQuestions': {   // 每日一问题库（纯文本数组）
                $a = cfg_arr($v, 200);
                if ($a === null) break;
                $l = [];
                foreach ($a as $s) {
                    $x = cfg_s($s, 120);
                    $x = $x === null ? null : trim($x);
                    if ($x === null || $x === '') { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $l[] = $x;
                }
                $val = $l; $keep = true;
                break;
            }

            case 'messages':
            case 'truthDares': {
                $a = cfg_arr($v, $k === 'messages' ? 50 : 200);
                if ($a === null) break;
                $l = [];
                foreach ($a as $s) {
                    $x = cfg_s($s, $k === 'messages' ? 120 : 200);
                    if ($x === null) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $l[] = $x;
                }
                $val = $l; $keep = true;
                break;
            }

            case 'homeCards': {
                $a = cfg_arr($v, 20);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $ic = cfg_s($it['icon'] ?? '', 8);
                    $t  = cfg_s($it['title'] ?? '', 40);
                    $x  = cfg_s($it['text'] ?? '', 200);
                    $lk = cfg_link($it['link'] ?? '');
                    $lt = cfg_s($it['linkText'] ?? '', 40);
                    if ($ic === null || $t === null || $x === null || $lk === null || $lt === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $l[] = ['icon' => $ic, 'title' => $t, 'text' => $x, 'link' => $lk, 'linkText' => $lt];
                }
                $val = $l; $keep = true;
                break;
            }

            case 'anniversaries': {
                $a = cfg_arr($v, 60);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $ic = cfg_s($it['icon'] ?? '', 8);
                    $t  = cfg_s($it['title'] ?? '', 40);
                    $d  = cfg_date($it['date'] ?? '', true);
                    if ($ic === null || $t === null || $t === '' || $d === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $row = ['icon' => $ic, 'title' => $t, 'date' => $d,
                            'type' => (($it['type'] ?? '') === 'once' ? 'once' : 'repeat')];
                    if (!empty($it['lunar'])) $row['lunar'] = true;
                    if (isset($it['auto'])) {
                        $au = cfg_auto($it['auto']);
                        if ($au !== null) $row['auto'] = $au;
                    }
                    $l[] = $row;
                }
                $val = $l; $keep = true;
                break;
            }

            case 'timeline': {
                $a = cfg_arr($v, 300);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $ic = cfg_s($it['icon'] ?? '', 8);
                    $t  = cfg_s($it['title'] ?? '', 40);
                    $d  = cfg_date($it['date'] ?? '', false);
                    $x  = cfg_s($it['text'] ?? '', 500);
                    if ($ic === null || $t === null || $t === '' || $d === null || $x === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $row = ['date' => $d, 'icon' => $ic, 'title' => $t, 'text' => $x];
                    if (isset($it['auto'])) {
                        $au = cfg_auto($it['auto']);
                        if ($au !== null) $row['auto'] = $au;
                    }
                    $l[] = $row;
                }
                $val = $l; $keep = true;
                break;
            }

            case 'gallery': {
                $a = cfg_arr($v, 500);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $src = cfg_link($it['src'] ?? '');
                    $cat = cfg_s($it['cat'] ?? '', 20);
                    $cap = cfg_s($it['cap'] ?? '', 60);
                    if ($src === null || $src === '' || $cat === null || $cap === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $l[] = ['src' => $src, 'cat' => $cat, 'cap' => $cap];
                }
                $val = $l; $keep = true;
                break;
            }

            case 'letters': {
                $a = cfg_arr($v, 200);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $d  = cfg_date($it['date'] ?? '', false);
                    $t  = cfg_s($it['title'] ?? '', 40);
                    $b  = cfg_s($it['body'] ?? '', 2000);
                    $sg = cfg_s($it['sign'] ?? '', 20);
                    if ($d === null || $t === null || $t === '' || $b === null || $b === '' || $sg === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $l[] = ['date' => $d, 'title' => $t, 'body' => $b, 'sign' => $sg];
                }
                $val = $l; $keep = true;
                break;
            }

            case 'wishes': {
                $a = cfg_arr($v, 100);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $t = cfg_s($it['title'] ?? '', 30);
                    $x = cfg_s($it['text'] ?? '', 200);
                    if ($t === null || $t === '' || $x === null) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $l[] = ['title' => $t, 'text' => $x];
                }
                $val = $l; $keep = true;
                break;
            }

            case 'quiz':
            case 'compatQuiz': {
                $a = cfg_arr($v, 300);
                if ($a === null) break;
                $l = [];
                foreach ($a as $it) {
                    if (!is_array($it)) { $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue; }
                    $q = cfg_s($it['q'] ?? '', 200);
                    $opts = cfg_optlist($it['opts'] ?? null);
                    if ($q === null || $q === '' || $opts === null || count($opts) < 2) {
                        $skipped[$k] = ($skipped[$k] ?? 0) + 1; continue;
                    }
                    $row = ['q' => $q, 'opts' => $opts];
                    if ($k === 'quiz') {
                        /* 与 normalize_quiz 同一口径：非标量的 a 按 0 处理，
                           绝不让 (int)数组 === 1 的隐式转换改写正确答案 */
                        $rawA = $it['a'] ?? 0;
                        $ai = is_scalar($rawA) ? (int)$rawA : 0;
                        $row['a'] = ($ai >= 0 && $ai < count($opts)) ? $ai : 0;
                    }
                    $l[] = $row;
                }
                $val = $l; $keep = true;
                break;
            }

            default:
                break;
        }

        if ($keep) $out[$k] = $val;
        else $rejected[] = $k;
    }
    return $out;
}
