<?php
/* ============================================================
   情侣网站 · 访客内容数据层（留言/情书/照片）
   被 api/content.php 与 admin/api.php 共用。
   ------------------------------------------------------------
   安全：deviceId 是"删除自己内容"的凭据，只保存在服务端数据里，
   对外一律剥离，只回传布尔字段 mine（见 content_view）。
   并发：所有写入都走 love_mutate（flock 加锁读改写），避免丢记录。
   ============================================================ */

declare(strict_types=1);

const CONTENT_FILE = 'content.json';
const PHOTO_MAX_BASE64 = 3 * 1024 * 1024;  // 压缩后照片上限

/** 只保留「JSON 数组」形态（连续下标 0..n-1）的值。
    为什么不能只用 is_array()：JSON 里的 `{"a":1}` 解码到 PHP 也是 array，
    而它下发到前端是 `{}` —— 面板那边 `list.length` 是 undefined、紧接着
    `list.slice()` 抛 TypeError，整块面板半渲染（F-S2-04 真机复现抓到的就是这一格：
    `{"capsules":{"not":"a list"}}`）。所以这里要求"列表形态"，不是"是数组"。
    空数组是合法的空列表，要放行。 */
function content_list($v): array {
    if (!is_array($v) || $v === []) return [];
    if (function_exists('array_is_list')) return array_is_list($v) ? $v : [];
    return array_keys($v) === range(0, count($v) - 1) ? $v : [];
}

/** 写入路径取桶：必须是**读路径认得的那种列表**（content_list，同一把尺）。

    为什么写入也要过这一道：JSON 对象解码到 PHP 也是 array，旧写法只判 is_array()，
    于是桶是 `{"a":1}` 时 `$list[] = $rec` 会把新记录挂到键 0 上、回写仍是**对象**，
    而读路径（content_get / content_view）用 content_list 只认列表形态 → 整桶被丢成 []：
    接口回 ok:true + 完整 record，访客却"什么都没发出去、别人的内容全没了"，
    删除路径也找不到那条记录（照片还成了磁盘上不可回收的孤儿）——第七轮 S2-03。
    读侧要求列表是 F-S2-04 的既有修复（对象形态会让面板半渲染），不能放宽，
    所以只能让写侧与它同一口径：先归一成列表，畸形的那份按"读不出来的旧数据"丢弃。

    $repaired 出参：桶存在但不是列表（盘上有读不出来的畸形数据，本次被丢弃重建），
    调用方要把它回报给客户端 —— 旧行为是"报成功、内容永不出现"，一声不响。 */
function content_bucket(array $c, string $kind, bool &$repaired = false): array {
    $raw = $c[$kind] ?? null;
    $repaired = $raw !== null && $raw !== [] && content_list($raw) === [];
    return content_list($raw);
}

function content_get(): array {
    $c = love_read(CONTENT_FILE, null);
    if (!is_array($c)) $c = [];
    return [
        'photos'   => content_list($c['photos'] ?? null),
        'letters'  => content_list($c['letters'] ?? null),
        'messages' => content_list($c['messages'] ?? null),
        'capsules' => content_list($c['capsules'] ?? null),
    ];
}

function content_save(array $c): bool {
    return love_write(CONTENT_FILE, $c);
}

/** 单条时间胶囊的对外视图：**未到期只回"哪天开、还有几天"，正文与签名绝不外发**；
    自己写的可以带标题（方便认领是哪一封），正文仍然锁着。

    为什么必须只留这一份实现：content_view()（每页注入 / action=all）与
    capsule_add() 的 uid 去重分支都要输出"别人可能锁着的那条胶囊"。去重分支
    原先直接回吐原记录 —— 而胶囊 uid 会随每页注入下发，于是撞一次 uid 就能读到
    对方未到期胶囊的 title/body/sign（第四轮 F-S3-01 实测复现）。
    两份实现并存迟早漂移，这里收成一份。 */
