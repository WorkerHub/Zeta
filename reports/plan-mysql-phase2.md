# Zeta 二期 MySQL（路线 A · TiDB Cloud Starter）：实施计划与接口契约（冻结稿）

状态：**计划正文，待确认关口**（按既定委托由 Muse 在本话题代拍）。本文件只出计划：不实施、不写生产、不改源码、不影响线上资源；随本人分支提交，不合并 main。
日期：2026-11-13（北京时间）
依据：SPEC v2.2（本单 spec）＋ spike 报告 `reports/spike-mysql-phase2.md`（#8）。

---

## 0. 一句话

二期 MySQL 用 TiDB 官方 HTTP 驱动 `@tidbcloud/serverless` 在 Worker 内以 `fetch` 调用 TiDB Cloud Starter 的 HTTPS 端点，作为第三个 `kind` 接进一期的既有骨架；登记形态、行数上限、错误分级、JSON 安全出口与一期同构，**无数据库迁移**，只新增两个 lib 文件与按 `kind` 的分支。

---

## 1. 范围与非目标

**范围**
1. 新增 `kind: 'mysql'`，语义**收敛为 TiDB Cloud Starter（MySQL 兼容）专用**，登记时粘贴 `mysql://<用户名>:<密码>@<host>:4000/<db>`。
2. 新增连接串归一化与执行器两个 lib，接进 `resolveQueryTarget()` / `openExecutor()` / 现有错误分级。
3. 扩展 `sql-guard` 的 MySQL 方言分类（read/write/destructive/forbidden）与行数上限适配。
4. 管理面板：引擎下拉加 MySQL、连接串表单、试连接口接受 `kind`、文案明确"仅 TiDB Cloud Starter"。
5. 测试：单测、路由测、SQL 方言测，以及一个由 `TIDB_URL` 门控的实连测试。

**非目标（本期明确不做）**
- 普通 MySQL / MariaDB / Aiven / PlanetScale 等非 TiDB Cloud 目标：**登记层直接拒绝**，文案不得暗示可连。
- 不做 MySQL 线协议直连（mysql2）、不自写 STARTTLS 适配、不经 Hyperdrive（SPEC v2.2）。
- 不做连接池、不做长连接缓存、不启用驱动的 stateful/tx 模式。
- 不做新迁移（见 §3.1）、不改既有 sqlite/postgres 行为。
- 不做部署（合并后由既定流程处理），不调用生产数据。

---

## 2. 平台前提（已实测，spike 结论沿用）

| 项 | 结论 |
| --- | --- |
| 证书链 | `*.us-east-1.prod.aws.tidbcloud.com` ← Let's Encrypt `YE2` ← `ISRG Root YE` ← `ISRG Root X2`，`Verify return code: 0`；公共 CA 前提成立 |
| HTTP 端点 | `https://http-<gateway 主机>/v1beta/sql`；us-east-1 / us-west-2 / ap-southeast-1 / ap-northeast-1 四个区实测可达（假凭证返回 `401` + `Error 1105 (HY000): Access denied…`） |
| 免费档 | 每组织最多 5 个 MySQL 兼容实例；每个 5 GiB 行存 + 5 GiB 列存 + 5000 万 RU/月；400 并发连接；AWS 公网入口空闲 340 秒断开 |
| 驱动 | `@tidbcloud/serverless@0.3.0`，**零依赖**，Worker 内可用（实测到鉴权层），`fetch` 可注入 |

---

## 3. 冻结契约

### 3.1 `kind` 与登记语义

