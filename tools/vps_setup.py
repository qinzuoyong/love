# -*- coding: utf-8 -*-
"""情侣网站 · 自有服务器(VPS) 初始化：一次装好，可重复跑（幂等）

作用：
  1. 预检目标机：ssh 免密可达 / sudo 免密 / nginx / php-fpm / 证书 / FPM socket 对得上
  2. 用 deploy/vps/nginx.conf.template 渲染站点配置装到
     /etc/nginx/sites-available/<站点名>
     **装前备份 → 装后 `nginx -t` 兜底 → 失败自动回滚并报错**，成功才 reload
  3. 建站点目录并授权 www-data（dist / data / assets/img/uploads）
  4. 确认 sites-enabled 软链存在

为什么要这个脚本：2026-09-15 体检发现服务器上的 nginx 配置是手写的、和项目模板漂移了，
漏掉了 add_header 不继承导致的安全头丢失（HTML 页上 X-Robots-Tag 等 4 个头全没）。
把配置纳入版本控制 + 用脚本安装，就不会再漂。

用法：
    python tools/vps_setup.py --creds "<凭据文件>"
    python tools/vps_setup.py --creds "<文件>" --dry-run      # 只打印，不动服务器
    python tools/vps_setup.py --creds "<文件>" --dirs-only    # 只建目录，不碰 nginx 配置
    python tools/vps_setup.py --creds "<文件>" --conf-only    # 只装 nginx 配置

取值优先级：命令行参数 > 环境变量 > 凭据文件。
    域名       裸域名（值尾部的括号说明会自动裁掉）
    网站根     dist 内容所在目录，如 /var/www/love/dist
    SSH 别名   能免密登录的 ~/.ssh/config Host 别名（或 LOVE_VPS_SSH / --ssh-host）
    站点名     可选，nginx 配置文件名与软链名，默认 love

注意：
  · 值一律不入库：常规回显把域名脱敏（只打印长度与形态），不打印明文。
    **例外**：`--dry-run` 会把渲染后的整份配置打出来供人工复核，里面含真实域名 ——
    那份输出别粘到公开场合（issue / 聊天记录）。
  · 远端路径参数（--root / --php-sock）会被校验必须是 Linux 绝对路径：
    经 Git Bash 传参时 MSYS 会把 "/开头" 的参数**和环境变量**都改写成 Windows 路径，
    而装错之后 `nginx -t` 与 sha256 回读都验不出来。请写进凭据文件，或先
    `export MSYS2_ARG_CONV_EXCL='*'`（只对参数有效），或用 PowerShell 跑。
  · 本脚本只动 nginx 配置与目录属主，**不上传任何站点文件**（那是 tools/deploy_vps.py 的事）。
  · 站点目录只做 `install -d`（建目录 + 修正该目录本身的属主/权限），
    绝不做 `chown -R`，以免误改已有数据的属主。
"""
import argparse
import hashlib
import os
import posixpath
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy import mask_path, mask_secret                            # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "deploy", "vps", "nginx.conf.template")

SSH_BIN = os.environ.get("LOVE_SSH_BIN") or "ssh"
SCP_BIN = os.environ.get("LOVE_SCP_BIN") or "scp"

DEFAULT_SITE = "love"
DEFAULT_USER = "www-data"

# 凭据文件里的标签（长的在前，避免短别名抢先匹配）
LABELS = {
    "domain": ("站点域名", "网站域名", "域名", "Domain", "domain"),
    "root": ("网站根目录", "站点根目录", "网站根", "站点根", "WebRoot", "webroot"),
    "ssh": ("SSH 别名", "SSH别名", "SSH 主机", "SSH主机", "Host 别名", "主机别名", "SSHHost"),
    "site": ("站点名", "配置名", "配置文件名", "SiteName"),
}


def die(msg):
    sys.exit("错误：%s" % msg)


def shq(s):
    """单引号包裹的 shell 字面量（值里带单引号也能安全传递）"""
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


REMOTE_PATH_HINT = (
    "（远端路径必须是 Linux 绝对路径。经 Git Bash 传参时 MSYS 会把 \"/开头\" 的参数\n"
    "  改写成 Windows 路径，实测 `--root /var/www/love/dist` 到手会变成\n"
    "  `<Git 安装目录>/var/www/love/dist` —— 这种值装进 nginx 后 `nginx -t`\n"
    "  和 sha256 回读都发现不了，站点会静默指向一个不存在的目录。\n"
    "  实测 MSYS 对**环境变量**也会做同样的改写，而且 `MSYS2_ARG_CONV_EXCL` 管不了它，\n"
    "  所以只有这三条路是可靠的：\n"
    "    1) 写进凭据文件（推荐，读的是文件内容，不经过 MSYS 改写）\n"
    "    2) 在 Git Bash 里先 `export MSYS2_ARG_CONV_EXCL='*'`，再用命令行参数传\n"
    "    3) 干脆用 PowerShell / CMD 跑，不经 MSYS）"
)


