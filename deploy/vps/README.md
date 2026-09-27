# 自有 VPS 部署（Ubuntu + Nginx + PHP-FPM）

本目录是**自有云主机部署路径**的权威配置与运维说明。它和 `deploy/nginx.conf` 的分工是：

| 文件 | 定位 |
|---|---|
| `deploy/nginx.conf` | 通用示例，给人手动粘贴到宝塔/任意 Nginx 主机 |
| `deploy/.htaccess` | Apache / 虚拟主机路径 |
| `deploy/vps/nginx.conf.template` | **自有 VPS 的权威配置**，由 `tools/vps_setup.py` 渲染占位符后整份安装 |

之所以要有一份"权威配置"：2026-09-15 体检发现服务器上那份是手写的，和项目模板漂移了，
漏掉了 `add_header` 不继承导致的**安全头全部丢失**（HTML 页上 `X-Robots-Tag` 等 4 个头一个都没有，
等于对搜索引擎完全敞开）。纳入版本控制 + 用脚本安装，就不会再漂。

---

## 一、前提条件

目标机需要满足这些（`vps_setup.py` 会先跑一遍预检，**它检到的那几条**不满足会
**在改动任何东西之前**中止；标了「脚本不检」的必须自己确认）：

- Ubuntu 22.04（或同类 Debian 系）+ PHP **7.3+**（实测 8.1）——
  ⚠️ **脚本不检这两项**：它只把发行版名打印出来（`/etc/os-release` 的 `PRETTY_NAME`），
  并看「哪个 `php*-fpm` unit 在跑」，既不比对版本号、也不取 `php -v`。
  所以 PHP 7.2 或非 Debian 系的主机同样会"预检全绿"，版本下限请自行确认。
- 已装 **nginx**（脚本会预检：`nginx -v` 探不到就中止）与
  **php-fpm**（脚本会预检：没有正在运行的 `php*-fpm` 就中止；
  另要求能探测到可用的 FPM socket，否则要显式给 `--php-sock`）
- 该用户可**免密 sudo**（脚本会预检：`sudo -n` 不通就中止，不会弹密码提示）
- 已用 certbot 配好证书：`/etc/letsencrypt/live/<域名>/fullchain.pem`（脚本会预检）
- 目标机上存在用户名 `www-data`（脚本会预检：没有这个用户就中止）
- 本机 `~/.ssh/config` 里有能免密登录到这台机器的 Host 别名（脚本不检，连不上时会在第一步报错）
- 域名已解析到这台机器（脚本不检；它只把域名渲染进 `server_name` 与
  `ssl_certificate` 指向的 `/etc/letsencrypt/live/<域名>/fullchain.pem`）

> 内存提示：1 GiB 起步的入门机型跑 nginx + PHP-FPM 足够；
> 如果之后要在同一台机器上加 Node 服务，要留意余量。

---

## 二、三段命令

### 1. 初始化（一次，可重复跑）

```bash
python tools/vps_setup.py --creds "<凭据文件>" --ssh-host "<连接别名>"
```

做四件事：预检 → 渲染并安装 Nginx 配置（**装前备份、`nginx -t` 兜底、失败自动回滚**）→
建站点目录并授权 `www-data` → 确认 `sites-enabled` 软链。

可选参数：`--dry-run`（只打印渲染结果与计划，不连服务器、不改本地任何文件）、
`--conf-only`、`--dirs-only`、`--php-sock`（显式指定 FPM socket）。

> ⚠️ **`--ssh-host` 是必需的**，因为凭据文件里没有这一项：脚本从凭据文件读的是
> 「域名 / 网站根 / 站点名」，而 SSH 连接别名属于**本机** `~/.ssh/config`（或环境变量
> `LOVE_VPS_SSH`）。想少打这个参数，就在凭据文件里补一行 `SSH 别名：<名字>`。
> 缺参数时脚本会直接中止并列出缺哪几样，不会半途改服务器。

