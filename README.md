# ChatGPT Team 支付长链生成器

带 CDK 准入控制、可视化国家选择、国家代理路由和 CDK 管理后台的 ChatGPT Team Checkout 长链生成器。

## 已实现功能

- 用户必须先校核 CDK，验证通过后页面才会解锁。
- Checkout API 会再次验证 CDK 并原子扣减一次使用次数，不能绕过前端。
- `/admin` 管理后台支持批量生成、备注、有效天数、使用次数、列表和吊销。
- CDK 明文只在生成时返回一次，D1 只保存 `SHA-256(Pepper + CDK)` 和末四位。
- 支持美国、埃及、英国、菲律宾、日本、泰国、印度、瑞典八个可点击国家卡片。
- 后端强制匹配国家币种，并通过对应国家代理生成 Checkout 链接。

## 请求链路

```text
用户输入 CDK
  → Worker 查询 D1 验证授权
  → 页面解锁
  → 用户提交 Access Token 和国家
  → Worker 再次验证 CDK并原子计次
  → HTTPS Relay 按国家选择普通代理
  → chatgpt.com / api.openai.com
```

## 首次部署

需要 Node.js 20+、Cloudflare 账号和一个可部署 Node Relay 的环境。

### 1. 安装依赖

```powershell
npm install
```

### 2. 创建并绑定 D1

```powershell
npx wrangler d1 create chatgpt-team-checkout-db
```

将命令返回的 `database_id` 替换 [wrangler.toml](./wrangler.toml) 中的全零占位值，然后执行远程迁移：

```powershell
npx wrangler d1 migrations apply chatgpt-team-checkout-db --remote
```

迁移文件位于 `migrations/0001_create_cdks.sql`。

### 3. 设置 CDK 安全密钥

分别生成两个不同的长随机字符串，然后写入 Worker Secret：

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CDK_HASH_PEPPER
```

- `ADMIN_TOKEN`：登录 `/admin` 管理后台使用。
- `CDK_HASH_PEPPER`：参与 CDK 哈希，不得与 ADMIN_TOKEN 相同，设置后不要随意更换；更换会使已有 CDK 无法验证。

### 4. 配置国家代理 Relay

Cloudflare Worker 的 `fetch` 不能直接使用普通 `IP:端口` HTTP/SOCKS 代理，因此项目包含 `relay/server.mjs`。

复制配置：

```powershell
copy .relay.env.example .relay.env
```

编辑 `.relay.env`：

```dotenv
PORT=8790
RELAY_TOKEN=一个足够长的随机密钥
COUNTRY_UPSTREAM_PROXIES='{"US":"http://user:password@us-proxy.example.com:8080","EG":"http://user:password@eg-proxy.example.com:8080"}'
```

支持的 Key：`US`、`EG`、`GB`、`PH`、`JP`、`TH`、`IN`、`SE`。代理 Value 支持 `http://` 或 `https://`，账号密码可写在 URL 中。

将 Relay 部署为 HTTPS 服务后，把各国 Relay 地址写入 Worker Secret：

```json
{
  "US": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "EG": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "GB": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "PH": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "JP": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "TH": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "IN": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" },
  "SE": { "url": "https://relay.example.com/forward", "token": "RELAY_TOKEN" }
}
```

```powershell
npx wrangler secret put COUNTRY_PROXY_CONFIG
```

默认缺少国家代理时拒绝请求，不会静默直连。仅本地调试可设置 `ALLOW_DIRECT_CHECKOUT=true`。

### 5. 部署

```powershell
npm test
npm run check
npm run deploy
```

部署后访问：

- `/`：用户支付长链生成器。
- `/admin`：CDK 管理后台。
- `/health`：服务配置状态。

## 本地开发

复制示例配置并修改其中的假密钥：

```powershell
copy .dev.vars.example .dev.vars
copy .relay.env.example .relay.env
npx wrangler d1 migrations apply chatgpt-team-checkout-db --local
```

启动 Relay：

```powershell
npm run relay:dev
```

另开终端启动 Worker：

```powershell
npm run dev
```

访问 `http://127.0.0.1:8787`。本地 Relay 地址可以使用 `http://127.0.0.1:8790/forward`；生产环境必须使用 HTTPS。

## CDK 行为

管理后台生成参数：

- `count`：单批 1–50 个。
- `maxUses`：每个 CDK 1–100000 次。
- `expiresDays`：0–3650 天，0 表示长期有效。
- `label`：最长 80 字符的内部备注。

校核 CDK 本身不会扣次数。真正提交生成支付链时，后端使用带条件的 D1 `UPDATE` 原子加一，避免并发请求突破最大次数。国家代理未配置、请求参数不合法时不会扣次数；进入上游 Checkout 后即视为使用一次，即使上游最终拒绝或失败也会保留该次记录。

CDK 可处于以下状态：

- `active`：有效且有剩余次数。
- `exhausted`：次数已耗尽。
- `expired`：超过有效期。
- `revoked`：管理员手动吊销。

## API

### `POST /api/cdk/verify`

```json
{ "cdk": "ABCD-EFGH-JKLM-NPQR" }
```

验证成功返回剩余次数、最大次数和有效期，不扣次数。

### `POST /api/checkout/team`

```json
{
  "cdk": "ABCD-EFGH-JKLM-NPQR",
  "accessToken": "eyJ...",
  "promoCode": "SPRING50",
  "country": "US",
  "workspaceName": "myWorkspace",
  "seatQuantity": 2,
  "deviceId": "d8f2-..."
}
```

后端只接受八个国家，币种由国家强制决定。主源网络错误、超时或 5xx 时，会通过同一个国家代理回退到 `api.openai.com`。

### 管理 API

所有管理请求必须携带：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/admin/cdks?limit=500`：CDK 列表和统计。
- `POST /api/admin/cdks`：生成 CDK。
- `DELETE /api/admin/cdks/:id`：吊销 CDK。

## 安全说明

- Access Token、CDK 明文和 ADMIN_TOKEN 都不会写入浏览器持久存储。
- D1 不保存 CDK 明文，数据库泄露后仍需要服务端 Pepper 才能校验候选值。
- 管理 Token、哈希 Pepper、Relay Token 和国家代理凭据只存在于服务端环境变量。
- CDK 校核有独立限速，Checkout 也有 IP 限速。
- Relay 只允许两个固定 Checkout 目标，不能作为开放代理。
- `.dev.vars`、`.relay.env`、`.wrangler` 和 `node_modules` 已被 `.gitignore` 排除。
- 可设置 `ALLOWED_ORIGIN=https://你的前端域名` 收紧 CORS，默认值为 `*`。
