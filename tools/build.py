# -*- coding: utf-8 -*-
"""情侣网站构建脚本：生成可部署的 dist/ 目录

作用：
1. 把整个网站复制到 dist/（部署时传 dist/ 里的内容即可）
2. 给 HTML 中引用的静态资源（css/js/图片）自动加版本戳 ?v=<内容md5前8位>
   - 文件内容改了 → 版本号自动变 → 浏览器必定拉新文件（部署后更新即时生效）
   - 文件没改 → 版本号不变 → 浏览器复用缓存（省流量、加载快）

用法：
    python tools/build.py          # 输出到 dist/
    python tools/build.py -o out   # 自定义输出目录

注意：原目录不会被修改，双击 index.html 本地预览照常可用。
"""
import hashlib
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 不复制的内容
# 注意: data/ 与 assets/img/uploads/ 是服务器运行时目录（管理员后台用），
# 绝不进入构建产物；更新部署靠 tools/deploy.py，保护路径永不覆盖。
EXCLUDE_DIRS = {"dist", "tools", "deploy", "data", "uploads", "__pycache__", "_test"}
EXCLUDE_FILES = {"gen_placeholders.py", "README.md", "LICENSE", ".gitignore"}

# HTML 里的资源引用: src="assets/..." 或 href="assets/..."（含 admin 页的 ../assets/...）
RES_RE = re.compile(r'(src|href)="((?:\.\./)?assets/[^"?#]+)"')


def md5v(path):
    """文件内容的版本戳(前 8 位)"""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


RUNTIME_DIR_NAMES = {"data", "uploads"}


def find_runtime_dir(path, depth=2):
    """在 path 下（含其后代，最多 depth 层）找"线上运行时目录"。

    为什么必须往下看几层而不是只看第一层：站点可能整站位于 out 的子目录里
    （例如 `-o /var/www/love` 而站点在 `/var/www/love/dist`），只看一层就会漏判，
    而漏判的后果是 shutil.rmtree 把 /var/www/love 整棵删掉 —— data/config.json、
    data/gate_secret、data/content.json、assets/img/uploads/ 的照片、music.dat
    全部不可逆消失。旧实现正是这样：只查 `out/data` 与 `out/assets/img/uploads`。

    返回命中的路径（供报错用），没找到返回 None。
    """
    if not os.path.isdir(path):
        return None
    if os.path.basename(os.path.normpath(path)).lower() in RUNTIME_DIR_NAMES:
        return path
    stack = [(path, 0)]
    while stack:
        cur, level = stack.pop()
        try:
            entries = os.listdir(cur)
        except OSError:
            continue
        for name in entries:
            full = os.path.join(cur, name)
            if not os.path.isdir(full):
                continue
            low = name.lower()
            if low in RUNTIME_DIR_NAMES:
                return full
            if low == "assets" and os.path.isdir(os.path.join(full, "img", "uploads")):
                return os.path.join(full, "img", "uploads")
            if level + 1 < depth:
                stack.append((full, level + 1))
    return None


def _dir_prefix(p):
    """补上**唯一一个**尾部分隔符。

    旧写法 `out_cmp + os.sep` 在 out_cmp 本身已经是盘符根（`c:\\`）或 POSIX 根（`/`）
    时会拼出 `c:\\\\` / `//`，于是 `(root + sep).startswith(out + sep)` 对"盘根"永远为
    False —— 守卫等于不存在。第四轮 F-S11-01 实测：Git Bash 里 `-o /` 会被 MSYS 改写成
    Git 安装根，守卫放行，紧接着 `shutil.rmtree` 删掉整个 Git 安装（连 git 本身一起没）。
    """
    p = os.path.normpath(p)
    return p if p.endswith(os.sep) else p + os.sep


def _is_fs_root(p):
    """是不是文件系统根（`/`、`c:\\`）：根的 dirname 就是它自己。跨平台都成立。"""
    return os.path.dirname(p) == p