| 项 | 决定 |
| --- | --- |
| 类型 | `worker/src/types.ts`：`DatabaseKind = 'sqlite' \| 'postgres' \| 'mysql'`；前端 `web/src/types.ts` 的 `DbKind` **已含** `'mysql'`，不改 |
| 语义 | `kind: 'mysql'` = **仅 TiDB Cloud Starter**。普通 MySQL 不是"未支持"，而是"不是本 kind 的对象" |
| 落实手段 | 归一化阶段拒绝 host 不属于 `tidbcloud.com` 的串（§3.2），错误文案明说"本期仅支持 TiDB Cloud Starter" |
| 登记列 | `binding_name = my:<id>`（与 `cf:`/`pg:` 并列，UNIQUE 不受影响）；`cf_database_id = NULL` |
| 连接载荷 | 沿用一期 `sealSecret(JSON.stringify({ url }))`，存 `d1_databases.connection_secret`；任何 API、日志、审计不回显串原文 |
| 迁移 | **无**。`kind` 自 `schema_v2` 起是 `TEXT NOT NULL DEFAULT 'sqlite'`，无 CHECK 约束；`connection_secret` 已存在。不新增 `schema_v3` |
| 应用库护栏 | 不适用：`cf_database_id` 恒为 NULL → `isAppDb()` 恒假 |
| 分发 | `resolveQueryTarget()`：`kind === 'mysql'` → 要求 `connection_secret` 存在，否则返回 config 错误（"重新保存连接"指引，与 pg 同构） |

### 3.2 连接串归一化：`worker/src/lib/mysql-url.ts`（新增）

照 `pg-url.ts` 的形状与约束，逐条冻结：

| 项 | 规则 |
| --- | --- |
| 协议白名单 | `mysql:` 与 `mysql2:`，其它一律拒绝 |
| 长度 | ≤ 4096 字符 |
| 必填 | `username`、口令、host |
| host 白名单 | hostname 必须以 `.tidbcloud.com` 结尾（只认公共同信根、只认 TiDB Cloud Starter）；`localhost`/IP/其它域名 → 拒绝，文案指向"仅 TiDB Cloud Starter" |
| 端口 | 驱动只取 hostname，端口不参与 HTTP 调用；为文案一致仍接受 `:4000`，缺省补 `:4000` |
| 数据库 | 路径为空 → 补默认库 `test`（SPEC v2.2 口径）；规范化后的串携带该库名 |
| query 参数 | **全部剥离**（HTTP 驱动不读；`ssl-ca`/`ssl-mode`/`ssl` 一类旋钮在 Worker 上无意义，留着只会误导）；`charset` 也剥——端点自定编码 |
| 百分号编码 | 口令含 `@` `:` `/` `#` 等未编码字符时 URL 解析会错位：捕获后返回可操作提示（"密码含特殊字符时请做百分号编码"），不回显原文 |
| 输出 | `{ ok: true, url, host, database }`；`url` 是规范化后的串（`mysql://`、无参数、含库名、含 `:4000`），这是唯一被加密保存与喂给驱动的形态 |
| 错误 | `{ ok: false, error }`，文案不含输入的串或凭证（与 `normalizePostgresUrl` 一致） |

### 3.3 执行器：`worker/src/lib/mysql-executor.ts`（新增）

照 `pg-executor.ts` 的形状与归因方式，逐条冻结：

| 项 | 决定 |
| --- | --- |
| 导出 | `MySqlErrorKind = 'sql' \| 'auth' \| 'config' \| 'transport'`；`MySqlQueryError`；`MySqlExecuted = { results, meta, changes?, truncated }`；`MySqlSession { run(sql, kind, maxRows), close() }`；`openMySqlSession(url)`；`testMySqlConnection(url)`；`describeMySqlError(err, url, connect)` |
| 加载方式 | 动态 `await import('@tidbcloud/serverless')`——D1 路径（绝大多数请求）不付加载成本，与 `pg-executor.ts` 一致 |
| 连接生命周期 | 每请求一个驱动 `connect({ url, fetch: timedFetch })`；批内语句**顺序复用同一 Connection 实例**；`close()` 保持接口形状（HTTP 无连接可关，不启用 `persist()`/`begin()`，即无会话状态） |
| 建连证明 | `openMySqlSession` 先跑 `select 1`，让主机名/凭证/网络错误在**每请求一次**暴露，而不是每条语句各暴露一次 |
| 读 | `limitReadSql(sql, maxRows, 'mysql') ?? sql` → `execute(sql, null, { fullResult: true })`；行数 > maxRows 则切片并置 `truncated: true` |
| 写 | 直接执行，`changes = rowsAffected ?? 0`，`results: []`（沿用一期"写不返回结果表"的契约） |
| 出口序列化 | `toJsonSafeRows()`（一期已有；`Uint8Array` → base64，无需改动） |
| 超时 | 用驱动的 `fetch` 注入点包一层 `AbortSignal.timeout(30_000)`——用依赖原生接口实现，不自研 |
| 脱敏 | 错误消息命中连接串（或其中的 host/用户名/口令）时替换为 `[redacted]`，与 `pg-executor.ts` 的 `redact()` 同构 |
| 试连 | `testMySqlConnection(url)`：`select version()` → `{ server_version }`，供登记前置校验与 "test connection" 按钮复用 |