> 🪤 **`--root` / `--php-sock` 在 Git Bash 里别用命令行传**：MSYS 会把 "/开头" 的参数
> **和环境变量**都改写成 Windows 路径（实测 `/var/www/love/dist` 到手会变成
> `<Git 安装目录>/var/www/love/dist`），而这种错误 `nginx -t` 与 sha256 回读
> **都发现不了** —— 脚本会报"配置已生效"，站点却指向一个不存在的目录。
> 现在脚本会直接拦下这类值并中止。可靠传法：写进凭据文件（推荐）、用 PowerShell 跑，
> 或在 Git Bash 里先 `export MSYS2_ARG_CONV_EXCL='*'`（这条只对命令参数有效，
> 管不了环境变量）。

回滚：

```bash
ls -1 /etc/nginx/sites-available/love.bak.*          # 挑一个带时间戳的备份
sudo cp -a <备份> /etc/nginx/sites-available/love
sudo nginx -t && sudo systemctl reload nginx
```

### 2. 部署

```bash
python tools/deploy_vps.py --creds "<凭据文件>" --ssh-host "<连接别名>" --with-media  # 首次（含背景音乐）
python tools/deploy_vps.py --creds "<凭据文件>" --ssh-host "<连接别名>"              # 之后每次更新
```

- `--with-media` 只在**首次铺服务器**时需要（带上 `assets/music/music.dat`）；
  平时它和其他受保护内容一样被跳过。**它会覆盖服务器上现有的那份音乐** ——
  后来单独换过歌的话就别再加这个参数（脚本每次都会把这句提醒打出来）。
- `--dry-run` 只列出将同步的文件清单，不连服务器，**也不会替你重建 `dist/`**
  （要刷新产物先跑 `python tools/build.py`）。
- `--no-build` 跳过构建，直接用现有 `dist/`。

### 3. 验收（只读）

```bash
python tools/verify_vps.py --creds "<凭据文件>"              # 两阶段都跑
python tools/verify_vps.py --creds "<凭据文件>" --phase infra  # 只验基础设施
```

`infra` 阶段在**还没部署站点内容时就该全绿**；`site` 阶段在部署之后才全绿。
脚本只发 GET、不做任何写操作，也**绝不调用解锁口令路径**（那会消耗失败计数，
累计到上限会把两个人一起锁在门外——见 `tools/README.md` 的「线上探针铁律」）。

---

## 三、传输方式为什么不是 rsync

本机 Git Bash **没有 rsync**（cwRsync 未装、WSL 服务不可用），服务器有。所以走：

```
本地打 tar.gz → scp 到服务器 /tmp → 服务器侧 rsync 解到站点目录 → 清理临时目录
```

这么做的额外好处：解压和同步都在服务器的临时目录里完成，**上传中途断了也不会碰到线上目录**。

同步时使用 `rsync -a --checksum --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r --chown=www-data:www-data`，
并且**绝对不加 `--delete`**：

- `--checksum` 按内容判断是否需要传。`build.py` 每次重建 `dist/`，mtime 全是构建时刻，
  靠 mtime 比会每次都全量重传。
- 不加 `--delete` 让「只增不删」成为一个**显式**声明，而不是 tar 覆盖的隐式行为，好审计。
- `--chmod` 把落地权限**钉死**成 目录 755 / 文件 644。不写它的话权限取决于远端 umask：
  本机（Windows）用 Python `tarfile` 打包时成员权限位只能是 `0666`，远端解包 umask 实测是
  `0002`，于是文件是 `0664` 且被 `rsync -a`（含 `-p`）原样搬进站点根 —— 结果是 web 目录里
  所有程序文件对 `www-data` **组可写**：接口一旦被攻破，攻击者可以直接改写站点自身的
  PHP 文件做持久化；换一台 umask `000` 的机器还会变成全局可写。

同步完成前还有一道**逐字节回读**：本地生成 sha256 清单 → 一起 scp 到 `/tmp` →
在站点根里跑 `sha256sum -c`，**全部匹配才算部署成功**（不匹配会打出对不上的文件名并中止）。
为什么必须有：链路是「打包 → scp → 服务器侧 rsync」，任何一环出问题（打包少文件、
rsync 被 exclude 规则静默跳过、传输截断）都不会自己报错，`--stats` 里的"N files transferred"
只说明 rsync 认为该传几个，说明不了内容对不对。这条是从 FTP 路径那边学来的：
当时正是靠 SHA 回读才发现有文件被漏推。

### 只增不删的保护清单

