# -*- coding: utf-8 -*-
"""情侣网站 · 自有服务器(VPS) 线上只读验收

纯 Python 标准库（urllib + ssl），不需要 node / playwright —— 自有服务器没有
WAF 挑战页那类东西，裸请求拿到的就是真实响应。（这条经验来自现有线上主机：
那边必须先过真浏览器，裸 fetch 会拿到挑战页；本脚本不适用于那种主机。）

分两阶段，用 --phase 选：
  infra  基础设施：装了 nginx 配置就该**全绿**，不依赖站点内容是否已部署。
         - 安全头必须在**所有**响应上出现（尤其 /index.html 与 /assets/*，
           它们各自带 add_header，是 nginx 不继承那个坑的高发区），
           而且 403/404 也要带（`add_header ... always` 的契约）
         - HSTS、HTTP→HTTPS 301、TLS 1.2+、ALPN 协商出 h2
         - 敏感目录/照片直链必须 403（文件与目录两种形态都要验）；
           /assets/img/*.svg 这种非照片资源必须**没被误杀**
         - 不存在的页面必须真 404（没被兜底改写成 200 首页）
  site   站点内容：部署之后才有意义（页面 200、接口能被浏览器直接执行、
         门禁生效）。--phase all（默认）两段都跑。

铁律（与 tools/online_probe.js 同一套）：
  · **只读**：只发 GET，不做任何写操作。线上是真实数据，不是沙箱。
  · **绝不碰解锁口令路径**：本脚本不调用 api/unlock.php，也不提交任何口令 ——
    那会消耗失败计数，累计到上限会把两个人一起锁在门外。
    门禁是否生效靠"未解锁时注入的私密内容为空"来判定，不需要真的去解锁。

用法：
    python tools/verify_vps.py --creds "<凭据文件>"
    python tools/verify_vps.py --creds "<文件>" --phase infra     # 只验基础设施
    python tools/verify_vps.py --site <域名>                       # 显式指定站点

退出码：0 全过；1 有失败项。
"""
import argparse
import calendar
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vps_setup import die, mask_domain, parse_creds, read_text      # noqa: E402

TIMEOUT = 25

# 由 --no-proxy / --proxy 决定走哪条路：
#   NO_PROXY  装空 ProxyHandler，强制直连
#   PROXY_URL 显式走这个代理
# 背景（2026-09-15 实测）：本机直连服务器的 **80 端口**极不稳定 ——
# 6/6 失败，而同一 IP 的 443 稳定 200，走代理时 80 也稳定拿到 301。
# 服务器侧从自身访问公网 IP:80 能正常拿到 nginx 响应，所以这不是服务器问题，
# 而是出口对明文 HTTP 的 DPI 干扰。所以 80 端口的断言在连不上时要报"警告"而不是
# "失败"，并提示用 --proxy 复验。
NO_PROXY = False
PROXY_URL = ""
LAST_ERROR = ""
# main() 解析出域名后写入这里，供 redact() 把输出文本里的域名换成打码形态。
DOMAIN = ""

# 必须出现的响应头（小写）。HSTS 的 max-age 先给 1 天，稳定后再调大。
REQUIRED_HEADERS = (
    "x-robots-tag",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "strict-transport-security",
)

# 敏感路径：必须 403（与 deploy/vps/nginx.conf.template 的 deny 规则一一对应）
# 文件形态与**目录形态**都要验：只拦文件不拦目录，目录列表照样能看。
MUST_403 = (
    "/data/config.json",
    "/data/content.json",
    "/data/admin.json",
    "/data/",
    "/lib/store.php",
    "/lib/access.php",
    "/lib/",
    "/deploy/.htaccess",
    "/deploy/nginx.conf",
    "/deploy/",
    "/assets/img/uploads/",
    "/assets/img/uploads/probe-should-be-403.jpg",
    "/assets/img/probe-should-be-403.jpg",
    # 路径穿越：nginx 会先把 URI 归一化再匹配 location，所以这条实际命中的是
    # /data/config.json → 403。写进来是为了盯住"有人拿掉 deny 规则"这类回归。
    "/assets/../data/config.json",
)