### 3.4 API 契约

| 端点 | 契约 |
| --- | --- |
| `POST /api/admin/databases` | 请求 `{ kind: 'mysql', connection_url, name?, description? }`；**先试连再落库**（失败不落行）；成功 `201 { id }`；审计 `create_database`；`name` 缺省取归一化得到的库名 |
| `POST /api/admin/databases/test-connection` | 请求 `{ connection_url, kind? }`；**`kind` 缺省 `postgres`**（兼容现有前端）；响应 `{ ok: true, kind, server_version, latency_ms }`（`server_version` 形如 `8.0.11-TiDB-v8.5.3`） |
| `POST /api/query` | 形状不变：读 `{ results, meta, truncated, duration_ms, …run }`；写 `{ meta: { changes }, results: [], duration_ms }`；`MAX_RESULT_ROWS = 5000`、`MAX_SQL_LENGTH = 100000` |
| `POST /api/query/batch` | 形状不变：≤100 条语句，逐条顺序执行、单条失败不中断；同一驱动连接复用 |
| `GET /api/databases`、权限、历史、记事本、运行记录 | 完全沿用（`kind` 原样透出；前端已能显示 MySQL 标签） |

### 3.5 错误分类（路线 A 版，替换 spike 里基于线协议的 ER_* 表）

| 现象 | `kind` | 对外 |
| --- | --- | --- |
| `DatabaseError.status` 401 / 403 | `auth` | 500（管理员看细节，成员看通用文案） |
| `status` 400 且消息形如 `Error <errno> (<sqlstate>): …` | `sql` | **400，所有人可见** |
| `status` 400 其它（缺库名、参数不合法） | `config` | 500 |
| `status` 429 | `transport`（文案提示可能是配额/限流） | 500 |
| `status` 5xx | `transport` | 500 |
| `fetch` 抛出（DNS/TLS/网络/`AbortSignal` 超时） | `transport` | 500 |
| 凭证含非 Latin-1 字符导致 `btoa` 失败 | `config` | 500 |
| 驱动抛 `empty session, please try again` | `transport`（可重试） | 500 |
| `Error 1105 (HY000)`（已连上之后） | 暂定 `sql`，**标注待实连复核**（§10-6） | 400 |

日志策略沿用一期：`auth`/`config`/`transport` 的细节只给管理员，普通成员拿通用文案，原始细节 `console.error`。

### 3.6 类型映射（与驱动默认解码一致，无需 custom decoder）

| MySQL 类型 | 出口形态 | 说明 |
| --- | --- | --- |
| `INT` / `TINYINT` / `SMALLINT` / `MEDIUMINT` / `YEAR` | number | 驱动默认 `parseInt` |
| `FLOAT` / `DOUBLE` | number | 驱动默认 `parseFloat`；非有限值转字符串（一期 `toJsonSafe`） |
| `BIGINT` / `UNSIGNED BIGINT` | **字符串** | 驱动默认原样返回字符串，精度不丢 |
| `DECIMAL` / `NUMERIC` | **字符串** | 同上 |
| `DATE` / `DATETIME` / `TIMESTAMP` / `TIME` | **字符串原样** | 无人为时区转换；与一期 PG 的 ISO 8601 **不同**，属已知差异，需在交付说明写明 |
| `CHAR` / `VARCHAR` / `TEXT` / `ENUM` / `SET` | 字符串 | — |
| `JSON` | 对象 | 驱动 `JSON.parse`；与一期 PG `jsonb` 一致 |
| `BLOB` / `TINYBLOB` / `MEDIUMBLOB` / `LONGBLOB` / `BINARY` / `VARBINARY` | base64 字符串 | 驱动给 `Uint8Array` → `toJsonSafe` 转 base64 |
| `BIT` | base64 字符串 | 与 BLOB 同形（不映射成 0/1），属已知瑕疵，实连复核（§10-3） |
| `BOOLEAN`（= `TINYINT(1)`） | number（0/1） | 与一期 PG 的 true/false 不同，需在交付说明写明 |
| `NULL` | `null` | — |

