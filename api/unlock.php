<?php
/* ============================================================
   情侣网站 · 解锁接口（服务端校验密码）
   ------------------------------------------------------------
   - GET              → {ok, required, ok: 是否已解锁}
   - POST {unlock,password} → 校验成功下发 HttpOnly Cookie，失败计数/锁定
   - POST {lock}      → 清除解锁状态
   说明：密码只存在于服务器 data/config.json，绝不下发给前端。
   ============================================================ */

require __DIR__ . '/../lib/store.php';
require __DIR__ . '/../lib/access.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    love_json(['ok' => true, 'required' => love_gate_required(), 'unlocked' => love_gate_ok()]);
}

$in = love_body();
$action = u_str($in['action'] ?? 'unlock');

if ($action === 'lock') {
    love_gate_clear();
    love_json(['ok' => true, 'unlocked' => false]);
}

if ($action !== 'unlock') love_json(['ok' => false, 'error' => '未知操作'], 400);

/* 没配密码：直接视为已解锁（纯静态降级时前端也走本地比对） */
if (!love_gate_required()) {
    love_json(['ok' => true, 'required' => false, 'unlocked' => true]);
}

/* 密钥无法落盘（data/ 不可写）时不能继续：否则下发的 Cookie 下一次请求就
   失效，表现为「解锁成功却一直被弹回」，而页面只会提示"密码不对"。
   这里明确报服务器故障，让用户能直接定位到目录权限问题。 */
if (!love_gate_storage_ready()) {
    love_json(['ok' => false, 'error' => '服务器无法保存解锁状态（data/ 目录不可写，请检查主机权限）'], 500);
}

$left = love_gate_locked_for();
if ($left > 0) {
    love_json(['ok' => false, 'error' => '尝试太多次了，请 ' . (int)ceil($left / 60) . ' 分钟后再试', 'retryAfter' => $left], 429);
}

/* 提交口令先「去首尾空白」再比对 —— 与 love_gate_password() 完全同一口径
   （那边读配置时也会 trim）。此前服务端对用户输入一个字都不动，于是手机键盘
   自动补的空格、从别处复制粘贴带上的空格、中文输入法打出的全角数字，都会让
   "看着输对了"的人永远被拒，而且提示只有"密码不对"，根本无从自查
   （实测：同一串口令仅多一个尾空格即 401）。 */
$pw = trim(u_str($in['password'] ?? ''));
if ($pw !== '' && hash_equals(love_gate_password(), $pw)) {
    love_gate_reset();
    if (!love_gate_set()) {
        /* 响应头已发出或密钥不可用 → Cookie 实际没下发。此处绝不能报 ok:true，
           否则浏览器没拿到凭据、下一个请求又变回未解锁，用户会遇到
           "解锁成功 → 下一页被弹回"的死循环，而页面只会显示密码不对。 */
        love_json(['ok' => false, 'error' => '服务器无法保存解锁状态，请刷新页面后重试'], 500);
    }
    love_json(['ok' => true, 'required' => true, 'unlocked' => true]);
}

love_gate_fail();
love_json(['ok' => false, 'error' => '密码不对哦，再想想？（注意别带空格、别用全角数字）', 'unlocked' => false], 401);
