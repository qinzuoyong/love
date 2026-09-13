# -*- coding: utf-8 -*-
"""情侣网站部署脚本：dist/ → InfinityFree（FTP）

核心承诺（"更新永不破坏服务器自定义内容"）：
1. 只上传、绝不删除远程文件
2. 以下路径永远跳过（它们只属于服务器，由管理员后台维护）：
   - data/**              —— 管理员后台的全部自定义数据
   - assets/img/uploads/** —— 上传的照片
   - assets/img/*.jpg|jpeg|png|webp —— 直接放进去的真实照片
   - assets/music/music.dat —— 背景音乐（扩展名不用 .mp3 是刻意的：主机按扩展名
     给音频强加 no-store 禁缓存；旧 music.mp3 同样受保护，留给带旧缓存的访客）
3. 每次部署都会把 data/.htaccess 与 assets/img/uploads/.htaccess
   保护模板同步上去（幂等，重复跑无副作用）

用法：
    python tools/deploy.py --creds "我的服务器\\服务器.txt"
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
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 需要同步到服务器、但不在 dist 里的保护模板: (本地相对路径, 远程相对路径)
EXTRA_FILES = [
    ("deploy/data-htaccess", "data/.htaccess"),
    ("deploy/uploads-htaccess", "assets/img/uploads/.htaccess"),
    ("deploy/.htaccess", ".htaccess"),          # 根目录压缩/缓存/安全头（程序文件，可覆盖）
]

# 保护路径: 命中则跳过（dist 里本来也没有，双保险防误放）
PROTECTED_PREFIXES = ("data/", "assets/img/uploads/")
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".webp")
PROTECTED_EXACT = ("assets/music/music.dat", "assets/music/music.mp3")

# 凭据文件里的标签（长的在前，避免"FTP 密码"被"密码"抢先匹配）
CRED_LABELS = (
    "FTP 主机名", "FTP主机名", "FTP 用户名", "FTP用户名", "FTP 密码", "FTP密码",
    "FTP端口（可选）", "FTP端口", "FTP 端口", "主机名", "用户名", "密码", "端口", "Host", "host",
)


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
    """解析凭据文件（标签/值可同行也可分行；自动识别 utf-8 / GBK 编码）"""
    if not os.path.isfile(path):
        sys.exit("凭据文件不存在：%s" % path)
    raw = open(path, "rb").read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "big5", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        sys.exit("凭据文件编码无法识别（请另存为 UTF-8 或 GBK）")

    lines = [ln.strip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]

    def is_label(s):
        return any(s.startswith(lab) for lab in CRED_LABELS)

    def grab(*labels):
        for i, line in enumerate(lines):
            lab = next((l for l in labels if line.startswith(l)), None)
            if lab is None:
                continue
            rest = line[len(lab):].strip(" :：\t")
            if rest:
                return rest
            for j in range(i + 1, len(lines)):      # 值在下一行
                if not lines[j]:
                    continue
                if is_label(lines[j]):
                    break
                return lines[j]
        return ""

    host = grab("FTP 主机名", "FTP主机名", "主机名", "Host", "host")
    user = grab("FTP 用户名", "FTP用户名", "FTP 账号", "用户名")
    pwd = grab("FTP 密码", "FTP密码", "FTP 口令", "密码")
    port = grab("FTP端口（可选）", "FTP端口", "FTP 端口", "端口") or "21"
    if not host or not user or not pwd:
        sys.exit("凭据解析失败：请在文件中提供 FTP 主机名 / FTP 用户名 / FTP 密码")
    try:
        port = int(port)
    except ValueError:
        sys.exit("FTP 端口不是数字：%r" % port)
    return host, user, pwd, port


def open_ftp(host, port, user, pwd, no_tls=False):
    """建立 FTP 连接（默认要求加密）。

    明文 FTP 会把用户名和密码暴露在网络上，所以这里**不再自动降级**：
    FTPS 握手失败就直接停下，由人显式决定要不要用 --no-tls 走明文
    （旧行为是打印一行警告后自己回退明文，等于把安全决策悄悄做掉了）。
    --no-tls：跳过 FTPS，直接明文。"""
    if not no_tls:
        try:
            ftp = ftplib.FTP_TLS()
            ftp.connect(host, port, timeout=30)
            ftp.login(user, pwd)
            if hasattr(ftp, "prot_p"):
                ftp.prot_p()
            print("    连接方式: FTPS（已加密）")
            return ftp
        except Exception as e:  # noqa
            try:
                ftp.close()
            except Exception:  # noqa
                pass
            sys.exit("FTPS 连接失败：%s\n"
                     "本项目默认要求加密传输（避免 FTP 用户名/密码走明文）。\n"
                     "若该主机确实不支持 FTPS，请显式加 --no-tls 改用明文 FTP（风险自担）。" % e)
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=30)
    ftp.login(user, pwd)
    return ftp


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
    # 加密传输是默认行为，不需要也不能靠参数切换；--tls 只作为旧命令行的兼容别名保留。
    # 两者互斥是必须的：否则 `--tls --no-tls` 会静默按明文跑，等于替用户把安全决策做掉了。
    tlsg = ap.add_mutually_exclusive_group()
    tlsg.add_argument("--tls", action="store_true", help="（默认即要求 FTPS，保留该参数仅为兼容旧命令）")
    tlsg.add_argument("--no-tls", action="store_true", help="跳过 FTPS，直接用明文 FTP（凭据将以明文传输，风险自担）")
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
    ftp = open_ftp(host, port, user, pwd, no_tls=args.no_tls)
    ftp.set_pasv(True)

    base = detect_remote_base(ftp, args.remote)
    if base:
        print("    远程基目录: /%s" % base)

    def remote_size(path):
        """远程文件大小；不存在/无权限返回 None"""
        try:
            return ftp.size(path)
        except Exception:
            return None

    def upload(local_path, remote_path, tries=3):
        """带重试的上传（网络抖动时不会传一半就放弃）"""
        last = None
        for n in range(tries):
            try:
                mkdrs(ftp, posixpath.dirname(remote_path))
                with open(local_path, "rb") as f:
                    ftp.storbinary("STOR " + remote_path, f)
                return True
            except Exception as e:  # noqa
                last = e
        print("    ✗ 上传失败 %s：%s" % (remote_path, last))
        return False

    uploaded = skipped = 0
    added_photos = 0
    try:
        for dirpath, dirnames, filenames in os.walk(DIST):
            for name in filenames:
                local = os.path.join(dirpath, name)
                rel = os.path.relpath(local, DIST).replace("\\", "/")
                remote = posixpath.join(base, rel) if base else rel
                if is_protected(rel):
                    # 真实照片：只在服务器上"还没有"时补传一次（绝不覆盖服务器上的照片）
                    if rel.startswith("assets/img/") and rel.endswith(PHOTO_EXT):
                        if remote_size(remote) is None:
                            if upload(local, remote):
                                added_photos += 1
                                print("    ↑ %s （首次补传，服务器原本没有）" % rel)
                    skipped += 1
                    continue
                if upload(local, remote):
                    uploaded += 1
                    print("    ↑ %s" % rel)

        for local, remote in EXTRA_FILES:
            src = os.path.join(ROOT, local)
            dst = posixpath.join(base, remote) if base else remote
            if upload(src, dst):
                print("    ↑ %s （保护/站点配置模板）" % remote)
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa
            try:
                ftp.close()
            except Exception:  # noqa
                pass

    print()
    print("部署完成 ✓  上传 %d 个文件（含首次补传照片 %d 张），跳过保护内容 %d 项" % (uploaded, added_photos, skipped))
    print()
    print("【更新保护规则 · 请牢记】")
    print("  本次未上传、也不会删除服务器上的自定义内容：")
    print("    data/                  —— 管理员后台的配置/留言/情书/照片记录")
    print("    assets/img/uploads/    —— 上传的照片文件")
    print("    assets/img/*.jpg|png|webp —— 直接放入的真实照片（仅首次补传，不覆盖）")
    print("    assets/music/music.dat —— 背景音乐（旧 music.mp3 也在保护清单，只留不传）")
    print("  今后每次更新都跑本脚本即可，自定义内容永不丢失。")
    print("  下一步：浏览器打开 https://<你的域名>/admin/ 创建管理员账号。")


if __name__ == "__main__":
    main()
