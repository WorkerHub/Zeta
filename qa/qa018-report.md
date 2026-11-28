# QA018 报告 — Spark UI 接入生产实机验证（apollo，四页 + 未登录拦截）

- 被测站点：https://zeta.pama.workers.dev（生产，Worker 版本 `eb427c51-04c1-4dc3-a9dd-bcd7d5da3385`，部署于 2026-11-28T12:44Z，含 f2ba681/66c84e4/dc3905b/2d9666e）
- 上游：zeta-spark-service v0.3.0（apollo；Spark UI 已开启、reverseProxy 模式、4040 私有发布）
- 部署前置核验：PR #231/#232 CI 绿（runs 46145912848/46145919234）→ main CI 绿（46146004370/46146022521）→ Deploy 成功（46146070445/46146080703）
- 浏览器工装：Playwright 1.65.1 + Google Chrome for Testing 1255（本机），生产访问走系统代理
- 数据源：Apollo（spark，id `ddda2673-29d0-4292-af9f-ea51c0e653c1`）；对照非 Spark：Workerhub(sqlite)/Bubble(postgres)/Moss(postgres)/Tree(mysql)
- 约束遵守：全程只读（不改代码、不修 bug、不写生产数据）；观感/版式不在清单
- **总判定：第一段 #1/#2/#3 全 PASS；第二段 #4/#5/#7 PASS，#6 FAIL（阻断级，根因已定位，见「阻断缺陷单」）**

## 签收表

| # | 验收项 | 标准 | 测法 | 结果 | 证据 |
|---|--------|------|------|------|------|
| 1 | 未登录访问 `/spark-ui/` 被拦 | 401 JSON，无重定向、非 SPA 壳、不下发会话 cookie | 无 cookie 浏览器上下文实测 4 形态（根路径 / `?db=` 真实 ID / 深路径 / 无斜杠） | **PASS** | `qa/qa018-evidence/results-unauth.json`、`shots/unauth-*.png`、`log-unauth-network.json` |
| 2 | UI 两字段未填的 Spark 数据源不显示入口 | `has_spark_ui=false`（API 口径）且查询页桌面/移动菜单均无 `/spark-ui/` 链接 | 登录态实测：选中 Apollo 后分别打开桌面与移动菜单计数；另全页面级扫描 | **PASS**（run 3，17/17） | `results-phase1.json`（B1/C1/C2）、`shots/phase1-C1-*.png`、`phase1-C2-*.png`、`log-phase1-network.json`（session 内 `/spark-ui` 请求 0 次） |
| 3 | 非 Spark 数据源页面与行为与现行完全一致 | 菜单无 Spark UI 入口；编辑表单不渲染 UI 字段；轻查询行为正常 | 登录态实测：6 个非 Spark 数据源逐个选中开菜单计数；Apple(postgres) 上显式连接后 `SELECT 1`；Bubble/Tree 编辑表单字段扫描 | **PASS**（run 3） | `results-phase1.json`（D-menu-*×6/D-query/E2-Bubble/E2-Tree）、`shots/phase1-D-*.png`、`phase1-E2-*.png` |
| 4 | 首击 `?db=<id>` 设签名 cookie 并 302 `/spark-ui/` | Set-Cookie `spark_ui_session`（HttpOnly/Path=/spark-ui/SameSite=Lax）+ 302 | 登录态实测（第二段，UI 字段填好后） | **PASS**（run 5） | `results-phase2.json`（P4a/P4b/P4c/P4d）、`shots/phase2-P4b-popup-landing.png`、`phase2-S7-first-hit-landing.png`、`log-phase2-network.json` |
| 5 | 菜单打开 Spark UI，Jobs/SQL 页实时进度 | 长查询运行中打开 UI，Jobs/SQL 页显示活动 job；job group 与 会话:执行 ID 对应 | 登录态跑长查询 + UI 实测（第二段） | **PASS**（带注记：查询 2663ms 完成，实时窗口短；SQL 页因 #6 缺陷不可达，见阻断缺陷单） | `results-phase2.json`（P5a/P5b/P5d）、`shots/phase2-S4-landing-jobs-unstyled.png`（Active Jobs: 1 入镜）、`log-phase2-network.json` |
| 6 | Jobs/Stages/SQL/Environment 四页逐页渲染正常 | 无静态资源 404、无错乱重定向、页内链接保持 `/spark-ui/` 前缀 | 逐页抓取 + 链接/资源审计（第二段） | **FAIL（阻断级）**：全部页面裸 HTML；SQL 页被上游 302 逐回 Jobs 页不可达；资源引用 100% 绝对地址跨域被 CSP 拦截 | 阻断缺陷单（下节）+ `console-errors.json`（69 条 CSP 违例原文）、`spark-ui-html-links.json`、`404-resources.json`（空清单）、`shots/phase2-S6-page-*.png`、`log-phase2-network.json`（page-sql 302） |
| 7 | 网络面板见不到 UI 平台令牌与 UI 源发布地址 | 全部请求/响应中无 `ui_platform_token` 明文、无上游发布域名 | 请求/响应记录全文扫描（第二段） | **PASS**（带观察项：页面源码内嵌上游代理基址，见下节定性） | `results-phase2.json`（Q7a–Q7e）、`log-phase2-network.json`（56 条脱敏） |

