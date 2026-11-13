# Zeta 三期 SparkSQL spike 结论

- 日期：2026-11-13（北京时间）
- 单号：Zeta #12「三期 SparkSQL spike：执行器方案 + 发布端口六项实测」
- 状态：六项实测全部完成、执行器方案与 `spark` 方言基线定稿，**待 SPEC v2.5 核对**；核对通过后据此拆三期实施单（后端执行器 / 前端连接态）。
- 本文档是用户点名的交付物（原「过程文档不进仓库」的执行约束由本轮用户指令改判），不含任何密钥、令牌或发布地址。

---

## 0. 摘要

| 项 | 结论 | 关键证据 |
|---|---|---|
| 1 发布 private 端口 + 登记载荷 | 通过 | 无平台令牌 → 401 纯文本 `This URL is private…`；`/health` 只验平台令牌；`/query` 验应用令牌 |
| 2 127.0.0.1 绑定下的代理可达性 | **可达，不改绑 0.0.0.0** | 经发布 URL `GET /health` → 200，1.3–2.8 s |
| 3 闲置 suspend 后唤醒 | 通过 | 静置 31 分 42 秒 → 首个请求 200 / **3447 ms** / 一次成功；会话与 `t_demo` 完好 |
| 4 1000 行结果集与响应体积 | 通过 | 1000 行 6,957 B；加压到 **1.0 MB 逐字节完整**，无截断 |
| 5 机器 stop 态错误形态 | 通过 | 503 + `text/plain` 三形态；判定规则与四句文案已定（见 §2.6） |
| 6 撤销旧 quick tunnel | 通过 | 旧主机名权威 DNS 为 **NXDOMAIN**（两个公共解析器一致）；`spark-tunnel.service` 已 stop+disable |

三条要记住的结论：

1. **不需要改绑 0.0.0.0**——发布代理在机器边界内可达 loopback，公网暴露面维持「发布端口 + 双令牌」，规格无需记录偏离原因。
2. **suspend 对用户是无感的**：访问即唤醒（3.4 s），首请求直接成功，SparkSession 与练习表无损；`/health → 语句` 两步天然覆盖。
3. **stop 与 suspend 是两种机制**：代理明说「a visit does not start it」，即**访问不会启动已停止的机器**——因此 stop 态必须立刻失败并给专属文案，重试没有意义。

---

## 1. 六项逐项结果

### 项 1 · 发布 private 端口与登记载荷 — 通过

| 探测 | 结果 |
|---|---|
| `GET /health` 不带平台令牌 | **401**，`text/plain`：`This URL is private. Open the link that carries its ?_token=, or send the token as Authorization: Bearer.` |
| `GET /health` 带平台令牌 | **200**，`{"ok":true,"sparkVersion":"3.5.3"}` |
| `GET /health` 带平台令牌、**不带**应用令牌 | **200** ——健康检查只验平台令牌 |
| `POST /query` 双令牌齐备（`select 1`） | 200，`{"columns":["ok"],"rows":[[1]],"rowCount":1,"truncated":false}` |
| 缺应用令牌 | **401**，JSON `{"error":"unauthorized"}` |
| 应用令牌错误 | **401**，JSON `{"error":"unauthorized"}` |

结论：private 端口成立；登记载荷所需三项（`url` / 平台令牌 / 应用令牌）实测齐备可用。产品侧对「平台令牌只显示一次」的处理口径是**管理员粘贴后不回显、编辑需重填**（与 PG/MySQL 连接串一致）。

### 项 2 · 127.0.0.1 绑定下的代理可达性 — 可达，不改绑

- 经发布 URL 直接打通：首测 **2573 ms**（13:22:57），热态 **1329–2839 ms**，项 4/5 期间长期稳定 1.2–2.2 s。
- 结论：**不需要改绑 0.0.0.0，规格不需要新增偏离原因。** 安全边界仍是「私网绑定 + 发布代理 + 双令牌」。

### 项 3 · suspend 后唤醒 — 通过

