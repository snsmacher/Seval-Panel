# Seval Panel


> **关于中国大陆定位**
>
> 由于 Cloudflare 在中国大陆没有边缘节点，国内访客的 IP 定位可能不准确。因此面板中大陆城市统一显示为"未知"。海外访客定位正常。



适用于个人博客的轻量级分析工具。可统计页面浏览量、访问者地理位置、浏览器/设备信息，并于umaim兼容，还能检测机器人访问行为——所有这些功能都包含在 Cloudflare 的免费套餐中。

## 堆栈

- **Hono** — Worker routing
- **D1** — SQLite database
- **Chart.js** — Frontend charts
- **request.cf** — Geo/bot data (no third-party IP DB needed)

## 部署
# 1. 装依赖
npm install

# 2. 创建 D1 数据库（首次）
npx wrangler d1 create analytics-db
# → 把输出的 database_id 填到 wrangler.jsonc

# 3. 初始化数据表
npx wrangler d1 execute analytics-db --file=./migrations/0001_init.sql --remote
npx wrangler d1 execute analytics-db --file=./migrations/0002_add_ip.sql --remote
npx wrangler d1 execute analytics-db --file=./migrations/0003_settings.sql --remote

# 4. 部署
npx wrangler deploy

# 5. 打开 /admin，设密码 + 选埋点方式 → 完成


## 如何接入你的网站

```html
<script src="https://your-worker.workers.dev/track.js" data-host="https://your-worker.workers.dev" defer></script>
```

或使用umami埋点进行接入

## 仪表盘

```
https://your-worker.workers.dev/admin
```
