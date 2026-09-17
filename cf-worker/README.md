# lobsterai2api — Cloudflare Workers 版

将 LobsterAI 上游转换为 OpenAI 兼容 API 的 Cloudflare Workers 移植（原 Go 版 lobsterai2api 的 Workers 重写）。
**凭证保管、签到、余额维护全部在 CF 完成，无需 GitHub Actions 参与。**

## 结构

| 文件 | 职责 |
|---|---|
| `src/protocol.mjs` | 纯协议层：OpenAI↔LobsterAI 请求/响应转换、SSE 聚合、错误分类、JWT 过期解析 |
| `src/upstream.mjs` | 上游 HTTP 客户端：信封解包、刷新、对话（流式转发 + 超时）、签到、模型列表 |
| `src/coordinator.mjs` | Durable Object：账号池、显式操作队列（防并发交错）、冷却状态机、每日维护、alarm 驱动 |
| `src/worker.mjs` | 入口：Bearer 鉴权（API_KEY/ADMIN_KEY）、路由、cron 触发 |
| `test/worker.test.mjs` | 离线回归（`node --test`，无网络无 CF 运行时） |

## 部署

```bash
npm i -g wrangler
wrangler deploy            # wrangler.toml 已含 DO 绑定与 cron
wrangler secret put API_KEY    # 对外 /v1 鉴权
wrangler secret put ADMIN_KEY  # /admin 鉴权
```

## 账号导入

`POST /admin/accounts`，`Authorization: Bearer <ADMIN_KEY>`：

```json
[{"accessToken":"...","refreshToken":"...","uid":"...","firstKeyfrom":"...","latestKeyfrom":"..."}]
```

兼容嵌套形（`{"auth":{...},"account":{...}}`，登录工具 OAuth 输出）与扁平形；重复 uid 为更新、同批重复为错误。
**不落真实凭证，仅 accessToken/refreshToken 字段名示例。**

`GET /admin/status` 查看池状态（uid、冷却原因、过期时间、签到日期）；`POST /admin/maintenance` 手动触发维护。

## 端点

- `GET /v1/models` — 上游动态模型（带 keyfrom 查询参数），结果缓存 1h；上游不可用时回退到 19 个静态模型并标注 `source: "static"`
- `POST /v1/chat/completions` — stream=true 时逐块转发上游 SSE（响应头 content-type/cache-control/x-accel-buffering 由本服务重建）；false 时在 DO 锁外聚合为完整 JSON
- `GET /health` 存活探测（不需要密钥，不代表上游可用）

## 状态机（与 Go 版对齐并修正）

- 冷却策略（与 Go 版 `cmd/server/config.go` 默认值一致）：`no_credit`(402/余额关键词)→12h；`rate_limit`(429)→60s；`session_dead`/401→禁用并提示换凭证；连续 3 次未知/传输/服务端错误→`error_threshold` 冷却 10m，成功一次即清零
- `POST /v1/chat/completions` 单请求最多轮转 3 个账号（`MaxRotate`）：402/429/5xx 依次换号重试，请求级错误（`invalid_request`/`configuration_error`/`cancelled`）立即返回，最终错误为最后一个账号的失败
- chat 收到 401 时对同一账号强制刷新一次并重试
- **与 Go 的差异**：本版把账号状态与凭证同存一份文档，所以刷新成功后只清鉴权类 reason；`no_credit`/`rate_limit`/`error_threshold` 冷却必须等余额恢复或冷却到期（Go 版冷却存在独立 pool 状态里，刷新本就不影响冷却）
- 重新导入同 uid 只更新凭证字段，保留 `credits`/`checkinDay`/`checkinKey`/未到期的冷却状态，并清除 `disabled`/`refreshPending`（Go 版 `Pool.Add` 的“保留状态”语义）
- 签到带同日幂等键持久化：`checkinDay` 变更时才生成新 `checkinKey`，当天重试复用同一 key；每次维护明细写入 `lastMaintenance`
- 维护走 alarm 逐账号串行，绝不并发打上游

## 本地验证

```bash
node --test test/worker.test.mjs   # 16 项断言：协议转换、鉴权比较、SSE 聚合、池调度/轮转、维护、上游错误映射、刷新失败与静态回退回归
# 注意：Node ≥ 21 把无扩展名的 `test/` 当模块解析，`node --test test/` 会 MODULE_NOT_FOUND；须写全文件名
```

## 边界

- 未在真实 CF 运行时验证（本地仅语法 + 离线行为测试）；DO/alarm 行为依据官方文档编写
- 签到成功字段名按 `scripts/checkin.py` 兼容序列探测（creditsGranted/rewardCredits/credits）
