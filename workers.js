/**
 * Workers + R2 NotePad (v9.3 Smart Memory)
 * 优化：创建分享时，自动记忆上次使用的选项（有效期、次数限制等）
 * 基础：包含 v9.2 的所有功能
 */

const CONFIG_KEY = '_sys_admin_config'; 
const SHARES_DB_KEY = '_sys_shares.json'; 
const SESSION_COOKIE_NAME = 'np_sess';  
const SESSION_DURATION = 60 * 60 * 24 * 7; 

// --- Favicon ---
const FAVICON_TAG = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237c4dff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'%3E%3C/path%3E%3Cpolyline points='14 2 14 8 20 8'%3E%3C/polyline%3E%3Cline x1='16' y1='13' x2='8' y2='13'%3E%3C/line%3E%3Cline x1='16' y1='17' x2='8' y2='17'%3E%3C/line%3E%3Cline x1='10' y1='9' x2='8' y2='9'%3E%3C/line%3E%3C/svg%3E">`;

// --- 后端逻辑 ---
function getCookie(request, name) {
  const cookieString = request.headers.get('Cookie');
  if (cookieString) {
    const cookies = cookieString.split(';');
    for (let i = 0; i < cookies.length; i++) {
      const cookie = cookies[i].trim();
      if (cookie.startsWith(name + '=')) return cookie.substring(name.length + 1);
    }
  }
  return null;
}

// Turnstile
async function validateTurnstile(token, secret, ip) {
    const formData = new FormData();
    formData.append('secret', secret);
    formData.append('response', token);
    formData.append('remoteip', ip);
    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { body: formData, method: 'POST' });
    const outcome = await result.json();
    return outcome.success;
}

// DB Helper
async function getShareDB(env) {
    try {
        const obj = await env.MY_BUCKET.get(SHARES_DB_KEY);
        if (!obj) return {};
        return await obj.json();
    } catch (e) {
        console.error("Share DB Read Error:", e);
        return {}; 
    }
}