| 项 | 实测 |
|---|---|
| 静置窗口 | 13:24:48 → 13:56:30（北京时间），**31 分 42 秒**零探测 |
| 平台侧证据（Instabox API） | `autoSuspendAfterSeconds=1800`；约 05:54:48Z 自动 suspend；`runStartedAt=2026-11-13T05:56:32Z`（首个请求 05:56:30Z 后 2 秒） |
| **端到端唤醒耗时** | **3447 ms** |
| **首请求是否直接成功** | **是**：单次、不重试的 `GET /health` 直接 200，无 502/503，不依赖重试 |
| 唤醒后 SparkSession | 完好：无 JVM 重建（3.4 s 排除冷启动）；`t_demo` 两行 `[[1,"alice"],[2,"bob"]]` |
| 唤醒后一致性抽查 | 1000 行查询响应 **6,957 字节，与静置前完全一致** |
| 唤醒后热态 | `/health` 1359 ms、`show tables` 1327 ms、`select * from t_demo` 2242 ms |

### 项 4 · 1000 行结果集与响应体积 — 通过

| 查询 | maxRows | 行数 | `truncated` | 响应字节 | 耗时 |
|---|---|---|---|---|---|
| `select id from range(1000)` | 1000 | 1000 | false | **6,957** | 1.5 s |
| 同上，三列（int / 字符串 / int） | 1000 | 1000 | false | 23,308 | 2.0 s |
| `select id from range(6000)` | 5000 | 5000 | **true** | 38,956 | 2.8 s |
| 同上 | 8000 | 5000（硬上限） | true | 38,956 | 4.1 s |
| 同上 | **100** | 100 | true | 655 | 1.3 s |
| `select id from range(100)` | 100 | 100 | **false**（无更多行，不误报） | 656 | 1.3 s |
| `select id from range(5000)` | 5000 | 5000 | **false**（恰等于上限） | 38,957 | 2.7 s |
| 5000 行 × 7 列 | 5000 | 5000 | false | 275,302（269 KB） | 4.3 s |
| 5000 行 × 200 字符 | 5000 | 5000 | false | **1,030,066（1.0 MB）** | 6.3 s |

结论：**代理对响应体积无截断，至少到 1.0 MB 逐字节完整**（末行抽查一致）；行数封顶 5000 生效；`truncated` 判定精确——等于上限但没有更多行时为 `false`。

### 项 5 · 机器 stop 态的错误形态 — 通过

| 探测 | 状态 | 响应头 | 响应体 |
|---|---|---|---|
| 停机前 | 200 | `server: BaseHTTP/0.6 Python/3.8.10` | JSON 正常结果 |
| 刚停机（14:22:05） | **503** | `text/plain`，无 `server` 头 | `Sandbox is not reachable.`（26 B） |
| 稳定停机（14:22:07–14:30:07） | **503** | `text/plain`、`cache-control: no-store` | `Sandbox offline: it is stopped, and a visit does not start it. Its owner can start it: instabox start <sandbox>`（112 B） |
| 停机态 + 无令牌 | 401 | `text/plain` | `This URL is private. …`（令牌校验先于机器状态） |
| 停机态 + 错平台令牌 | 401 | `text/plain` | 同上 |
| 停机态 + 有效平台令牌 + **错应用令牌** | **503**（不是 401） | `text/plain` | offline 文案（代理先判机器状态，服务层未被问到） |
| 停机态 + 坏 SQL | 503 | `text/plain` | offline 文案（请求到不了服务） |
| 停机态 + 不存在的路径 | 503 | `text/plain` | offline 文案（状态检查先于路由） |
| 启动中（14:30:24） | **502** | `text/plain` | `The sandbox service disconnected or is unavailable.`（32 B） |
| 恢复后（14:30:41） | 200 | JSON | 17 秒内可用；首查询 5.9 s 预热，`t_demo` 两行完好（6.9 s） |

停机态 503 响应耗时 1.2–3.0 s。判定规则与对外文案见 §2.6。

### 项 6 · 撤销 quick tunnel — 通过（旧地址在撤销前即已死亡）

旧主机名为 Muse 提供的 cloudflared quick tunnel（2026-11-12 13:27Z 建立；具体主机名见单内，本文档不复述）。

