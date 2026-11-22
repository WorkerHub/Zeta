# 个人资料 / 安全设置 拆页 QA 脚本

本页验收（拆成 `/profile` 与 `/security` 两个路由）的可复跑脚本。真浏览器（系统 Chrome 无头，CDP 驱动）+ 真后端（`wrangler dev` 本地 D1 + Vite dev），无桩接口、无假数据。

对应报告：[`../profile-security-split.md`](../profile-security-split.md)。

## 前置

```bash
# 1) 依赖（仓库根）
pnpm install

# 2) 本地密钥（worker/.dev.vars，gitignored；不要提交）
#    JWT_SECRET=<随机>  ENCRYPTION_KEY=<32 字节 base64>
#    SETUP_SECRET=<随机>  CLOUDFLARE_API_TOKEN=<占位>  APP_URL=http://localhost:5173
#    APP_URL 必须与浏览器实际访问的 origin 一致（Passkey 的 rpId/expectedOrigin 取它的 hostname）

# 3) 初始化本地 D1（只做一次）
curl -X POST http://localhost:8787/api/setup -H 'Content-Type: application/json' \
     -d "{\"secret\":\"<SETUP_SECRET>\"}"

# 4) 起服务（两个终端）
cd worker && pnpm dev --port 8787     # wrangler dev + 本地 D1
cd web && pnpm dev --port 5173 --strictPort   # Vite，代理 /api → 8787

# 5) 生产构建复核（阶段 C 需要 worker 直供 web/dist）
pnpm build:web
```

- Playwright：任意 1.65+ 版本，脚本用 `channel: 'chrome'` 驱动本机安装的 Chrome；若仓库没装 playwright，可用 `NODE_PATH=/path/to/node_modules` 指向别处。
- `node:sqlite`（Node ≥ 22.5）用于只读直查本地 D1 文件：`worker/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`（不占用 dev server 的库句柄）。

## 跑法

```bash
export ZETA_REPO=$(pwd)          # 仓库根（脚本也可用当前工作目录）
node .github/assets/qa/profile-security-split/reset-fixture.js   # 可选：清掉本地 QA 账号及其凭据
node .github/assets/qa/profile-security-split/phase-a.js          # 阶段 A：路由/Tab/Profile/Security/别名（40 项）
node .github/assets/qa/profile-security-split/phase-b.js          # 阶段 B：菜单入口/改密/TOTP/Passkey/2FA/移动端（22 项）
node .github/assets/qa/profile-security-split/phase-c.js          # 阶段 C：生产构建复核 + dev/生产 refresh 竞态对比（8 项）
```

- 阶段 A 的账号：`qa-split@example.com` / 初始密码 `qa-pass-123456`（首个注册账号自动是 admin；之后注册接口按产品设计关闭，脚本会自动复用已存在账号）。
- 阶段 B 会把密码轮换成 `qa-pass-888888`（若原密码已是它则改用 `qa-pass-999999`），脚本启动时会依次尝试已知密码探测当前值。
- 阶段 B/C 会写入并清理本地二次验证凭据；全部数据都在本地 D1，不触生产。

## 可重复性加固（都已在归档版本上实测通过）

| 坑 | 处理 |
| --- | --- |
| 阶段 B 轮换过密码后，下一轮不知道当前密码 | 登录时依次探测候选密码（123456/654321/777777/888888/999999） |
| 运行条数目标值与库里的值相同 → 前端不进入「有未保存更改」态 → 保存按钮一直禁用 | 目标值动态取「与当前输入框不同的值」，断言按该目标值比对落库 |
| TOTP 验证码 30 秒窗口内不可重放 | 命中 `Code already used` 时等待到下一个窗口再试 |
| 阶段 A/C 若在 TOTP 已启用后运行，纯密码登录进不去 | 阶段 A/C 启动时先清掉本地 TOTP 凭据（仅本地一次性 D1） |
| `d1()` 查询出错时静默返回 null，看起来像「没落库」 | 出错时打印 SQL 与错误信息 |
| dev 模式 StrictMode 双 refresh 竞态偶发把会话清掉 → 跳回 `/login` | `gotoAuthed()` 允许最多 5 次「重新登录后再导航」，并在错误里带上最后一次 URL |

## 结果

归档脚本在本地实测：**阶段 A 40/40、阶段 B 22/22、阶段 C 8/8**（合计 70 项全通过）。
结果 JSON：`/tmp/zeta-qa/ps-results-{a,b,c}.json`；截图落在 `.github/assets/qa/`。
