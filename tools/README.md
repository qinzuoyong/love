# tools/ 工具说明

## 正式工具（进版本库）

| 文件 | 作用 | 是否会写线上 |
|---|---|---|
| `build.py` | 由源码生成 `dist/`（构建产物，不入库） | 否 |
| `deploy.py` | FTPS 只增不删上传 `dist/`（跳过 `data/`、uploads、真实照片、音乐） | 写"文件"，不动运行时数据 |
| `deploy_vps.py` | SSH 只增不删部署 `dist/` 到自有 VPS（tar + scp + 服务器侧 rsync；保护清单与 `deploy.py` 共用同一份定义；`--chmod` 钉死落地权限 644/755；传完按 sha256 清单逐字节回读） | 写"文件"，不动运行时数据 |
| `vps_setup.py` | 自有 VPS 初始化：预检 + 安装 `deploy/vps/nginx.conf.template`（装前备份、装后回读 sha256、`nginx -t` 兜底、失败自动回滚）+ 建站点目录 | 写"服务器配置与目录"，不动站点文件 |
| `verify_vps.py` | 自有 VPS 线上**只读**验收：TLS/h2/301、安全头（200 与 403/404 都验）、敏感目录与点文件、404 未被改写、接口按真实契约断言、未解锁不注入私密内容 | 否 |
| `online_probe.py` | 线上只读实测启动器：从凭据文件取站点地址、经 FTPS 取解锁口令后启动下面两个脚本 | 否 |
| `online_probe.js` | 线上未解锁阶段（项数以最近一次线上运行为准，实测 21 项）：WAF、注入、接口响应体干净、8 页可访问 | 否 |
| `online_probe_unlocked.js` | 线上解锁态阶段（项数以最近一次线上运行为准，实测 28 项）：门禁分级、真实解锁、接口 JSON、畸形载荷被拒 | 否 |

### 用法

```bash
python tools/build.py
python tools/deploy.py --creds "<凭据文件>"          # 只增不删（InfinityFree / FTP）
python tools/online_probe.py --creds "<凭据文件>"     # 两阶段线上只读实测
python tools/online_probe.py --creds "<凭据文件>" --phase locked    # 只跑未解锁阶段

# 自有 VPS（Ubuntu + Nginx + PHP-FPM）：三段命令，详细说明见 deploy/vps/README.md
python tools/vps_setup.py  --creds "<凭据文件>" --ssh-host "<连接别名>"            # 初始化（可重复跑）
python tools/deploy_vps.py --creds "<凭据文件>" --ssh-host "<连接别名>" --with-media  # 首次部署（含背景音乐）
python tools/verify_vps.py --creds "<凭据文件>"                                   # 线上只读验收
python tools/verify_vps.py --creds "<凭据文件>" --phase infra                     # 只验基础设施
```

`--ssh-host` 取自本机 `~/.ssh/config` 的 Host 别名（凭据文件里没有这一项，
可以补一行 `SSH 别名：<名字>` 省掉这个参数）。
⚠️ 在 **Git Bash** 里别用命令行传 `--root` / `--php-sock`：MSYS 会把 `/var/...`
这类参数**和环境变量**都改写成 Windows 形态，而 `nginx -t` 与 sha256 回读都查不出来
（脚本现在会直接拦下这类值；可靠传法是写进凭据文件，或用 PowerShell 跑）。

`verify_vps.py` 只发 GET，且**不调用解锁口令路径**（同下面「线上探针铁律」第 2 条）。
它在 `--phase infra` 下验的是 nginx 配置是否生效，不依赖站点内容是否已部署；
`--phase site` 才会验页面与接口（部署之后才有意义）。

⚠️ **本机直连自有 VPS 的 80 端口不稳定**（出口对明文 HTTP 的 DPI 干扰，详见
`deploy/vps/README.md` 第六节）。验 `http → https 301` 有两条路：

1. **推荐**：在服务器上用 Host 头访问自己的 80（不依赖本机网络）——
   `ssh <别名> "curl -s -o /dev/null -D - -H 'Host: <域名>' 'http://127.0.0.1/index.html?probe=1'"`