function capsule_view(array $r, string $deviceId, string $today): array {
    $mine = $deviceId !== '' && u_str($r['deviceId'] ?? '') === $deviceId;
    $openAt = u_str($r['openAt'] ?? '');
    $locked = $openAt === '' || $openAt > $today;
    if (!$locked) {
        unset($r['deviceId']);
        $r['locked'] = false;
        $r['mine'] = $mine;
        return $r;
    }
    $out = [
        'uid'      => u_str($r['uid'] ?? ''),
        'openAt'   => $openAt,
        'ts'       => (int)($r['ts'] ?? 0),
        'locked'   => true,
        'daysLeft' => $openAt === '' ? 0 : (int)ceil((strtotime($openAt) - strtotime($today)) / 86400),
        'mine'     => $mine,
    ];
    if ($mine) $out['title'] = u_str($r['title'] ?? '');
    return $out;
}

/** 对外视图：剥离 deviceId（删除凭据），按当前访客补上 mine
    时间胶囊额外做"到期才可读"：未到期只回开启日期与倒计时，
    标题与正文一律不下发（连管理员接口另说，见 admin/api.php）。

    四个桶一律先过 content_list()（与 content_get() 同一把尺）：api/config.php 的
    注入路径是**直接读原始文件**的，如果这里按 (array) 硬转，`{"photos":{"a":1}}`
    这种对象形态会被 $map 当成"有记录"逐条下发，而同一份文件走 content_get() 的
    （api/content.php 的 action=all、后台面板）看到的是空桶 —— 同一次刷新里
    两处对同一份数据给出不同答案（S2-03 的另一半）。 */
function content_view(array $c, string $deviceId): array {
    $map = function ($list) use ($deviceId) {
        $out = [];
        foreach ((array)$list as $r) {
            if (!is_array($r)) continue;
            $mine = $deviceId !== '' && u_str($r['deviceId'] ?? '') === $deviceId;
            unset($r['deviceId']);
            $r['mine'] = $mine;
            $out[] = $r;
        }
        return $out;
    };
    $today = date('Y-m-d');
    $capsules = [];
    foreach (content_list($c['capsules'] ?? null) as $r) {
        if (!is_array($r)) continue;
        $capsules[] = capsule_view($r, $deviceId, $today);
    }
    return [
        'photos'   => $map(content_list($c['photos'] ?? null)),
        'letters'  => $map(content_list($c['letters'] ?? null)),
        'messages' => $map(content_list($c['messages'] ?? null)),
        'capsules' => $capsules,
    ];
}

function clean_id(string $s): string {
    $s = preg_replace('/[^A-Za-z0-9_-]/', '', trim($s));
    return $s !== '' ? u_sub($s, 48) : '';
}