def check_remote_path(name, value):
    """拦下被 MSYS 改写成 Windows 形态的"远端路径"参数（见 REMOTE_PATH_HINT）。

    只管"形态"（绝对路径 + 无冒号）。留空表示"该入口允许不填"（如 --php-sock
    留空 = 自动探测）；站点根另有一道取值下限 check_web_root()。"""
    if not value:
        return
    if not value.startswith("/") or ":" in value:
        die("%s 不是 Linux 绝对路径：%r\n%s" % (name, value, REMOTE_PATH_HINT))


# 站点根的取值下限（第七轮 S11-07）。
# `--root /`、`/usr`、`/var` 这类值能通过"绝对路径 + 无冒号"两条判据，而远端
# `sudo rsync -a … "$STAGE"/ "$WEBROOT"/` 会把**目标目录本身**的属主/权限改成源
# （www-data / 0755），并把整站铺进系统目录。没带 --delete 所以不删文件，但
# "污染 + 改属主"是不可逆的，而且 sha256 回读全过、结尾照样报"部署完成 ✓"。
# 这与 build.py 里"拒绝输出到文件系统根"是同一种防御，部署侧必须有对应的一道。
WEB_ROOT_MIN_SEGMENTS = 2
WEB_ROOT_SYSTEM_TREES = (
    "/bin/", "/boot/", "/dev/", "/etc/", "/lib/", "/lib64/", "/proc/",
    "/root/", "/run/", "/sbin/", "/sys/", "/usr/",
    "/var/lib/", "/var/log/", "/var/run/", "/var/spool/", "/var/tmp/",
)


def check_web_root(name, value):
    """站点根的取值下限：形态守卫 + 拒绝空值/根/系统目录（第七轮 S11-07）。

    两条部署路径（vps_setup、deploy_vps）的 --root 入口都必须过这里 ——
    `--php-sock` 不需要：/run/php/*.sock 本来就在系统目录树里。"""
    check_remote_path(name, value)
    if not value:
        die("%s 不能为空：远端同步需要一个明确的站点根目录（如 /var/www/love/dist）" % name)
    if any(seg == ".." for seg in value.split("/")):
        die("%s 里不允许出现 `..`：%r\n请写规范化后的绝对路径。" % (name, value))
    norm = posixpath.normpath(value)
    segments = [s for s in norm.split("/") if s]
    if len(segments) < WEB_ROOT_MIN_SEGMENTS:
        die("%s 太浅：%r\n站点根至少要有两级（如 /var/www/love/dist 或 /srv/love）。\n"
            "`/`、`/usr`、`/var`、`/etc` 这类值会让 rsync -a 改写系统目录本身的"
            "属主与权限，并把整站铺进系统目录。" % (name, value))
    for tree in WEB_ROOT_SYSTEM_TREES:
        if norm == tree.rstrip("/") or norm.startswith(tree):
            die("%s 落在系统目录里：%r（%s 之下的目录不能当站点根）\n"
                "请改用 /var/www/… 或 /srv/… 下的独立目录。"
                % (name, value, tree.rstrip("/")))


def check_site_name(site):
    """配置名会拼进远端路径、并被写进一段以 sudo 运行的脚本，必须收窄字符集。

    为什么不用 shq() 就够：`CONF="/etc/nginx/sites-available/<site>"` 这类赋值在
    脚本里本来就是双引号形态，值里出现 `"`、`$(`、`/`、`..` 都能改写脚本本身。"""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", site or ""):
        die("配置名只能用字母/数字/点/下划线/连字符：%r" % site)


def read_text(path):
    """多编码探测读取（凭据文件常见 UTF-8 BOM / GBK）"""
    if not os.path.isfile(path):
        die("文件不存在：%s" % path)
    last = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "big5", "latin-1"):
        try:
            with open(path, "r", encoding=enc) as f:
                return f.read()
        except UnicodeDecodeError as e:
            last = e
            continue
        except OSError as e:
            die("读不到 %s：%s" % (path, e))
    die("文件编码无法识别：%s（%s）" % (path, last))


def clean_value(raw):
    """裁掉值尾部的说明文字。
    凭据文件里常见写法是 `域名    ：example.com（免费二级域名）`，
    这里把括号及其后的内容、以及空白后的内容都去掉，只留裸值。

    ⚠️ 只用于**域名/主机名**这类"短值 + 说明"的标签（见 RAW_LABELS）：
    路径与别名里的 `(` 或空格是合法的真值，裁剪会把它们静默改短 ——
    截断后的值仍然 startswith("/") 且不含 `:`，于是所有守卫都放行，
    文件被装到另一个目录而 `nginx -t`、sha256 回读全过（第七轮 S11-04）。"""
    v = (raw or "").strip()
    for ch in ("（", "("):
        i = v.find(ch)
        if i > 0:
            v = v[:i]
    parts = v.split()
    return parts[0] if parts else ""