保护清单直接复用 `tools/deploy.py` 的常量与 `is_protected()`，两条部署路径共用同一份定义：

- `data/**` —— 管理员后台的全部自定义数据
- `assets/img/uploads/**` —— 上传的照片
- `assets/img/*.jpg|jpeg|png|webp|gif` —— 直接放进服务器的真实照片
- `assets/music/music.dat` —— 背景音乐（要传得显式加 `--with-media`）

> **VPS 版不部署 Apache 的 `.htaccess` 模板**（`deploy/*-htaccess`）。nginx 根本不读它们，
> 敏感目录保护由 `nginx.conf.template` 里的 `deny` 规则承担；`data/` 与 `uploads/` 下的
> `.htaccess` 由 `lib/store.php` 在运行时自己写。所以看到服务器上少了那几个文件是正常的。

部署后**不需要** reload php-fpm：PHP 的 `opcache.validate_timestamps=On` 会自动感知变更。

---

## 四、这份配置修了哪些坑

改配置前请先读这一节。每一条都是实测出来的，不是理论推导。

### 1. `add_header` 不继承 —— 安全头静默消失

nginx 的 `add_header` **不会**从上层继承：某个 `location` 里一旦出现任何 `add_header`，
server 级的那几个安全头在这类响应上就全部消失。

`/assets/*` 和 `*.html` 两个 `location` 各自写了缓存头，所以它们必须**把 5 个安全头重复一遍**。
漏写时实测现象：`/` 与 `/index.html` 的响应里 `X-Robots-Tag`、`X-Content-Type-Options`、
`X-Frame-Options`、`Referrer-Policy`、HSTS **一个都没有**。

⚠️ **改这些地方时要三处一起改**（两个 location + server 级），否则会静默不同步。
`tools/verify_vps.py --phase infra` 会逐个 URL 检查这 5 个头，改完跑一遍。

### 2. ⚠️ `error_page 404 =404;`（不带 URI）是个陷阱

**千万不要写这种形式。** 2026-09-15 在本机实测：它不是"保持原状态码"，
nginx 会把 `=404` 当成跳转目标 URI，于是缺失的文件返回的是

```
HTTP/1.1 302 Moved Temporarily
Location: =404
```

而不是 404。对比证据很干净：同一份配置里 `*.html` 那个 location 没写这行、返回正确的 404；
`/assets/` 写了这行、返回这个假的 302。302 还会被浏览器缓存，问题很难复查。

正确做法是**压根不使用 server 级的 `error_page 404 /index.html` 兜底首页**。
本模板没有它，所以 PHP 与静态文件的 404/403 会自然原样透传，不需要任何"护栏"。

> 如果你确实想要"找不到页面就回首页"，请**在页面自己的 location 里用 `try_files`**，
> 例如 `location ~* \.html$ { try_files $uri /index.html; }`，绝不要在 server 级用 `error_page`
> —— 它会连接口和 `photo.php` 的 404 一起改写成 200 + 首页 HTML，
> 那样 `fetch` 会拿到一坨 HTML 解析失败、`<img>` 拿不到图片内容，错误被完全掩盖。

### 3. HTTP/2

`listen 443 ssl` 要补上 `http2` 标志，否则只能走 HTTP/1.1。
nginx 1.18（Ubuntu 22.04 自带）用 **`listen 443 ssl http2;`** 这种写法；
`http2 on;` 是 1.25.1+ 才有的新指令，在本机上是语法错误。

> ⚠️ 如果你手动跑 `certbot --nginx -d <域名>` 重装证书，装完请回读本配置确认 `http2` 没被吃掉。

### 4. HSTS 与 `.htaccess` 保持一致

`deploy/.htaccess` 里有 `Strict-Transport-Security "max-age=86400"`，
Nginx 这边也必须有一份（本模板已在 server 级与两个 location 里都写了）。
两条部署路径不能有行为差异。

`max-age` 故意先给 1 天：它是"浏览器里没有绕过按钮"的锁，证书一旦失效，
站点在 max-age 到期前会直接打不开。稳定运行一段时间后再调大成 `31536000`；
要撤销就在 https 响应里下发 `max-age=0`。

### 5. `assets/music/music.dat` 用 octet-stream 是**可以**的

