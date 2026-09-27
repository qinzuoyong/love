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

/** 后台「保存全部修改」要落盘的那一份：把提交上来的整份配置净化成最终结果。
    为什么单独成函数：① `admin/api.php` 的 save_config 用它；
    ② F-S2-03 的真并发夹具要**直接调用同一份实现**来验"读-改-写是否在同一把锁内" ——
       夹具复刻一遍逻辑就等于没测到被测代码。
    语义保持原样：整体替换（未提交的键会消失），唯一例外是 `password`：
    缺键时沿用 `$cur`（当前盘上那份）的值 —— 前端粘一份不含 password 的配置时
    不能把已设的解锁口令删掉（那会让门禁静默失效，历史事故）。
    **调用方必须把"读 $cur → 调本函数 → 写回"放在同一把 flock 内**（见 save_config）。

    ⚠️ password 的"沿用"必须区分三态，否则**一次普通保存就能把门禁从 fail-closed
    变成全站公开**（第七轮 S1-02）：磁盘上该键是数组/布尔/null/纯空白时，
    `love_gate_required()` 返回 true 而 `love_gate_password()` 是空串 —— 这是
    "谁都进不来"的故障态（fail-closed，正确）；但旧实现一律写成显式空串，
    而空串在这套语义里等于**关闭门禁**，下一次任何人打开页面就会拿到全部私密键
    （情话/相册/情书/时间轴/题库…），保存响应却是干净的 ok:true。
    面板侧还会把这个故障"翻译"成空串一起提交（口令读不出来 → 面板按"没设密码"显示），
    所以服务端不能只看提交里有没有这个键，必须按"磁盘现值能不能用"决定：
       - 磁盘现值可用（非空标量）        → 沿用磁盘现值（提交没给可用口令时）
       - 磁盘上本来就没这个键 / 显式 ""   → 保持"没启用门禁"（既有约定，必须留着：
                                            管理员明确清空口令就是要关掉门禁）
       - 磁盘现值处于故障态              → **原样保留故障值**（故障态保持故障），
                                            并让调用方在 rejected 里看见 password，
                                            面板会提示"该项格式不对已忽略"，不再静默。 */
