当前功能：

📑 复制代码 - 复制到剪贴板

🗑️ 清空内容 - 清空编辑器

📊 实时统计 - 显示行数、字符数、关键字数、函数数

⚙️ 部署前必读：设置环境变量
请务必在 Cloudflare Worker 的设置 -> 变量/环境变量中添加以下两个变量：

KV 绑定：

变量名： CODE_KV (KV Namespace 的绑定变量名)

访问密码/令牌：

变量名： ACCESS_PASSWORD

值： 您希望设置的密码/令牌 (例如：mysecrettoken123)

界面现在更加简洁，用户可以直接输入自己的代码进行高亮处理。工具已经准备好部署到 Cloudflare Workers！

<img width="1549" height="1463" alt="image" src="https://github.com/user-attachments/assets/e6065c2b-c040-44f7-9991-d9802bcbdea3" />