async function saveShareDB(env, data) {
    await env.MY_BUCKET.put(SHARES_DB_KEY, JSON.stringify(data));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.MY_BUCKET) return new Response('错误：未绑定 R2 存储桶 (MY_BUCKET)', { status: 500 });

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

    // 1. 分享 (支持 Raw 模式)
    if (url.pathname === '/share') {
      try {
        const token = url.searchParams.get('k');
        const rawId = url.searchParams.get('id');

        // A. 管理员直接预览
        if (rawId) {
            const authObj = await checkAuth(request, env);
            if (!authObj.isAuthenticated) return new Response(renderErrorPage('权限不足', '需要登录管理员账号才能直接预览原始文件。'), { status: 403, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            const obj = await env.MY_BUCKET.get(rawId);
            if (!obj) return new Response(renderErrorPage('文件不存在', '您请求的文件ID不存在。'), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            return new Response(renderSharePage(await obj.text(), rawId, false, null), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        }

        if (!token) return new Response(renderErrorPage('链接无效', '缺少必要的访问参数。'), { status: 400, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });

        const shareDB = await getShareDB(env);
        const shareInfo = shareDB[token];

        if (!shareInfo) return new Response(renderErrorPage('链接不存在', '该分享链接不存在或已被删除。'), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        
        // B. 检查有效期
        if (shareInfo.expire && Date.now() > shareInfo.expire) {
            return new Response(renderErrorPage('链接已过期', '该分享链接已超过有效期，无法继续访问。'), { status: 410, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        }

        // C. 检查最大访问次数
        if (shareInfo.maxVisits && shareInfo.maxVisits > 0) {
            const currentViews = shareInfo.views || 0;
            if (currentViews >= shareInfo.maxVisits) {
                return new Response(renderErrorPage('链接已失效', '此分享链接已达到最大访问次数限制 (阅后即焚)，文件已无法访问。'), { 
                    status: 410, 
                    headers: { 'Content-Type': 'text/html; charset=UTF-8' } 
                });
            }
        }

        // D. 检查密码逻辑
        let isUnlocked = !shareInfo.password; 
        if (shareInfo.password) {
            if (request.method === 'POST') {
                try {
                    const body = await request.formData();
                    const pwd = body.get('password');
                    if (pwd === shareInfo.password) {
                        isUnlocked = true;
                    }
                } catch(e) {
                    return new Response(`表单提交错误: ${e.message}`, { status: 400 });
                }
            }
        }

        if (!isUnlocked) {
            return new Response(renderPasswordPage(token), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        }

        // E. 获取内容
        const obj = await env.MY_BUCKET.get(shareInfo.fileId);
        if (!obj) return new Response(renderErrorPage('源文件丢失', '分享记录存在，但源文件似乎已被删除。'), { status: 404, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        
        const text = await obj.text();
        const isRaw = url.searchParams.get('raw') === 'true';

        // F. 更新访问计数
        ctx.waitUntil((async () => {
            try {
                const db = await getShareDB(env);
                if(db[token]) {
                    db[token].views = (db[token].views || 0) + 1;
                    await saveShareDB(env, db);
                }
            } catch(e) { console.warn('Stats update failed', e); }
        })());

        if (isRaw) {
          return new Response(text, { 
            headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Access-Control-Allow-Origin': '*' } 
          });
        }
        return new Response(renderSharePage(text, shareInfo.fileId, true, token), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });

      } catch (err) {
        return new Response(renderErrorPage('系统错误', `服务器内部错误: ${err.message}`), { status: 500, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      }
    }

    // 2. 初始化与配置读取
    let systemConfig = null;
    const configObj = await env.MY_BUCKET.get(CONFIG_KEY);
    
    if (!configObj) {
      if (url.pathname === '/api/setup' && request.method === 'POST') {
        const body = await request.json();
        if (!body.username || !body.password) return new Response(JSON.stringify({ error: '请填写完整' }), { status: 400 });
        const newConfig = { username: body.username, password: body.password, createdAt: Date.now() };
        await env.MY_BUCKET.put(CONFIG_KEY, JSON.stringify(newConfig));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }
      return new Response(renderSetupPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    systemConfig = await configObj.json();

    // 3. 登录逻辑
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const body = await request.json();
      if (env.TURNSTILE_SECRET_KEY) {
          const token = body.turnstileToken;
          if (!token) return new Response(JSON.stringify({ error: '请完成人机验证' }), { status: 403, headers: corsHeaders });
          const ip = request.headers.get('CF-Connecting-IP');
          const valid = await validateTurnstile(token, env.TURNSTILE_SECRET_KEY, ip);
          if (!valid) return new Response(JSON.stringify({ error: '验证失败' }), { status: 403, headers: corsHeaders });
      }
      if (body.username === systemConfig.username && body.password === systemConfig.password) {
        const token = btoa(`${systemConfig.username}:${systemConfig.password}:${Date.now()}`);
        return new Response(JSON.stringify({ success: true }), { 
          headers: { 
            'Content-Type': 'application/json', ...corsHeaders,
            'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; Path=/; Max-Age=${SESSION_DURATION}; SameSite=Lax`
          } 
        });
      }
      return new Response(JSON.stringify({ error: '账号或密码错误' }), { status: 401, headers: corsHeaders });
    }

    if (url.pathname === '/api/logout') {
      return new Response(null, {
        status: 302, headers: { 'Location': '/', 'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0;` }
      });
    }

    // 4. 鉴权拦截
    const authState = await checkAuth(request, env, systemConfig);
    if (!authState.isAuthenticated) {
      if (url.pathname.startsWith('/api/')) return new Response(JSON.stringify({ error: '未登录' }), { status: 401, headers: corsHeaders });
      return new Response(renderLoginPage(env.TURNSTILE_SITE_KEY), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 5. 核心 API
    try {
      if (url.pathname === '/api/save' && request.method === 'POST') {
        const body = await request.json(); 
        let id = body.id ? body.id.trim() : crypto.randomUUID().substring(0, 8);
        if (!body.code) throw new Error("内容不能为空");
        if (id === CONFIG_KEY || id === SHARES_DB_KEY) throw new Error("系统保留文件名");
        await env.MY_BUCKET.put(id, body.code);
        return new Response(JSON.stringify({ success: true, id }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/get') {
        const id = url.searchParams.get('id');
        if (!id) throw new Error("缺少 ID");
        const obj = await env.MY_BUCKET.get(id);
        if (!obj) throw new Error("文件不存在");
        return new Response(JSON.stringify({ code: await obj.text() }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/delete' && request.method === 'DELETE') {
        const id = url.searchParams.get('id');
        if (!id || id === CONFIG_KEY || id === SHARES_DB_KEY) throw new Error("无法删除");
        await env.MY_BUCKET.delete(id);
        
        const shareDB = await getShareDB(env);
        let changed = false;
        Object.keys(shareDB).forEach(k => {
            if (shareDB[k].fileId === id) { delete shareDB[k]; changed = true; }
        });
        if(changed) await saveShareDB(env, shareDB);

        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/list') {
        const listed = await env.MY_BUCKET.list({ limit: 100 });
        const files = listed.objects
          .filter(o => o.key !== CONFIG_KEY && o.key !== SHARES_DB_KEY)
          .map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
        return new Response(JSON.stringify({ success: true, files: files }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/share/create' && request.method === 'POST') {
        const body = await request.json();
        if (!body.fileId) throw new Error("未指定文件");
        
        const token = crypto.randomUUID();
        const shareDB = await getShareDB(env);
        
        shareDB[token] = {
            fileId: body.fileId,
            password: body.password || '', 
            expire: body.expire ? Date.now() + (body.expire * 1000) : null,
            maxVisits: body.maxVisits ? parseInt(body.maxVisits) : 0, 
            created: Date.now(),
            views: 0
        };
        
        await saveShareDB(env, shareDB);
        return new Response(JSON.stringify({ success: true, token }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/share/list') {
        const shareDB = await getShareDB(env);
        const list = [];
        const now = Date.now();
        let changed = false;

        Object.keys(shareDB).forEach(k => {
            const info = shareDB[k];
            const isTimeExpired = info.expire && info.expire < now;
            
            if (isTimeExpired) {
                delete shareDB[k];
                changed = true;
            } else {
                list.push({ token: k, ...info });
            }
        });
        if(changed) await saveShareDB(env, shareDB);

        return new Response(JSON.stringify({ success: true, shares: list }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/api/share/delete' && request.method === 'DELETE') {
        const token = url.searchParams.get('token');
        const shareDB = await getShareDB(env);
        if (shareDB[token]) {
            delete shareDB[token];
            await saveShareDB(env, shareDB);
        }
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 批量删除 API
      if (url.pathname === '/api/share/batch_delete' && request.method === 'POST') {
        const body = await request.json();
        if (!body.tokens || !Array.isArray(body.tokens)) throw new Error('无效参数');
        const shareDB = await getShareDB(env);
        let changed = false;
        body.tokens.forEach(t => {
            if (shareDB[t]) {
                delete shareDB[t];
                changed = true;
            }
        });
        if (changed) await saveShareDB(env, shareDB);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      }

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }

    return new Response(renderAppPage(), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
};

// --- Auth Helper ---
async function checkAuth(request, env, config = null) {
    if(!config) {
        const obj = await env.MY_BUCKET.get(CONFIG_KEY);
        if(!obj) return { isAuthenticated: false };
        config = await obj.json();
    }
    const token = getCookie(request, SESSION_COOKIE_NAME) || request.headers.get('X-Access-Token');
    if (token) {
        try {
            const parts = atob(token).split(':');
            if (parts.length >= 2 && parts[0] === config.username && parts[1] === config.password) {
                return { isAuthenticated: true, user: config.username };
            }
        } catch (e) {}
    }
    return { isAuthenticated: false };
}

// --- HTML Generators ---
const COMMON_CSS_VARS = `:root { --bg: #121212; --panel: rgba(30, 30, 30, 0.7); --accent: #7c4dff; --text: #e0e0e0; --border: rgba(255,255,255,0.1); }`;
const COMMON_BODY_STYLE = `background:#000;background-image:radial-gradient(circle at 50% 0%,#2a1a4a 0%,#000 70%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;height:100vh;margin:0;display:flex;align-items:center;justify-content:center;overflow:hidden;`;

function renderSetupPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>初始化</title>${FAVICON_TAG}<style>${COMMON_CSS_VARS} body{${COMMON_BODY_STYLE}} .box{background:var(--panel);backdrop-filter:blur(15px);padding:40px;border-radius:16px;border:1px solid var(--border);width:320px;text-align:center}input{width:100%;padding:12px;margin:10px 0;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:#fff;border-radius:8px;box-sizing:border-box}button{width:100%;padding:12px;background:var(--accent);border:none;color:#fff;border-radius:8px;cursor:pointer;margin-top:20px}</style></head><body><div class="box"><h3>🚀 系统初始化</h3><form onsubmit="s(event)"><input id="u" placeholder="用户名" required><input type="password" id="p" placeholder="密码" required><button>确定</button></form></div><script>async function s(e){e.preventDefault();try{await fetch('/api/setup',{method:'POST',body:JSON.stringify({username:u.value,password:p.value})});location.reload()}catch(e){alert('网络错误')}}</script></body></html>`;
}

function renderLoginPage(siteKey) {
  const tw = siteKey ? `<div class="cf-turnstile" data-sitekey="${siteKey}" data-theme="dark" style="margin:15px 0"></div>` : '';
  const ts = siteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录</title>${FAVICON_TAG}${ts}<style>${COMMON_CSS_VARS} body{${COMMON_BODY_STYLE}} .box{background:var(--panel);backdrop-filter:blur(15px);padding:40px;border-radius:16px;border:1px solid var(--border);width:320px;text-align:center}input{width:100%;padding:12px;margin:10px 0;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:#fff;border-radius:8px;box-sizing:border-box;outline:0}input:focus{border-color:var(--accent)}button{width:100%;padding:12px;background:var(--accent);border:none;color:#fff;border-radius:8px;cursor:pointer;margin-top:10px}.cf-turnstile{display:flex;justify-content:center}</style></head><body><div class="box"><h3>🔐 登录</h3><form onsubmit="l(event)"><input id="u" placeholder="用户名" required><input type="password" id="p" placeholder="密码" required>${tw}<button id="btn">进入</button></form></div><script>async function l(e){e.preventDefault();const b=document.getElementById('btn');b.innerText='...';let t=null;if(window.turnstile){t=turnstile.getResponse();if(!t){alert('请验证');b.innerText='进入';return}}try{const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:u.value,password:p.value,turnstileToken:t})});const d=await r.json();if(d.success)location.reload();else{alert(d.error);if(window.turnstile)turnstile.reset()}}catch(e){alert('Err')}finally{b.innerText='进入'}}</script></body></html>`;
}

function renderPasswordPage(token) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>受保护的文件</title>${FAVICON_TAG}<style>${COMMON_CSS_VARS} body{${COMMON_BODY_STYLE}} .box{background:var(--panel);backdrop-filter:blur(15px);padding:40px;border-radius:16px;border:1px solid var(--border);width:320px;text-align:center}input{width:100%;padding:12px;margin:10px 0;background:rgba(255,255,255,0.05);border:1px solid var(--border);color:#fff;border-radius:8px;box-sizing:border-box;outline:0;text-align:center}button{width:100%;padding:12px;background:var(--accent);border:none;color:#fff;border-radius:8px;cursor:pointer;margin-top:10px}</style></head><body><div class="box"><h3>🔒 需要密码</h3><p style="font-size:12px;color:#aaa">此文件受密码保护，请输入密码以继续。</p><form method="POST"><input type="password" name="password" placeholder="输入访问密码" required autofocus><button>解锁</button></form></div></body></html>`;
}

function renderErrorPage(title, message) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>${FAVICON_TAG}<style>${COMMON_CSS_VARS} body{${COMMON_BODY_STYLE}} .box{background:var(--panel);backdrop-filter:blur(15px);padding:40px;border-radius:16px;border:1px solid var(--border);width:360px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,0.5)} h3{margin-top:10px;margin-bottom:10px;font-size:20px;color:#fff} p{color:#aaa;font-size:14px;line-height:1.6;margin-bottom:20px} .icon{color:#ff5252;margin-bottom:15px} .btn{display:inline-block;padding:10px 20px;background:var(--accent);color:#fff;text-decoration:none;border-radius:8px;font-size:14px;transition:0.2s;border:none;cursor:pointer} .btn:hover{background:#6c42e0}</style></head><body><div class="box"><div class="icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg></div><h3>${title}</h3><p>${message}</p><button onclick="c()" class="btn" id="cb">关闭此页面</button></div><script>function c(){try{window.opener=null;window.open('','_self');window.close();const b=document.getElementById('cb');setTimeout(()=>{b.innerText='请手动关闭此标签页';b.style.background='#555';b.style.cursor='not-allowed'},100)}catch(e){}}</script></body></html>`;
}

function renderSharePage(code, filename, isPublic, token) {
  const safeCode = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  let lang = 'javascript';
  if (filename.endsWith('.css')) lang = 'css';
  else if (filename.endsWith('.html')) lang = 'html';
  else if (filename.endsWith('.json')) lang = 'json';
  else if (filename.endsWith('.md')) lang = 'markdown';
  else if (filename.endsWith('.py')) lang = 'python';

  const readOnlyBadge = isPublic ? '<span style="background:#4caf50;font-size:10px;padding:2px 6px;border-radius:4px;color:white;margin-left:10px">只读</span>' : '';
  
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${filename}</title>${FAVICON_TAG}<link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" /><link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.css" rel="stylesheet" /><style>:root{--bg:#0a0a0a;--panel:rgba(30,30,30,0.6);--border:rgba(255,255,255,0.08);--accent:#7c4dff;--text:#d4d4d4}body{margin:0;height:100vh;background:var(--bg);background-image:radial-gradient(circle at 50% 0%,#1a1a2e 0%,#000 70%);color:var(--text);font-family:'JetBrains Mono',Consolas,monospace;display:flex;flex-direction:column;overflow:hidden}header{height:60px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;background:rgba(10,10,10,0.8);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);z-index:10}.file-title{font-weight:bold;display:flex;align-items:center;gap:8px;font-size:14px;color:#fff}.btn-group{display:flex;gap:10px}.btn{padding:6px 12px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:rgba(255,255,255,0.05);color:#ccc;transition:0.2s;text-decoration:none;display:flex;align-items:center;gap:5px}.btn:hover{background:rgba(255,255,255,0.1);color:#fff;border-color:rgba(255,255,255,0.2)}.btn-primary{background:var(--accent);color:white;border:none}.btn-primary:hover{background:#6c42e0}.content{flex:1;overflow:auto;position:relative}pre[class*="language-"]{margin:0!important;height:100%;border-radius:0!important;background:transparent!important;padding:20px!important;text-shadow:none!important}code[class*="language-"]{font-family:'JetBrains Mono',Consolas,monospace!important;font-size:14px!important;line-height:1.6!important}.line-numbers .line-numbers-rows{border-right:1px solid var(--border)!important}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:5px;border:2px solid var(--bg)}</style></head><body><header><div class="file-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg> ${filename} ${readOnlyBadge}</div><div class="btn-group"><button class="btn" onclick="downloadFile()">下载</button><button class="btn btn-primary" onclick="copyCode()" id="copyBtn">复制内容</button></div></header><div class="content"><pre class="line-numbers"><code id="codeBlock" class="language-${lang}">${safeCode}</code></pre></div><script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/line-numbers/prism-line-numbers.min.js"></script><script>function copyCode(){const c=document.getElementById('codeBlock').innerText;navigator.clipboard.writeText(c).then(()=>{const b=document.getElementById('copyBtn');const o=b.innerText;b.innerText='已复制!';b.style.background='#4caf50';setTimeout(()=>{b.innerText=o;b.style.background=''},2000)})}function downloadFile(){const c=document.getElementById('codeBlock').innerText;const b=new Blob([c],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='${filename}';a.click()}</script></body></html>`;
}

// --- App Page with Enhanced Modals ---
function renderAppPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloud Note v9.3</title>
${FAVICON_TAG}
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/monokai.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/css/css.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/xml/xml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closebrackets.min.js"></script>

<style>
  :root { 
    --bg-main: #0a0a0a; 
    --glass-panel: rgba(30, 30, 30, 0.6);
    --glass-border: rgba(255, 255, 255, 0.08);
    --text-main: #d4d4d4; 
    --text-muted: #888;
    --accent: #7c4dff; 
    --danger: #ff5252;
  }
  * { box-sizing: border-box; outline: none; }
  body { margin: 0; padding: 0; height: 100vh; display: flex; background: var(--bg-main); color: var(--text-main); font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace; overflow: hidden; }
  
  /* Sidebar */
  .sidebar { width: 64px; background: var(--glass-panel); backdrop-filter: blur(20px); display: flex; flex-direction: column; align-items: center; padding-top: 20px; border-right: 1px solid var(--glass-border); z-index: 20; }
  .sidebar-btn { width: 42px; height: 42px; margin-bottom: 15px; border-radius: 12px; display: flex; justify-content: center; align-items: center; cursor: pointer; color: var(--text-muted); font-size: 18px; transition: 0.2s; background: transparent; }
  .sidebar-btn:hover { background: rgba(255,255,255,0.1); color: #fff; transform: scale(1.05); }
  .sidebar-btn::after { content: attr(data-tip); position: absolute; left: 70px; background: rgba(0,0,0,0.8); color: #fff; padding: 6px 10px; font-size: 12px; border-radius: 6px; white-space: nowrap; opacity: 0; pointer-events: none; transform: translateX(-10px); transition: 0.2s; visibility: hidden; backdrop-filter: blur(4px); }
  .sidebar-btn:hover::after { opacity: 1; transform: translateX(0); visibility: visible; }

  /* Main */
  .main { flex: 1; display: flex; flex-direction: column; position: relative; background: radial-gradient(circle at top right, #1a1a2e 0%, #0a0a0a 40%); }
  .header { height: 50px; display: flex; align-items: center; padding: 0 20px; border-bottom: 1px solid var(--glass-border); background: rgba(10, 10, 10, 0.5); backdrop-filter: blur(10px); }
  .win-controls { display: flex; gap: 8px; margin-right: 20px; }
  .win-dot { width: 12px; height: 12px; border-radius: 50%; }
  .red { background: #ff5f56; } .yellow { background: #ffbd2e; } .green { background: #27c93f; }
  .filename-wrapper { position: relative; display: flex; align-items: center; background: rgba(255,255,255,0.05); border-radius: 6px; padding: 4px 10px; border: 1px solid transparent; transition: 0.3s; }
  .filename-wrapper:focus-within { border-color: var(--accent); background: rgba(255,255,255,0.08); }
  .filename-input { background: transparent; border: none; color: #fff; font-family: inherit; font-size: 13px; width: 180px; font-weight: 500; }
  .status-badge { margin-left: 15px; font-size: 12px; padding: 2px 8px; border-radius: 4px; opacity: 0; transition: 0.3s; background: var(--accent); color: white; transform: translateY(10px); }
  .status-badge.show { opacity: 1; transform: translateY(0); }
  .status-badge.err { background: var(--danger); }
  .header-tools { margin-left: auto; display: flex; gap: 15px; font-size: 12px; color: var(--text-muted); align-items: center;}
  .tool-item { cursor: pointer; display: flex; align-items: center; gap: 6px; transition: 0.2s; padding: 4px 8px; border-radius: 4px;}
  .tool-item:hover { color: #fff; background: rgba(255,255,255,0.05); }
  .tool-item.active { color: var(--accent); }

  /* Editor & Footer */
  .editor-container { flex: 1; display: flex; position: relative; overflow: hidden; }
  .CodeMirror { height: 100%; width: 100%; background: transparent !important; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 14px; line-height: 1.6; color: #e0e0e0; }
  .CodeMirror-gutters { background: rgba(0,0,0,0.2) !important; border-right: 1px solid var(--glass-border) !important; }
  .CodeMirror-linenumber { color: #555 !important; }
  .CodeMirror-cursor { border-left: 2px solid var(--accent) !important; }
  .CodeMirror-selected { background: rgba(124, 77, 255, 0.3) !important; }
  .footer { height: 30px; background: rgba(10,10,10,0.8); border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: flex-end; padding: 0 15px; font-size: 11px; color: #666; font-family: -apple-system, sans-serif; }

  /* Modals */
  .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 100; display: none; justify-content: center; align-items: center; backdrop-filter: blur(5px); opacity: 0; transition: opacity 0.3s; }
  .modal-overlay.open { opacity: 1; }
  .modal { background: rgba(30, 30, 30, 0.9); width: 600px; max-height: 75vh; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; box-shadow: 0 25px 50px rgba(0,0,0,0.5); backdrop-filter: blur(20px); transform: scale(0.95); transition: 0.3s; }
  .modal-overlay.open .modal { transform: scale(1); }
  .modal-header { padding: 15px 20px; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center; }
  
  /* Buttons & Inputs */
  .search-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 13px; width: 180px; }
  .search-input:focus { border-color: var(--accent); }
  
  .btn { padding: 8px 20px; border-radius: 8px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.05); color: #ccc; cursor: pointer; transition: 0.2s; font-size: 13px; text-decoration: none;}
  .btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
  .btn-primary { background: var(--accent); color: white; border:none; }
  .btn-primary:hover { background: #6c42e0; }
  .btn-danger { background: rgba(255, 82, 82, 0.15); color: #ff5252; border-color: rgba(255, 82, 82, 0.3); }
  .btn-danger:hover { background: rgba(255, 82, 82, 0.3); }

  /* File List Styles */
  .file-list { overflow-y: auto; padding: 10px; }
  .file-item { padding: 10px 15px; border-radius: 8px; cursor: pointer; color: #ccc; display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; transition: 0.2s; border: 1px solid transparent; }
  .file-item:hover { background: rgba(255,255,255,0.05); color: #fff; }
  .file-item.active { background: rgba(124, 77, 255, 0.15); border-color: var(--accent); color: #fff; }
  .file-info { display: flex; flex-direction: column; min-width: 0; margin-right: 15px; }
  .file-name { font-family: monospace; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 8px;}
  .file-meta { font-size: 11px; color: #666; margin-top: 4px; display: flex; gap: 10px; }
  .list-actions { display:flex; gap: 5px; opacity: 0.6; transition: 0.2s; }
  .file-item:hover .list-actions { opacity: 1; }
  .icon-btn { padding: 6px; border-radius: 6px; color: #aaa; transition: 0.2s; display: flex; align-items: center; justify-content:center; }
  .icon-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
  .icon-btn.delete:hover { background: rgba(255, 82, 82, 0.2); color: #ff5252; }
  .sort-btn { font-size:12px; color:#888; cursor:pointer; display:flex; align-items:center; gap:4px; padding:4px 8px; border-radius:4px; transition:0.2s; }
  .sort-btn:hover { color:#fff; background:rgba(255,255,255,0.05); }
  .file-type-js { color: #f1e05a; } 

  /* Form & Share Styles (Updated for Radio) */
  .form-group { margin-bottom: 20px; }
  .form-label { display: block; margin-bottom: 8px; font-size: 12px; color: #aaa; }
  .form-control { width: 100%; background: rgba(0,0,0,0.3); border: 1px solid var(--glass-border); color: #fff; padding: 10px; border-radius: 8px; }
  
  .radio-group { display: flex; gap: 10px; flex-wrap: wrap; }
  .radio-label { 
      cursor: pointer; padding: 8px 12px; border-radius: 6px; background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); 
      font-size: 13px; color: #ccc; transition: 0.2s; display: flex; align-items: center; gap: 6px;
  }
  .radio-label:hover { background: rgba(255,255,255,0.1); }
  .radio-label input { margin: 0; accent-color: var(--accent); }
  .radio-label:has(input:checked) { border-color: var(--accent); background: rgba(124, 77, 255, 0.1); color: #fff; }

  /* Confirm Modal Styles */
  .confirm-box { text-align: center; padding: 10px; }
  .confirm-title { font-size: 18px; font-weight: 600; margin-bottom: 10px; color: #fff; display: flex; align-items: center; justify-content: center; gap: 10px;}
  .confirm-desc { color: #888; font-size: 14px; margin-bottom: 25px; line-height: 1.5; }
  .confirm-actions { display: flex; justify-content: center; gap: 15px; }

  /* Share Manager Toolbar */
  .mgr-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px; background: rgba(255,255,255,0.03); border-bottom: 1px solid var(--glass-border); }
  .chk-label { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; color: #ccc; }
  .chk-label:hover { color: #fff; }
  .share-chk { accent-color: var(--accent); width: 16px; height: 16px; margin: 0; }

  @media (max-width: 768px) {
    body { flex-direction: column-reverse; } 
    .sidebar { width: 100%; height: 50px; flex-direction: row; border-top: 1px solid var(--glass-border); border-right: none; }
    .sidebar-btn { margin: 0; height: 100%; width: 100%; border-radius: 0; }
    .sidebar-btn::after { display: none; } 
    .header { padding: 0 10px; }
    .win-controls { display: none; }
    .filename-input { width: 120px; }
    .modal { width: 95%; }
  }
</style>
</head>
<body>

  <nav class="sidebar">
    <div class="sidebar-btn" onclick="act.new()" data-tip="新建文件"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg></div>
    <div class="sidebar-btn" onclick="act.save()" data-tip="保存 (Ctrl+S)"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg></div>
    <div class="sidebar-btn" onclick="act.openShareDialog()" data-tip="创建分享"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg></div>
    <div class="sidebar-btn" onclick="act.listShares()" data-tip="分享管理"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg></div>
    <div class="sidebar-btn" onclick="act.copy()" data-tip="复制内容"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></div>
    <div class="sidebar-btn" onclick="act.list()" data-tip="文件列表"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg></div>
    <div style="flex-grow:1"></div>
    <div class="sidebar-btn" onclick="location.href='/api/logout'" data-tip="注销"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg></div>
  </nav>

  <main class="main">
    <div class="header">
      <div class="win-controls"><div class="win-dot red"></div><div class="win-dot yellow"></div><div class="win-dot green"></div></div>
      <div class="filename-wrapper">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e0e0e0" stroke-width="2" style="margin-right:8px"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
         <input type="text" id="filename" class="filename-input" placeholder="script.js" autocomplete="off" spellcheck="false">
      </div>
      <div id="statusBadge" class="status-badge">已保存</div>
      <div class="header-tools">
        <div class="tool-item" id="wrapToggle" onclick="toggleWrap()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path></svg> <span>自动换行</span>
        </div>
      </div>
    </div>
    <div class="editor-container">
      <textarea id="editor" placeholder="// 开始编写..." spellcheck="false"></textarea>
    </div>
    <div class="footer"><span id="stats">Ln 1, Col 1</span></div>
  </main>

  <div id="modalOverlay" class="modal-overlay">
    <div class="modal">
      <div class="modal-header">
        <div style="display:flex;align-items:center;">
            <span style="font-size:16px;font-weight:600;color:#fff">📂 文件列表</span>
            <span id="fileCount" class="modal-stats" style="margin-left:10px;font-size:12px;color:#888">0 items</span>
        </div>
        <div style="display:flex; gap:10px; align-items:center">
             <div class="sort-btn" onclick="toggleSort()" id="sortLabel">🕒 时间</div>
             <input type="text" class="search-input" id="search" placeholder="搜索..." oninput="filterList()">
             <div style="cursor:pointer; padding:5px" onclick="closeModal()">✕</div>
        </div>
      </div>
      <div id="fileList" class="file-list">加载中...</div>
    </div>
  </div>

  <div id="shareCreateModal" class="modal-overlay">
    <div class="modal" style="width:420px">
        <div class="modal-header">
            <span style="font-size:16px;font-weight:600;color:#fff">🔗 创建分享</span>
            <div style="cursor:pointer; padding:5px" onclick="document.getElementById('shareCreateModal').classList.remove('open');setTimeout(()=>document.getElementById('shareCreateModal').style.display='none',300)">✕</div>
        </div>
        <div style="padding:20px">
            <div class="form-group">
                <label class="form-label">访问权限</label>
                <div class="radio-group">
                    <label class="radio-label"><input type="radio" name="sharePwdOpt" value="off" checked onclick="togglePwdInput(false)"> 公开</label>
                    <label class="radio-label"><input type="radio" name="sharePwdOpt" value="on" onclick="togglePwdInput(true)"> 密码保护</label>
                </div>
                <input type="text" id="sharePwdInput" class="form-control" placeholder="输入访问密码" style="display:none; margin-top:10px">
            </div>
            
            <div class="form-group">
                <label class="form-label">有效期</label>
                <div class="radio-group">
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="3600"> 1 小时</label>
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="86400" checked> 1 天</label>
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="172800"> 2 天</label>
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="604800"> 7 天</label>
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="2592000"> 30 天</label>
                    <label class="radio-label"><input type="radio" name="shareExpOpt" value="0"> 永久</label>
                </div>
            </div>

            <div class="form-group">
                <label class="form-label">最大访问次数</label>
                <div class="radio-group">
                    <label class="radio-label"><input type="radio" name="shareLimitOpt" value="0" checked> 不限</label>
                    <label class="radio-label"><input type="radio" name="shareLimitOpt" value="1"> 1 次</label>
                    <label class="radio-label"><input type="radio" name="shareLimitOpt" value="5"> 5 次</label>
                    <label class="radio-label"><input type="radio" name="shareLimitOpt" value="10"> 10 次</label>
                </div>
            </div>

            <button class="btn btn-primary" style="width:100%; margin-top:10px" onclick="act.doShare()">生成链接</button>
            <div id="shareResult" style="margin-top:15px;display:none">
                <input type="text" id="shareLinkInput" class="form-control" readonly onclick="this.select()">
                <div style="color:#4caf50;font-size:12px;margin-top:5px;text-align:center">链接已生成并复制!</div>
            </div>
        </div>
    </div>
  </div>

  <div id="shareMgrModal" class="modal-overlay">
    <div class="modal">
        <div class="modal-header">
            <span style="font-size:16px;font-weight:600;color:#fff">🌐 活跃分享管理</span>
            <div style="cursor:pointer; padding:5px" onclick="document.getElementById('shareMgrModal').classList.remove('open');setTimeout(()=>document.getElementById('shareMgrModal').style.display='none',300)">✕</div>
        </div>
        <div class="mgr-toolbar">
            <label class="chk-label"><input type="checkbox" id="selectAllShare" class="share-chk" onclick="toggleSelectAll()"> 全选</label>
            <button id="batchDelBtn" class="btn btn-danger" style="padding:4px 10px;font-size:12px;display:none" onclick="act.openBatchDelModal()">批量删除</button>
        </div>
        <div id="shareList" class="file-list" style="max-height:60vh">加载中...</div>
    </div>
  </div>

  <div id="confirmOverlay" class="modal-overlay">
    <div class="modal" style="width: 360px;">
      <div class="modal-header" style="justify-content: flex-end; border:none; padding-bottom:0;">
         <div style="cursor:pointer; padding:5px" onclick="closeConfirm()">✕</div>
      </div>
      <div class="confirm-box">
        <div class="confirm-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff5252" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          未保存的更改
        </div>
        <div class="confirm-desc">当前文件内容尚未保存。<br>继续操作将导致更改永久丢失。</div>
        <div class="confirm-actions">
          <button class="btn" onclick="closeConfirm()">取消</button>
          <button class="btn btn-danger" id="confirmBtn">放弃更改</button>
        </div>
      </div>
    </div>
  </div>

  <div id="shareDelOverlay" class="modal-overlay">
    <div class="modal" style="width: 360px;">
      <div class="modal-header" style="justify-content: flex-end; border:none; padding-bottom:0;">
         <div style="cursor:pointer; padding:5px" onclick="closeShareConfirm()">✕</div>
      </div>
      <div class="confirm-box">
        <div class="confirm-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff5252" stroke-width="2"><path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          取消分享
        </div>
        <div class="confirm-desc">确定要取消此分享链接吗？<br>取消后外部将无法访问此文件。</div>
        <div class="confirm-actions">
          <button class="btn" onclick="closeShareConfirm()">再想想</button>
          <button class="btn btn-danger" onclick="act.confirmDelShare()">确定取消</button>
        </div>
      </div>
    </div>
  </div>

  <div id="batchDelOverlay" class="modal-overlay">
    <div class="modal" style="width: 360px;">
      <div class="modal-header" style="justify-content: flex-end; border:none; padding-bottom:0;">
         <div style="cursor:pointer; padding:5px" onclick="closeBatchConfirm()">✕</div>
      </div>
      <div class="confirm-box">
        <div class="confirm-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ff5252" stroke-width="2"><path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          批量取消分享
        </div>
        <div class="confirm-desc" id="batchDelMsg"></div>
        <div class="confirm-actions">
          <button class="btn" onclick="closeBatchConfirm()">再想想</button>
          <button class="btn btn-danger" onclick="act.confirmBatchDelShare()">确定取消</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    const dom = {
      filename: document.getElementById('filename'),
      badge: document.getElementById('statusBadge'),
      stats: document.getElementById('stats'),
      modalOverlay: document.getElementById('modalOverlay'),
      confirmOverlay: document.getElementById('confirmOverlay'),
      list: document.getElementById('fileList'),
      search: document.getElementById('search'),
      wrapBtn: document.getElementById('wrapToggle'),
      fileCount: document.getElementById('fileCount'),
      sortLabel: document.getElementById('sortLabel'),
      // Share
      shareModal: document.getElementById('shareCreateModal'),
      shareMgrModal: document.getElementById('shareMgrModal'),
      sharePwdInput: document.getElementById('sharePwdInput'),
      shareResult: document.getElementById('shareResult'),
      shareLinkInput: document.getElementById('shareLinkInput'),
      shareList: document.getElementById('shareList'),
      // Share Delete Confirm
      shareDelOverlay: document.getElementById('shareDelOverlay'),
      // Batch
      selectAllShare: document.getElementById('selectAllShare'),
      batchDelBtn: document.getElementById('batchDelBtn'),
      batchDelOverlay: document.getElementById('batchDelOverlay'),
      batchDelMsg: document.getElementById('batchDelMsg')
    };

    let currentId = null;
    let fileCache = []; 
    let isUnsaved = false;
    let sortByDate = true;
    let pendingAction = null;
    let pendingShareToken = null;

    // CodeMirror Init
    const editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
        mode: "javascript",
        theme: "monokai",
        lineNumbers: true,
        smartIndent: true,
        indentUnit: 2,
        tabSize: 2,
        matchBrackets: true,
        autoCloseBrackets: true,
        lineWrapping: false,
        extraKeys: { "Ctrl-S": () => act.save(), "Cmd-S": () => act.save() }
    });

    editor.on("change", () => { setStatus(false); });
    editor.on("cursorActivity", () => {
        const pos = editor.getCursor();
        dom.stats.innerText = \`Ln \${pos.line + 1}, Col \${pos.ch + 1}\`;
    });

    // Helper: Safe Run with Confirmation
    function safeRun(action) {
      if (!isUnsaved) {
        action();
      } else {
        pendingAction = action;
        dom.confirmOverlay.style.display = 'flex';
        setTimeout(() => dom.confirmOverlay.classList.add('open'), 10);
      }
    }

    function closeConfirm() {
      dom.confirmOverlay.classList.remove('open');
      setTimeout(() => dom.confirmOverlay.style.display = 'none', 300);
      pendingAction = null;
    }

    document.getElementById('confirmBtn').addEventListener('click', () => {
      isUnsaved = false;
      closeConfirm();
      if (pendingAction) {
          pendingAction(); 
      } else {
          act.new(); 
      }
    });

    dom.confirmOverlay.addEventListener('click', (e) => { if(e.target === dom.confirmOverlay) closeConfirm(); });

    // UI Helper for Share
    function togglePwdInput(show) {
        dom.sharePwdInput.style.display = show ? 'block' : 'none';
        if(show) dom.sharePwdInput.focus();
    }

    // Share Delete Modal Helpers
    function closeShareConfirm() {
        dom.shareDelOverlay.classList.remove('open');
        setTimeout(() => dom.shareDelOverlay.style.display = 'none', 300);
        pendingShareToken = null;
    }
    
    dom.shareDelOverlay.addEventListener('click', (e) => { if(e.target === dom.shareDelOverlay) closeShareConfirm(); });

    // Batch Share Helpers
    function toggleSelectAll() {
        const checked = dom.selectAllShare.checked;
        document.querySelectorAll('.share-item-chk').forEach(el => el.checked = checked);
        updateBatchBtn();
    }

    function updateBatchBtn() {
        const count = document.querySelectorAll('.share-item-chk:checked').length;
        if (count > 0) {
            dom.batchDelBtn.style.display = 'inline-block';
            dom.batchDelBtn.innerText = \`批量删除 (\${count})\`;
        } else {
            dom.batchDelBtn.style.display = 'none';
        }
        // Sync Select All checkbox
        const total = document.querySelectorAll('.share-item-chk').length;
        dom.selectAllShare.checked = total > 0 && count === total;
    }

    function closeBatchConfirm() {
        dom.batchDelOverlay.classList.remove('open');
        setTimeout(() => dom.batchDelOverlay.style.display = 'none', 300);
    }
    dom.batchDelOverlay.addEventListener('click', (e) => { if(e.target === dom.batchDelOverlay) closeBatchConfirm(); });

    const act = {
      save: async () => {
        const content = editor.getValue();
        if (!content.trim()) return showBadge('内容为空', true);
        showBadge('保存中...', false, true);
        let saveId = dom.filename.value.trim();
        if (saveId && !saveId.includes('.')) saveId += '.js';
        if (!saveId && currentId) saveId = currentId;
        if (!saveId) saveId = 'script.js';

        try {
          const res = await api('/api/save', { method: 'POST', body: JSON.stringify({ id: saveId, code: content }) });
          if (res.success) {
            currentId = res.id;
            dom.filename.value = res.id;
            history.pushState(null, '', '?id=' + encodeURIComponent(res.id));
            checkMode(res.id);
            showBadge('已保存');
            setStatus(true);
          }
        } catch (e) { showBadge('保存失败', true); }
      },

      new: () => {
        safeRun(() => {
            editor.setValue(''); 
            editor.clearHistory();
            dom.filename.value = ''; 
            currentId = null;
            history.pushState(null, '', location.pathname);
            checkMode('');
            setStatus(true); 
            showBadge('新建文件');
        });
      },

      // --- New Share Logic ---
      openShareDialog: () => {
        if(!currentId) return showBadge('请先保存文件', true);
        if(isUnsaved) return showBadge('请先保存更改', true);
        
        // Reset UI
        dom.sharePwdInput.value = '';
        dom.shareResult.style.display = 'none';
        
        // Load Defaults from LocalStorage
        const defPwd = localStorage.getItem('np_share_pwd') || 'off';
        const defExp = localStorage.getItem('np_share_exp') || '86400';
        const defLim = localStorage.getItem('np_share_lim') || '0';

        // Apply to Radios
        const pwdRad = document.querySelector(\`input[name="sharePwdOpt"][value="\${defPwd}"]\`);
        if(pwdRad) pwdRad.checked = true;
        togglePwdInput(defPwd === 'on');

        const expRad = document.querySelector(\`input[name="shareExpOpt"][value="\${defExp}"]\`);
        if(expRad) expRad.checked = true;

        const limRad = document.querySelector(\`input[name="shareLimitOpt"][value="\${defLim}"]\`);
        if(limRad) limRad.checked = true;

        openModal(dom.shareModal);
      },

      doShare: async () => {
          const pwdVal = document.querySelector('input[name="sharePwdOpt"]:checked').value;
          const expVal = document.querySelector('input[name="shareExpOpt"]:checked').value;
          const limitVal = document.querySelector('input[name="shareLimitOpt"]:checked').value;

          const isPwd = pwdVal === 'on';
          const pwd = isPwd ? dom.sharePwdInput.value.trim() : '';
          
          if(isPwd && !pwd) return alert('请设置密码');

          const exp = parseInt(expVal);
          const limit = parseInt(limitVal);

          // Save Defaults
          localStorage.setItem('np_share_pwd', pwdVal);
          localStorage.setItem('np_share_exp', expVal);
          localStorage.setItem('np_share_lim', limitVal);

          try {
              const res = await api('/api/share/create', { 
                  method: 'POST', 
                  body: JSON.stringify({ fileId: currentId, password: pwd, expire: exp, maxVisits: limit }) 
              });
              if(res.success) {
                  const link = window.location.origin + '/share?k=' + res.token;
                  dom.shareResult.style.display = 'block';
                  dom.shareLinkInput.value = link;
                  dom.shareLinkInput.select();
                  navigator.clipboard.writeText(link);
              }
          } catch(e) { alert(e.message); }
      },

      listShares: async () => {
          openModal(dom.shareMgrModal);
          dom.shareList.innerHTML = '<div style="padding:20px;text-align:center">加载中...</div>';
          dom.batchDelBtn.style.display = 'none'; // reset
          dom.selectAllShare.checked = false; // reset
          try {
              const res = await api('/api/share/list');
              if(res.success) renderShareList(res.shares);
          } catch(e) { dom.shareList.innerText = 'Error'; }
      },
      
      delShare: (token) => {
          pendingShareToken = token;
          dom.shareDelOverlay.style.display = 'flex';
          setTimeout(() => dom.shareDelOverlay.classList.add('open'), 10);
      },

      confirmDelShare: async () => {
          if(!pendingShareToken) return;
          try {
              await api('/api/share/delete?token=' + pendingShareToken, { method: 'DELETE' });
              closeShareConfirm();
              act.listShares(); 
              showBadge('分享已取消');
          } catch(e) { alert('操作失败'); }
      },

      // Batch Delete
      openBatchDelModal: () => {
          const selected = document.querySelectorAll('.share-item-chk:checked');
          if (selected.length === 0) return;
          dom.batchDelMsg.innerHTML = \`确定要取消选中的 <b>\${selected.length}</b> 个分享链接吗？<br>取消后外部将无法访问这些文件。\`;
          openModal(dom.batchDelOverlay);
      },

      confirmBatchDelShare: async () => {
          const selected = [...document.querySelectorAll('.share-item-chk:checked')].map(el => el.value);
          try {
              await api('/api/share/batch_delete', { 
                  method: 'POST', 
                  body: JSON.stringify({ tokens: selected }) 
              });
              closeBatchConfirm();
              act.listShares();
              showBadge('批量取消成功');
          } catch(e) { alert('批量操作失败: ' + e.message); }
      },
      // ---------------------

      copy: () => navigator.clipboard.writeText(editor.getValue()).then(() => showBadge('已复制')),

      download: async (targetId) => {
          showBadge('正在下载...', false, true);
          try {
              const res = await api('/api/get?id=' + encodeURIComponent(targetId));
              const blob = new Blob([res.code], {type: 'text/javascript'});
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = targetId; a.click();
              showBadge('下载完成');
          } catch(e) { showBadge('下载失败', true); }
      },

      del: async (targetId) => {
        if (!targetId || !confirm('确定彻底删除 [' + targetId + '] 吗?')) return;
        try {
          const res = await api('/api/delete?id=' + encodeURIComponent(targetId), { method: 'DELETE' });
          if (res.success) {
            if (currentId === targetId) { isUnsaved = false; act.new(); }
            act.list(); showBadge('删除成功');
          }
        } catch (e) { showBadge(e.message, true); }
      },

      list: async () => {
        openModal(dom.modalOverlay);
        dom.list.innerHTML = '<div style="padding:20px;text-align:center;color:#666">加载中...</div>';
        dom.search.value = ''; dom.search.focus();
        try {
          const res = await api('/api/list');
          if (res.success && res.files) {
            fileCache = res.files;
            renderList(fileCache);
          } else {
            dom.list.innerHTML = '<div style="padding:20px;text-align:center;color:#666">空空如也</div>';
            dom.fileCount.innerText = '0 items';
          }
        } catch (e) { dom.list.innerHTML = '加载失败'; }
      }
    };

    async function api(url, opts = {}) {
      const res = await fetch(url, opts);
      if (res.status === 401) location.reload();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'API Error');
      return data;
    }

    function showBadge(msg, isError = false, persist = false) {
      dom.badge.innerText = msg;
      dom.badge.className = 'status-badge show ' + (isError ? 'err' : '');
      if(!persist) setTimeout(() => dom.badge.classList.remove('show'), 2000);
    }
    
    function setStatus(saved) { isUnsaved = !saved; }

    function toggleWrap() {
      const wrap = !editor.getOption("lineWrapping");
      editor.setOption("lineWrapping", wrap);
      dom.wrapBtn.classList.toggle('active', wrap);
    }
    
    function checkMode(filename) {
        if(!filename) { editor.setOption("mode", "javascript"); return; }
        if(filename.endsWith('.html')) editor.setOption("mode", "htmlmixed");
        else if(filename.endsWith('.css')) editor.setOption("mode", "css");
        else editor.setOption("mode", "javascript");
    }
    
    dom.filename.addEventListener('change', () => checkMode(dom.filename.value));

    function toggleSort() {
        sortByDate = !sortByDate;
        dom.sortLabel.innerText = sortByDate ? '🕒 时间' : '🔤 名称';
        filterList();
    }
    
    function openModal(el) {
        el.style.display = 'flex';
        setTimeout(() => el.classList.add('open'), 10);
    }

    function renderList(files) {
      dom.fileCount.innerText = files.length + ' 文件';
      dom.list.innerHTML = '';
      if(files.length === 0) {
        dom.list.innerHTML = '<div style="padding:30px;text-align:center;color:#666;display:flex;flex-direction:column;align-items:center;gap:10px"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg><span>无结果</span></div>';
        return;
      }
      
      files.sort((a,b) => {
          if (sortByDate) return new Date(b.uploaded) - new Date(a.uploaded);
          return a.key.localeCompare(b.key);
      });

      files.forEach(f => {
        const div = document.createElement('div');
        div.className = 'file-item ' + (f.key === currentId ? 'active' : '');
        
        let icon = '📄';
        let typeClass = 'file-type-txt';
        if (f.key.endsWith('.js')) { icon = 'JS'; typeClass = 'file-type-js'; }
        else if (f.key.endsWith('.html')) { icon = '<>'; }
        else if (f.key.endsWith('.css')) { icon = '#'; }
        
        const date = new Date(f.uploaded);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const sizeStr = f.size < 1024 ? f.size + 'B' : (f.size/1024).toFixed(1) + 'KB';

        div.innerHTML = \`
          <div class="file-info" style="flex-grow:1" onclick="loadFromFile('\${f.key}')">
            <div class="file-name">
                <span class="\${typeClass}">\${icon}</span> \${f.key}
            </div>
            <div class="file-meta">
                <span>\${dateStr}</span> <span>·</span> <span>\${sizeStr}</span>
            </div>
          </div>
          <div class="list-actions">
            <div class="icon-btn download" onclick="event.stopPropagation(); act.download('\${f.key}')" title="下载"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></div>
            <div class="icon-btn delete" onclick="event.stopPropagation(); act.del('\${f.key}')" title="删除"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></div>
          </div>
        \`;
        dom.list.appendChild(div);
      });
    }

    function renderShareList(shares) {
        dom.shareList.innerHTML = '';
        if(shares.length === 0) {
            dom.shareList.innerHTML = '<div style="padding:20px;text-align:center;color:#666">暂无活跃分享</div>';
            return;
        }
        shares.forEach(s => {
            const div = document.createElement('div');
            div.className = 'file-item';
            const expStr = s.expire ? new Date(s.expire).toLocaleString() : '永久';
            const locked = s.password ? '🔒' : '🌐';
            const limitStr = s.maxVisits > 0 ? s.maxVisits : '∞';
            
            div.innerHTML = \`
              <div style="padding-right:10px;display:flex;align-items:center">
                  <input type="checkbox" class="share-item-chk share-chk" value="\${s.token}" onclick="updateBatchBtn()">
              </div>
              <div class="file-info" style="flex-grow:1">
                <div class="file-name">\${locked} \${s.fileId}</div>
                <div class="file-meta">过期: \${expStr} · 浏览: \${s.views||0} / \${limitStr}</div>
              </div>
              <div class="list-actions">
                 <div class="icon-btn" onclick="act.delShare('\${s.token}')" title="删除链接">
                     <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                 </div>
              </div>
            \`;
            dom.shareList.appendChild(div);
        });
    }

    function loadFromFile(key) { 
        safeRun(() => {
            location.href = '?id=' + encodeURIComponent(key); 
        });
    }
    
    function filterList() {
      const term = dom.search.value.toLowerCase();
      renderList(fileCache.filter(f => f.key.toLowerCase().includes(term)));
    }
    function closeModal() {
      dom.modalOverlay.classList.remove('open');
      setTimeout(() => dom.modalOverlay.style.display = 'none', 300);
    }

    (async function() {
      const params = new URLSearchParams(location.search);
      const id = params.get('id');
      if (id) {
        showBadge('加载中...', false, true);
        try {
          const res = await api('/api/get?id=' + encodeURIComponent(id));
          editor.setValue(res.code); 
          dom.filename.value = id; 
          currentId = id;
          checkMode(id);
          showBadge('加载完成'); setStatus(true);
        } catch (e) { showBadge('文件未找到', true); }
      }
      editor.clearHistory(); 
    })();
    
    dom.modalOverlay.addEventListener('click', (e) => { if(e.target === dom.modalOverlay) closeModal(); });
    window.addEventListener('beforeunload', (e) => { if (isUnsaved) e.returnValue = ''; });
  </script>
</body>
</html>`;
}