/* ---------- 照片（base64 dataURL → 校验 → 存 uploads/） ---------- */
function photo_add(array $in): array {
    $dataUrl = u_str($in['dataUrl'] ?? '');
    $cap = u_sub(trim(u_str($in['cap'] ?? '')), 60);
    $uid = clean_id(u_str($in['uid'] ?? 'p' . time()));
    $deviceId = clean_id(u_str($in['deviceId'] ?? ''));
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    if (strlen($dataUrl) > PHOTO_MAX_BASE64 || strlen($dataUrl) < 100) {
        return ['ok' => false, 'error' => '图片数据无效'];
    }
    if (!preg_match('#^data:image/(jpeg|png|webp|gif);base64,#i', $dataUrl, $m)) {
        return ['ok' => false, 'error' => '仅支持 jpg/png/webp/gif'];
    }
    $bin = base64_decode(substr($dataUrl, strpos($dataUrl, ',') + 1), true);
    if ($bin === false || $bin === '') return ['ok' => false, 'error' => '图片解码失败'];
    $info = @getimagesizefromstring($bin);
    if ($info === false) return ['ok' => false, 'error' => '不是有效的图片'];
    $extMap = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'];
    $ext = $extMap[$info['mime']] ?? '';
    if ($ext === '') return ['ok' => false, 'error' => '不支持的图片类型'];

    $dir = love_uploads_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return ['ok' => false, 'error' => '服务器目录不可写'];
    love_protect_uploads_dir($dir);

    // 去重 + 落库都在同一把锁里完成，避免并发丢记录
    $result = ['ok' => false, 'error' => '服务器繁忙'];
    $writtenName = null;              // 锁内写出的文件名，落库失败时要回收
    $repaired = false;                // 桶是畸形形态、本次被丢弃重建（回报给客户端）
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $cap, $deviceId, $bin, $ext, $dir, &$result, &$writtenName, &$repaired) {
        /* 与读路径同一把尺（content_list）：桶是对象形态时按"空"处理，
           否则新记录挂到对象键上、回写仍是对象，读侧永远看不见（S2-03）。 */
        $photos = content_bucket($c, 'photos', $repaired);
        foreach ($photos as $p) {                       // 同一 uid 已存在 → 直接返回（本机数据迁移去重）
            if (u_str($p['uid'] ?? '') === $uid) {
                $result = ['ok' => true, 'record' => $p, 'dup' => true];
                return $c;
            }
        }
        $name = 'u' . date('ymd') . '_' . substr(bin2hex(random_bytes(6)), 0, 12) . '.' . $ext;
        if (@file_put_contents($dir . '/' . $name, $bin) === false) {
            $result = ['ok' => false, 'error' => '图片保存失败'];
            return $c;
        }
        $writtenName = $name;
        $rec = [
            'src'      => 'assets/img/uploads/' . $name,
            'cap'      => $cap,
            'uid'      => $uid,
            'deviceId' => $deviceId,
            'ts'       => time(),
        ];
        $photos[] = $rec;
        $c['photos'] = $photos;
        $result = ['ok' => true, 'record' => $rec];
        return $c;
    }, []);
    if (!is_array($out)) {
        /* 落库失败（编码/写入异常）时，刚刚写进磁盘的那张图必须删掉：
           否则它会成为一个没有任何记录引用的孤儿文件，相册里看不见、也没人清得掉。 */
        if ($writtenName !== null) @unlink($dir . '/' . $writtenName);
        return ['ok' => false, 'error' => '服务器繁忙'];
    }
    if ($repaired && !empty($result['ok'])) $result['repaired'] = true;   // 让"畸形桶被丢弃重建"可被察觉
    return $result;
}

/* ---------- 手写情书 ---------- */
function letter_add(array $in): array {
    $title = u_sub(trim(u_str($in['title'] ?? '')), 30);
    $body  = u_sub(trim(u_str($in['body'] ?? '')), 2000);
    $sign  = u_sub(trim(u_str($in['sign'] ?? '')), 20);
    $date  = preg_replace('/[^0-9-]/', '', u_str($in['date'] ?? date('Y-m-d')));
    /* 与 capsule_add 口径一致：必须是真实存在的日期。否则前台会拿到无法解析的
       日期串（排序变乱、格式化出 NaN）。缺省/非法一律回退到今天。 */
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $dm) || !checkdate((int)$dm[2], (int)$dm[3], (int)$dm[1])) {
        $date = date('Y-m-d');
    }
    $uid = clean_id(u_str($in['uid'] ?? 'l' . time()));
    $deviceId = clean_id(u_str($in['deviceId'] ?? ''));
    if ($title === '' || $body === '') return ['ok' => false, 'error' => '标题和内容不能为空'];
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    $result = ['ok' => false, 'error' => '服务器繁忙'];
    $repaired = false;
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $title, $body, $sign, $date, $deviceId, &$result, &$repaired) {
        $list = content_bucket($c, 'letters', $repaired);   // 与读路径同一把尺（S2-03）
        foreach ($list as $r) {
            if (u_str($r['uid'] ?? '') === $uid) {
                $result = ['ok' => true, 'record' => $r, 'dup' => true];
                return $c;
            }
        }
        $rec = [
            'date' => $date, 'title' => $title, 'body' => $body, 'sign' => $sign,
            'uid' => $uid, 'deviceId' => $deviceId, 'ts' => time(),
        ];
        $list[] = $rec;
        $c['letters'] = $list;
        $result = ['ok' => true, 'record' => $rec];
        return $c;
    }, []);
    if (!is_array($out)) return ['ok' => false, 'error' => '服务器繁忙'];
    if ($repaired && !empty($result['ok'])) $result['repaired'] = true;
    return $result;
}

