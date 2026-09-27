<?php
/* ============================================================
   情侣网站 · 管理员首次安装
   仅当服务器上还没有管理员账号时可用；创建成功后自动关闭。
   同时自检 data/ 目录可写性（PHP 需要能写 JSON 数据文件）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';

$installed = love_admin_exists();
/* admin.json **存在但结构不合法**时（手改过、磁盘写满留下半截、"更新作者(id)"那类历史脏数据
   写进去的数组型哈希），love_admin_exists() 会回答"没装" —— 而它是 $installed 的唯一来源。
   照它的话把建号表单交给匿名访问者，等于把站点交给第一个扫到 install.php 的人：
   他能改配置、能下含 pass_hash 的备份，而真正的主人此刻连登录都进不去（love_logged_in()
   与 love_admin_exists() 同口径，也判 false）。所以"文件在"就不再按"没装"处理。 */
$broken = !$installed && is_file(love_data_dir() . '/admin.json');
$installed = $installed || $broken;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    love_session();
    $in = $_POST;
    if (!love_csrf_ok($in['csrf'] ?? null)) {
        $err = '页面已过期，请刷新后重试';
    } elseif ($broken) {
        $err = 'data/admin.json 已存在但内容不完整或不合法，不能安装。请修正该文件，或删除它后重新运行本页';
    } elseif ($installed) {
        $err = '管理员已存在，不能再安装';
    } else {
        $user = trim(u_str($in['username'] ?? ''));
        $pass = u_str($in['password'] ?? '');
        $pass2 = u_str($in['password2'] ?? '');
        /* 用户名必须"浏览器表达得出来"。u_len() 只数长度、不看字节内容，
           旧实现因此放行两类永远用不了的用户名（第七轮 S4-08）：
             ① 无效 UTF-8 字节（如 a\xFFb）：love_mutate() 里 json_encode() 返回
                false → 整次写入失败 → 页面报"写入失败：data/ 目录不可写"，
                而同一页的自检正显示"✅ 可写"（误导诊断，且会在 data/ 里留下一个
                0 字节的 admin.json —— 之后 install.php 会一直判"文件存在但结构
                不合法，不能安装"，站主不手删文件就再也装不上）；
             ② NUL / 其它控制字符（如 ab\x00cd）：json_encode 转义后**写入成功**，
                此后登录必须提交完全相同的字符串，而浏览器输入框根本产生不了 NUL
                —— 等于自锁（密码那一格早就挡了 NUL，用户名这一格漏了同一类问题）。
           判据用 preg_match('//u') 校 UTF-8（无 mbstring 也可靠），控制字符单独看
           （NUL 不能写进正则字符类，PCRE 会报 "Null byte in regex"）。 */
        if (u_len($user) < 2 || u_len($user) > 20) {
            $err = '用户名 2-20 个字符';
        } elseif (preg_match('//u', $user) !== 1
                  || strpos($user, "\0") !== false
                  || preg_match('/[\x01-\x1F\x7F]/', $user) === 1) {
            $err = '用户名只能包含普通的文字/字母数字（不能是乱码字节，也不能含空字符等控制字符）';
        } elseif (u_len($pass) < 6) {
            $err = '密码至少 6 位';
        } elseif (u_len($pass) > 64) {
            /* 与登录框（admin/index.php 的 #lgPass maxlength="64"）、
               change_password 同尺：超过 64 字符的口令在登录界面根本输不进去
               —— 建号当天就把自己锁在门外（第七轮 S4-01 同族）。 */
            $err = '密码最多 64 位（登录框也就能输入 64 个字符）';
        } elseif (strpos($pass, "\0") !== false) {
            /* bcrypt 不接受 NUL 字节：password_hash() 在 PHP 8 抛 ValueError
               （未捕获 → 500 空响应体）。未安装状态下任何人都能 POST 到这一行，
               所以和 admin/api.php 的 change_password 采用同一道闸。 */
            $err = '密码不能包含空字符';
        } elseif ($pass !== $pass2) {
            $err = '两次输入的密码不一致';
        } else {
            /* 加锁写入 + 锁内二次判定：两个并发请求可能同时通过上面的 $installed
               检查（它是本次请求开头算出来的），旧实现的"无条件写"会让后写者
               静默覆盖先写者 —— 别人用另一个密码就把刚建好的账号顶掉，双方都不知情。 */
            $raceErr = null;
            $written = love_mutate('admin.json', function ($cur) use ($user, $pass, &$raceErr) {
                /* 与 lib/store.php 的 love_admin_exists() 同一口径：两个键都是
                   非空字符串才算"已安装"——数组型的脏数据不算，避免
                   "存在性判断说没装、锁内判定说已存在"的口径分叉。 */
                if (is_array($cur)
                    && is_string($cur['username'] ?? null) && $cur['username'] !== ''
                    && is_string($cur['pass_hash'] ?? null) && $cur['pass_hash'] !== '') {
                    $raceErr = '管理员已存在，不能再安装';
                    return $cur;
                }
                return [
                    'username' => $user,
                    'pass_hash' => password_hash($pass, PASSWORD_DEFAULT),
                    'created' => time(),
                ];
            }, []);
            if ($raceErr !== null) {
                $err = $raceErr;
            } elseif (!is_array($written)) {
                $err = '写入失败：data/ 目录不可写（见下方自检结果）';
            } else {
                love_session_login($user);        // 换新 Session ID，防会话固定
                header('Location: index.php');
                exit;
            }
        }
    }
}

