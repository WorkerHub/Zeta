# Zeta

> [**中文文档**](./README_zh-CN.md) | [**English**](./README.md)

自托管的 [Cloudflare D1](https://developers.cloudflare.com/d1/) 数据库 SQL 查询界面。完全运行在 Cloudflare 平台上，无需管理任何服务器。

**版本 1.0.0**

![Stack](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare) ![Stack](https://img.shields.io/badge/Hono-v4-blue) ![Stack](https://img.shields.io/badge/React-19-61dafb?logo=react) ![Stack](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)

---

## 功能特性

- **SQL Notebook** — 每位用户可创建多个命名 SQL 编辑器标签页，自动保存，每个标签页独立绑定数据库；支持重命名、每用户最多 20 个
- **SQL 编辑器** — 完整 SQL 输入，语法高亮（CodeMirror 6），Ctrl/Cmd+Enter 执行，支持选中片段单独运行，显示耗时和行数；读查询最多返回 5000 行，在 SQL 层面强制限制
- **运行结果保留** — 每次运行 Notebook 都会连同结果一起保存，切换标签页、离开页面、刷新或换设备后仍可查看；运行记录以带编号的横向标签页排列（… #3 #2 #1，最新的在最左边），可切换、删除或清空，顶部的「历史」按钮会打开可调整宽度的抽屉，集中查看 SQL 和结果（见[查询结果保留](#查询结果保留)）
- **多数据库** — 连接多个 D1 数据库，按用户分配每个数据库的 `read`（只读）或 `write`（读写）权限
- **身份验证** — 邮箱 + 密码登录、邮件验证、找回密码、可选 TOTP / 邮件 OTP / Passkey（WebAuthn）二步验证
- **管理后台** — 用户管理、数据库连接管理、权限分配、邮件及应用配置
- **多语言** — 内置中文（简体）和英文界面
- **深色 / 浅色 / 自动主题** — 默认跟随系统偏好
- **100% Cloudflare** — Workers + D1 + KV + Workers Assets，唯一外部依赖为邮件服务（Resend 或 SMTP）

---

## 架构

```
┌─────────────────────────────────┐
│  Cloudflare Worker (Hono.js)    │
│  ┌────────────┐  ┌────────────┐ │
│  │  /api/*    │  │  SPA       │ │
│  │  REST API  │  │  (Assets)  │ │
│  └─────┬──────┘  └────────────┘ │
│        │                        │
│  ┌─────▼──────┐  ┌────────────┐ │
│  │  D1 (应用) │  │  KV        │ │
│  │  + 目标 D1 │  │  (会话/2FA)│ │
│  └────────────┘  └────────────┘ │
└─────────────────────────────────┘
```

| 层级 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| API 框架 | Hono.js v4 |
| 应用数据库 | D1 (SQLite) — 用户、Notebook、设置、查询历史 |
| 查询目标 | 额外的 D1 数据库（通过 Cloudflare D1 HTTP API 访问） |
| 会话 / 2FA 状态 | Cloudflare KV |
| 前端 | React 19 + Vite + Tailwind CSS v4 |

---

## 通过 GitHub Actions 部署

每次推送到 `main` 分支时自动触发部署，**无需在本地安装任何工具**。

### 第一步 — 创建 Cloudflare 资源

在 [Cloudflare 控制台](https://dash.cloudflare.com) 中创建以下资源：

**D1 数据库**（Workers & Pages → D1 → 创建数据库）
- 名称：`zeta-db`（或任意名称）
- 记录创建后显示的 **Database ID**

**KV 命名空间**（Workers & Pages → KV → 创建命名空间）
- 名称：`ZETA_KV`
- 记录 **Namespace ID**

**API Token**（我的个人资料 → API 令牌 → 创建令牌）
- 使用 **Edit Cloudflare Workers** 模板
- 令牌值只显示一次，请立即保存

同时记录你的 **Account ID**（控制台首页右侧边栏）。

---

### 第二步 — 配置 GitHub 仓库

进入 GitHub 仓库 → **Settings → Secrets and variables → Actions**：

**Secrets**（加密存储，用于敏感值）：

| 名称 | 值 |
|------|----|
| `CLOUDFLARE_API_TOKEN` | 第一步中获取的 API Token |

**Variables**（明文存储，用于非敏感 ID）：

| 名称 | 值 |
|------|----|
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID |
| `D1_DATABASE_NAME` | 例如 `zeta-db` |
| `D1_DATABASE_ID` | 第一步中的 D1 Database ID |
| `KV_NAMESPACE_ID` | 第一步中的 KV Namespace ID |

---

### 第三步 — 在 Cloudflare 控制台配置 Worker 密钥和变量

这些值属于敏感信息或与具体部署环境相关，**直接在 Cloudflare 控制台配置**，不经过 GitHub。

进入 **Workers & Pages → zeta → 设置 → 变量和密钥**：

**密钥（Secret 类型）**：

| 名称 | 如何生成 |
|------|---------|
| `JWT_SECRET` | 任意 64 位随机字符串，例如 `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64 位十六进制（32 字节），例如 `openssl rand -hex 32`。会严格校验：其他取值（口令、较短的密钥等）会被直接拒绝，而不是悄悄生成一个弱密钥 |
| `SETUP_SECRET` | 任意随机字符串，例如 `openssl rand -hex 16` |
| `CF_D1_API_TOKEN` | 拥有 **D1 → Edit** 权限的 Cloudflare API Token（账号级）。运行时用它列出并查询你在后台添加的 D1 数据库。注意：这是与部署用的 GitHub `CLOUDFLARE_API_TOKEN` 不同的另一个 Token。 |

**变量（Text 类型）**：

| 名称 | 值 |
|------|----|
| `APP_URL` | 你的 Worker 地址，例如 `https://zeta.yourname.workers.dev` 或自定义域名。请填写用户实际访问的 `https://` 地址：它是 CORS 唯一允许的来源、Passkey 的 RP ID、邮件链接的前缀，也是所有登录令牌的签发方/受众（之后修改会让所有用户重新登录） |
| `TABLE_PREFIX` | *（可选）* 所有内部 D1 表的前缀，例如 `kp` → 表名变为 `kp_users`、`kp_settings` 等。必须在**调用 setup 接口之前**设置，初始化后不可更改。 |

> `CF_ACCOUNT_ID` 与 `ZETA_APP_DB_ID` 会在部署时由 GitHub Variables `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID` 自动注入，**不要在这里手动设置**。你只需要配置上面的 `CF_D1_API_TOKEN`。

> 以上配置完全隔离于 GitHub。`wrangler.toml` 中的 `keep_vars = true` 确保每次部署不会覆盖你在此处设置的值。

---

### 第四步 — 推送代码触发部署

```bash
git push origin main
```

[GitHub Actions 工作流](.github/workflows/deploy.yml) 会自动执行以下步骤：
1. 安装依赖
2. 构建 React 前端
3. 将 GitHub Variables 中的 ID 注入 `wrangler.toml`
4. 运行 `wrangler deploy`

在仓库的 **Actions** 标签页可以实时查看部署进度。

---

### 第五步 — 初始化数据库

首次部署成功后，**发送一次**以下请求来创建所有数据表并写入默认配置（secret 放在请求体中，不会出现在浏览器历史、访问日志或 `Referer` 请求头里）：

```bash
curl -X POST https://<你的域名>/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<SETUP_SECRET>"}'
```

成功后返回：

```json
{ "ok": true, "message": "Database initialised successfully. You can now register at /register — the first user becomes admin. On new installs registration then stays closed until an admin opens it in Admin → Settings." }
```

> 现在也有一个 `/setup` 页面入口，对大多数用户而言比在终端里敲命令更方便：它提交的是同一个 `POST /api/setup` 请求（带上密钥），因此受到相同的限流保护。管理员可以在**管理后台 → 设置**里隐藏该页面（`setup_page_enabled`，默认开启）——这个开关**只影响页面**；`POST /api/setup` 仍可用密钥调用，作为升级 / 救急通道。`POST /api/setup` 按来源 IP 限流：**每 15 分钟 10 次**（超限返回 `429` 并带 `Retry-After` 头），计数发生在密钥校验之前。

> 该接口是幂等的，重复调用不会造成任何破坏，可安全地多次调用。**每次升级部署后请再调用一次**：它还会对旧版本创建的数据库执行 Schema 升级（例如让 `query_history` 在删除用户或数据库时保留记录——升级前删除用户或数据库会失败；以及创建 `rate_limits` 表，让登录 / 两步验证 / 邮件的限流计数精确生效——该表创建前会退回到近似的 KV 计数；以及在 `user_database_permissions` 表的外键仍指向不带前缀的 `users` / `d1_databases` 表时重建该表——修复前授权、撤销数据库权限以及删除用户或数据库都会报 `no such table` 错误。用户或数据库已不存在的权限记录会被丢弃，丢弃的行数会在响应的 `permissionsRepair` 字段中给出；以及为[查询结果保留](#查询结果保留)创建 `notebook_runs` 表并给 `users` 表添加 `notebook_run_limit` 列——升级前运行结果不会被保存，运行记录列表也无法加载；以及为运行记录编号：添加 `notebook_runs.seq` 和 `notebooks.last_run_seq` 列，把每个 Notebook 已有的运行记录按时间从早到晚从 1 开始编号，并建立唯一索引 `(notebook_id, seq)`——**部署带编号运行标签页的版本后，请再调用一次**：调用前查询仍可正常执行，但不会被保存，运行记录标签页也无法加载；以及为[通过 HTTP 接口添加 D1 数据库](#接入更多-d1-数据库)添加 `d1_databases.cf_database_id` 列——升级前后台的添加/关联数据库会报 `no such column: cf_database_id`）。通过迁移文件创建的数据库可执行 `pnpm migrate:remote`（`0004_notebook_runs.sql`、`0005_notebook_run_seq.sql`、`0006_d1_cf_database_id.sql`）完成同样的升级。
>
> 旧版本使用的 `GET /api/setup/<SETUP_SECRET>` 已废弃：现在会返回 `405` 且不执行任何操作。如果曾经访问过旧 URL，建议轮换 `SETUP_SECRET`。

> 数据库初始化后，已登录的管理员也可以在**管理后台 → 设置**里直接点「检查并升级数据库」按钮执行同样的检查与升级，无需密钥——管理员会话本身就是凭据。首次初始化仍需通过 `/setup` 页面或上面的 `curl` 命令。

---

### 第六步 — 注册管理员账号

访问 `https://<你的域名>/register` 进行注册。**第一个注册的用户自动成为管理员**。

新部署在第一个账号创建后会自动关闭注册。之后你可以：
- 在 **管理后台 → 用户** 中创建账号，或在 **管理后台 → 设置** 中开放自助注册（配置好邮件服务后，建议同时开启邮箱验证和强制两步验证）
- 在 **管理后台 → 数据库** 中添加可查询的 D1 数据库
- 在 **管理后台 → 数据库 → 权限** 中为用户分配访问权限

---

## 接入更多 D1 数据库

D1 数据库现在从管理后台直接添加——**无需绑定、无需改 GitHub Variables、也无需重新部署**。Worker 通过 Cloudflare D1 HTTP API 访问它们，凭据是第三步配置的 `CF_D1_API_TOKEN`（密钥）与 `CF_ACCOUNT_ID`（变量）。

1. 在**管理后台 → 数据库**中点击**添加数据库**。
2. 从账号的 D1 数据库列表中选择一个（Zeta 自身的应用库已被排除）。
3. 可选地填写显示名称和描述，然后注册。
4. 在**管理后台 → 数据库 → 权限**中为用户分配 `read`（只读）或 `write`（读写）权限。

> **旧版绑定式数据库。** 用旧的绑定方式注册的数据库没有 `cf_database_id`，在重新关联之前将无法查询。在**管理后台 → 数据库**中，对这类数据库点击**关联**，从列表中选择对应的 Cloudflare 数据库即可。权限、查询历史与已保存的运行记录都会保留。

---

## MySQL 兼容写法

SQL 编辑器支持少量 MySQL 的查看语句，会自动转换成等价的只读 SQLite 查询，让习惯 MySQL 的命令能在 D1 数据库上直接使用：

| MySQL 语句 | 返回列 | 说明 |
|-----------|--------|------|
| `SHOW TABLES` | `name` | 当前库的表和视图，排除 `sqlite_*`、`_cf_*` 开头的内部表 |
| `DESCRIBE 表名` / `DESC 表名` / `SHOW COLUMNS FROM 表名` | `Field`、`Type`、`Null`、`Key`、`Default`、`Extra` | `Null` 为 `YES`/`NO`；`Key` 主键列为 `PRI`，否则为空字符串；`Default` 为 SQLite 的原始默认值表达式 |
| `SHOW CREATE TABLE 表名` | `Table`、`Create Table` | 原始的 `CREATE TABLE` 建表语句 |
| `SHOW INDEX FROM 表名`（也可写 `SHOW INDEXES` / `SHOW KEYS`） | `Table`、`Non_unique`、`Key_name`、`Seq_in_index`、`Column_name`、`Collation`、`Cardinality`、`Sub_part`、`Packed`、`Null`、`Index_type`、`Comment`、`Index_comment`、`Visible`、`Expression` | `Key_name` 主键为 `PRIMARY`；`Cardinality`、`Expression` 为 `NULL` |

这些语句不区分大小写，允许末尾加分号；表名支持反引号、双引号和不加引号三种写法。转换结果是只读的——只有 `read` 权限的用户也可以执行，5000 行上限同样生效，查询历史和运行记录中保存的是你原本输入的语句。`SHOW DATABASES` 不受支持（每个连接只绑定一个数据库），会返回明确的错误提示；其他 `SHOW …` 写法以及任何无法识别的语法会原样交给原有流程处理。

---

## 查询结果保留

每次运行 Notebook（单条或多条语句）都会连同结果保存到应用数据库的 `notebook_runs` 表中。结果上方以标签页显示该 Notebook 的运行记录，编号从右到左排列：`… #5 #4 #3 #2 #1`，最新一次在最左边，打开 Notebook 时默认选中它。标签栏可以左右滑动（触控板、触屏、鼠标滚轮均可），滑到最右端会继续加载更早的记录；鼠标悬停在标签上可查看运行时间、数据库、行数和 SQL 摘要。点标签上的 × 立即删除该条记录（键盘聚焦标签时按 Delete / Backspace 效果相同，←/→ 切换标签）。顶部的「历史」按钮会打开侧边抽屉，列出该 Notebook 的全部运行记录：选中一条即可查看它的 SQL 和结果、删除单条记录，或点「清空全部」并确认后清空全部记录；列表滚动到底部会继续加载更早的记录。抽屉默认占窗口宽度的一半，拖动它的左边缘（或用方向键）即可调整宽度。每次运行的编号固定不变且不会重复使用：删除或自动清理后编号会出现空缺（例如最早的一条是 #37），各 Notebook 分别编号。

有两项限制控制其大小，均在 **管理后台 → 设置 → 查询结果保留** 中配置：

| 限制 | 默认值 | 范围 | 作用 |
|------|--------|------|------|
| 每个 Notebook 保留的运行记录数 | 100 | 1–1000 | 超出的旧记录会被删除。用户可在 **个人资料 → 查询结果保留** 中设置更小的值，取两者中较小的生效。 |
| 每个用户运行结果存储上限 | 50 MB | 1–1024 MB | 超出时删除该用户最旧的运行记录（不限 Notebook）。 |

调低任一项都会立即作用于已保存的记录。单次运行最多保存 512 KB 结果（D1 单行上限为 2 MB），更大的结果只保留前面的行，结果面板中会给出提示。另外，读查询最多返回 5000 行：`SELECT`、`VALUES`、`WITH` 语句会以 `SELECT * FROM (<原语句>) LIMIT 5001` 的形式执行，由数据库本身提前停止（`PRAGMA` / `EXPLAIN` 在返回后截断）。

**容量估算：** 应用数据库中运行记录最多占用 *用户数 × 每用户存储上限*——按默认 50 MB 计，10 个用户约 500 MB，正好是 Workers 免费版 D1 单库的容量上限（付费版为 10 GB）。请按用户数调整这两项限制。

**安全性：** 保存的结果以明文存放在应用数据库中，与被查询数据在其自身数据库中的存放方式相同。只有所有者本人能查看和读取；每次读取都会重新校验对被查询数据库的访问权限：数据库被停用时结果不可见；撤销该用户对数据库的权限，或删除数据库、Notebook、用户时，相关结果会被一并删除。

---

## 本地开发

在两个终端分别启动 Worker 和前端开发服务器：

```bash
# 终端 1 — Worker（端口 8787）
cd worker && pnpm dev

# 终端 2 — Vite（端口 5173，/api 代理到 8787）
cd web && pnpm dev
```

创建 `worker/.dev.vars` 文件配置本地环境变量：

```ini
JWT_SECRET=dev-jwt-secret
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
SETUP_SECRET=dev-setup-secret
APP_URL=http://localhost:8787
CF_D1_API_TOKEN=<一个拥有 D1 → Edit 权限的 API Token>
CF_ACCOUNT_ID=<你的 Cloudflare Account ID>
ZETA_APP_DB_ID=<本应用自身数据库的 D1 Database ID>
```

执行以下命令完成本地数据库初始化：

```bash
curl -X POST http://localhost:8787/api/setup \
  -H 'Content-Type: application/json' \
  -d '{"secret":"dev-setup-secret"}'
```

然后在浏览器中打开 `http://localhost:5173`。

### 代码格式化

在仓库根目录执行：

```bash
pnpm format        # 用 biome 格式化整个代码库
pnpm format:check  # 只检查格式、不写入文件（CI 同样会强制检查）
```

纯格式化的提交记录在 `.git-blame-ignore-revs` 中，GitHub 的 blame 视图会自动识别。若想让本地 `git blame` 也跳过这些提交，每个 clone 执行一次：

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

---

## 配置变量参考

### GitHub Secrets & Variables

| 名称 | 类型 | 说明 |
|------|------|------|
| `CLOUDFLARE_API_TOKEN` | Secret | Wrangler 部署认证 Token |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare 账号 ID |
| `D1_DATABASE_NAME` | Variable | D1 数据库名称（例如 `zeta-db`） |
| `D1_DATABASE_ID` | Variable | D1 数据库 ID |
| `KV_NAMESPACE_ID` | Variable | KV 命名空间 ID |

### Cloudflare 控制台（手动配置）

| 名称 | 类型 | 说明 |
|------|------|------|
| `JWT_SECRET` | 密钥 | 签发访问令牌和刷新令牌（HS256） |
| `ENCRYPTION_KEY` | 密钥 | 64 位十六进制（严格校验）— TOTP 密钥及 SMTP/Resend 凭据的 AES-GCM 加密密钥 |
| `SETUP_SECRET` | 密钥 | 保护 `POST /api/setup` 初始化端点 |
| `CF_D1_API_TOKEN` | 密钥 | 拥有 `D1 → Edit` 权限的 API Token — 列出并查询后台添加的 D1 数据库 |
| `APP_URL` | 变量 | 部署的完整 URL，例如 `https://zeta.example.com`；同时作为 JWT 的 `iss`/`aud`，其他共用 `JWT_SECRET` 的部署签发的令牌会被拒绝 |
| `TABLE_PREFIX` | 变量 | *（可选）* 内部表名前缀（例如 `kp`）。首次 setup 前设置，初始化后不可更改。 |

`CF_ACCOUNT_ID` 与 `ZETA_APP_DB_ID` 不在此处设置：`wrangler.toml` 的 `[vars]` 会在部署时从 GitHub Variables `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID` 自动注入。

---

## API 概览

所有端点挂载在 `/api/` 下，认证使用短效 JWT 访问令牌（Authorization 请求头）+ HttpOnly 刷新令牌 Cookie。请求体上限 4 MB（超出返回 `413`）。

| 前缀 | 说明 |
|------|------|
| `POST /api/auth/*` | 注册、登录、注销、令牌刷新、邮件验证、密码重置、2FA（TOTP / 邮件 OTP / Passkey） |
| `GET/PATCH /api/profile/*` | 个人信息、修改密码、TOTP 设置/确认/删除、Passkey 注册/删除。删除 TOTP 或 Passkey 需在 JSON 请求体中提供 `{"currentPassword": "..."}` |
| `GET /api/databases` | 列出当前用户可访问的数据库 |
| `POST /api/query` | 对可查询的 D1 数据库执行 SQL（多条语句用 `/batch`）。数据库走 D1 HTTP API 执行。读查询最多返回 5000 行，超出时返回 `truncated: true`。带上 `notebookId` 时，这次运行会保存到该 Notebook 下，响应中附带 `run_id` / `seq`（运行编号）/ `executed_at` |
| `GET /api/query/history` | 查询执行历史（可按数据库过滤） |
| `GET/POST/PATCH/DELETE /api/notebooks` | SQL Notebook 的增删改查（每用户，最多 20 个） |
| `GET/DELETE /api/notebooks/:id/runs[/:runId]` | Notebook 的运行记录：列表（按编号 `seq` 从大到小，支持 `limit`，以及 `before=<seq>` 或 `offset` 翻页）、读取单条及其结果、删除单条、清空全部 |
| `GET/PUT /api/profile/run-settings` | 用户自己的保留次数（`run_limit`，`null` 表示跟随管理员上限）及存储用量 |
| `GET/POST/PATCH/DELETE /api/admin/*` | 仅管理员：用户、数据库、权限、设置 |
| `POST /api/setup` | 幂等的数据库 Schema 初始化（JSON 请求体 `{"secret": "<SETUP_SECRET>"}`）。按 IP 限流：每 15 分钟 10 次 |
| `GET /api/setup/state` | 公开接口：`{"enabled": boolean}` —— `/setup` 页面是否开启 |
| `GET /api/health` | 健康检查 |

---

## 技术栈

| | |
|---|---|
| **运行时** | Cloudflare Workers |
| **API** | [Hono](https://hono.dev) v4 |
| **数据库** | [Cloudflare D1](https://developers.cloudflare.com/d1/)（SQLite） |
| **KV** | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| **前端** | React 19、Vite、Tailwind CSS v4 |
| **SQL 编辑器** | CodeMirror 6 + `@codemirror/lang-sql` |
| **认证** | PBKDF2-SHA256 密码、HS256 JWT、WebAuthn Passkey |
| **二步验证** | TOTP（otpauth）、邮件 OTP、Passkey |
| **邮件** | [Resend](https://resend.com) 或自定义 SMTP |
| **部署** | `wrangler deploy`（GitHub Actions） |

---

## 许可证

[MIT](LICENSE)
