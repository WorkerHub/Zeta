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

## 审读疑点（待实测确认，不算结论）

- 菜单入口 `SparkUiMenuLink` 的 href 为 `/spark-ui/?db=<id>`，不带任何凭据；后端 `requireAuth` 对 `/spark-ui` 首击仅接受 `spark_ui_session` cookie、`Authorization` 头或 `?token=`。SPA 的 access token 仅存内存、refresh cookie 仅限 `Path=/api/auth`，顶级导航两者皆不带 → **代码上推断：真实浏览器从菜单打开 Spark UI 的首击会得到 401 JSON**，入口不可用（除非 24h 内曾以其他方式完成过一次带凭据的首击）。此为变更面内的集成疑点，第二段以真实浏览器点击菜单实测定性。

## 执行分段

- 第一段（未填状态）：#2、#3，另附 #1 已完成项；出结果即停、回报。
- 第二段（用户填好 Apollo 的 ui_url/ui_platform_token 后）：#4、#5、#6、#7 + 首击疑点定性。