## 审读疑点（修正后待第二段实测定性，不算结论）

- ~~菜单入口为 `<a href="/spark-ui/?db=<id>" target="_blank">` 顶级导航、无凭据 → 疑似首击 401~~ **此疑点基于旧实现，已过时**。生产部署对应代码中 `SparkUiMenuLink` 是按钮：点击先 `POST /api/spark-ui/session`（SPA 以内存 access token 带 Bearer 调用，SparkUiMenuLink.tsx `handleClick` → `sparkUiApi.createSession`）建立签名会话 cookie，成功后才 `window.open('/spark-ui/', '_blank', 'noopener,noreferrer')`——新标签页携带 `spark_ui_session` cookie 首击，凭据疑点按此机制应不成立。**第二段实测定性：疑点不成立**。run 5 实测菜单点击 → `POST /api/spark-ui/session` 204 + Set-Cookie（P4a）→ 新标签落地 `/spark-ui/jobs/` 渲染 Jobs 内容（P4b）；带 cookie 直接 GET `/spark-ui/?db=<id>` 亦 302 + Set-Cookie 落地首页契约（P4d）。cookie 口径 HttpOnly/Path=/spark-ui/Max-Age≈86400/SameSite=Lax/Secure（P4c），与 `worker/src/routes/spark-ui.ts:104-139` 契约一致。
- 第二段另需实测：带 `spark_ui_session` cookie 直接 GET `/spark-ui/?db=<id>` 的 302 落首页契约（冻结契约口径），与菜单点击流并存。

## 执行分段

- 第一段（未填状态）：#2、#3，另附 #1 已完成项；出结果即停、回报。
- 第二段（用户填好 Apollo 的 ui_url/ui_platform_token 后）：#4、#5、#6、#7 + 疑点定性。

## 执行记录

- **run 1（部分有效）**：注入 refresh_token 后登录态建立成功（A1/B1/B2/B3/C0/C1 + Apple/Deer/Tree 三个非 Spark 菜单项全过，`has_spark_ui=false` 口径确认，全 session `/spark-ui` 请求 0 次），但 6 项因脚本层缺陷失败（菜单开合状态未感知、锚定正则失配按钮 innerText、未先走显式连接流程、移动端预开状态误触发）——均为脚本缺陷非产品问题。部分结果与截图存档于 `results-phase1-run1-partial.json`、`shots-run1/`。
- **run 2（终止）**：refresh=401。原因：refresh 端点为严格一次性轮换（`worker/src/routes/auth.ts` refresh 处理器验证后即 `revokeRefreshToken(payload.jti)` 再发新值），run 1 的 SPA 挂载刷新已消费注入原值。run 1 的 results JSON 被覆盖，已重建存档。
- **run 3（2026-11-28，完整一击，17/17 PASS）**：第 2 枚 refresh_token 注入后单会话跑完全部第一段断言，无页面错误、session 内 `/spark-ui` 请求 0 次。关键值：Apollo `has_spark_ui=false`（B1）；选中 Apollo 后桌面与移动菜单均无入口且页面级扫描为 0（C1/C2）；六个非 Spark 数据源菜单均无入口（D-menu）；Apple 上显式连接（probe 200）后 `SELECT 1` 返回 200 + 1 结果集（D-query）；Bubble/Tree 编辑表单不渲染 UI 字段、Apollo 编辑表单 kind=SparkSQL 且 UI 两字段回显为空（E1/E2）。证据：`results-phase1.json`、`log-phase1-network.json`、`shots/phase1-*.png`。
- **run 4（2026-11-28 15:52 UTC，第二段首试，门槛即停）**：第 3 枚 refresh_token 注入后 SPA 挂载即 `POST /api/auth/refresh` → **401**（值在首次使用前已被轮换吊销；注入机制与 run 3 完全一致）。按约定不重跑，第二段未执行。证据：`results-phase2.json`（P0 失败记录）、`log-phase2-network.json`。待第 4 枚令牌。
- **run 5（2026-11-28 15:57–15:58 UTC，第二段完整一击，22 断言 18 PASS / 4 FAIL）**：第 4 枚 refresh_token 注入后单会话跑完 #4–#7 全部断言，无页面错误（page_errors=[]）。结果落盘 `results-phase2.json`（run_at 15:58:26Z）。#4 全链路 PASS（建会话 204 → popup 落地 → cookie 口径 → 首击 302 契约）；#5 PASS（带注记）；#6 **FAIL 阻断级**（见阻断缺陷单）；#7 PASS（带观察项）。4 项 FAIL 为 P6-landing-style / P5c / P6b（根因即 #6 缺陷 + 脚本探针缺陷）与 Q7a（fonts 为应用既有行为，见下节定性）。
- **执行完毕**：两段全部完成，签收表如上。阻断缺陷待用户开修复单（本 QA 不修）。

