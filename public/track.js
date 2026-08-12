// Seval 埋点脚本：自动 PV 上报 + seval.track(name, value) 事件埋点
(function(d,s){
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
})(document,'script');