# 这些标签的值逐字保留（只 strip），不走 clean_value 的"裁掉括号说明"：
#   root —— 远端路径，`/www/站点(旧)/dist`、`/var/www/love site/dist` 都合法
#   ssh  —— ~/.ssh/config 的 Host 别名，可能是带空格的自定义名
#   site —— nginx 配置名，格式由 check_site_name() 收窄并**报错**，不在这里静默改值
RAW_LABELS = ("root", "ssh", "site")


def parse_creds(text):
    """按「标签：值」或「标签独占一行、值在下一行」两种格式取值

    只有域名这类短值才裁掉尾部说明文字；路径与别名逐字保留（见 RAW_LABELS）。"""
    lines = [ln.strip() for ln in text.splitlines()]

    def grab(names):
        for i, ln in enumerate(lines):
            if not ln or ln.startswith("#"):
                continue
            for name in names:
                if ln == name:                      # 标签独占一行 → 往下找第一个非空行
                    for nxt in lines[i + 1:i + 4]:
                        if nxt and not nxt.startswith("#"):
                            return nxt
                    continue
                # 标签与值同行：允许标签和冒号之间有空白（常见写法 `域名    ：xxx`）
                m = re.match(r"^%s\s*[：:]\s*(.*)$" % re.escape(name), ln)
                if m:
                    rest = m.group(1).strip()
                    if rest:
                        return rest
                    for nxt in lines[i + 1:i + 4]:
                        if nxt and not nxt.startswith("#"):
                            return nxt
                    return ""
        return ""

    out = {}
    for key, names in LABELS.items():
        raw = (grab(names) or "").strip()
        out[key] = raw if key in RAW_LABELS else clean_value(raw)
    return out


def redact(text, *secrets):
    """把输出文本里出现的敏感值（连接别名等）换成 mask_secret 的形态。

    横幅早就打了码（main() 的「连接别名」一行），但错误路径仍然明文打出来 ——
    `ssh <别名> 超时`、以及 scp 的 stderr 里常见的
    `Could not resolve hostname <别名>`。同一份输出上半截打码、下半截明文
    等于没打码（第七轮 S11-06）。"""
    s = str(text if text is not None else "")
    for v in secrets:
        v = str(v or "")
        if v:
            s = s.replace(v, mask_secret(v))
    return s


