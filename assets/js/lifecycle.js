/* ============================================================
   情侣网站 · 视图生命周期登记（定时器 / 全局监听 / 观察者的统一登记与清理）
   ------------------------------------------------------------
   为什么需要它：改造后站内切页是"换视图"而不是"换文档"，页面脚本会被**重新执行**，
   而它们挂在 document/window 上的监听、setInterval、IntersectionObserver 不会随
   视图内容一起消失 —— 不登记就会一次一页地累积（切 6 次页面 = 6 份定时器）。

   设计原则（很重要）：
     · **非挂载期一律透传** —— 直接打开某一页时 current 为 null，
       on/every/after/observe 就是 addEventListener/setInterval/... 本身，
       行为与改造前**逐字节等价**（阶段 1 的验收就是"全量套件 0 失败"）。
     · **显式登记，不做全局劫持** —— 劫持 document.addEventListener 会把外壳自己
       在挂载期里"迟到的"注册（音乐自动播放被拒时挂的 pointerdown、音乐探测回调里
       挂的 setInterval）也算进视图账本，切页时被误清 → 出现"提示还在、点了没反应"
       这类极难定位的 bug。外壳的这类注册走 shell() 显式豁免。
     · 账本在**整个挂载期**保持打开（不是只在脚本执行那一瞬间），
       否则页面脚本里"网络回来之后才挂的定时器"（如 compat.js 的轮询）会漏账。

   **哪些登记必须走账本、哪些故意不走**（判据是"会不会无界累积 / 会不会作用在你已经
   离开的那一页上"，而不是"是不是定时器"）：
     · 必走：所有**重复**注册（setInterval）、挂在 document/window 上的监听、
       观察者（IntersectionObserver 等）、以及"有用户可见副作用的一次性定时器"
       （例如纪念日当天的烟花、默契度按钮文案复位 —— 视图都换掉了还去改它没有意义）。
     · 故意不走：**纯清理动作**的一次性定时器，如 `URL.revokeObjectURL(url)`。
       它们在几秒内自己结束、不会累积；登记了反而会在切页时被取消，
       把一个 blob URL 永远留在内存里 —— 那才是真的泄漏。
     · 元素级监听不需要登记：它挂在视图里的元素上，innerHTML 一换就随之消失。
   ============================================================ */

(function () {
  "use strict";

  if (window.LoveLifecycle) return;      // 幂等：重复引入只生效一次

  var current = null;      // 当前视图的账本；null = 不在挂载期（透传）
  var suspend = 0;         // >0 = 外壳上下文，登记一律绕过账本
  var seq = 0;             // 挂载代次（每次 begin() 加一），供幂等守卫使用
  var guards = null;       // 本次挂载里已经跑过的守卫键

  function recording() { return current !== null && suspend === 0; }

  function stats() {
    return {
      active: current !== null,
      suspend: suspend,
      generation: seq,
      listeners: current ? current.listeners.length : 0,
      timers: current ? current.timers.length : 0,
      observers: current ? current.observers.length : 0,
      guards: guards ? guards.size : 0,
    };
  }

  /* ---------- 登记 API（非挂载期透传） ---------- */

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    if (recording()) current.listeners.push({ target: target, type: type, fn: fn, opts: opts });
    return fn;
  }

  /* 主动注销：与 on 对称。页面脚本自己摘监听时走这里，
     账本里那条也要一并划掉 —— 否则 unmount 时会对同一个 fn 再摘一次
     （removeEventListener 对同一 (target,type,fn) 是幂等的，但留着记录会让
     "账本归零"这类断言失去意义）。 */
  function off(target, type, fn, opts) {
    target.removeEventListener(type, fn, opts);
    if (!current) return;
    for (var i = current.listeners.length - 1; i >= 0; i--) {
      var r = current.listeners[i];
      if (r.target === target && r.type === type && r.fn === fn) current.listeners.splice(i, 1);
    }
  }

  function every(fn, ms) {
    var id = setInterval(fn, ms);
    if (recording()) current.timers.push(id);
    return id;
  }

  function after(fn, ms) {
    var id = setTimeout(fn, ms);
    if (recording()) current.timers.push(id);
    return id;
  }

  /* 主动清一个定时器：与 every/after 对称 */
  function clear(id) {
    if (id === null || id === undefined) return;
    try { clearInterval(id); } catch (e) {}
    try { clearTimeout(id); } catch (e) {}
    if (!current) return;
    for (var i = current.timers.length - 1; i >= 0; i--) {
      if (current.timers[i] === id) current.timers.splice(i, 1);
    }
  }

  function observe(observer) {
    if (recording() && observer) current.observers.push(observer);
    return observer;
  }

  /* 幂等守卫：同一个键在一次挂载里只放行一次（外壳的挂载钩子、重复初始化都用它） */
  function guard(key) {
    if (!guards) return true;
    if (guards.has(key)) return false;
    guards.add(key);
    return true;
  }

  /* 外壳上下文：里面的登记绕过账本（见文件头"显式登记"那段的原因） */
  function shell(fn) {
    suspend++;
    try { return fn(); }
    finally { suspend--; }
  }

  /* ---------- 挂载边界（由 shell.js 调用） ---------- */

  function begin() {
    if (current) end();          // 没正常收尾就又开了 → 先把旧账清掉，绝不留半份
    seq++;
    current = { listeners: [], timers: [], observers: [] };
    guards = new Set();
    return seq;
  }

  function end() {
    var b = current;
    current = null;
    guards = null;
    var done = { listeners: 0, timers: 0, observers: 0 };
    if (!b) return done;
    b.listeners.forEach(function (r) {
      try { r.target.removeEventListener(r.type, r.fn, r.opts); done.listeners++; } catch (e) {}
    });
    b.timers.forEach(function (id) {
      try { clearInterval(id); } catch (e) {}
      try { clearTimeout(id); } catch (e) {}
      done.timers++;
    });
    b.observers.forEach(function (o) {
      try { o.disconnect(); done.observers++; } catch (e) {}
    });
    b.listeners.length = 0;
    b.timers.length = 0;
    b.observers.length = 0;
    return done;
  }

  /* ---------- 首屏（入口视图）也要进账本 ----------
     页面脚本在解析期执行，而 shell.js 是最后一个 `<script>`（body 末尾）—— 在外壳启动
     之前，页面脚本的注册就已经发生了，那一刻 current 还是 null → 全部透传、不记账；
     外壳第一次换视图时 LC.end() 拿到 null，什么都清不掉，入口页的定时器与全局监听
     永久驻留（第七轮 S7-02：首页的 1s 时钟、相册的 document keydown 都属这一类）。

     本文件在 <head> 里、早于任何页面脚本，所以在这里就为"当前文档即将被外壳接管的
     那个视图"开账本。shell.js 挂载时照旧 end()+begin()：end() 会把入口视图这一份
     清干净。解锁页不加载本文件；file:// 下外壳惰性（shell.js 直接 return），账本一直
     开着也没有副作用 —— 没有 end 就没有清理，与改造前逐字节等价。
     注意：外壳自己那批注册走 LC.shell() 显式豁免（main.js 的 shellOn/shellEvery），
     不会被这份账本记进去，所以首屏清理不会碰到导航/音乐/返回顶部这些常驻功能。 */
  begin();

  window.LoveLifecycle = {
    on: on, off: off, every: every, after: after, clear: clear, observe: observe,
    guard: guard, shell: shell, begin: begin, end: end, stats: stats,
  };
})();