# 上一次构建的产物里**必有**这些页面文件（就是仓库根的那一批页面）。
# 判据是**组合**而不是"任意一个"：`index.html` 是所有静态站点都有的通用文件名，
# 拿"目录里有一个 index.html / 一个 admin/ 子目录"当"我认识这个目录"的依据，
# 等于把 `-o` 指向任意静态站点目录都会整棵 rmtree（第七轮 S11-10）。
# 要求至少命中 BUILD_MARKERS_MIN 个本项目页面名：通用静态站点不可能同时叫这 8 个
# 名字里的 3 个，而本工具的正常产物 8 个全在（`admin/` 单独出现不再算数）。
BUILD_MARKERS = frozenset((
    "index.html", "home.html", "gallery.html", "game.html", "letter.html",
    "achievements.html", "timeline.html", "anniversary.html",
))
BUILD_MARKERS_MIN = 3


def looks_like_our_build(path):
    """这个目录能不能被安全清空：不存在 / 空 / 像我们自己的上一次构建产物。

    为什么需要这条：`shutil.rmtree(out)` 是"先清空再写"的写法，而 out 是用户给的
    任意路径。光靠"是不是项目祖先 + 下面有没有 data/uploads"两条判据去枚举危险目录，
    永远是枚举不完的（盘根、站点根的更上层、Git 安装根、htdocs…每种形状都漏一次：
    第四轮 F-S11-01/02/04 就是这么漏的）。反过来定一条底线更牢靠 ——
    **不删不认识的东西**：目录里若已有多个我们构建产物必带的页面，说明是上一次的
    产物，照常清空重建；否则一律拒绝，让用户自己确认。

    旧判据只要命中 `{index.html, home.html, admin}` 里的**一个**就算"认识"，
    于是任何含 index.html 的静态站点目录、任何含 admin/ 子目录的目录都会被
    `rmtree` —— 与要防的损失（不可逆删除）不成比例（第七轮 S11-10）。
    取舍：构建中断到一半、产物里连 3 个页面都不剩时会拒绝覆盖，需要人工清空；
    这与"不删不认识的东西"这条底线一致（docstring 早就写明这个取舍）。
    """
    if not os.path.isdir(path):
        return True                     # 不存在 = 没东西可删
    try:
        names = set(os.listdir(path))
    except OSError:
        return False                    # 读不出来就别删
    if not names:
        return True                     # 空目录 = 没东西可删
    return len(names & BUILD_MARKERS) >= BUILD_MARKERS_MIN


def safe_out_dir(out):
    """输出目录守卫：绝不 rmtrash 掉项目本身、盘根、或线上运行时目录。
    （旧版 `python tools/build.py -o .` 会把整个项目清空，
      `-o /var/www/love/dist` 会把线上 data/、uploads/ 一起删掉）

    判断一律用规范化路径（normcase + realpath），返回的仍是原来的写法：
    Windows / macOS 的文件系统不区分大小写，而 abspath() 会原样保留传入的
    大小写 —— 用 `-o c:\\users\\...\\love` 这样只换了大小写的路径，字符串比较
    不相等、os.path.exists 却命中同一个目录，rmtree 照样把整个项目（含 data/
    与 .git）删掉。"""
    out_abs = os.path.abspath(out)
    out_cmp = os.path.normcase(os.path.realpath(out_abs))
    root_cmp = os.path.normcase(os.path.realpath(ROOT))
    if _is_fs_root(out_cmp):
        sys.exit("拒绝构建：输出目录不能是文件系统根/盘符根（会删掉整块盘）\n  out = %s" % out_cmp)
    if out_cmp == root_cmp or _dir_prefix(root_cmp).startswith(_dir_prefix(out_cmp)):
        sys.exit("拒绝构建：输出目录不能是项目根目录或其上级（会删掉整个项目）\n  out = %s" % out_cmp)
    # 输出目录落在项目内的情况不能在这里一律拒绝（默认的 dist/ 就落在项目内），
    # 真正要做的是把它排除出 os.walk —— 见 main() 里对 out_norm 的过滤。否则刚写好的
    # 产物会被当成源文件再走一遍，产出 out/out/<整站> 这种套娃（`-o out` 可复现）。
    hit = find_runtime_dir(out_cmp)
    if hit is not None:
        sys.exit("拒绝构建：输出目录里已有 %s（像是线上/运行时目录，构建会清空它）\n  out = %s\n"
                 "请改用空目录，或加 -o 指向别处。" % (hit, out_cmp))
    # 兜底：不认识的东西不删（盘根的更上层、站点根的上上级、Git 安装根、htdocs、
    # 别人的静态站点目录…… 都落在这里被挡住）
    if not looks_like_our_build(out_cmp):
        sys.exit("拒绝构建：输出目录非空、且不像本工具的上一次构建产物（构建会先清空它）\n"
                 "  out = %s\n"
                 "  判据：目录里至少要有 %d 个本项目页面文件（如 index.html + home.html +\n"
                 "  gallery.html 一起出现）；只含一个通用文件名（index.html、admin/ 之类）\n"
                 "  的目录不会被当成产物删除。请改用空目录/新目录；若确认其中内容可以\n"
                 "  删除，请自己先清空它。" % (out_cmp, BUILD_MARKERS_MIN))
    return out_abs


