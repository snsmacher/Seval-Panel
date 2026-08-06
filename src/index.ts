import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = { DB: D1Database; ADMIN_PASSWORD: string };

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*" }));

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
})(document);`, {
    headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" },
  })
);

app.post("/track", async (c) => {
  const { path, referrer } = await c.req.json().catch(() => ({}));
  if (!path) return c.text("missing path", 400);

  const cf = c.req.raw.cf ?? {};
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
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO hits (path, country, city, region, ua, browser, os, device, bot_score, referrer, ip)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(
      path.slice(0, 512),
      (cf.country ?? "").slice(0, 64),
      isCN ? "" : (cf.city ?? "").slice(0, 64),
      (cf.region ?? "").slice(0, 64),
      ua.slice(0, 512),
      browser,
      os,
      device,
      cf.botManagement?.score ?? 0,
      (referrer ?? "").slice(0, 512),
      (c.req.header("CF-Connecting-IP") ?? "").slice(0, 45),
    ).run()
  );

  return c.text("ok");
});

app.get("/api/stats", async (c) => {
  const days = Math.min(Number(c.req.query("days")) || 7, 90);

  const [totals, humanTotal, countries, browsers, devices, hourly] = await Promise.all([
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
  ]);

  return c.json({ totals: totals ?? { total: 0, pages: 0 }, human: (humanTotal as any)?.count ?? 0, countries: countries.results, browsers: browsers.results, devices: devices.results, hourly: hourly.results });
});

app.get("/admin", async (c) => {
  const pw = c.req.query("pw");
  if (pw !== c.env.ADMIN_PASSWORD) return c.html(loginHtml, 401);
  return c.html(dashboardHtml);
});

export default app;

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
body{padding:28px;max-width:1080px;margin:0 auto}
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
@media(max-width:780px){.stats{grid-template-columns:1fr}.list{grid-template-columns:1fr}.toolbar .apply{margin-left:0}}
@media(prefers-reduced-motion:reduce){.stat{transition:opacity 200ms ease;transform:none!important}}
</style>
</head>
<body>
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

<section class="section">
<div class="section-head"><span class="section-title">流量分析</span><span class="section-en">Traffic</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">浏览量 (PV)</div><div class="stat-value" id="total">--</div><div class="stat-sub">全部页面访问次数</div></div>
<div class="stat"><div class="stat-label">独立访客</div><div class="stat-value" id="visitors">--</div><div class="stat-sub">去重 IP 数量</div></div>
<div class="stat"><div class="stat-label">页面数</div><div class="stat-value" id="botRate">--</div><div class="stat-sub">被访问的页面数量</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">流量趋势</span><span class="chart-unit">单位:次</span></div><canvas id="hourly"></canvas></div>
</section>

<section class="section">
<div class="section-head"><span class="section-title">地域分布</span><span class="section-en">Geography</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">国家/地区数</div><div class="stat-value" id="countryCount">--</div><div class="stat-sub">访问来源国家数</div></div>
<div class="stat"><div class="stat-label">城市数</div><div class="stat-value" id="cityCount">--</div><div class="stat-sub">访问来源城市数</div></div>
<div class="stat"><div class="stat-label">主导来源</div><div class="stat-value" id="topCountry" style="font-size:20px">--</div><div class="stat-sub">访问量最大国家</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">国家/地区分布</span><span class="chart-unit">TOP 10</span></div><canvas id="countries"></canvas></div>
</section>

<section class="section">
<div class="section-head"><span class="section-title">设备与浏览器</span><span class="section-en">Devices</span></div>
<div class="stats">
<div class="stat"><div class="stat-label">浏览器种类</div><div class="stat-value" id="browserCount">--</div><div class="stat-sub">使用的浏览器数量</div></div>
<div class="stat"><div class="stat-label">桌面占比</div><div class="stat-value" id="desktopRate">--</div><div class="stat-sub">桌面设备访问比例</div></div>
<div class="stat"><div class="stat-label">主导浏览器</div><div class="stat-value" id="topBrowser" style="font-size:20px">--</div><div class="stat-sub">使用最多的浏览器</div></div>
</div>
<div class="chart-card"><div class="chart-head"><span class="chart-title">浏览器分布</span><span class="chart-unit">TOP 6</span></div><canvas id="browsers"></canvas></div>
</section>

<section class="section">
<div class="section-head"><span class="section-title">最近访问</span><span class="section-en">Recent</span></div>
<div class="list-card"><div class="list" id="recentList"><div class="empty">暂无访问数据</div></div></div>
</section>

<script>
let hChart,cChart,bChart;
async function load(days){
  const r=await fetch('/api/stats?days='+days);const d=await r.json();
  document.getElementById('total').textContent=d.totals.total.toLocaleString();
  document.getElementById('visitors').textContent=d.human.toLocaleString();
  document.getElementById('botRate').textContent=d.totals.pages||'--';

  const topCountries={};
  d.countries.forEach(x=>{const k=x.country||'Unknown';topCountries[k]=(topCountries[k]||0)+x.count});
  const countryEntries=Object.entries(topCountries);
  const cSorted=countryEntries.sort((a,b)=>b[1]-a[1]);
  const topCountry=cSorted[0]?cSorted[0][0]:'--';
  const totalCities=d.countries.length;
  document.getElementById('countryCount').textContent=countryEntries.length||'--';
  document.getElementById('cityCount').textContent=totalCities||'--';
  document.getElementById('topCountry').textContent=topCountry;

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

  const recent=d.countries.slice(0,12);
  document.getElementById('recentList').innerHTML=recent.length?recent.map(x=>'<div>'+(x.city||'Unknown')+', '+x.country+'<span>· '+x.count+' 次</span></div>').join(''):'<div class="empty" style="grid-column:1/-1">暂无访问数据</div>';
}
load(+document.getElementById('rangeSelect').value);
</script>
</body>
</html>`;
