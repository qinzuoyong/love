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

/* 跨站请求一律拒（只判 POST；GET 是页面探测状态用的，无副作用）。
   这个入口不用登录就能打到，而它会 **消耗失败计数**（按 IP 计，10 次锁 10 分钟，
   手机运营商 NAT 下连带同出口的人）与 **清掉解锁状态**（action=lock）——
   任何第三方页面用最简单的表单 POST（simple request，不触发预检）就能驱动它，
   中招的是访客自己的出口 IP（F-S1-03）。 */
if (!love_origin_ok()) {
    love_json(['ok' => false, 'error' => '这个请求不是从本站页面发出的，已拒绝（跨站请求不能操作解锁状态）'], 403);
}

if ($action === 'lock') {
    love_gate_clear();
    love_json(['ok' => true, 'unlocked' => false]);
}

if ($action !== 'unlock') love_json(['ok' => false, 'error' => '未知操作'], 400);

/* 没配密码：直接视为已解锁（纯静态降级时前端也走本地比对） */
if (!love_gate_required()) {
    love_json(['ok' => true, 'required' => false, 'unlocked' => true]);
}

/* 门禁开着但口令不可得（config.json 损坏 / 口令写着纯空白 / 写成了数组）：
   此时谁都无法解锁 —— 这是**故障**，不是密码问题。必须在这里拦掉并如实说明，
   否则用户看到的是"密码不对"，还会白扣失败次数（10 次锁 10 分钟，两个人一起进不来），
   而真正该做的只是去修 data/config.json。 */
if (love_gate_unusable()) {
    love_json(['ok' => false, 'error' => '服务器数据文件异常：读不到可用的解锁口令（data/config.json 可能损坏，或口令字段是空白/非文本/超过 40 个字符 —— 上限按解锁页输入框能输入的字符数算，一个 emoji 记 2 个字符），请先修复该文件'], 500);
}

/* 密钥无法落盘（data/ 不可写）时不能继续：否则下发的 Cookie 下一次请求就
   失效，表现为「解锁成功却一直被弹回」，而页面只会提示"密码不对"。
   这里明确报服务器故障，让用户能直接定位到目录权限问题。 */
if (!love_gate_storage_ready()) {
    love_json(['ok' => false, 'error' => '服务器无法保存解锁状态（data/ 目录不可写，请检查主机权限）'], 500);
}

$left = love_gate_locked_for();
/* -1 = security.json 损坏：**fail-closed**。绝不能把损坏当成"没锁过"放行 ——
   那样"10 次锁 10 分钟"这条防爆破保护就永久静默失效（第七轮 S2 待证 1）。
   如实报故障、请站主修文件，口径与本接口对 config.json 损坏的处理一致
   （宁可说故障，也绝不把故障伪装成"密码不对"或"没锁定"）。 */
if ($left < 0) {
    love_json(['ok' => false, 'error' => '服务器安全计数文件损坏（data/security.json 内容不是合法的计数对象），暂时无法校验解锁。请先修复或删除该文件后重试'], 500);
}
if ($left > 0) {
    love_json(['ok' => false, 'error' => '尝试太多次了，请 ' . (int)ceil($left / 60) . ' 分钟后再试', 'retryAfter' => $left], 429);
}

/* 提交口令先「去首尾空白」再比对 —— 与 love_gate_password() 完全同一口径
   （那边读配置时也会 trim）。此前服务端对用户输入一个字都不动，于是手机键盘
   自动补的空格、从别处复制粘贴带上的空格、中文输入法打出的全角数字，都会让
   "看着输对了"的人永远被拒，而且提示只有"密码不对"，根本无从自查
   （实测：同一串口令仅多一个尾空格即 401）。 */
$pw = trim(u_str($in['password'] ?? ''));
/* 空口令不是「一次失败尝试」：旧实现照样 love_gate_fail()，于是任何第三方页面只要
   POST 一个 body 解不出 JSON 的请求（连预检都不用）就能白烧一次失败计数 ——
   10 次就把访客 IP 锁 10 分钟（F-S1-03）。这里明确回 400，且不计数。 */
if ($pw === '') {
    love_json(['ok' => false, 'error' => '请先填写解锁口令（没有提交口令不算一次失败尝试）', 'unlocked' => false], 400);
}
if (hash_equals(love_gate_password(), $pw)) {
    love_gate_reset();
    if (!love_gate_set()) {
        /* 响应头已发出或密钥不可用 → Cookie 实际没下发。此处绝不能报 ok:true，
           否则浏览器没拿到凭据、下一个请求又变回未解锁，用户会遇到
           "解锁成功 → 下一页被弹回"的死循环，而页面只会显示密码不对。 */
        love_json(['ok' => false, 'error' => '服务器无法保存解锁状态，请刷新页面后重试'], 500);
    }
    love_json(['ok' => true, 'required' => true, 'unlocked' => true]);
}

/* 检查写入返回值：计数没能落盘（security.json 损坏 / data 不可写）时不能当成功。
   否则调用方以为"又记了一次"，实际防护完全没生效还一路静默（第七轮 S2 待证 1）。
   文案里如实点出"这次失败没被记上"，让站主能去查 data/。 */
if (!love_gate_fail()) {
    love_json(['ok' => false, 'error' => '密码不对。另外：这次失败没能写入 data/security.json（防爆破计数暂时失效），请检查该文件是否损坏、或 data/ 目录是否可写', 'unlocked' => false], 401);
}
love_json(['ok' => false, 'error' => '密码不对哦，再想想？（注意别带空格、别用全角数字）', 'unlocked' => false], 401);