def ssh_run(host, script, timeout=180, quiet=False):
    """把一段 bash 脚本喂给远端 `bash -s` 执行，返回 (returncode, 输出文本)。
    BatchMode=yes 保证绝不弹密码提示 —— 免密通道有问题就要立刻失败，不能挂住。"""
    try:
        p = subprocess.run(
            [SSH_BIN, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "bash", "-s"],
            input=script.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    except FileNotFoundError:
        die("找不到 ssh 可执行文件（%s）。可用环境变量 LOVE_SSH_BIN 指定路径。" % SSH_BIN)
    except subprocess.TimeoutExpired:
        die("ssh 到 %s 超时（%d 秒）。先手工确认 `ssh %s` 能连上（别名已打码，见横幅）。"
            % (mask_secret(host), timeout, mask_secret(host)))
    text = (p.stdout or b"").decode("utf-8", "replace")
    if not quiet:
        for ln in text.rstrip().splitlines():
            print("    %s" % ln)
    return p.returncode, text


def scp_up(local, host, remote, timeout=180):
    try:
        p = subprocess.run(
            [SCP_BIN, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
             local, "%s:%s" % (host, remote)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
        )
    except FileNotFoundError:
        die("找不到 scp 可执行文件（%s）。可用环境变量 LOVE_SCP_BIN 指定路径。" % SCP_BIN)
    except subprocess.TimeoutExpired:
        die("scp 到 %s 超时。" % mask_secret(host))
    if p.returncode != 0:
        # scp 的 stderr 里通常带 `Could not resolve hostname <别名>`：整段一起打码
        die("上传失败：%s" % redact((p.stdout or b"").decode("utf-8", "replace").strip(), host))


def render(domain, web_root, php_sock):
    text = read_text(TEMPLATE)
    for token, val in (("__DOMAIN__", domain), ("__ROOT__", web_root), ("__PHP_SOCK__", php_sock)):
        if token not in text:
            die("模板里找不到占位符 %s —— 模板被改过？请检查 %s" % (token, TEMPLATE))
        text = text.replace(token, val)
    leftover = sorted(set(re.findall(r"__[A-Z_]{2,}__", text)))
    if leftover:
        die("模板里还有没渲染的占位符：%s" % ", ".join(leftover))
    # 统一 LF：模板在 Windows 上可能被编辑器改成 CRLF，nginx 虽容忍但 diff 会很难看
    return text.replace("\r\n", "\n")


def preflight_script(site, domain, web_root):
    """远端预检脚本。所有变量在脚本头部注入，避免在 Python 里对脚本体做字符串替换。
    抽成模块级函数是为了能单独做 `bash -n` 语法校验（内联在调用处就测不到）。"""
    head = (
        "SITE=%s\n" % shq(site)
        + "DOMAIN=%s\n" % shq(domain)
        + "WEBROOT=%s\n" % shq(web_root)
        + "SITEUSER=%s\n" % shq(DEFAULT_USER)
    )
    body = r"""
echo "MARK hostname=$(hostname)"
echo "MARK os=$( . /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}" )"
if sudo -n true 2>/dev/null; then echo "MARK sudo=ok"; else echo "MARK sudo=no"; fi
if command -v nginx >/dev/null 2>&1; then
  echo "MARK nginx=$(nginx -v 2>&1 | sed 's/^nginx version: //')"
else
  echo "MARK nginx=absent"
fi

ACT=""
for u in php8.4-fpm php8.3-fpm php8.2-fpm php8.1-fpm php8.0-fpm php-fpm; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then ACT="$u"; break; fi
done
echo "MARK fpm=${ACT:-none}"
if [ -n "$ACT" ]; then
  echo "MARK fpm_enabled=$(systemctl is-enabled "$ACT" 2>/dev/null || echo unknown)"
fi

# FPM socket：三个来源都探一遍，以"php-fpm 实际在监听的"为准（最可靠）。
# 坑：pool 配置里写的是 `listen = /run/php/php8.1-fpm.sock`（**没有** unix: 前缀），
#     而 /run/php/ 下还有一个排序更靠前的 `php-fpm.sock` 符号链接，光靠 glob 会选错。
SOCK_POOL=""
if [ -d /etc/php ]; then
  SOCK_POOL=$(sudo grep -rhoE '^[[:space:]]*listen[[:space:]]*=[[:space:]]*[^;[:space:]]+' \
                /etc/php/*/fpm/pool.d/*.conf 2>/dev/null \
              | sed -E 's/^[[:space:]]*listen[[:space:]]*=[[:space:]]*//; s/^unix://' \
              | grep -E '^/' | head -1)
fi
SOCK_LISTEN=$(sudo ss -lx 2>/dev/null | grep -oE '/[^ ]*php[^ ]*\.sock' | head -1)
SOCK="$SOCK_LISTEN"
[ -z "$SOCK" ] && SOCK="$SOCK_POOL"
echo "MARK sock_pool=${SOCK_POOL:-none}"
echo "MARK sock_listen=${SOCK_LISTEN:-none}"
echo "MARK sock=${SOCK:-none}"
if [ -n "$SOCK" ] && [ -S "$SOCK" ]; then echo "MARK sock_ok=yes"; else echo "MARK sock_ok=no"; fi

CONF="/etc/nginx/sites-available/$SITE"
echo "MARK conf_exists=$([ -f "$CONF" ] && echo yes || echo no)"
echo "MARK site_enabled=$([ -e "/etc/nginx/sites-enabled/$SITE" ] && echo yes || echo no)"
# 证书目录 /etc/letsencrypt/live 是 0700 root，非 root 的 -f 一定探不到 —— 必须 sudo
echo "MARK cert=$(sudo -n test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" && echo yes || echo no)"
if [ -d "$WEBROOT" ]; then
  echo "MARK root_state=exists"
  echo "MARK root_owner=$(stat -c '%U:%G %a' "$WEBROOT" 2>/dev/null || echo unknown)"
else
  echo "MARK root_state=missing"
fi
echo "MARK user=$([ "$(id -u "$SITEUSER" 2>/dev/null)" != "" ] && echo ok || echo missing)"
echo "MARK disk=$(df -h --output=avail / 2>/dev/null | tail -1 | tr -d ' ')"
echo "MARK mem=$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
echo "MARK DONE"
"""
    return head + body


def preflight(host, site, domain, web_root):
    """跑远端预检并把 MARK 行解析成字典"""
    rc, out = ssh_run(host, preflight_script(site, domain, web_root), quiet=True)
    if rc != 0 or "MARK DONE" not in out:
        print(out.rstrip())
        die("预检失败（退出码 %d）。先手工跑一次 `ssh %s` 确认通道正常。"
            % (rc, mask_secret(host)))

    marks = {}
    for ln in out.splitlines():
        m = re.match(r"^MARK\s+([a-z_]+)=(.*)$", ln.strip())
        if m:
            marks[m.group(1)] = m.group(2).strip()
    return marks


def install_script(site, remote_src, expect_sha256):
    """远端安装脚本。设计要点：
    · 先备份成带时间戳的 .bak，并把路径打出来，便于手工恢复
    · 装完**回读 sha256** 与本地渲染结果比对：证明落地的字节与仓库里那份完全一致
      （scp/install 被截断或被别的东西覆盖，只有回读才看得出来）
    · `nginx -t` 失败必须回滚且**不 reload**，否则等于把线上搞挂
    · 幂等：重复跑只会再产生一个 .bak，行为一致"""
    return r"""
set -u
CONF=%(conf)s
LINK=%(link)s
SRC=%(src)s
EXPECT="%(expect)s"
BAK=""
# SRC 是 scp 上来的临时文件：无论走到哪一步退出都要清掉，否则失败几次
# 就在 /tmp 里攒几个配置副本（里面是站点域名与路径）。
trap 'rm -f "$SRC"' EXIT

echo "STEP backup"
if [ -f "$CONF" ]; then
  BAK="$CONF.bak.$(date +%%Y%%m%%d-%%H%%M%%S)"
  if sudo cp -a "$CONF" "$BAK"; then echo "OK backup=$BAK"; else echo "FAIL backup"; exit 1; fi
else
  echo "OK backup=none(新建配置)"
fi

echo "STEP install"
# 先装到 $CONF.new 再 mv 覆盖：GNU `install` 是**原地截断**写入，中途失败
# （磁盘满、被信号打断）会把线上那份配置留成残缺文件 —— 此时 nginx 因为还在用
# 内存里的旧配置照常服务，直到下一次 reload/restart 才炸。mv 是原子替换，没有这个窗口。
if sudo install -m 0644 -o root -g root "$SRC" "$CONF.new"; then
  echo "OK staged=$CONF.new"
  if sudo mv -f "$CONF.new" "$CONF"; then
    echo "OK installed=$CONF"
  else
    echo "FAIL mv"; exit 1
  fi
else
  echo "FAIL install"; exit 1
fi
rm -f "$SRC"

echo "STEP hash"
GOT=$(sudo sha256sum "$CONF" | cut -d' ' -f1)
if [ "$GOT" = "$EXPECT" ]; then
  echo "OK sha256=$GOT"
else
  echo "FAIL hash_mismatch got=$GOT expect=$EXPECT"
  if [ -n "$BAK" ]; then sudo cp -a "$BAK" "$CONF" && echo "ROLLBACK=done($BAK)"; fi
  exit 1
fi

echo "STEP enable"
# 已存在的软链**必须**指向我们这份配置才算数（第四轮 F-S11-05）：
# 常见旧命名形态是 sites-enabled/<站点> -> sites-available/<站点>.conf，而本次装的是
# sites-available/<站点>。旧实现只判"存在性"就打印"已存在"，于是站点其实还在用旧配置；
# 更糟的是 nginx -t 失败时回滚会 `rm -f "$LINK"` 把**别人建的**软链删掉 ——
# 即使旧配置还在，站点从此不再被 nginx 加载（重载/重启后 404 或落到 default server）。
LINK_CREATED=0
# `-e` 对**悬空软链**为假（test -e 会跟随链接），于是旧写法会掉进"这里没有软链"
# 的分支去 `ln -s`，而那个名字已经存在 → ln 报 File exists → FAIL link、退出且
# **不回滚**；上层兜底文案却宣称"线上那份文件没有被改动过"，与事实相反（配置文件
# 已经被 mv 覆盖，旧内容只剩 .bak）。`-L` 是"这个位置存在一个链接本身"，
# 两条合起来才等于"这里有东西"（第七轮 S11-05）。
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  LINK_TARGET=$(readlink "$LINK" 2>/dev/null || echo "")
  if [ "$LINK_TARGET" = "$CONF" ]; then
    echo "OK link=$LINK(已存在且指向本配置)"
  else
    echo "FAIL link_conflict link=$LINK target=${LINK_TARGET:-<不是软链>} want=$CONF"
    echo "提示：该软链不是本次创建的，脚本不会删它；请人工确认站点该用哪份配置。"
    if [ -n "$BAK" ]; then sudo cp -a "$BAK" "$CONF" && echo "ROLLBACK=done($BAK)"; else sudo rm -f "$CONF" && echo "ROLLBACK=done(只删新建配置，未动软链)"; fi
    exit 1
  fi
else
  if sudo ln -s "$CONF" "$LINK"; then
    LINK_CREATED=1; echo "OK link=$LINK"
  else
    # 建软链失败也要回收：此时 $CONF 已经被上一步 mv 覆盖过，只有 $BAK 里还有旧内容。
    # 旧写法只 `exit 1`，上层只能打出与事实相反的兜底文案（第七轮 S11-05）。
    echo "FAIL link"
    if [ -n "$BAK" ]; then sudo cp -a "$BAK" "$CONF" && echo "ROLLBACK=done($BAK)"; else sudo rm -f "$CONF" && echo "ROLLBACK=done(只删新建配置，未动软链)"; fi
    exit 1
  fi
fi

echo "STEP nginx-t"
if sudo nginx -t 2>&1; then
  echo "OK nginx_t=pass"
else
  echo "FAIL nginx_t"
  if [ -n "$BAK" ]; then
    sudo cp -a "$BAK" "$CONF" && echo "ROLLBACK=done($BAK)"
  else
    # 只删**本次创建**的软链（F-S11-05）：别人建的一律不动。
    sudo rm -f "$CONF"
    if [ "$LINK_CREATED" = "1" ]; then
      sudo rm -f "$LINK" && echo "ROLLBACK=done(删除新建配置与本次创建的软链)"
    else
      echo "ROLLBACK=done(删除新建配置；已存在的软链保持原样)"
    fi
  fi
  if sudo nginx -t >/dev/null 2>&1; then echo "ROLLBACK_OK"; else echo "ROLLBACK_BROKEN"; fi
  exit 1
fi

echo "STEP reload"
if sudo systemctl reload nginx; then
  echo "OK reloaded"
else
  # reload 失败说明 nginx 在运行时拒绝了这份配置（如地址/端口冲突，`nginx -t`
  # 检查不出来）。把它也回滚掉：虽然 reload 是平滑的、旧配置还在跑，但留着一份
  # 装不上的新配置在磁盘上，下次任何人 restart 都会踩雷。
  echo "FAIL reload"
  if [ -n "$BAK" ]; then
    sudo cp -a "$BAK" "$CONF" && echo "ROLLBACK=done($BAK)"
  else
    sudo rm -f "$CONF" "$LINK" && echo "ROLLBACK=done(删除新建配置)"
  fi
  if sudo systemctl reload nginx >/dev/null 2>&1; then echo "ROLLBACK_OK"; else echo "ROLLBACK_BROKEN"; fi
  exit 1
fi
echo "MARK DONE"
""" % {"conf": shq("/etc/nginx/sites-available/%s" % site),
       "link": shq("/etc/nginx/sites-enabled/%s" % site),
       "src": shq(remote_src), "expect": expect_sha256}


def make_dirs_script(web_root):
    """建目录并授权。只用 `install -d`（对每个目录单独生效），**不做 chown -R**，
    避免误改已有数据的属主 —— 那是 deploy_vps.py 同步后按需处理的事。"""
    return r"""
set -u
ROOT=%(root)s
USER_NAME=%(user)s
for d in "$ROOT" "$ROOT/data" "$ROOT/assets" "$ROOT/assets/img" "$ROOT/assets/img/uploads"; do
  if sudo install -d -o "$USER_NAME" -g "$USER_NAME" -m 0755 "$d"; then
    echo "OK dir=$d owner=$(stat -c '%%U:%%G %%a' "$d")"
  else
    echo "FAIL dir=$d"; exit 1
  fi
done
echo "MARK DONE"
""" % {"root": shq(web_root), "user": shq(DEFAULT_USER)}


def make_dirs(host, web_root, dry_run):
    script = make_dirs_script(web_root)
    if dry_run:
        print("    [dry-run] 会在远端执行：")
        for ln in script.splitlines():
            print("      %s" % ln)
        return

    rc, out = ssh_run(host, script)
    if rc != 0 or "MARK DONE" not in out:
        die("建目录失败。")


def install_conf(host, site, rendered, dry_run):
    """装 nginx 配置：备份 → 写入 → 回读 sha256 → nginx -t → 失败回滚。"""
    remote_tmp = "/tmp/.love-setup-%s.conf" % site
    tmp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp"
    local_tmp = os.path.join(tmp_dir, ".love-setup-%s.conf" % site)
    # 渲染结果以 UTF-8 + LF 落盘，回读时按同一口径取哈希
    expect_sha256 = hashlib.sha256(rendered.encode("utf-8")).hexdigest()
    with open(local_tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(rendered)

    if dry_run:
        print("    [dry-run] 会写本地临时文件 %s（%d 字节，sha256 %s…）"
              % (local_tmp, len(rendered.encode("utf-8")), expect_sha256[:12]))
        print("    [dry-run] 会 scp 到 %s:%s" % (mask_secret(host), remote_tmp))
        print("    [dry-run] 会在远端执行：")
        for ln in install_script(site, remote_tmp, expect_sha256).splitlines():
            print("      %s" % ln)
        return

    try:
        scp_up(local_tmp, host, remote_tmp)
        rc, out = ssh_run(host, install_script(site, remote_tmp, expect_sha256))
    finally:
        # 清理必须走 finally：scp_up()/ssh_run() 失败会走 die()（SystemExit），
        # 旧写法把 os.remove() 放在它们后面，于是失败路径根本不执行 ——
        # 渲染后的整份 nginx 配置（含真实域名、站点根、socket 路径）就长期留在
        # 本机 %TEMP% 里（第七轮 S11-08）。远端那份有 trap 兜住，本地也要有。
        try:
            os.remove(local_tmp)
        except OSError:
            pass

    if rc != 0 or "MARK DONE" not in out:
        # 只按远端真正打出来的 ROLLBACK 行说话。以前这里无条件宣称"已自动回滚、
        # 服务器未被留在坏状态"，而远端有两条路径（预检/安装失败、回滚后 nginx -t 仍不过）
        # 根本不会回滚或回滚失败 —— 那时这句安慰话会把一个需要立即上机处理的状态
        # 说成没事，比不打印更糟。
        if "ROLLBACK_BROKEN" in out:
            die("安装 %s 失败，而且**回滚之后 nginx -t 仍然不过** —— 服务器现在可能处于"
                "坏状态，请立刻上机检查（备份路径见上面 ROLLBACK= 那行）。" % site)
        if "ROLLBACK=done" in out:
            die("安装 %s 失败，已自动回滚到备份（路径见上面 ROLLBACK=done 那行）。" % site)
        # 兜底文案必须与远端**实际**打出的 STEP/OK/FAIL 行对齐：安装是"先写 .new
        # 再 mv"的原子替换，走到哪一步决定了线上那份文件有没有被换掉，不能在
        # 报告里替远端下结论（第七轮 S11-05：旧文案宣称"线上那份文件没有被改动过"，
        # 而在 enable 步骤失败时它其实已经被替换、旧内容只剩 .bak）。
        die("安装 %s 失败，且远端没有报告回滚结果。请按上面 `STEP …` 与 `OK/FAIL` 行"
            "判断停在哪一步：`STEP install`/`mv` 之前的失败**没有**动线上那份配置；"
            "`STEP enable` 及之后的失败则**可能已经替换**（旧内容在 .bak 备份里，"
            "路径见上面 `OK backup=` 那行）。确认无误后再重跑。" % site)


def mask_domain(domain):
    """脱敏回显：只露最后 4 个字符。

    实现在 `deploy.mask_secret`（同一口径的单一来源）：同一个站点的名字会在
    FTP 路径与 VPS 路径的日志里各出现一次，两边打码强度不同就等于没打。
    """
    return mask_secret(domain)


def main():
    ap = argparse.ArgumentParser(description="情侣网站 · VPS 初始化（nginx 配置 + 站点目录，幂等）")
    ap.add_argument("--creds", default="", help="凭据文件路径（仓库外）")
    ap.add_argument("--ssh-host", default="", help="~/.ssh/config 里的 Host 别名（或 LOVE_VPS_SSH）")
    ap.add_argument("--domain", default="", help="站点域名（或 LOVE_SITE_HOST）")
    ap.add_argument("--root", default="", help="站点根目录，如 /var/www/love/dist")
    ap.add_argument("--site", default="", help="nginx 配置名（默认 love）")
    ap.add_argument("--php-sock", default="", help="PHP-FPM socket 路径（默认自动探测）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做什么，不连服务器")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--conf-only", action="store_true", help="只装 nginx 配置，不动目录")
    g.add_argument("--dirs-only", action="store_true", help="只建目录，不动 nginx 配置")
    args = ap.parse_args()

    creds = parse_creds(read_text(args.creds)) if args.creds else {}

    host = args.ssh_host or os.environ.get("LOVE_VPS_SSH") or creds.get("ssh") or ""
    domain = args.domain or os.environ.get("LOVE_SITE_HOST") or creds.get("domain") or ""
    web_root = args.root or os.environ.get("LOVE_VPS_ROOT") or creds.get("root") or ""
    site = args.site or os.environ.get("LOVE_VPS_SITE") or creds.get("site") or DEFAULT_SITE

    missing = []
    if not host:
        missing.append("连接别名：--ssh-host，或环境变量 LOVE_VPS_SSH，"
                       "或在凭据文件里加一行「SSH 别名：<名字>」")
    if not domain:
        missing.append("域名：--domain，或环境变量 LOVE_SITE_HOST，或凭据文件的「域名」")
    if not web_root:
        missing.append("站点根：--root，或凭据文件的「网站根」")
    if missing:
        die("缺少必要参数：\n  - " + "\n  - ".join(missing))

    # 远端路径与配置名在渲染/拼脚本之前先收窄：这类值错了，后面所有"安全网"
    # （nginx -t、sha256 回读）都验不出来 —— 它们只验语法和"装上去的字节一致"。
    check_site_name(site)
    check_web_root("站点根（--root）", web_root)
    check_remote_path("PHP socket（--php-sock）", args.php_sock or "")

    if not os.path.isfile(TEMPLATE):
        die("找不到配置模板：%s" % TEMPLATE)

    print("==> 目标")
    print("    连接别名   : %s" % mask_secret(host))
    print("    域名       : %s（共 %d 字符）" % (mask_domain(domain), len(domain)))
    print("    站点根     : %s" % mask_path(web_root))
    print("    配置名     : %s" % site)

    if args.dry_run:
        sock = args.php_sock or "/run/php/php8.1-fpm.sock"
        print()
        print("==> [dry-run] 渲染后的配置（socket 用占位 %s）" % sock)
        print("-" * 64)
        print(render(domain, web_root, sock))
        print("-" * 64)
        print()
        print("==> [dry-run] 目录步骤")
        make_dirs(host, web_root, True)
        print()
        print("[dry-run] 未连接服务器，未修改任何东西。")
        return

    # ---- 1. 预检 ----
    print()
    # 与横幅同一口径：连接别名是敏感值，所有对外输出都打码（第七轮 S11-06）
    print("==> 1/3 预检 %s …" % mask_secret(host))
    mk = preflight(host, site, domain, web_root)
    print("    主机       : %s（%s）" % (mk.get("hostname", "?"), mk.get("os", "?")))
    print("    sudo 免密  : %s" % ("是" if mk.get("sudo") == "ok" else "否"))
    print("    nginx      : %s" % mk.get("nginx", "?"))
    print("    php-fpm    : %s（开机自启 %s）" % (mk.get("fpm", "?"), mk.get("fpm_enabled", "?")))
    print("    FPM socket : %s（pool 配置写的是 %s）" % (mk.get("sock", "?"), mk.get("sock_pool", "?")))
    if mk.get("sock_listen") not in ("", "none", None) and mk.get("sock_pool") not in ("none", ""):
        if mk.get("sock_listen") != mk.get("sock_pool"):
            print("                 ⚠ 两者不一致，已按「实际在监听的」写入配置")
    print("    证书       : %s" % ("已就位" if mk.get("cert") == "yes" else "**缺失**"))
    print("    站点根     : %s%s" % (mk.get("root_state", "?"),
                                   ("，属主 " + mk.get("root_owner", "?")) if mk.get("root_state") == "exists" else ""))
    print("    站点已启用 : %s" % mk.get("site_enabled", "?"))
    print("    剩余磁盘   : %s ；可用内存 %s MB" % (mk.get("disk", "?"), mk.get("mem", "?")))

    problems = []
    if mk.get("sudo") != "ok":
        problems.append("sudo 不是免密，脚本里的 `sudo -n` 会失败")
    if mk.get("nginx") in ("", "absent", None):
        problems.append("目标机没装 nginx")
    if mk.get("fpm") in ("", "none", None):
        problems.append("目标机没有正在运行的 php-fpm")
    if mk.get("sock_ok") != "yes":
        problems.append("探测不到可用的 PHP-FPM socket（需要显式给 --php-sock）")
    if mk.get("cert") != "yes":
        problems.append("找不到 /etc/letsencrypt/live/<域名>/fullchain.pem（先用 certbot 申请证书）")
    if mk.get("user") != "ok":
        problems.append("目标机上没有 %s 这个用户" % DEFAULT_USER)
    if problems:
        print()
        for p in problems:
            print("    ✗ %s" % p)
        die("预检未通过，已中止 —— **没有改动服务器任何东西**。")

    print("    ✓ 预检通过")
    php_sock = args.php_sock or mk.get("sock")

    if not args.dirs_only:
        print()
        print("==> 2/3 安装 nginx 配置（装前备份，失败自动回滚）…")
        install_conf(host, site, render(domain, web_root, php_sock), False)
        print("    ✓ 配置已生效并 reload")

    if not args.conf_only:
        print()
        print("==> 3/3 准备站点目录（只 install -d，不做 chown -R）…")
        make_dirs(host, web_root, False)
        print("    ✓ 目录就绪")

    print()
    print("初始化完成 ✓")
    print()
    print("  下一步：")
    print("    python tools/deploy_vps.py --creds \"<凭据文件>\" --with-media   # 首次铺站（含背景音乐）")
    print("    python tools/verify_vps.py --creds \"<凭据文件>\"                # 线上只读验收")
    print()
    print("  回滚 nginx 配置（登录服务器后）：")
    print("    ls -1 /etc/nginx/sites-available/%s.bak.*                        # 挑一个备份" % site)
    print("    sudo cp -a <备份> /etc/nginx/sites-available/%s" % site)
    print("    sudo nginx -t && sudo systemctl reload nginx")


if __name__ == "__main__":
    main()
