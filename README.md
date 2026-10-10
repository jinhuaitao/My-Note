# Cloud Note — Cloudflare Workers + R2 云端记事本 / 文件分享

一个部署在 Cloudflare Workers 上的单用户代码记事本：浏览器里写代码、存到 R2、按需生成带密码 / 有效期 / 访问次数限制的分享链接。

**R2 存储桶会在部署时自动创建并自动绑定**，不需要手动建桶、也不需要把 bucket id 复制来复制去。

---

## 一、部署：Dashboard 连接 GitHub（推荐）

### 1. 把代码推到 GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin <你的仓库地址>
git push -u origin main
```

### 2. 在 Cloudflare Dashboard 连接仓库

进入 **Workers & Pages → 创建 → Workers → 连接到 Git**，选中这个仓库，然后按下表填写：

| 配置项 | 值 |
| --- | --- |
| **Project name** | `cloud-notepad`（**必须与 `wrangler.jsonc` 里的 `name` 完全一致**，自动创建的资源以它为前缀命名） |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Root directory | 仓库根目录（含 `wrangler.jsonc` 的那一层） |

保存后 Cloudflare 会自动跑一次构建并部署。

### 3. 首次打开

访问 `https://<你的项目名>.<子域>.workers.dev`，会出现**初始化页**，设置管理员用户名与密码即可进入。

---

## 二、⚠️ 两个必须知道的坑

### 坑 1：必须先开通 R2（最常见的部署失败原因）

新账号首次使用 R2 需要先同意条款。**到 Dashboard → R2 页面点一次「同意 / 开通」**，否则自动创建 bucket 会失败，部署报错。

### 坑 2：Dashboard 部署不会把资源 ID 写回仓库

通过 Dashboard（GitHub）部署时，R2 桶**会被自动创建并绑定**，但**生成的 ID 不会写回你的 `wrangler.jsonc`**，只能在 Dashboard 里查看。

这本身没问题 —— 只要一直用 Dashboard 部署就行。但如果你之后想改用本地 `npx wrangler deploy`，**必须先从 Dashboard 把桶名复制回配置**，例如：

```jsonc
"r2_buckets": [
  { "binding": "MY_BUCKET", "bucket_name": "cloud-notepad-my-bucket" }
]
```

否则 wrangler 会把它当成「没有绑定」**再创建一套新桶** —— 你会以为「线上数据全丢了」（其实是新桶是空的，旧数据还在旧桶里）。

---

## 三、Turnstile 人机验证：在应用内设置，不用碰控制台

登录后点左侧齿轮图标 → **设置 → 安全**，填入：

- **Site Key**（公开值，会完整回显）
- **Secret Key**（机密值，**永远只回显掩码**，留空表示不修改）

保存后**下次打开登录页时生效**（登录页是服务端渲染的）。

### 生效优先级

```
应用内设置（R2）  >  环境变量  >  关闭
```

- 两处都没配 → 人机验证自动关闭。**这是刻意的设计**，避免把自己锁在门外。
- 只配了一半（只有 Site Key 或只有 Secret Key）→ 视为未配置，静默关闭，不会出现「验证框加载不出来、却次次提示验证失败」的死循环。
- 如果只想用环境变量：`npx wrangler secret put TURNSTILE_SECRET_KEY` + 在 `wrangler.jsonc` 的 `vars` 里写 `TURNSTILE_SITE_KEY`。

### 容错模式（严格 / 宽松）

默认 **严格模式**，只对「非请求方原因」放行：

| 失败原因 | 严格模式 | 说明 |
| --- | --- | --- |
| 密钥填错、密钥失效、验证服务不可达 | ✅ 放行 + 醒目告警 | 请求方再努力也没用，攻击者也**无法制造**这种失败，所以放行不引入绕过路径 |
| 用户没完成验证 / token 无效 / token 过期 | ❌ 拦截 | 这是请求方自己的问题 |

密钥填错时**管理员依然能登录**（否则连「进设置页把密钥改回来」的入口都会被锁死），登录后主页顶部会保留一条橙色告警横幅。

「宽松模式」会放行所有验证失败，**仅供临时排障**，会明显降低防护强度。