# 必须**不能**返回 200 的路径。两种情形放进这组：
#   1) 不带斜杠的目录请求 —— nginx 会先 301 到带斜杠的地址（然后才 403），
#      所以不能要求 403，但**绝不能**是 200（那就是把目录列出来了）；
#   2) 点文件 —— 构建产物里没有它们（2026-09-15 实测确认），因此只要不是
#      被 "文件不存在" 之外的路径拿出来，就必须被拒绝；一旦返回 200，
#      说明有 dotfile 真被部署上去了且没有任何保护。
MUST_NOT_200 = (
    "/data",
    "/lib",
    "/assets/img/uploads",
    "/.htaccess",
    "/.git/config",
    "/.env",
)

# 必须**能**访问的资源：防止 deny 规则写得过宽把正常资源一起杀掉
MUST_NOT_403 = (
    "/assets/img/photo-1.svg",      # 占位插画（非照片），照片规则只该拦 jpg/png/webp/gif
    "/robots.txt",
)

# 站点内容页（site 阶段要求 200）
SITE_PAGES = (
    "/",
    "/index.html",
    "/home.html",
    "/gallery.html",
    "/game.html",
    "/letter.html",
    "/achievements.html",
    "/timeline.html",
    "/anniversary.html",
)

SITE_ASSETS = (
    "/assets/css/style.css",
    "/assets/js/main.js",
    "/assets/js/config.js",
    "/assets/music/music.dat",
)

# 这些资源"缺了也不算故障"：music.dat 只在首次部署（--with-media）时上传，
# 之后的日常更新命令不带它。断言 200 会长期假红，见 site 阶段的处理。
OPTIONAL_SITE_ASSETS = ("/assets/music/music.dat",)

# api/config.php 注入的 5 个全局变量（缺一个都说明接口出了问题）
INJECT_MARKERS = (
    "__SERVER_OVERRIDES__",
    "__SERVER_GATE__",
    "__SERVER_CONTENT__",
    "__SERVER_COMPAT__",
    "__SERVER_DAILY__",
)

# 响应体里绝不该出现的"键名"：password/pwd/hash/secret。
# 只匹配 `"键":` 这种真正的 JSON 键，值里出现这几个字母（比如情话正文）不算。
SECRET_KEY_RE = re.compile(r'"[a-z0-9_]*(?:pass|pwd|hash|secret)[a-z0-9_]*"\s*:', re.I)


def redact(text):
    """把输出文本里出现的站点域名换成打码形态（与横幅同一来源）。

    横幅早就打了码（`*` * (len-4) + 末 4 位），但失败路径会把域名原样带出来 ——
    裸 socket 连不上的 `连不上 <域名>:443`、证书校验异常里的
    `certificate is not valid for '<域名>'`、以及 urllib 的 LAST_ERROR 原文。
    验收输出是最容易被贴进聊天/issue 的那种文本，同一份输出里"上半截打码、
    下半截明文"等于没打码，所以所有对外文本统一过这里（第七轮 S11-02）。
    """
    s = str(text if text is not None else "")
    if DOMAIN:
        s = s.replace(DOMAIN, mask_domain(DOMAIN))
    return s


def photo_probe_verdict(status, ctype):
    """photo.php 探测的三态判定（第七轮 S11-01）。返回 (ok|fail, 说明)。

    只有**明确可判断**的状态才允许计通过 —— 与本文件对 MUST_NOT_403 立的规矩
    是同一条（连不上不能算通过，那是假通过）。旧写法判据是
    `st == 200 and text/html` 才失败，于是连不上（0）、404（接口没部署）、
    5xx（PHP 致命错误）三种情况全部落进 ok 分支：photo.php 整条坏掉时验收
    照样"全绿"，而它是本站取到照片的**唯一**路径。
    """
    c = (ctype or "").lower()
    if status in (401, 403):
        return "ok", "状态 %s（门禁生效，未解锁被拒）" % status
    if status == 200 and "image/" in c:
        return "ok", "状态 200，Content-Type %s（返回的是图片字节）" % (ctype or "无")
    if status == 200 and "text/html" in c:
        return "fail", ("状态 200，Content-Type %s —— 被 404/403 兜底改写成了页面 HTML"
                        % (ctype or "无"))
    if status == 0:
        return "fail", "连不上（%s）—— 连不上不能算通过" % (redact(LAST_ERROR) or "原因见上面的错误行")
    if status == 404:
        return "fail", "状态 404 —— photo.php 没部署上去（照片会全部看不到）"
    if status >= 500:
        return "fail", "状态 %s —— photo.php 内部出错了（去看 nginx/php 错误日志）" % status
    return "fail", ("状态 %s，Content-Type %s —— 既不是门禁拒绝、也不是图片字节，"
                    "无法判断为正常" % (status, ctype or "无"))


