# -*- coding: utf-8 -*-
"""情侣网站部署脚本：dist/ → InfinityFree（FTP）

核心承诺（"更新永不破坏服务器自定义内容"）：
1. 只上传、绝不删除远程文件
2. 以下路径永远跳过（它们只属于服务器，由管理员后台维护）：
   - data/**              —— 管理员后台的全部自定义数据
   - assets/img/uploads/** —— 上传的照片
   - assets/img/*.jpg|jpeg|png|webp —— 直接放进去的真实照片
   - assets/music/music.mp3 —— 背景音乐
3. 每次部署都会把 data/.htaccess 与 assets/img/uploads/.htaccess
   保护模板同步上去（幂等，重复跑无副作用）

用法：
    python tools/deploy.py --creds "我的服务器\\love.infinityfreeapp.com服务器\\服务器.txt"
    python tools/deploy.py --creds <文件> --no-build   # 跳过构建（dist 已存在时）
    python tools/deploy.py --creds <文件> --remote htdocs  # 远程基目录（默认自动探测）

凭据文件格式（标签换行，见 服务器.txt）：
    FTP 主机名
    ftpupload.net
    FTP 用户名
    xxx
    FTP 密码
    xxx
    FTP端口（可选）
    21
"""
import argparse
import ftplib
import os
import posixpath
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 需要同步到服务器、但不在 dist 里的保护模板: (本地相对路径, 远程相对路径)
EXTRA_FILES = [
    ("deploy/data-htaccess", "data/.htaccess"),
    ("deploy/uploads-htaccess", "assets/img/uploads/.htaccess"),
]

# 保护路径: 命中则跳过（dist 里本来也没有，双保险防误放）
PROTECTED_PREFIXES = ("data/", "assets/img/uploads/")
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".webp")
PROTECTED_EXACT = ("assets/music/music.mp3",)


def is_protected(rel):
    rel = rel.replace("\\", "/")
    if rel.startswith(PROTECTED_PREFIXES):
        return True
    if rel in PROTECTED_EXACT:
        return True
    if rel.startswith("assets/img/") and rel.endswith(PHOTO_EXT):
        return True
    return False


def load_creds(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()

    def grab(*labels):
        for lab in labels:
            m = re.search(re.escape(lab) + r"\s*[:：]?\s*([^\r\n]+)", text)
            if m and m.group(1).strip():
                return m.group(1).strip()
        return ""

    host = grab("FTP 主机名", "主机名") or grab("Host", "host")
    user = grab("FTP 用户名", "FTP 账号", "用户名")
    pwd = grab("FTP 密码", "FTP 口令", "密码")
    port = grab("FTP端口（可选）", "FTP 端口", "端口") or "21"
    if not host or not user or not pwd:
        sys.exit("凭据解析失败：请在文件中提供 FTP 主机名 / FTP 用户名 / FTP 密码")
    return host, user, pwd, int(port)


def mkdrs(ftp, path):
    """递归创建远程目录（已存在则忽略）"""
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur = posixpath.join(cur, p) if cur else p
        try:
            ftp.mkd(cur)
        except ftplib.error_perm:
            pass  # 已存在


def detect_remote_base(ftp, prefer):
    """探测远程基目录: 优先 prefer, 否则看根目录里有没有 htdocs。
    注意: NLST('/') 可能返回 '/htdocs' 或 'htdocs', 需归一化。"""
    if prefer:
        return prefer
    try:
        names = [n.lstrip("/") for n in ftp.nlst("/")]
    except Exception:
        names = []
    if "htdocs" in names:
        return "htdocs"
    return ""  # FTP 根目录即站点根


def main():
    ap = argparse.ArgumentParser(description="情侣网站 FTP 部署（只增不删，保护自定义内容）")
    ap.add_argument("--creds", required=True, help="FTP 凭据文件路径（仓库外）")
    ap.add_argument("--no-build", action="store_true", help="跳过构建（使用现有 dist/）")
    ap.add_argument("--remote", default="", help="远程基目录（默认自动探测 htdocs）")
    ap.add_argument("--host", default="", help="覆盖 FTP 主机名")
    ap.add_argument("--port", type=int, default=0, help="覆盖 FTP 端口")
    args = ap.parse_args()

    if not args.no_build:
        print("==> 1/2 构建 dist/ …")
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py")], check=True)

    host, user, pwd, port = load_creds(args.creds)
    if args.host:
        host = args.host
    if args.port:
        port = args.port

    print("==> 2/2 上传到 %s（只上传，不删除远程文件）…" % host)
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=30)
    ftp.login(user, pwd)
    ftp.set_pasv(True)

    base = detect_remote_base(ftp, args.remote)
    if base:
        print("    远程基目录: /%s" % base)

    uploaded = skipped = 0
    for dirpath, dirnames, filenames in os.walk(DIST):
        for name in filenames:
            local = os.path.join(dirpath, name)
            rel = os.path.relpath(local, DIST).replace("\\", "/")
            if is_protected(rel):
                skipped += 1
                continue
            remote = posixpath.join(base, rel) if base else rel
            mkdrs(ftp, posixpath.dirname(remote))
            with open(local, "rb") as f:
                ftp.storbinary("STOR " + remote, f)
            uploaded += 1
            print("    ↑ %s" % rel)

    for local, remote in EXTRA_FILES:
        src = os.path.join(ROOT, local)
        dst = posixpath.join(base, remote) if base else remote
        mkdrs(ftp, posixpath.dirname(dst))
        with open(src, "rb") as f:
            ftp.storbinary("STOR " + dst, f)
        print("    ↑ %s （保护模板）" % remote)

    ftp.quit()

    print()
    print("部署完成 ✓  上传 %d 个文件，跳过保护内容 %d 项" % (uploaded, skipped))
    print()
    print("【更新保护规则 · 请牢记】")
    print("  本次未上传、也不会删除服务器上的自定义内容：")
    print("    data/                  —— 管理员后台的配置/留言/情书/照片记录")
    print("    assets/img/uploads/    —— 上传的照片文件")
    print("    assets/img/*.jpg|png|webp —— 直接放入的真实照片")
    print("    assets/music/music.mp3 —— 背景音乐")
    print("  今后每次更新都跑本脚本即可，自定义内容永不丢失。")
    print("  下一步：浏览器打开 https://<你的域名>/admin/ 创建管理员账号。")


if __name__ == "__main__":
    main()
