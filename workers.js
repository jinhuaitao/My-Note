/**
 * Workers.js 代码工具 - 仅保留代码编辑器，支持自定义名称保存。
 *
 * 验证模式：单访问令牌/密码 (ACCESS_PASSWORD)
 * 验证方式：URL参数 (?token=) 或 HTTP头 (X-Access-Token)
 * 状态码：未授权访问返回 403 Forbidden，以避免浏览器弹出原生 Basic Auth 弹窗。
 */

export default {
    async fetch(request, env, ctx) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        // 注意：现在 API 请求需要 Content-Type: application/json
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token', 
      };
  
      const url = new URL(request.url);
  
      // 0. 访问密码验证 (如果 ACCESS_PASSWORD 环境变量已设置)
      if (env.ACCESS_PASSWORD) {
          const expectedPassword = env.ACCESS_PASSWORD;
          // 尝试从请求头或 URL 参数中获取令牌
          const requestToken = request.headers.get('X-Access-Token') || url.searchParams.get('token');
  
          if (requestToken !== expectedPassword) {
              // 返回 403 Forbidden 页面和密码输入框，以阻止浏览器弹出原生的 Basic Auth 认证框。
              // Unauthorized Page 风格匹配 Subtle Depth
              const unauthorizedHtml = `<!DOCTYPE html>
              <html lang="zh-CN">
              <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>需要访问令牌</title>
                  <style>
                      body { 
                          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                          text-align: center; 
                          padding-top: 100px; 
                          background: #181920; /* Subtle Depth Primary BG */
                          color: #A9A9A9;
                      }
                      .box { 
                          background: #242731; /* Content Surface */
                          padding: 40px; 
                          border-radius: 16px; /* Larger border radius */
                          box-shadow: 0 10px 30px rgba(0,0,0,0.6); 
                          display: inline-block; 
                          max-width: 400px; 
                          border: 1px solid rgba(255, 255, 255, 0.05);
                      }
                      h2 { 
                          color: #c490ff; /* Accent Color */
                          margin-bottom: 25px; 
                          font-size: 1.8em;
                      }
                      p { margin-bottom: 15px; }
                      input[type="password"] { 
                          padding: 12px; 
                          margin: 10px 0; 
                          border: 1px solid #333; 
                          border-radius: 10px; 
                          width: 100%; 
                          box-sizing: border-box; 
                          background-color: #181920;
                          color: #F0F0F0;
                          font-size: 1em;
                          box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
                      }
                      button { 
                          padding: 12px 25px; 
                          background: linear-gradient(145deg, #c490ff, #aa78f5); /* Soft Gradient */
                          color: white; 
                          border: none; 
                          border-radius: 10px; 
                          cursor: pointer; 
                          transition: all 0.3s; 
                          font-weight: 700;
                          margin-top: 10px;
                          box-shadow: 0 4px 15px rgba(196, 144, 255, 0.4);
                      }
                      button:hover { 
                          background: linear-gradient(145deg, #aa78f5, #c490ff);
                          transform: translateY(-2px);
                          box-shadow: 0 6px 20px rgba(196, 144, 255, 0.6);
                      }
                      .hint {
                          font-size: 0.8em; 
                          color: #888; 
                          margin-top: 20px;
                      }
                  </style>
              </head>
              <body>
                  <div class="box">
                      <h2>🔒 访问受限</h2>
                      <p>请输入访问令牌/密码以继续操作。</p>
                      <form onsubmit="event.preventDefault(); window.location.href=window.location.pathname+'?token=' + document.getElementById('tokenInput').value;">
                          <input type="password" id="tokenInput" placeholder="访问令牌/密码" required>
                          <button type="submit">解锁</button>
                      </form>
                  </div>
              </body>
              </html>`;
              
              return new Response(unauthorizedHtml, {
                  status: 403, // 更改为 403 Forbidden
                  headers: {
                      'Content-Type': 'text/html; charset=UTF-8',
                      // 移除 WWW-Authenticate 头
                  },
              });
          }
      }
  
  
      // 1. 处理 CORS 预检
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: corsHeaders,
        });
      }
  
      // 2. API: 保存代码到 KV (POST /api/save)
      if (url.pathname === '/api/save' && request.method === 'POST') {
        try {
          if (!env.CODE_KV) {
            throw new Error('KV 未绑定，请在后台设置 CODE_KV');
          }
          
          // **!!! 关键修改：从请求 body 中解析 JSON 数据 !!!**
          const body = await request.json(); 
          const text = body.code;
          let customId = body.id; // 获取自定义 ID
          
          if (!text || text.trim().length === 0) {
            return new Response(JSON.stringify({ error: '内容不能为空' }), { status: 400, headers: corsHeaders });
          }
          
          let id;
          if (customId) {
            // 验证并清理 ID (仅允许字母数字、连字符和下划线，转为小写)
            customId = customId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
            
            if (customId.length < 3 || customId.length > 50) {
               return new Response(JSON.stringify({ error: '自定义名称长度须在 3-50 字符之间' }), { status: 400, headers: corsHeaders });
            }
            
            // 检查 ID 是否已存在 (如果存在则不允许覆盖)
            const existingCode = await env.CODE_KV.get(customId);
            if (existingCode !== null) {
              return new Response(JSON.stringify({ error: `名称 '${customId}' 已存在。请更换一个名称。` }), { status: 409, headers: corsHeaders });
            }
            id = customId;
          } else {
            // 生成 8 位随机 ID
            id = crypto.randomUUID().substring(0, 8);
          }
  
          // 存入 KV (默认过期时间 30 天)
          await env.CODE_KV.put(id, text, { expirationTtl: 60 * 60 * 24 * 30 });
          
          return new Response(JSON.stringify({ success: true, id: id }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          // 如果 JSON 解析失败，会进入这里
          return new Response(JSON.stringify({ error: err.message || '无效的请求格式，请确保内容是 JSON。' }), { status: 500, headers: corsHeaders });
        }
      }
  
      // 3. API: 获取代码 (GET /api/get?id=xxx)
      if (url.pathname === '/api/get' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (id && env.CODE_KV) {
          const code = await env.CODE_KV.get(id);
          if (code) {
            return new Response(JSON.stringify({ code: code }), {
               headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        }
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
      }
      
      // 4. API: 删除代码 (DELETE /api/delete?id=xxx)
      if (url.pathname === '/api/delete' && request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id) {
          return new Response(JSON.stringify({ error: '缺少 ID 参数' }), { status: 400, headers: corsHeaders });
        }
        if (!env.CODE_KV) {
            return new Response(JSON.stringify({ error: 'KV 未绑定' }), { status: 500, headers: corsHeaders });
        }
  
        try {
          await env.CODE_KV.delete(id);
          
          return new Response(JSON.stringify({ success: true, id: id }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
        }
      }
  
      // 5. API: 列出所有代码 ID (GET /api/list)
      if (url.pathname === '/api/list' && request.method === 'GET') {
        if (!env.CODE_KV) {
            return new Response(JSON.stringify({ error: 'KV 未绑定' }), { status: 500, headers: corsHeaders });
        }
        try {
          // 列出所有 Key，不获取 Value
          const listResult = await env.CODE_KV.list();
          
          const ids = listResult.keys.map(key => key.name);
  
          return new Response(JSON.stringify({ 
              success: true, 
              ids: ids, 
              list_complete: listResult.list_complete 
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
        }
      }
  
      // 6. 返回前端 HTML 页面
      const htmlContent = `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Workers.js 代码存储工具 - Subtle Depth</title>
      <style>
          /* --- 全局样式 (Subtle Depth Dark Mode) --- */
          *{margin:0;padding:0;box-sizing:border-box}
          :root {
              --bg-primary: #181920; /* Deep Indigo */
              --bg-secondary: #242731; /* Content Surface */
              --text-light: #EAEAEA;
              --text-dark: #A9A9C9;
              --accent-color: #c490ff; /* Soft Lavender (Main Action) */
              --primary-color: #00bcd4; /* Cyan (Secondary Focus) */
              --editor-bg: #1B1E25; 
              --editor-border: #333948;
              --key-input-bg: #21242c;
              --danger-color: #FF6B6B; /* Soft Red */
              --shadow-dark: rgba(0, 0, 0, 0.7);
              --shadow-light: rgba(255, 255, 255, 0.05);
          }
          body{
              font-family:'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
              background-color: var(--bg-primary);
              color: var(--text-dark);
              min-height:100vh;
              padding:30px 20px;
          }
          .container{
              max-width:1200px;
              margin:0 auto;
              background-color: var(--bg-secondary);
              border-radius:20px; 
              box-shadow:0 15px 40px var(--shadow-dark);
              overflow:hidden;
              display:flex;
              flex-direction:column;
              border: 1px solid var(--editor-border);
              transition: box-shadow 0.3s;
          }
          .container:hover {
              box-shadow: 0 15px 50px var(--shadow-dark), 0 0 10px rgba(196, 144, 255, 0.1);
          }
          /* --- Header --- */
          header{
              background: var(--bg-secondary);
              color: white;
              padding:30px 40px;
              text-align:left;
              border-bottom: 2px solid var(--accent-color); /* 紫罗兰色强调 */
          }
          header h1{
              font-size:2.5em;
              margin-bottom:5px;
              color: var(--text-light);
          }
          header p{
              font-size:1em;
              opacity:0.8;
              color: var(--accent-color);
              font-weight: 500;
          }
          /* --- Main Content --- */
          .main-content{
              padding:40px;
              flex-grow: 1;
              display: flex;
              flex-direction: column;
          } 
          .editor-section{
              background-color: var(--editor-bg);
              border-radius:18px;
              box-shadow:0 5px 15px var(--shadow-dark);
              overflow:hidden;
              display:flex;
              flex-direction:column;
              border: 1px solid var(--editor-border);
          }
          .section-header{
              background-color: var(--key-input-bg);
              color: var(--text-dark);
              padding:15px 25px;
              font-weight:400;
              display:flex;
              justify-content:space-between;
              align-items:center;
              font-family: monospace;
              border-bottom: 1px solid var(--editor-border);
              font-size: 0.95em;
              letter-spacing: 0.5px;
          }
          .section-header span:first-child {
              color: var(--text-light);
              font-weight: 600;
          }
          
          /* Key 输入区域样式 */
          .key-input-wrapper {
              padding: 15px 25px;
              background: var(--editor-bg);
              border-bottom: 1px solid var(--editor-border);
          }
          .key-input-wrapper label {
              font-size: 14px;
              font-weight: 500;
              color: var(--accent-color);
              display: block;
              margin-bottom: 8px;
          }
          #customKeyInput {
              width: 100%;
              padding: 12px;
              border: 1px solid var(--editor-border);
              border-radius: 10px;
              box-sizing: border-box;
              background-color: var(--key-input-bg);
              color: var(--text-light);
              font-family: monospace;
              box-shadow: inset 0 2px 5px var(--shadow-dark);
              transition: border-color 0.3s;
          }
          #customKeyInput:focus {
              border-color: var(--accent-color);
              box-shadow: inset 0 2px 5px var(--shadow-dark), 0 0 10px rgba(196, 144, 255, 0.3);
          }
  
          .editor-wrapper{
              padding:25px;
              height:65vh; 
              min-height:400px;
              overflow:auto;
              flex-grow:1;
          } 
          #codeInput{
              width:100%;
              height:100%;
              border:none; 
              border-radius:10px;
              padding:18px;
              font-family:"Fira Code","Consolas","Monaco",monospace; 
              font-size:15px;
              line-height: 1.5;
              resize:none;
              outline:none;
              background-color: var(--key-input-bg); 
              color: var(--text-light);
              box-shadow: inset 0 2px 8px var(--shadow-dark);
          }
          #codeInput:focus{
              box-shadow: inset 0 2px 8px var(--shadow-dark), 0 0 5px rgba(0, 188, 212, 0.1);
          }
          
          /* --- Scrollbar Styling (Minimalist Subtle Depth) --- */
          /* For Webkit Browsers (Chrome, Safari, Edge) */
          .editor-wrapper::-webkit-scrollbar,
          #codeInput::-webkit-scrollbar,
          .modal-body::-webkit-scrollbar,
          body::-webkit-scrollbar {
              width: 8px; /* 滚动条宽度 */
              height: 8px;
          }
          .editor-wrapper::-webkit-scrollbar-thumb,
          #codeInput::-webkit-scrollbar-thumb,
          .modal-body::-webkit-scrollbar-thumb,
          body::-webkit-scrollbar-thumb {
              /* 默认极低透明度，实现隐藏效果 */
              background-color: rgba(196, 144, 255, 0.15); 
              border-radius: 10px;
              transition: background-color 0.3s;
          }
          .editor-wrapper::-webkit-scrollbar-thumb:hover,
          #codeInput::-webkit-scrollbar-thumb:hover,
          .modal-body::-webkit-scrollbar-thumb:hover,
          body::-webkit-scrollbar-thumb:hover {
              background-color: var(--accent-color); /* 悬停时高亮 */
          }
          .editor-wrapper::-webkit-scrollbar-track,
          #codeInput::-webkit-scrollbar-track,
          .modal-body::-webkit-scrollbar-track,
          body::-webkit-scrollbar-track {
              background: transparent; /* 轨道透明 */
          }
          /* For Firefox */
          .editor-wrapper, #codeInput, .modal-body, body {
              scrollbar-width: thin; /* 窄 */
              scrollbar-color: rgba(196, 144, 255, 0.4) transparent; /* 拇指颜色 透明轨道 */
          }
          
          /* --- Controls (Buttons) --- */
          .controls{
              padding:30px 40px;
              background-color: var(--bg-secondary);
              border-top: 1px solid var(--editor-border);
              display:flex;
              gap:20px;
              flex-wrap:wrap;
              justify-content:center;
          }
          button{
              padding:14px 28px; 
              border:none;
              border-radius:12px; /* Smoother curves */
              font-size:16px;
              font-weight:700;
              cursor:pointer;
              transition:all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
              display:flex;
              align-items:center;
              gap:10px;
              text-shadow: 0 1px 2px rgba(0,0,0,0.3);
          }
          
          /* 按钮配色和动画优化 */
          .btn-success, .btn-primary {
              background: linear-gradient(160deg, var(--accent-color), #aa78f5);
              color: white;
              box-shadow: 0 6px 20px rgba(196, 144, 255, 0.3);
          }
          .btn-success:hover, .btn-primary:hover {
              background: linear-gradient(160deg, #aa78f5, var(--accent-color));
              transform:translateY(-2px);
              box-shadow:0 8px 25px rgba(196, 144, 255, 0.5);
          }
          .btn-success:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none;}
          
          .btn-secondary{
              background: var(--key-input-bg);
              color: var(--primary-color);
              border: 1px solid var(--editor-border);
              box-shadow: 0 4px 10px var(--shadow-dark);
          }
          .btn-secondary:hover{
              background:#333948;
              color: #99FFFF;
              transform:translateY(-2px);
              box-shadow:0 6px 15px var(--shadow-dark), 0 0 5px rgba(0, 188, 212, 0.4);
          }
          
          .btn-danger{
              background: var(--danger-color);
              color: white;
              box-shadow: 0 6px 20px rgba(255, 107, 107, 0.3);
          }
          .btn-danger:hover{
              background:#FF8585;
              transform:translateY(-2px);
              box-shadow:0 8px 25px rgba(255, 107, 107, 0.5);
          }
          .btn-danger:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none;}
          
          /* --- Toast & Loading --- */
          .toast{
              position:fixed;top:30px;right:30px;
              background:var(--accent-color);color:white;
              padding:15px 25px;border-radius:10px;
              box-shadow:0 5px 20px rgba(196, 144, 255, 0.3);
              opacity:0;transform:translateY(-30px);
              transition:all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1.25);
              z-index:1000;
              font-weight: 600;
          }
          .toast.error{
              background:var(--danger-color);
              box-shadow:0 5px 20px rgba(255, 107, 107, 0.3);
          }
          .toast.show{opacity:1;transform:translateY(0)}
          
          .loading-overlay{
              position:absolute;top:0;left:0;right:0;bottom:0;
              background:rgba(24, 25, 32, 0.9); 
              display:none;justify-content:center;align-items:center;
              z-index:10;
              border-radius: 8px; 
          }
          .spinner{
              width:40px;height:40px;
              border:4px solid var(--key-input-bg);
              border-top:4px solid var(--accent-color);
              border-radius:50%;
              animation:spin 1s linear infinite;
          }
          @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
          
          /* --- Modal Styles (Soft Glassmorphism List) --- */
          .modal-overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(18, 19, 25, 0.9); 
              display: none; 
              justify-content: center;
              align-items: center;
              z-index: 1000;
              backdrop-filter: blur(5px); 
          }
          .modal-overlay.active {
              display: flex;
          }
          .modal-content {
              background: var(--bg-secondary);
              color: var(--text-dark);
              padding: 30px;
              border-radius: 20px;
              width: 90%;
              max-width: 550px;
              max-height: 85vh;
              overflow: hidden;
              box-shadow: 0 20px 50px var(--shadow-dark);
              display: flex;
              flex-direction: column;
              border: 1px solid var(--editor-border);
          }
          .modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              border-bottom: 2px solid var(--primary-color);
              padding-bottom: 15px;
              margin-bottom: 15px;
          }
          .modal-header h2 {
              margin: 0;
              color: var(--text-light);
          }
          .close-btn {
              background: var(--danger-color);
              border: none;
              font-size: 20px;
              cursor: pointer;
              color: white;
              line-height: 1;
              transition: transform 0.3s, background 0.3s;
              width: 35px;
              height: 35px;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: 300;
              box-shadow: 0 4px 10px rgba(255, 107, 107, 0.3);
          }
          .close-btn:hover {
              transform: rotate(90deg) scale(1.1);
              background: #FF8585;
          }
          .modal-body {
              flex-grow: 1;
              overflow-y: auto;
              padding-right: 5px; 
          }
          .list-item {
              padding: 12px 10px;
              border-bottom: 1px solid #292c3a;
              cursor: pointer;
              color: var(--primary-color);
              font-family: monospace;
              font-weight: bold;
              transition: background 0.2s, color 0.2s;
              border-radius: 8px;
              margin-bottom: 5px;
          }
          .list-item:hover {
              background: #2a2d3b;
              color: var(--accent-color);
          }
          .list-empty, .list-hint {
              text-align: center;
              color: var(--text-dark);
              padding: 15px;
              font-size: 0.9em;
          }
          /* --- Media Queries --- */
          @media (max-width:768px){
              body{padding:10px}
              .container {
                  border-radius: 10px;
                  box-shadow: none;
              }
              .main-content{padding:15px}
              header{padding:20px}
              header h1{font-size:1.8em}
              .controls{flex-direction:column;align-items:stretch;padding:15px}
              button {justify-content: center;}
              .modal-content{max-height: 90vh; width: 95%;}
              .editor-wrapper{min-height: 300px; height: 50vh;}
          }
      </style>
  </head>
  <body>
      <div class="container">
          <header>
              <h1>🚀 记事本</h1>
              <p>基于 Cloudflare Workers KV 的记事本存储与共享工具</p>
          </header>
          
          <div class="main-content">
              <div class="editor-section">
                  <div class="section-header">
                      <span>📝 编辑器</span>
                      <span id="inputStats">0 行 · 0 字符</span>
                  </div>
                  
                  <div class="key-input-wrapper">
                      <label for="customKeyInput">自定义名称/ID (可选):</label>
                      <input type="text" id="customKeyInput" placeholder="例如: my-worker-function-v2 (不填则自动生成 ID)" maxlength="50">
                  </div>
  
                  <div class="editor-wrapper" style="position:relative">
                      <textarea id="codeInput" placeholder="在此输入您的代码..."></textarea>
                      <div id="loadingOverlay" class="loading-overlay"><div class="spinner"></div></div>
                  </div>
              </div>
              
          </div>
  
          <div class="controls">
              <button class="btn-success" id="btnSave" onclick="saveToCloud()"><span>☁️</span> 保存/分享</button>
              <button class="btn-secondary" onclick="copyCode()"><span>📑</span> 复制代码</button>
              <button class="btn-secondary" onclick="showSavedList()"><span>📋</span> 查看列表</button>
              <button class="btn-danger" id="btnDelete" onclick="deleteCodePrompt()" disabled>
                  <span>❌</span> 删除此代码
              </button>
              <button class="btn-danger" onclick="clearAll()"><span>🗑️</span> 清空内容</button>
          </div>
  
      </div>
      
      <div id="toast" class="toast"></div>
  
      <div id="listModal" class="modal-overlay">
          <div class="modal-content">
              <div class="modal-header">
                  <h2>已保存的代码片段 ID</h2>
                  <button class="close-btn" onclick="closeSavedList()">&times;</button>
              </div>
              <div id="listBody" class="modal-body">
                  <p class="list-empty">加载中...</p>
              </div>
              <div class="modal-footer">
                  <p class="list-hint">点击 ID 即可加载代码。</p>
              </div>
          </div>
      </div>
  
      <script>
          let highlightTimeout;
  
          function getLoadedId() {
              const urlParams = new URLSearchParams(window.location.search);
              return urlParams.get('id');
          }
  
          function getAuthToken() {
              const urlParams = new URLSearchParams(window.location.search);
              return urlParams.get('token');
          }
  
          function updateDeleteButton() {
              const id = getLoadedId();
              const btnDelete = document.getElementById("btnDelete");
              
              if (id) {
                  btnDelete.disabled = false;
                  btnDelete.title = '删除当前加载的代码片段 (ID: ' + id + ')';
              } else {
                  btnDelete.disabled = true;
                  btnDelete.title = '请先通过链接加载代码才能删除';
              }
          }
  
          document.addEventListener("DOMContentLoaded", function(){
              const codeInput=document.getElementById("codeInput");
              codeInput.addEventListener("input",handleInput);
              
              const id = getLoadedId();
              if(id){
                  loadCodeFromCloud(id);
              }
              
              updateDeleteButton();
          });
  
          function handleInput(){
              clearTimeout(highlightTimeout);
              // 延迟更新字符统计信息
              highlightTimeout=setTimeout(function(){updateInputStats()},200);
          }
  
          // --- List Functions ---
          function showSavedList() {
              const modal = document.getElementById('listModal');
              modal.classList.add('active');
              fetchSavedList();
          }
  
          function closeSavedList() {
              document.getElementById('listModal').classList.remove('active');
          }
  
          async function fetchSavedList() {
              const listBody = document.getElementById('listBody');
              listBody.innerHTML = '<p class="list-empty">加载中... <div class="spinner" style="margin:10px auto; border-top-color:#00bcd4;"></div></p>';
              
              const token = getAuthToken();
              const headers = token ? { 'X-Access-Token': token } : {};
  
              try {
                  const response = await fetch('/api/list', { headers });
                  const data = await response.json();
  
                  if (response.ok && data.success) {
                      if (data.ids && data.ids.length > 0) {
                          listBody.innerHTML = '';
                          data.ids.forEach(id => {
                              const item = document.createElement('div');
                              item.className = 'list-item';
                              item.textContent = id;
                              item.onclick = () => {
                                  const tokenParam = token ? '&token=' + token : '';
                                  window.location.href = window.location.pathname + '?id=' + id + tokenParam;
                                  closeSavedList();
                              };
                              listBody.appendChild(item);
                          });
                          
                          if (!data.list_complete) {
                              const hint = document.createElement('p');
                              hint.style.cssText = 'font-size:0.8em; color:#FFC0CB; margin-top:10px; text-align:center;';
                              hint.textContent = '注意：列表可能不完整（Cloudflare KV限制）。';
                              listBody.appendChild(hint);
                          }
  
                      } else {
                          listBody.innerHTML = '<p class="list-empty">暂无保存的代码片段。</p>';
                      }
                  } else {
                      listBody.innerHTML = '<p class="list-empty" style="color:#FF6B6B;">加载列表失败: ' + (data.error || 'API 错误') + '</p>';
                  }
              } catch (e) {
                  listBody.innerHTML = '<p class="list-empty" style="color:#FF6B6B;">网络连接失败或 KV 未正确绑定。</p>';
              }
          }
          // --- End List Functions ---
          
          function getAuthHeaders(includeContentType = true) {
              const token = getAuthToken();
              const headers = {};
              if (token) headers['X-Access-Token'] = token;
              // 注意: 在 saveToCloud 中我们会手动设置 Content-Type: application/json
              // 在其他 API (GET/DELETE/LIST) 中不需要 Content-Type
              return headers; 
          }
  
          async function saveToCloud() {
              const code = document.getElementById("codeInput").value;
              // **!!! 关键修改：获取自定义 Key/ID !!!**
              const customKey = document.getElementById("customKeyInput").value.trim(); 
  
              if(!code.trim()) {
                  showToast("内容为空，无法保存", true);
                  return;
              }
  
              const btn = document.getElementById("btnSave");
              const originalText = btn.innerHTML;
              btn.innerHTML = '<span>⏳</span> 保存中...';
              btn.disabled = true;
  
              try {
                  // 设置 headers
                  const headers = getAuthHeaders();
                  headers['Content-Type'] = 'application/json'; // 必须指定 JSON
  
                  // 构建 payload
                  const payload = {
                      code: code
                  };
                  if (customKey) {
                      payload.id = customKey; // 将自定义 Key 加入 payload
                  }
                  
                  const response = await fetch('/api/save', {
                      method: 'POST',
                      headers: headers,
                      body: JSON.stringify(payload) // 发送 JSON
                  });
                  
                  const data = await response.json();
                  
                  if(response.ok && data.success) { // 检查 response.ok 确保 4xx 错误也被捕获
                      const tokenParam = getAuthToken() ? '&token=' + getAuthToken() : '';
                      const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?id=' + data.id + tokenParam;
                      window.history.pushState({path:newUrl},'',newUrl);
                      
                      navigator.clipboard.writeText(newUrl);
                      showToast("已保存！分享链接已复制 (ID: " + data.id + ")");
                      updateDeleteButton();
                      // 清空自定义 Key 输入框
                      document.getElementById("customKeyInput").value = '';
                  } else {
                      showToast("保存失败: " + (data.error || "未知错误"), true);
                  }
              } catch(e) {
                  showToast("网络错误或请求格式错误: " + e.message, true);
              } finally {
                  btn.innerHTML = originalText;
                  btn.disabled = false;
              }
          }
  
          async function loadCodeFromCloud(id) {
              const loader = document.getElementById("loadingOverlay");
              loader.style.display = "flex";
              
              const token = getAuthToken();
              const tokenParam = token ? '&token=' + token : {};
              const headers = token ? { 'X-Access-Token': token } : {};
  
              try {
                  const response = await fetch('/api/get?id=' + id + tokenParam, { headers });
                  if(response.ok) {
                      const data = await response.json();
                      document.getElementById("codeInput").value = data.code;
                      updateInputStats();
                      showToast("代码加载成功 (ID: " + id + ")");
                      document.getElementById("customKeyInput").value = id; // 加载时填入自定义 Key 框
                  } else {
                      showToast("未找到指定的代码片段或认证失败", true);
                      clearAll(true);
                  }
              } catch(e) {
                  showToast("加载失败: " + e.message, true);
              } finally {
                  loader.style.display = "none";
                  updateDeleteButton();
              }
          }
  
          function deleteCodePrompt() {
              const id = getLoadedId();
              if (!id) return;
  
              if (confirm("⚠️ 确认删除？此操作不可逆，代码片段 ID: " + id)) {
                  deleteCodeFromCloud(id);
              }
          }
  
          async function deleteCodeFromCloud(id) {
              const btn = document.getElementById("btnDelete");
              const originalText = btn.innerHTML;
              btn.innerHTML = '<span>⏳</span> 删除中...';
              btn.disabled = true;
  
              try {
                  const headers = getAuthHeaders();
                  const response = await fetch('/api/delete?id=' + id, {
                      method: 'DELETE',
                      headers: headers
                  });
                  
                  const data = await response.json();
                  
                  if (response.ok && data.success) {
                      showToast("删除成功！代码片段 " + id + " 已从 KV 空间移除。");
                      clearAll(true);
                  } else {
                      showToast("删除失败: " + (data.error || "未知错误"), true);
                  }
              } catch(e) {
                  showToast("网络错误: " + e.message, true);
              } finally {
                  btn.innerHTML = originalText;
                  updateDeleteButton();
              }
          }
          
          function updateInputStats(){
              const code=document.getElementById("codeInput").value;
              // 修正：在 JS 中，换行符是 \\n，但为了统计行数，split 应该用原始的换行符
              const lines=code.split('\\n').length; 
              const chars=code.length;
              document.getElementById("inputStats").textContent=lines+" 行 · "+chars+" 字符"
          }
  
          function copyCode(){
              const code=document.getElementById("codeInput").value;
              if(!code) return;
              navigator.clipboard.writeText(code).then(function(){
                  showToast("代码已复制到剪贴板！")
              }).catch(function(){
                  const textarea=document.createElement("textarea");
                  textarea.value=code;
                  document.body.appendChild(textarea);
                  textarea.select();
                  document.execCommand("copy");
                  document.body.removeChild(textarea);
                  showToast("代码已复制到剪贴板！")
              })
          }
  
          function clearAll(skipToast){
              document.getElementById("codeInput").value="";
              document.getElementById("customKeyInput").value=""; // 清空自定义 Key 输入框
              
              // 重置统计信息
              document.getElementById("inputStats").textContent="0 行 · 0 字符";
              
              // 清除 URL 参数 (保留 token)
              const token = getAuthToken();
              let newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
              if (token) {
                  newUrl += '?token=' + token;
              }
              window.history.pushState({path:newUrl},'',newUrl);
              
              updateDeleteButton();
              
              if (!skipToast) showToast("内容已清空！")
          }
  
          function showToast(message, isError){
              const toast=document.getElementById("toast");
              toast.textContent=message;
              if(isError) toast.classList.add("error");
              else toast.classList.remove("error");
              
              toast.classList.add("show");
              setTimeout(function(){toast.classList.remove("show"); toast.classList.remove("error");},3000)
          }
      </script>
  </body>
  </html>`;
  
      return new Response(htmlContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          ...corsHeaders,
        },
      });
    }
  };