nginx 的 `mime.types` 没有 `.dat`，所以响应头是 `Content-Type: application/octet-stream`。
这没问题：

1. `assets/js/main.js` 的音乐探测是**反向判断**——只拒绝 `html|xml|json`，octet-stream 明确放行
2. `<audio>` 会自行嗅探解码
3. 同样的组合（`nosniff` + octet-stream + `.dat`）在现有线上站点已实测可用

> ⚠️ **不要**为了"更规范"给 `.dat` 加 `AddType audio/mpeg`。改 `types` 会牵扯 MIME 继承，
> 还可能要在 location 里再重复一遍安全头，收益为零、风险不为零。
> （项目里"千万别给 .dat 加 AddType"那条约束是针对 **InfinityFree 边缘层**按扩展名强加
> `no-store` 的行为，自有服务器没有那个边缘层，所以那条约束在这里不适用——但上面的
> 理由本身就足够支持不改。）

### 6. 照片是 base64，`upload_max_filesize` 不适用

照片走 `<input>` → canvas 压缩 → `data:image/...;base64` → JSON POST，**不是 multipart 文件上传**。

- 真正的业务上限是 `lib/content.php` 的 `PHOTO_MAX_BASE64 = 3 MB`
- 外层护栏 `client_max_body_size 20m`、内层护栏 PHP `post_max_size = 8M`，两层都远大于 3 MB
- PHP 的 `upload_max_filesize = 2M` **在这里不生效**，不用为了它去改 php.ini

### 7. 443 也要防"任意 Host"（2026-09-15 补）

80 块一直有 `if ($host != <域名>) { return 404; }`，443 块原本**没有**。实测：把任意域名
解析到本机 IP 再访问 `https://那个域名/`，会拿到 **200 + 整站内容**，而且带我们的
HSTS 与安全头 —— 等于本站被"任何指向该 IP 的域名"镜像一份。现在两个块口径一致，
都只服务本域名（裸 IP 访问同样返回干净的 404，比"证书告警 + 站点"更好）。

### 8. `charset utf-8` 与 `server_tokens off`（2026-09-15 补）

- **charset**：Apache 那条路径（`AddDefaultCharset`）默认就带 `charset=UTF-8`，nginx 不带，
  中文站点只能靠 HTML 里的 `<meta charset>` 兜底。补上 `charset utf-8;` 让两条路径同口径。
  它只**声明**不改写内容（没有 `charset_map`/`source_charset` 就不会转码），
  且只作用于 `charset_types` 列的类型，`application/json` 与 `application/octet-stream` 不受影响。
- **server_tokens off**：默认所有响应头与 404 页面正文里都会写 `nginx/1.18.0 (Ubuntu)`
  （实测可见），等于免费告诉扫描器该打哪个 CVE。关掉后保留 `Server: nginx`。

### 9. 点文件（`.htaccess` / `.git` / `.env`）必须显式拒绝（2026-09-15 补）

nginx **既不读 `.htaccess`、也不会自动拒绝它** —— 默认行为就是当普通文件下载出去。
本项目构建产物里没有点文件（2026-09-15 在服务器上实测 `find` 确认），所以这是一条
**防将来手滑**的规则：手工上传、换部署工具、编辑器产生临时文件都可能往站点根塞点文件。

```nginx
location ~* /\.(?!well-known/) { deny all; }
```

`.well-known/` 单独用负向断言放行：certbot 的 HTTP-01 校验要用它。本机目前走的是
certbot 的 **nginx 插件**（不是 webroot），但留这个白名单可以避免将来换续期方式时踩坑 ——
改完已实测续期演练仍然通过（见下一节）。

---

## 五、运维：日志在哪

自有服务器相比免费主机最大的好处之一就是**有诊断通道**（免费主机那边
`display_errors=0` 且没有可读错误日志，只能验收不能定位）：

| 要看什么 | 去哪看 |
|---|---|
| 访问日志 | `/var/log/nginx/love.access.log`（配置里显式指定的） |
| nginx 层错误（含 FastCGI 上游报错） | `/var/log/nginx/love.error.log` |
| **PHP 警告 / 致命错误** | `/var/log/php8.1-fpm.log`（`log_errors=On`、`display_errors=Off`） |
| 证书 | `sudo certbot certificates` |
| 封禁情况 | `sudo fail2ban-client status sshd` |

