# ChatGPT Team 长链工作台

带 CDK 准入控制、优惠码自动分配、国家代理路由和分类管理后台的 ChatGPT Team Checkout 长链工作台。

## 已实现功能

- 页面首次打开只显示 CDK 验证入口，验证通过后才会进入正式工作台。
- 客户 CDK 生成后有 24 小时待激活期；首次校验激活后 3 小时内可重复提链并更换国家。
- 支持长期有效、可重复使用的管理员通用 CDK；重新生成时自动停用旧码。
- CDK 支持停用和软删除；删除后立即失效并从后台列表移除，但不会回收已经分配的优惠码。
- `/admin` 管理后台按概览、CDK、优惠码、国家代理分类。
- 优惠码支持 Excel、CSV、TXT 和粘贴导入；所有国家共用全球库存，生成客户 CDK 时原子分配一条。
- 兼容导入完整 `chatgpt.com/p/...` 链接，自动截取、存储并展示 `/p/` 后的优惠码；库存列表支持状态筛选和分页。
- 工作台只接受后台已登记且未删除的优惠码，拒绝使用外部优惠码。
- 优惠码可由管理员手动标记“已售出”，通过工作台提链成功时也会自动标记；已售出代码立即脱敏并在首次标记 24 小时后自动删除。
- 已分配优惠码仍可由管理员手动删除，方便同步客户在外部自行提链的库存状态。
- 管理后台可直接查看、复制新生成的 CDK、优惠码及其分配关系；敏感值仅通过鉴权后的管理接口解密返回。
- 生成结果可直接复制“自助提链 / CDK / 优惠码”三行交付文本。
- CDK 同时保存 `SHA-256(Pepper + CDK)` 校验值和 AES-GCM 密文，数据库中不出现明文；升级前的历史 CDK 因只有哈希，只能继续脱敏显示。
- 国家下拉支持美国、埃及、英国、智利、菲律宾、日本、泰国、印度、瑞典，并显示国旗、当地币种与美元参考价。
- 后端强制匹配国家币种，并通过对应国家代理生成 Checkout 链接。
- 代理凭据使用 AES-GCM 加密存入 D1，管理 API 只返回脱敏地址。
- 工作台与管理后台均使用放大的中文排版；Session JSON 输入框提供可展开的安全获取说明。

## 请求链路

```text
用户输入 CDK
  → Worker 查询 D1，首次校验时激活 3 小时授权
  → 页面解锁
  → 用户提交 Access Token、国家和优惠码
  → Worker 再次验证 CDK，并校验优惠码是否在后台登记
  → Worker 解密该国家代理并交给 HTTPS Relay
  → Relay 通过对应 HTTP / HTTPS 代理出站
  → chatgpt.com / api.openai.com
  → 成功后累计 CDK 使用次数，并把优惠码标记为已售出
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

该命令会依次执行 CDK、代理和优惠码库存迁移。

### 3. 设置后台安全密钥

分别生成四个不同的长随机字符串，然后写入 Worker Secret：

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CDK_HASH_PEPPER
npx wrangler secret put PROXY_ENCRYPTION_KEY
npx wrangler secret put PROMO_ENCRYPTION_KEY
```

- `ADMIN_TOKEN`：登录 `/admin` 管理后台使用。
- `CDK_HASH_PEPPER`：参与 CDK 哈希，不得与 ADMIN_TOKEN 相同，设置后不要随意更换；更换会使已有 CDK 无法验证。
- `PROXY_ENCRYPTION_KEY`：加密 D1 中的代理 URL。设置后必须稳定保存；更换会使已导入代理无法解密，需要全部重新导入。
- `PROMO_ENCRYPTION_KEY`：加密 D1 中的优惠码并参与去重哈希。设置后不要更换，否则已导入优惠码无法解密。

### 4. 配置国家代理 Relay

Cloudflare Worker 的 `fetch` 不能直接使用普通 `IP:端口` HTTP/SOCKS 代理，因此项目包含 `relay/server.mjs`。

复制配置：

```powershell
copy .relay.env.example .relay.env
```

编辑 `.relay.env`。新版由后台动态下发代理，因此 Relay 只需要一个鉴权密钥：

```dotenv
PORT=8790
RELAY_TOKEN=一个足够长的随机密钥
COUNTRY_UPSTREAM_PROXIES='{}'
```

把 Relay 部署到 Railway、Render、Fly.io、VPS 等支持长期运行 Node.js 的平台，并确保外部地址是 HTTPS。Cloudflare Worker 本身不能直接连接普通代理，所以 Relay 不能省略。

将同一个 Relay 地址写入 Worker Secret：

```json
{ "url": "https://relay.example.com/forward", "token": "与 RELAY_TOKEN 相同的值" }
```

```powershell
npx wrangler secret put RELAY_CONFIG
```

部署 Worker 后打开 `/admin`，输入 `ADMIN_TOKEN`，即可按国家导入代理。支持：

- 单个导入：`http://user:password@host:port`
- 逐行批量导入：`US=http://user:password@host:port`
- JSON 批量导入：`{"US":"http://...","JP":"http://..."}`

导入后可直接测试出口 IP 和延迟。页面不会再次显示代理明文。支持的国家代码为 `US`、`EG`、`GB`、`CL`、`PH`、`JP`、`TH`、`IN`、`SE`，代理协议支持 `http://` 和 `https://`。