| 检查 | 结果 |
|---|---|
| 权威 DNS（cloudflare-dns.com DoH） | **Status 3 = NXDOMAIN**，Authority 为 `trycloudflare.com` 的 SOA（Cloudflare 权威侧无此记录） |
| 独立复核（dns.google DoH） | **Status 3 = NXDOMAIN**，同样带 `trycloudflare.com` SOA |
| 连续 3 次（14:32:19 / 27 / 36） | 全部 `Status 3, answers 0`；经代理 HTTP 一律 **502** |
| HTTPS 直连 | 本地代理 CONNECT 建立后 TLS 握手中断（上游已不存在） |
| 本机系统解析 | NXDOMAIN；同环境对照（发布 URL、cloudflare.com）解析正常 |
| Muse 侧 | `cloudflared` 自 06:20:54Z 起 `Register tunnel error ... Unauthorized: Tunnel not found` 持续重试；`spark-tunnel.service` 已 **stop + disable**；旧地址 curl 000 |

结论：旧公网入口在 DNS 层就不存在（不是「服务关掉了」，是记录已消失），**公网入口实际只剩发布端口一条**，双令牌即唯一安全边界。

---

## 2. 执行器方案结论

### 2.1 服务契约（实测口径）

- `GET /health` → `{"ok": true, "sparkVersion": "3.5.3"}`；只验平台令牌。
- `POST /query`，头 `X-Auth-Token: <应用令牌>`，体 `{"sql": "...", "maxRows": 5000}`；
  成功 `{"columns": [...], "rows": [[...]], "rowCount": n, "truncated": bool}`。
- 双令牌分工：平台令牌走 `Authorization: Bearer`（代理层验），应用令牌走 `X-Auth-Token`（服务层验）。
- 值已在服务侧 JSON 安全化：`decimal → "1.23"`、`date → "2026-11-13"`、`binary → base64`、`null → null`、`double → 数字`。
- `rowCount` = 返回行数；SELECT 为结果行数，INSERT/DDL **恒为 0**（不得冒充受影响行数）。
- 单请求只接受一条语句；多语句由客户端拆分后逐条发送（Zeta 侧已有：`web/src/lib/sql.ts` 的 `splitSqlStatements` + `/api/query/batch` 逐条请求），执行器无需自拆。
- 行数硬上限 5000；常驻单个 SparkSession（local[4]、driver 4g、Hive/Derby metastore 在数据目录），**全局锁串行**。

### 2.2 结果映射

`columns + rows[[…]]` → `results: Record<string, unknown>[]`：按列名 zip 成对象，**短行缺列补 `null`**（否则 JSON 序列化时键消失、前端列错位）。已知行为：重名列（`select 1 as a, 2 as a` → `columns=["a","a"]`）映射后后者覆盖，与 D1 路径一致，不做特殊处理。`truncated` 直传。

### 2.3 错误分级（实测 8 形态全覆盖）

| HTTP | 形态 | 归类 | 呈现 |
|---|---|---|---|
| 200 | `columns/rows` | 成功 | 结果表 |
| 200 | `{"error": "..."}` | `sql` | 400，全员可见（裁剪后的原文，保留 `[TABLE_OR_VIEW_NOT_FOUND]` 等错误码） |
| 400 | `{"error":"empty sql"}` / `"single statement only"` | `sql` | 400（Zeta 自己的 `empty` / `multiple` 守卫会先拦，属兜底） |
| 401 | JSON `{"error":"unauthorized"}` | `auth` | 500，仅管理员：应用令牌被拒 |
| 401 | `text/plain` `This URL is private…` | `auth` | 500，仅管理员：发布地址令牌被拒 |
| 403 | 任意 | `auth` | 同上 |
| 503 | `Sandbox offline: it is stopped…` | `not_ready`（已停止） | 500 全员：机器已停止，**不重试** |
| 502 / 503 其他文案 | `Sandbox is not reachable` / `The sandbox service disconnected` | `not_ready`（启动中） | 500 全员：启动中或暂不可达，**重试** |
| 网络错误 / 非 JSON / 超时 | — | `transport` | 500，仅管理员 |

实现判定顺序：先看 `502/503` 判机器态（离线文案优先，因为此时服务层根本没被问到），再按 `401` 的 `content-type` 分代理层与服务层，最后 `400`/`200` 且带 `error` 归 `sql`。错误正文裁剪到 **1500 字符**（Spark 的结构化异常 + 逻辑计划树可达数 KB；`runs.ts` 的错误存储上限是 2000 字符）。

### 2.4 重试与超时

