import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

type Env = { DB: D1Database; ADMIN_PASSWORD: string };

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*" }));

// 解析 geo/ua/browser/os/device 上下文，供 /track、/api/collect、/api/event 复用
function parseContext(c: Context<{ Bindings: Env }>) {
  const cf = (c.req.raw as any).cf ?? {};
  const ua = c.req.header("user-agent") ?? "";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome/.test(ua) ? "Chrome"
    : /Safari/.test(ua) ? "Safari"
    : /Firefox/.test(ua) ? "Firefox"
    : "";
  const os = /Windows/.test(ua) ? "Windows"
    : /Mac/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : "";
  const device = /Mobile/.test(ua) ? "mobile" : /Tablet|iPad/.test(ua) ? "tablet" : "desktop";
  const isCN = (cf.country ?? "") === "CN";
  return {
    country: (cf.country ?? "").slice(0, 64),
    city: isCN ? "" : (cf.city ?? "").slice(0, 64),
    region: (cf.region ?? "").slice(0, 64),
    ua: ua.slice(0, 512),
    browser, os, device,
    bot_score: cf.botManagement?.score ?? 0,
    ip: (c.req.header("CF-Connecting-IP") ?? "").slice(0, 45),
  };
}

app.get("/track.js", (c) =>
  c.text(`(function(d){
  var e=d.currentScript||d.querySelector('script[data-analytics]');
  var h=e?e.getAttribute('data-host'):'';
  if(!h)return;
  var p=location.pathname,r=d.referrer;
  function t(){navigator.sendBeacon?navigator.sendBeacon(h+'/track',JSON.stringify({path:p,referrer:r})):fetch(h+'/track',{method:'POST',body:JSON.stringify({path:p,referrer:r}),keepalive:!0})}
  t();
  var o=null;d.addEventListener('astro:page-load',t);d.addEventListener('turbolinks:load',t);
  window.addEventListener('popstate',function(){if(o!==location.pathname){o=location.pathname;p=o;t()}});
  // 全局事件埋点 API：seval.track(name, value) → POST /api/event
  window.seval={track:function(n,v){var b=JSON.stringify({name:n,value:v,path:location.pathname});navigator.sendBeacon?navigator.sendBeacon(h+'/api/event',b):fetch(h+'/api/event',{method:'POST',body:b,keepalive:!0})}};
})(document);`, {
    headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" },
  })
);

app.post("/track", async (c) => {
  const { path, referrer } = await c.req.json().catch(() => ({}));
  if (!path) return c.text("missing path", 400);
  const ctx = parseContext(c);

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO hits (path, country, city, region, ua, browser, os, device, bot_score, referrer, ip)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(
      path.slice(0, 512),
      ctx.country, ctx.city, ctx.region, ctx.ua,
      ctx.browser, ctx.os, ctx.device, ctx.bot_score,
      (referrer ?? "").slice(0, 512),
      ctx.ip,
    ).run()
  );

  return c.text("ok");
});

// ---- umami 兼容端点 ----
// 接收 umami tracker 的 POST /api/collect：type=pageview 写入 hits，type=event 写入 events
app.post("/api/collect", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const payload = body?.payload || body;
  const ctx = parseContext(c);
  const referrer = (payload?.referrer || body?.referrer || "").slice(0, 512);

  // umami 事件：type === 'event' 或携带 event_name
  if (payload?.type === "event" || payload?.event_name) {
    const name = String(payload?.event_name ?? "").slice(0, 512);
    if (!name) return c.text("missing event_name", 400);
    const ev = payload?.event_data;
    const value = (ev == null ? "" : typeof ev === "string" ? ev : JSON.stringify(ev)).slice(0, 512);
    const path = (payload?.url || payload?.path || "/").slice(0, 512);
    c.executionCtx.waitUntil(
      c.env.DB.prepare(
        `INSERT INTO events (name, value, path, country, city, region, ua, browser, os, device, bot_score, referrer, ip)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
      ).bind(name, value, path, ctx.country, ctx.city, ctx.region, ctx.ua, ctx.browser, ctx.os, ctx.device, ctx.bot_score, referrer, ctx.ip).run()
    );
    return c.text("ok");
  }

  // 默认 pageview
  const path = (payload?.url || payload?.path || "/").slice(0, 512);
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO hits (path, country, city, region, ua, browser, os, device, bot_score, referrer, ip)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(path, ctx.country, ctx.city, ctx.region, ctx.ua, ctx.browser, ctx.os, ctx.device, ctx.bot_score, referrer, ctx.ip).run()
  );
  return c.text("ok");
});

// ---- 原生事件端点 ----
// 接收 seval.track(name, value) 上报的事件
app.post("/api/event", async (c) => {
  const { name, value, path } = await c.req.json().catch(() => ({}));
  if (!name) return c.text("missing name", 400);
  const ctx = parseContext(c);
  const referrer = (c.req.header("referer") ?? "").slice(0, 512);

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO events (name, value, path, country, city, region, ua, browser, os, device, bot_score, referrer, ip)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`
    ).bind(
      String(name).slice(0, 512),
      (value == null ? "" : String(value)).slice(0, 512),
      (path ?? "").slice(0, 512),
      ctx.country, ctx.city, ctx.region, ctx.ua,
      ctx.browser, ctx.os, ctx.device, ctx.bot_score,
      referrer, ctx.ip,
    ).run()
  );

  return c.text("ok");
});

