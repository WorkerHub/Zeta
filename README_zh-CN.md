# D1 Studio

自托管的 [Cloudflare D1](https://developers.cloudflare.com/d1/) 数据库 SQL 查询界面。完全运行在 Cloudflare 平台上，无需管理任何服务器。

![Stack](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare) ![Stack](https://img.shields.io/badge/Hono-v4-blue) ![Stack](https://img.shields.io/badge/React-19-61dafb?logo=react) ![Stack](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)

---

## 功能特性

- **SQL 编辑器** — 完整 SQL 输入，语法高亮（CodeMirror 6），Ctrl/Cmd+Enter 执行，显示耗时和行数
- **查询历史** — 每个数据库最近 50 条记录，点击即可重新执行
- **多数据库** — 连接多个 D1 数据库，按用户分配每个数据库的 `read`（只读）或 `write`（读写）权限
- **身份验证** — 邮箱 + 密码、邮件验证、找回密码、可选 TOTP / 邮件 OTP / Passkey（WebAuthn）二步验证
- **管理后台** — 用户管理、数据库连接管理、权限分配、邮件及应用配置
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
| 应用数据库 | D1 (SQLite) — 用户、设置、查询历史 |
| 查询目标 | 额外绑定的 D1 数据库 |
| 会话 / 2FA | Cloudflare KV |
| 前端 | React 19 + Vite + Tailwind CSS |

---

## 通过 GitHub Actions 部署

每次推送到 `main` 分支时自动触发部署，**无需在本地安装任何工具**。

### 第一步 — 创建 Cloudflare 资源

在 [Cloudflare 控制台](https://dash.cloudflare.com) 中创建以下资源：

**D1 数据库**（Workers & Pages → D1 → 创建数据库）
- 名称：`d1-studio-db`（或任意名称）
- 记录创建后显示的 **Database ID**

**KV 命名空间**（Workers & Pages → KV → 创建命名空间）
- 名称：`D1_STUDIO_KV`
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
| `CF_D1_DATABASE_NAME` | 例如 `d1-studio-db` |
| `CF_D1_DATABASE_ID` | 第一步中的 D1 Database ID |
| `CF_KV_NAMESPACE_ID` | 第一步中的 KV Namespace ID |

---

### 第三步 — 在 Cloudflare 控制台配置 Worker 密钥和变量

这些值属于敏感信息或与具体部署环境相关，**直接在 Cloudflare 控制台配置**，不经过 GitHub。

进入 **Workers & Pages → d1-studio → 设置 → 变量和密钥**：

**密钥（Secret 类型）**：

| 名称 | 如何生成 |
|------|---------|
| `JWT_SECRET` | 任意 64 位随机字符串，例如 `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64 位十六进制（32 字节），例如 `openssl rand -hex 32` |
| `SETUP_SECRET` | 任意随机字符串，例如 `openssl rand -hex 16` |

**变量（Text 类型）**：

| 名称 | 值 |
|------|----|
| `APP_URL` | 你的 Worker 地址，例如 `https://d1-studio.yourname.workers.dev` 或自定义域名 |

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

首次部署成功后，**访问一次**以下 URL 来创建所有数据表并写入默认配置：

```
https://<你的域名>/api/setup/<SETUP_SECRET>
```

成功后返回：

```json
{
  "ok": true,
  "message": "Database initialised successfully. You can now register at /register — the first user becomes admin."
}
```

> 该接口是幂等的，重复访问不会造成任何破坏，可安全地多次调用。

---

### 第六步 — 注册管理员账号

访问 `https://<你的域名>/register` 进行注册。**第一个注册的用户自动成为管理员**。

注册完成后，你可以：
- 在 **管理后台 → 设置** 中关闭注册开关，防止其他人随意注册
- 在 **管理后台 → 数据库** 中添加可查询的 D1 数据库
- 在 **管理后台 → 数据库 → 权限** 中为用户分配访问权限

---

## 接入更多 D1 数据库

D1 数据库必须在部署时绑定到 Worker，操作步骤如下：

1. 在 `worker/wrangler.toml` 中添加一个 `[[d1_databases]]` 条目：

   ```toml
   [[d1_databases]]
   binding = "QUERY_DB_1"
   database_name = "my-app-db"
   database_id   = "xxxx-xxxx-xxxx"
   ```

2. 推送到 `main` — Actions 工作流会自动重新部署。

3. 在 **管理后台 → 数据库** 中点击**添加数据库**，输入绑定名称（`QUERY_DB_1`）。

4. 在**数据库 → 权限**中为需要访问的用户分配权限（只读/读写）。

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
```

访问本地初始化端点完成数据库初始化：

```
http://localhost:8787/api/setup/dev-setup-secret
```

---

## 配置变量参考

### GitHub Secrets & Variables

| 名称 | 类型 | 说明 |
|------|------|------|
| `CLOUDFLARE_API_TOKEN` | Secret | Wrangler 部署认证 Token |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare 账号 ID |
| `CF_D1_DATABASE_NAME` | Variable | D1 数据库名称（例如 `d1-studio-db`） |
| `CF_D1_DATABASE_ID` | Variable | D1 数据库 ID |
| `CF_KV_NAMESPACE_ID` | Variable | KV 命名空间 ID |

### Cloudflare 控制台（手动配置）

| 名称 | 类型 | 说明 |
|------|------|------|
| `JWT_SECRET` | 密钥 | 签发访问令牌和刷新令牌（HS256） |
| `ENCRYPTION_KEY` | 密钥 | 64 位十六进制 — TOTP 密钥的 AES-GCM 加密密钥 |
| `SETUP_SECRET` | 密钥 | 保护 `GET /api/setup/:secret` 初始化端点 |
| `APP_URL` | 变量 | 部署的完整 URL，例如 `https://studio.example.com` |

---

## 技术栈

| | |
|---|---|
| **运行时** | Cloudflare Workers |
| **API** | [Hono](https://hono.dev) v4 |
| **数据库** | [Cloudflare D1](https://developers.cloudflare.com/d1/)（SQLite） |
| **KV** | [Cloudflare KV](https://developers.cloudflare.com/kv/) |
| **前端** | React 19、Vite、Tailwind CSS v3 |
| **SQL 编辑器** | CodeMirror 6 + `@codemirror/lang-sql` |
| **认证** | PBKDF2-SHA256 密码、HS256 JWT、WebAuthn Passkey |
| **二步验证** | TOTP（otpauth）、邮件 OTP、Passkey |
| **邮件** | [Resend](https://resend.com) 或自定义 SMTP |
| **部署** | `wrangler deploy` |

---

## 许可证

MIT
