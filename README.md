# 这是一个基于 Cloudflare Workers 和 Cloudflare R2 的云端笔记/代码片段管理工具（Cloud Note）。

它具有以下特点：

无服务器架构：完全运行在 Cloudflare 边缘网络。

R2 存储：文件内容、配置、分享记录都保存在 R2 对象存储中。

安全验证：集成 Cloudflare Turnstile 人机验证。

分享功能：支持创建带有密码、有效期和访问次数限制的分享链接。

以下是详细的部署教程：

# 第一步：准备工作
你需要一个 Cloudflare 账号。如果没有，请前往 dash.cloudflare.com 注册。

# 第二步：创建 R2 存储桶 (Bucket)
这个存储桶将用来存放你的所有笔记和系统配置文件。

登录 Cloudflare 控制台，在左侧菜单点击 R2。

点击 Create bucket (创建存储桶)。

给存储桶起个名字，例如 my-notepad-storage（名字需唯一）。

点击 Create bucket 确认创建。

注意：你不需要开启“公开访问”，Worker 会处理所有的读写权限。

# 第三步：获取 Turnstile 密钥 (可选，但推荐)
代码中集成了 Turnstile 用于登录时的验证码防护。

在 Cloudflare 控制台左侧菜单点击 Turnstile。

点击 Add widget (添加站点)。

Site name: 随便填（例如 Notepad）。

Domain: 填写 workers.dev (或者如果你打算绑定自定义域名，就填你的域名)。

Widget Mode: 选择 Managed (推荐) 或 Non-interactive。

点击 Create。

重要：复制并保存好 Site Key 和 Secret Key，稍后要用。

# 第四步：创建 Cloudflare Worker
在左侧菜单点击 Workers & Pages -> Overview。

点击 Create application -> Create Worker。

给 Worker 起个名字，例如 my-pad，点击 Deploy (先部署个空代码也没事)。

点击 Edit code 进入代码编辑页面。

# 第五步：部署代码
在代码编辑器中，删除默认的 Hello World 代码。

将你提供的 my-pad.js 文件中的所有内容复制并粘贴进去。

点击右上角的 Save and deploy。

# 第六步：绑定变量 (关键步骤)
代码无法直接运行，因为它需要知道去哪里存数据以及验证码的密钥。

退回到 Worker 的详细页面（点击左上角的箭头或重新进入 Workers 列表点击你的 Worker）。

点击顶部的 Settings (设置) 选项卡。

点击 Variables (变量)。

## 1. 绑定 R2 存储桶
向下滚动到 R2 Bucket Bindings 区域。

点击 Add binding。

Variable name (变量名): 必须填写 MY_BUCKET (注意：必须完全一致，大小写敏感，因为代码里写的是 env.MY_BUCKET)。

R2 Bucket: 选择你在“第二步”中创建的存储桶 (my-notepad-storage)。

点击 Deploy 保存。

## 2. 绑定 Turnstile 环境变量 (可选，但推荐)
在同一个页面，向上滚动到 Environment Variables 区域。

点击 Add variable。

添加以下两个变量：

变量名: TURNSTILE_SITE_KEY，值: (填入第三步获取的 Site Key)

变量名: TURNSTILE_SECRET_KEY，值: (填入第三步获取的 Secret Key)

##点击 Deploy 保存。

注意：如果你不想用 Turnstile，可以在环境变量中不添加这两个 Key，或者去代码里把相关逻辑删掉，但建议保留以增加安全性。

# 第七步：初始化系统
点击 Worker 页面上的 Visit 链接（或者直接访问你的 xxx.workers.dev 域名）。（如添加Turnstile验证，请先绑定域名【Turnstile添加的域名】）

第一次访问时，系统检测到没有配置文件，会自动跳转到 初始化页面。

设置你的 管理员用户名 和 密码。

点击确定，系统会自动登录并跳转到主界面。

使用说明
新建/保存：左侧侧边栏有新建和保存按钮，支持 Ctrl+S / Cmd+S 快捷键。

文件管理：点击侧边栏的“列表”图标可以查看、搜索、下载或删除 R2 中的文件。

分享功能：

点击“分享”图标，可以设置密码、有效期（1天、7天等）、最大访问次数（阅后即焚）。

分享出去的链接是独立的，访客无需登录即可查看（受你设置的权限限制）。

原始文件访问：如果你需要作为图床或代码托管使用，可以在分享时勾选“公开”，生成的链接支持 Raw 模式访问。