app.get("/api/stats", async (c) => {
  const days = Math.min(Number(c.req.query("days")) || 7, 90);

  // 并行查询各维度统计，顺序与下方解构变量一一对应：
  //   totals(PV+去重页面数) humanTotal(独立访客) countries(地域TOP30) browsers(浏览器)
  //   devices(设备) hourly(流量趋势) referrers(来源TOP10) topPages(热门页面TOP10)
  //   liveCount(实时在线) eventTotals(事件总数/类型数) events(TOP10事件)
  // 过滤 bot_score>=30 OR =0：排除 1-29 的疑似爬虫（events 同理）
  const [totals, humanTotal, countries, browsers, devices, hourly, referrers, topPages, liveCount, eventTotals, events] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) as total, COUNT(DISTINCT path) as pages FROM hits WHERE created_at > datetime('now', '-' || ? || ' days')`
    ).bind(days).first(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT ip) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND ip != ''`
    ).bind(days).first(),
    c.env.DB.prepare(
      `SELECT country, city, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY country, city ORDER BY count DESC LIMIT 30`
    ).bind(days).all(),
    c.env.DB.prepare(
      `SELECT browser, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY browser ORDER BY count DESC`
    ).bind(days).all(),
    c.env.DB.prepare(
      `SELECT device, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY device ORDER BY count DESC`
    ).bind(days).all(),
    c.env.DB.prepare(
      `SELECT ${days <= 2 ? "strftime('%Y-%m-%d ', created_at) || printf('%02d:00', (cast(strftime('%H', created_at) as integer) / 4) * 4)" : "strftime('%Y-%m-%d', created_at)"} as hour, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY hour ORDER BY hour`
    ).bind(days).all(),
    c.env.DB.prepare(
      "SELECT CASE WHEN referrer = '' THEN '直接访问' WHEN referrer LIKE '%google.%' THEN 'Google' WHEN referrer LIKE '%baidu.%' THEN '百度' WHEN referrer LIKE '%bing.%' THEN 'Bing' WHEN referrer LIKE '%github.%' THEN 'GitHub' ELSE referrer END as source, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY source ORDER BY count DESC LIMIT 10"
    ).bind(days).all(),
    c.env.DB.prepare(
      "SELECT path, COUNT(*) as count FROM hits WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY path ORDER BY count DESC LIMIT 10"
    ).bind(days).all(),
    c.env.DB.prepare(
      "SELECT COUNT(DISTINCT ip) as count FROM hits WHERE created_at > datetime('now', '-5 minutes') AND ip != ''"
    ).first(),
    c.env.DB.prepare(
      "SELECT COUNT(*) as total, COUNT(DISTINCT name) as types FROM events WHERE created_at > datetime('now', '-' || ? || ' days')"
    ).bind(days).first(),
    c.env.DB.prepare(
      "SELECT name, COUNT(*) as count FROM events WHERE created_at > datetime('now', '-' || ? || ' days') AND (bot_score >= 30 OR bot_score = 0) GROUP BY name ORDER BY count DESC LIMIT 10"
    ).bind(days).all(),
  ]);

  return c.json({ totals: totals ?? { total: 0, pages: 0 }, human: (humanTotal as any)?.count ?? 0, countries: countries.results, browsers: browsers.results, devices: devices.results, hourly: hourly.results, referrers: referrers.results, topPages: topPages.results, live: (liveCount as any)?.count ?? 0, eventTotals: eventTotals ?? { total: 0, types: 0 }, events: events.results });
});