常用：

```bash
sudo tail -f /var/log/nginx/love.access.log
sudo tail -50 /var/log/php8.1-fpm.log
sudo nginx -t && sudo systemctl reload nginx
```

---

## 六、本机网络的一个已知现象（不是服务器问题）

从这台机器**直连**服务器的 80 端口极不稳定（2026-09-15 实测 6/6 失败，
报 `WinError 10054 远程主机强迫关闭了一个现有的连接`），而：

- 同一 IP 的 **443 稳定可用**
- **走代理时 80 能正常拿到 301**
- 从服务器自身访问自己的公网 IP:80 能正常拿到 nginx 响应

三条合起来说明这是**出口对明文 HTTP 的 DPI 干扰**（跨境/境外出口上很常见），
不是服务器或安全组的问题。影响与对策：

- 实际访客大多直接访问 `https://`，加上 HSTS 与站内 https 升级，影响有限
- 不加 `--proxy` 时这一项会报**警告**（而不是失败），并附上解释
- **最可靠的复验方式是不依赖本机网络**，直接在服务器上用 Host 头访问自己的 80：

  ```bash
  ssh <SSH别名> "curl -s -o /dev/null -D - -H 'Host: <域名>' \
      'http://127.0.0.1/index.html?probe=1'"
  # 期望：HTTP/1.1 301 Moved Permanently
  #       Location: https://<域名>/index.html?probe=1   ← 查询串必须被保留
  ```

- `--proxy` 也可以，但**代理链本身可能连不上**（2026-09-15 实测：本机 Clash 的
  7897 端口在监听，但经它访问本机 443 会直接 502 / EOF）—— 那时会把所有项一起变红，
  别误判成服务器故障。所以 `--proxy` 只建议用来单独验这一项。
- ⚠️ `--proxy` **只影响 HTTP 请求**。TLS 那一项（要看 ALPN 协商结果）走裸 socket 直连，
  不受 `--proxy/--no-proxy` 影响，连不上时会明确提示这一点。

---

## 七、2026-09-15 全量审查：已实测确认的结论

这一节记的是"查过、确认没问题"的事，免得下次再怀疑一遍。每条都是在真机上跑出来的。

1. **certbot 续期不会改动这份配置。** 用 `sudo certbot renew --dry-run` 实测两次
   （分别在加固前后），配置文件 sha256 与 mtime **都没变**，`nginx -t` 通过、ALPN 仍是 `h2`。
   所以"certbot 会把 `http2` 吃掉"只是理论风险，本机流程下不会发生；配置仍以本仓库模板为准
   （服务器现状与本地渲染结果逐字节一致）。
2. **PHP 扩展齐了。** FPM 侧实测已加载 openssl / sodium / mbstring / json / exif / fileinfo /
   iconv / hash / session / zlib，站点用到的都够（`password_hash`、`random_bytes`、`getimagesize`、
   `finfo` 都能用）。
3. **`session.save_path=/var/lib/php/sessions` 对 `www-data` 可写**（`drwx-wx-wt`），
   管理员后台登录不会因为目录权限静默失败。
4. **已知差异（刻意不改）**：PHP 的 `session.gc_maxlifetime = 1440`（24 分钟），
   而 `lib/store.php` 里设计的后台空闲超时是 8 小时。`phpsessionclean.timer` 实测在跑
   （每 30 分钟清一次），所以**后台空闲约 24 分钟以上会被登出一次**。
   现有线上主机同样如此，两条路径行为一致；只在自有服务器上单独调大会造成行为分叉，
   所以保持不动。真要改，在 `/etc/php/8.1/fpm/conf.d/` 下加一个 `99-love.ini`
   写 `session.gc_maxlifetime = 28800` 再 reload php-fpm 即可。
