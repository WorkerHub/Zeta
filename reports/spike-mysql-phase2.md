# Zeta 二期 MySQL spike：目标平台评估 · mysql2 直连可行性 · 接入点与契约草案

状态：**结论报告（调研单交付物，仅留在本分支，不合并 main）**
日期：2026-11-13（北京时间）
范围：只做调研与实测。未部署任何 Worker、未改动线上资源、未写库、未合并任何东西；工作树除本文件外零改动；全程未落盘任何密钥（探针一律用假用户名/假口令）。

结论一句话：**目标平台 TiDB Cloud Starter 免费档的公共 CA 前提成立；mysql2 在 Worker 内做 MySQL 直连不可行（结构性限制，不是版本或参数问题）；能走通的是厂商 HTTP 驱动或自写 STARTTLS 适配，二选一需要拍板。**

---

## 1. 结论

### 1.1 目标平台：TiDB Cloud Starter（原 Serverless）公共 CA 检验通过

实测证书链（`openssl s_client -starttls mysql -connect gateway01.us-east-1.prod.aws.tidbcloud.com:4000`）：

| 层级 | 证书 |
| --- | --- |
| 叶子 | `CN=*.us-east-1.prod.aws.tidbcloud.com`（Let's Encrypt 签发） |
| 中间 | `C=US, O=Let's Encrypt, CN=YE2` |
| 中间 | `C=US, O=ISRG, CN=Root YE` |
| 根 | `C=US, O=Internet Security Research Group, CN=ISRG Root X2` |

`Verify return code: 0 (ok)`。us-west-2、ap-northeast-1 三个区同构（Let's Encrypt `YE1`/`YE2`，同一 ISRG 根）；HTTP 端点 `http-gateway01…:443`（免费档的 `/v1beta/sql`）使用同一 CA 链。也就是说它落在一期确立的「公共同信根」前提内，不需要注入自定义 CA。

免费档（官方文档抓取）：每个组织最多 5 个 MySQL 兼容实例，每个 5 GiB 行存 + 5 GiB 列存 + 5000 万 RU/月，最多 400 并发连接；AWS 公网入口空闲 340 秒断开、连接最长 30 分钟；**强制 TLS**（明文连接被服务器拒绝）。服务端版本 `8.0.11-TiDB-v8.5.3`。官方现称 Starter 档（旧称 Serverless）。

### 1.2 mysql2（3.13 / 3.24 均实测）在 Worker 内直连：不可行

原因一句话：MySQL 的 TLS 是 STARTTLS 式的（服务端先发明文 greeting，客户端再就地升级 TLS），而 workerd 的 `node:tls` 不能接管一条已有的 `node:net` 连接。

必须说清楚的是：**mysql2 本身在 Worker 里是好的**——打包正常（1293 KiB / gzip 389 KiB），明文连接能跑完握手并拿到服务器返回的业务错误。唯一断点就是 TLS 升级这一步。所以这不是"换个版本、加个参数、塞个 CA"能解决的。

### 1.3 两条真正可走的路

| 路线 | 形态 | 代价 |
| --- | --- | --- |
| **A（推荐）** | TiDB 官方 HTTP 驱动 `@tidbcloud/serverless`，纯 `fetch`，已实测在 Worker 内跑通到鉴权层 | `kind` 含义变成"TiDB Cloud Starter 实例"，连不了普通 MySQL；错误粒度比线协议粗 |
| **B** | 自写 STARTTLS 适配（`cloudflare:sockets` 的 `secureTransport:'starttls'`，已实测握手成功）+ 覆盖 mysql2 的 `startTLS` | 改写依赖内部行为（"依赖优先"的边缘），mysql2 / workerd 每次升级都要重测 |
| C | 二期 MySQL 暂缓，等 workerd 支持 socket 升级 | 二期排期让位，三期 SparkSQL 不受影响 |

---

## 2. 红线与边界

- 只在本地 `wrangler dev`（本地模式）跑探针，**没有部署任何 Worker、没有改动线上资源、没有写库、没有合并**。
- 过程结论进单据与本文件，不改动任何源码。
- 全程未落盘任何密钥、连接串、token；探针用假用户名/假口令，错误信息里不含真实凭据。