def process_html(src_path, dst_path, versions):
    """给 HTML 里的资源引用加版本戳"""
    with open(src_path, "r", encoding="utf-8") as f:
        html = f.read()

    def repl(m):
        attr, res = m.group(1), m.group(2)
        key = res[3:] if res.startswith("../") else res  # ../assets/... → assets/...
        v = versions.get(key)
        if v:
            return '%s="%s?v=%s"' % (attr, res, v)
        return m.group(0)

    html = RES_RE.sub(repl, html)
    # 固定写 LF：避免 Windows 构建出 CRLF、Linux 出 LF，导致 dist 字节随平台漂移
    with open(dst_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)


def main():
    out = DIST
    if len(sys.argv) >= 3 and sys.argv[1] == "-o":
        out = os.path.abspath(sys.argv[2])
    out = safe_out_dir(out)

    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)

    versions = {}
    copied = 0
    html_files = []

    # 输出目录若落在项目内（默认的 dist/ 就是），必须排除出遍历：否则刚写进去的
    # 产物会被当成源文件再复制一次，产出 out/out/<整站> 这种套娃（`-o out` 可复现）。
    out_norm = os.path.normcase(os.path.abspath(out))

    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [
            d for d in dirnames
            if d not in EXCLUDE_DIRS
            # 以 . 开头的目录（.git、以及各编辑器/AI 工具的工作目录）一律不进产物。
            # 用通配规则而不是逐个列名字：既不跟工具版本走，也不会把作者本机装了哪些
            # 工具写进公开仓库。
            and not d.startswith(".")
            and os.path.normcase(os.path.abspath(os.path.join(dirpath, d))) != out_norm
        ]
        for name in filenames:
            # 点文件也不进产物：上面只排除了点**目录**，根目录的点**文件**
            # （.env、.gitattributes、编辑器/工具留下的临时点文件）会被原样复制进
            # dist/，再随 deploy.py 的 os.walk 上传到服务器 —— 而 Apache 那条路径
            # 对点文件没有任何拒绝规则（第四轮 F-S12-5 / F-S12-1）。
            # 用通配规则而不是逐个列名字：既不跟工具版本走，也不把作者本机装了
            # 哪些工具写进公开仓库。
            if name in EXCLUDE_FILES or name.startswith("."):
                continue
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, ROOT)
            dst = os.path.join(out, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if name.endswith(".html") or name.endswith(".php"):
                # PHP 页面(如 admin/index.php)同样需要给资源引用打版本戳
                html_files.append((src, dst))
            else:
                shutil.copy2(src, dst)
                if rel.startswith("assets"):
                    versions[rel.replace("\\", "/")] = md5v(src)
            copied += 1

    for src, dst in html_files:
        process_html(src, dst, versions)

    # 统计
    total_size = 0
    for dirpath, _, filenames in os.walk(out):
        for name in filenames:
            total_size += os.path.getsize(os.path.join(dirpath, name))
    n_html = len(html_files)
    print("构建完成 ✓")
    print("  输出目录: %s" % out)
    print("  文件总数: %d（含 %d 个页面）" % (copied, n_html))
    print("  总大小:   %.1f KB" % (total_size / 1024))
    print("  版本戳:   %d 个资源文件已加 ?v= 版本号" % len(versions))
    print()
    print("部署提示: 把 %s 目录里的内容上传到服务器即可" % out)
    print("          Nginx 配置示例见 deploy/nginx.conf（Apache 见 deploy/.htaccess）")


if __name__ == "__main__":
    main()
