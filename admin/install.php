<?php
/* ============================================================
   情侣网站 · 管理员首次安装
   仅当服务器上还没有管理员账号时可用；创建成功后自动关闭。
   同时自检 data/ 目录可写性（PHP 需要能写 JSON 数据文件）。
   ============================================================ */

require __DIR__ . '/../lib/store.php';

$installed = love_admin_exists();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    love_session();
    $in = $_POST;
    if (!love_csrf_ok($in['csrf'] ?? null)) {
        $err = '页面已过期，请刷新后重试';
    } elseif ($installed) {
        $err = '管理员已存在，不能再安装';
    } else {
        $user = trim(u_str($in['username'] ?? ''));
        $pass = u_str($in['password'] ?? '');
        $pass2 = u_str($in['password2'] ?? '');
        if (u_len($user) < 2 || u_len($user) > 20) {
            $err = '用户名 2-20 个字符';
        } elseif (u_len($pass) < 6) {
            $err = '密码至少 6 位';
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
      <p>管理员账号已存在。<br><a href="index.php">→ 前往登录</a></p>
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
    <?php endif; ?>

    <div class="checks">
      <div>服务器写入自检：</div>
      <?php foreach ($checks as $k => $v): ?>
        <div><?php echo htmlspecialchars($k, ENT_QUOTES, 'UTF-8'); ?>：<?php echo $v; ?></div>
      <?php endforeach; ?>
    </div>
  </div>
</body>
</html>