### 3.7 `sql-guard` 的 MySQL 方言表（本期实现，`SqlDialect` 增加 `'mysql'`）

**扫描器必须先补的三处**（都属"我们当注释、服务器当 SQL"的危险方向）：

1. `/*! … */` 可执行注释 → MySQL 方言下整条 `forbidden`（`/*+` 优化器提示仍可丢）；
2. `#` 行注释 → 按 MySQL 规则忽略到行尾；
3. 字符串反斜杠转义（`\'`、`\"`）→ 按 MySQL 默认 `sql_mode` 识别，避免"引号里的 `;`"被当成语句分隔符。

**分类表**

| 分类 | 语句 |
| --- | --- |
| `read` | `SELECT`（无 `INTO OUTFILE/DUMPFILE`）、`SHOW`（`TABLES/CREATE/INDEX/VARIABLES/COLUMNS` 等）、`DESCRIBE`/`DESC`、可包裹的 `EXPLAIN`（`EXPLAIN ANALYZE` 递归判内层，同一期）、`WITH … SELECT` |
| `write` | `INSERT`/`UPDATE`/`DELETE`/`REPLACE`、`CREATE`/`ALTER`（`ALTER … DROP` 仍判 `destructive`）、`ANALYZE`/`OPTIMIZE`/`REPAIR`、`RENAME`、`CALL` |
| `destructive` | `DROP`、`TRUNCATE`（沿用一期） |
| `forbidden` | `LOAD DATA … [LOCAL] INFILE`、`SELECT … INTO OUTFILE/DUMPFILE`、`LOCK/UNLOCK TABLES`、`PREPARE`/`EXECUTE`/`DEALLOCATE`、`GRANT`/`REVOKE`/`CREATE USER`/`FLUSH`/`KILL`/`SHUTDOWN`、`START TRANSACTION`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`、`USE`、`SET`、`SHOW PROCESSLIST`/`SHOW GRANTS`、`HANDLER`、`/*! … */` |

`USE`/`SET` 归 forbidden 的理由：路线 A 是**无状态 HTTP 调用**，语句之间没有会话延续，`USE`/`SET @x` 不会对后续语句生效——允许它等于让用户以为状态生效了。计划确认时若要求保留，则必须同时给出"按语句注解"的替代方案。

**行数上限适配**：`limitReadSql()` 在 mysql 方言下派生表必须带别名（`… ) AS zeta_limit LIMIT 5001`）；`SELECT … FOR UPDATE` / `LOCK IN SHARE MODE` 不能进子查询 → 不包裹、事后截断（同 PG 做法）。

**多语句**：客户端一律拒绝（`multiple`），不依赖端点行为。

### 3.8 前端条目与文案

| 项 | 决定 |
| --- | --- |
| 引擎下拉 | 加 `<option value="mysql">MySQL</option>`（`admin_db.kind_mysql` 中英文标签已有） |
| 表单 | 复用现有连接串块（`web/src/components/PostgresConnectionFields.tsx`）：组件泛化为按 `kind` 取文案的 `ConnectionStringFields`，纯展示不变；`canSavePostgres()` 改名/改造为按 kind 的 `canSaveConnectionString()` |
| API | `web/src/lib/api.ts` 的 `testConnection` 增加可选 `kind`（向后兼容） |
| 文案（en + zh） | 新增 `admin_db.register_title_mysql`、`register_desc_mysql`、`connection_url_placeholder_mysql`（`mysql://user:xxxx@gateway01.<region>.prod.aws.tidbcloud.com:4000/test`）、`connection_url_hint_mysql`——**必须明说"仅支持 TiDB Cloud Starter（TiDB Cloud 免费实例），不支持普通 MySQL/MariaDB"**；`describeTestResult` 直接复用 |
| 已有行 | `kindLabel()` 已覆盖 mysql，无需改动 |

