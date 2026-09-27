# -*- coding: utf-8 -*-
"""情侣网站部署脚本：dist/ → 自有服务器(VPS，SSH)

核心承诺（与 FTP 版 tools/deploy.py 完全一致）：
1. 只增不删：同步过程**不带 --delete**，机制上不可能删除服务器上的文件
2. 以下路径永远不上传（它们只属于服务器，由管理员后台维护）：
   - data/**                —— 管理员后台的全部自定义数据
   - assets/img/uploads/**  —— 上传的照片
   - assets/img/*.jpg|jpeg|png|webp —— 直接放进去的真实照片
   - assets/music/music.dat —— 背景音乐（加 --with-media 才带上，用于首次铺服务器）
3. 保护清单直接复用 tools/deploy.py 的 is_protected()（其内部就是那一份
   PROTECTED_PREFIXES / PROTECTED_EXACT / PHOTO_EXT），两条部署路径共用同一套
   定义，不会各自漂移。
4. 传完逐字节回读：本地生成 sha256 清单 → 服务器侧 `sha256sum -c` 全过才算成功
   （链路是 打包 → scp → 服务器侧 rsync，任一环出问题都不会自己报错）。

传输方式（为什么不是 rsync -e ssh）：
   本机 Git Bash **没有 rsync**，而服务器有。所以走「本地打 tar → scp 到 /tmp →
   服务器侧 rsync 解到站点目录」。这样做还有个好处：解压和同步都在服务器的
   临时目录里完成，上传中途断了也不会碰到线上目录。

用法：
    python tools/deploy_vps.py --creds "<凭据文件>"
    python tools/deploy_vps.py --creds "<文件>" --with-media    # 首次铺站，带上背景音乐
    python tools/deploy_vps.py --creds "<文件>" --dry-run       # 只列出将同步的文件，不连服务器
    python tools/deploy_vps.py --creds "<文件>" --no-build      # 跳过构建（dist 已存在）

取值优先级：命令行参数 > 环境变量 > 凭据文件（域名用不到，本脚本只需要 SSH 别名与站点根）。

注意：
  · 不部署 Apache 的 .htaccess 模板（deploy/*-htaccess）：nginx 根本不读它们，
    敏感目录保护由 deploy/vps/nginx.conf.template 里的 deny 规则承担；
    data/ 与 uploads/ 下的 .htaccess 由 lib/store.php 在运行时自己写。
  · 部署完不需要 reload php-fpm：PHP 的 opcache.validate_timestamps=On 会自动感知变更。
  · 首次铺站前先跑 tools/vps_setup.py（建目录 + 装 nginx 配置）。
  · 文件权限由 --chmod 固定成 目录 0755 / 文件 0644，**不**继承远端 umask
    （见 remote_deploy_script 里的说明）。
"""
import argparse
import hashlib
import os
import subprocess
import sys
import tarfile
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy import DIST, is_protected, mask_path, mask_secret      # noqa: E402
from vps_setup import (DEFAULT_SITE, SSH_BIN, check_remote_path, check_web_root,  # noqa: E402
                       die, parse_creds, read_text, scp_up, shq, ssh_run)

# 受保护但可以用 --with-media 显式放行的路径（仅这几个）
MEDIA_EXACT = ("assets/music/music.dat", "assets/music/music.mp3")

# 服务器侧 rsync 的额外排除（tar 里本来就没有这些，双保险防误放，与 FTP 版同思路）
RSYNC_EXCLUDES = ("/data/", "/assets/img/uploads/", "/.htaccess")

# 落地权限：目录 0755 / 文件 0644，由 rsync 在接收端强制设定。
# 为什么必须显式指定：本机（Windows）用 Python tarfile 打包时，成员权限位是
# **0666**（Windows 没有 unix 权限位可记），而远端解包的 umask 实测是 0002，
# 于是 tar 解出来是 0664、`rsync -a`（含 -p）会把它原样搬到站点根 ——
# 结果是 web 目录里所有程序文件对 www-data **组可写**：一旦接口被攻破，
# 攻击者可以直接改写站点自身的 PHP 文件做持久化；而且权限还取决于远端 umask
# （umask 000 的机器上会变成全局可写）。显式 --chmod 让结果与 umask 无关。
RSYNC_CHMOD = "Du=rwx,Dgo=rx,Fu=rw,Fgo=r"