function cfg_merge_overrides(array $ov, $cur, array &$rejected, array &$skipped): array {
    $hasDiskPw = is_array($cur) && array_key_exists('password', $cur);
    $rawPw = $hasDiskPw ? $cur['password'] : null;
    $diskPw  = (is_scalar($rawPw) && !is_bool($rawPw)) ? trim((string)$rawPw) : '';
    $diskPwOk = $diskPw !== '';                       // 与 love_gate_password() 同口径
    $diskOff  = is_string($rawPw) && $rawPw === '';   // 显式空串 = 关闭门禁
    $diskFault = $hasDiskPw && !$diskPwOk && !$diskOff;

    $out = sanitize_cfg($ov, $rejected, $skipped);
    $out = normalize_quiz($out);              // 双保险（sanitize 已归一 a）
    $faultKept = false;
    if (!array_key_exists('password', $out)) {
        /* 提交里没有可用口令：没这个键 / 被净化丢掉（超长、纯空白、非文本）都算。 */
        if ($diskPwOk)        $out['password'] = $diskPw;
        elseif ($diskFault) { $out['password'] = $rawPw; $faultKept = true; }
        else                  $out['password'] = '';
    } elseif ($diskFault && $out['password'] === '') {
        /* 提交里明确是空串，但磁盘现值处于故障态 → 拒绝改写该键。
           这一格正是面板普通保存的形状（面板读到故障口令时会自己填 ""提交），
           放行就等于"一次改 slogan 的保存把门禁关掉"。 */
        $out['password'] = $rawPw;
        $faultKept = true;
    }
    /* 故障态被保留时必须在响应里能被察觉：同一个键只记一次 —— 上面 sanitize_cfg
       已经可能记过（超长/纯空白的路径），重复条目会让面板显示
       「2 项…password、password」（S1-06 的同族噪声）。 */
    if ($faultKept && !in_array('password', $rejected, true)) $rejected[] = 'password';
    return $out;
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
        /* 只查 d<=31 不够：2-30 / 2-31 / 4-31 / 6-31 / 9-31 / 11-31 这些日期
           在任何一年都不存在，却能被存进配置。前台首页的进度环会拿它当"年周期
           锚点"，算出一个指向不存在日期的百分比，还把它排在首位挡掉其它合法
           纪念日 —— 而同一页的纪念日卡片（走 countdown.js）会说"日期不合法"，
           两边当场打架（第五轮 R5-14）。这里按"该月实际最大天数"挡掉。
           2 月**按 29 天算**：闰日纪念日是真实存在的，countdown.js 会跳到下一个
           闰年，不能在这一层把 2-29 一起拒掉。 */
        static $maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        return ($mo >= 1 && $mo <= 12 && $dy >= 1 && $dy <= $maxDay[$mo - 1]) ? $s : null;
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

/* 选项列表：**与运行层同一把尺** —— 选项数上限 6、空选项一律丢掉。

   运行层 `compat_sanitize_questions()`（api/compat.php 的 create 用它）的判据是
   "每项非空、≤60 字符、**选项数 2..6**"，任一题不合格就 `return null` →
   整份题库作废 → 接口回「参数错误」。而这里旧实现只要求"每项是标量、最多 8 项"，
   不拒空串、也不限上界 6；面板又固定渲染 4 个选项框（留空是常态）。于是：
     - 只填 2 个选项（余下 2 格留空）→ 能存盘、能注入前端 → 开局时运行层一看
       有空串 → 整份判非法 → 「参数错误」，而且**触发是随机的**（那一题被抽进
       10 题样本才失败），同一份配置时好时坏、报错不给根因（第七轮 S2-01）；
     - 手改出 7~8 项 → cfg_arr 保留、面板只显示前 4 个，改别处再保存也清不掉。
   两层只能有一把尺：这里直接归一成运行层愿意接受的最小形态（去空白、去空串、
   最多 6 项）。少于 2 项的题目由调用方按"格式不对"丢弃并记 $skipped
   （题库少一题，而不是整场开局永远打不开）。 */
function cfg_optlist($v): ?array {
    $a = cfg_arr($v, 8);
    if ($a === null) return null;
    $out = [];
    foreach ($a as $o) {
        $s = cfg_s($o, 60);
        if ($s === null) return null;
        $s = trim($s);                 // 与 u_len($os) 的运行层同口径（那里也先 trim 再量）
        if ($s === '') continue;       // 空选项没有意义：存下去就是"存得下、开不了局"
        $out[] = $s;
        if (count($out) >= 6) break;   // 运行层上界 6（compat.php 的 count($oc) > 6）
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
                /* 长度口径必须与解锁页一致：输入框是 maxlength=40（index.html），
                   所以口令最多 40 个字符。旧实现用 cfg_s($v, 40) **静默截断** ——
                   粘 50 个字符进后台，盘上只留前 40，面板却仍显示 50：主人此后拿
                   「自己设的那串」去解锁，永远是 401「密码不对」，连试 10 次还锁 10 分钟
                   （F-S1-02，第三轮「三处口径一致」没收干净的尾巴）。
                   这里改成**明确拒绝该键**（保留磁盘原值）并记进 $rejected，让后台
                   当场报出来 —— 宁可说「没生效、为什么」，也不要静默改写别人的口令。
                   长度用 u_len()（有 mbstring 按字符、没有也按**码点**数，
                   与 cfg_s()/u_sub() 的截断口径同一把尺）：这里只会拒得更多，
                   绝不会放过超过 40 个字符的口令。 */
                if (!is_string($v) && !is_int($v) && !is_float($v)) break;
                /* 上限的**唯一来源**是 lib/store.php 的 LOVE_GATE_MAX_PW（本文件
                   顶部已 require store.php，任何加载本文件的入口都先加载了它）；
                   旧实现写 `defined('LOVE_GATE_MAX_PW') ? LOVE_GATE_MAX_PW : 40`
                   把 40 抄了第二遍，哪天线上值一改就会静默分叉（第七轮 S1 待证 5）。 */
                $maxPw = LOVE_GATE_MAX_PW;
                $raw = (string)$v;
                /* ⚠️ 先 trim **再**量长度：门禁侧量的是 u_len_utf16(trim($pw))
                   （lib/access.php 的 love_gate_unusable），面板保存前的自检也是
                   trim 之后数（admin/index.php 的 Array.from(...trim())）。
                   旧实现唯独这一层量的是**未 trim 的原串**，于是"40 个字符 +
                   一个尾随空格"（粘贴常见形态，面板 maxlength 挡不住粘贴进
                   rawApply 的 JSON）会被判 41 > 40 → 记 rejected 并**丢弃该键**
                   → cfg_merge_overrides 用磁盘旧值兜底 —— 管理员以为设成了新口令，
                   实际生效的还是旧口令，面板输入框里却一直显示那串没生效的新口令，
                   之后拿它去解锁必然 401（第七轮 S1-03，F-S1-02 的同族：看着输对了却进不去）。
                   长度用 u_len_utf16（UTF-16 码元，与解锁页 maxlength 同尺）：
                   u_len 数码点，21 个 emoji 会被判"可用"，而输入框最多敲 20 个
                   （第七轮 S1-04）。 */
                $t = trim($raw);
                /* 超长 → 丢弃该键（保留磁盘原值）。这里**不**自己记 rejected：
                   下面统一由 `if ($keep) ... else $rejected[] = $k;` 记一次 ——
                   旧实现两处都记，面板于是显示「2 项…password、password」（S1-06）。 */
                if (u_len_utf16($t) > $maxPw) break;
                if ($t === '' && $raw !== '') break;    // 纯空白 → 丢弃该键，沿用磁盘现值
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