---

## 3. mysql2 实测证据（Workers 运行时实跑）

环境：workerd `1.20261023.1`（与仓库现有 wrangler 4.156.0 同版本），`compatibility_date = 2026-10-01`，`compatibility_flags = ["nodejs_compat"]`。

| 探针 | 结果 |
| --- | --- |
| `node:net` 直连 4000 端口 | ✅ 读到 MySQL greeting，`protocol 10`，`8.0.11-TiDB-v8.5.3-serverless` |
| mysql2 3.24.6 明文连接 | ✅ 协议跑通，服务器拒绝：`1105 HY000 Connections using insecure transport are prohibited`（证明 mysql2 装配与握手在 Worker 内可用） |
| mysql2 3.24.6 + `ssl` | ❌ `ERR_OPTION_NOT_IMPLEMENTED: The options.checkServerIdentity option is not implemented` |
| mysql2 3.13.0 + `ssl` | ❌ 同样形态（源码对照：3.13 与 3.24 的 `startTLS` 传给 `tls.connect` 的选项集一致：`rejectUnauthorized`/`requestCert`/`checkServerIdentity`/`secureContext`/`socket`/`servername`/`isServer`） |
| `tls.connect({socket})` 读前升级 | ❌ `TypeError: This WritableStream writer has been released.` |
| `tls.connect({socket})` 读完 greeting 后升级 | ❌ `TypeError: Cannot call releaseLock() on a reader with outstanding read promises.` |
| 同上，先 `pause()` + 去监听 + 延迟 200ms | ❌ 同样 releaseLock 报错（不是时序问题，这条路堵死） |

workerd 内置实现（从 `workerd` 二进制内的 JS 源码读到）另有三条印证：

1. `TLSSocket` 对 `requestCert` 是硬抛 `ERR_OPTION_NOT_IMPLEMENTED`；
2. `rejectUnauthorized: false` 明确"未实现"（与一期「不能关闭校验」的结论一致）；
3. `checkServerIdentity` 在 `2026-10-01` 这个 compat date 下是抛错档（更早的 date 是静默忽略，但那只是把失败推迟一步）。

对照组的正面结果，说明"通路存在，只是不在 `node:tls` 上"：

| 探针 | 结果 |
| --- | --- |
| `cloudflare:sockets` + `secureTransport:'starttls'` + `startTls()` | ✅ 读 greeting（101 字节）→ 发 SSLRequest → 握手完成 → TLS 通道可读写 |
| `@tidbcloud/serverless` 0.3.0（官方 HTTP 驱动，零依赖） | ✅ Worker 内可用；假凭证返回 `DatabaseError`（HTTP 401，`details.code 49900002`，消息 `Error 1105 (HY000): Access denied…`） |
| `node:buffer` 的 `Buffer` | ✅ `instanceof Uint8Array` 为真，一期 `toJsonSafe()` 的 base64 出口无需改动 |

---

## 4. 候选平台评估

| 候选 | 公共 CA | 免费档 | 结论 |
| --- | --- | --- | --- |
| **TiDB Cloud Starter**（首选） | ✅ 实测通过（Let's Encrypt → ISRG Root X2） | ✅ 5 GiB / 5000 万 RU/月 / 每组织 5 实例 | **推荐**：TLS 与 HTTP 两个端点都实测可达 |
| Aiven MySQL | ❌ 项目 CA | — | 按规格预防式排除（一期定论，本次未实测） |
| PlanetScale | ✅ 实测通过（同一 ISRG 根） | ❌ 无免费档 | 备选，非本期 |
| 其它（SingleStore / HeatWave 等） | 未实测 | 需注册实例才能验证书 | 本期不铺开：首选已通过，不必再加变量 |

---

## 5. 两条可选路线的细节

### 路线 A：TiDB 官方 HTTP 驱动 `@tidbcloud/serverless`（推荐）

