/**
 * Workers.js 代码高亮工具 + KV 存储、删除与列表功能 (最终版)
 * * 部署前必读：
 * 1. 在 Cloudflare 创建 KV Namespace。
 * 2. 在 Worker 设置中绑定 KV，变量名为: CODE_KV (必须完全一致)
 */

export default {
    async fetch(request, env, ctx) {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
  
      const url = new URL(request.url);
  
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
          const text = await request.text();
          if (!text || text.trim().length === 0) {
            return new Response(JSON.stringify({ error: '内容不能为空' }), { status: 400, headers: corsHeaders });
          }
          
          // 生成 8 位随机 ID
          const id = crypto.randomUUID().substring(0, 8);
          
          // 存入 KV (默认过期时间 30 天)
          await env.CODE_KV.put(id, text, { expirationTtl: 60 * 60 * 24 * 30 });
          
          return new Response(JSON.stringify({ success: true, id: id }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
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
      <title>Workers.js 代码高亮工具</title>
      <style>
          *{margin:0;padding:0;box-sizing:border-box}
          body{font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px}
          .container{max-width:1400px;margin:0 auto;background:rgba(255,255,255,0.95);border-radius:15px;box-shadow:0 20px 40px rgba(0,0,0,0.1);overflow:hidden}
          header{background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white;padding:30px;text-align:center;position:relative}
          header h1{font-size:2.5em;margin-bottom:10px;text-shadow:2px 2px 4px rgba(0,0,0,0.3)}
          header p{font-size:1.2em;opacity:0.9}
          .main-content{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:30px}
          .editor-section,.preview-section{background:white;border-radius:10px;box-shadow:0 5px 15px rgba(0,0,0,0.08);overflow:hidden;display:flex;flex-direction:column}
          .section-header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:15px 20px;font-weight:bold;display:flex;justify-content:space-between;align-items:center}
          .editor-wrapper,.preview-wrapper{padding:20px;height:500px;overflow:auto;flex-grow:1}
          #codeInput{width:100%;height:100%;border:2px solid #e0e0e0;border-radius:8px;padding:15px;font-family:"Consolas","Monaco","Courier New",monospace;font-size:14px;resize:none;outline:none;transition:border-color 0.3s}
          #codeInput:focus{border-color:#667eea}
          #highlightedOutput{width:100%;height:100%;border:2px solid #e0e0e0;border-radius:8px;padding:15px;font-family:"Consolas","Monaco","Courier New",monospace;font-size:14px;background:#f8f9fa;overflow:auto;white-space:pre-wrap;word-wrap:break-word}
          .controls{padding:20px 30px;background:#f8f9fa;display:flex;gap:15px;flex-wrap:wrap;justify-content:center}
          button{padding:12px 24px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:all 0.3s;display:flex;align-items:center;gap:8px}
          
          .btn-primary{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}
          .btn-primary:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(102,126,234,0.4)}
          
          .btn-secondary{background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white}
          .btn-secondary:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(240,147,251,0.4)}
          
          .btn-danger{background:linear-gradient(135deg,#ff6b6b 0%,#ee5a24 100%);color:white}
          .btn-danger:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(255,107,107,0.4)}
          .btn-danger:disabled{opacity:0.7;cursor:not-allowed;transform:none}
          
          .btn-success{background:linear-gradient(135deg,#42e695 0%,#3bb2b8 100%);color:white}
          .btn-success:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(66,230,149,0.4)}
          .btn-success:disabled{opacity:0.7;cursor:not-allowed;transform:none}
  
          .stats{padding:20px 30px;background:white;display:flex;justify-content:space-around;border-top:1px solid #e0e0e0}
          .stat-item{text-align:center}
          .stat-value{font-size:24px;font-weight:bold;color:#667eea;display:block}
          .stat-label{color:#666;font-size:14px;margin-top:5px}
          
          .keyword{color:#d73a49;font-weight:bold}
          .function{color:#6f42c1}
          .string{color:#032f62}
          .comment{color:#6a737d;font-style:italic}
          .number{color:#005cc5}
          .workers-specific{color:#e36209;font-weight:bold}
          .bracket{color:#24292e;font-weight:bold}
          .operator{color:#d73a49}
          
          .toast{position:fixed;top:20px;right:20px;background:#28a745;color:white;padding:15px 20px;border-radius:8px;box-shadow:0 5px 15px rgba(0,0,0,0.2);opacity:0;transform:translateY(-20px);transition:all 0.3s;z-index:1000}
          .toast.error{background:#dc3545}
          .toast.show{opacity:1;transform:translateY(0)}
          
          .loading-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.8);display:none;justify-content:center;align-items:center;z-index:10}
          .spinner{width:40px;height:40px;border:4px solid #f3f3f3;border-top:4px solid #667eea;border-radius:50%;animation:spin 1s linear infinite}
          @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
          
          /* New Modal Styles for List */
          .modal-overlay {
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0, 0, 0, 0.6);
              display: none; /* 默认隐藏 */
              justify-content: center;
              align-items: center;
              z-index: 1000;
          }
          .modal-overlay.active {
              display: flex;
          }
          .modal-content {
              background: white;
              padding: 20px;
              border-radius: 10px;
              width: 90%;
              max-width: 600px;
              max-height: 80vh;
              overflow: hidden;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
              display: flex;
              flex-direction: column;
          }
          .modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              border-bottom: 1px solid #eee;
              padding-bottom: 10px;
              margin-bottom: 10px;
          }
          .modal-header h2 {
              margin: 0;
              color: #667eea;
          }
          .close-btn {
              background: none;
              border: none;
              font-size: 24px;
              cursor: pointer;
              color: #999;
              line-height: 1;
          }
          .close-btn:hover {
              color: #333;
          }
          .modal-body {
              flex-grow: 1;
              overflow-y: auto;
              padding-right: 5px; 
          }
          .list-item {
              padding: 8px 10px;
              border-bottom: 1px dashed #eee;
              cursor: pointer;
              color: #005cc5;
              font-family: monospace;
              font-weight: bold;
              transition: background 0.2s;
          }
          .list-item:hover {
              background: #f8f9fa;
              text-decoration: underline;
          }
          .list-empty, .list-hint {
              text-align: center;
              color: #999;
              padding: 10px;
              font-size: 0.9em;
          }
          @media (max-width:768px){
              .main-content{grid-template-columns:1fr}
              header h1{font-size:2em}
              .controls{flex-direction:column;align-items:stretch}
              .modal-content{max-height: 90vh; width: 95%;}
          }
      </style>
  </head>
  <body>
      <div class="container">
          <header>
              <h1>🚀 Workers.js 代码高亮工具</h1>
              <p>专为 Cloudflare Workers.js 设计的在线代码高亮和格式化工具</p>
          </header>
          
          <div class="main-content">
              <div class="editor-section">
                  <div class="section-header">
                      <span>📝 代码编辑器</span>
                      <span id="inputStats">0 行 · 0 字符</span>
                  </div>
                  <div class="editor-wrapper" style="position:relative">
                      <textarea id="codeInput" placeholder="在此输入您的 Workers.js 代码..."></textarea>
                      <div id="loadingOverlay" class="loading-overlay"><div class="spinner"></div></div>
                  </div>
              </div>
              
              <div class="preview-section">
                  <div class="section-header">
                      <span>🎨 高亮预览</span>
                      <span id="outputStats">0 行 · 0 关键字</span>
                  </div>
                  <div class="preview-wrapper">
                      <div id="highlightedOutput"></div>
                  </div>
              </div>
          </div>
  
          <div class="controls">
              <button class="btn-primary" onclick="highlightCode()"><span>✨</span> 高亮代码</button>
              <button class="btn-success" id="btnSave" onclick="saveToCloud()"><span>☁️</span> 保存/分享</button>
              <button class="btn-secondary" onclick="copyCode()"><span>📑</span> 复制代码</button>
              <button class="btn-secondary" onclick="showSavedList()"><span>📋</span> 查看列表</button>
              <button class="btn-danger" id="btnDelete" onclick="deleteCodePrompt()" disabled>
                  <span>❌</span> 删除此代码
              </button>
              <button class="btn-danger" onclick="clearAll()"><span>🗑️</span> 清空内容</button>
          </div>
  
          <div class="stats">
              <div class="stat-item"><span class="stat-value" id="lineCount">0</span><div class="stat-label">行数</div></div>
              <div class="stat-item"><span class="stat-value" id="charCount">0</span><div class="stat-label">字符数</div></div>
              <div class="stat-item"><span class="stat-value" id="keywordCount">0</span><div class="stat-label">关键字数</div></div>
              <div class="stat-item"><span class="stat-value" id="functionCount">0</span><div class="stat-label">函数数</div></div>
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
          const jsKeywords=["break","case","catch","class","const","continue","debugger","default","delete","do","else","export","extends","false","finally","for","function","if","import","in","instanceof","let","new","null","return","super","switch","this","throw","true","try","typeof","var","void","while","with","yield","async","await"];
          const workersObjects=["addEventListener","removeEventListener","fetch","request","response","Request","Response","Headers","URL","URLSearchParams","DurableObject","KVNamespace","R2Bucket","Cache","crypto","console","setTimeout","clearTimeout","setInterval","clearInterval","atob","btoa","WebSocket","TransformStream","ReadableStream","WritableStream","env","ctx","waitUntil"];
          let highlightTimeout;
  
          function getLoadedId() {
              const urlParams = new URLSearchParams(window.location.search);
              return urlParams.get('id');
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
              codeInput.addEventListener("keydown",handleKeydown);
              
              const id = getLoadedId();
              if(id){
                  loadCodeFromCloud(id);
              }
              
              updateDeleteButton();
          });
  
          function handleInput(){
              clearTimeout(highlightTimeout);
              updateInputStats();
              highlightTimeout=setTimeout(function(){highlightCode()},500);
          }
  
          function handleKeydown(e){
              if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();highlightCode()}
              else if((e.ctrlKey||e.metaKey)&&e.key==="l"){e.preventDefault();clearAll()}
              else if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key==="C"){e.preventDefault();copyCode()}
              else if((e.ctrlKey||e.metaKey)&&e.key==="s"){e.preventDefault();saveToCloud()} // Ctrl+S 保存
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
              listBody.innerHTML = '<p class="list-empty">加载中... <div class="spinner" style="margin:10px auto;"></div></p>';
  
              try {
                  const response = await fetch('/api/list');
                  const data = await response.json();
  
                  if (response.ok && data.success) {
                      if (data.ids && data.ids.length > 0) {
                          listBody.innerHTML = '';
                          data.ids.forEach(id => {
                              const item = document.createElement('div');
                              item.className = 'list-item';
                              item.textContent = id;
                              item.onclick = () => {
                                  // 加载代码并关闭 Modal
                                  window.location.href = window.location.pathname + '?id=' + id;
                                  closeSavedList();
                              };
                              listBody.appendChild(item);
                          });
                          
                          if (!data.list_complete) {
                              const hint = document.createElement('p');
                              hint.style.cssText = 'font-size:0.8em; color:orange; margin-top:10px; text-align:center;';
                              hint.textContent = '注意：列表可能不完整（Cloudflare KV限制）。';
                              listBody.appendChild(hint);
                          }
  
                      } else {
                          listBody.innerHTML = '<p class="list-empty">暂无保存的代码片段。</p>';
                      }
                  } else {
                      listBody.innerHTML = '<p class="list-empty" style="color:red;">加载列表失败: ' + (data.error || 'API 错误') + '</p>';
                  }
              } catch (e) {
                  listBody.innerHTML = '<p class="list-empty" style="color:red;">网络连接失败或 KV 未正确绑定。</p>';
              }
          }
          // --- End List Functions ---
  
          async function saveToCloud() {
              const code = document.getElementById("codeInput").value;
              if(!code.trim()) {
                  showToast("内容为空，无法保存", true);
                  return;
              }
  
              const btn = document.getElementById("btnSave");
              const originalText = btn.innerHTML;
              btn.innerHTML = '<span>⏳</span> 保存中...';
              btn.disabled = true;
  
              try {
                  const response = await fetch('/api/save', {
                      method: 'POST',
                      body: code
                  });
                  const data = await response.json();
                  
                  if(data.success) {
                      const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?id=' + data.id;
                      window.history.pushState({path:newUrl},'',newUrl);
                      
                      navigator.clipboard.writeText(newUrl);
                      showToast("已保存！分享链接已复制");
                      updateDeleteButton();
                  } else {
                      showToast("保存失败: " + (data.error || "未知错误"), true);
                  }
              } catch(e) {
                  showToast("网络错误: " + e.message, true);
              } finally {
                  btn.innerHTML = originalText;
                  btn.disabled = false;
              }
          }
  
          async function loadCodeFromCloud(id) {
              const loader = document.getElementById("loadingOverlay");
              loader.style.display = "flex";
              
              try {
                  const response = await fetch('/api/get?id=' + id);
                  if(response.ok) {
                      const data = await response.json();
                      document.getElementById("codeInput").value = data.code;
                      highlightCode();
                      updateInputStats();
                      showToast("代码加载成功");
                  } else {
                      showToast("未找到指定的代码片段", true);
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
                  const response = await fetch('/api/delete?id=' + id, {
                      method: 'DELETE'
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
          
          function highlightCode(){
              const code=document.getElementById("codeInput").value;
              if(!code.trim()){
                  document.getElementById("highlightedOutput").innerHTML="";
                  updateStats(0,0,0,0);
                  return
              }
              let highlighted=code;
              let keywordCount=0;
              let functionCount=0;
              
              highlighted=highlighted.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
              
              // Comments
              highlighted=highlighted.replace(/\\/\\/.*$/gm,function(match){return '<span class="comment">'+match+'</span>'});
              highlighted=highlighted.replace(/\\/\\*[\\s\\S]*?\\*\\//g,function(match){return '<span class="comment">'+match+'</span>'});
              
              // Strings
              const stringRegex=new RegExp('(["\\\'“])((?:\\\\\\\\.|(?!\\\\1)[^\\\\\\\\])*)\\\\1','g');
              highlighted=highlighted.replace(stringRegex,'<span class="string">$1$2$1</span>');
              
              // Numbers
              highlighted=highlighted.replace(/\\b(\\d+\\.?\\d*)\\b/g,'<span class="number">$1</span>');
              
              // Workers Objects
              workersObjects.forEach(function(obj){
                  const regex=new RegExp('\\\\\\\\b'+obj+'\\\\\\\\b','g');
                  highlighted=highlighted.replace(regex,'<span class="workers-specific">'+obj+'</span>')
              });
              
              // Keywords
              jsKeywords.forEach(function(keyword){
                  const regex=new RegExp('\\\\\\\\b'+keyword+'\\\\\\\\b','g');
                  highlighted=highlighted.replace(regex,function(match){keywordCount++;return '<span class="keyword">'+match+'</span>'})
              });
              
              // Functions
              highlighted=highlighted.replace(/\\b([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*\\(/g,'<span class="function">$1</span>(');
              functionCount=(highlighted.match(/<span class="function">/g)||[]).length;
              
              // Brackets
              highlighted=highlighted.replace(/([{}()\\[\\]])/g,'<span class="bracket">$1</span>');
              
              // Operators
              const operators=["+","-","*","/","==","===","!=","!==",">","<",">=","<=","&&","||","!","++","--","%","&","|","^","~","<<",">>",">>>","+=","-=","*=","/=","%=","&=","|=","^=","<<=",">>=",">>>="];
              operators.forEach(function(op){
                  // FIX: 使用十六进制编码避免在 Workers 模板字符串中的解析错误
                  // 字符 [ 和 ] 的十六进制编码为 \x5b 和 \x5d
                  const escapedOp = op.replace(/[.*+?^\\$()|\\x5b\\x5d\\x5c]/g, '\\\\$&');
                  const regex=new RegExp('\\\\\\\\s*('+escapedOp+')\\\\\\\\s*','g');
                  highlighted=highlighted.replace(regex,' <span class="operator">$1</span> ')
              });
              
              document.getElementById("highlightedOutput").innerHTML=highlighted;
              
              const lines=code.split('\\n').length;
              const chars=code.length;
              updateStats(lines,chars,keywordCount,functionCount);
          }
  
          function updateStats(lines,chars,keywords,functions){
              document.getElementById("lineCount").textContent=lines;
              document.getElementById("charCount").textContent=chars;
              document.getElementById("keywordCount").textContent=keywords;
              document.getElementById("functionCount").textContent=functions
          }
  
          function updateInputStats(){
              const code=document.getElementById("codeInput").value;
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
              document.getElementById("highlightedOutput").innerHTML="";
              updateStats(0,0,0,0);
              document.getElementById("inputStats").textContent="0 行 · 0 字符";
              document.getElementById("outputStats").textContent="0 行 · 0 关键字";
              
              // 清除 URL 参数
              const url = window.location.protocol + "//" + window.location.host + window.location.pathname;
              window.history.pushState({path:url},'',url);
              
              updateDeleteButton();
              
              if (!skipToast) showToast("内容已清空！")
          }
  
          function showToast(message, isError){
              const toast=document.getElementById("toast");
              toast.textContent=message;
              if(isError) toast.classList.add("error");
              else toast.classList.remove("error");
              
              toast.classList.add("show");
              setTimeout(function(){toast.classList.remove("show")},3000)
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