2. 加 `--proxy <你的代理>`。但**代理链本身可能连不上**（2026-09-15 实测：本机
   7897 在监听，但经它访问 443 会 502/EOF），那时会把别的项一起变红，别误判成服务器故障。

不加 `--proxy` 时这一项会报**警告**并说明原因，不必当成故障。

站点地址是敏感值，不写进仓库：启动器读**凭据文件首行**（裸域名），
也可用 `--site` 或环境变量 `LOVE_SITE_HOST` 显式指定。
解锁口令不入库、不进命令行、不落盘：启动器经 FTPS 读服务器 `data/config.json`，
在内存里取出后用子进程环境变量交给 node 脚本，只打印长度。

### 线上探针铁律

> 适用于所有打线上的工具：`online_probe*.js`、`verify_vps.py`、以及 `_` 前缀的那批诊断脚本。

1. **只读**：只做「读 + 畸形载荷被拒」。线上是两人真实数据，不是沙箱——
   往 `api/compat.php` 发一次合法 `create`、往 `api/daily.php` 发一次作答、
   发一条 `message_add`，都会写进你们真实的页面。任何写操作都不许加进来。
   需要测写路径就回本地 `php -S`。
2. **绝不测"错误密码"路径**：`api/unlock.php` 一旦走到密码校验就计一次失败，
   累计到上限会锁门，两个人都进不去。（现有探针传 `action: []`，在校验前就以
   「未知操作」返回，所以不消耗次数。）`verify_vps.py` 则直接**不调用** `api/unlock.php`。

## 本机临时脚本（`_` 前缀，被 `.gitignore` 排除，收尾应清理）

- `_test_lowrisk_fixes.py`、`_test_compat.py`、`_local_gate_fix_test.js`、
  `_test_malformed_compat.py`、`_test_device_identity.py`、`_test_unlock_fallback.js`、
  `_test_gate_whitespace.js`、`_test_anniv_next.js`、`_test_music_autoplay.js`、
  `_test_admin_fuzz.js`、`_test_audit_fixes.js`、`_test_audit_fixes_2.py`（服务端）、
  `_test_audit_fixes_2.js`（浏览器侧）、`_test_audit_fixes_3.js`、
  `_test_audit_fixes_4.py`（服务端）、`_test_audit_fixes_4.js`（浏览器侧）、
  `_test_theme_contrast.js`、`_test_achievements.js`、`_test_audit_tools.py`、
  `_test_build_guard.py`、`_test_build_guard_4.py`、`_test_gitignore_guard.py`、
  `_test_runner_artifacts.py`、`_test_concurrent_writes.py`、`_test_docs_consistency.py`、
  `_test_round5_fixes.py`、`_test_suite_hygiene.py`、`_test_shell_music_continuity.js`、
  `_test_shell_lifecycle.js`：
  默认是本地 `php -S` 回归测试。
  ⚠️ **例外（别照字面理解成"只在本地跑"）**：`_ui_compat_test.js`、`_ui_handover_test.js`
  与 `_online_*.js` 是**打线上**的探针（站点地址从 `LOVE_SITE` 环境变量或第一个参数取，
  不传就退出），只读、但会真连站点 —— 第四轮 F-S13-06 就是把它们写成了"只在本地跑"。
  ⚠️ 别把这个 glob 当成"只有三条"：磁盘上 `tools/_online_*.js` 实测 **11 个**（2026-09-27，
  以 `ls tools/_online_*.js` 为准），其中 3 个列在下面的「线上只读探针」一节；
  其余 8 个（`_online_achievements_check.js`、`_online_e2e_unlock.js`、`_online_header_dump.js`、
  `_online_home_scroll.js`、`_online_music_cache_check.js`、`_online_music_timeline.js`、
  `_online_shell_continuity.js`、`_online_unlocked_check.js`）也在本节末尾逐个登记，
  **11 个全是打线上的只读脚本**，一个都不是"只在本地跑"。
  其中 `_test_suite_hygiene.py` 是**套件设施自身的体检**（守卫套件会不会红、计数有没有吞掉
  「跳过」、php 日志有没有跨套件共用），它体检的是"尺子"而不是被测代码 —— 见 F-S13-02/03/09/11。
  其中 `_test_docs_consistency.py` 是**纯文本核对**（不启服务、不碰 `data/`）：
  拿文档/配置里的原话去核对代码与磁盘（S14 片的那一族"文档承诺 X、代码实际 Y"）。
  其中 `_test_shell_music_continuity.js`（自带服务 8162）与 `_test_shell_lifecycle.js`
  （自带服务 8163）是**「站内切页音乐不断」改造（2026-09-23）**的两把尺子：
  前者量"开始播放后连点 6 次导航，audio 元素是否唯一、currentTime 是否单调、有没有新的
  play() 重试/NotAllowedError/超过 0.5 秒的断点"，并打印 currentTime 曲线原文
  （改前的多页实现在同一探针下必须是**红**的，否则这条判据不算有区分力）；
  后者量外壳的视图生命周期（深链 / 监听与定时器不累积〔反向样本是把"登记"改成不记账，
  等价于把那 10 处 `LC.on/every/observe` 改回裸调用 —— 注意：从外部把
  `LoveLifecycle.end` 换成空函数**没用**，`begin()` 内部兜底调的是闭包里的真 `end()`〕/
  返回键 / 每页功能仍可用 / JS 出错不白屏 / 连点竞态 / 音乐元素唯一）。