- 不碰 socket、不碰 TLS 升级，纯 `fetch`（已实测到鉴权层）；零依赖；连接串形状仍是 `mysql://user:password@host:4000/db`，与一期 PG 一致。
- `execute` 直接返回 `rows / rowCount / rowsAffected / lastInsertId / types`，正好填一期的 `Executed` 契约（`changes` ← `rowsAffected`）。
- 支持参数化执行、事务（实验性）、stateful 连接（实验性）。
- 端点由驱动自行拼出：`https://http-<gateway 主机>/v1beta/sql`，Basic Auth + `TiDB-Database` 头。
- 代价：`kind` 的含义变成"TiDB Cloud Starter 实例"，连不了普通 MySQL。**默认假设**：仍叫 `kind: 'mysql'`，UI 标注 TiDB Cloud Starter，另加传输字段区分（待确认）。
- 错误粒度：只有 HTTP 状态 + `details.code`（TiDB 的 499xxxxx），MySQL errno 需从消息前缀 `Error 1105 (HY000): …` 解析。

### 路线 B：自写 STARTTLS 适配 + 覆盖 mysql2 的 `startTLS`

- 用已实测可用的 `cloudflare:sockets` 做 TLS 升级，把 socket 包成 Duplex 交给 mysql2，并覆盖 `Connection.prototype.startTLS`。能连任何公共 CA 的 MySQL（含自建、其它云）。
- 代价：改写依赖内部行为（违反"依赖优先"的边缘），mysql2 或 workerd 每次升级都要重测；代码量与维护成本都明显高于 A；评审时大概率被立规专项挑出。

### 路线 C：二期 MySQL 暂缓

保留本结论，等 workerd 修好 socket 升级再回来；三期 SparkSQL 的排期不受影响。

---

## 6. 与一期同构的接入点（两条路线通用，文件级）

| 接入点 | 改动 |
| --- | --- |
| `worker/src/types.ts` | `DatabaseKind` 增加 `'mysql'`（前端 `web/src/types.ts` 的 `DbKind` **已有** `'mysql'`/`'spark'`，一期已预留标签） |
| `worker/src/lib/bindings.ts` | `QueryTarget` 增加 `{ kind: 'mysql'; databaseId }`；`resolveQueryTarget()` 按 `kind` 分发，同样要求 `connection_secret` 存在（照抄 postgres 分支） |
| `worker/src/lib/mysql-url.ts`（新增） | 照 `pg-url.ts`：只接受 `mysql://` / `mysql2://`，剥掉 `ssl-ca` / `ssl-cert` / `ssl-key` 等 CA 旋钮（Worker 用不了），错误信息绝不回显连接串，长度上限 4096 |
| `worker/src/lib/mysql-executor.ts`（新增） | 照 `pg-executor.ts`：`MySqlQueryError(kind: sql/auth/config/transport)`、`MySqlExecuted`、`openMySqlSession()`、`testMySqlConnection()`；动态 `import()`（D1 路径不付加载成本），一请求一连接、批内复用、`finally` 关闭，无连接池 |
| `worker/src/routes/query.ts` | `dialectOf()` 增加 mysql；`openExecutor()` 加分支；`resolveExecError()` 加 `MySqlQueryError` 分支；`MAX_RESULT_ROWS=5000`、`MAX_SQL_LENGTH=100000`、批 ≤100 全部沿用；`translate()` 保持只服务 sqlite（`mysql-compat.ts` 的语法糖**不**进 mysql 目标，避免两者混用） |
| `worker/src/lib/sql-guard.ts` | `SqlDialect` 增加 `'mysql'`，按第 8 节补方言规则；`limitReadSql()` 的派生表在 mysql 下必须带别名（现在只有 postgres 加 `AS zeta_limit`） |
| `worker/src/routes/admin.ts` | `kind` 校验加 `'mysql'`；`verifyPostgresConnection()` 泛化为 `verifyConnection(kind, url)`；`binding_name` 用 `my:${id}`；`POST /admin/databases/test-connection` 需要接受 `kind`（现在只认连接串，属契约变更，要一并冻结） |
| `worker/src/lib/migrations.ts` | **无需迁移**：`kind` 是自由文本（无 CHECK 约束），`connection_secret` 在 `schema_v2` 已存在。不新增 `schema_v3` |
| `web/src/pages/admin/Databases.tsx` + `web/src/lib/translations.ts` | 引擎下拉加 MySQL（`admin_db.kind_mysql` 中英文标签已有），把 `kind === 'postgres'` 的分支泛化成"连接串类引擎"，加 `mysql://` 占位符 |
| `worker/src/lib/app-db-guard.ts` | 无需改动：mysql 目标 `cf_database_id` 为 NULL → `isAppDb()` 恒假，应用库护栏自然不会误伤 |

