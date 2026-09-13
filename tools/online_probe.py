#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""线上只读实测启动器（真实主机 + 真实 PHP + 真实 WAF）。

为什么要有这个启动器，而不是直接 node 跑：
  1. 站点地址属敏感值，不写进仓库 —— 从凭据文件首行读取（该行就是裸域名）；
  2. 解锁口令不落盘、不进命令行、不进 shell 历史：通过 FTPS 读服务器自己的
     data/config.json，在内存里取出后用**子进程环境变量**交给 node 脚本，
     并且只打印长度、不打印内容。

用法：
  python tools/online_probe.py --creds "<凭据文件>"                  # 两阶段都跑
  python tools/online_probe.py --creds "<凭据文件>" --phase locked   # 只跑未解锁阶段
  python tools/online_probe.py --creds "<凭据文件>" --phase unlocked # 只跑解锁态阶段
  python tools/online_probe.py --site <站点地址> --phase locked      # 显式给地址（首行不可用时）

只读铁律：
  - 这套探针只做「读 + 畸形载荷被拒」，任何写操作都不许加进来；
  - **绝不测"错误密码"路径**：api/unlock.php 一旦走到密码校验就 love_gate_fail()
    计一次失败，累计到上限会锁门，两个人都进不去。
"""
import argparse
import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy import ROOT, load_creds, open_ftp, detect_remote_base  # noqa


def site_from_creds(path):
    """凭据文件首行是站点地址（裸域名，无标签）。

    只接受形如 host.tld 的裸域名：带空格/冒号（说明取到了标签行）、
    或不含点（说明取到了别的短值）都视为不可用，返回空串让调用方报错，
    避免把一个错值当成站点地址去连。
    """
    raw = open(path, "rb").read()
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk", "big5", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        return ""
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        if "." in line and " " not in line and ":" not in line and "：" not in line and "\\" not in line:
            return line
        return ""
    return ""


def read_unlock_password(creds_path):
    """从服务器 data/config.json 取解锁口令（只走内存，不落盘、不打印）。"""
    host, user, pwd, port = load_creds(creds_path)
    ftp = open_ftp(host, port, user, pwd)
    ftp.set_pasv(True)
    base = detect_remote_base(ftp, "")
    remote = (base + "/" if base else "") + "data/config.json"
    buf = io.BytesIO()
    try:
        ftp.retrbinary("RETR " + remote, buf.write)
    finally:
        try:
            ftp.quit()
        except Exception:
            try:
                ftp.close()
            except Exception:
                pass

    cfg = json.loads(buf.getvalue().decode("utf-8"))
    pw = cfg.get("password")
    if not isinstance(pw, str) or pw == "":
        sys.exit("服务器 data/config.json 里没有可用的 password（门禁可能已关闭），无法做解锁态测试")
    return pw


def run_node(script, env):
    path = os.path.join(ROOT, "tools", script)
    if not os.path.isfile(path):
        sys.exit("缺少脚本：%s" % path)
    return subprocess.run(["node", path], cwd=ROOT, env=env).returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True, help="凭据文件路径（首行=站点地址；含 FTP 主机/账号/口令）")
    ap.add_argument("--site", default="", help="显式指定站点地址；留空则取凭据文件首行")
    ap.add_argument("--phase", choices=("locked", "unlocked", "all"), default="all",
                    help="locked=未解锁阶段(20 项)；unlocked=解锁态阶段(27 项)；all=两个都跑")
    args = ap.parse_args()

    site = args.site.strip() or os.environ.get("LOVE_SITE_HOST", "").strip() or site_from_creds(args.creds)
    if not site:
        sys.exit("读不到站点地址：凭据文件首行需是裸域名，或用 --site/LOVE_SITE_HOST 指定")

    codes = []
    env = dict(os.environ)
    env["LOVE_SITE_HOST"] = site

    if args.phase in ("locked", "all"):
        print("=== 阶段 1/2：未解锁（匿名可达路径，只读）===")
        codes.append(run_node("online_probe.js", env))

    if args.phase in ("unlocked", "all"):
        print("\n=== 阶段 2/2：解锁态 ===")
        pw = read_unlock_password(args.creds)
        print("已从服务器读到解锁口令（长度 %d，内容不打印）。开始浏览器实测…" % len(pw))
        env["LOVE_UNLOCK_PW"] = pw
        codes.append(run_node("online_probe_unlocked.js", env))

    bad = [c for c in codes if c != 0]
    print("\n线上只读实测结束：%d 个阶段，%d 个失败" % (len(codes), len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