- **审查设施**（也是 `_` 前缀，属"跑套件的东西"，不是套件本身）：
  `_run_all_suites.py` —— 唯一入口的套件运行器（跑前逐套件还原 `data/` 快照、
  产出当天的基线汇总与逐套件原始输出，编号从不覆盖已有的，见 F-S13-18/20）；
  `_audit_fingerprint.py` —— 审查「闸门 2」的冻结面指纹（接口键路径 / DEFAULT_CONFIG 键集 /
  交付产物 sha256 / 页面状态码），只记结构不记内容；
  `_restore_data_snapshot.py` —— 被**强杀**之后的补救：从任一次 `_audit/baseline-*/_data-snapshot`
  把 `data/` 还原（默认挑最新的**干净**快照，即 `config.json` 里没有口令的那份），默认只打印计划、要 `--yes` 才动手。
- **线上只读探针**（会打线上，但只读；铁律见「线上探针」一节）：
  `_online_daily_check.js`、`_online_fix_markers_3.js`、`_online_header_403.js`。
  它们必须先在本地跑阴性对照（证明标记真的会红）才能用，且**绝不**在线上做写操作、
  **绝不**测错误口令（会消耗解锁失败次数并锁门）。
  `_online_header_403.js` 的阴性对照是**离线**的：`node tools/_online_header_403.js --selftest`
  （8 例合成响应，其中 5 例是「人为改坏必须红」）。它按 `server`/`cf-ray` 判定响应归属：
  本站源站发出的（含 301/302/403/404）**必须**带齐 5 个安全头，落在外站错误域的只登记不判头
  —— 本站的 403/404 会被宿主 vhost 的 `ErrorDocument` 302 到 `errors.infinityfree.net`
  （2026-09-18 只读实测，见 `_audit/edge-redirect-chain.txt`），旧版判据会把宿主页面算成本站缺头。
  失败时它以退出码 1 结束（旧版恒 0，FAIL 在自动化里不可见）。
  ⚠️ 这些套件都会改写/重建仓库 `data/` 夹具：lowrisk 与 device_identity 会 rmtree 重建
  （2026-09-13 起带整目录快照→恢复），unlock_fallback / gate_whitespace / music_autoplay /
  admin_fuzz / audit_fixes / audit_fixes_2 自己建自己的并跑完还原——**新写套件必须遵守同一条纪律，否则互相污染**
  （2026-09-13 曾因此把 unlock_fallback 依赖的夹具口令覆盖丢失）。
  `_test_audit_fixes_2.js` 会临时把 `data/config.json` 改成"门禁开启 + 未来 startDate"，
  跑完按跑前内容原样写回（它给的是哑口令，且被测请求永远挂住，**不会**消耗线上那种失败计数）。

  怎么起（在仓库根目录）：

  ```bash
  python tools/_test_lowrisk_fixes.py                   # 自带服务，70 项，最全
  python tools/_test_device_identity.py                 # 自带服务，22 项：设备身份/删除归属
  node   tools/_test_unlock_fallback.js                 # 自带服务，17 项：解锁页降级态（含 8s 超时等待）
  node   tools/_test_gate_whitespace.js                 # 自带服务，20 项：口令首尾空格/全角/锁定倒计时/非 JSON 响应/回弹提示/http→https 升级与本地豁免
  node   tools/_test_admin_fuzz.js                      # 自带服务（8139），54 项：admin 接口畸形载荷模糊测试（含 restore 哈希收窄回归）
  node   tools/_test_anniv_next.js                      # 无需服务，48 项：纪念卡/农历/脚本顺序/2-29 纪念日/烟花触发（Node + vm）
  node   tools/_test_music_autoplay.js                  # 自带服务（8138，门禁自动关），32 项：自动播放/被拒兜底/偏好记忆/跨页续播；跑完恢复 data/config.json
  node   tools/_test_audit_fixes.js                     # 自带服务（8141，门禁自动关），38 项：2026-09-14 审查修复验收（lunar 闰月守卫/本地 dayNo/主题强跳豁免/暗色状态样式含真浏览器对比度）
  python tools/_test_audit_tools.py                     # 无需服务，165 项：build.py 输出目录（临时副本里构建）/deploy.py remote_file_state 三态/只增不删契约/VPS 三件套（含 MSYS 路径改写守卫、清单与 rsync 排除同源、配置原子替换）
  python tools/_test_audit_fixes_2.py                   # 自带服务（8136），18 项：第二轮审查的服务端修复（默契度僵尸回合改标 abandoned 不再销毁 + TTL 放宽 + 提示明确；photo_add 撞 uid 时 mine 按真实归属算）；跑完整目录还原 data/（A5 现在带下界，夹具没触发也会红）
  node   tools/_test_audit_fixes_2.js                   # 自带服务（8142/8150/8152，门禁按组切换），61 项：第二轮审查的浏览器侧修复（本机存储写失败不许报成功、连点只发一个请求、startDate 在未来时天数夹到 0、解锁提交的超时兜底、请求挂住时按钮必须恢复〔时钟快进实测〕、后台遇到缺答案的回合不崩且不误算百分比）+ 关键写法静态锁；另含 server.js 超时机制的 vm 断言
  # ⚠️ 8143/8144 是 `_test_achievements.js` 与 `_test_audit_fixes_3.js` 的登记端口（第四轮 F-S13-08
  #    之后本套件改用 8150/8152）。**8151 的端口双占已在第七轮 S13b-04 修掉**：8151 归
  #    `_test_round6_ui.js` 专有，本套件的 G 组改用未占用的 8152（runner extra_ports 同步登记）。
  #    换端口之后"孤儿 php 活过整轮"这条闸门才真正成立（收尾只杀声明过的端口）。
  node   tools/_test_achievements.js                    # 自带服务（8143，门禁自动关），86 项：成就墙（vm 跑真源码验阈值边界/抗畸形/数据源优先级/分享卡断行按码点〔A21〕 + 真浏览器验渲染与 1080×1920 分享长图 + 接入静态锁）
  # 其余套件（项数直接取自最近一次基线 `_audit/love-baseline-*.txt`，别再手抄数字）：
  # 唯一入口是 `_run_all_suites.py`（**文件名带下划线前缀**；写成 tools/run_all_suites.py
  # 会 "can't open file"）。套件数别信手抄的：`--list` 末尾会打印「共 N 套」，以它实测为准。
  python tools/_run_all_suites.py                      # 跑完全部套件并产出当天基线（**当前实测 43 套**，以 `--list` 末尾打印的「共 N 套」为准）
  python tools/_run_all_suites.py --list               # 只列出注册表（含每套的 kind/端口/门禁/备注）
  python tools/_run_all_suites.py --only compat,achievements    # 只跑名字含这些子串的套件
  python tools/_run_all_suites.py --timeout-scale 2    # 超时倍数（机器慢时用）
  node   tools/_test_audit_fixes_3.js                 # 87 项  （F1 静态锁改成只看生效代码：注释里的字样不再豁免/命中）
  node   tools/_test_audit_fixes_4.js                 # 193 项  （X4 改花括号配对取函数体；全量跑有断言条数下限）
  python tools/_test_audit_fixes_4.py                 # 127 项  自带服务 8145 + M 组敌对服务器专有 8153（runner extra_ports 已登记）
  python tools/_test_build_guard.py  "<仓库根>/tools/build.py"         # 11 项  必须把 build.py 的绝对路径当参数传（缺参数直接 IndexError，别误判成套件坏了）
  python tools/_test_build_guard_4.py "<仓库根>/tools/build.py"        # 18 项  同上（runner 内部就是这么传的）
  python tools/_test_concurrent_writes.py             # 11 项
  python tools/_test_docs_consistency.py              # 11 项
  python tools/_test_gitignore_guard.py               # 13 项
  python tools/_test_suite_hygiene.py                 # 27 项  套件设施体检（守卫套件真的会红吗 / 计数有没有吞掉「跳过」/ php 日志有没有跨套件共用 / 每个套件是否真有**可执行**的失败出口；F-S13-02/03/09/11）。⚠️ D4 会**真跑一遍** `_test_lowrisk_fixes.py`（起 php -S 8132 + 重建 data/），所以别和 runner 同时跑；runner 里给它登记了 extra_ports=(8132,)
  python tools/_test_round5_fixes.py                  # 19 项  损坏数据兜底 / 口令布尔 / 安装器夺号 / 恢复零写入（自带临时目录树，不碰 data/）
  python tools/_test_round6_fixes.py                  # 26 项  两层长度口径一致（R5-6）/ 写窗口内读侧共享锁（R5-7）/ 年周期锚点必须是真实日期（R5-14）（自带临时目录树，不碰 data/）
  node   tools/_test_round6_js_core.js                # 71 项  第六轮 js-core：compat.js 半截本机记录兜底/降级提示/提交遇宿主 HTML 错误页（R6-6：不许把 SyntaxError 噪音糊到界面、不许说成网络问题）、server.js 非 JSON 响应归类成 badResponse（**不置** server，否则内容页会丢本机副本）、main.js 重复 rAF 链与续播定时器（含 R6-8：元数据未到时 currentTime 的 seek 回显不许被认成「已到位」）、game.js 写入失败不许报新纪录（纯 vm 沙箱，不起服务、不碰 data/）
  node   tools/_test_round6_js_data.js                # 29 项  第六轮 js-data：gallery.js 迁移期三源合并、capsules.js 代次令牌、progress.js 锚点日期必须真实存在（纯 vm 沙箱，不起服务、不碰 data/）
  node   tools/_test_round6_ui.js                     # 56 项  第六轮 UI 修复（R5-15 对比度 / R5-16a~d：断行码点+省略号、fillFitted 必设 font、lunar 越界返 null、startDate 非法不全页早退、分享失败要说话）；A~E 段纯 Node+vm，F/G 段真浏览器用 php -S（8151 **专有**，自带 data/config.json 快照与还原），可加 --no-browser 只跑 Node 段（48 项）；子集跑会打印 SUBSET 标记，全量跑有断言条数下限
  python tools/_test_runner_artifacts.py              # 7 项
  node   tools/_test_theme_contrast.js                # 58 项  真机对比度；自带 php -S 8147（**专有**；`_test_audit_fixes_4.py` 的 M 组已改用 8153），收尾删自己的 php 日志
  node   tools/_test_home_scroll.js                   # 8 项  自带服务（8161）：进入首页必须停在页面顶部（daily.js 的 focus 带 preventScroll），含 S1 反证（不带参数的 focus 确实会滚动 → 证明探针有区分度）+ 手机/桌面两视口 + 其余 7 页 + 静态锁 + 断言条数下限；**逐文件**快照还原 data/（config/daily/security 三个文件，不再 rmtree 整目录）
  node   tools/_test_shell_music_continuity.js        # 12 项  自带服务（8162）：「站内切页音乐不断」的判据（元素唯一 / currentTime 单调 / 无新的 play() 重试 / 无 NotAllowedError / 无超过 0.5 秒的断点），并打印 currentTime 曲线原文；改前的多页实现在同一探针下是**红**的（反证留痕在 _audit/）
  node   tools/_test_shell_lifecycle.js               # 64 项  自带服务（8163）：视图外壳（深链 / 监听与定时器不累积〔反向样本＝让"登记"不记账〕/ 返回键 / 每页功能仍可用 / JS 出错不白屏 / 连点竞态 / 门禁复核）；按 LoveShell.pages 自适应，迁移未完成时后半段单独记为「跳过」
  # 第七轮（2026-09-27）全量审查新增七套（项数取自当天基线，端口均已登记进 runner）：
  node   tools/_test_r7_js_core.js                    # 26 项  第七轮核心批次（纯 vm 沙箱，不起服务、不碰 data/）：server.js 快照消费语义〔首屏用注入快照/之后实时拉/失败回退〕、daily.js 挂载实时化、lifecycle.js 入口视图账本、letters.js 本机 uid 确定性、shell.js 锚点与代次保护、achievements.js 实时取数与缺元素防护
  node   tools/_test_r7_js_edge.js                    # 51 项  第七轮边界批次（纯 vm 沙箱）：countdown once 日期守卫、calendar `.ics` UID 稳定身份、game.js 定时器走账本且落盘不丢、sharecard 2-29 窗口
  python tools/_test_r7_php_a.py                      # 84 项  第七轮 PHP-A（php-cli，临时目录树，不碰 data/）：门禁配置读取进共享锁、保存侧不许把口令故障态写成语义关闭、长度口径 trim/UTF-16 同尺、注入 json_encode 兜底、题库两层同尺、限流桶类型收窄、daily 日期存在性
  python tools/_test_r7_php_b.py                      # 72 项  第七轮 PHP-B（自带 php -S 8173/8174）：写接口 uid 去重键、compat 两侧答案完整才 done、abandoned 标记、限流分桶、改口令长度上限、401 语义、restore 计数与提示、后台不下发 deviceId
  python tools/_test_r7_php_c.py                      # 9 项   第七轮 S12-03：运行时目录保护模板的归属判据（部署侧 .htaccess 不许被运行时静默覆盖；旧版宽松文件仍可升级）
  python tools/_test_r7_tools.py                      # 77 项  第七轮工具链：verify_vps 判据/打码/异常收口、vps_setup 路径守卫与临时文件清理、deploy 照片三态、build 输出目录判定收窄、nginx/htaccess 目录列表与版本号
  node   tools/_test_r7_css.js                        # 104 项 第七轮样式（自带 Node 静态服务 8164，不 spawn php）：换视图首帧可见/平滑滚动让位程序化滚动/对比度与焦点/Tab 可达性/长文不裁切/#view 高度
  node   tools/_test_r7_js_shell2.js                  # 23 项  第七轮外壳批次2（纯 vm 沙箱）：目标页在子目录时脚本 src 按目标页 URL 解析、`#view` 里相对 src/href 绝对化（含 `#`/`javascript:`/`mailto:`/`download` 阴性对照）、换视图 aria-live 播报（同标题不重复）、7 个真实页脚本 URL 逐字不变
  python tools/_test_r7_php_d.py                      # 60 项  第七轮 PHP 残留（php-cli，临时目录树）：限流额度/窗口移进 lib/ 只定义一处、love_mutate 只清理"本次新建且仍 0 字节"的文件、口令上限唯一来源、unlock 文案与面板自检改 UTF-16 码元、security.json 三态（缺失/空/损坏 fail-closed）、面板百分比同源 compat_pct、admin 那份超时活到 body 读完

  node   tools/_local_walkthrough.js                  # 自带服务（8160），21 项：阶段二走查——真浏览器逐页开 8 页 + /admin/，真点真填（解锁/留言/情书/胶囊/每日一问/默契问答 10 题/相册上传），全程收集 JS 报错与 assets 4xx/5xx，收尾扫 PHP 错误日志；整份快照还原 data/，但不许与 _run_all_suites.py 同时跑（两边都写 data/）

  php -S 127.0.0.1:8130 -t .    # 另开一个终端
  php -S 127.0.0.1:8131 -t .
  node   tools/_local_gate_fix_test.js                  # 门禁三场景，10 项（跑在 8130）
  python tools/_test_malformed_compat.py                # 畸形 compat.json（跑在 8130）
  python tools/_test_compat.py                          # 回合制全链路，26 项（跑在 8131）
  ```

  ⚠️ **跑门禁那套之前先把限流状态清干净**：`data/security.json` 里的
  `gate_block` 会让解锁页进入"锁定倒计时"（输入框被禁用），此时套件会以
  `page.fill('#pwInput')` 超时失败 —— 看起来像代码坏了，其实是夹具被上一次
  运行留下的失败计数锁住了。稳妥做法：跑前写入
  `{"gate_fails":[],"gate_block":[],"hits":{}}`。

  ⚠️ **门禁开关是互斥的，别在同一轮里混着跑**：`_test_compat.py` 要求门禁**关闭**
  （`data/config.json` 的 `password` 为空），否则 `api/compat.php` 一律 401，
  它会以 `KeyError: 'round'` 失败（看起来像代码坏了，其实是夹具状态）；
  而 `_local_gate_fix_test.js` 要求门禁**开启**、口令正好是它写的 `test1234`。
  稳妥顺序：先 `password:""` 跑完 compat 两项，再改成 `test1234` 跑门禁那项。
  `_test_gate_whitespace.js` 自带服务、自己写夹具（口令 `520520`），
  跑完会把 `data/config.json` 留成 `520520` —— 接着跑 compat 两项前记得改回 `""`。

  **夹具要求**：`_local_gate_fix_test.js` 与 `_test_malformed_compat.py` 需要
  本地存在 `data/`（后者要 `data/compat.json`）；门禁测试还要求
  `data/config.json` 里的 `password` 就是它写的 `test1234`（用测试口令，别用真实口令）。
  本地 `data/` 是运行期产物、已被 gitignore，收尾删掉即可，下次跑前按需重建：

  ```bash
  mkdir -p data && printf '{"password":"test1234"}' > data/config.json
  ```

  跑测试会在本地 `data/` 留下 compat 回合与限流状态（`compat.json`、
  `security.json`、`gate_secret`），属于正常现象，删掉不影响任何东西。
- `_check_remote_device_ids.py`：**只读**核查线上 `data/*.json` 里 deviceId 的**形态**
  （只输出计数，不打印 id 值与任何真实内容），并顺手拉一份改前快照到 `%TEMP%`。
  收紧身份规则（`lib/store.php` 的 `LOVE_DEV_PATTERN`）之前先跑它，
  确认不会把历史记录孤儿化。
- `_verify_remote.py`：FTPS 回读线上文件并比对 sha256（部署后验收用）。
  默认清单含 `.htaccess` 与各 PHP；**也能校验不在 dist 里的文件**（如根 `.htaccess`
  按 deploy.py 的 EXTRA_FILES 映射回 `deploy/.htaccess`）——直接把它当参数传即可，
  如 `... _verify_remote.py --creds <凭据文件> .htaccess assets/js/main.js`。
  注意：它只证明"文件传对了"，不证明"规则生效"（后者看 `_online_header_dump.js`）。
- `_online_achievements_check.js`：**只读**线上成就墙验收 —— 解锁后验证等级卡/48 条成就/五个分组/雷达图真的渲染出来、分享长图能生成且尺寸正好 1080×1920、全程无 JS 报错。用**正确**口令解锁（不消耗失败计数），不做任何写操作。启动方式同 `_check_console_errors.js`：
  `python tools/_run_online_check.py --creds "<凭据文件>" --script tools/_online_achievements_check.js`
- `_check_console_errors.js`：**只读**线上运行时体检——真浏览器打开 8 页，收集
  JS 运行时报错、控制台 error 与 `assets/` 下 4xx/5xx。内容型探针只能看出
  「页面 200、无 PHP 报错」，抓不到 JS 运行期异常，改过前端脚本后建议跑一遍。
  启动方式与 `online_probe.js` 相同（`LOVE_SITE_HOST` + `LOVE_UNLOCK_PW` 由启动器注入）。
- `_online_shell_continuity.js`：**只读**线上验收「站内切页音乐不断」（2026-09-23 改造）。
  判据与本地探针同口径（元素唯一 / 单文档 / 无新 play() 重试 / 无 NotAllowedError /
  无超过 0.5 秒的断点），并打印线上 currentTime 曲线原文；另验 `window.LoveShell.pages`
  是 7 页（证明新文件确实上线）。用**正确**口令解锁（不消耗失败计数），只发 GET：
  `python tools/_run_online_check.py --creds "<凭据文件>" --script tools/_online_shell_continuity.js`
- `_online_home_scroll.js`：**只读**线上验收「进入首页停在最上端」（2026-09-23 用户反馈
  的缺陷，修在 `daily.js` 的 `focus({preventScroll:true})`）。四条判据：L1 进入
  home.html 后 `scrollY===0`、L2 每日一问输入框仍是焦点（功能没被砍）、L3 反证（线上不带
  preventScroll 的 focus 确实会滚动 → 证明 L1 不是"页面本来就不够高"的假绿）、L4 其余 6 页
  也在顶部。用**正确**口令解锁，不做任何写操作：
  `python tools/_run_online_check.py --creds "<凭据文件>" --script tools/_online_home_scroll.js`
- `_audio_diag.js`、`_music_ui_test.js`：音乐链路诊断（需 `LOVE_SITE`，打线上）。
  2026-09-12 换曲后，「页脚署名行」相关的断言已在两处翻转为**必须不存在**：
  `_music_ui_test.js` 的第 2 组、`_test_music_autoplay.js` 的 F1
  （原来的写法是断言署名行存在且含 `Canon in D Major`）。将来若把署名加回来，
  这两处要一起改，否则会假失败。
- **`_cleanup_compat.py`：会写线上**——管理员登录后调 `content_delete` 删除线上
  默契度记录。只在确实要清理线上脏数据时用，别当测试脚本跑。
- `_upload_music.py`：用 STOR 覆盖线上音乐文件（一次性工具）。
- `_run_online_check.py`：**只读**线上脚本启动器 —— 站点地址取凭据文件首行、
  解锁口令经 FTPS 读服务器 `data/config.json`，都用环境变量注入子进程，只打印
  长度不打印内容。默认跑 `_music_ui_test.js`（音乐链路），可换脚本：
  `python tools/_run_online_check.py --creds "<凭据文件>" --script tools/_check_console_errors.js`
- `_online_header_dump.js`：**只读**线上响应头对照（CSS/JS/音频/PHP 各来一遍），
  顺带回读安全头（HSTS/nosniff/X-Robots-Tag）与图片直链保护是否仍返回 403。
  改过 `.htaccess` 后必跑 —— sha256 一致只证明文件传对了，不证明规则生效。
- `_online_music_cache_check.js`：**只读**实测每次整页导航时音乐真实传输多少字节
  （CDP dataReceived，比 resource timing 的 transferSize 可信）+ 缓存相关响应头。
- `_online_music_timeline.js`：**只读**从打开站点到出声的分段耗时（冷启动 / 热缓存 /
  限速 5KB/s 三种），用来判断"慢"到底慢在页面还是慢在音频。
- `_online_e2e_unlock.js`、`_online_unlocked_check.js`：早期线上探针，已被
  `online_probe_unlocked.js` 取代；前者会真实提交解锁口令（用对了不会吃失败计数）。