## 阻断缺陷单（#6，run 5 实测，供开修复单）

**标题**：Spark UI 反代页面全部裸 HTML（无样式无脚本），SQL 页不可达

**现象**
- 我方会话（访问源 `zeta.pama.workers.dev`）：落地页与 Jobs/Stages/Environment 页全部裸 HTML（截图目视确认）；4 样式表 + 9 脚本 + 1 icon 共 14 个资源引用**零网络请求发出**；控制台 **69 条 CSP 违例原文**，如：
  `Loading the stylesheet 'https://zeta.oneboy.app/spark-ui/proxy/local-1795879633814/static/bootstrap.min.css' violates the following Content Security Policy directive: "style-src 'self' 'unsafe-inline'". ... The action has been blocked.`
- 用户会话（访问源 `zeta.oneboy.app`，用户手动实测）：同样裸 HTML，控制台报样式被 MIME text/html 拒绝。
- `GET /spark-ui/sql/` → 上游 **302** → 反代改写落 `/spark-ui/jobs/` → **SQL 页不可达**（net log page-sql 段：302 document+fetch → jobs 200）。

**href 定性（5 个页面全部一致，`spark-ui-html-links.json`）**
- 全部资源引用为**绝对地址**：`https://zeta.oneboy.app/spark-ui/proxy/local-1795879633814/static/{bootstrap.min.css, vis-timeline-graph2d.min.css, webui.css, timeline-view.css, spark-logo-77x50px-hd.png, sorttable.js, jquery-3.5.1.min.js, vis-timeline-graph2d.min.js, bootstrap.bundle.min.js, initialize-tooltips.js, table.js, timeline-view.js, log-view.js, webui.js}`
- 无空 href、无相对路径、无指回页面自身的引用（用户控制台「样式请求落到页面 URL」现象与我方捕获不符，推测为其会话时点的上游会话/路径差异，以我方 HTML 存档为现行事实）。
- 路径段 `local-1795879633814` = **spark.app.id**（Environment 页证实：`spark.app.id=local-1795879633814`、`spark.ui.reverseProxy=true`、`spark.ui.port=4040`）→ 即 Spark 原生 reverseProxy 路径 `/proxy/<appId>/`；主机名 `zeta.oneboy.app` 来自上游为 Spark 配置的公网代理基址（spark.ui.proxyBase 类配置）。

**失败资源清单**：**空**（`404-resources.json`，全页合计 0 个 4xx、0 个 MIME=text/html）。失败模式不是「请求了但失败」，而是**请求根本未发出**（CSP 在发起前拦截）。

**根因链（三层叠加）**
1. 上游 zeta-spark-service 为 Spark 配置了指向产品公网域的代理基址（`zeta.oneboy.app` + `/spark-ui/proxy/<appId>`），UI HTML 内嵌绝对地址资源引用（Environment 页截图 + href 清单为证）。
2. worker 反代**无响应体改写**：`worker/src/routes/spark-ui.ts` 仅改写 Location 头，HTML 经 `new Response(proxyRes.body, ...)` 原样透传，资源引用不落回当前访问源。
3. worker 安全头中间件作用于所有路由：`worker/src/index.ts:39` `app.use('*', securityHeaders)`，CSP `style-src 'self' 'unsafe-inline'` / `script-src 'self' 'unsafe-inline' 'unsafe-eval'`（`worker/src/middleware/security.ts:18-25`）盖在反代响应上 → 非 oneboy.app 访问源上跨域样式/脚本被浏览器拦截（控制台 69 条违例）；oneboy.app 访问源上引用同源放行，但该 URL 走 worker `/spark-ui/proxy/*` 路由再次反代至 ui_url 拼接路径，返回 text/html 被 MIME 拒（用户控制台报错）。
4. 另：上游对 `/spark-ui/sql/` 返回 302 → `/jobs/`（Spark 原生 `/sql/` 不应 302），需上游侧核查。