app.get("/callback", (c) => {
  const code = c.req.query("code") || "";
  const state = c.req.query("state") || "";
  const error = c.req.query("error");
  return c.html(`<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CF OAuth</title><style>:root{font:14px/1.5 system-ui,sans-serif;background:#f5f6f8;display:flex;justify-content:center;align-items:center;height:100vh}main{background:#fff;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:18px;font-weight:600;margin-bottom:8px}.code-box{background:#1d1d1f;color:#34c759;font:14px "SF Mono",monospace;padding:12px 16px;border-radius:8px;margin:16px 0;word-break:break-all;user-select:all}.hint{font-size:13px;color:#8c8c8c}</style></head><body><main>${error?`<h1 style="color:#ff3b30">授权失败</h1><p style="color:#8c8c8c">${error}</p>`:code?`<h1>授权完成</h1><p class="hint">复制下方授权码，粘贴到 CF Client 中</p><div class="code-box">${code}</div><p class="hint">复制后关闭此页面</p>`:`<h1>CF OAuth 回调</h1><p class="hint">等待授权中...</p>`}</main></body></html>`);
});

// ---- 初始化设置 ----
app.get("/api/setup/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
  return c.json({ setup: !row });
});

app.post("/api/setup/save", async (c) => {
  const { password, mode } = await c.req.json().catch(() => ({}));
  if (!password || password.length < 4) return c.json({ ok: false, error: "密码至少4位" }, 400);
  await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?1)").bind(password).run();
  if (mode) await c.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mode', ?1)").bind(mode).run();
  return c.json({ ok: true });
});

app.get("/admin", async (c) => {
  // First run: check if password exists
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
  if (!row) return c.html(setupHtml);
  const pw = c.req.query("pw");
  if (pw !== (row as any).value) return c.html(loginHtml, 401);
  return c.html(dashboardHtml);
});

export default app;