### 自检

登录页底部有「**人机验证自检**」（设置页里也有）。它无需登录即可访问，会返回结论（`secret-ok` / `secret-invalid` / `not-configured` / `emergency-off` / `unreachable`）、掩码后的密钥、服务端错误码和具体修复建议。**排查时先点自检，别盲猜。**

### 破窗开关（彻底登不进去时的自救入口）

如果因为域名未授权（`110200`）、密钥填错等原因完全无法登录：

1. Cloudflare Dashboard → **R2 → 你的存储桶 → 添加对象**
2. 键名：`_sys_turnstile_off`，内容：`1`
3. 人机验证立即被强制关闭，可以正常登录了
4. 问题修好后**删除该对象**即可恢复（值为 `0` 或空串不生效）

---

## 四、本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 可选，填 Turnstile 密钥
npm run dev
```

`wrangler dev` 会**自动创建本地持久化 R2**（存在 `.wrangler/`），完全不碰线上数据。

```bash
npm run check   # 干跑构建，不部署，用来验证配置
npm run deploy  # 部署（需要先 wrangler login）
```

---

## 五、功能一览

**编辑器**
- CodeMirror 语法高亮（JS / TS / HTML / CSS / Markdown / Python / SQL / YAML / Shell / C 系）
- 自动保存（停止输入 1.5 秒）、自动换行、高亮当前行、字号调节（11–22px）
- 查找 / 替换（`Ctrl+F` / `Ctrl+H`）、`Ctrl+S` 保存、`Ctrl+Alt+N` 新建、`Ctrl+K` 文件管理
- 行 / 列 / 行数 / 字符数 / 语言实时状态栏
- 深色 / 浅色主题一键切换（跟随本地记忆）

**文件**
- 网格 / 列表双视图、按时间 / 名称 / 大小排序、即时搜索
- 重命名、复制一份、下载、删除、多选批量删除
- 右键菜单、未保存改动的二次确认
- 拖拽式多选（复选框）、总占用空间统计

**分享**
- 密码保护、有效期（1 小时 ~ 永久）、最大访问次数（阅后即焚）
- 生成后自动复制链接 + **二维码**（可保存为 PNG）
- 分享管理：卡片 / 列表双视图、访问次数统计、批量取消、右键快捷操作
- 分享页支持代码高亮、复制、下载；`.md` 可切换渲染预览，`.html` 可在**沙箱 iframe** 里预览

**设置中心**
- 安全：Turnstile 密钥、容错模式、自检、紧急开关说明
- 外观：主题、字号、自动保存 / 换行 / 高亮当前行、站点标题与副标题
- 账号：改用户名、改密码（改密后**其它设备上的会话立即失效**，当前设备保持登录）
- 数据：文件数 / 占用空间 / 活跃分享 / 累计访问，一键导出全部文件、清理过期分享

---

## 六、安全说明

| 项 | 实现 |
| --- | --- |
| 口令存储 | 加盐 SHA-256（`salt` 为 16 字节随机值），**不存明文**；v9.x 的明文配置在首次成功登录时自动升级 |
| 会话 | 服务端生成的 32 字节随机 token（64 位十六进制），存 R2，默认 30 天；`HttpOnly` + `Secure` + `SameSite=Lax`；登出即吊销 |
| 登录限流 | 同一 IP 15 分钟内失败 5 次锁定 15 分钟；锁定期间即使口令正确也拒绝；登录成功后清零 |
| 比较 | 恒定时间比较，避免时序侧信道 |
| 接口守卫 | 未登录的 API 请求返回 `401 JSON`（**不会 302 到 HTML 登录页**，避免前端 `res.json()` 解析 HTML 抛异常）；每个接口都有 try/catch，异常转 JSON |
| 注入 | 页面渲染对用户数据做 HTML 转义；嵌入 `<script>` 的数据统一转义 `<`；列表用 `createElement` + `textContent` 构建，不用 `innerHTML` 拼字符串 |
| 路径穿越 | 文件名中的 `/` `\` 被清洗，`_sys` 前缀为系统保留，禁止写入 / 删除 |
| 缓存 | API 一律 `Cache-Control: no-store`，HTML `no-cache` |

### ⚠️ 一个必须知道的取舍

**Cloudflare 的环境变量 Secret 是加密存储的，而 R2 里存的值不是。**

把 Turnstile 密钥放进应用内设置，换来的是「部署后完全不用碰控制台、改完立即生效」；代价是**失去了静态加密**（能访问你 R2 桶的人就能读到 Secret Key）。

如果你更看重这一点，改回读环境变量只需三步：
1. 在设置页点「清空全部密钥」
2. `npx wrangler secret put TURNSTILE_SECRET_KEY`
3. 在 `wrangler.jsonc` 的 `vars` 里加 `TURNSTILE_SITE_KEY`

代码里的三段式回退（设置 → env → 关闭）会自动生效，**不需要改代码**。

---

## 七、数据布局（R2 对象键）

| 键 | 内容 |
| --- | --- |
| `<任意文件名>` | 你的文件正文（纯文本） |
| `_sys_admin_config` | 管理员账号：`{ username, salt, passwordHash, createdAt, version }` |
| `_sys_settings.json` | 应用设置：Turnstile 密钥、容错模式、站点标题 |
| `_sys_shares.json` | 分享记录：`{ token: { fileId, password, expire, maxVisits, views, created } }` |
| `_sys_sess/<token>` | 会话：`{ u, exp, createdAt }` |
| `_sys_throttle/<ip>` | 登录失败计数 |
| `_sys_turnstile_off` | 破窗开关（内容为 `1` 时强制关闭人机验证） |

所有 `_sys` 开头的键都会从文件列表中过滤掉，也无法被删除。

---

## 八、从 v9.x 升级

直接把新代码推上去即可，**数据无需迁移**：

- `_sys_admin_config` 键名沿用；旧版明文口令在首次成功登录时自动升级为加盐哈希
- `_sys_shares.json` 结构向后兼容（新增字段都有默认值）
- 唯一的破坏性变化：绑定名从原来可能自定义的名字统一为 `MY_BUCKET`。如果你之前的配置用了别的名字（如 `NOTEPAD_BUCKET`），把 `wrangler.jsonc` 里的 `binding` 改成原来那个名字即可，代码只认 `MY_BUCKET`。

---

## 九、测试

```bash
npm test
```

用桩 R2 直接调用 Worker 的 `fetch`，覆盖 **182 项断言**：初始化 / 登录 / 限流 / 会话吊销、文件 CRUD / 重命名 / 复制 / 批量删除、分享创建 / 密码 / 过期 / 阅后即焚 / 联动清理、设置成对校验 / 掩码 / 清空、Turnstile 全部降级分支（含伪造错误码防绕过、破窗开关）、注入与转义、五个页面的内联脚本语法。

不需要 Cloudflare 账号，也不需要网络。

---

## 十、目录结构

```
cloud-notepad/
├── wrangler.jsonc          # 部署配置（r2_buckets 故意不写 bucket_name → 自动创建）
├── package.json
├── .dev.vars.example       # 本地开发用的密钥模板
├── src/
│   ├── index.js            # Worker 后端：路由、鉴权、设置、分享、Turnstile 容错
│   └── views/              # 前端整页 HTML，以「文本模块」导入
│       ├── app.html        # 主应用（编辑器 + 文件管理 + 分享 + 设置）
│       ├── login.html      # 登录页（含人机验证自检）
│       ├── setup.html      # 初始化页
│       ├── password.html   # 分享密码页
│       ├── share.html      # 公开分享页（高亮 / 预览 / 二维码）
│       └── error.html      # 错误页
└── tests/
    ├── run.mjs             # 182 项回归测试
    ├── register.mjs        # 让 Node 认识 .html 文本模块
    └── html-loader.mjs
```

> 前端 HTML 放在 `src/views/*.html` 里、以**文本模块**导入，而不是塞进 JS 模板字符串。
> 这样从根上避开了「模板字符串里一个反引号就把整个 Worker 弄崩」这类高频事故，也让 HTML / CSS 有正常的语法高亮和补全。
