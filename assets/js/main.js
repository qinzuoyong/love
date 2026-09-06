/* ============================================================
   情侣网站 · 通用脚本
   负责: 导航 / 品牌名 / 飘心背景 / 音乐盒 / 滚动动画 /
         返回顶部 / Toast / 彩带 / 解锁页花瓣
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 品牌名 & 页面标题 ---------- */
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = CONFIG.names.boy + " ♥ " + CONFIG.names.girl;
  });
  const heroNames = document.getElementById("heroNames");
  if (heroNames) {
    heroNames.innerHTML =
      CONFIG.names.boy + ' <span class="amp">♥</span> ' + CONFIG.names.girl;
  }
  // 浏览器标签页标题带上名字(便于多标签识别, 改名后自动跟着变)
  document.title = CONFIG.names.boy + " ♥ " + CONFIG.names.girl + " · " + document.title;

  /* ---------- 导航: 滚动阴影 / 高亮当前页 / 移动端菜单 ---------- */
  const nav = document.getElementById("nav");
  const topBtn = document.getElementById("topBtn");

  function onScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 8);
    if (topBtn) topBtn.classList.toggle("show", window.scrollY > 420);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if (topBtn) {
    topBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // 当前页高亮（body 上的 data-page 与导航链接的 href 匹配）
  const page = document.body.dataset.page || "";
  document.querySelectorAll(".nav-links a").forEach((a) => {
    if (a.getAttribute("href") === page) a.classList.add("active");
  });

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

    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    const MAX = window.innerWidth < 640 ? 14 : 22;
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

    function drawHeart(x, y, r, t, hue, alpha) {
      ctx.save();
      ctx.translate(x + Math.sin(t * 0.001 + heart_phase) * 14, y);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "hsl(" + hue + ", 75%, 78%)";
      ctx.beginPath();
      ctx.moveTo(0, r * 0.32);
      ctx.bezierCurveTo(-r, -r * 0.35, -r * 0.45, -r, 0, -r * 0.28);
      ctx.bezierCurveTo(r * 0.45, -r, r, -r * 0.35, 0, r * 0.32);
      ctx.fill();
      ctx.restore();
    }

    let heart_phase = 0;
    function frame(ts) {
      if (!running) return;
      heart_phase = ts;
      ctx.clearRect(0, 0, W, H);
      spawn(false);
      hearts = hearts.filter((h) => h.y > -60);
      hearts.forEach((h) => {
        h.y -= h.vy;
        drawHeart(h.x, h.y, h.r, ts, h.hue, h.alpha);
      });
      animLoop(frame);
    }
    // 首屏先铺一批
    for (let i = 0; i < MAX; i++) spawn(true);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { running = false; }
      else if (!running) { running = true; animLoop(frame); }
    });
    animLoop(frame);
  }

  /* ---------- 音乐盒(WebAudio 合成, 无需音频文件) ----------
     默认播放一段轻音乐盒旋律; 若存在 assets/music/music.mp3
     则优先播放你的专属音乐(把 mp3 放进 assets/music/ 即可) */
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

    start() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { toast("当前浏览器不支持音频"); return; }
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
      this.ctx.resume();
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.1;
      this.timer = setInterval(() => this.schedule(), 120);
      this.playing = true;
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
  // 优先播放 assets/music/music.mp3(存在时), 否则用内置 WebAudio 合成音乐盒
  let audioEl = null;
  let usingMp3 = false;
  let musicPlaying = false;
  let audioFail = false;    // mp3 实际加载失败(服务器返回的可能是 WAF 挑战页而非音频)
  let pendingPlay = false;  // 用户已点播放但音频还在下载, 就绪后自动续播

  const musicBtn = document.getElementById("musicBtn");
  if (musicBtn) {
    function setMusicUI() {
      const el = document.getElementById("musicIcon");
      musicBtn.classList.toggle("off", !musicPlaying);
      if (el) el.textContent = musicPlaying ? "🔊" : "🔇";
    }

    // mp3 不可用时的兜底: 切内置合成旋律, 保证点了就一定有声音
    function fallbackSynth(msg) {
      usingMp3 = false;
      audioFail = true;
      pendingPlay = false;
      if (audioEl) { try { audioEl.pause(); } catch (e) {} }
      SynthMusic.start();
      musicPlaying = SynthMusic.playing;
      setMusicUI();
      if (msg) toast(msg, true);
    }

    // 探测 mp3 是否存在(仅 http 环境可行); file:// 下直接走合成音乐
    if (location.protocol.startsWith("http")) {
      fetch("assets/music/music.mp3", { method: "HEAD" })
        .then((r) => {
          if (!r.ok) return;
          // 只认真正的音频响应: WAF 挑战页也是 200 但 content-type 是 text/html,
          // 若放行会让 audioEl 加载 HTML 而静默无声
          const ct = (r.headers.get("content-type") || "").toLowerCase();
          if (!/audio|mpeg|octet-stream/.test(ct)) return;
          usingMp3 = true;
          audioEl = new Audio("assets/music/music.mp3");
          audioEl.loop = true;
          audioEl.volume = 0.55;
          audioEl.addEventListener("error", function () {
            if (usingMp3) fallbackSynth("音频加载失败，已切换内置旋律");
          });
          // 用户点过播放而音频还没就绪(服务器慢时可能等十几秒): 就绪后自动续播
          audioEl.addEventListener("canplay", function () {
            if (pendingPlay && usingMp3 && !audioFail) {
              pendingPlay = false;
              audioEl.play().then(function () {
                musicPlaying = true;
                setMusicUI();
                toast("♪ 音乐响起，送给你");
              }).catch(function () { fallbackSynth("播放失败，已切换内置旋律"); });
            }
          });
          // 若合成音乐已在播放, 立即停掉, 避免双音轨
          if (SynthMusic.playing) SynthMusic.stop();
        })
        .catch(() => {});
    }

    musicBtn.addEventListener("click", () => {
      if (usingMp3 && audioEl && !audioFail) {
        if (audioEl.paused) {
          if (audioEl.readyState >= 3) {
            audioEl.play().catch(() => fallbackSynth("播放失败，已切换内置旋律"));
          } else {
            // 音频还在下载: 明确提示"加载中", 就绪后自动播放, 不会让人以为坏了
            pendingPlay = true;
            toast("♪ 音乐加载中，请稍候…");
          }
        } else {
          audioEl.pause();
        }
        musicPlaying = !audioEl.paused;
      } else {
        SynthMusic.toggle();
        musicPlaying = SynthMusic.playing;
      }
      setMusicUI();
      if (musicPlaying) toast("♪ 音乐响起，送给你");
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
    const canvas = document.getElementById("confettiCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = (canvas.width = innerWidth);
    const H = (canvas.height = innerHeight);
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
    const cv = document.getElementById("fxCanvas");
    if (!cv) return;
    if (sessionStorage.getItem("fx-done")) return; // 本页会话只放一次
    sessionStorage.setItem("fx-done", "1");
    const ctx = cv.getContext("2d");
    const W = (cv.width = innerWidth);
    const H = (cv.height = innerHeight);
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

  /* ---------- 解锁页花瓣(仅 index.html) ---------- */
  if (document.getElementById("petalCanvas")) {
    const cv = document.getElementById("petalCanvas");
    const cx = cv.getContext("2d");
    let W, H, petals = [];
    function rs() {
      W = cv.width = innerWidth;
      H = cv.height = innerHeight;
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
    function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
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

  /* ---------- 启动飘心 ---------- */
  cursorHearts();
  createHeartsCanvas();
})();