const setupHtml = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seval Panel - 初始化</title><style>:root{font:14px/1.5 system-ui,sans-serif;color:#1d1d1f;background:#f5f5f7}main{max-width:440px;margin:80px auto 0;padding:32px;background:rgba(255,255,255,.76);backdrop-filter:blur(20px)saturate(180%);border-radius:16px;border:1px solid rgba(0,0,0,.06)}h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin-bottom:20px}h2{font-size:14px;font-weight:500;margin-bottom:8px;color:#8c8c8c}.step{display:none}.step.active{display:block}label{display:block;font-size:12px;font-weight:500;color:#8c8c8c;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}input{width:100%;padding:10px 12px;border:1px solid rgba(0,0,0,.12);border-radius:8px;font:inherit;font-size:14px;box-sizing:border-box;outline:none;margin-bottom:12px}input:focus{border-color:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.12)}.btn{display:inline-block;padding:10px 20px;border:none;border-radius:8px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;transition:transform 100ms ease-out}.btn:active{transform:scale(.97)}.btn-primary{background:#007aff;color:#fff;margin-right:8px}.btn-ghost{background:rgba(0,0,0,.04);color:#1d1d1f}.option{display:flex;align-items:flex-start;gap:12px;padding:16px;border:1px solid rgba(0,0,0,.08);border-radius:10px;margin-bottom:10px;cursor:pointer;transition:border-color 150ms,background 120ms}.option:hover{border-color:#007aff;background:rgba(0,122,255,.03)}.option.selected{border-color:#007aff;background:rgba(0,122,255,.06)}.option .radio{width:18px;height:18px;border-radius:50%;border:2px solid rgba(0,0,0,.2);flex-shrink:0;margin-top:2px;transition:border-color 150ms}.option.selected .radio{border-color:#007aff;background:radial-gradient(circle,#007aff 40%,transparent 45%)}.option strong{display:block;font-size:14px;margin-bottom:2px}.option span{font-size:12px;color:#8c8c8c}.done{text-align:center;padding:20px}.done .check{font-size:40px;margin-bottom:12px}.code-box{background:#1d1d1f;color:#34c759;font:12px "SF Mono",Consolas,monospace;padding:12px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;user-select:all;margin-top:12px}.status{font-size:13px;color:#ff3b30;margin-top:8px}</style></head><body><main>
<div class="step active" id="step1">
<h1>欢迎使用 Seval Panel</h1><h2>第 1 步：设置管理密码</h2>
<label>密码（至少 4 位）</label>
<input id="pw" type="password" placeholder="设置登录密码" autofocus>
<button class="btn btn-primary" onclick="nextStep()">下一步</button>
<div class="status" id="err"></div>
</div>
<div class="step" id="step2">
<h1>选择接入方式</h1><h2>第 2 步：将埋点代码放入网站</h2>
<div class="option" data-mode="native" onclick="selectMode(this)">
<div class="radio"></div><div><strong>原生方式</strong><span>使用 Seval 原始埋点脚本，功能完整</span></div>
</div>
<div class="option" data-mode="umami" onclick="selectMode(this)">
<div class="radio"></div><div><strong>umami 兼容</strong><span>使用 umami 埋点脚本，只需改 data-host</span></div>
</div>
<div class="code-box" id="codeSnippet" style="display:none"></div>
<button class="btn btn-primary" onclick="finish()">完成设置</button>
</div>
<div class="step" id="step3"><div class="done">
<div class="check">✅</div>
<h1>设置完成</h1><p style="color:#8c8c8c;margin-bottom:16px">Seval Panel 已就绪</p>
<button class="btn btn-primary" onclick="location.href='/admin'">前往面板</button>
</div></div>
</main>
<script>
let pw='',mode='native';
function nextStep(){
  pw=document.getElementById('pw').value;if(pw.length<4){document.getElementById('err').textContent='密码至少4位';return}
  document.getElementById('err').textContent='';
  document.getElementById('step1').classList.remove('active');document.getElementById('step2').classList.add('active');
  document.querySelector('.option[data-mode="native"]').classList.add('selected');showCode();
}
function selectMode(el){
  document.querySelectorAll('.option').forEach(o=>o.classList.remove('selected'));
  el.classList.add('selected');mode=el.dataset.mode;showCode();
}
function showCode(){
  var host=location.origin,box=document.getElementById('codeSnippet');
  if(mode==='umami'){
    box.textContent='<!-- Seval -->\\n<script async src="'+host+'/track.js" data-host="'+host+'"><\\/script>';
  }else{
    box.textContent='<!-- Seval -->\\n<script async src="'+host+'/track.js" data-host="'+host+'"><\\/script>';
  }
  box.style.display='block';
}
async function finish(){
  var r=await fetch('/api/setup/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,mode:mode})});
  var j=await r.json();
  if(!j.ok){document.getElementById('err').textContent=j.error;return}
  document.getElementById('step2').classList.remove('active');document.getElementById('step3').classList.add('active');
}
</script></body></html>`;

const loginHtml = `<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问数据监控大屏</title><style>:root{font:100%/1.5 system-ui,sans-serif;color:#1d1d1f;background:#f5f5f7}main{max-width:360px;margin:120px auto 0;padding:32px;background:rgba(255,255,255,.72);backdrop-filter:blur(20px)saturate(180%);border-radius:20px;border:1px solid rgba(0,0,0,.06)}h1{font-size:24px;font-weight:500;letter-spacing:-.01em;margin:0 0 24px;text-align:center}input{width:100%;padding:12px 16px;border:1px solid rgba(0,0,0,.12);border-radius:10px;font:inherit;font-size:15px;box-sizing:border-box;outline:none;transition:border-color 150ms ease}input:focus{border-color:#007aff}button{width:100%;padding:12px;margin-top:16px;border:none;border-radius:10px;background:#007aff;color:#fff;font:inherit;font-size:15px;font-weight:500;cursor:pointer;transition:transform 100ms ease-out,opacity 150ms ease}button:active{transform:scale(.97)}</style></head><body><main><h1>访问统计</h1><form onsubmit="location.href='?pw='+encodeURIComponent(document.getElementById('p').value);return!1"><input id="p" type="password" placeholder="密码" autofocus><button type="submit">登录</button></form></main></body></html>`;

const dashboardHtml = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>访问数据监控大屏</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#1d1d1f;background:#f5f6f8}
*{box-sizing:border-box;margin:0}
body{padding:0}
.layout{display:flex;min-height:100vh}
.sidebar{position:sticky;top:0;align-self:flex-start;width:208px;flex-shrink:0;height:100vh;padding:20px 0;border-right:1px solid #f0f0f3;overflow-y:auto}
.nav{display:flex;flex-direction:column;gap:2px;padding:0 12px}
.nav-item{padding:9px 12px;border-radius:8px;font-size:14px;color:#4a4a4a;cursor:pointer;transition:background 120ms;text-decoration:none}
.nav-item:hover{background:rgba(0,0,0,.04)}
.nav-item.active{background:rgba(46,199,201,.12);color:#0e8c8e;font-weight:500}
.nav-sep{height:1px;background:#f0f0f3;margin:8px 4px}
.main{flex:1;min-width:0;padding:28px}
.view{display:none}
.view.active{display:block}
.header{margin-bottom:24px}
.title{font-size:24px;font-weight:600;letter-spacing:-.02em;color:#1d1d1f}
.subtitle{font-size:13px;color:#8c8c8c;margin-top:4px}
.toolbar{display:flex;align-items:center;gap:8px;margin-top:16px}
.toolbar select{padding:8px 32px 8px 12px;border:1px solid #e5e5e7;background:#fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238c8c8c' stroke-width='1.5'/></svg>") no-repeat right 10px center;border-radius:6px;font:inherit;font-size:13px;color:#1d1d1f;appearance:none;cursor:pointer;outline:none}
.toolbar select:hover{border-color:#2ec7c9}
.toolbar .apply{margin-left:auto;padding:8px 20px;background:#1d1d1f;color:#fff;border:none;border-radius:6px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:transform 100ms ease-out,opacity 150ms ease}
.toolbar .apply:active{transform:scale(.97)}
.section{margin-bottom:20px}
.section-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.section-head::before{content:'';width:3px;height:14px;background:#2ec7c9;border-radius:2px}
.section-title{font-size:15px;font-weight:600;color:#1d1d1f;letter-spacing:-.01em}
.section-en{font-size:12px;color:#8c8c8c;font-weight:400}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
.stat{background:#fff;border:1px solid #f0f0f3;border-radius:10px;padding:18px 20px;transition:transform 160ms ease-out,box-shadow 160ms ease}
.stat:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.04)}
.stat-label{font-size:12px;color:#8c8c8c;margin-bottom:6px}
.stat-value{font-size:32px;font-weight:600;letter-spacing:-.02em;color:#1d1d1f;line-height:1.1}
.stat-sub{font-size:12px;color:#a8a8a8;margin-top:6px}
.chart-card{background:#fff;border:1px solid #f0f0f3;border-radius:10px;padding:20px}
.chart-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.chart-title{font-size:14px;font-weight:600;color:#1d1d1f}
.chart-unit{font-size:11px;color:#a8a8a8}
canvas{height:280px!important}
.list-card{background:#fff;border:1px solid #f0f0f3;border-radius:10px;padding:20px}
.list{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;font-size:13px}
.list div{padding:8px 0;border-bottom:1px solid #f5f5f7;color:#4a4a4a}
.list div span{color:#a8a8a8;font-size:12px;margin-left:6px}
.empty{text-align:center;color:#a8a8a8;font-size:13px;padding:40px 0}
@media(max-width:780px){.stats{grid-template-columns:1fr}.list{grid-template-columns:1fr}.toolbar .apply{margin-left:0}.layout{flex-direction:column}.sidebar{position:static;height:auto;width:100%;border-right:none;border-bottom:1px solid #f0f0f3}.nav{flex-direction:row;overflow-x:auto;gap:4px}.main{padding:20px 16px}}
@media(prefers-reduced-motion:reduce){.stat{transition:opacity 200ms ease;transform:none!important}}
</style>
</head>
<body>
<div class="layout">
<aside class="sidebar">
<nav class="nav">
<a class="nav-item active" data-v="traffic" onclick="showView('traffic')">流量分析</a>
<a class="nav-item" data-v="geo" onclick="showView('geo')">地域分布</a>
<a class="nav-item" data-v="devices" onclick="showView('devices')">设备与浏览器</a>
<a class="nav-item" data-v="sources" onclick="showView('sources')">来源分析</a>
<a class="nav-item" data-v="pages" onclick="showView('pages')">热门页面</a>
<a class="nav-item" data-v="events" onclick="showView('events')">事件跟踪</a>
<a class="nav-item" data-v="recent" onclick="showView('recent')">最近访问</a>
<div class="nav-sep"></div>
<a class="nav-item" data-v="settings" onclick="showView('settings')">设置</a>
<a class="nav-item" href="/admin">登出</a>
</nav>
</aside>
<main class="main">
<div class="header">
<div class="title">访问数据监控大屏</div>
<div class="subtitle">博客访问流量与用户分析</div>
<div class="toolbar">
<select id="rangeSelect">
<option value="1">最近 24 小时</option>
<option value="7" selected>最近 7 天</option>
<option value="30">最近 30 天</option>
</select>
<button class="apply" onclick="load(+document.getElementById('rangeSelect').value)">应用</button>
</div>
</div>

<div class="view active" id="view-traffic">
<section class="section">
<div class="section-head"><span class="section-title">流量分析</span><span class="section-en">Traffic</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">浏览量 (PV)</div><div class="stat-value" id="total">--</div><div class="stat-sub">全部页面访问次数</div></div>
<div class="stat"><div class="stat-label">独立访客</div><div class="stat-value" id="visitors">--</div><div class="stat-sub">去重 IP 数量</div></div>
<div class="stat"><div class="stat-label">页面数</div><div class="stat-value" id="botRate">--</div><div class="stat-sub">被访问的页面数量</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">流量趋势</span><span class="chart-unit">单位:次</span></div><canvas id="hourly"></canvas></div>
</section>
</div>

<div class="view" id="view-geo">
<section class="section">
<div class="section-head"><span class="section-title">地域分布</span><span class="section-en">Geography</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">国家/地区数</div><div class="stat-value" id="countryCount">--</div><div class="stat-sub">访问来源国家数</div></div>
<div class="stat"><div class="stat-label">城市数</div><div class="stat-value" id="cityCount">--</div><div class="stat-sub">访问来源城市数</div></div>
<div class="stat"><div class="stat-label">主导来源</div><div class="stat-value" id="topCountry" style="font-size:20px">--</div><div class="stat-sub">访问量最大国家</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">国家/地区分布</span><span class="chart-unit">TOP 10</span></div><canvas id="countries"></canvas></div>
</section>
</div>

<div class="view" id="view-devices">
<section class="section">
<div class="section-head"><span class="section-title">设备与浏览器</span><span class="section-en">Devices</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">浏览器种类</div><div class="stat-value" id="browserCount">--</div><div class="stat-sub">使用的浏览器数量</div></div>
<div class="stat"><div class="stat-label">桌面占比</div><div class="stat-value" id="desktopRate">--</div><div class="stat-sub">桌面设备访问比例</div></div>
<div class="stat"><div class="stat-label">主导浏览器</div><div class="stat-value" id="topBrowser" style="font-size:20px">--</div><div class="stat-sub">使用最多的浏览器</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">浏览器分布</span><span class="chart-unit">TOP 6</span></div><canvas id="browsers"></canvas></div>
</section>
</div>

<div class="view" id="view-sources">
<section class="section">
<div class="section-head"><span class="section-title">来源分析</span><span class="section-en">Sources</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">来源渠道</div><div class="stat-value" id="sourceCount">--</div><div class="stat-sub">流量来源数量</div></div>
<div class="stat"><div class="stat-label">直接访问占比</div><div class="stat-value" id="directRate">--</div><div class="stat-sub">无来源页直接访问</div></div>
<div class="stat"><div class="stat-label">实时在线</div><div class="stat-value" id="liveVisitors">--</div><div class="stat-sub">最近 5 分钟活跃访客</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">来源分布</span><span class="chart-unit">TOP 10</span></div><canvas id="referrerChart"></canvas></div>
</section>
</div>

<div class="view" id="view-pages">
<section class="section">
<div class="section-head"><span class="section-title">热门页面</span><span class="section-en">Pages</span></div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">TOP 10 页面</span></div><canvas id="pagesChart"></canvas></div>
</section>
</div>

<div class="view" id="view-events">
<section class="section">
<div class="section-head"><span class="section-title">事件跟踪</span><span class="section-en">Events</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">事件总数</div><div class="stat-value" id="eventTotal">--</div><div class="stat-sub">全部事件触发次数</div></div>
<div class="stat"><div class="stat-label">事件类型数</div><div class="stat-value" id="eventTypes">--</div><div class="stat-sub">不同事件名数量</div></div>
<div class="stat"><div class="stat-label">主导事件</div><div class="stat-value" id="topEvent" style="font-size:20px">--</div><div class="stat-sub">触发最多的事件</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">TOP 10 事件</span></div><canvas id="eventsChart"></canvas></div>
</section>
</div>

<div class="view" id="view-recent">
<section class="section">
<div class="section-head"><span class="section-title">最近访问</span><span class="section-en">Recent</span></div>
<div class="list-card"><div class="list" id="recentList"><div class="empty">暂无访问数据</div></div></div>
</section>
</div>

<div class="view" id="view-settings">
<section class="section">
<div class="section-head"><span class="section-title">设置</span><span class="section-en">Settings</span></div>
<div class="chart-card">
<div class="chart-head"><span class="chart-title">埋点代码</span></div>
<div id="embedCode" style="background:#1d1d1f;color:#34c759;font:12px 'SF Mono',Consolas,monospace;padding:12px 16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;user-select:all"></div>
<p class="stat-sub" style="margin-top:12px">将上述代码放入网站 head 即可开始统计。更多设置开发中。</p>
</div>
</section>
</div>

<script>
let hChart,cChart,bChart,rChart,pChart,eChart;
// 侧边栏视图切换：显隐 .view + 高亮 nav-item；下一帧重绘图表（display:none 的 canvas 尺寸需刷新）
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+id));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.v===id));
  requestAnimationFrame(function(){[hChart,cChart,bChart,rChart,pChart,eChart].forEach(function(c){try{c&&c.resize()}catch(e){}})});
}
// 设置视图：填充埋点代码（host 取当前域名；用 </"+"script> 拼接，避免 HTML 解析提前闭合 <script>）
document.getElementById('embedCode').textContent='<!-- Seval -->\\n<script async src="'+location.origin+'/track.js" data-host="'+location.origin+'"></'+'script>';
async function load(days){
  const r=await fetch('/api/stats?days='+days);const d=await r.json();
  // 流量分析：PV / 独立访客 / 页面数
  document.getElementById('total').textContent=d.totals.total.toLocaleString();
  document.getElementById('visitors').textContent=d.human.toLocaleString();
  document.getElementById('botRate').textContent=d.totals.pages||'--';

  // 地域分布：国家/城市数 + 主导来源
  const topCountries={};
  d.countries.forEach(x=>{const k=x.country||'Unknown';topCountries[k]=(topCountries[k]||0)+x.count});
  const countryEntries=Object.entries(topCountries);
  const cSorted=countryEntries.sort((a,b)=>b[1]-a[1]);
  const topCountry=cSorted[0]?cSorted[0][0]:'--';
  const totalCities=d.countries.length;
  document.getElementById('countryCount').textContent=countryEntries.length||'--';
  document.getElementById('cityCount').textContent=totalCities||'--';
  document.getElementById('topCountry').textContent=topCountry;

  // 设备与浏览器：浏览器种类 / 桌面占比 / 主导浏览器
  const browserEntries=d.browsers.filter(x=>x.browser);
  const topBrowserEntry=browserEntries.sort((a,b)=>b.count-a.count)[0];
  const desktop=d.devices.find(x=>x.device==='desktop');
  const desktopTotal=d.devices.reduce((s,x)=>s+x.count,0);
  document.getElementById('browserCount').textContent=browserEntries.length||'--';
  document.getElementById('desktopRate').textContent=desktopTotal?Math.round((desktop?desktop.count:0)/desktopTotal*100)+'%':'--';
  document.getElementById('topBrowser').textContent=topBrowserEntry?topBrowserEntry.browser:'--';

  const labels=d.hourly.map(x=>{const dt=new Date(x.hour.replace(' ','T')+'Z');return days<=2?(dt.getMonth()+1)+'-'+dt.getDate()+' '+String(dt.getHours()).padStart(2,'0')+':00':(dt.getMonth()+1)+'-'+dt.getDate()});
  const counts=d.hourly.map(x=>x.count);
  if(hChart)hChart.destroy();
  hChart=new Chart(document.getElementById('hourly'),{type:'line',data:{labels,datasets:[{label:'浏览量',data:counts,borderColor:'#2ec7c9',backgroundColor:'rgba(46,199,201,0.12)',fill:true,tension:.35,pointRadius:0,pointHoverRadius:4,pointHoverBackgroundColor:'#2ec7c9',borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}},scales:{x:{ticks:{maxTicksLimit:8,font:{size:11},color:'#a8a8a8'},grid:{display:false},border:{display:false}},y:{ticks:{font:{size:11},color:'#a8a8a8',maxTicksLimit:5},grid:{color:'#f0f0f3',drawBorder:false},border:{display:false},beginAtZero:true}}}});

  const top10=cSorted.slice(0,10);
  if(cChart)cChart.destroy();
  cChart=new Chart(document.getElementById('countries'),{type:'bar',data:{labels:top10.map(x=>x[0]),datasets:[{label:'访问量',data:top10.map(x=>x[1]),backgroundColor:['#2ec7c9','#ffce56','#6ee0b2','#975fe4','#ff9f7f','#5b8ff9','#a8a8a8','#e5c','#fac','#abc'],borderRadius:4,barThickness:18}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}},scales:{x:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{display:false},border:{display:false}},y:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{color:'#f0f0f3',drawBorder:false},border:{display:false},beginAtZero:true}}}});

  if(bChart)bChart.destroy();
  bChart=new Chart(document.getElementById('browsers'),{type:'doughnut',data:{labels:browserEntries.map(x=>x.browser),datasets:[{data:browserEntries.map(x=>x.count),backgroundColor:['#2ec7c9','#ffce56','#6ee0b2','#975fe4','#ff9f7f','#5b8ff9'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{position:'right',labels:{font:{size:12},color:'#4a4a4a',padding:12,usePointStyle:true,pointStyle:'circle'}},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}}}});

  // 来源分析
  const refEntries=(d.referrers||[]).map(x=>[x.source,x.count]);
  const direct=refEntries.find(x=>x[0]==='直接访问');
  const refTotal=refEntries.reduce((s,x)=>s+x[1],0);
  document.getElementById('sourceCount').textContent=refEntries.length||'--';
  document.getElementById('directRate').textContent=refTotal?Math.round((direct?direct[1]:0)/refTotal*100)+'%':'--';
  document.getElementById('liveVisitors').textContent=d.live||'0';
  const refTop10=refEntries.slice(0,10);
  if(rChart)rChart.destroy();
  rChart=new Chart(document.getElementById('referrerChart'),{type:'bar',data:{labels:refTop10.map(x=>x[0]),datasets:[{label:'访问量',data:refTop10.map(x=>x[1]),backgroundColor:'#5b8ff9',borderRadius:4,barThickness:18}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}},scales:{x:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{display:false},border:{display:false}},y:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{color:'#f0f0f3',drawBorder:false},border:{display:false},beginAtZero:true}}}});

  // 热门页面
  const pageEntries=(d.topPages||[]).map(x=>[x.path.replace(/^.*[/][/]/,'/'),x.count]).slice(0,10);
  if(pChart)pChart.destroy();
  pChart=new Chart(document.getElementById('pagesChart'),{type:'bar',data:{labels:pageEntries.map(x=>x[0]),datasets:[{label:'访问量',data:pageEntries.map(x=>x[1]),backgroundColor:'#975fe4',borderRadius:4,barThickness:18}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}},scales:{x:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{color:'#f0f0f3',drawBorder:false},border:{display:false},beginAtZero:true},y:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{display:false},border:{display:false}}}}});

  // 事件跟踪
  const evEntries=(d.events||[]).map(x=>[x.name,x.count]);
  const evTotals=d.eventTotals||{total:0,types:0};
  document.getElementById('eventTotal').textContent=(evTotals.total||0).toLocaleString();
  document.getElementById('eventTypes').textContent=evTotals.types||'--';
  document.getElementById('topEvent').textContent=evEntries[0]?evEntries[0][0]:'--';
  if(eChart)eChart.destroy();
  eChart=new Chart(document.getElementById('eventsChart'),{type:'bar',data:{labels:evEntries.map(x=>x[0]),datasets:[{label:'触发次数',data:evEntries.map(x=>x[1]),backgroundColor:'#ff9f7f',borderRadius:4,barThickness:18}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1d1d1f',titleFont:{size:11},bodyFont:{size:12},padding:8,cornerRadius:6}},scales:{x:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{color:'#f0f0f3',drawBorder:false},border:{display:false},beginAtZero:true},y:{ticks:{font:{size:11},color:'#a8a8a8'},grid:{display:false},border:{display:false}}}}});

  const recent=d.countries.slice(0,12);
  document.getElementById('recentList').innerHTML=recent.length?recent.map(x=>'<div>'+(x.city||'Unknown')+', '+x.country+'<span>· '+x.count+' 次</span></div>').join(''):'<div class="empty" style="grid-column:1/-1">暂无访问数据</div>';
}
load(+document.getElementById('rangeSelect').value);
</script>
</main>
</div>
</body>
</html>`;