---

## 7. 接口契约草案（建议冻结）

### 7.1 登记与试连

- **登记**：`POST /api/admin/databases`，`kind: 'mysql'`，`connection_url` 必填；只有真正连通才落库；成功返回 `{ id, name, kind, database, server_version }`；连接串用现有 `sealSecret` 存成 `{"url": …}`，任何响应都不回显（沿用一期 `has_connection` 写法）。
- **试连**：`POST /api/admin/databases/test-connection`，请求 `{ connection_url, kind? }`（`kind` 缺省保持 `postgres` 以兼容现有前端），响应 `{ ok, kind, server_version, latency_ms }`。

### 7.2 执行

`POST /api/query` 与 `/api/query/batch` 的请求/响应形状完全不变：

- 读：最多 5000 行，超出后 `truncated: true`；
- 写：返回 `{ meta: { changes }, results: [] }`，`changes` ← `rowsAffected`；
- 要不要在 `meta` 里带 `insert_id`：**建议不带**，保持一期形状（列为开放项）。

### 7.3 错误分级（HTTP 码沿用一期策略：sql → 400 对所有人可见；auth/config/transport → 管理员看细节、普通成员看通用文案）

| 情况 | 归类 |
| --- | --- |
| `ER_PARSE_ERROR 1064`、`ER_NO_SUCH_TABLE 1146`、`ER_BAD_FIELD_ERROR 1054`、`ER_DUP_ENTRY 1062`、`ER_DATA_TOO_LONG 1406`、`ER_TRUNCATED_WRONG_VALUE 1292`、`ER_LOCK_DEADLOCK 1213`、`ER_LOCK_WAIT_TIMEOUT 1205`、`ER_ROW_IS_REFERENCED_2 1451`、`ER_NO_REFERENCED_ROW_2 1452`、`ER_NOT_SUPPORTED_YET 1235` | sql（400） |
| `ER_ACCESS_DENIED_ERROR 1045`、`ER_DBACCESS_DENIED_ERROR 1044`、`ER_TABLEACCESS_DENIED_ERROR 1142`、`ER_SPECIFIC_ACCESS_DENIED_ERROR 1227`、`ER_NOT_SUPPORTED_AUTH_MODE 1251` | auth |
| `ER_BAD_DB_ERROR 1049`、存储的连接串不可读 | config |
| `PROTOCOL_CONNECTION_LOST`、`ECONNRESET/EPIPE/ETIMEDOUT/ENOTFOUND/ECONNREFUSED`、`ER_CON_COUNT_ERROR 1040`、`ER_CLIENT_INTERACTION_TIMEOUT 4031`、TLS 握手失败、连接超时 | transport |
| `ER_UNKNOWN_ERROR 1105`（TiDB 的万能筐，insecure transport 就是它） | 连接阶段 → transport；已连上后 → sql（**实连复核完成（§11-6）：本实例未返回 1105；400 一律按语句错误归 `sql`/400**） |
| 驱动抛出但没有 `code` 的错误 | transport |

### 7.4 类型映射（JSON 安全出口，`toJsonSafe()` 不改）