def server_version_leak(hdr):
    """响应头里是否带 nginx 版本号，命中就返回那个 `Server:` 值，否则返回 ""。

    `server_tokens off;` 的作用域是 http|server|location，**不跨 server 块继承**：
    只在 443 块里写，80 块（301/404 的响应）照样输出
    `Server: nginx/1.18.0 (Ubuntu)`，而 80 恰是扫描器最先打的门（第七轮 S12-01）。
    这里只判"有没有版本号"（带 `/`），不要求头必须存在（有的边缘层会去掉它）。
    """
    v = (hdr.get("server") or "").strip()
    return v if "/" in v else ""


def js_payloads(text):
    """把 `window.__SERVER_X__ = {...};` 逐行解析成 {名字: 解析后的对象}。
    解析不出来的记 None —— 响应体里混进 PHP 告警时就会这样（警告插在语句前面
    或中间，整行都不再是合法 JSON），所以这个检查同时覆盖"有无告警"这件事。"""
    out = {}
    for ln in text.splitlines():
        m = re.match(r"^window\.(__SERVER_[A-Z_]+__)\s*=\s*(.*);$", ln.strip())
        if not m:
            continue
        try:
            out[m.group(1)] = json.loads(m.group(2))
        except ValueError:
            out[m.group(1)] = None
    return out


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随跳转：我们要断言 80 → 443 的 301 本身，而不是它的最终结果"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_get(url, follow=False, timeout=None):
    """返回 (状态码, 响应头字典(小写), 正文字节)。
    4xx/5xx 不抛异常（返回真实状态码）；**连不上返回状态码 0**，原因放在 LAST_ERROR。
    返回 0 而不是直接退出，是因为"明文 80 连不上"在本机是网络干扰而非配置问题，
    要由调用方决定算失败还是警告。"""
    global LAST_ERROR
    LAST_ERROR = ""
    # 默认参数在函数定义时就求值了，改不动；所以这里运行时再读全局 TIMEOUT
    if timeout is None:
        timeout = TIMEOUT
    handlers = [urllib.request.HTTPSHandler(context=ssl.create_default_context())]
    if PROXY_URL:
        handlers.append(urllib.request.ProxyHandler({"http": PROXY_URL, "https": PROXY_URL}))
    elif NO_PROXY:
        # 打自己的服务器却走了系统代理（如本机开着 Clash）是最常见的假失败，
        # --no-proxy 直接装一个空 ProxyHandler 绕开，比依赖 NO_PROXY 环境变量可靠
        handlers.append(urllib.request.ProxyHandler({}))
    if not follow:
        handlers.append(NoRedirect())
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "love-verify-vps/1.0"})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:  # noqa
            pass
        hdr = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
        return e.code, hdr, body
    except OSError as e:
        # URLError / ConnectionResetError / timeout 都走这里（都是 OSError 子类）
        LAST_ERROR = str(getattr(e, "reason", None) or e)
        return 0, {}, b""
    except http.client.HTTPException as e:
        # BadStatusLine（状态行被截断/篡改）与 IncompleteRead **不是** OSError 子类
        # （issubclass 为 False，只有 RemoteDisconnected 是），所以旧写法会让它们
        # 穿透本函数 → 未捕获 traceback → 整轮验收中断、后面的断言一条都不跑。
        # 文件头记录过"出口对明文 HTTP 有 DPI 干扰"，那正是最可能产生畸形响应的地方，
        # 而设计意图是这种情况记警告（第七轮 S11-03）。
        LAST_ERROR = "%s: %s" % (type(e).__name__, e)
        return 0, {}, b""