love_session();
$csrf = love_csrf();

/* 自检：data/ 与 uploads/ 是否可写 */
function probe_write(string $dir): string {
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return '❌ 目录不存在且无法创建';
    if (!is_writable($dir)) return '❌ 不可写（请在主机控制面板把权限设为 755/可写）';
    $f = $dir . '/.probe_' . getmypid();
    if (@file_put_contents($f, 'ok') === false) return '❌ 无法写入测试文件';
    @unlink($f);
    return '✅ 可写';
}
$checks = [
    'data/（配置与数据）'  => probe_write(love_data_dir()),
    'assets/img/uploads/（照片）' => probe_write(love_uploads_dir()),
    'mbstring（中文截断）' => function_exists('mb_substr') || function_exists('iconv')
        ? '✅ 已安装'
        : '⚠️ 未安装（会退回按字节截断，建议开启 mbstring 或 iconv）',
];
/* 建目录时顺手落保护文件：不依赖 tools/deploy.py 也能挡住 /data/ 直接下载 */
love_protect_data_dir(love_data_dir());
love_protect_uploads_dir(love_uploads_dir());
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<?php love_emit_https_upgrade(); ?>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>管理员安装 · 情侣网站</title>
  <style>
    body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #fdf2f6; color: #5a3b47; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 8px 30px rgba(240,98,146,.18); padding: 32px; width: 100%; max-width: 420px; }
    h1 { font-size: 20px; margin: 0 0 6px; color: #d6457e; }
    .sub { font-size: 13px; color: #9a7b8a; margin-bottom: 20px; }
    label { display: block; font-size: 13px; margin: 14px 0 6px; color: #7a5a6b; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #f0c9d8; border-radius: 10px; font-size: 14px; outline: none; }
    input:focus { border-color: #e88fb2; }
    button { width: 100%; margin-top: 18px; padding: 11px; background: #f06292; color: #fff; border: 0; border-radius: 10px; font-size: 15px; cursor: pointer; }
    button:hover { background: #d6457e; }
    .err { background: #ffe9ef; color: #c2365f; padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-top: 14px; }
    .checks { margin-top: 20px; font-size: 13px; color: #7a5a6b; border-top: 1px dashed #f0c9d8; padding-top: 12px; }
    .checks div { margin: 4px 0; }
    a { color: #d6457e; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 管理员安装</h1>
    <p class="sub">首次访问才会出现。创建管理员账号后，即可在后台修改网站的全部配置与数据。</p>

    <?php if (!empty($err)): ?><div class="err"><?php echo htmlspecialchars($err, ENT_QUOTES, 'UTF-8'); ?></div><?php endif; ?>

    <?php if ($installed): ?>
      <?php if ($broken): ?>
        <p>⚠️ data/admin.json 已存在但内容不完整或不合法。<br>请修正该文件（需要 username 与 pass_hash 两个非空字符串，pass_hash 可用后台备份里的原值），或删除它后重新运行本页。</p>
      <?php else: ?>
        <p>管理员账号已存在。<br><a href="index.php">→ 前往登录</a></p>
      <?php endif; ?>
    <?php else: ?>
      <form method="post" autocomplete="off">
        <input type="hidden" name="csrf" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES, 'UTF-8'); ?>">
        <label>管理员用户名（2-20 个字符）</label>
        <input name="username" maxlength="20" required>
        <label>密码（至少 6 位）</label>
        <input type="password" name="password" maxlength="64" required>
        <label>再次输入密码</label>
        <input type="password" name="password2" maxlength="64" required>
        <button type="submit">创建管理员账号</button>
      </form>
      <div class="checks">
        <div>服务器写入自检：</div>
        <?php foreach ($checks as $k => $v): ?>
          <div><?php echo htmlspecialchars($k, ENT_QUOTES, 'UTF-8'); ?>：<?php echo $v; ?></div>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</body>
</html>