| MySQL 类型 | 出口形态 | 说明 |
| --- | --- | --- |
| `DECIMAL` / `NUMERIC` | 字符串 | 驱动默认 `decimalNumbers: false`，精度不丢 |
| `BIGINT` / `UNSIGNED BIGINT` | 字符串 | 驱动开 `supportBigNumbers + bigNumberStrings`，绝不走 JS number |
| `DATE` / `DATETIME` / `TIMESTAMP` | **原样字符串** | 开 `dateStrings`，避免时区漂移；这是一期 ISO 8601 之外的差异，需明确写进契约 |
| `TIME` / `YEAR` | 字符串 / number | `TIME` 可能超出 `Date` 范围，保持字符串 |
| `CHAR` / `VARCHAR` / `TEXT` / `ENUM` / `SET` | 字符串 | — |
| `BLOB` / `BINARY` / `VARBINARY` / `GEOMETRY` | base64 字符串 | 驱动给 Buffer，workerd 里 `instanceof Uint8Array` 已实测为真 |
| `JSON` | 对象（递归走一遍映射） | 与一期 PG 的 `jsonb` 行为一致 |
| `FLOAT` / `DOUBLE` | number | 非有限值转字符串（沿用一期） |
| `BIT(1)` | base64 字符串 | 不映射成 0/1（**实连复核：`BIT(8)` 写入 `03` 读回字节 `03`，无多余 0 字节**） |
| `TINYINT(1)` / `BOOLEAN` | number（0/1） | 与 PG 的 true/false 不一致，需在契约里写明 |
| `NULL` | `null` | — |

### 7.5 运行期不变量（沿用一期）

- 一请求一连接、批内顺序复用、`finally` 关闭；不做连接池、不做长连接缓存；不经 Hyperdrive。
- TLS 必须开、只认公共同信根；连接串只从 `sealSecret` 出、只进执行器，任何 API/日志都不回显（错误信息里的 URL 要 redact）。
- `multipleStatements: false` 是硬要求（多语句护栏的第二道闸）。
- `connectTimeout` 15 秒。

---

## 8. sql-guard 的 MySQL 方言边界（建议，未改代码）

### 8.1 扫描器必须先补的三处（都属于"我们当注释、服务器当 SQL"的危险方向）

1. **`/*! … */` 可执行注释**：MySQL 会执行里面的 SQL（如 `/*!50000 DROP TABLE t */`），现在被整段丢弃。建议 mysql 方言下直接 `forbidden`（`/*+` 优化器提示仍可丢）。
2. **`#` 行注释**：MySQL 支持，现在被当成普通字符。多数情况导致误判成多语句而拒绝（安全方向），但应按方言处理干净。
3. **字符串反斜杠转义**：MySQL 默认 `\'` 是转义，现在会被当字符串结束。方向偏安全（会误拒），但会让"引号里的 `;`"被当成语句分隔符，行为不可预期。

另注：MySQL 的 `--` 注释要求后面跟空白，而现有扫描器一律当注释——已在两种写法下验证不会放行写操作，但同一份方言补丁里一并按 MySQL 规则处理更稳。

### 8.2 分类建议