---

## 4. 接入点清单（文件级）

| 文件 | 改动 | 依据 |
| --- | --- | --- |
| `worker/package.json` + `pnpm-lock.yaml` | 新增依赖 `@tidbcloud/serverless`，**精确锁 `0.3.0`**（与 `postgres: 4.1.1` 同风格；0.x 不许浮动） | 依赖纪律：用官方驱动，不自研 |
| `worker/src/lib/mysql-url.ts`（新增） | 归一化（§3.2） | spike §6 |
| `worker/src/lib/mysql-executor.ts`（新增） | 执行器（§3.3） | spike §6 |
| `worker/src/types.ts` | `DatabaseKind` 加 `'mysql'` | §3.1 |
| `worker/src/lib/bindings.ts` | `QueryTarget` 加 `{ kind: 'mysql'; databaseId }`，`resolveQueryTarget()` 加分支 | §3.1 |
| `worker/src/lib/sql-guard.ts` | `SqlDialect` 加 `'mysql'`；扫描器三处补丁；`classifyStatement` 加 mysql 分支；`limitReadSql` 别名/锁定读 | §3.7 |
| `worker/src/routes/query.ts` | `dialectOf()` 加 mysql；`openExecutor()` 加分支；`resolveExecError()` 加 `MySqlQueryError`；`translate()` 保持 sqlite-only | §3.4 |
| `worker/src/routes/admin.ts` | `kind` 校验加 `'mysql'`；`verifyPostgresConnection()` 泛化为 `verifyConnection(kind, url)`；`POST /databases` 加 mysql 分支（`my:<id>`）；`test-connection` 接受 `kind`（缺省 postgres） | §3.4 |
| `worker/src/lib/migrations.ts` | **不改** | §3.1 |
| `web/src/pages/admin/Databases.tsx`、`web/src/components/PostgresConnectionFields.tsx`、`web/src/lib/pg-connection.ts`、`web/src/lib/api.ts`、`web/src/lib/translations.ts` | §3.8 | §3.8 |
| `CLAUDE.md` | Key Files 增两行（mysql-url / mysql-executor），一句说明 kind 三态 | 项目文档，随代码维护 |

---

## 5. 实施步骤（每步可独立提交、独立评审）

| 步 | 内容 | 产物 |
| --- | --- | --- |
| S1 | 依赖 + `mysql-url.ts` + 其单测 | 归一化通过全部用例；`pnpm-lock.yaml` 更新 |
| S2 | `mysql-executor.ts` + 单测（mock 驱动） | 读/写/截断/错误分类/超时/脱敏全部覆盖 |
| S3 | `sql-guard.ts` 方言扩展 + 方言用例集 | 新用例全绿，sqlite/postgres 用例无回归 |
| S4 | 路由接线（bindings / query / admin / types） | `query-mysql.test.ts`、`admin-mysql.test.ts` 通过 |
| S5 | 前端（下拉、表单泛化、文案、api） | 手测：登记 → 试连 → 保存 → 查询 → 历史/记事本正常 |
| S6 | 实连测试（`TIDB_URL` 门控）+ 交付证据汇总 | §10 复核结果表 |

---

## 6. 验收标准（逐项可验证）