/* ---------- 时间胶囊（写给未来的信：到期才能打开） ----------
   与情书的区别：正文在开启日之前**绝不离开服务器**（content_view 会剥掉），
   所以刷新、看源码、抓接口都看不到，必须等到那天。 */
function capsule_add(array $in): array {
    $title  = u_sub(trim(u_str($in['title'] ?? '')), 30);
    $body   = u_sub(trim(u_str($in['body'] ?? '')), 2000);
    $sign   = u_sub(trim(u_str($in['sign'] ?? '')), 20);
    $openAt = preg_replace('/[^0-9-]/', '', u_str($in['openAt'] ?? ''));
    $uid = clean_id(u_str($in['uid'] ?? 'c' . time()));
    $deviceId = clean_id(u_str($in['deviceId'] ?? ''));
    if ($title === '' || $body === '') return ['ok' => false, 'error' => '标题和内容不能为空'];
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $openAt, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
        return ['ok' => false, 'error' => '开启日期格式不对'];
    }
    if ($openAt < date('Y-m-d')) return ['ok' => false, 'error' => '开启日期不能早于今天'];

    $result = ['ok' => false, 'error' => '服务器繁忙'];
    $repaired = false;
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $title, $body, $sign, $openAt, $deviceId, &$result, &$repaired) {
        $list = content_bucket($c, 'capsules', $repaired);   // 与读路径同一把尺（S2-03）
        foreach ($list as $r) {
            if (u_str($r['uid'] ?? '') === $uid) {
                /* 去重分支返回的是**已存在的那条**（"本机数据迁移"用）。它可能是
                   别人未到期的胶囊，而胶囊 uid 会随每页注入下发 —— 直接回吐原记录
                   等于把锁着的正文交出去（第四轮 F-S3-01：换一台设备撞一次 uid 就读到了）。
                   所以这里必须走与 content_view 同一套视图函数。 */
                $result = ['ok' => true, 'record' => capsule_view($r, $deviceId, date('Y-m-d')), 'dup' => true];
                return $c;
            }
        }
        $rec = [
            'title' => $title, 'body' => $body, 'sign' => $sign, 'openAt' => $openAt,
            'uid' => $uid, 'deviceId' => $deviceId, 'ts' => time(),
        ];
        $list[] = $rec;
        $c['capsules'] = $list;
        $result = ['ok' => true, 'record' => $rec];
        return $c;
    }, []);
    if (!is_array($out)) return ['ok' => false, 'error' => '服务器繁忙'];
    if ($repaired && !empty($result['ok'])) $result['repaired'] = true;
    return $result;
}

/* ---------- 留言 ---------- */
function message_add(array $in): array {
    $name = u_sub(trim(u_str($in['name'] ?? '')), 10);
    $name = $name === '' ? '匿名' : $name;
    $text = u_sub(trim(u_str($in['text'] ?? '')), 100);
    $uid = clean_id(u_str($in['uid'] ?? 'm' . time()));
    $deviceId = clean_id(u_str($in['deviceId'] ?? ''));
    if ($text === '') return ['ok' => false, 'error' => '写点什么再发送吧'];
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    $result = ['ok' => false, 'error' => '服务器繁忙'];
    $repaired = false;
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $name, $text, $deviceId, &$result, &$repaired) {
        $list = content_bucket($c, 'messages', $repaired);   // 与读路径同一把尺（S2-03）
        foreach ($list as $r) {
            if (u_str($r['uid'] ?? '') === $uid) {
                $result = ['ok' => true, 'record' => $r, 'dup' => true];
                return $c;
            }
        }
        $rec = ['name' => $name, 'text' => $text, 'ts' => time(), 'uid' => $uid, 'deviceId' => $deviceId];
        $list[] = $rec;
        $c['messages'] = $list;
        $result = ['ok' => true, 'record' => $rec];
        return $c;
    }, []);
    if (!is_array($out)) return ['ok' => false, 'error' => '服务器繁忙'];
    if ($repaired && !empty($result['ok'])) $result['repaired'] = true;
    return $result;
}
