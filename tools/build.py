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
EXCLUDE_DIRS = {"dist", "tools", "deploy", "data", "uploads", ".git", "__pycache__", "_test", ".codegraph", ".dsh-debug", ".playwright-mcp", ".trae", ".workbuddy", ".zcode"}
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


def safe_out_dir(out):
    """输出目录守卫：绝不 rmtrash 掉项目本身或线上运行时目录。
    （旧版 `python tools/build.py -o .` 会把整个项目清空，
      `-o /var/www/love/dist` 会把线上 data/、uploads/ 一起删掉）"""
    out_abs = os.path.abspath(out)
    root_abs = os.path.abspath(ROOT)
    if out_abs == root_abs or (root_abs + os.sep).startswith(out_abs + os.sep):
        sys.exit("拒绝构建：输出目录不能是项目根目录或其上级（会删掉整个项目）\n  out = %s" % out_abs)
    for guard in ("data", os.path.join("assets", "img", "uploads")):
        if os.path.exists(os.path.join(out_abs, guard)):
            sys.exit("拒绝构建：输出目录里已有 %s（像是线上/运行时目录，构建会清空它）\n  out = %s\n"
                     "请改用空目录，或加 -o 指向别处。" % (guard, out_abs))
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

    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            if name in EXCLUDE_FILES:
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