| 分类 | 语句 |
| --- | --- |
| **read** | `SELECT`（无 `INTO OUTFILE/DUMPFILE`）、`SHOW`（`SHOW TABLES/CREATE/INDEX/VARIABLES` 等）、`DESCRIBE`/`DESC`、可包裹的 `EXPLAIN`（`EXPLAIN ANALYZE` 要递归判内层，同一期）、`WITH … SELECT` |
| **write** | `INSERT`/`UPDATE`/`DELETE`/`REPLACE`、`CREATE`/`ALTER`（`ALTER … DROP` 仍判 destructive）、`SET`（会话级）、`USE`、`CALL`、`ANALYZE`/`OPTIMIZE`/`REPAIR`、`RENAME` |
| **destructive** | `DROP`、`TRUNCATE`（沿用一期） |
| **forbidden** | `LOAD DATA … [LOCAL] INFILE`（现有 `FILE_STATEMENTS` 已含 `load`）、`SELECT … INTO OUTFILE/DUMPFILE`、`LOCK/UNLOCK TABLES`、`PREPARE`/`EXECUTE`/`DEALLOCATE`（绕过分类的动态执行）、`GRANT`/`REVOKE`/`CREATE USER`/`FLUSH`/`KILL`/`SHUTDOWN`、`START TRANSACTION`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`（与"一语句一请求、自动提交"的契约冲突，建议禁止，待计划确认）、`HANDLER`、`/*! … */` |

### 8.3 行数上限适配

- `limitReadSql()` 在 mysql 下派生表必须带别名：`SELECT * FROM ( … ) AS zeta_limit LIMIT 5001`；
- `SELECT … FOR UPDATE` / `LOCK IN SHARE MODE` 不能塞进子查询，照 postgres 的做法"不包裹、事后截断"。

### 8.4 策略选择（需计划阶段确认）

- `SHOW PROCESSLIST` / `SHOW FULL PROCESSLIST` / `SHOW GRANTS` 建议归 `forbidden`：会把同库其它会话的 SQL 暴露给普通成员。
- 事务控制语句（`START TRANSACTION` 等）建议 `forbidden`：一连接一请求 + 自动提交的契约下它们没有意义，还会留下锁。

---

## 9. 未完成项与开放问题

1. **`TIDB_URL` 到位后的用途变了**：它不再能救 mysql2（那次失败发生在鉴权之前），只用于把选定路线跑完全链路——鉴权、读写、`truncated`、类型映射、错误码归类。等路线定了再补做即可，不必为它等。
2. ~~需要实连复核：`BIT(1)` 的 base64 表现、`1105` 归类、TiDB 是否支持会话级语句超时（防一条慢查询烧 RU）。~~ **已完成（2026-11-13，TIDB_URL 到位后）：见 §11。**
3. 生产 workerd 由 Cloudflare 推送，与本地实测版本可能不同；但上述阻断点都写在 workerd 自己的实现里，短期内不会自己消失。
4. 一期结论沿用不变：不走自定义 CA、不做连接池、不经 Hyperdrive——本次全部实测与之一致。
5. 待拍板：传输路线 A / B / C；若选 A，`kind` 命名（`mysql` 还是 `tidb`）与传输字段。

---

## 10. 下一步

**路线 A 已选定并实现**（计划正文 `reports/plan-mysql-phase2.md`，提交 3327ad8；实现分支见交付汇报）。`TIDB_URL` 到位后已补完 §10 实连复核与 S5 浏览器手测，结论见 §11；下一步是合并关口由用户/Chief 拍板，不再有待定的传输路线。


---

## 11. 实连复核结果（2026-11-13，`TIDB_URL` 到位后）

环境：TiDB Cloud Starter，`gateway01.us-west-2.prod.aws.tidbcloud.com`，`select version()` → `8.0.11-TiDB-v8.5.3-serverless`。
方式：`TIDB_URL=… pnpm test -- mysql-live`（6 条实连测试全绿，日志前缀 `[mysql-live]`）＋同轮浏览器手测（登记→试连→保存→查询→历史/记事本）。
写操作只在本实例可写的 `test` 库建/插/删自建表 `zeta_live_*` 与 `zeta_probe_*`，结束即删；凭证不入日志、不入报告。

注：交付用的连接串指向 `sys` 库，该库对本实例用户不开放 DDL（`CREATE/DROP` 均 1142），因此写类复核改在 `test` 库进行；读取与归一化仍用原始串。

### 11.1 §10 清单逐项

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | 归一化 + 不回显 | 通过：host `gateway01.us-west-2…`、库 `sys`；归一化幂等（再归一化不变）；错误文案不含原串/凭证 |
| 2 | `server_version` | `8.0.11-TiDB-v8.5.3-serverless`（test-connection 路径） |
| 3 | 类型映射 | 与 §7.4 一致，**BLOB 不多 0 字节**（明细见 11.2） |
| 4 | >5000 行截断 | 写入 5005 行后 `select` 返回 5000 行 + `truncated: true`（`LIMIT 5001` 在服务端生效） |
| 5 | 三类错误 | auth / config / transport 各一例（明细见 11.3） |
| 6 | `1105` 定稿 | **归 `sql`/400**：本实例全程未返回 1105；400 承载全部语句拒绝，401 承载凭证与库名问题，据此按状态码定稿 |
| 7 | 会话语义 | **「无状态」假设不成立**，见 11.5；`USE`/`SET` 仍 `forbidden`，`BEGIN` 新增 `forbidden` |
| 8 | 批量 | 5 条语句 = 5 次 `fetch`，无池化、无长连接 |
| 9 | 回填 | 本节 |

### 11.2 类型实测

| 列 | 声明 | 出口 |
| --- | --- | --- |
| `id` | `BIGINT` | `"9007199254740993"`（字符串，精度不丢） |
| `dec_col` | `DECIMAL(12,2)` | `"12.34"`（字符串） |
| `dt` | `DATETIME` | `"2026-11-12 15:39:41"`（原样，无人为时区转换） |
| `blob_col` | `BLOB`（写入 `0x0102`） | `Uint8Array(2)` → base64 `AQI=`，字节 `01 02`，**没有多出的 0 字节** |
| `bits` | `BIT(8)`（写入 `b'00000011'`） | `Uint8Array(1)` → base64 `Aw==`，字节 `03` |
| `doc` | `JSON` | `{ n: 1 }`（对象） |
| `flag` | `TINYINT(1)` | `1`（number） |

### 11.3 错误三元组（`status / body code / message`，凭证已脱敏）

| 场景 | 实测 | 归类 |
| --- | --- | --- |
| 错凭证 | `401` / `400` / `Error 1045 (28000): Access denied for user '[redacted]'@'…' (using password: YES)` | auth |
| 错库名 | `401` / `—` / `Error 1049 (42000): Unknown database 'sys_nope'` | config |
| 不可达 host | fetch 抛错（DNS） | transport |
| 语法错误 | `400` / `400` / `You have an error in your SQL syntax: line 1 column 5 near "SELEC 1"` | sql |
| 缺表 | `400` / `61100002` / `Execute SQL fail: Error 1146 (42S02): Table 'test.zeta_missing_table_xyz' doesn't exist` | sql |
| 权限不足（`DROP TABLE mysql.user`） | `400` / `61100002` / `Execute SQL fail: Error 1142 (42000): DROP command denied to user '[redacted]'@'%' …` | sql |
| 内存超限（`@@tidb_mem_quota_query` 收紧后大查询） | `400` / `61100002` / `Execute SQL fail: Error 8175 (HY000): … exceeding the allowed memory limit …` | sql |

