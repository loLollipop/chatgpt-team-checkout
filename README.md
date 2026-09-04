# ChatGPT Team 长链工作台

带 CDK 准入控制、优惠码自动分配、国家代理路由和分类管理后台的 ChatGPT Team Checkout 长链工作台。

## 已实现功能

- 页面首次打开只显示 CDK 验证入口，验证通过后才会进入正式工作台。
- 客户 CDK 生成后有 24 小时待激活期；首次校验激活后 24 小时内可重复提链并更换国家。首次成功使用已绑定优惠码后，CDK 结束时间会与优惠码自动清理时间对齐。
- 支持长期有效、可重复使用的管理员通用 CDK；重新生成时自动停用旧码。
- CDK 支持停用和软删除；删除后立即失效并从后台列表移除，但不会回收已经分配的优惠码。
- `/admin` 管理后台按概览、CDK、优惠码、国家代理分类。
- 优惠码支持 Excel、CSV、TXT 和粘贴导入；所有国家共用全球库存，生成客户 CDK 时原子分配一条。
- 兼容导入完整 `chatgpt.com/p/...` 链接，自动截取、存储并展示 `/p/` 后的优惠码；库存列表支持状态筛选和分页。
- 客户使用该 CDK 自动分配的优惠码时保持 24 小时规则；首次成功使用不匹配的自有优惠码后，自动释放原分配码，CDK 切换为 3 小时 / 默认 3 次成功提链模式，管理员可在有效期内追加次数。
- 外部优惠码成功提链记录使用 AES-GCM 加密保存，仅在鉴权后的 CDK 管理列表中展示；用户工作台不展示审计模式和优惠码记录。
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
  → Worker 查询 D1，首次校验时激活 24 小时授权
  → 页面解锁
  → 用户提交 Access Token、国家和优惠码
  → Worker 再次验证 CDK，并校验优惠码是否精确绑定给当前 CDK
  → Worker 解密该国家代理并交给 HTTPS Relay
  → Relay 通过对应 HTTP / HTTPS 代理出站
  → chatgpt.com / api.openai.com
  → 成功后累计 CDK 使用次数；分配码标记已售出，不匹配码释放原库存并进入 3 小时 / 3 次审计模式
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

服务端固定每个新客户 CDK 有 24 小时待激活期。首次调用校验接口时写入激活时间，并把有效期重置为从激活时刻起 24 小时；使用当前 CDK 自动分配的优惠码时可在有效期内重复生成支付链和更换国家。首次成功使用该分配码后，CDK 的结束时间会精确同步为优惠码的 `auto_delete_at`，重复提链不会延后。传入自定义次数或有效期不会改变该规则。库存不足时整批生成会被拒绝，不会留下未绑定优惠码的 CDK。

客户 CDK 首次成功使用与自动分配码不匹配的优惠码时，会立即解除原分配关系，让未售出的原优惠码回到库存，并从该次成功时刻开始切换为最长 3 小时、默认 3 次成功提链的仅 CDK 模式。只有上游返回有效 Checkout 链接才释放和计数；参数错误、代理失败和上游失败均不会释放或计数。默认第 3 次成功仍返回链接，之后 CDK 自动进入 `exhausted`。管理员可在原 3 小时有效期内每次追加 1–100 次；充值只增加使用上限，不清零真实使用次数，也不延长有效期。仅 CDK 模式内每次成功使用的优惠码会加密写入审计记录，管理员可在 CDK 列表展开查看。新规则对旧 CDK 同样有效。管理员通用 CDK 不受该规则限制。

管理员通用 CDK 长期有效、可重复使用、不分配优惠码。系统同时只保留一个有效管理员通用 CDK。

校核 CDK 会开始 24 小时激活期，但不会增加使用次数。每次成功生成支付链后，后端使用带条件的 D1 `UPDATE` 原子累计 `use_count` 供审计；激活期内不限制成功次数。国家代理未配置、参数不合法或上游失败时不会累计次数。

CDK 可处于以下状态：

- `pending`：尚未激活，仍处于 24 小时激活期限内。
- `active`：已经激活且仍在 24 小时有效期内；使用已绑定优惠码成功后与该优惠码同步结束。
- `exhausted`：旧版单次 CDK 次数已耗尽，或仅 CDK 模式已成功提链 3 次。
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

`seatDefault` 和 `seatProlite` 分别是标准席位与高级席位数量，两者都可大于 0，但合计必须为 2–999。`billingPeriod` 可选 `month` 或 `year`。后端会把合计数量写入整数 `seat_quantity`，并把标准/高级席位明细写入复数字段 `seat_quantities`。旧版 `seatQuantity` + `seatType` 请求仍兼容。

`promoCode` 可留空。填写当前 CDK 自动分配的优惠码时，生成支付链成功后会自动标记为“已售出”，完整代码不再通过优惠码库存接口返回，并在 24 小时后由 Cloudflare Cron 软删除；重复提链不会延后首次自动删除时间。填写任何与当前 CDK 分配码不匹配的优惠码时仍允许生成支付链，但客户 CDK 会在首次成功后释放原分配码，并切换为 3 小时 / 3 次的仅 CDK 模式，管理后台保留加密审计记录。

后端只接受九个国家，币种由国家强制决定。主源网络错误、超时或 5xx 时，会通过同一个国家代理回退到 `api.openai.com`。

### 管理 API

所有管理请求必须携带：

```http
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/admin/cdks?limit=500`：CDK 可视化列表和统计；新 CDK 返回可复制明文，历史哈希记录保持脱敏，并包含仅 CDK 模式的成功次数与加密审计记录。
- `POST /api/admin/cdks`：生成 CDK。
- `POST /api/admin/cdks/universal`：生成新的管理员通用 CDK，并自动停用旧管理员 CDK。
- `DELETE /api/admin/cdks/:id`：吊销 CDK。
- `DELETE /api/admin/cdks/:id/delete`：软删除 CDK；保留优惠码分配关系。
- `POST /api/admin/cdks/:id/recharge`：为尚未过期的仅 CDK 模式追加 `quantity` 次额度，单次 1–100，不延长有效期。
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