- 每次请求先 `GET /health`（3 次，间隔 0 / 0.8 / 2.4 s，单次 10 s；只重试**过渡态**），再发语句。
- `POST /query` **永不重试**（响应丢失时无法判断语句是否已执行，重试可能重复写），单次超时 60 s。
- 实测支撑的取舍：suspend 唤醒根本不需要重试（首请求即 200）；stop 态重试无意义（访问不启动机器）；启动中需 17 秒，超过 3.2 s 预算——文案引导用户重试，而不是让每个请求挂到超时。

### 2.5 连接态与唤醒口径

- **测试连接（管理员一次性）** = `/health` + `select 1`。两步缺一不可：实测 `/health` 不校验应用令牌；服务事故期还出现过「health 正常但查询全失败」。
- **查询路径** = `/health`（证明可达 + 平台令牌）→ 单条语句（证明应用令牌与执行能力）。
- 遗留风险：`/health` 不探会话，JVM 失联时仍返回 200。建议 SPEC v2.5 请服务侧在 `/health` 带上会话存活信息；在此之前执行器只能在语句失败时暴露该故障。

### 2.6 四句 not_ready / auth 文案（项 5 定稿）

1. **机器已停止**（503 + `Sandbox offline: it is stopped`，全员可见、不重试）：
   「Spark 机器已停止运行，需要管理员在 Instabox 启动后才能查询。」
2. **启动中 / 暂时不可达**（502 或 503 其他文案，重试后仍失败）：
   「Spark 机器正在启动或暂时不可达，请稍后重试。」
3. **应用令牌被拒**（服务层 401 + JSON）：
   「Spark 应用令牌被拒，请管理员检查登记信息。」
4. **发布地址令牌被拒**（代理层 401 + 纯文本）：
   「发布地址的访问令牌被拒，请管理员重新发布并更新登记信息。」

### 2.7 密钥与载荷

- 载荷 `{url, platform_token, app_token}` 经既有 `sealSecret()`（AES-GCM，`ENCRYPTION_KEY`）密封存入 `connection_payload`；**无需数据库迁移**（`schema_v2` 的通用密封 JSON 列，`kind` 无 CHECK 约束）。
- 载荷永不出现在 API 响应里；编辑需重填（与 PG/MySQL 一致）。
- 错误文案对 url 与两把令牌全部 `[redacted]`；令牌只走请求头，**不进 URL**（代理支持 `?_token=`，执行器会拒绝/剔除 URL 内嵌令牌，避免进日志与历史）。
- 团队 Secret SPARK_ACCESS 仅本次 spike 实测使用，不是产品运行时凭据。

### 2.8 限额与存储对齐

路由 `MAX_RESULT_ROWS = 5000` 与服务硬上限相等 → 直接传 `maxRows=5000`，以服务端 `truncated` 为准；**不对 Spark 用 `limitReadSql` 包裹**（封顶在服务端，重复包裹无收益，还可能干扰 Spark 解析）。单次运行结果落盘上限 512 KB、错误 2000 字符，均为既有逻辑。

### 2.9 实施单可直接照做的落地清单

**worker**

1. `worker/src/lib/sql-guard.ts`：`SqlDialect` 加 `'spark'`，按 §3 落地；
2. `worker/src/types.ts`：`DatabaseKind` 加 `'spark'`（`web/src/types.ts` 早已有该值，是上版预留的死分支）；
3. `worker/src/lib/bindings.ts`：`QueryTarget` 加 `{kind:'spark'}`，`resolveQueryTarget` 与 pg/mysql 同支路（要求载荷存在）；
4. 新增 `worker/src/lib/spark-access.ts`：校验并规范化载荷（https、去尾斜杠、拒绝 URL 内嵌凭据与 `_token`、令牌非空且有长度上限）；
5. 新增 `worker/src/lib/spark-executor.ts`：`SparkQueryError` / `openSparkSession` / `testSparkConnection`，含 §2.3 分级、§2.4 重试、脱敏与错误裁剪；
6. `worker/src/routes/query.ts`：`readStoredConnection` 泛化为读整份载荷；`openExecutor` 加 spark 分支；`dialectOf` 返回 `'spark'`；`resolveExecError` 纳入 `SparkQueryError`；
7. `worker/src/routes/admin.ts`：`ConnectionKind` 加 `'spark'`；`verifyConnection` 分支；`test-connection` 与 create/patch 接收两把令牌；`binding_name` 前缀 `spark:`；
8. 测试：`sql-guard` 的 spark 用例（含 §3.2 的高危清单）、`spark-access.test.ts`、`spark-executor.test.ts`（fetch 打桩）、`routes/__tests__/query-spark.test.ts`（照 `query-mysql.test.ts` 的 mock 手法）、`admin-spark.test.ts`，以及 opt-in 的 `spark-live.test.ts`（读 `SPARK_ACCESS`，无则跳过）。