默认缺少该国家代理时拒绝请求，不会静默直连。仅本地调试可设置 `ALLOW_DIRECT_CHECKOUT=true`。旧版 `COUNTRY_PROXY_CONFIG` 和 Relay 的 `COUNTRY_UPSTREAM_PROXIES` 仍保留为兼容回退，后台导入的代理优先。

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

客户 CDK 生成参数：

- `count`：单批 1–50 个。
- `label`：最长 80 字符的内部备注。

服务端固定每个新客户 CDK 有 24 小时待激活期。首次调用校验接口时写入激活时间，并把有效期重置为从激活时刻起 3 小时；这 3 小时内可以重复生成支付链和更换国家。传入自定义次数或有效期不会改变该规则。库存不足时整批生成会被拒绝，不会留下未绑定优惠码的 CDK。

管理员通用 CDK 长期有效、可重复使用、不分配优惠码。系统同时只保留一个有效管理员通用 CDK。

校核 CDK 会开始 3 小时激活期，但不会增加使用次数。每次成功生成支付链后，后端使用带条件的 D1 `UPDATE` 原子累计 `use_count` 供审计；激活期内不限制成功次数。国家代理未配置、参数不合法或上游失败时不会累计次数。

CDK 可处于以下状态：

- `pending`：尚未激活，仍处于 24 小时激活期限内。
- `active`：已经激活且仍在 3 小时有效期内。
- `exhausted`：旧版单次 CDK 的次数已耗尽；新 CDK 不会进入此状态。
- `expired`：超过有效期。
- `revoked`：管理员手动吊销。

## API

### `POST /api/cdk/verify`

```json
{ "cdk": "ABCD-EFGH-JKLM-NPQR" }
```

普通 CDK 首次验证时激活。验证成功返回 CDK 类型、`repeatable`、激活时间、使用次数和有效期，不增加使用次数。

### `POST /api/checkout/team`

```json
{
  "cdk": "ABCD-EFGH-JKLM-NPQR",
  "accessToken": "eyJ...",
  "promoCode": "SPRING50",
  "country": "US",
  "workspaceName": "myWorkspace",
  "seatDefault": 2,
  "seatProlite": 0,
  "billingPeriod": "month",
  "deviceId": "d8f2-..."
}
```

`seatDefault` 和 `seatProlite` 分别是标准席位与高级席位数量，两者都可大于 0，但合计必须为 2–999。`billingPeriod` 可选 `month` 或 `year`。后端会把两个席位数量转换为 Checkout 需要的两项 `seat_quantity` 数组；旧版 `seatQuantity` + `seatType` 请求仍兼容。

`promoCode` 可留空；填写时必须是后台尚未删除的登记优惠码。生成支付链成功后，该优惠码会自动标记为“已售出”，完整代码不再通过管理接口返回，并在 24 小时后由 Cloudflare Cron 软删除。重复提链不会延后首次自动删除时间。

后端只接受九个国家，币种由国家强制决定。主源网络错误、超时或 5xx 时，会通过同一个国家代理回退到 `api.openai.com`。

### 管理 API

所有管理请求必须携带：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/admin/cdks?limit=500`：CDK 可视化列表和统计；新 CDK 返回可复制明文，历史哈希记录保持脱敏。
- `POST /api/admin/cdks`：生成 CDK。
- `POST /api/admin/cdks/universal`：生成新的管理员通用 CDK，并自动停用旧管理员 CDK。
- `DELETE /api/admin/cdks/:id`：吊销 CDK。
- `DELETE /api/admin/cdks/:id/delete`：软删除 CDK；保留优惠码分配关系。
- `GET /api/admin/promos?page=1&limit=20&state=all`：优惠码可视化库存、分配状态、统计和分页信息。`limit` 最大 100，`state` 可选 `all`、`available`、`assigned`、`sold`。
- `POST /api/admin/promos`：批量加密导入优惠码。
- `POST /api/admin/promos/:id/sold`：手动标记已售出，并从首次标记起安排 24 小时后自动删除。
- `DELETE /api/admin/promos/:id`：软删除优惠码；已分配或已售出的优惠码也可删除。
- `GET /api/admin/proxies`：返回代理脱敏列表。
- `POST /api/admin/proxies`：单个或批量加密保存代理。
- `POST /api/admin/proxies/:country/test`：通过 Relay 测试出口 IP 和延迟。
- `DELETE /api/admin/proxies/:country`：删除国家代理。

## 安全说明

- Access Token、解密后的 CDK 和 ADMIN_TOKEN 都不会写入浏览器持久存储，管理接口响应禁用缓存。
- D1 不保存 CDK 明文：校验使用带 Pepper 的 SHA-256 哈希，可视化使用 AES-GCM 密文。只有通过 Bearer 鉴权的管理接口可以解密显示新 CDK。
- 优惠码使用 AES-GCM 加密保存；只有通过 Bearer 鉴权的管理接口和对应 CDK 的交付响应可以返回解密值，公共接口不会列出库存明文。
- 管理 Token、哈希 Pepper 和 Relay Token 只存在于服务端 Secret；代理凭据经 AES-GCM 加密后存入 D1。
- CDK 校核有独立限速，Checkout 也有 IP 限速。
- Relay 只允许两个固定 Checkout 目标，测试端点也只允许访问固定的 ipify 地址，不能作为开放代理。
- `.dev.vars`、`.relay.env`、`.wrangler` 和 `node_modules` 已被 `.gitignore` 排除。
- 可设置 `ALLOWED_ORIGIN=https://你的前端域名` 收紧 CORS，默认值为 `*`。
