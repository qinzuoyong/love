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
    python tools/deploy.py --creds "<仓库外的凭据文件>"
    python tools/deploy.py --creds <文件> --no-build   # 跳过构建（dist 已存在时）
    python tools/deploy.py --creds <文件> --remote htdocs  # 远程基目录（默认自动探测）

退出码：全部传成功 = 0；只要有文件没传上去（或 dist/ 为空）= 1，
并且不再打印「部署完成 ✓」—— 失败必须对调用方（含自动化）可见。

凭据文件格式（标签与值可同行也可换行）：
    FTP 主机名
    ftp.example.com
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
# 受保护的真实照片后缀。必须与服务器侧口径一致：deploy/.htaccess 与
# deploy/vps/nginx.conf.template 的图片直链拒绝规则都含 gif，photo.php 的白名单
# 也放行 gif。这里漏掉 gif 的话，assets/img/ 下的 .gif 会被当成普通静态文件
# 无条件覆盖 —— 打破"绝不覆盖服务器上的真实照片"这条唯一的部署契约。
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif")
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
    # 后缀比较必须忽略大小写：相机与 Windows 导出的文件名常是 IMG_1234.JPG，
    # 而服务器侧（.htaccess / nginx）的图片拒绝规则都是不区分大小写的（~*）。
    # 这里若区分大小写，那个文件就不算"照片"，会走普通同步被覆盖 ——
    # 而"绝不覆盖服务器上的照片"正是本函数存在的唯一理由。
    if rel.startswith("assets/img/") and rel.lower().endswith(PHOTO_EXT):
        return True
    return False


def mask_secret(text, keep=4):
    """脱敏回显：只露最后 4 个字符（短值露 2 个）。

    部署日志既是人工排查的主要途径，也最容易被贴进聊天/issue；按本项目的脱敏
    红线，域名、端口、服务器路径都不该明文落到日志里。`vps_setup.mask_domain`
    本来只给域名打了码，这里把同一套口径抽成单一实现，主机名/路径共用
    （`vps_setup.mask_domain` 现在也委托到这里，两边不会再各写一份）。
    """
    text = text or ""
    if not text:
        return ""
    k = text[-4:] if len(text) > 8 else text[-2:]
    return "*" * max(len(text) - len(k), 3) + k


def mask_path(path):
    """站点绝对路径脱敏：保留首段与末段（`/home/u12345/htdocs` → `/home/…/htdocs`）。

    路径里最敏感的是**中间那段**（通常是站点号 / 用户名：`/home/u12345/…`），
    首段与末段正是排查时要看的（是不是 /home、末尾是不是 htdocs / public_html）。
    ⚠️ 只留首段是必须的：写成"保留首两段"就会把 `/home/u12345/…` 里的站点号
    原样带出来（第一版就是这么写的，断言当场抓住）。
    两段以内的路径原样返回 —— 没有可藏的中间段，遮成 `***` 反而看不出是什么。
    """
    p = (path or "").replace("\\", "/")
    parts = [x for x in p.split("/") if x]
    if len(parts) <= 2:
        return p
    return ("/" if p.startswith("/") else "") + parts[0] + "/…/" + parts[-1]