**web（极简口径）**

1. `web/src/pages/admin/Databases.tsx`：`isConnectionKind` 加 spark，引擎下拉加 SparkSQL 选项（`kindLabel` 与翻译键 `admin_db.kind_spark` 已存在）；
2. 选中 SparkSQL 时：URL 输入 + 两个密码型令牌输入，复用现有「显示/隐藏 + 测试通过才可保存」交互；不新开页面、不加新路由；
3. `web/src/lib/api.ts`：`testConnection` / `createDatabase` 带两把令牌；`web/src/lib/connection-string.ts` 的 `canSaveConnectionString` 要求「URL + 两令牌」整组测试通过；
4. 补中英文案（字段标签、占位、§2.6 的四句失败提示），视觉沿用现有表单语言。

---

## 3. sql-guard `spark` 方言安全基线

### 3.1 为什么必须独立方言

用真实 `classifySql` 跑 41 条 Spark 语句，三种现有方言共 63 格判定不符。最关键的：

| SQL | sqlite | postgres | mysql | Spark 应为 |
|---|---|---|---|---|
| `select transform(a,b) using 'bash -c id' from t` | **read** | **read** | **read** | forbidden（worker 上执行 shell） |
| `set spark.hadoop.fs.s3a.secret.key=x` | write | write | forbidden | forbidden（共享会话配置） |
| `reset` / `cache table t` / `add jar …` / `list jar` | write | write | write | forbidden |
| `create function f as 'com.evil.Payload'` | write | write | write | forbidden（把 JVM 类加载进集群） |
| `describe t` / `describe query …` | write | **write** | read | read |
| `select 1 [; drop table t ]` | **read**（`[` 吃掉分号） | **read** | multiple | multiple |
| `select 'a\'; drop table t'` | multiple | multiple | read | read（Spark 默认反斜杠转义） |

一句话：复用 postgres 方言 = 漏掉整类会话/集群级危险语句，还会把 shell 执行判成只读；复用 mysql 方言则字符串扫描对、关键字规则全错。

### 3.2 forbidden / destructive / read 清单

**forbidden（实施单必须带对应用例）**

| 语句形态 | 理由 / 依据 |
|---|---|
| `SELECT TRANSFORM(…) USING 'script'` | 在 worker 上执行脚本（3.5.3 语法 `USING script=stringLit`；内建函数不用 `using`） |
| `SET` / `RESET` / `USE` | 单个常驻 SparkSession + 全局锁 → 改写所有人的会话与目录 |
| `CACHE` / `UNCACHE` / `CLEAR CACHE` / `REFRESH` | 共享会话缓存被改写 |
| `ADD` / `LIST`（jar / file / archive） | 向集群载入或列举资源 |
| `CREATE [OR REPLACE] [TEMPORARY] FUNCTION` | 任意 JVM 代码 |
| `CREATE [GLOBAL] TEMPORARY VIEW` | 临时视图落在共享会话命名空间 |
| `CALL` | Spark 4.x 预留（3.5 无此语句，提前堵死） |
| `LOAD DATA` | 服务端文件读取（既有 `FILE_STATEMENTS` 规则） |
| `INSERT OVERWRITE DIRECTORY` | 写集群文件系统 |
| ``parquet.`/path` `` / `csv` / `json` / `orc` / `text` / `avro` / `binaryFile` / `delta` / `file` + 引号路径 | 读集群文件系统（3.5.3 文档 File 源） |

**destructive**：`INSERT OVERWRITE`（非 directory 形态，覆盖既有数据）、`CREATE OR REPLACE TABLE`（原地替换表与数据）、`DROP` / `TRUNCATE` / `ALTER … DROP`。

**read**：`SELECT` / `VALUES` / `WITH` / `SHOW …` / `DESCRIBE|DESC`（含 `DESCRIBE QUERY`）/ `EXPLAIN`（`EXPLAIN ANALYZE` 仍按内层语句判；3.5 无此语法，天然安全）。

### 3.3 扫描层三条

