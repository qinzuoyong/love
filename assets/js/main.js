/* ============================================================
   情侣网站 · 通用脚本
   负责: 导航 / 品牌名 / 飘心背景 / 音乐盒 / 滚动动画 /
         返回顶部 / Toast / 彩带 / 解锁页花瓣
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 视图生命周期 ----------
     本文件属**外壳级**：站内切页时它是"换视图"而不是"换文档"，所以本文件只跑一次，
     它建的监听/定时器要活过整个会话。因此外壳自己的注册一律走 LC.shell() 显式豁免，
     绝不能被视图账本清掉（清了会出现"提示还在、点了没反应"这类极难定位的 bug）；
     页面脚本则走 LC.on/every 登记、切页时统一清理。 */
  const LC = window.LoveLifecycle || null;
  function shellOn(target, type, fn, opts) {
    if (LC && LC.shell) LC.shell(function () { target.addEventListener(type, fn, opts); });
    else target.addEventListener(type, fn, opts);
  }
  function shellEvery(fn, ms) {
    if (LC && LC.shell) return LC.shell(function () { return setInterval(fn, ms); });
    return setInterval(fn, ms);
  }

  /* ---------- 品牌名 & 页面标题 ---------- */
  /* 这两个抽成函数：站内切页换视图后，新视图里的 [data-brand] 与 #heroNames
     需要重新回填，而外壳本身只跑一次（见 shell.js 的 loveOnViewMounted）。 */
  function loveBrandFill() {
    document.querySelectorAll("[data-brand]").forEach((el) => {
      el.textContent = CONFIG.names.boy + " ♥ " + CONFIG.names.girl;
    });
    const heroNames = document.getElementById("heroNames");
    if (heroNames) {
      const esc = window.escHtml || ((v) => String(v === null || v === undefined ? "" : v));
      heroNames.innerHTML =
        esc(CONFIG.names.boy) + ' <span class="amp">♥</span> ' + esc(CONFIG.names.girl);
    }
  }
  // 浏览器标签页标题带上名字(便于多标签识别, 改名后自动跟着变)
  function loveSetTitle(pageTitle) {
    document.title = CONFIG.names.boy + " ♥ " + CONFIG.names.girl + " · " + pageTitle;
  }
  loveBrandFill();
  loveSetTitle(document.title);

  /* ---------- 无障碍：跟随系统的"减弱动态效果" ----------
     开了就停掉飘心/光标爱心这类持续动画，打字机直接出全文（见各页脚本）。 */
  const reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  window.__loveReduceMotion = reduceMotion;

  /* ---------- 高分屏适配 ----------
     给 canvas 设 width/height 时乘上 devicePixelRatio，并用 setTransform 把
     绘制坐标系还原成 CSS 像素 —— 这样脚本里继续按 innerWidth/innerHeight
     书写坐标即可，而在 DPR>1 的手机上不再发虚。
     注意：给 canvas.width 赋值会重置 2D 上下文状态，所以每次都要重新设变换。 */
  function fitCanvas(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // 上限 2：再高只是徒增开销
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  window.loveFitCanvas = fitCanvas;

  /* ---------- 顶部滚动进度条（transform: scaleX，走合成层） ---------- */
  let scrollBar = null;
  if (!reduceMotion) {
    scrollBar = document.createElement("div");
    scrollBar.className = "scroll-bar";
    scrollBar.setAttribute("aria-hidden", "true");
    document.body.appendChild(scrollBar);
  }

  /* ---------- 导航: 滚动阴影 / 高亮当前页 / 移动端菜单 ---------- */
  const nav = document.getElementById("nav");
  const topBtn = document.getElementById("topBtn");

  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 8);
    if (topBtn) topBtn.classList.toggle("show", window.scrollY > 420);
    if (scrollBar) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      scrollBar.style.transform = "scaleX(" + p + ")";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (topBtn) {
    topBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // 当前页高亮（body 上的 data-page 与导航链接的 href 匹配）
  /* 抽成函数：外壳的导航栏在切页后**不会重建**，所以必须先把上一页的 active
     摘干净再高亮新的 —— 直接沿用"每次都是新文档"的旧写法会累积多个高亮。 */
  function loveNavHighlight() {
    const page = document.body.dataset.page || "";
    document.querySelectorAll(".nav-links a").forEach((a) => {
      const on = a.getAttribute("href") === page;
      a.classList.toggle("active", on);
      /* 读屏用户拿不到"我在哪一页"这条信息（原来只有 .active 这个纯视觉类）；
         aria-current 是这件事的标准表达（第七轮 S15-05）。 */
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  loveNavHighlight();

  const navToggle = document.getElementById("navToggle");
  const navLinks = document.querySelector(".nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => navLinks.classList.toggle("open"));
    navLinks.addEventListener("click", (e) => {
      if (e.target.tagName === "A") navLinks.classList.remove("open");
    });
  }

  /* ---------- 动画循环(带降级: rAF 存在但不触发时自动切 setTimeout) ---------- */
  let animMode = null; // null=未探测 / "raf" / "timeout"
  function animLoop(cb) {
    const drive = () => cb(Date.now());
    if (animMode === "timeout") { setTimeout(drive, 33); return; }
    if (animMode === "raf") { requestAnimationFrame(drive); return; }
    // 首次调用: 探测 rAF 是否真的会回调
    if (typeof requestAnimationFrame !== "function") {
      animMode = "timeout";
      drive();
      return;
    }
    let fired = false;
    const rafId = requestAnimationFrame(() => { fired = true; animMode = "raf"; drive(); });
    setTimeout(() => {
      if (!fired) {
        animMode = "timeout";
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
        drive();
      }
    }, 150);
  }
  window.animLoop = animLoop; // 供 progress.js 等外部脚本复用

  /* ---------- 背景飘心 ---------- */
  function createHeartsCanvas() {
    const canvas = document.createElement("canvas");
    canvas.id = "heartsCanvas";
    document.body.prepend(canvas);
    const ctx = canvas.getContext("2d");
    let W, H, hearts = [], running = true;
    /* 代次令牌（R5-10）：页面隐藏时已经排进队列、但还没执行的那条 rAF 回调**不会**
       被浏览器丢弃 —— 重新可见时它会和 visibilitychange 里新排的一条并存，于是每
       切走再回来就多出一条链（2→3→4…），CPU/耗电随链数线性增长。
       每条链建立时领一个代次；回调发现自己的代次不是当前代次，就只收尾、不续链。 */
    let loopGen = 0;

    function resize() {
      W = window.innerWidth;
      H = window.innerHeight;
      fitCanvas(canvas, W, H);
    }
    resize();
    window.addEventListener("resize", resize);

    const MAX = reduceMotion ? 0 : (window.innerWidth < 640 ? 14 : 22);
    function spawn(force) {
      if (hearts.length < MAX && (force || Math.random() < 0.06)) {
        hearts.push({
          x: Math.random() * W,
          y: H + 30,
          r: 6 + Math.random() * 14,
          vy: 0.35 + Math.random() * 0.8,
          sway: 0.4 + Math.random() * 0.8,
          phase: Math.random() * Math.PI * 2,
          alpha: 0.12 + Math.random() * 0.2,
          hue: Math.random() < 0.75 ? 340 : 265, // 粉 / 淡紫
        });
      }
    }

    /* phase 用每颗心自己的随机相位：早先这里读的是全局 heart_phase（其实存的是
       帧时间戳），于是变成 sin(ts*0.001 + ts) —— 每帧都在跳，视觉上是左右高频
       抖动；而 spawn() 里生成的 h.phase 从来没被读过。 */
    function drawHeart(x, y, r, t, hue, alpha, phase) {
      ctx.save();
      ctx.translate(x + Math.sin(t * 0.001 + phase) * 14, y);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "hsl(" + hue + ", 75%, 78%)";
      ctx.beginPath();
      ctx.moveTo(0, r * 0.32);
      ctx.bezierCurveTo(-r, -r * 0.35, -r * 0.45, -r, 0, -r * 0.28);
      ctx.bezierCurveTo(r * 0.45, -r, r, -r * 0.35, 0, r * 0.32);
      ctx.fill();
      ctx.restore();
    }

    function frame(ts, gen) {
      if (!running || gen !== loopGen) return;   // 已隐藏，或是一条陈旧链 → 到此为止
      ctx.clearRect(0, 0, W, H);
      spawn(false);
      hearts = hearts.filter((h) => h.y > -60);
      hearts.forEach((h) => {
        h.y -= h.vy;
        drawHeart(h.x, h.y, h.r, ts, h.hue, h.alpha, h.phase);
      });
      animLoop((t) => frame(t, gen));            // 续的是同一条链 → 沿用同一个代次
    }
    function startHeartsLoop() {
      const gen = ++loopGen;                     // 作废所有在途链
      animLoop((t) => frame(t, gen));
    }
    // 首屏先铺一批
    for (let i = 0; i < MAX; i++) spawn(true);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { running = false; loopGen++; }
      else if (!running) { running = true; startHeartsLoop(); }
    });
    startHeartsLoop();
  }

  /* ---------- 音乐盒(WebAudio 合成, 无需音频文件) ----------
     默认播放一段轻音乐盒旋律; 若存在 assets/music/music.dat
     则优先播放你的专属音乐(把音频命名为 music.dat 放进 assets/music/ 即可) */
  const SynthMusic = {
    ctx: null, master: null, delay: null, timer: null,
    playing: false, step: 0, nextTime: 0,

    // 简谱: [音名, 时值(拍)], 每 4 拍一个小节, 共 4 小节
    melody: [
      ["C4", 1], ["E4", 1], ["G4", 1], ["B4", 1],
      ["C5", 2], ["B4", 1], ["G4", 1],
      ["A4", 1], ["F4", 1], ["A4", 1], ["C5", 1],
      ["D5", 2], ["C5", 1], ["A4", 1],
      ["G4", 1], ["E4", 1], ["G4", 1], ["B4", 1],
      ["A4", 2], ["F4", 1], ["A4", 1],
      ["G4", 2], ["E4", 1], ["C4", 1], ["D4", 2], ["E4", 2],
    ],
    // 低音伴奏(每小节一个根音)
    bass: ["C3", "F3", "G3", "C3"],

    freq(name) {
      const notes = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      const m = name.match(/^([A-G])(\d)$/);
      const n = notes[m[1]] + (parseInt(m[2], 10) + 1) * 12;
      return 440 * Math.pow(2, (n - 69) / 12);
    },

    note(f, t, dur, vol, type) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || "triangle";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.delay);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    },

    schedule() {
      while (this.nextTime < this.ctx.currentTime + 0.5) {
        const beat = 0.36;                 // 每拍时长
        const step = this.step;
        const total = this.melody.length;
        // 旋律
        const [name, len] = this.melody[step % total];
        this.note(this.freq(name), this.nextTime, beat * len * 0.92, 0.16);
        // 每小节低音
        if (step % 16 === 0) {
          const bar = (step / 16) | 0;
          this.note(this.freq(this.bass[bar % 4]), this.nextTime, beat * 15.5, 0.10, "sine");
        }
        this.nextTime += beat * len;
        this.step++;
      }
    },

    /* 返回"是否真的响起来了"（R5-16a）：调用方据此决定要不要点亮"在响"。
       AudioContext 可能不存在、构造可能被策略拒绝、resume() 可能同步抛 —— 旧实现把
       这几条都当成起播成功，于是图标亮着、实际一点声音都没有（与 mp3 那条路上
       fallbackSynth 的处理是同一族）。resume() 的**异步**拒绝在这里无法同步判定，
       只吞掉它以免变成未处理的拒绝。 */
    start() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) { toast("当前浏览器不支持音频"); return false; }
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.9;
          this.delay = this.ctx.createDelay();
          this.delay.delayTime.value = 0.28;
          const fb = this.ctx.createGain();
          fb.gain.value = 0.32;
          const wet = this.ctx.createGain();
          wet.gain.value = 0.35;
          this.delay.connect(fb);
          fb.connect(this.delay);
          this.delay.connect(wet);
          wet.connect(this.master);
          this.master.connect(this.ctx.destination);
        }
        const res = this.ctx.resume();
        if (res && typeof res.catch === "function") res.catch(function () {});
        this.step = 0;
        this.nextTime = this.ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 120);
        this.playing = true;
        return true;
      } catch (e) {
        // 起不来就如实收场：不留下"在响"的状态，也不留下还在跑的调度器
        this.playing = false;
        clearInterval(this.timer);
        this.timer = null;
        return false;
      }
    },
    stop() {
      clearInterval(this.timer);
      this.timer = null;
      if (this.ctx) {
        this.ctx.suspend();
      }
      this.playing = false;
    },
    toggle() {
      if (this.playing) this.stop();
      else this.start();
    },
  };

  // ---------- 音乐控制 ----------
  // 优先播放 assets/music/music.dat(存在时), 否则用内置 WebAudio 合成音乐盒。
  // 进站即尝试自动播放; 浏览器拦下时退到"点一下屏幕任意位置就响"。
  let audioEl = null;
  let usingMp3 = false;
  let musicPlaying = false;
  let audioFail = false;    // mp3 实际加载失败(服务器返回的可能是 WAF 挑战页而非音频)
  let starting = false;     // 一次启动流程还在进行中(play() 的 promise 还没落地)
  let playTimer = null;     // play() 迟迟不落地的看门狗(见 tryStart 里的说明)

  const MUSIC_KEY = "love-music";          // "on" / "off": 用户的开关偏好
  const MUSIC_POS_KEY = "love-music-pos";  // 播放到第几秒: 跳页时接着放
  const MUSIC_POS_SAVE_MS = 5000;
  /* play() 的 promise 既不 resolve 也不 reject 时，等多久就按"你自己点一下"处理。
     取 12s：比同文件 HEAD 探测用的 8s 更宽，正常"策略放行→等真正出声"的慢启动
     通常远快于它；万一真落在窗口外，也只是多显示一句**自愈**的提示
     （音频随后响起来时 onPlaying() 会立刻把它收掉）。 */
  const PLAY_SETTLE_TIMEOUT_MS = 12000;
  /* 音频文件用 .dat 而不是 .mp3(2026-09-13 探针实测): 主机边缘层按【扩展名】给
     音频强加 Cache-Control: no-store —— 同字节文件叫 .mp3 就被禁缓存(每次翻页
     重新下载约 40KB、出声等 2-4 秒), 叫 .dat 就拿到正常的 30 天缓存, 且浏览器
     照样当音频解码。
     ⚠️ 千万不要在 .htaccess 给 .dat 加 AddType audio/mpeg —— 边缘层会重新把它
     识别成音频, no-store 就回来了。
     地址带版本号: 音频不像 css/js 那样被 build.py 自动打版本号, 换曲时必须手动
     把 v=N 加一, 否则浏览器最久 30 天都在放缓存里的旧曲子。 */
  const MUSIC_URL = "assets/music/music.dat?v=1";

  // 浏览器禁用了站点存储(隐私模式)时, 读写失败都不该影响播放本身
  function musicPrefOn() {
    try { return localStorage.getItem(MUSIC_KEY) !== "off"; } catch (e) { return true; }
  }
  function setMusicPref(on) {
    try { localStorage.setItem(MUSIC_KEY, on ? "on" : "off"); } catch (e) {}
  }
  function saveMusicPos() {
    try {
      if (audioEl && !audioEl.paused && audioEl.currentTime > 1) {
        localStorage.setItem(MUSIC_POS_KEY, String(Math.floor(audioEl.currentTime)));
      }
    } catch (e) {}
  }
  function readMusicPos() {
    try { return parseFloat(localStorage.getItem(MUSIC_POS_KEY)) || 0; } catch (e) { return 0; }
  }

  const musicBtn = document.getElementById("musicBtn");
  if (musicBtn) {
    function setMusicUI() {
      const el = document.getElementById("musicIcon");
      musicBtn.classList.toggle("off", !musicPlaying);
      if (el) el.textContent = musicPlaying ? "🔊" : "🔇";
    }

    // mp3 不可用时的兜底: 切内置合成旋律, 保证点了就一定有声音。
    // 只允许在有用户手势时调用 —— WebAudio 没有手势时起不来, 会把图标点成"在响"却没有声音。
    function fallbackSynth(msg) {
      usingMp3 = false;
      audioFail = true;
      starting = false;
      if (audioEl) { try { audioEl.pause(); } catch (e) {} }
      /* 合成旋律也可能起不来（无 AudioContext / 被策略拒）：只有真起来了才按
         "已切换内置旋律"说，否则别把图标点成"在响"却没有声音（R5-16a）。 */
      const synthOk = SynthMusic.start();
      musicPlaying = SynthMusic.playing;
      disarmWake();
      musicBtn.classList.remove("loading");
      setMusicUI();
      if (msg) toast(synthOk ? msg : "音频起不来，这台设备/浏览器可能不支持", true);
    }

    /* 自动播放被拦下时的兜底: 让按钮呼吸 + 提示一句, 并等"用户第一次点击/按键"立刻播放。
       监听挂在捕获阶段(第三个参数 true), 页面上任何元素的点击都能触发, 包括会
       stopPropagation 的按钮和链接。不做静音自动播放 —— 静音等于没声音, 没有意义。 */
    let wakeArmed = false;
    let onWake = null;
    /* 提示做成"常驻"的而不只是 2.4 秒的 toast: 一闪就没的提示最容易被理解成
       "一直在加载/是不是坏了"。这块提示与音乐按钮同高并列, 出声后立即消失,
       并且 pointer-events:none, 所以它永远不会挡住"点一下任意处"那一下。 */
    let hintEl = null;
    function showHint() {
      if (hintEl) return;
      hintEl = document.createElement("div");
      hintEl.className = "music-hint";
      hintEl.textContent = "点一下开始播放音乐";
      document.body.appendChild(hintEl);
    }
    function hideHint() {
      if (!hintEl) return;
      try { hintEl.remove(); } catch (e) {}
      hintEl = null;
    }
    function armWake(msg) {
      if (wakeArmed) return;
      wakeArmed = true;
      musicBtn.classList.remove("loading");   // 已在等缓冲 → 升级成"点一下就能响"
      musicBtn.classList.add("wake");
      showHint();
      if (msg) toast(msg);
      onWake = function (e) {
        /* 点音乐按钮本身时直接交给它的 click 处理器: 否则捕获阶段的 pointerdown
           先起播、紧接着 click 又看到"在响"把它暂停, 点一下等于没点。 */
        if (musicBtn.contains(e.target)) return;
        disarmWake();
        tryStart(true);
      };
      /* 外壳级注册（豁免视图账本）：自动播放被拒时挂的这两个监听可能发生在
         某个视图的挂载期内（起播看门狗 12s 到点、或用户中途点了一下），
         若被记进视图账本就会在切页时被清掉，而 wakeArmed 仍为 true
         → 提示一直挂着、点了却不再有任何反应。 */
      shellOn(document, "pointerdown", onWake, true);
      shellOn(document, "keydown", onWake, true);
    }
    function disarmWake() {
      hideHint();
      if (!wakeArmed) return;
      wakeArmed = false;
      musicBtn.classList.remove("wake");
      if (onWake) {
        document.removeEventListener("pointerdown", onWake, true);
        document.removeEventListener("keydown", onWake, true);
        onWake = null;
      }
    }

    // 自动播放突然满音量很吓人, 起播时淡入
    let fadeTimer = null;
    function fadeIn(el) {
      clearInterval(fadeTimer);
      let v = 0;
      el.volume = 0;
      fadeTimer = setInterval(function () {
        v = Math.min(0.55, v + 0.055);
        try { el.volume = v; } catch (e) {}
        if (v >= 0.55) clearInterval(fadeTimer);
      }, 150);
    }

    function onPlaying() {
      musicPlaying = true;
      starting = false;
      disarmWake();
      musicBtn.classList.remove("loading");
      setMusicPref(true);
      setMusicUI();
    }

    function clearPlayTimer() {
      if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    }

    /* 唯一的启动入口: 想让它响的时候都走这里, 不再各自写一遍 play()。
       fromGesture=true 表示这次调用来自用户操作 —— 只有这时才允许退到合成旋律。 */
    function tryStart(fromGesture) {
      if (musicPlaying || starting) return;
      if (usingMp3 && audioEl && !audioFail) {
        starting = true;
        /* 不等 readyState 就调 play():
           ① 自动播放被策略拦下时, play() 会**立刻**拒绝(不理会缓冲进度), 于是"点一下
              屏幕"的提示马上就能出来 —— 等缓冲完再调的话, 慢主机上要让人对着不动的
              按钮干等几十秒甚至几分钟(整曲比原来的卡农大了近三倍, 更明显);
           ② 策略放行时 play() 的 promise 会一直等到真正出声才 resolve, 行为不变。 */
        musicBtn.classList.add("loading");
        var playing = audioEl.play();
        /* 老内核（Chrome 42–49 / Firefox 39–52）的 play() **返回 undefined** 而不是 Promise。
           直接对它 .then 会立刻抛 TypeError，被外层 .catch 吞掉 —— 而那时 starting 已经置位，
           五处复位点又全在 Promise 回调里，于是状态机卡死在"加载中"：点屏幕提示消失却不出声、
           再点按钮永远只回一句「音乐加载中」（第四轮 F-S5-01）。
           没有 Promise 可等就按"已经开始播"处理：直接 onPlaying() 复位并更新 UI；
           真的播不起来由下面 audioEl 的 error 监听兜底。 */
        if (!playing || typeof playing.then !== "function") {
          fadeIn(audioEl);
          onPlaying();
          return;
        }
        /* play() 的 promise 可能**既不 resolve 也不 reject**：缓冲卡住、宿主不响应，
           又始终不触发 error。旧码对这一支没有任何兜底 —— starting 永远为 true、按钮
           永远转圈、「点一下屏幕任意位置」的提示也永远不出现，用户连"点一下试试"的
           机会都没有（第五轮 §2.3 第 3 条把它记为"待验证"，第六轮真机探针实测确认
           成立：12s 后仍是 class="loading"、无 wake、无 .music-hint）。
           给一条宽限看门狗：到点仍未落地就按"你自己点一下"处理。armWake() 会把
           loading 升级成 wake + 常驻提示；音频随后真响起来时 onPlaying() 会
           disarmWake 收尾，随后才 reject 的则照常走下面的 catch。 */
        clearPlayTimer();
        playTimer = setTimeout(function () {
          playTimer = null;
          if (!starting) return;      // 已经 onPlaying() 或经别的路径复位过了
          starting = false;
          armWake("点一下屏幕任意位置，音乐就响");
        }, PLAY_SETTLE_TIMEOUT_MS);
        playing.then(function () {
          clearPlayTimer();
          fadeIn(audioEl);
          onPlaying();
        }).catch(function (err) {
          clearPlayTimer();
          starting = false;
          musicBtn.classList.remove("loading");
          /* NotAllowedError = 浏览器拦了自动播放。这时绝不能退到合成旋律:
             WebAudio 同样需要手势才能出声, 退了只会让图标亮着却没有声音。
             其它错误(解码失败等)且有手势时, 才是真的换内置旋律。 */
          if (fromGesture && !(err && err.name === "NotAllowedError")) {
            fallbackSynth("播放失败，已切换内置旋律");
          } else {
            armWake("点一下屏幕任意位置，音乐就响");
          }
        });
        return;
      }
      // 没有 mp3(或已失败): 合成旋律必须有手势才起得来
      if (fromGesture) {
        /* 只有真的响起来才点亮"在响"（R5-16a）：start() 回 false（无 AudioContext /
           构造被策略拒 / 抛异常）时走已有的 armWake 提示分支，绝不假装在播。 */
        if (SynthMusic.start()) onPlaying();
        else armWake("点一下屏幕任意位置，音乐就响");
      } else {
        armWake("点一下屏幕任意位置，音乐就响");
      }
    }

    // 探测 mp3 是否存在(仅 http 环境可行); file:// 下直接走合成音乐
    function noMp3() {
      if (musicPrefOn()) armWake("点一下屏幕任意位置，音乐就响");
    }

    if (location.protocol.startsWith("http")) {
      /* 探测必须带超时：挂住时 .then 与 .catch(noMp3) 都不跑 → 既不设 usingMp3、
         也不调 noMp3()，"点一下屏幕任意位置，音乐就响"这句常驻提示永远不会出现，
         自动播放也不会被尝试（用户以为音乐坏了）。超时后按"没有 mp3"处理。 */
      var headReq = (typeof window.loveTimedFetch === "function")
        ? window.loveTimedFetch(MUSIC_URL, { method: "HEAD", timeoutMs: 8000 })
        : fetch(MUSIC_URL, { method: "HEAD" });
      headReq
        .then((r) => {
          if (!r.ok) { noMp3(); return; }
          // 只认真正的音频响应: WAF 挑战页也是 200 但 content-type 是 text/html,
          // 若放行会让 audioEl 加载 HTML 而静默无声。
          // 反向判断(只拒绝明确的文档类响应), 不做音频白名单 —— music.dat 没有
          // 音频扩展名语义, 主机/本地 php -S 可能不下发 content-type 或给
          // octet-stream, 白名单会把这些能正常解码的响应误杀。
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          if (/html|xml|json/.test(ct)) { noMp3(); return; }
          usingMp3 = true;
          audioEl = new Audio(MUSIC_URL);
          audioEl.loop = true;
          audioEl.volume = 0.55;
          audioEl.addEventListener("error", function () {
            if (!usingMp3) return;
            audioFail = true;
            starting = false;
            musicBtn.classList.remove("loading");
            /* 曾经响过说明这个文档里已经有手势, 可以直接切合成旋律;
               否则只能等用户点一下。绝不能在这里直接 start(), 否则会出现
               "图标在响、实际没声音"。 */
            if (musicPlaying) fallbackSynth("音频加载失败，已切换内置旋律");
            else armWake("背景音乐加载失败了，点一下屏幕听内置旋律");
          });
          /* 播放位置: 整曲循环时"从哪继续"要跟上次一致, 站内跳页才不会每次从头。
             先直接设(规范允许在元数据到来前设"默认起播位置"), 元数据到了再用真实
             时长校验一次 —— 换曲后旧的位置可能超出新曲长度, 那时退回开头。

             但**只设一次是不够的**：元数据到来时往往只缓冲了几秒，浏览器会把
             "跳到第 N 秒"夹到已经能 seek 的位置（实测：存了 9 秒，新页面从 1.1 秒
             开始播；机器/网络一忙就必现，闲时看不出来）。症状是"跳页后音乐偶尔
             从头开始"，而且不报任何错。所以这里改成"设了要确认"：
             在 canplay/progress/loadeddata 上反复补设，直到真的到位（或已经自然
             播过目标位置）。绝不往回跳，否则会像倒带。 */
          const savedPos = readMusicPos();
          let resumeTarget = savedPos > 1 ? savedPos : 0;
          /* 判据留痕：这条续播在负载下出过"看起来没续播"的疑难（2026-09-18 闸门里
             D1 红一次、同一份代码单跑两次绿），当时读数说明**根本没 seek**（新页面从
             1.0 秒连续播到 24.8 秒、没有任何前跳）。留一份"存了多少 / 判定时时长多少 /
             最后决定跳到哪 / 为什么放弃"的可读记录，下次红的时候能直接读出是哪条分支。 */
          const resumeDebug = { saved: savedPos, duration: 0, target: resumeTarget, note: "待元数据" };
          window.__loveMusicResume = resumeDebug;
          /* 定时器句柄与它唯一的清理出口（R5-16b）：
             resumeTimer 会被 applyResume / loadedmetadata / error 三处引用，所以先初始化为
             null，清理一律走 stopResumeTimer() —— 不存在"用到 null"或"清一个没建的定时器"。
             旧码无条件 `setInterval(applyResume, 500)`：resumeTarget 为 0 时 applyResume 每次
             都在 `if (!resumeTarget) return;` 提前返回，这个定时器永远不会被清掉，于是
             每次页面加载都泄漏一个 500ms 定时器（手机长会话里越积越多）。 */
          let resumeTimer = null;
          const stopResumeTimer = function () {
            if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
          };
          const applyResume = function () {
            /* 判据留痕挂在这里而不是只挂事件：实测 `loadedmetadata` 有时在监听器挂上
               之前就过去了（blob 源的元数据可能已就绪），只挂事件的话留痕永远停在
               "待元数据" —— 那等于没留。这个 500ms 的兜底定时器一定会跑。 */
            resumeDebug.target = resumeTarget;
            if (!resumeDebug.duration && audioEl.duration > 0) resumeDebug.duration = audioEl.duration;
            if (!resumeTarget) return;
            /* 判"到位"只认**位置已经到达目标**（或自然播过去了）。**不能**用
               `Math.abs(currentTime - resumeTarget) <= 0.5` 这种"读回来对得上就算到位"：
               元数据到达之前给 currentTime 赋值会被浏览器记成"起播位置"，读回来就是目标值
               （看着像成功了），于是这里立刻清掉目标、定时器停摆；等真正加载后浏览器把
               那次 seek 夹到已缓冲的位置（实测落到 1.0 秒），就再也没人补这一下 ——
               症状仍是"翻页后从头开始"（本轮第二次实测：D0 绿/D1 红、sawJump=false）。 */
            /* ★★ 光把判据从 `Math.abs(...)<=0.5` 换成 `>= target-0.5`（上面那段注释的改法）
               **还不够**：两种写法都在读 `currentTime`，而"回显假象"骗的正是这个读数 ——
               元数据到达之前赋值，浏览器把它记成"起播位置"，`currentTime` 当场读回目标值，
               判据成立 → resumeTarget 清零 + 定时器停掉；等真正加载后那次 seek 被丢弃/夹住，
               位置掉回 0，而**再没有人补这一下**，用户翻页回来听到的是从头开始。
               所以再加一道前提：**readyState < 1（连元数据都还没有）时 currentTime 不作数**，
               继续按"补设 + 等下一轮"处理；真到位了下一轮自然就认。
               （确定性的红→绿见 `_audit/_e2e_round6.js` N 段：把"回显 9 但 readyState=0"
                 桩出来，旧写法会认「已到位（续播成功）」并把 target 清零，新写法保持
                 target 并继续补设；N2 是正向对照 —— 元数据已到、位置确实在目标处时仍旧照认，
                 证明成功路径没被打断。
                 另注：想用真 `music.dat` 直接复现**没有**成功 —— `_probe_resume.js` 在无头
                 环境里 `paused:false / readyState:4` 却 20 秒内 `currentTime` 恒为 0，连
                 **手动**赋 `currentTime` 都读回 0，说明该环境没有媒体时钟、seek 是惰性的，
                 那条探针没有判别力。所以这里不声称"已证实用户可见缺陷"、也不推翻
                 F-S5-03d 的原判定，只记作**被桩证实的判据加固**。 */
            if (audioEl.readyState >= 1 && audioEl.currentTime >= resumeTarget - 0.5) {
              resumeDebug.note = "已到位（续播成功）";
              resumeTarget = 0;                    // 到过目标位置（或已播过去）→ 收工，绝不回跳
              stopResumeTimer();
              return;
            }
            resumeDebug.note = "已按存的位置续播";
            try { audioEl.currentTime = resumeTarget; } catch (e) {}
          };
          /* 光挂事件不够：缓冲补齐时 progress 可能早就不再触发（实测：文件已下完、
             seekable 已覆盖目标位置，可事件已经过去，于是"那一次补设"永远不发生）。
             加一个短周期定时器兜底，到位/放弃时自己清掉。
             ⚠️ resumeTarget 为 0 时**根本不要起**它（否则就是上面说的永不清泄漏）。 */
          if (resumeTarget) {
            resumeTimer = setInterval(applyResume, 500);
            try { audioEl.currentTime = resumeTarget; } catch (e) {}
          }
          /* 第三条终止分支：音频根本加载不出来时，续播已无意义 —— 收掉定时器，
             别让它在整个页面生命周期里空转。 */
          audioEl.addEventListener("error", function () {
            resumeDebug.note = "音频加载失败（放弃续播）";
            resumeTarget = 0;
            stopResumeTimer();
          });
          audioEl.addEventListener("loadedmetadata", function () {
            if (!resumeTarget) return;
            const d = audioEl.duration;
            resumeDebug.duration = d || 0;
            /* 只在"存的位置**超出**这首曲子"时才放弃续播（换曲场景）。
               ⚠️ 旧判据是 `resumeTarget > d - 3` —— 那 3 秒余量把**同一首曲子**的
               末段也当成了"换曲"：126 秒的曲子里，上次听到 124 秒 → 目标 124 > 123
               → 直接放弃、从头开始播。实测（本节 D3）就是这样：用户听到尾巴时跳页，
               回来一定从头。余量本来是为了"别差一点就 seek 到结尾"，但差一点的正确处理
               是照常 seek（顶多很快循环回开头），不是把整条续播丢掉。 */
            if (d && resumeTarget >= d) {
              resumeDebug.note = "目标超出时长（按换曲处理）";
              resumeTarget = 0;
              stopResumeTimer();
              return;
            }
            try { audioEl.currentTime = resumeTarget; } catch (e) {}
          });
          ["canplay", "loadeddata", "progress"].forEach(function (ev) {
            audioEl.addEventListener(ev, applyResume);
          });
          // 若合成音乐已在播放, 立即停掉, 避免双音轨（同时同步图标状态）
          if (SynthMusic.playing) {
            SynthMusic.stop();
            musicPlaying = false;
            setMusicUI();
          }
          /* 外壳级注册（豁免视图账本）：这条 HEAD 探测最长要等 8 秒才回来，
             回调很可能落在某个视图的挂载期内 —— 被记进视图账本的话，
             切页时"每 5 秒存一次播放位置"的定时器与 pagehide 兜底就被清掉了
             （音乐照放，但位置不再落盘）。 */
          shellEvery(saveMusicPos, MUSIC_POS_SAVE_MS);
          shellOn(window, "pagehide", saveMusicPos);
          shellOn(document, "visibilitychange", function () {
            if (document.hidden) saveMusicPos();
          });
          // 用户没关过音乐 → 进站就尝试自动播放(被拦下会退到"点一下即响")
          if (musicPrefOn()) tryStart(false);
        })
        .catch(noMp3);
    } else {
      noMp3();
    }

    musicBtn.addEventListener("click", () => {
      if (musicPlaying) {
        // 暂停: 记住"不想听", 下次进站不再自动播放
        if (usingMp3 && audioEl && !audioFail) {
          saveMusicPos();
          try { audioEl.pause(); } catch (e) {}
        } else {
          SynthMusic.stop();
        }
        musicPlaying = false;
        starting = false;
        musicBtn.classList.remove("loading");
        disarmWake();
        setMusicPref(false);
        setMusicUI();
        return;
      }
      setMusicPref(true);
      // 正在等缓冲(play() 的 promise 还没落地): 点一下给个明确说法, 别像没反应
      if (starting) { toast("♪ 音乐加载中，请稍候…"); return; }
      tryStart(true);
    });
  }

  /* ---------- 滚动浮现动画 ----------
     基于滚动监听 + 定时兜底(兼容所有环境, 不依赖 IntersectionObserver/rAF) */
  function revealNow() {
    document.querySelectorAll(".reveal:not(.visible)").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.94 && r.bottom > 0) {
        el.classList.add("visible");
      }
    });
  }
  window.addEventListener("scroll", revealNow, { passive: true });
  window.addEventListener("resize", revealNow);
  window.revealNow = revealNow; // 动态生成内容后手动调用
  revealNow();
  setInterval(revealNow, 1000); // 兜底: 任何环境都能浮现

  /* ---------- 站内切页（换视图）后，外壳要重做的事 ----------
     shell.js 每挂载完一个视图就调它一次（外壳级的监听/定时器不用重挂，
     要重做的只有"跟着新视图走"的那几件：品牌名回填、导航高亮、浮现动画）。
     抽成这个钩子而不是让 shell.js 直接调上面三个函数，是为了在 shell.js
     加载顺序变化（它排在 main.js 之后）时仍然只有一个入口。 */
  window.loveOnViewMounted = function () {
    loveBrandFill();
    loveNavHighlight();
    revealNow();
  };

  /* ---------- Toast 提示 ---------- */
  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }
  window.toast = toast;

  /* ---------- 通关彩带 ---------- */
  window.burstConfetti = function (duration) {
    /* 与花瓣/飘心同一口径：系统的"减弱动态效果"必须听（F-S10-02）。
       这两个是 canvas 逐帧画的，CSS 的 @media (prefers-reduced-motion) 碰不到它们，
       所以判在这里 —— 放在函数体第一句，任何调用方都绕不过去。 */
    if (reduceMotion) return;
    const canvas = document.getElementById("confettiCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = innerWidth;
    const H = innerHeight;
    fitCanvas(canvas, W, H);
    const colors = ["#f06292", "#ff8aab", "#f8bbd0", "#b39ddb", "#ffab91", "#f9a825"];
    const parts = [];
    for (let i = 0; i < 160; i++) {
      parts.push({
        x: W / 2, y: H / 2,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 1.2) * 14,
        g: 0.28 + Math.random() * 0.15,
        s: 5 + Math.random() * 7,
        c: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    const end = Date.now() + (duration || 3000);
    (function draw() {
      ctx.clearRect(0, 0, W, H);
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (Date.now() < end) animLoop(draw);
      else ctx.clearRect(0, 0, W, H);
    })();
  };

  /* ---------- 烟花庆祝(特殊日自动放) ----------
     参考 Awesome-Love-Code 等开源特效思路, 零依赖手写实现
     全屏透明覆盖层, 不挡任何操作; 每页每次最多放一轮 */
  window.launchFireworks = function (bursts) {
    /* 同彩带：canvas 特效不受 CSS 的 prefers-reduced-motion 管，必须在这里判（F-S10-02） */
    if (reduceMotion) return;
    const cv = document.getElementById("fxCanvas");
    if (!cv) return;
    /* 按页面区分：sessionStorage 是"每个标签页"共享的，用同一个键时同一标签页里
       只有第一个特殊日页面会放烟花，之后切到别的页面就不再庆祝了。
       存储被禁用时（隐私模式）直接照常放一次。 */
    var fxKey = "fx-done:" + location.pathname;
    try {
      if (sessionStorage.getItem(fxKey)) return;
      sessionStorage.setItem(fxKey, "1");
    } catch (e) { /* 站点存储不可用 → 不拦截 */ }
    const ctx = cv.getContext("2d");
    const W = innerWidth;
    const H = innerHeight;
    fitCanvas(cv, W, H);
    const colors = ["#f06292", "#ff8aab", "#f8bbd0", "#b39ddb", "#ffab91", "#f9a825", "#ffffff"];
    let parts = [];
    const maxBursts = bursts || 6;
    let fired = 0;

    function boom(x, y) {
      const n = 46 + (Math.random() * 24 | 0);
      const c = colors[(Math.random() * colors.length) | 0];
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.3;
        const sp = 2 + Math.random() * 5.2;
        parts.push({
          x: x, y: y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 1,
          decay: 0.012 + Math.random() * 0.02,
          c: c,
        });
      }
    }

    const end = Date.now() + 4200;
    (function draw() {
      ctx.clearRect(0, 0, W, H);
      // 定时从底部附近炸几发(错峰)
      if (Date.now() < end - 1500 && fired < maxBursts && Math.random() < 0.08) {
        boom(W * (0.2 + Math.random() * 0.6), H * (0.15 + Math.random() * 0.35));
        fired++;
      }
      parts.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.055; p.life -= p.decay;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      parts = parts.filter((p) => p.life > 0);
      if (Date.now() < end || parts.length) animLoop(draw);
      else ctx.clearRect(0, 0, W, H);
    })();
  };

  /* ---------- 解锁页花瓣(仅 index.html) ----------
     reduceMotion 与飘心同一口径（见文件末尾的启动飘心）：这 46 片花瓣是持续
     下落的常驻动画，正是"减少动态效果"要关掉的那一类。旧实现漏了这道判断，
     于是开了该选项的访客解锁页照样满屏花瓣。 */
  if (document.getElementById("petalCanvas") && !reduceMotion) {
    const cv = document.getElementById("petalCanvas");
    const cx = cv.getContext("2d");
    let W, H, petals = [];
    function rs() {
      W = innerWidth;
      H = innerHeight;
      fitCanvas(cv, W, H);
    }
    rs();
    addEventListener("resize", rs);
    const COUNT = innerWidth < 640 ? 28 : 46;
    for (let i = 0; i < COUNT; i++) {
      petals.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 5 + Math.random() * 8,
        vy: 0.5 + Math.random() * 1.2,
        vx: -0.4 + Math.random() * 0.8,
        rot: Math.random() * Math.PI,
        vr: -0.03 + Math.random() * 0.06,
      });
    }
    (function petalFrame() {
      cx.clearRect(0, 0, W, H);
      petals.forEach((p) => {
        p.y += p.vy; p.x += p.vx; p.rot += p.vr;
        if (p.y > H + 20) { p.y = -20; p.x = Math.random() * W; }
        if (p.x > W + 20) p.x = -20;
        if (p.x < -20) p.x = W + 20;
        cx.save();
        cx.translate(p.x, p.y);
        cx.rotate(p.rot);
        cx.globalAlpha = 0.7;
        const g = cx.createLinearGradient(0, -p.r, 0, p.r);
        g.addColorStop(0, "#ffc1d8");
        g.addColorStop(1, "#ff8fb3");
        cx.fillStyle = g;
        cx.beginPath();
        cx.ellipse(0, 0, p.r * 0.55, p.r, 0, 0, Math.PI * 2);
        cx.fill();
        cx.restore();
      });
      animLoop(petalFrame);
    })();
  }

  /* ---------- 光标跟随爱心(仅鼠标设备, 触屏自动关闭) ---------- */
  function cursorHearts() {
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return;
    const canvas = document.createElement("canvas");
    canvas.id = "cursorCanvas";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let W, H;
    function resize() { W = window.innerWidth; H = window.innerHeight; fitCanvas(canvas, W, H); }
    resize();
    window.addEventListener("resize", resize);

    const hearts = [];
    let lastSpawn = 0;
    window.addEventListener("pointermove", (e) => {
      const now = Date.now();
      if (now - lastSpawn < 60) return;
      lastSpawn = now;
      hearts.push({
        x: e.clientX + (Math.random() - 0.5) * 18,
        y: e.clientY + (Math.random() - 0.5) * 18,
        r: 5 + Math.random() * 7,
        vy: -0.5 - Math.random() * 0.6,
        alpha: 0.55,
        born: now,
        hue: Math.random() < 0.8 ? 340 : 265,
      });
      if (hearts.length > 26) hearts.shift();
    }, { passive: true });

    (function loop() {
      ctx.clearRect(0, 0, W, H);
      const now = Date.now();
      for (let i = hearts.length - 1; i >= 0; i--) {
        const h = hearts[i];
        const age = now - h.born;
        if (age > 800) { hearts.splice(i, 1); continue; }
        h.y += h.vy;
        const life = 1 - age / 800;
        ctx.save();
        ctx.translate(h.x, h.y);
        ctx.globalAlpha = h.alpha * life;
        ctx.fillStyle = "hsl(" + h.hue + ", 80%, 78%)";
        ctx.beginPath();
        ctx.moveTo(0, h.r * 0.32);
        ctx.bezierCurveTo(-h.r, -h.r * 0.35, -h.r * 0.45, -h.r, 0, -h.r * 0.28);
        ctx.bezierCurveTo(h.r * 0.45, -h.r, h.r, -h.r * 0.35, 0, h.r * 0.32);
        ctx.fill();
        ctx.restore();
      }
      animLoop(loop);
    })();
  }

  /* ---------- 启动飘心（系统开了减弱动态效果时全部跳过） ---------- */
  if (!reduceMotion) {
    cursorHearts();
    createHeartsCanvas();
  }
})();