def rsync_exclude_hit(rel):
    """rel 是否会被 RSYNC_EXCLUDES 挡下；挡下就返回那条规则，否则返回 ""。

    ⚠️ 这个函数存在的原因是一个"永远部署不动"的坑：清单（sha256sum -c 的依据）
    必须与 rsync 实际会写入的文件**严格一致**。旧版 collect() 只按 is_protected 过滤，
    而 rsync 另有三条 --exclude —— 一旦 dist/ 里真的出现 `.htaccess`（build.py 不排除它，
    FTP 那条路径还把它当正常程序文件传），它就会进清单、却被 rsync 跳过，
    于是 `sha256sum -c` 报 hash_mismatch、部署**每次都失败**，而报错指向"哈希不对"，
    完全看不出真因是排除规则。所以两个函数的过滤条件必须同源。"""
    rel = rel.replace("\\", "/")
    for pat in RSYNC_EXCLUDES:
        bare = pat.lstrip("/")
        if bare.endswith("/"):
            if rel.startswith(bare):
                return pat
        elif rel == bare:
            return pat
    return ""


def build_dist():
    print("==> 1/4 构建 dist/ …")
    # 必须先 flush：build.py 是子进程、直接写 fd，而本进程的 stdout 在被管道
    # 捕获时是块缓冲的，不 flush 会让子进程输出跑到自己的标题前面去（很难读）。
    sys.stdout.flush()
    subprocess.run([sys.executable, os.path.join(os.path.dirname(DIST), "tools", "build.py")], check=True)


def collect(with_media):
    """返回 (可用文件, 跳过清单)。跳过清单含两类：受保护路径 + 被 rsync 排除规则挡下的。"""
    if not os.path.isdir(DIST):
        die("找不到 %s。先跑 `python tools/build.py`，或去掉 --no-build。" % DIST)
    out = []
    skipped = []
    for dirpath, _dirnames, filenames in os.walk(DIST):
        for name in filenames:
            local = os.path.join(dirpath, name)
            rel = os.path.relpath(local, DIST).replace("\\", "/")
            if is_protected(rel):
                # 只有显式 --with-media 才放行媒体；照片类一律不放行（只有 FTP 版
                # 的"仅首次补传"逻辑碰它们，VPS 版走 rsync，没有安全的三态探测，
                # 所以干脆什么都不做，绝不冒险覆盖）
                if with_media and rel in MEDIA_EXACT:
                    pass
                else:
                    skipped.append(rel)
                    continue
            if rsync_exclude_hit(rel):
                # 与 rsync 同口径：不传、也不进校验清单（进了就必然 hash_mismatch）
                skipped.append(rel)
                continue
            out.append((local, rel, os.path.getsize(local)))
    out.sort(key=lambda t: t[1])
    return out, skipped


def make_tar(files):
    """打一个 gzip 压缩包。用 stdlib 的 tarfile 而不是调本机 tar：
    Windows 上 tar 的路径与 --exclude 行为容易出错，Python 这边能精确控制
    写进去的每一条 arcname。"""
    tmp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    path = os.path.join(tmp_dir, ".love-deploy-%s.tar.gz" % uuid.uuid4().hex[:10])
    with tarfile.open(path, "w:gz") as tf:
        for local, rel, _size in files:
            # arcname 必须是 posix 风格，且不带前导 ./
            tf.add(local, arcname=rel, recursive=False)
    return path


