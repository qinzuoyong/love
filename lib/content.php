<?php
/* ============================================================
   情侣网站 · 访客内容数据层（留言/情书/照片）
   被 api/content.php 与 admin/api.php 共用。
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
    ];
}

function content_save(array $c): bool {
    return love_write(CONTENT_FILE, $c);
}

function clean_id(string $s): string {
    $s = preg_replace('/[^A-Za-z0-9_-]/', '', trim($s));
    return $s !== '' ? u_sub($s, 48) : '';
}

/* ---------- 照片（base64 dataURL → 校验 → 存 uploads/） ---------- */
function photo_add(array $in): array {
    $dataUrl = (string)($in['dataUrl'] ?? '');
    $cap = u_sub(trim((string)($in['cap'] ?? '')), 60);
    $uid = clean_id((string)($in['uid'] ?? 'p' . time()));
    $deviceId = clean_id((string)($in['deviceId'] ?? 'unknown'));
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

    // 去重：同一 uid 已存在则直接返回（本机数据迁移时用）
    $c = content_get();
    foreach ($c['photos'] as $p) {
        if (($p['uid'] ?? '') === $uid) return ['ok' => true, 'record' => $p, 'dup' => true];
    }

    $name = 'u' . date('ymd') . '_' . substr(bin2hex(random_bytes(6)), 0, 12) . '.' . $ext;
    if (@file_put_contents($dir . '/' . $name, $bin) === false) return ['ok' => false, 'error' => '图片保存失败'];
    $rec = [
        'src'      => 'assets/img/uploads/' . $name,
        'cap'      => $cap,
        'uid'      => $uid,
        'deviceId' => $deviceId,
        'ts'       => time(),
    ];
    $c['photos'][] = $rec;
    content_save($c);
    return ['ok' => true, 'record' => $rec];
}

/* ---------- 手写情书 ---------- */
function letter_add(array $in): array {
    $title = u_sub(trim((string)($in['title'] ?? '')), 30);
    $body  = u_sub(trim((string)($in['body'] ?? '')), 2000);
    $sign  = u_sub(trim((string)($in['sign'] ?? '')), 20);
    $date  = preg_replace('/[^0-9-]/', '', (string)($in['date'] ?? date('Y-m-d')));
    $uid = clean_id((string)($in['uid'] ?? 'l' . time()));
    $deviceId = clean_id((string)($in['deviceId'] ?? 'unknown'));
    if ($title === '' || $body === '') return ['ok' => false, 'error' => '标题和内容不能为空'];
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    $c = content_get();
    foreach ($c['letters'] as $r) {
        if (($r['uid'] ?? '') === $uid) return ['ok' => true, 'record' => $r, 'dup' => true];
    }
    $rec = [
        'date' => $date, 'title' => $title, 'body' => $body, 'sign' => $sign,
        'uid' => $uid, 'deviceId' => $deviceId, 'ts' => time(),
    ];
    $c['letters'][] = $rec;
    content_save($c);
    return ['ok' => true, 'record' => $rec];
}

/* ---------- 留言 ---------- */
function message_add(array $in): array {
    $name = u_sub(trim((string)($in['name'] ?? '')), 10);
    $name = $name === '' ? '匿名' : $name;
    $text = u_sub(trim((string)($in['text'] ?? '')), 100);
    $uid = clean_id((string)($in['uid'] ?? 'm' . time()));
    $deviceId = clean_id((string)($in['deviceId'] ?? 'unknown'));
    if ($text === '') return ['ok' => false, 'error' => '写点什么再发送吧'];
    if ($uid === '' || $deviceId === '') return ['ok' => false, 'error' => '参数错误'];

    $c = content_get();
    foreach ($c['messages'] as $r) {
        if (($r['uid'] ?? '') === $uid) return ['ok' => true, 'record' => $r, 'dup' => true];
    }
    $rec = ['name' => $name, 'text' => $text, 'ts' => time(), 'uid' => $uid, 'deviceId' => $deviceId];
    $c['messages'][] = $rec;
    content_save($c);
    return ['ok' => true, 'record' => $rec];
}