### 11.4 两处与预判不同（已按实测改代码）

1. **语句错误有两种文案形态**：解析错误**没有** `Error <errno> (<sqlstate>)` 行；表/列/权限错误带 `Execute SQL fail: ` 前缀。原判据是「消息必须以 `Error ` 开头」，会把解析错误判成 config/500。改为**按状态码判定：400 → sql**（实测所有 400 都是语句拒绝，未观察到「请求形状」型 400）。
2. **错库名实测是 401 + `Error 1049`**，原契约按「400 其它 → config」写。改为在 401/403 分支识别 1049 归 config，文案改为「The database does not exist」。

### 11.5 会话共享（与 §7.5「无状态」假设相反）

实测：端点按（凭证, 库名）保留一个服务端会话并**跨请求复用**——独立进程拿到相同的 `CONNECTION_ID`；`SET @x=1` 之后，新进程的 `SELECT @x` 读到 `1`；`USE mysql` 之后，后续请求的 `DATABASE()` 变成 `mysql`。结论：

- `USE` / `SET` **确实会生效**，因此归 `forbidden` 的理由从「不会生效、留着误导」改为「会污染整个应用的共享会话」；
- `BEGIN`（`START TRANSACTION` 的同义词）新增 `forbidden`：共享会话里开事务会把其它请求的语句卷进去；
- 执行器在每请求的建连证明语句里读取 `database()`，与登记库不一致即按 config 报错（fail closed），避免静默查错库。

复核过程中探查用的 `USE` 已还原（`test` 会话回到 `test`、`sys` 会话保持 `sys`），用户变量与 `@@tidb_mem_quota_query` 均已复位。

### 11.6 `1105` 定稿

本实例**未返回过 1105**：凭证错是 1045(28000)、库名错是 1049(42000)、语句类错误是 1146/1054/1142/8175 或纯解析错误，全部落在 400；鉴权类是 401。因此 §7.3 的 1105 行按「连接阶段 → transport；已连上后 → sql」定稿——实现在 400 分支直接归 `sql`，不再依赖错误码文本。