def check_tls(domain):
    """TLS 版本、证书剩余天数、ALPN 是否协商出 h2（http2 是否真的生效）"""
    info = {}
    ctx = ssl.create_default_context()
    ctx.set_alpn_protocols(["h2", "http/1.1"])
    try:
        with socket.create_connection((domain, 443), timeout=TIMEOUT) as raw:
            with ctx.wrap_socket(raw, server_hostname=domain) as s:
                info["protocol"] = s.version()
                info["alpn"] = s.selected_alpn_protocol() or ""
                cert = s.getpeercert()
    except ssl.SSLCertVerificationError as e:
        # 异常文本里通常就带域名（`certificate is not valid for '<域名>'`），
        # 打码后才允许进输出（第七轮 S11-02）。
        die("证书校验失败：%s\n（Let's Encrypt 证书过期或域名不匹配，先跑 certbot renew）" % redact(e))
    except (socket.timeout, OSError) as e:
        # 这一项用的是裸 socket（要读 ALPN 协商结果），**不经过 --proxy**。
        # 代理模式下这里仍是直连，所以出口对 443 的干扰会在这里表现出来。
        die("连不上 %s:443：%s\n注意：TLS 探测走裸 socket 直连（为了读 ALPN），"
            "不受 --proxy/--no-proxy 影响；本机到 443 不稳定时先解决网络再跑本脚本。"
            % (mask_domain(domain), redact(e)))
    if cert and cert.get("notAfter"):
        try:
            exp = calendar.timegm(time.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z"))
            info["days_left"] = int((exp - time.time()) // 86400)
        except ValueError:
            pass
    return info


def main():
    # global 必须放在函数最前面：argparse 的 default=TIMEOUT 会先读一次这个全局，
    # 之后再声明 global 就是 SyntaxError（"used prior to global declaration"）。
    global NO_PROXY, PROXY_URL, TIMEOUT, DOMAIN

    ap = argparse.ArgumentParser(description="情侣网站 · VPS 线上只读验收")
    ap.add_argument("--creds", default="", help="凭据文件路径（从中取「域名」）")
    ap.add_argument("--site", default="", help="站点裸域名（或环境变量 LOVE_SITE_HOST）")
    ap.add_argument("--phase", choices=("infra", "site", "all"), default="all",
                    help="infra=基础设施 / site=站点内容 / all=两者（默认）")
    ap.add_argument("--no-proxy", action="store_true",
                    help="绕开系统代理再请求（本机开着 Clash 之类时用）")
    ap.add_argument("--proxy", default="", metavar="URL",
                    help="显式走这个代理，如 http://127.0.0.1:7897（**只建议**用来验 80→301；"
                         "443 那一堆项直连更稳 —— 本机实测经代理访问 443 会 502/EOF）")
    ap.add_argument("--timeout", type=int, default=TIMEOUT, help="单请求超时秒数（默认 25）")
    args = ap.parse_args()

    NO_PROXY = args.no_proxy
    PROXY_URL = args.proxy
    TIMEOUT = args.timeout

    creds = parse_creds(read_text(args.creds)) if args.creds else {}
    domain = args.site or os.environ.get("LOVE_SITE_HOST") or creds.get("domain") or ""
    if not domain:
        die("缺少域名：--site，或环境变量 LOVE_SITE_HOST，或凭据文件的「域名」")
    if domain.startswith("http") or "/" in domain:
        die("--site 要裸域名（不带 http:// 和路径），收到：%r" % mask_domain(domain))
    DOMAIN = domain

    base = "https://" + domain
    results = []          # (阶段, 名称, "ok"/"fail"/"warn", 说明)

    def rec(phase, name, status, detail=""):
        results.append((phase, name, status, detail))

    run_infra = args.phase in ("infra", "all")
    run_site = args.phase in ("site", "all")

    print("==> 验收目标：%s（阶段 %s）" % (mask_domain(domain), args.phase))
    print()

    # ---------------- infra ----------------
    if run_infra:
        print("--- 基础设施 ---")

        # 1. TLS / 证书 / ALPN
        tls = check_tls(domain)
        proto = tls.get("protocol", "?")
        rec("infra", "TLS 版本 ≥ 1.2", "ok" if proto in ("TLSv1.2", "TLSv1.3") else "fail",
            proto)
        alpn = tls.get("alpn") or "(未协商)"
        rec("infra", "HTTP/2（ALPN 协商出 h2）", "ok" if alpn == "h2" else "fail",
            "ALPN=%s（不是 h2 说明 nginx 的 listen 少了 http2 标志）" % alpn)
        if "days_left" in tls:
            d = tls["days_left"]
            rec("infra", "证书有效期", "ok" if d > 14 else "warn",
                "剩余 %d 天（certbot.timer 自动续期）" % d)

        # 2. HTTP → HTTPS 301
        st, hdr, _ = http_get("http://" + domain + "/index.html?probe=1")
        if st == 0:
            rec("infra", "http → https 301", "warn",
                "直连 80 端口失败（%s）。**多半不是服务器问题**：本机实测同一 IP 的 443 "
                "稳定可用、80 直连不稳定，而服务器用 Host 头访问自己的 80 能稳定拿到 301 "
                "—— 属出口对明文 HTTP 的 DPI 干扰。不依赖本机网络的复验方式：\n"
                "      ssh <SSH别名> \"curl -s -o /dev/null -D - -H 'Host: <域名>' "
                "'http://127.0.0.1/index.html?probe=1'\"\n"
                "      也可以试 --proxy，但代理链本身可能连不上（本机实测过 443 直接 "
                "502/EOF），那时会把别的项一起变红，别误判成服务器故障。" % redact(LAST_ERROR))
        else:
            loc = hdr.get("location", "")
            rec("infra", "http → https 301",
                "ok" if st == 301 and loc.startswith("https://") else "fail",
                "状态 %s，Location %s" % (st, loc or "(无)"))
            # 查询串必须被保留（否则主机防护的 ?i=1 之类参数会丢）
            rec("infra", "301 保留查询串", "ok" if "probe=1" in loc else "fail",
                "Location 里 %s查询串" % ("含" if "probe=1" in loc else "**不含**"))
            # 80 块最容易漏 server_tokens off（不跨 server 块继承，第七轮 S12-01）：
            # 明文端口仍在响应里报 `Server: nginx/1.18.0 (Ubuntu)`。
            leak80 = server_version_leak(hdr)
            rec("infra", "80 端口不暴露 nginx 版本", "ok" if not leak80 else "fail",
                "Server: %s%s" % (leak80 or hdr.get("server", "(无该头)"),
                                  "  ← 80 块也加一行 server_tokens off;" if leak80 else ""))

        # 3. 安全头：逐个 URL 验。**不管状态码**都要有头 —— 因为 location 里
        #    add_header 用了 always。这正是在 infra 阶段就能验的原因：站点还没部署
        #    时这些 URL 可能 404，但头必须照样在（否则就是又踩了不继承的坑）。
        header_urls = ("/", "/index.html", "/assets/css/style.css", "/assets/js/main.js")
        for path in header_urls:
            st, hdr, _ = http_get(base + path)
            if st == 0:
                rec("infra", "安全头 %s" % path, "fail",
                    "连不上（%s）—— 443 直连都失败的话先解决网络，别急着看头" % redact(LAST_ERROR))
                continue
            missing = [h for h in REQUIRED_HEADERS if h not in hdr]
            if missing:
                rec("infra", "安全头 %s" % path, "fail",
                    "状态 %s，缺 %s" % (st, ", ".join(missing)))
            else:
                bad = []
                if "noindex" not in hdr.get("x-robots-tag", "").lower():
                    bad.append("X-Robots-Tag 不含 noindex")
                if hdr.get("x-content-type-options", "").lower() != "nosniff":
                    bad.append("X-Content-Type-Options 不是 nosniff")
                rec("infra", "安全头 %s" % path, "warn" if bad else "ok",
                    ("状态 %s，%s" % (st, "；".join(bad))) if bad else "状态 %s，5 个头齐全" % st)
            # 443 也不该报版本号：与 80 那条是同一件事的两半（S12-01）
            leak = server_version_leak(hdr)
            rec("infra", "不暴露 nginx 版本 %s" % path, "ok" if not leak else "fail",
                "Server: %s%s" % (leak or hdr.get("server", "(无该头)"),
                                  "  ← 这个 server 块缺 server_tokens off;" if leak else ""))

        # 4. 敏感路径必须 403；而且 403 响应上安全头也要在 ——
        #    `add_header ... always` 的契约就是"被拦住的响应也带 noindex"，
        #    否则搜索引擎照样会为"被拒绝但留下链接"的地址建索引。
        for path in MUST_403:
            st, hdr, _ = http_get(base + path)
            if st != 403:
                rec("infra", "敏感路径拒绝 %s" % path, "fail", "状态 %s（应为 403）" % st)
                continue
            missing = [h for h in REQUIRED_HEADERS if h not in hdr]
            rec("infra", "敏感路径拒绝 %s" % path, "fail" if missing else "ok",
                "状态 403，但缺安全头 %s（location 里新加了 add_header？）" % ", ".join(missing)
                if missing else "状态 403，安全头齐全")

        # 5. 正常资源不能被误杀。
        #    ⚠️ 连不上（状态 0）必须算失败：这类"不该被拒"的断言如果拿"连不上"
        #    当通过，就会在整站不可达时静默变绿 —— 那是假通过，比不做检查更糟。
        for path in MUST_NOT_403:
            st, _hdr, _ = http_get(base + path)
            if st == 0:
                rec("infra", "正常资源未被误杀 %s" % path, "fail",
                    "连不上（%s）—— 连不上不能算通过" % redact(LAST_ERROR))
                continue
            if st == 403:
                rec("infra", "正常资源未被误杀 %s" % path, "fail",
                    "状态 403 —— 被 deny 规则误杀了")
            elif st == 200:
                rec("infra", "正常资源未被误杀 %s" % path, "ok", "状态 200")
            else:
                # 404 在 infra 阶段是**预期**的（还没部署），5xx 不是。以前这里把任何
                # 非 403 都记成 "ok / 状态 404"，等于把 500 和"还没部署"都说成通过 ——
                # 一个永远绿的断言会训练人忽略它。改成 warn：不算故障，但要看得见。
                rec("infra", "正常资源未被误杀 %s" % path,
                    "warn" if st == 404 else "fail",
                    "状态 404 —— 规则没误杀它，只是文件还没部署（site 阶段才断言 200）"
                    if st == 404 else "状态 %s（既不是 200 也不是 404）" % st)

        # 6. 目录形态与点文件都不能是 200（301 到 403 是允许的，列出目录不行）
        for path in MUST_NOT_200:
            st, _hdr, _ = http_get(base + path)
            if st == 0:
                rec("infra", "不暴露 %s" % path, "fail",
                    "连不上（%s）—— 连不上不能算通过" % redact(LAST_ERROR))
                continue
            rec("infra", "不暴露 %s" % path, "ok" if st != 200 else "fail",
                "状态 %s%s" % (st, "（把目录/点文件直接给出去了）" if st == 200 else ""))

        # 6. robots.txt 的内容检查放在下面 site 阶段 —— 它是部署上来的内容文件，
        #    infra 阶段（还没部署）本来就该是 404，在这里断言"可访问"只会长期假红。
        #    这里只保证 deny 规则没有把它一起拦掉（已包含在 MUST_NOT_403 里）。

        # 7. 不存在的页面必须真 404（不能被兜底改写成 200 首页）
        st, hdr, body = http_get(base + "/__probe_no_such_page__.html")
        rec("infra", "不存在的页面返回 404", "ok" if st == 404 else "fail", "状态 %s" % st)
        if st == 200:
            rec("infra", "404 未被改写成首页", "fail",
                "返回 200 —— 十有八九是有人加了 server 级 `error_page 404 /index.html`")

        # 8. php 接口的 404 不能被改写（用不存在的 php 路径验，不碰真实接口）
        st, hdr, _ = http_get(base + "/__probe_no_such_script__.php")
        ctype = hdr.get("content-type", "")
        rec("infra", "不存在的 .php 返回 404", "ok" if st == 404 else "fail",
            "状态 %s（Content-Type %s）" % (st, ctype or "无"))

        # 9. 缺失的 assets 必须真 404。
        # 这是 2026-09-15 修掉的一个隐蔽 bug 的回归断言：不带 URI 的
        # `error_page 404 =404;` 并不是"保持状态码"，nginx 会把 `=404` 当成跳转
        # 目标，于是返回 `302 Location: =404`。music 探测之类的逻辑会被这个假跳转
        # 带偏，而且 302 会被浏览器缓存，问题很难复查。
        st, hdr, _ = http_get(base + "/assets/css/__probe_missing__.css")
        loc = hdr.get("location", "")
        rec("infra", "缺失的 assets 返回 404（不是 302）", "ok" if st == 404 else "fail",
            "状态 %s%s" % (st, ("，Location %s ← 典型的 `error_page 404 =404;` 写错" % loc)
                           if loc else ""))

    # ---------------- site ----------------
    if run_site:
        print()
        print("--- 站点内容 ---")

        for path in SITE_PAGES:
            st, _hdr, _ = http_get(base + path)
            # /timeline.html 之类的页面部署后应为 200；未部署时是 404（属预期）
            rec("site", "页面 %s" % path, "ok" if st == 200 else "fail", "状态 %s" % st)

        for path in SITE_ASSETS:
            st, _hdr, _ = http_get(base + path)
            if st == 200:
                rec("site", "资源 %s" % path, "ok", "状态 200")
            elif path in OPTIONAL_SITE_ASSETS and st == 404:
                # music.dat 只在**首次部署**加 --with-media 时才会上传（之后的更新命令
                # 没有这个参数）。这里如果按 200 硬断言，日常更新后这一项必然报红 ——
                # 一个长期假红的断言最后只会被忽略。改成 warn 并说清是哪种情况。
                rec("site", "资源 %s" % path, "warn",
                    "状态 404 —— 没上传过背景音乐。首次部署要加 --with-media；"
                    "网站本身不缺它（没音乐时走内置 WebAudio 音乐盒）")
            else:
                rec("site", "资源 %s" % path, "fail", "状态 %s" % st)

        # robots.txt：必须能访问，且**故意不写** `Disallow: /`。两者是配合关系——
        # 写了 Disallow: /，爬虫根本读不到页面上的 X-Robots-Tag: noindex，两种机制
        # 会互相抵消（noindex 失效、链接却仍可能被收录）。
        st, _hdr, body = http_get(base + "/robots.txt")
        if st != 200:
            rec("site", "robots.txt 可访问", "fail", "状态 %s" % st)
        else:
            rec("site", "robots.txt 可访问", "ok", "状态 200")
            has_disallow_all = False
            for ln in body.decode("utf-8", "replace").splitlines():
                ln = ln.strip()
                if ln.startswith("#") or ":" not in ln:
                    continue
                k, _, v = ln.partition(":")
                if k.strip().lower() == "disallow" and v.strip() == "/":
                    has_disallow_all = True
            rec("site", "robots.txt 不写 Disallow: /", "fail" if has_disallow_all else "ok",
                "写了 Disallow: / 会与 X-Robots-Tag 互相抵消" if has_disallow_all
                else "与 X-Robots-Tag 配合正确")

        # 接口必须能被浏览器直接当脚本执行，且**不**能夹带 PHP 告警
        # （告警进响应体=整站 JS 挂，见 lib/store.php 文件头）。
        # ⚠️ 它发的是 application/javascript **不是** application/json ——
        #    api/config.php 是"注入脚本"（window.__SERVER_*__ = ...），每页用
        #    `<script src>` 加载，正文根本不是 JSON。早期版本按 JSON 去断言
        #    （`"json" in ctype` + json.loads 整份正文），在**健康站点上会假报失败**，
        #    这里改成按真实契约验：Content-Type 是 JS + 5 个注入变量都在 + 可解析。
        st, hdr, body = http_get(base + "/api/config.php")
        ctype = hdr.get("content-type", "")
        text = body.decode("utf-8", "replace")
        if st != 200:
            rec("site", "api/config.php 返回 200", "fail", "状态 %s" % st)
        else:
            ctype_l = ctype.lower()
            rec("site", "api/config.php 是 JS 注入且声明 UTF-8",
                "ok" if ("javascript" in ctype_l and "charset=utf-8" in ctype_l) else "fail", ctype)
            warned = any(w in text for w in ("Warning:", "Fatal error", "Notice:",
                                             "Deprecated:", "<br />"))
            rec("site", "api 响应体无 PHP 告警", "fail" if warned else "ok",
                "响应体里出现了 PHP 警告/致命错误" if warned else "干净")

            payloads = js_payloads(text)
            missing = [m for m in INJECT_MARKERS if m not in payloads]
            broken = [m for m in INJECT_MARKERS if m in payloads and payloads[m] is None]
            if missing:
                rec("site", "api 注入的 5 个 __SERVER_*__ 齐全", "fail",
                    "缺 %s" % ", ".join(missing))
            elif broken:
                rec("site", "api 注入可解析", "fail",
                    "%s 那行解析不出来（响应体被别的东西污染了）" % ", ".join(broken))
            else:
                rec("site", "api 注入的 5 个 __SERVER_*__ 齐全且可解析", "ok")

            # 口令绝不下发（lib/access.php 与 api/config.php 的明确契约：
            # password 不在任何白名单里，校验只走 api/unlock.php）。
            leak = SECRET_KEY_RE.search(text)
            rec("site", "api 不下发口令类字段", "fail" if leak else "ok",
                ("响应体里出现了 %s 这样的键" % leak.group(0)) if leak
                else "无 password/pwd/hash/secret 键")

            # 门禁：未持 Cookie 时必须是"关"，且私密内容一个都不能注入。
            # 这是本项目最要紧的一条（整站内容都靠它护着），而且完全只读 ——
            # 不需要真的去调 api/unlock.php 试密码。
            gate = payloads.get("__SERVER_GATE__") or {}
            if gate.get("required") is not True:
                rec("site", "门禁已配置", "warn",
                    "data/config.json 里没有解锁口令（required=%r）—— 此时任何访客都能看到全部内容"
                    % gate.get("required"))
            else:
                rec("site", "未持 Cookie 时门禁状态为未解锁",
                    "ok" if gate.get("ok") is False else "fail",
                    "gate.ok=%r（未解锁却为真 = 门禁失效）" % gate.get("ok"))
                ct = payloads.get("__SERVER_CONTENT__") or {}
                comp = payloads.get("__SERVER_COMPAT__") or {}
                daily = payloads.get("__SERVER_DAILY__") or {}
                nonempty = [k for k, v in ct.items() if v]
                rec("site", "未解锁不注入私密内容",
                    "fail" if nonempty else "ok",
                    "这些键非空：%s" % ", ".join(nonempty) if nonempty
                    else "留言/情书/照片/时间胶囊均为空")
                rec("site", "未解锁不注入默契度回合",
                    "ok" if comp.get("active") is None else "fail",
                    "active=%r" % (comp.get("active"),))
                rec("site", "未解锁不注入每日一问",
                    "ok" if daily.get("enabled") is False else "fail",
                    "enabled=%r" % (daily.get("enabled"),))

        # 门禁：photo.php 绝不能返回 200 + text/html（那就是被 404/403 兜底改写成了
        # 首页 HTML —— <img> 会拿到一坨 HTML）。门禁开着时 403、关着时 200 + 图片都算正常。
        # ⚠️ 但"没被改写成 HTML"不等于"接口是好的"：旧判据只在那一种情况下记 fail，
        #    于是**连不上（0）、404（接口没部署）、5xx（PHP 致命错误）**全都记 ok ——
        #    photo.php 是本站取到照片的唯一路径，它整条坏掉时验收却给"全绿"
        #    （第七轮 S11-01）。判定收敛到 photo_probe_verdict()：只有明确可判断的
        #    状态（401/403 与 200 + image/*）才算通过，其余一律失败。
        st, hdr, body = http_get(base + "/photo.php?f=assets/img/uploads/probe.jpg")
        ctype = hdr.get("content-type", "")
        verdict, detail = photo_probe_verdict(st, ctype)
        rec("site", "photo.php 可用（未被改写/未故障）", verdict, detail)
        if st in (401, 403):
            rec("site", "photo.php 门禁生效", "ok", "状态 %s（未解锁被拒）" % st)
        elif st == 200 and "image/" in ctype.lower():
            rec("site", "photo.php 门禁", "warn",
                "未解锁却返回了图片 —— 确认 data/config.json 里的门禁口令是否为空")

        # /admin/ 应该能打开（登录页或安装页），至少不能是 500
        st, hdr, body = http_get(base + "/admin/")
        rec("site", "/admin/ 可打开", "ok" if st == 200 else "fail",
            "状态 %s（500 通常是 PHP 致命错误，去查 nginx 错误日志）" % st)

    # ---------------- 汇总 ----------------
    print()
    fails = [r for r in results if r[2] == "fail"]
    warns = [r for r in results if r[2] == "warn"]
    for phase, name, status, detail in results:
        mark = {"ok": "✓", "fail": "✗", "warn": "⚠"}[status]
        print("  %s %s%s" % (mark, name, ("：" + detail) if detail else ""))

    print()
    print("合计 %d 项：通过 %d，失败 %d，警告 %d"
          % (len(results), len(results) - len(fails) - len(warns), len(fails), len(warns)))
    if fails:
        print()
        print("失败项明细：")
        for _p, name, _s, detail in fails:
            print("  ✗ %s —— %s" % (name, detail or "无详情"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