5. **系统升级已完成（2026-09-15）**，记录在此以便下次比对：

   | 项目 | 结果 |
   |---|---|
   | 升级包 | 13 个：nginx 全家桶 `1.18.0-6ubuntu14.20 → .21`（含 **jammy-security**）、krb5 库 4 个 |
   | 移除包 | **0 个**（执行前用 `apt-get -s upgrade` 模拟确认过） |
   | libc6 | 已是最新，重启后 `reboot-required` 清除；**没有新内核**，重启不换内核 |
   | 重启耗时 | 10 秒恢复 SSH；`nginx / php8.1-fpm / fail2ban / certbot.timer` 全部 enabled 自启 |
   | 配置漂移 | 升级前后站点配置 sha256 都是 `3946ae57…`，未被 dpkg 触碰；无 `.dpkg-dist` 待合并 |
   | 升级后复验 | 续期演练通过、ALPN 仍 `h2`、403/404/301/Host 守卫全部照旧、`vps_setup.py` 幂等重跑成功、`verify_vps.py --phase infra` 32 通过 / 0 失败 |

   命令与本次一致（**永远先模拟再执行**）：

   ```bash
   sudo apt-get update
   sudo apt-get -s upgrade | grep -E '^Remv'      # 必须为空，否则先查清再动
   sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a \
        apt-get -y -o Dpkg::Options::=--force-confdef \
                   -o Dpkg::Options::=--force-confold upgrade
   sudo systemctl reboot
   ```

   > `--force-confold` 表示"包带了新版配置就保留现有的"；用 `sudo env VAR=…` 而不是
   > `sudo VAR=…` 是因为默认 sudoers 的 `env_reset` 不允许通过命令行设环境变量。

6. **磁盘与日志卫生（2026-09-15 已做）**：`apt-get clean` 释放 169 MB（169M → 12K）；
   给 journald 加了硬上限 `/etc/systemd/journald.conf.d/99-love-size.conf`
   （`SystemMaxUse=200M`、`SystemKeepFree=1G`）—— journald 默认上限是**磁盘的 10%**，
   在这台 62 GB 的机器上理论能长到 6 GB，小规格远程机值得钉死（删掉该文件即恢复默认）。
   日志上限由 `logrotate` 负责（`/etc/logrotate.d/nginx`：daily / 14 份 / 压缩）。

---

## 八、还没做的（等需要时再说）

1. **可选的 Node WebSocket 服务**（模板阶段 E）：需要装 Node 20、部署到 `/opt/<服务名>`、
   起 systemd，并取消 `nginx.conf.template` 里那一段反代注释。
   它还依赖前端改连接地址并重新打包，所以建议两边一起做。
2. **`data/` 定时备份**：目前 `data/` 只存在于服务器上，没有备份。
3. **从现有线上站点搬迁真实数据**：需要「导出 → 上传 → 逐字节校验」那条工具链。
4. **`ufw` 刻意没开**（2026-09-15 查证）：服务器对外**只监听 22 / 80 / 443**
   （`ss -tlnp` 实测，正好是云平台安全组放行的那三个；DNS stub 53 只绑 `127.0.0.53`、
   chrony 只绑 `127.0.0.1`、没有别的服务挂在公网口上）。在 NSG 已经收口的前提下再开主机
   防火墙只是多一个"配错就 SSH 失联、得去云平台控制台串口救"的失效点，收益为零。
   fail2ban 同理只留 sshd jail：站点自身的门禁与后台登录在 PHP 层已按 IP 限流锁定
   （`lib/access.php` 10 次锁 10 分钟、`lib/store.php` 5 次锁 10 分钟），
   再加 nginx 层封禁只会制造"自己人被封"的风险，不解决真实问题。
5. **netplan 的 4 个包暂不装**（`netplan.io` / `libnetplan0` / `netplan-generator` /
   `python3-netplan`，`0.107.1-3ubuntu0.22.04.4 → .5`）：它来自 `jammy-updates`（**不是**安全更新），
   且 Ubuntu 标着 **`phased 10%`** —— 只对 10% 的机器放行，正是为了先抓回归。
   远程机上强行装网络组件、万一新 generator 处理云平台的网络配置出问题就会直接失联，
   风险收益不划算。走 Ubuntu 的正常分阶段放行即可；要现在装就用
   `-o APT::Get::Always-Include-Phased-Updates=true`。
6. **旧的 `.bak` 配置备份会累积**（每次 `vps_setup.py` 生成一个）。留几个当"后悔药"即可，
   定期 `sudo rm /etc/nginx/sites-available/love.bak.<旧时间戳>`。

这些都不影响当前部署能力，需要时单独提。