1. **只认 TiDB Cloud**：粘贴非 `.tidbcloud.com` 主机的 `mysql://` 串 → 400，文案指向"仅 TiDB Cloud Starter"，且**不落库**。
2. **归一化**：协议白名单、长度上限 4096、缺 user/口令/host 拒绝、query 参数被剥离、空库补 `test`、`%` 编码提示；任何错误文案不含原串。
3. **试连兼容**：`test-connection` 不带 `kind` 时行为与今天完全一致（postgres）；带 `kind: 'mysql'` 时返回 `{ok,kind,server_version,latency_ms}`。
4. **登记**：先试连成功才 `201 {id}`；`binding_name` 为 `my:<id>`；`connection_secret` 为 `enc:v1:` 载荷；`GET /admin/databases` 响应里没有任何串原文。
5. **查询契约**：读 ≤5000 行且超限 `truncated: true`；写返回 `meta.changes` 且 `results: []`；`duration_ms`、历史、记事本运行号、批量形状与一期一致。
6. **错误分级**：sql → 400 所有人可见；auth/config/transport → 500，管理员见细节（已脱敏）、成员见通用文案。
7. **方言**：§3.7 表逐条有对应用例；`/*!` 可执行注释被拒；`#` 注释与反斜杠转义按 MySQL 规则解析；`FOR UPDATE` 不被包裹。
8. **无迁移**：存量部署直接跑 `POST /api/setup`（无新迁移）即可登记 mysql；既有 sqlite/postgres 目标行为零变化。
9. **前端**：下拉有 MySQL；未通过试连不能保存；文案明说"仅 TiDB Cloud Starter"；已有 mysql/spark 标签逻辑不受影响。
10. **CI**：`pnpm lint`、`pnpm format:check`、`pnpm build:web`、`cd worker && pnpm type-check`、`cd worker && pnpm test`、`cd web && pnpm test` 全绿；`pnpm install --frozen-lockfile` 可复现。

---

## 7. 自测与证据计划

| 测试文件 | 覆盖 | 证据形态 |
| --- | --- | --- |
| `worker/src/lib/__tests__/mysql-url.test.ts` | §3.2 每条规则（对标 `pg-url.test.ts` 用例集） | 用例数 + 通过数 |
| `worker/src/lib/__tests__/mysql-executor.test.ts` | `vi.mock('@tidbcloud/serverless')`：读写映射、截断、错误分类、超时注入、脱敏、`select 1` 建连证明、批内连接复用 | 同上 |
| `worker/src/lib/__tests__/sql-guard.test.ts`（增补） | §3.7 每条分类 + 三处扫描器补丁 + `limitReadSql` 别名 | 新增用例数，既有用例零改动 |
| `worker/src/routes/__tests__/query-mysql.test.ts` | 对标 `query-pg.test.ts`：dialect、权限、`Executed` 映射、错误码、batch 复用与关闭 | 同上 |
| `worker/src/routes/__tests__/admin-mysql.test.ts` | 登记/试连/非 TiDB 主机拒绝/串不落明文/审计 | 同上 |
| `worker/src/lib/__tests__/mysql-live.test.ts` | `describe.skipIf(!process.env.TIDB_URL)`；自建表、读写、类型、truncated、错误码 | 实连时执行并贴结果 |

交付汇报须含：改动文件与核心改动、无迁移的说明（含回滚方式）、上述命令与实际结果摘要（测试数 / 通过数 / 失败数）、未跑成的项及原因、§10 复核结论（若已就绪）。

---

## 8. 开放项裁决（本计划给出决定，供关口确认）

| 开放项 | 决定 | 理由 |
| --- | --- | --- |
| `meta` 是否带 `insert_id` | **不带** | 驱动 0.3.0 读取的是 `resp.sLastInsertID`（字段名与文档不符），实连前无法确认为真，契约不依赖未验证字段；一期契约只有 `changes`，前端也只读 `meta.changes`。若实连确认可用，作为后续增量单加，不改本契约 |
| `1105` 错误分级 | 暂定"已连上后 → sql(400)"，**实连复核后定稿** | spike 已记录 1105 同时承载凭证错误与语句错误；复核清单见 §10-6 |
| `BIT` 映射 | 保持 base64（与 BLOB 同形） | 不自定义 decoder，避免手搓；文档写明 |
| 429 归类 | `transport`（500） | 一期没有 rate-limit 分类，新增会扩散契约；文案提示"可能是配额或限流" |
| `USE` / `SET` | `forbidden` | 无状态 HTTP，语句间无会话延续，允许即误导 |
| `SHOW PROCESSLIST` / `SHOW GRANTS` | `forbidden` | 会把同库其它会话的 SQL / 授权信息暴露给普通成员 |

---

## 9. 风险与回滚