**修复方向（供参考，不在本 QA 执行）**
- 上游侧：代理基址不指向产品域、或生成相对路径引用；
- worker 侧：反代补 HTML 响应体改写（上游基址 → 当前访问源 `/spark-ui/` 前缀）；且 `/spark-ui/*` 反代响应豁免或放宽 CSP（`app.use('*')` 改为排除反代路径）；
- 上游侧：核查 SQL 页 302 行为（proxyBase 与 reverseProxy 路径匹配）。

**复现路径**：登录 → 选中 Apollo → 查询页菜单点 Spark UI → 新标签落地 `/spark-ui/jobs/` 裸 HTML；DevTools 控制台可见 CSP 违例；直接访问 `/spark-ui/sql/` 被 302 回 `/jobs/`。

## 第二段定性补充

**#4（PASS）**：菜单点击整链路实测——桌面菜单入口出现（entry_count=1，P4pre）→ `POST /api/spark-ui/session` **204** + Set-Cookie（P4a，flags `HttpOnly; Path=/spark-ui; Max-Age=86400; SameSite=Lax; Secure`）→ popup 落地 `/spark-ui/jobs/` 且渲染 Jobs 内容（P4b）→ 上下文 cookie 口径逐项核对（P4c，maxAge≈86397）→ 首击契约：带 cookie GET `/spark-ui/?db=<id>` 302 + Set-Cookie + 落地（P4d）。与冻结契约及 `worker/src/routes/spark-ui.ts:104-139` 完全一致。

**#5（PASS，带注记）**：长查询 `SELECT sum(id % 7) AS s FROM range(5000000000)` 于 15:57:56 提交、**2663ms 完成**（apollo Spark 极快，实时观测窗口短——如实注记）。Jobs 页捕获：
- 落地页截图 Active Jobs: 1（job 67，0/2 进行中）+ 完成行 job 66/67 入镜（实时可观测成立，P5a）；
- job group 格式实测 `zeta:<会话ID>:default[:<执行ID>]`：job 64 `zeta:dac03cb2-…:default`（会话探针 10ms，无执行 ID）、job 66/67 同挂 `zeta:dac03cb2-…:default:ae191e99-…`（本查询执行，15:58:02 1s / 15:58:04 0.1s，P5d duration_ms=2663 吻合）、job 18 `zeta:dac03cb2-…:default:8e5dc255-…`（15:35:21，用户此前测试查询）——与冻结契约「会话:执行 ID」口径一致（P5b 文本留档）。
- P5c FAIL（SQL 页无执行记录）根因 = #6 缺陷中「/sql/ 被上游 302 逐回」+ 我方脚本捕获竞态；SQL 页不可达已并入阻断缺陷单。

**#7（PASS，带观察项）**：
- 网络 panel 全 session 请求主机仅生产 origin（84 条）+ `fonts.googleapis.com`（1）+ `fonts.gstatic.com`（2）。字体为**应用既有行为**（phase 1 未填态同样 3 条请求），与 Spark UI 变更面无关；**无任何上游/发布主机请求**。
- `ui_platform_token`/accessToken 不出现在任何请求 URL（Q7b hits=0）；`:4040` 不出现在 URL 与 `/api/*` 响应体（Q7c）；`/api/databases` 无 UI 字段回显（Q7d，仅 `has_spark_ui`）。
- 观察项（不定级，供裁量）：反代页面**源码**内嵌上游代理基址 `zeta.oneboy.app/spark-ui/proxy/<appId>/…`（浏览器可见）。该主机即产品自身域名、路径经 worker 鉴权门控、4040 私有发布未泄露；但上游 appId 形态信息进入页面源码，建议随 #6 根因修复一并消除。
- Environment 页 `spark.ui.port=4040`、`javax.jdo.option.ConnectionURL=jdbc:postgresql://pg:5432/metastore`（密码列 Spark 自行 redact）为 Spark 自身配置展示、鉴权门控内，不构成发布地址/凭据泄露（Q7e 观察项）。

**脚本缺陷披露（不影响定性结论）**：P6b/P6-landing-style 样式探针 evaluate 抛错被 catch 记 null（样式判定改以网络面板 + 截图目视 + 控制台 CSP 违例定性，三源互证）；S5 SQL 页文本捕获与导航竞态；P6a 中 sql 页 markerOk 为假阳性（302 落 jobs 后导航栏含 "SQL" 文案）——已以 net log 302 证据纠正。
