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

function content_get(): array {
    $c = love_read(CONTENT_FILE, null);
    if (!is_array($c)) $c = [];
    return [
        'photos'   => is_array($c['photos'] ?? null) ? $c['photos'] : [],
        'letters'  => is_array($c['letters'] ?? null) ? $c['letters'] : [],
        'messages' => is_array($c['messages'] ?? null) ? $c['messages'] : [],
        'capsules' => is_array($c['capsules'] ?? null) ? $c['capsules'] : [],
    ];
}

function content_save(array $c): bool {
    return love_write(CONTENT_FILE, $c);
}

/** 对外视图：剥离 deviceId（删除凭据），按当前访客补上 mine
    时间胶囊额外做"到期才可读"：未到期只回开启日期与倒计时，
    标题与正文一律不下发（连管理员接口另说，见 admin/api.php）。 */
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
    foreach ((array)($c['capsules'] ?? []) as $r) {
        if (!is_array($r)) continue;
        $mine = $deviceId !== '' && u_str($r['deviceId'] ?? '') === $deviceId;
        $openAt = u_str($r['openAt'] ?? '');
        $locked = $openAt === '' || $openAt > $today;
        if ($locked) {
            $lockedRec = [
                'uid'      => u_str($r['uid'] ?? ''),
                'openAt'   => $openAt,
                'ts'       => (int)($r['ts'] ?? 0),
                'locked'   => true,
                'daysLeft' => $openAt === '' ? 0 : (int)ceil((strtotime($openAt) - strtotime($today)) / 86400),
                'mine'     => $mine,
            ];
            // 自己写的可以看见标题（方便认领是哪一封），正文仍然锁着
            if ($mine) $lockedRec['title'] = u_str($r['title'] ?? '');
            $capsules[] = $lockedRec;
        } else {
            unset($r['deviceId']);
            $r['locked'] = false;
            $r['mine'] = $mine;
            $capsules[] = $r;
        }
    }
    return [
        'photos'   => $map($c['photos'] ?? []),
        'letters'  => $map($c['letters'] ?? []),
        'messages' => $map($c['messages'] ?? []),
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
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $cap, $deviceId, $bin, $ext, $dir, &$result, &$writtenName) {
        $photos = is_array($c['photos'] ?? null) ? $c['photos'] : [];
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
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $title, $body, $sign, $date, $deviceId, &$result) {
        $list = is_array($c['letters'] ?? null) ? $c['letters'] : [];
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
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $title, $body, $sign, $openAt, $deviceId, &$result) {
        $list = is_array($c['capsules'] ?? null) ? $c['capsules'] : [];
        foreach ($list as $r) {
            if (u_str($r['uid'] ?? '') === $uid) {
                $result = ['ok' => true, 'record' => $r, 'dup' => true];
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
    $out = love_mutate(CONTENT_FILE, function ($c) use ($uid, $name, $text, $deviceId, &$result) {
        $list = is_array($c['messages'] ?? null) ? $c['messages'] : [];
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
    return $result;
}