1. `'…'` / `"…"` 内按**反斜杠转义**处理（依据：3.5.3 `SQLConf.escapedStringLiterals` 自 Spark 2.0 默认 `false`）。
2. `[` **不再当标识符引用**（Spark 无此语法；否则会像实测那样把 `;` 藏起来）。
3. `#` 行注释与 `/*! */` 可执行注释**不启用**（那是 MySQL 语法）；`$$…$$` 与 `E'…'` 也不启用（那是 PG 语法）。

### 3.4 原型验证数字

- 拟议规则对 **58 条** Spark 语句（覆盖上述每一类 + 正常读写）判定 **0 不符**。
- **差分回归**：从既有测试抽取 **416 条** SQL 字符串，对 sqlite/postgres/mysql 逐条比对「原实现 vs 打过补丁的实现」→ **差异 0**。
- 基线：`cd worker && ./node_modules/.bin/vitest run` → **40 文件 / 588 用例全绿**。

---

## 4. 相对 SPEC v2.3 的补充建议（拟进 v2.5）

1. **代理层 401 形态**：平台令牌错误返回 `text/plain` 的 `This URL is private…`，与服务层 JSON `{"error":"unauthorized"}` 不同；规格目前只写了服务层。
2. **请求级 400 两形态**：空 SQL / 多语句返回 `400 {"error":"empty sql"}`、`{"error":"single statement only"}`（SQL 执行失败仍是 `200 + error`）。
3. **stop 态 503 两形态 + 启动中 502 一形态**，以及「访问不会启动已停止的机器」；停机态下**错应用令牌也返回 503**（代理先判机器状态），故 auth 判定只在运行态成立。
4. **`/health` 不探会话**：建议服务侧补会话存活信息（本次 JVM 失联事故的盲点），否则只有「`/health` + `select 1`」双步能在管理员侧兜住。

---

## 5. 依赖纪律说明

- **不新增任何 npm 依赖**：HTTP 用平台 `fetch`，超时用 `AbortSignal.timeout`，加密复用既有 `sealSecret`。
- 自研范围仅限一层薄 fetch 客户端：Workers 上无法使用 Spark Connect（gRPC）或 Spark Thrift JDBC 这类驱动，服务侧 HTTP JSON 契约本身即接口——除这一层外无任何等价依赖可表达该行为。

---

## 6. 未决事项与可选优化

- 「切换数据库」下拉语义（用户与 Muse 定版中）：不影响本结论；`USE` 已被方言禁用，跨库请用限定名，实施单按最终规格调整文案。
- **无取消接口**：结果区的 X 只断开 HTTP，Spark 作业继续跑并占全局锁（会拖慢所有人）。建议本期接受并加一句提示，不新增接口。
- 启动中自动等待（把 `/health` 重试预算提到约 20 s）与「JVM 失联」专项提示：可选优化，非本期必需。

---

## 7. 复现方式（不含密钥）

- 实测脚本从环境变量 `SPARK_ACCESS`（团队 Secret，JSON：`{url, platform_token, app_token}`）读取凭据，**只打 `/health` 与 `/query` 的只读语句**（`select 1`、`show tables`、`select * from t_demo`、`select id from range(n)`），输出经脱敏后打印。
- 项 6 复核：`curl -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=<旧主机名>&type=A'` 与 `https://dns.google/resolve?name=<旧主机名>&type=A` 均返回 `Status: 3`（NXDOMAIN）。
- sql-guard 原型：把 `worker/src/lib/sql-guard.ts` 复制到临时目录加 `'spark'` 方言后，与仓库实现做差分（见 §3.4 数字）。

---

## 8. 边界声明

本轮未改动任何产品代码（本文档为唯一新增文件）、无数据库迁移、无部署、无任何线上数据写；机器状态（suspend / stop / start）全部由 Muse 侧执行，团队未触碰 Instabox。

---

## 9. 下一步

- **Muse**：按 SPEC v2.5 核对本结论（重点 §4 的四处补充是否入规格），据此拆三期实施计划（后端执行器 / 前端连接态两张单）。
- **Daniel**：在实施单中落地 `spark-access.ts` + `spark-executor.ts` + `spark` 方言（含 §3.2 的高危用例），自测对齐本轮数字（1000 行 / 5000 行截断、四句文案、两层 401、503 停机不重试）。
