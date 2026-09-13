# tools/ 工具说明

## 正式工具（进版本库）

| 文件 | 作用 | 是否会写线上 |
|---|---|---|
| `build.py` | 由源码生成 `dist/`（构建产物，不入库） | 否 |
| `deploy.py` | FTPS 只增不删上传 `dist/`（跳过 `data/`、uploads、真实照片、音乐） | 写"文件"，不动运行时数据 |
| `online_probe.py` | 线上只读实测启动器：从凭据文件取站点地址、经 FTPS 取解锁口令后启动下面两个脚本 | 否 |
| `online_probe.js` | 线上未解锁阶段（20 项）：WAF、注入、接口响应体干净、7 页可访问 | 否 |
| `online_probe_unlocked.js` | 线上解锁态阶段（27 项）：门禁分级、真实解锁、接口 JSON、畸形载荷被拒 | 否 |

### 用法

```bash
python tools/build.py
python tools/deploy.py --creds "<凭据文件>"          # 只增不删
python tools/online_probe.py --creds "<凭据文件>"     # 两阶段线上只读实测
python tools/online_probe.py --creds "<凭据文件>" --phase locked    # 只跑未解锁阶段
```

站点地址是敏感值，不写进仓库：启动器读**凭据文件首行**（裸域名），
也可用 `--site` 或环境变量 `LOVE_SITE_HOST` 显式指定。
解锁口令不入库、不进命令行、不落盘：启动器经 FTPS 读服务器 `data/config.json`，
在内存里取出后用子进程环境变量交给 node 脚本，只打印长度。

### 线上探针铁律

1. **只读**：只做「读 + 畸形载荷被拒」。线上是两人真实数据，不是沙箱——
   往 `api/compat.php` 发一次合法 `create`、往 `api/daily.php` 发一次作答、
   发一条 `message_add`，都会写进你们真实的页面。任何写操作都不许加进来。
   需要测写路径就回本地 `php -S`。
2. **绝不测"错误密码"路径**：`api/unlock.php` 一旦走到密码校验就计一次失败，
   累计到上限会锁门，两个人都进不去。（现有探针传 `action: []`，在校验前就以
   「未知操作」返回，所以不消耗次数。）

## 本机临时脚本（`_` 前缀，被 `.gitignore` 排除，收尾应清理）

- `_test_lowrisk_fixes.py`、`_test_compat.py`、`_local_gate_fix_test.js`、
  `_test_malformed_compat.py`、`_test_device_identity.py`、`_test_unlock_fallback.js`、
  `_test_gate_whitespace.js`、`_test_anniv_next.js`、`_test_music_autoplay.js`、
  `_test_admin_fuzz.js`、`_ui_compat_test.js`、`_ui_handover_test.js`：本地 `php -S` 回归测试，只在本地跑。
  ⚠️ 这些套件都会改写/重建仓库 `data/` 夹具：lowrisk 与 device_identity 会 rmtree 重建
  （2026-09-13 起带整目录快照→恢复），unlock_fallback / gate_whitespace / music_autoplay /
  admin_fuzz 自己建自己的并跑完还原——**新写套件必须遵守同一条纪律，否则互相污染**
  （2026-09-13 曾因此把 unlock_fallback 依赖的夹具口令覆盖丢失）。

  怎么起（在仓库根目录）：

  ```bash
  python tools/_test_lowrisk_fixes.py                   # 自带服务，70 项，最全
  python tools/_test_device_identity.py                 # 自带服务，22 项：设备身份/删除归属
  node   tools/_test_unlock_fallback.js                 # 自带服务，17 项：解锁页降级态（含 8s 超时等待）
  node   tools/_test_gate_whitespace.js                 # 自带服务，20 项：口令首尾空格/全角/锁定倒计时/非 JSON 响应/回弹提示/http→https 升级与本地豁免
  node   tools/_test_admin_fuzz.js                      # 自带服务（8139），54 项：admin 接口畸形载荷模糊测试（含 restore 哈希收窄回归）
  node   tools/_test_anniv_next.js                      # 无需服务，15 项：纪念卡/农历/脚本顺序/2-29 纪念日（Node + vm）
  node   tools/_test_music_autoplay.js                  # 自带服务（8138，门禁自动关），23 项：自动播放/被拒兜底/偏好记忆/跨页续播；跑完恢复 data/config.json
  php -S 127.0.0.1:8130 -t .    # 另开一个终端
  php -S 127.0.0.1:8131 -t .
  node   tools/_local_gate_fix_test.js                  # 门禁三场景，10 项（跑在 8130）
  python tools/_test_malformed_compat.py                # 畸形 compat.json（跑在 8130）
  python tools/_test_compat.py                          # 回合制全链路，26 项（跑在 8131）
  ```

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
- `_check_console_errors.js`：**只读**线上运行时体检——真浏览器打开 7 页，收集
  JS 运行时报错、控制台 error 与 `assets/` 下 4xx/5xx。内容型探针只能看出
  「页面 200、无 PHP 报错」，抓不到 JS 运行期异常，改过前端脚本后建议跑一遍。
  启动方式与 `online_probe.js` 相同（`LOVE_SITE_HOST` + `LOVE_UNLOCK_PW` 由启动器注入）。
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