| 风险 | 说明与缓解 |
| --- | --- |
| 驱动是 0.3.0（0.x） | 精确锁版本；执行器只依赖 `connect/execute` 与 `fullResult` 三个面；升级需重跑 `mysql-executor` 单测与实连测试 |
| HTTP 端点主机名约定 | 驱动拼 `https://http-<host>`，四个 AWS 区实测可达；若日后端点更名，表现为 `transport` 失败，文案引导到"检查实例区域/端点" |
| BLOB 十六进制前缀 | 驱动 `hexToUint8Array()` 未显式剥 `0x` 前缀，可能多出一个 0 字节；**实连复核项**（§10-3），若确认有问题，用驱动暴露的 `decoders` 覆盖 BLOB ——仍属依赖原生接口，不自研 |
| 单行过大 | 5000 行上限不含字节数；BLOB/TEXT 巨行仍可能撑大响应。缓解：沿用一期运行记录 512 KB 截断；必要时后续单独给行级字节上限 |
| 子请求数 | 批 ≤100 语句 = ≤100 次 `fetch`，在 Workers 子请求上限内 |
| RU 消耗 | 免费档 5000 万 RU/月；`LIMIT 5001` 在服务端生效，可减少传输与 RU |
| 回滚 | 改动集中在新增文件 + 按 `kind` 的分支，整体 revert 即回到一期状态；回滚后已登记的 `kind='mysql'` 行会落到"未支持的 kind"分支 → 管理员可在面板停用（`is_active=0`）止血，或重新保存为其它 kind |

---

## 10. `TIDB_URL` 到位后的实连复核清单（Daniel 执行，之后才进实施）

1. 用真实串跑 `normalizeMySqlUrl`，确认归一化结果与日志均不含串原文。
2. `testMySqlConnection` → `server_version` 形如 `8.0.11-TiDB-v8.5.3`。
3. 建表 + 插入 + 查询，核对类型：`DECIMAL`/`BIGINT` 字符串、`DATETIME` 原样、`BLOB` base64（**核对是否多出 1 个 0 字节**）、`JSON` 对象、`BIT` base64。
4. 行数上限：构造 >5000 行结果 → 切片 + `truncated: true`。
5. 认证/配置/传输三类：错凭证（auth）、错库名（config）、不可达 host（transport）各一例，确认 HTTP 码与文案。
6. **1105 复核**：分别制造语法错误、缺表、权限不足，记录 `status / details.code / message` 三元组，定稿 §3.5 的 1105 行。
7. 会话语义：`SET @x=1` 后 `SELECT @x` 的表现（预期无会话），确认 `USE`/`SET` 归 forbidden 的判断。
8. 批量：5 条语句的批次只发 5 次 `fetch`，无连接池、无长连接。
9. 把上述结果补进 spike 报告与交付汇报；未完成项写明原因。

---

## 11. 下一步与署名

**下一步：Muse（本话题代拍）在确认关口裁定本计划**：确认 → 进入 S1–S6 实施（Daniel）；要求修改 → 我按裁定改本文件后再次递关口。若 `TIDB_URL` 先就绪，先做 §10 复核再动 S1，避免契约与实测相左。

---

## 附录 A：驱动事实（`@tidbcloud/serverless@0.3.0` 源码核对，契约依赖项）

| 事实 | 细节 |
| --- | --- |
| 端点 | `POST https://http-<config.host>/v1beta/sql`，`Content-Type: application/json` |
| 认证 | `Authorization: Basic base64(username + ':' + 口令)`；`TiDB-Database: <库名>` 头；`TiDB-Session` 头承载会话 |
| URL 解析 | `config.url` → `username` / 口令 / `host`（**仅 hostname，无端口**）/ `database`，均 `decodeURIComponent` |
| 执行 | `execute(sql, args=null, { fullResult: true })` → `{ statement, types, rows, rowsAffected, lastInsertId, rowCount }` |
| 会话要求 | 每次执行都要求响应头带 `TiDB-Session`，否则抛 `empty session, please try again` |
| 错误 | `DatabaseError { status, details: { code, message } }`；非 2xx 时 `message` 取自响应体 |
| 默认解码 | 见 §3.6；可被 `decoders` 覆盖（我们自己不用，除非 §10-3 的 BLOB 前缀问题被证实） |
| `fetch` 注入 | `config.fetch` 可替换 → 我们用它在不改驱动的前提下加超时 |
| 依赖 | 无运行时依赖 |