def sha256_full(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_head(path, n=12):
    return sha256_full(path)[:n]


def remote_cleanup(host, paths):
    """失败路径上尽力删掉远端的临时文件（载荷包/清单）。

    刻意不走 ssh_run：那条路径在连不上时会 die() 打印"错误：…"，
    而此时我们正在处理一个更重要的原始错误，跟着再喊一句会把真因冲淡。
    这里用 ssh 的 `rm -f` 直接命令形式（不经 shell），路径是 /tmp/.love-<hex>，
    不含空格与特殊字符。"""
    try:
        subprocess.run([SSH_BIN, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                        host, "rm", "-f"] + list(paths),
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except Exception:
        pass


def make_manifest(files):
    """生成 sha256sum 校验清单，供服务器侧 `sha256sum -c` 逐字节回读。

    为什么需要：链路是「本地打包 → scp → 服务器侧 rsync」，任何一环出问题
    （打包少文件、rsync 被 exclude 规则静默跳过、传输截断）都不会自己报错，
    只有把落地后的文件重新哈希一遍才能证明"线上这份就是本地这份"。
    这正是 FTP 那条路径踩过的坑：当时靠 SHA 回读才发现有文件被漏推。
    没有被读回时，`--stats` 里的 "N files transferred" 只说明 rsync 觉得该传几个，
    说明不了它们的内容对不对。"""
    tmp_dir = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    path = os.path.join(tmp_dir, ".love-manifest-%s.txt" % uuid.uuid4().hex[:10])
    lines = []
    for local, rel, _size in files:
        name = rel
        if "\\" in name or "\n" in name:
            # GNU coreutils 的转义格式：整行加前导反斜杠，文件名里的 \ 与换行转义
            name = name.replace("\\", "\\\\").replace("\n", "\\n")
            lines.append("\\%s  %s" % (sha256_full(local), name))
        else:
            lines.append("%s  %s" % (sha256_full(local), name))
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return path


def remote_deploy_script(web_root, tar_path, manifest_path):
    """远端：解到临时目录 → rsync 进站点根（**不带 --delete**）→ 交属主 →
    逐字节回读校验 → 清理。

    为什么用 rsync 而不是直接 tar 解到站点根：rsync 能只写真正变化的文件
    （--checksum 按内容判断，不受 build.py 每次重写 mtime 的影响），
    而且"没写 --delete"是一个**显式**的只增不删声明，比 tar 覆盖的隐式行为好审计。"""
    return r"""
set -u
WEBROOT=%(root)s
TAR=%(tar)s
MANIFEST=%(manifest)s
STAGE=$(mktemp -d /tmp/.love-stage-XXXXXX) || { echo "FAIL mktemp"; exit 1; }
trap 'rm -rf "$STAGE"; rm -f "$TAR" "$MANIFEST"' EXIT

echo "STEP unpack"
if ! tar xzf "$TAR" -C "$STAGE"; then echo "FAIL unpack"; exit 1; fi
N=$(find "$STAGE" -type f | wc -l)
echo "OK unpacked=$N files"

echo "STEP rsync"
# -a 保留时间；--chmod 在接收端把权限钉成 目录755/文件644（见脚本头部说明：
# 不钉的话结果取决于远端 umask，实测会落到组可写的 0664）；
# --checksum 按内容判断是否需要传（build.py 每次重建 dist，mtime 全是构建时刻，
# 靠 mtime 比会每次都全量重传）；--chown 直接把属主交给 www-data；
# **绝对不加 --delete**。
if sudo rsync -a --checksum --chmod=%(chmod)s --chown=%(user)s:%(user)s --stats \
     $(for e in %(excl)s; do printf -- '--exclude=%%s ' "$e"; done) \
     "$STAGE"/ "$WEBROOT"/; then
  echo "OK rsync"
else
  echo "FAIL rsync"; exit 1
fi

echo "STEP verify-hash"
# 回读线上文件的 sha256，与本地清单逐条比对。在站点根里执行，清单里是相对路径。
cd "$WEBROOT" || { echo "FAIL cd"; exit 1; }
if OUT=$(sha256sum -c "$MANIFEST" 2>&1); then
  echo "OK hash_ok=$(printf '%%s\n' "$OUT" | grep -c ': OK$')"
else
  echo "FAIL hash_mismatch"
  printf '%%s\n' "$OUT" | grep -v ': OK$' | head -20
  exit 1
fi

echo "STEP stats"
echo "OK total_files=$(find "$WEBROOT" -type f | wc -l)"
echo "OK total_bytes=$(du -sb "$WEBROOT" | cut -f1)"
echo "OK owner=$(stat -c '%%U:%%G' "$WEBROOT")"
echo "OK modes=$(stat -c '%%a' "$WEBROOT")"
echo "MARK DONE"
""" % {
        "root": shq(web_root),
        "tar": shq(tar_path),
        "manifest": shq(manifest_path),
        "user": shq("www-data"),
        "chmod": RSYNC_CHMOD,
        "excl": " ".join(RSYNC_EXCLUDES),
    }


def main():
    ap = argparse.ArgumentParser(description="情侣网站 VPS 部署（SSH，只增不删，保护自定义内容）")
    ap.add_argument("--creds", default="", help="凭据文件路径（仓库外）")
    ap.add_argument("--ssh-host", default="", help="~/.ssh/config 里的 Host 别名（或 LOVE_VPS_SSH）")
    ap.add_argument("--root", default="", help="站点根目录（或 LOVE_VPS_ROOT / 凭据文件的「网站根」）")
    ap.add_argument("--no-build", action="store_true", help="跳过构建（使用现有 dist/）")
    ap.add_argument("--with-media", action="store_true",
                    help="连背景音乐一起传（assets/music/music.dat）。仅首次铺服务器时用")
    ap.add_argument("--dry-run", action="store_true", help="只列出将同步的文件，不连服务器、不改任何东西")
    args = ap.parse_args()

    creds = parse_creds(read_text(args.creds)) if args.creds else {}
    host = args.ssh_host or os.environ.get("LOVE_VPS_SSH") or creds.get("ssh") or ""
    web_root = args.root or os.environ.get("LOVE_VPS_ROOT") or creds.get("root") or ""

    missing = []
    if not host:
        missing.append("连接别名：--ssh-host，或环境变量 LOVE_VPS_SSH，"
                       "或在凭据文件里加一行「SSH 别名：<名字>」")
    if not web_root:
        missing.append("站点根：--root，或凭据文件的「网站根」")
    if missing:
        die("缺少必要参数：\n  - " + "\n  - ".join(missing))

    # 见 vps_setup.REMOTE_PATH_HINT：Git Bash 会把 "/开头" 的 argv 改写成 Windows 路径，
    # 装错之后 rsync/sha256 回读都"成功"（文件确实传了，只是传到了错的地方）。
    # 两道守卫都在连服务器之前，分开写是刻意的：
    #   check_remote_path —— 形态（绝对路径 + 无冒号），既有回归断言按这个名字找它；
    #   check_web_root    —— 取值下限（拒绝 / 与 /usr、/etc 这类系统目录，第七轮 S11-07。
    #                        它会先把形态那道再走一遍）。
    check_remote_path("站点根（--root）", web_root)
    check_web_root("站点根（--root）", web_root)

    if args.dry_run:
        # 文档承诺 --dry-run「不改任何东西」，那就不该顺手重建 dist/
        # （build.py 会 rmtree 输出目录再重写，属于改本地文件）。
        if not os.path.isdir(DIST):
            die("--dry-run 不构建 dist/（它承诺不改任何东西）。先跑 python tools/build.py 再来，"
                "或加 --no-build 明确表示用现有的 dist/。")
        print("==> 1/4 [dry-run] 不构建，直接列现有 dist/ 的清单"
              "（要刷新产物请先跑 python tools/build.py）")
        print()
    elif not args.no_build:
        build_dist()
        print()
    else:
        print("==> 1/4 跳过构建（--no-build）")
        print()

    files, skipped = collect(args.with_media)
    if not files:
        die("没有可部署的文件（dist/ 是空的？）")

    total = sum(s for _l, _r, s in files)
    print("==> 2/4 准备载荷")
    print("    待部署   : %d 个文件，%.1f KB" % (len(files), total / 1024.0))
    print("    跳过保护 : %d 项%s" % (len(skipped), "（含背景音乐，未加 --with-media）"
                                     if not args.with_media else ""))
    if skipped:
        for rel in skipped[:8]:
            print("      - %s" % rel)
        if len(skipped) > 8:
            print("      … 另有 %d 项" % (len(skipped) - 8))

    if args.with_media:
        # --with-media 是"允许覆盖音乐"的开关，不是"顺便带上"：服务器上如果换过歌，
        # 这一跑就把你们现在听的那首换回仓库里那份了。所以每次都要显式提醒。
        explicit = [rel for _l, rel, _s in files if rel in MEDIA_EXACT]
        if explicit:
            print()
            print("    ⚠ --with-media 会**覆盖**服务器上现有的背景音乐：")
            for rel in explicit:
                print("      - %s" % rel)
            print("      只在首次铺服务器（或确实要换回仓库里那份）时用；")
            print("      若服务器上的歌是后来单独换的，请去掉这个参数重跑。")

    if args.dry_run:
        print()
        print("==> [dry-run] 将同步的文件清单")
        for _local, rel, size in files:
            print("    %8d  %s" % (size, rel))
        print()
        print("[dry-run] 未连接服务器，未修改任何东西。")
        return

    tar_path = make_tar(files)
    manifest_path = make_manifest(files)
    tar_size = os.path.getsize(tar_path)
    print("    载荷包   : %.1f KB（压缩后），sha256 %s…" % (tar_size / 1024.0, sha256_head(tar_path)))
    print("    校验清单 : %d 条 sha256（传完在服务器侧逐条回读）" % len(files))

    token = uuid.uuid4().hex[:10]
    remote_tar = "/tmp/.love-deploy-%s.tar.gz" % token
    remote_manifest = "/tmp/.love-manifest-%s.txt" % token

    done = False
    try:
        print()
        print("==> 3/4 上传到 %s 并同步到 %s（只增不删）…"
              % (mask_secret(host), mask_path(web_root)))
        scp_up(tar_path, host, remote_tar, timeout=600)
        scp_up(manifest_path, host, remote_manifest, timeout=120)
        rc, out = ssh_run(host, remote_deploy_script(web_root, remote_tar, remote_manifest), timeout=900)
        if rc != 0 or "MARK DONE" not in out:
            die("远端同步失败（退出码 %d）。线上目录只可能多出文件，不会有文件被删；"
                "哈希回读不过的话上面会打出对不上的具体文件。" % rc)
        done = True
    finally:
        for p in (tar_path, manifest_path):
            try:
                os.remove(p)
            except OSError:
                pass
        if not done:
            # 远端那个 trap 只在 rsync 脚本真正跑起来时才生效 —— scp 中途失败的话
            # /tmp 里会留下载荷包/清单（含站点文件内容）。这里尽力清一次：
            # 清理失败不能掩盖原始错误，所以不打印、不抛。
            remote_cleanup(host, (remote_tar, remote_manifest))

    print()
    print("==> 4/4 部署完成 ✓")
    print("    同步了 %d 个文件（%.1f KB），服务器侧已逐字节回读校验通过" % (len(files), total / 1024.0))
    print()
    print("【更新保护规则 · 请牢记】")
    print("  本次未上传、也不会删除服务器上的自定义内容：")
    print("    data/                    —— 管理员后台的配置/留言/情书/照片记录")
    print("    assets/img/uploads/      —— 上传的照片文件")
    print("    assets/img/*.jpg|png|webp —— 直接放入的真实照片（VPS 版一律不碰）")
    print("    assets/music/music.dat   —— 背景音乐（要传得显式加 --with-media）")
    print()
    print("  下一步：")
    print("    python tools/verify_vps.py --creds \"<凭据文件>\"    # 线上只读验收")
    print("    浏览器打开 https://<域名>/admin/ 创建管理员账号（首次）。")


if __name__ == "__main__":
    main()