def clean_cred_value(raw):
    """裁掉值尾部的说明文字（凭据文件里常见写法是 `ftp.x.com（免费主机）`）。

    必须与 `vps_setup.clean_value()` 同口径：同一份凭据文件会同时喂给 FTP 路径
    与 VPS 路径，两边解析出不同的值就会一边能跑、一边报一个看不出真因的错
    （主机名带着全角括号去做 DNS，报的是 FTPS 连接失败）。

    ⚠️ 只用于**非密值**（主机名 / 端口）。密码不能过这个函数：合法口令里出现
    括号或空格是完全允许的，裁剪会把真口令静默改坏，而它失败时的表现只是
    `530 Login incorrect`，没人能猜到原因在解析这一层。
    """
    v = (raw or "").strip()
    for ch in ("（", "("):
        i = v.find(ch)
        if i > 0:
            v = v[:i]
    parts = v.split()
    return parts[0] if parts else ""


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

    # 主机名与端口走统一口径（裁掉尾部说明文字）；用户名与密码保持逐字原样
    host = clean_cred_value(grab("FTP 主机名", "FTP主机名", "主机名", "Host", "host"))
    user = grab("FTP 用户名", "FTP用户名", "FTP 账号", "用户名")
    pwd = grab("FTP 密码", "FTP密码", "FTP 口令", "密码")
    port = clean_cred_value(grab("FTP端口（可选）", "FTP端口", "FTP 端口", "端口")) or "21"
    if not host or not user or not pwd:
        sys.exit("凭据解析失败：请在文件中提供 FTP 主机名 / FTP 用户名 / FTP 密码")
    try:
        port = int(port)
    except ValueError:
        sys.exit("FTP 端口不是数字：%r\n"
                 "（提示：端口只写数字本身，别带括号说明，例如写 21 而不是 21（可选））" % port)
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

    # dist/ 为空时绝不能报成功：`--no-build` 配一个空（或不存在）的 dist 会让整轮部署
    # 一个站点文件都不更新，旧实现却照样打印「部署完成 ✓」并以 0 退出 —— 自动化调用方
    # 完全看不见。VPS 路径有这条守卫（deploy_vps.py 的「没有可部署的文件」），这里补上。
    if sum(len(files) for _dirpath, _dirnames, files in os.walk(DIST)) == 0:
        sys.exit("没有可部署的文件：%s 里一个文件都没有（忘了构建？去掉 --no-build 重跑）" % DIST)

    host, user, pwd, port = load_creds(args.creds)
    if args.host:
        host = args.host
    if args.port:
        port = args.port

    print("==> 2/2 上传到 %s（只上传，不删除远程文件）…" % mask_secret(host))
    ftp = open_ftp(host, port, user, pwd, no_tls=args.no_tls)
    ftp.set_pasv(True)

    base = detect_remote_base(ftp, args.remote)
    if base:
        print("    远程基目录: /%s" % base)

    def remote_file_state(path):
        """这个文件在服务器上处于什么状态："present" / "absent" / "unknown"。
        只有明确 "absent" 才允许上传：受保护的真实照片绝不能因为"探测不出来"
        就被当成"服务器上没有"而覆盖掉。部分免费主机禁用了 SIZE，而旧实现用
        `ftp.size(...) is None` 当判断条件，把"命令不支持/出错"与"文件不存在"
        混为一谈 —— 那种主机上每次部署都会重传并覆盖服务器上的照片。
        先问 SIZE（最省事），失败**一律**再列一次父目录核对文件名；都失败才算
        unknown。**不看 SIZE 的错误码**：550 的常见含义确实是"文件不存在"，但
        RFC 959 的 550 也含 "no access"，部分主机把"命令不允许 / ACL 拒绝"也
        表示成 550 —— 旧写法据此直接返回 absent、跳过复核，于是 STOR 会把服务器上
        那份真实照片覆盖掉（不可逆，第七轮 S11-09）。多列一次目录换来"absent
        一定是真的不存在"，而 unknown 一律不传。
        注意别用 cwd() 去试父目录 —— 那会改变连接的工作目录，之后所有相对路径的
        STOR 都会落到错的地方。"""
        try:
            if ftp.size(path) is not None:
                return "present"
        except Exception:  # noqa
            # 降级到下面的父目录复核（见 docstring：不按错误码下结论）
            pass
        parent = posixpath.dirname(path)
        want = posixpath.basename(path)
        try:
            names = ftp.nlst(parent if parent else ".")
        except Exception:  # noqa
            return "unknown"
        for n in (names or []):
            if posixpath.basename(str(n).rstrip("/")) == want:
                return "present"
        return "absent"

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
    uncertain_photos = 0
    # 失败必须可见：upload() 的 False 以前被整个丢掉，于是「3 次都没传上去」
    # 与「传上去了」在结尾的汇总里长得一模一样（都只是打印，退出码恒为 0）。
    failures = []
    try:
        for dirpath, dirnames, filenames in os.walk(DIST):
            for name in filenames:
                local = os.path.join(dirpath, name)
                rel = os.path.relpath(local, DIST).replace("\\", "/")
                remote = posixpath.join(base, rel) if base else rel
                if is_protected(rel):
                    # 真实照片：只在服务器上"确认还没有"时补传一次（绝不覆盖服务器上的照片）
                    # 后缀比较同样要忽略大小写：IMG_1234.JPG 在 is_protected() 里算照片，
                    # 这里若区分大小写就会连提示都不打地静默跳过（少传一张没人看得出来）。
                    if rel.startswith("assets/img/") and rel.lower().endswith(PHOTO_EXT):
                        state = remote_file_state(remote)
                        if state == "absent":
                            if upload(local, remote):
                                added_photos += 1
                                print("    ↑ %s （首次补传，服务器原本没有）" % rel)
                            else:
                                failures.append(rel)
                        elif state == "unknown":
                            uncertain_photos += 1
                            print("    ⚠ %s （探测不到服务器上是否已有：按「绝不覆盖」契约跳过，"
                                  "需要的话请手动上传）" % rel)
                    skipped += 1
                    continue
                if upload(local, remote):
                    uploaded += 1
                    print("    ↑ %s" % rel)
                else:
                    failures.append(rel)

        for local, remote in EXTRA_FILES:
            src = os.path.join(ROOT, local)
            dst = posixpath.join(base, remote) if base else remote
            if upload(src, dst):
                print("    ↑ %s （保护/站点配置模板）" % remote)
            else:
                failures.append(remote)
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa
            try:
                ftp.close()
            except Exception:  # noqa
                pass

    if failures:
        print()
        print("部署未完成 ✗  有 %d 个文件没传上去（服务器上它们仍是旧版本或根本不存在）：" % len(failures))
        for rel in failures[:20]:
            print("    ✗ %s" % rel)
        if len(failures) > 20:
            print("    … 另有 %d 个" % (len(failures) - 20))
        print()
        print("  本脚本只增不删：已传上去的会重传，服务器上的自定义内容不受影响，修好后重跑即可。")
        sys.exit(1)

    print()
    print("部署完成 ✓  上传 %d 个文件（含首次补传照片 %d 张），跳过保护内容 %d 项" % (uploaded, added_photos, skipped))
    if uncertain_photos:
        print("  ⚠ 另有 %d 张受保护照片探测不到服务器状态已跳过（绝不覆盖）：请手动确认后在服务器上处理"
              % uncertain_photos)
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
