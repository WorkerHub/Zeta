# QA018 报告 — Spark UI 接入生产实机验证（apollo，四页 + 未登录拦截）

- 被测站点：https://zeta.pama.workers.dev（生产，Worker 版本 `eb427c51-04c1-4dc3-a9dd-bcd7d5da3385`，部署于 2026-11-28T12:44Z，含 f2ba681/66c84e4/dc3905b/2d9666e）
- 上游：zeta-spark-service v0.3.0（apollo；Spark UI 已开启、reverseProxy 模式、4040 私有发布）
- 部署前置核验：PR #231/#232 CI 绿（runs 46145912848/46145919234）→ main CI 绿（46146004370/46146022521）→ Deploy 成功（46146070445/46146080703）
- 浏览器工装：Playwright 1.65.1 + Google Chrome for Testing 1255（本机），生产访问走系统代理
- 数据源：Apollo（spark，id `ddda2673-29d0-4292-af9f-ea51c0e653c1`）；对照非 Spark：Workerhub(sqlite)/Bubble(postgres)/Moss(postgres)/Tree(mysql)
- 约束遵守：全程只读（不改代码、不修 bug、不写生产数据）；观感/版式不在清单

## 签收表

| # | 验收项 | 标准 | 测法 | 结果 | 证据 |
|---|--------|------|------|------|------|
| 1 | 未登录访问 `/spark-ui/` 被拦 | 401 JSON，无重定向、非 SPA 壳、不下发会话 cookie | 无 cookie 浏览器上下文实测 4 形态（根路径 / `?db=` 真实 ID / 深路径 / 无斜杠） | **PASS** | `qa/qa018-evidence/results-unauth.json`、`shots/unauth-*.png`、`log-unauth-network.json` |
| 2 | UI 两字段未填的 Spark 数据源不显示入口 | `has_spark_ui=false`（API 口径）且查询页桌面/移动菜单均无 `/spark-ui/` 链接 | 登录态实测（第一段） | 待测（等 refresh_token） | `scripts/qa018-phase1.js`（C 组） |
| 3 | 非 Spark 数据源页面与行为与现行完全一致 | 菜单无 Spark UI 入口；编辑表单不渲染 UI 字段；轻查询行为正常 | 登录态实测（第一段） | 待测（等 refresh_token） | `scripts/qa018-phase1.js`（D/E 组） |
| 4 | 首击 `?db=<id>` 设签名 cookie 并 302 `/spark-ui/` | Set-Cookie `spark_ui_session`（HttpOnly/Path=/spark-ui/SameSite=Lax）+ 302 | 登录态实测（第二段，UI 字段填好后） | 待测（等字段填写） | 计划 `scripts/qa018-phase2.js` |
| 5 | 菜单打开 Spark UI，Jobs/SQL 页实时进度 | 长查询运行中打开 UI，Jobs/SQL 页显示活动 job；job group 与 会话:执行 ID 对应 | 登录态跑长查询 + UI 实测（第二段） | 待测（等字段填写） | 计划 |
| 6 | Jobs/Stages/SQL/Environment 四页逐页渲染正常 | 无静态资源 404、无错乱重定向、页内链接保持 `/spark-ui/` 前缀 | 逐页抓取 + 链接/资源审计（第二段） | 待测（等字段填写） | 计划 |
| 7 | 网络面板见不到 UI 平台令牌与 UI 源发布地址 | 全部请求/响应中无 `ui_platform_token` 明文、无上游发布域名 | 请求/响应记录全文扫描（第二段） | 待测（等字段填写） | 计划 |

## 审读疑点（修正后待第二段实测定性，不算结论）

- ~~菜单入口为 `<a href="/spark-ui/?db=<id>" target="_blank">` 顶级导航、无凭据 → 疑似首击 401~~ **此疑点基于旧实现，已过时**。生产部署对应代码中 `SparkUiMenuLink` 是按钮：点击先 `POST /api/spark-ui/session`（SPA 以内存 access token 带 Bearer 调用，SparkUiMenuLink.tsx `handleClick` → `sparkUiApi.createSession`）建立签名会话 cookie，成功后才 `window.open('/spark-ui/', '_blank', 'noopener,noreferrer')`——新标签页携带 `spark_ui_session` cookie 首击，凭据疑点按此机制应不成立。第二段以真实浏览器点击菜单实测整链路（POST 建会话 → 新标签页渲染）定性。
- 第二段另需实测：带 `spark_ui_session` cookie 直接 GET `/spark-ui/?db=<id>` 的 302 落首页契约（冻结契约口径），与菜单点击流并存。

## 执行分段

- 第一段（未填状态）：#2、#3，另附 #1 已完成项；出结果即停、回报。
- 第二段（用户填好 Apollo 的 ui_url/ui_platform_token 后）：#4、#5、#6、#7 + 疑点定性。

## 执行记录

- **run 1（部分有效）**：注入 refresh_token 后登录态建立成功（A1/B1/B2/B3/C0/C1 + Apple/Deer/Tree 三个非 Spark 菜单项全过，`has_spark_ui=false` 口径确认，全 session `/spark-ui` 请求 0 次），但 6 项因脚本层缺陷失败（菜单开合状态未感知、锚定正则失配按钮 innerText、未先走显式连接流程、移动端预开状态误触发）——均为脚本缺陷非产品问题。部分结果与截图存档于 `results-phase1-run1-partial.json`、`shots-run1/`。
- **run 2（终止）**：refresh=401。原因：refresh 端点为严格一次性轮换（`worker/src/routes/auth.ts` refresh 处理器验证后即 `revokeRefreshToken(payload.jti)` 再发新值），run 1 的 SPA 挂载刷新已消费注入原值。run 1 的 results JSON 被覆盖，已重建存档。
- **待办**：待新 refresh_token 后一击跑完第一段（脚本已修复为菜单状态感知 + 非锚定匹配 + 显式连接 + 移动端预开处理）。
