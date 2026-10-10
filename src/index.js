/**
 * Cloud Note v10 — Cloudflare Workers + R2 云端代码记事本 / 文件分享
 * ------------------------------------------------------------------
 * 相比 v9.3 的主要变化：
 *  1. R2 自动创建 + 自动绑定：wrangler.jsonc 里只写 { "binding": "MY_BUCKET" }，
 *     部署（含 Dashboard 连接 GitHub）时 Cloudflare 会自动建桶并绑定。
 *  2. Turnstile 密钥改为「应用内设置页」管理，存 R2；回退顺序：设置 → 环境变量 → 关闭。
 *     并按错误码分类降级：密钥填错 / 验证服务不可达时放行并告警，绝不把管理员锁死。
 *  3. 认证加固：口令加盐 SHA-256、服务端随机 session token（登出即吊销）、
 *     登录失败限流、恒定时间比较；旧版明文配置可平滑升级。
 *  4. 前端整页 HTML 放在 src/views/*.html 里，以「文本模块」导入，
 *     不再塞进 JS 模板字符串 —— 从根上避免反引号 / 正则转义坑。
 *  5. 新增：文件重命名 / 复制 / 批量删除、分享二维码、设置中心（外观 / 账号 / 数据）。
 */

import appHtml from './views/app.html';
import loginHtml from './views/login.html';
import setupHtml from './views/setup.html';
import shareHtml from './views/share.html';
import passwordHtml from './views/password.html';
import errorHtml from './views/error.html';

/* ==================== 常量 ==================== */

const KEY_CONFIG = '_sys_admin_config';       // 管理员账号（兼容 v9.x）
const KEY_SHARES = '_sys_shares.json';        // 分享记录
const KEY_SETTINGS = '_sys_settings.json';    // 应用内设置（含 Turnstile 密钥）
const KEY_TS_OFF = '_sys_turnstile_off';      // 破窗开关：值为 1 时强制关闭人机验证
const PREFIX_SESS = '_sys_sess/';             // 会话
const PREFIX_THROTTLE = '_sys_throttle/';     // 登录失败计数

const SESSION_COOKIE = 'np_sess';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 天
const LOGIN_MAX_FAIL = 5;
const LOGIN_WINDOW = 15 * 60 * 1000;           // 15 分钟
const MAX_FILE_SIZE = 2 * 1024 * 1024;         // 单文件 2MB
const MAX_FILES = 500;
const VERSION = '10.0.0';

const FAVICON_TAG =
  `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,` +
  `%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237c5cff' ` +
  `stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E` +
  `%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'%3E%3C/path%3E` +
  `%3Cpolyline points='14 2 14 8 20 8'%3E%3C/polyline%3E` +
  `%3Cline x1='16' y1='13' x2='8' y2='13'%3E%3C/line%3E%3Cline x1='16' y1='17' x2='8' y2='17'%3E%3C/line%3E` +
  `%3Cline x1='10' y1='9' x2='8' y2='9'%3E%3C/line%3E%3C/svg%3E">`;

/* ==================== 基础工具 ==================== */

const encoder = new TextEncoder();

/** 极简模板填充：把 {{KEY}} 换成值。用函数式 replace，避免 $& 之类的特殊替换符。 */
function fill(tpl, vars) {
  return String(tpl).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '');
}

/** 把值安全地嵌进 <script> 里：转义 < 防止提前闭合脚本标签。 */
function toScriptJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }, extraHeaders || {}),
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

function redirect(location, headers) {
  return new Response(null, { status: 302, headers: Object.assign({ Location: location }, headers || {}) });
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const item = part.trim();
    if (item.startsWith(name + '=')) return item.slice(name.length + 1);
  }
  return null;
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 恒定时间字符串比较，避免时序侧信道。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
}

/* ==================== R2 读写封装 ==================== */

async function r2json(env, key) {
  try {
    const obj = await env.MY_BUCKET.get(key);
    if (!obj) return null;
    return await obj.json();
  } catch (e) {
    console.warn('[r2] read json failed:', key, e && e.message);
    return null;
  }
}

async function r2text(env, key) {
  try {
    const obj = await env.MY_BUCKET.get(key);
    if (!obj) return null;
    return await obj.text();
  } catch (e) {
    return null;
  }
}

async function r2put(env, key, value, contentType) {
  await env.MY_BUCKET.put(key, value, {
    httpMetadata: { contentType: contentType || 'text/plain; charset=utf-8' },
  });
}

function isSystemKey(key) {
  return typeof key === 'string' && key.startsWith('_sys');
}

/* ==================== 设置（含 Turnstile） ==================== */

const DEFAULT_SETTINGS = {
  turnstile: { siteKey: '', secretKey: '' },
  turnstileMode: 'strict',
  site: { title: 'Cloud Note', subtitle: '云端代码记事本 · 文件分享' },
};

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const ts = src.turnstile && typeof src.turnstile === 'object' ? src.turnstile : {};
  const site = src.site && typeof src.site === 'object' ? src.site : {};
  return {
    turnstile: {
      siteKey: typeof ts.siteKey === 'string' ? ts.siteKey.trim() : '',
      secretKey: typeof ts.secretKey === 'string' ? ts.secretKey.trim() : '',
    },
    turnstileMode: src.turnstileMode === 'lenient' ? 'lenient' : 'strict',
    site: {
      title: (typeof site.title === 'string' && site.title.trim()) || DEFAULT_SETTINGS.site.title,
      subtitle: (typeof site.subtitle === 'string' && site.subtitle.trim()) || DEFAULT_SETTINGS.site.subtitle,
    },
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : 0,
  };
}

async function getSettings(env) {
  return normalizeSettings(await r2json(env, KEY_SETTINGS));
}

async function putSettings(env, settings) {
  const clean = normalizeSettings(settings);
  clean.updatedAt = Date.now();
  await r2put(env, KEY_SETTINGS, JSON.stringify(clean), 'application/json');
  return clean;
}

async function isTurnstileForceOff(env) {
  const val = await r2text(env, KEY_TS_OFF);
  if (val === null) return false;
  const t = val.trim();
  return t !== '' && t !== '0';
}

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 10) return value.slice(0, 2) + '••••••';
  return value.slice(0, 6) + '••••••••' + value.slice(-4);
}

/**
 * 解析当前生效的 Turnstile 配置。三段式回退，且只有一个出口函数，
 * 避免任何地方再手写一遍 Boolean(siteKey && secretKey) 导致状态漂移。
 */
async function resolveTurnstile(env) {
  const settings = await getSettings(env);
  const off = await isTurnstileForceOff(env);

  let siteKey = settings.turnstile.siteKey;
  let secretKey = settings.turnstile.secretKey;
  let source = siteKey && secretKey ? 'settings' : 'none';

  if (!(siteKey && secretKey)) {
    const envSite = env.TURNSTILE_SITE_KEY || '';
    const envSecret = env.TURNSTILE_SECRET_KEY || '';
    if (envSite && envSecret) {
      siteKey = envSite;
      secretKey = envSecret;
      source = 'env';
    } else {
      siteKey = '';
      secretKey = '';
      source = 'none';
    }
  }

  if (off) source = 'off';

  return {
    enabled: !off && Boolean(siteKey && secretKey),
    siteKey: off ? '' : siteKey,
    secretKey: off ? '' : secretKey,
    source,
    mode: settings.turnstileMode,
    site: settings.site,
  };
}

/* ==================== Turnstile 校验（按错误码分类降级） ==================== */

const TS_CONFIG_CODES = ['missing-input-secret', 'invalid-input-secret', 'bad-request'];

const TS_CODE_HINTS = {
  'missing-input-response': '没有拿到验证 token：多半是验证框没渲染出来、没完成验证，或页面上的配置是旧的。请强制刷新后重试，并检查 Turnstile widget 的 Hostname Management 是否包含当前域名。',
  'invalid-input-response': 'token 无效：最常见的原因是 Site Key 与 Secret Key 来自两个不同的 widget。请核对两把密钥是否同源。',
  'timeout-or-duplicate': 'token 已过期（有效期 300 秒）或被重复使用，请重新完成一次人机验证。',
  'invalid-input-secret': 'Secret Key 无效或填错了（注意 Site Key 与 Secret Key 都以 0x4AAA 开头，很容易填反）。',
  'missing-input-secret': '没有配置 Secret Key。',
  'bad-request': '请求格式异常，请检查两把密钥是否填写正确。',
  'internal-error': 'Cloudflare 侧临时故障，请稍后重试。',
  'network-error': '无法连接 Turnstile 校验服务，请稍后重试。',
};

async function callSiteVerify(secretKey, token, ip) {
  const form = new FormData();
  form.append('secret', secretKey);
  form.append('response', token || '');
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  try {
    return await res.json();
  } catch (e) {
    return { success: false, 'error-codes': ['bad-request'] };
  }
}

/**
 * 只对「非请求方原因」降级：
 *  - 密钥本身失效 / 校验服务不可达 → 请求方再努力也没用，攻击者也无法制造 → 放行 + 告警
 *  - token 无效 / 过期 / 缺失       → 请求方自己没过 → 拦截
 * 放行条件不可被攻击者操纵，所以不会引入新的绕过路径。
 */
async function verifyTurnstile(token, secretKey, ip) {
  if (!secretKey) return { ok: true, skipped: true, codes: [], configError: false };

  if (!token) {
    // 用「必定无效的探针 token」判断密钥自身是否有效
    try {
      const probe = await callSiteVerify(secretKey, 'XXXX.DUMMY.TOKEN.XXXX', ip);
      const codes = probe['error-codes'] || [];
      const broken = codes.some((c) => TS_CONFIG_CODES.includes(c));
      return {
        ok: false,
        codes: broken ? codes : ['missing-input-response'],
        configError: broken,
      };
    } catch (e) {
      return { ok: false, codes: ['network-error'], configError: true };
    }
  }

  try {
    const out = await callSiteVerify(secretKey, token, ip);
    const codes = out['error-codes'] || [];
    const ok = Boolean(out.success);
    return {
      ok,
      codes,
      configError: !ok && codes.some(
        (c) => TS_CONFIG_CODES.includes(c) || c === 'network-error' || c === 'internal-error'
      ),
    };
  } catch (e) {
    return { ok: false, codes: ['network-error'], configError: true };
  }
}

/** 裁决：返回 { pass, warning, codes, message } */
async function resolveTurnstileCheck(env, token, ip, clientError) {
  const cfg = await resolveTurnstile(env);
  if (!cfg.enabled) return { pass: true, warning: '', codes: [], message: '' };

  const result = await verifyTurnstile(token, cfg.secretKey, ip);
  if (clientError) console.warn('[turnstile] 客户端错误码:', String(clientError).slice(0, 32));
  if (result.ok) return { pass: true, warning: '', codes: [], message: '' };

  const list = result.codes || [];                       // 判定用数组
  const codeText = list.join(', ') || 'unknown';          // 展示用字符串
  const first = list[0] || 'unknown';
  const message = TS_CODE_HINTS[first] || ('人机验证未通过（' + codeText + '）。');

  if (result.configError || cfg.mode === 'lenient') {
    const reason = cfg.mode === 'lenient'
      ? '当前为「宽松模式」，已放行人机验证。'
      : '检测到 Turnstile 配置本身有问题（' + codeText + '），已临时放行以免把自己锁在门外。';
    return {
      pass: true,
      warning: reason + ' 请尽快到「设置 → 安全」检查密钥，或点登录页的「自检」查看详情。',
      codes: list,
      message: message,
    };
  }

  return { pass: false, warning: '', codes: list, message: message };
}

/* ==================== 账号 / 会话 / 限流 ==================== */

async function getConfig(env) {
  return await r2json(env, KEY_CONFIG);
}

async function hashPassword(password, salt) {
  return await sha256hex(salt + ':' + password);
}

async function verifyCredentials(env, config, password) {
  if (!config) return { ok: false };
  if (config.passwordHash && config.salt) {
    const computed = await hashPassword(password, config.salt);
    return { ok: safeEqual(computed, config.passwordHash), legacy: false };
  }
  // v9.x 的明文口令：校验通过后由调用方升级为加盐哈希
  if (typeof config.password === 'string') {
    return { ok: safeEqual(password, config.password), legacy: true };
  }
  return { ok: false };
}

async function upgradeConfigToHashed(env, config, password) {
  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const next = {
    username: config.username,
    salt: salt,
    passwordHash: passwordHash,
    createdAt: config.createdAt || Date.now(),
    upgradedAt: Date.now(),
    version: 2,
  };
  await r2put(env, KEY_CONFIG, JSON.stringify(next), 'application/json');
  return next;
}

async function createSession(env, username) {
  const token = randomHex(32);
  await r2put(env, PREFIX_SESS + token, JSON.stringify({
    u: username,
    exp: Date.now() + SESSION_TTL,
    createdAt: Date.now(),
  }), 'application/json');
  return token;
}

async function checkAuth(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return { isAuthenticated: false };
  const sess = await r2json(env, PREFIX_SESS + token);
  if (!sess || !sess.exp || sess.exp < Date.now()) return { isAuthenticated: false };
  const config = await getConfig(env);
  if (!config || sess.u !== config.username) return { isAuthenticated: false };
  return { isAuthenticated: true, user: sess.u, token: token };
}

async function getThrottle(env, ip) {
  return await r2json(env, PREFIX_THROTTLE + ip);
}

async function bumpThrottle(env, ip) {
  const now = Date.now();
  let cur = await getThrottle(env, ip);
  if (!cur || typeof cur.count !== 'number') cur = { count: 0, until: 0 };
  if (cur.until && cur.until < now) { cur.count = 0; cur.until = 0; }
  cur.count += 1;
  if (cur.count >= LOGIN_MAX_FAIL) cur.until = now + LOGIN_WINDOW;
  await r2put(env, PREFIX_THROTTLE + ip, JSON.stringify(cur), 'application/json');
  return cur;
}

async function clearThrottle(env, ip) {
  try { await env.MY_BUCKET.delete(PREFIX_THROTTLE + ip); } catch (e) { /* ignore */ }
}

/* ==================== 文件名 / 分享记录 ==================== */

function sanitizeFilename(name) {
  let n = String(name == null ? '' : name).trim();
  n = n.replace(/[\\/]+/g, '_');
  n = n.replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.replace(/^[.\s]+/, '');
  if (n.length > 120) n = n.slice(0, 120);
  return n;
}

async function getShareDB(env) {
  const db = await r2json(env, KEY_SHARES);
  return db && typeof db === 'object' ? db : {};
}

async function saveShareDB(env, db) {
  await r2put(env, KEY_SHARES, JSON.stringify(db), 'application/json');
}

/** 清理过期分享，返回 [有效列表, 是否发生变化] */
function pruneShares(db) {
  const now = Date.now();
  const list = [];
  let changed = false;
  for (const token of Object.keys(db)) {
    const info = db[token];
    if (!info || typeof info !== 'object') { delete db[token]; changed = true; continue; }
    if (info.expire && info.expire < now) { delete db[token]; changed = true; continue; }
    list.push(Object.assign({ token: token }, info));
  }
  return [list, changed];
}

async function removeSharesForFile(env, fileId) {
  const db = await getShareDB(env);
  let changed = false;
  for (const token of Object.keys(db)) {
    if (db[token] && db[token].fileId === fileId) { delete db[token]; changed = true; }
  }
  if (changed) await saveShareDB(env, db);
}

async function remapSharesForFile(env, fromId, toId) {
  const db = await getShareDB(env);
  let changed = false;
  for (const token of Object.keys(db)) {
    if (db[token] && db[token].fileId === fromId) { db[token].fileId = toId; changed = true; }
  }
  if (changed) await saveShareDB(env, db);
}

/* ==================== 页面渲染 ==================== */

/** 统一的页面渲染入口：自动补上 favicon，再填充占位符。 */
function render(view, vars) {
  return fill(view, Object.assign({ FAVICON: FAVICON_TAG }, vars || {}));
}

function renderErrorPage(title, message, status) {
  return html(render(errorHtml, {
    TITLE: escapeHtml(title),
    MESSAGE: escapeHtml(message),
  }), status || 500);
}

function renderLoginPage(ts, notice) {
  return html(render(loginHtml, {
    SITE_TITLE: escapeHtml(ts.site.title),
    SITE_SUBTITLE: escapeHtml(ts.site.subtitle),
    TURNSTILE_ENABLED: ts.enabled ? '1' : '0',
    TURNSTILE_SITE_KEY: escapeHtml(ts.siteKey),
    NOTICE: notice ? '<div class="notice">' + escapeHtml(notice) + '</div>' : '',
    BOOT: toScriptJson({
      mode: 'login',
      turnstile: { enabled: ts.enabled, siteKey: ts.siteKey, source: ts.source, mode: ts.mode },
      version: VERSION,
    }),
  }));
}

function renderSetupPage(ts) {
  return html(render(setupHtml, {
    SITE_TITLE: escapeHtml(ts.site.title),
  }));
}

function renderPasswordPage(token, errorText) {
  return html(render(passwordHtml, {
    TOKEN: escapeHtml(token),
    ERROR: errorText ? '<div class="notice">' + escapeHtml(errorText) + '</div>' : '',
  }));
}

function renderAppPage(ts, user) {
  return html(render(appHtml, {
    SITE_TITLE: escapeHtml(ts.site.title),
    SITE_SUBTITLE: escapeHtml(ts.site.subtitle),
    BOOT: toScriptJson({
      user: user,
      version: VERSION,
      turnstile: { enabled: ts.enabled, siteKey: ts.siteKey, source: ts.source, mode: ts.mode },
      site: { title: ts.site.title, subtitle: ts.site.subtitle },
    }),
    VERSION: VERSION,
  }));
}

const LANG_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.ts': 'typescript', '.tsx': 'tsx', '.css': 'css', '.scss': 'scss',
  '.html': 'markup', '.htm': 'markup', '.xml': 'markup', '.svg': 'markup',
  '.json': 'json', '.md': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.php': 'php',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.rb': 'ruby',
};

function detectLang(filename) {
  const name = String(filename || '').toLowerCase();
  const idx = name.lastIndexOf('.');
  if (idx === -1) return 'none';
  return LANG_BY_EXT[name.slice(idx)] || 'none';
}

function isMarkdownFile(filename) {
  const name = String(filename || '').toLowerCase();
  return name.endsWith('.md') || name.endsWith('.markdown');
}

function isHtmlFile(filename) {
  const name = String(filename || '').toLowerCase();
  return name.endsWith('.html') || name.endsWith('.htm');
}

function renderSharePage(code, filename, opts) {
  const options = opts || {};
  const safeName = escapeHtml(filename);
  const md = isMarkdownFile(filename);
  const htmlFile = isHtmlFile(filename);

  const previewButton = (md || htmlFile)
    ? '<button class="btn" id="previewBtn" type="button">预览</button>'
    : '';

  return html(render(shareHtml, {
    FILENAME: safeName,
    LANG: escapeHtml(detectLang(filename)),
    CODE: escapeHtml(code),
    BADGE: options.isPublic
      ? '<span class="badge badge-readonly">只读</span>'
      : '<span class="badge badge-admin">管理员预览</span>',
    PREVIEW_BUTTON: previewButton,
    PREVIEW_KIND: md ? 'markdown' : (htmlFile ? 'html' : ''),
    RAW_JSON: toScriptJson(code),
  }));
}

/* ==================== 主入口 ==================== */

const PUBLIC_API_PATHS = [
  '/api/turnstile/config',
  '/api/turnstile/diagnose',
];

function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

function isPublicApiPath(path) {
  return PUBLIC_API_PATHS.indexOf(path) !== -1;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (!env.MY_BUCKET) {
        const msg = 'R2 存储桶未绑定。请确认 wrangler.jsonc 里的 r2_buckets 配置为 { "binding": "MY_BUCKET" }（不写 bucket_name 即会自动创建并绑定），然后重新部署。';
        if (isApiPath(path)) return json({ error: 'no_bucket', message: msg }, 500);
        return renderErrorPage('存储未绑定', msg, 500);
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
      }

      /* ---------- 公开：分享访问 ---------- */
      if (path === '/share') {
        return await handleShare(request, env, url, ctx);
      }

      /* ---------- 公开：Turnstile 运行时配置 ---------- */
      if (path === '/api/turnstile/config' && request.method === 'GET') {
        const ts = await resolveTurnstile(env);
        return json({ enabled: ts.enabled, siteKey: ts.siteKey, source: ts.source, mode: ts.mode });
      }

      /* ---------- 公开：Turnstile 自检 ---------- */
      if (path === '/api/turnstile/diagnose' && request.method === 'GET') {
        return await handleTurnstileDiagnose(request, env);
      }

      /* ---------- 初始化 ---------- */
      const config = await getConfig(env);

      if (!config) {
        if (path === '/api/setup' && request.method === 'POST') {
          return await handleSetup(request, env);
        }
        if (isApiPath(path)) {
          return json({ error: 'not_initialized', message: '系统尚未初始化' }, 400);
        }
        return renderSetupPage(await getSettings(env));
      }

      // 已初始化后再调用初始化接口 → 明确的 409，而不是被鉴权守卫拦成 401
      if (path === '/api/setup') {
        return json({ error: 'already_initialized', message: '系统已初始化，请直接登录' }, 409);
      }

      /* ---------- 登录 / 登出 ---------- */
      if (path === '/api/login' && request.method === 'POST') {
        return await handleLogin(request, env, config);
      }

      if (path === '/api/logout') {
        const auth = await checkAuth(request, env);
        if (auth.token) {
          try { await env.MY_BUCKET.delete(PREFIX_SESS + auth.token); } catch (e) { /* ignore */ }
        }
        return redirect('/', { 'Set-Cookie': sessionCookie('', 0) });
      }

      /* ---------- 鉴权守卫 ---------- */
      const auth = await checkAuth(request, env);
      if (!auth.isAuthenticated) {
        if (isApiPath(path)) {
          return json({ error: 'unauthorized', message: '登录已过期，请重新登录' }, 401);
        }
        return renderLoginPage(await resolveTurnstile(env), '');
      }

      /* ---------- 受保护的 API ---------- */
      if (isApiPath(path)) {
        return await handleApi(request, env, url, auth, ctx);
      }

      /* ---------- 应用主页面 ---------- */
      return renderAppPage(await resolveTurnstile(env), auth.user);
    } catch (err) {
      console.error('[fatal]', err && err.stack ? err.stack : err);
      const message = String((err && err.message) || err);
      if (isApiPath(path)) return json({ error: 'server_error', message: message }, 500);
      return renderErrorPage('系统错误', '服务器内部错误：' + message, 500);
    }
  },
};

/* ==================== 路由实现 ==================== */

async function handleSetup(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request', message: '请求体格式错误' }, 400); }

  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) return json({ error: 'invalid', message: '请填写用户名和密码' }, 400);
  if (username.length > 32) return json({ error: 'invalid', message: '用户名过长（最多 32 字符）' }, 400);
  if (password.length < 6) return json({ error: 'invalid', message: '密码至少 6 位' }, 400);

  const existing = await getConfig(env);
  if (existing) return json({ error: 'already_initialized', message: '系统已初始化' }, 409);

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  await r2put(env, KEY_CONFIG, JSON.stringify({
    username: username,
    salt: salt,
    passwordHash: passwordHash,
    createdAt: Date.now(),
    version: 2,
  }), 'application/json');

  // 初始化后直接建立会话，避免「注册完再拿旧 token 登录」的坑
  const token = await createSession(env, username);
  return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL / 1000)) });
}

async function handleLogin(request, env, config) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request', message: '请求体格式错误' }, 400); }

  const ip = clientIp(request);

  // 1. 先查限流（必须在打 Turnstile 之前，否则攻击者可用空 token 反复触发探针）
  const throttle = await getThrottle(env, ip);
  if (throttle && throttle.until && throttle.until > Date.now()) {
    const retryAfter = Math.ceil((throttle.until - Date.now()) / 1000);
    return json({
      error: 'too_many_attempts',
      message: '登录失败次数过多，请在 ' + Math.ceil(retryAfter / 60) + ' 分钟后重试。',
      retryAfter: retryAfter,
    }, 429, { 'Retry-After': String(retryAfter) });
  }

  // 2. 人机验证
  const check = await resolveTurnstileCheck(env, body.turnstileToken, ip, body.cfError);
  if (!check.pass) {
    await bumpThrottle(env, ip);
    return json({
      error: 'turnstile_failed',
      codes: check.codes,
      message: check.message,
    }, 403);
  }

  // 3. 口令校验
  const username = String(body.username || '');
  const password = String(body.password || '');
  const usernameOk = safeEqual(username, String(config.username || ''));
  const pwd = await verifyCredentials(env, config, password);

  if (!usernameOk || !pwd.ok) {
    await bumpThrottle(env, ip);
    return json({ error: 'invalid_credentials', message: '账号或密码错误' }, 401);
  }

  // 4. 旧版明文配置自动升级为加盐哈希
  if (pwd.legacy) {
    try { await upgradeConfigToHashed(env, config, password); } catch (e) { console.warn('upgrade failed', e); }
  }

  await clearThrottle(env, ip);
  const token = await createSession(env, config.username);

  return json({
    success: true,
    warning: check.warning || '',
  }, 200, { 'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL / 1000)) });
}

async function handleTurnstileDiagnose(request, env) {
  const ip = clientIp(request);
  const throttle = await getThrottle(env, 'diag_' + ip);
  if (throttle && throttle.until && throttle.until > Date.now()) {
    return json({ error: 'too_many_attempts', message: '自检过于频繁，请稍后再试。' }, 429);
  }
  // 自检也用同一套计数，但阈值更宽松：超过 10 次锁 15 分钟
  {
    const now = Date.now();
    let cur = await getThrottle(env, 'diag_' + ip);
    if (!cur || typeof cur.count !== 'number') cur = { count: 0, until: 0 };
    if (cur.until && cur.until < now) { cur.count = 0; cur.until = 0; }
    cur.count += 1;
    if (cur.count >= 10) cur.until = now + LOGIN_WINDOW;
    await r2put(env, PREFIX_THROTTLE + 'diag_' + ip, JSON.stringify(cur), 'application/json');
  }

  const ts = await resolveTurnstile(env);
  const result = {
    host: new URL(request.url).host,
    source: ts.source,
    mode: ts.mode,
    siteKeyMasked: maskKey(ts.siteKey),
    secretKeyMasked: maskKey(ts.secretKey),
    secretKeyValid: null,
    serverCodes: [],
    conclusion: '',
    advice: [],
  };

  if (ts.source === 'off') {
    result.conclusion = 'emergency-off';
    result.advice.push('破窗开关已开启：R2 中的 _sys_turnstile_off 存在且不为 0。删除该对象即可恢复人机验证。');
  } else if (!ts.enabled) {
    result.conclusion = 'not-configured';
    result.advice.push('尚未配置 Turnstile，登录不受人机验证保护。可在「设置 → 安全」中填写 Site Key 与 Secret Key。');
  } else {
    try {
      const probe = await callSiteVerify(ts.secretKey, 'XXXX.DUMMY.TOKEN.XXXX', ip);
      const codes = probe['error-codes'] || [];
      result.serverCodes = codes;
      const broken = codes.some((c) => TS_CONFIG_CODES.includes(c));
      if (broken) {
        result.secretKeyValid = false;
        result.conclusion = 'secret-invalid';
        result.advice.push(TS_CODE_HINTS[codes[0]] || '密钥无效。');
        result.advice.push('注意：Site Key 与 Secret Key 都以 0x4AAA 开头，极易填反，请核对是否同源。');
        result.advice.push('当前已自动放行登录（严格模式下只对「非请求方原因」降级），但请尽快修正。');
      } else {
        result.secretKeyValid = true;
        result.conclusion = 'secret-ok';
        result.advice.push('Secret Key 有效。若登录页仍报「人机验证未通过」，请检查：');
        result.advice.push('① Turnstile widget 的 Hostname Management 是否包含当前域名 ' + result.host + '（*.workers.dev 需要显式填写，通配符无效）。');
        result.advice.push('② 浏览器是否拦截了 challenges.cloudflare.com 的脚本（广告拦截插件常见）。');
        result.advice.push('③ 强制刷新页面后重试。');
      }
    } catch (e) {
      result.conclusion = 'unreachable';
      result.advice.push('无法连接 Turnstile 校验服务，已按「非请求方原因」放行登录。请稍后重试。');
    }
  }

  return json(result);
}

async function handleShare(request, env, url, ctx) {
  const token = url.searchParams.get('k');
  const rawId = url.searchParams.get('id');

  // A. 管理员直接预览原始文件
  if (rawId) {
    const auth = await checkAuth(request, env);
    if (!auth.isAuthenticated) {
      return renderErrorPage('权限不足', '需要登录管理员账号才能直接预览原始文件。', 403);
    }
    const obj = await env.MY_BUCKET.get(rawId);
    if (!obj) return renderErrorPage('文件不存在', '您请求的文件 ID 不存在。', 404);
    const text = await obj.text();
    if (url.searchParams.get('raw') === 'true') {
      return new Response(text, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    return renderSharePage(text, rawId, { isPublic: false });
  }

  if (!token) return renderErrorPage('链接无效', '缺少必要的访问参数。', 400);

  const db = await getShareDB(env);
  const info = db[token];
  if (!info) return renderErrorPage('链接不存在', '该分享链接不存在或已被取消。', 404);

  if (info.expire && Date.now() > info.expire) {
    return renderErrorPage('链接已过期', '该分享链接已超过有效期，无法继续访问。', 410);
  }

  if (info.maxVisits && info.maxVisits > 0 && (info.views || 0) >= info.maxVisits) {
    return renderErrorPage('链接已失效', '此分享链接已达到最大访问次数限制（阅后即焚），文件已无法访问。', 410);
  }

  let unlocked = !info.password;
  let passwordError = '';
  if (info.password) {
    if (request.method === 'POST') {
      let form;
      try { form = await request.formData(); } catch (e) { form = null; }
      const input = form ? String(form.get('password') || '') : '';
      if (safeEqual(input, String(info.password))) {
        unlocked = true;
      } else {
        passwordError = '密码错误，请重新输入。';
      }
    }
  }

  if (!unlocked) {
    return renderPasswordPage(token, passwordError);
  }

  const obj = await env.MY_BUCKET.get(info.fileId);
  if (!obj) return renderErrorPage('源文件丢失', '分享记录存在，但源文件似乎已被删除。', 404);

  const text = await obj.text();

  // 访问计数（失败不影响返回）
  ctx.waitUntil((async () => {
    try {
      const fresh = await getShareDB(env);
      if (fresh[token]) {
        fresh[token].views = (fresh[token].views || 0) + 1;
        fresh[token].lastViewAt = Date.now();
        await saveShareDB(env, fresh);
      }
    } catch (e) { console.warn('share stat failed', e); }
  })());

  if (url.searchParams.get('raw') === 'true') {
    return new Response(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  return renderSharePage(text, info.fileId, { isPublic: true });
}

/* ==================== 受保护 API ==================== */

async function handleApi(request, env, url, auth, ctx) {
  const path = url.pathname;
  const method = request.method;

  try {
    /* ---- 文件列表 ---- */
    if (path === '/api/list' && method === 'GET') {
      const files = await listAllFiles(env);
      const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
      return json({ success: true, files: files, totalSize: totalSize, user: auth.user });
    }

    /* ---- 读取文件 ---- */
    if (path === '/api/get' && method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'invalid', message: '缺少文件 ID' }, 400);
      const obj = await env.MY_BUCKET.get(id);
      if (!obj) return json({ error: 'not_found', message: '文件不存在' }, 404);
      return json({ success: true, id: id, code: await obj.text() });
    }

    /* ---- 保存文件 ---- */
    if (path === '/api/save' && method === 'POST') {
      const body = await readJson(request);
      if (body === null) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);

      let id = sanitizeFilename(body.id) || randomHex(4);
      if (!id.includes('.')) id += '.js';
      if (isSystemKey(id)) return json({ error: 'invalid', message: '该文件名被系统保留' }, 400);

      const code = typeof body.code === 'string' ? body.code : '';
      if (!code.trim()) return json({ error: 'invalid', message: '内容不能为空' }, 400);
      if (code.length > MAX_FILE_SIZE) return json({ error: 'too_large', message: '文件过大（上限 2MB）' }, 413);

      await r2put(env, id, code, 'text/plain; charset=utf-8');
      return json({ success: true, id: id, size: code.length });
    }

    /* ---- 删除文件 ---- */
    if (path === '/api/delete' && method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id || isSystemKey(id)) return json({ error: 'invalid', message: '无法删除该文件' }, 400);
      await env.MY_BUCKET.delete(id);
      await removeSharesForFile(env, id);
      return json({ success: true });
    }

    /* ---- 批量删除 ---- */
    if (path === '/api/batch_delete' && method === 'POST') {
      const body = await readJson(request);
      if (!body || !Array.isArray(body.ids)) return json({ error: 'invalid', message: '参数无效' }, 400);
      const ids = body.ids.map((x) => String(x)).filter((x) => x && !isSystemKey(x));
      if (!ids.length) return json({ error: 'invalid', message: '没有可删除的文件' }, 400);
      if (ids.length > MAX_FILES) return json({ error: 'invalid', message: '单次最多删除 ' + MAX_FILES + ' 个文件' }, 400);

      await env.MY_BUCKET.delete(ids);
      const db = await getShareDB(env);
      let changed = false;
      for (const token of Object.keys(db)) {
        if (db[token] && ids.indexOf(db[token].fileId) !== -1) { delete db[token]; changed = true; }
      }
      if (changed) await saveShareDB(env, db);
      return json({ success: true, deleted: ids.length });
    }

    /* ---- 重命名 ---- */
    if (path === '/api/rename' && method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);
      const from = String(body.from || '');
      let to = sanitizeFilename(body.to);
      if (!from || isSystemKey(from)) return json({ error: 'invalid', message: '原文件名无效' }, 400);
      if (!to) return json({ error: 'invalid', message: '新文件名无效' }, 400);
      if (!to.includes('.')) to += '.js';
      if (isSystemKey(to)) return json({ error: 'invalid', message: '该文件名被系统保留' }, 400);
      if (to === from) return json({ success: true, id: to, unchanged: true });

      const src = await env.MY_BUCKET.get(from);
      if (!src) return json({ error: 'not_found', message: '原文件不存在' }, 404);
      const exists = await env.MY_BUCKET.get(to);
      if (exists) return json({ error: 'conflict', message: '目标文件名已存在' }, 409);

      const text = await src.text();
      await r2put(env, to, text, 'text/plain; charset=utf-8');
      await env.MY_BUCKET.delete(from);
      await remapSharesForFile(env, from, to);
      return json({ success: true, id: to });
    }

    /* ---- 复制文件 ---- */
    if (path === '/api/duplicate' && method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);
      const from = String(body.from || '');
      if (!from || isSystemKey(from)) return json({ error: 'invalid', message: '原文件名无效' }, 400);

      const src = await env.MY_BUCKET.get(from);
      if (!src) return json({ error: 'not_found', message: '原文件不存在' }, 404);
      const text = await src.text();

      const dot = from.lastIndexOf('.');
      const base = dot > 0 ? from.slice(0, dot) : from;
      const ext = dot > 0 ? from.slice(dot) : '.js';
      let to = base + '-copy' + ext;
      for (let i = 2; i < 200; i++) {
        const candidate = await env.MY_BUCKET.get(to);
        if (!candidate) break;
        to = base + '-copy' + i + ext;
      }
      await r2put(env, to, text, 'text/plain; charset=utf-8');
      return json({ success: true, id: to });
    }

    /* ---- 分享列表 ---- */
    if (path === '/api/share/list' && method === 'GET') {
      const db = await getShareDB(env);
      const [list, changed] = pruneShares(db);
      if (changed) await saveShareDB(env, db);
      list.sort((a, b) => (b.created || 0) - (a.created || 0));
      return json({ success: true, shares: list });
    }

    /* ---- 创建分享 ---- */
    if (path === '/api/share/create' && method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);
      const fileId = String(body.fileId || '');
      if (!fileId || isSystemKey(fileId)) return json({ error: 'invalid', message: '未指定有效文件' }, 400);

      const exists = await env.MY_BUCKET.get(fileId);
      if (!exists) return json({ error: 'not_found', message: '文件不存在，请先保存' }, 404);

      const expireSeconds = parseInt(body.expire, 10) || 0;
      const maxVisits = parseInt(body.maxVisits, 10) || 0;
      const password = String(body.password || '');

      const token = randomHex(16);
      const db = await getShareDB(env);
      db[token] = {
        fileId: fileId,
        password: password,
        expire: expireSeconds > 0 ? Date.now() + expireSeconds * 1000 : null,
        maxVisits: maxVisits > 0 ? maxVisits : 0,
        created: Date.now(),
        views: 0,
      };
      await saveShareDB(env, db);
      return json({ success: true, token: token });
    }

    /* ---- 取消分享 ---- */
    if (path === '/api/share/delete' && method === 'DELETE') {
      const token = url.searchParams.get('token');
      if (!token) return json({ error: 'invalid', message: '缺少 token' }, 400);
      const db = await getShareDB(env);
      if (db[token]) { delete db[token]; await saveShareDB(env, db); }
      return json({ success: true });
    }

    /* ---- 批量取消分享 ---- */
    if (path === '/api/share/batch_delete' && method === 'POST') {
      const body = await readJson(request);
      if (!body || !Array.isArray(body.tokens)) return json({ error: 'invalid', message: '参数无效' }, 400);
      const db = await getShareDB(env);
      let changed = false;
      for (const t of body.tokens) {
        if (db[String(t)]) { delete db[String(t)]; changed = true; }
      }
      if (changed) await saveShareDB(env, db);
      return json({ success: true });
    }

    /* ---- 统计 ---- */
    if (path === '/api/stats' && method === 'GET') {
      const files = await listAllFiles(env);
      const db = await getShareDB(env);
      const [list] = pruneShares(db);
      const now = Date.now();
      return json({
        success: true,
        files: files.length,
        bytes: files.reduce((s, f) => s + (f.size || 0), 0),
        shares: list.length,
        activeShares: list.filter((s) => !(s.maxVisits > 0 && (s.views || 0) >= s.maxVisits)).length,
        totalViews: list.reduce((s, x) => s + (x.views || 0), 0),
        newest: files.length ? files.reduce((a, b) => (new Date(a.uploaded) > new Date(b.uploaded) ? a : b)).key : null,
        serverTime: now,
      });
    }

    /* ---- 读取设置 ---- */
    if (path === '/api/settings' && method === 'GET') {
      const settings = await getSettings(env);
      const ts = await resolveTurnstile(env);
      return json({
        success: true,
        settings: {
          site: settings.site,
          turnstileMode: settings.turnstileMode,
          updatedAt: settings.updatedAt,
        },
        turnstile: {
          siteKey: settings.turnstile.siteKey,
          siteKeyMasked: maskKey(settings.turnstile.siteKey),
          siteKeySet: Boolean(settings.turnstile.siteKey),
          secretKeyMasked: maskKey(settings.turnstile.secretKey),
          secretKeySet: Boolean(settings.turnstile.secretKey),
          effectiveSource: ts.source,
          enabled: ts.enabled,
          mode: ts.mode,
        },
        account: { username: auth.user },
      });
    }

    /* ---- 保存设置 ---- */
    if (path === '/api/settings' && method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);

      const current = await getSettings(env);
      const next = normalizeSettings(current);

      // 站点信息
      if (body.site && typeof body.site === 'object') {
        if (typeof body.site.title === 'string') next.site.title = body.site.title.trim().slice(0, 40) || DEFAULT_SETTINGS.site.title;
        if (typeof body.site.subtitle === 'string') next.site.subtitle = body.site.subtitle.trim().slice(0, 60) || DEFAULT_SETTINGS.site.subtitle;
      }

      // 校验模式
      if (typeof body.turnstileMode === 'string') {
        next.turnstileMode = body.turnstileMode === 'lenient' ? 'lenient' : 'strict';
      }

      // Turnstile 密钥：字段不传 = 不修改；显式空串 = 清空
      let siteKey = next.turnstile.siteKey;
      let secretKey = next.turnstile.secretKey;
      if (typeof body.turnstileSiteKey === 'string') siteKey = body.turnstileSiteKey.trim();
      if (typeof body.turnstileSecretKey === 'string') secretKey = body.turnstileSecretKey.trim();

      if (siteKey && secretKey && siteKey === secretKey) {
        return json({
          error: 'invalid',
          message: 'Site Key 与 Secret Key 不能相同 —— 这是最常见的填反错误。两把密钥都以 0x4AAA 开头，请仔细核对。',
        }, 400);
      }

      // 成对校验：只填一半直接拒绝（两项同时为空 = 清空，合法）
      if (Boolean(siteKey) !== Boolean(secretKey)) {
        return json({
          error: 'pair_required',
          message: siteKey
            ? '只填了 Site Key，缺少 Secret Key。两项需要同时存在或同时清空。'
            : '只填了 Secret Key，缺少 Site Key。两项需要同时存在或同时清空。',
        }, 400);
      }

      next.turnstile.siteKey = siteKey;
      next.turnstile.secretKey = secretKey;

      const saved = await putSettings(env, next);
      const ts = await resolveTurnstile(env);

      return json({
        success: true,
        settings: { site: saved.site, turnstileMode: saved.turnstileMode, updatedAt: saved.updatedAt },
        turnstile: {
          siteKey: saved.turnstile.siteKey,
          siteKeyMasked: maskKey(saved.turnstile.siteKey),
          siteKeySet: Boolean(saved.turnstile.siteKey),
          secretKeyMasked: maskKey(saved.turnstile.secretKey),
          secretKeySet: Boolean(saved.turnstile.secretKey),
          effectiveSource: ts.source,
          enabled: ts.enabled,
          mode: ts.mode,
        },
      });
    }

    /* ---- 修改密码 ---- */
    if (path === '/api/password' && method === 'POST') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request', message: '请求体格式错误' }, 400);

      const config = await getConfig(env);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      const newUsername = typeof body.username === 'string' ? body.username.trim() : '';

      if (!newPassword || newPassword.length < 6) {
        return json({ error: 'invalid', message: '新密码至少 6 位' }, 400);
      }

      const verified = await verifyCredentials(env, config, oldPassword);
      if (!verified.ok) return json({ error: 'invalid_credentials', message: '当前密码不正确' }, 401);

      const username = newUsername || config.username;
      if (username.length > 32) return json({ error: 'invalid', message: '用户名过长（最多 32 字符）' }, 400);

      const salt = randomHex(16);
      const passwordHash = await hashPassword(newPassword, salt);
      await r2put(env, KEY_CONFIG, JSON.stringify({
        username: username,
        salt: salt,
        passwordHash: passwordHash,
        createdAt: config.createdAt || Date.now(),
        updatedAt: Date.now(),
        version: 2,
      }), 'application/json');

      // 改密后吊销其它会话（保留当前这一个）
      const keep = auth.token;
      try {
        const listed = await env.MY_BUCKET.list({ prefix: PREFIX_SESS, limit: 1000 });
        const toDelete = listed.objects.map((o) => o.key).filter((k) => k !== PREFIX_SESS + keep);
        if (toDelete.length) await env.MY_BUCKET.delete(toDelete);
      } catch (e) { console.warn('revoke sessions failed', e); }

      return json({ success: true, username: username, message: '密码已更新，其它设备上的登录已失效。' });
    }

    return json({ error: 'not_found', message: '接口不存在：' + path }, 404);
  } catch (err) {
    console.error('[api]', path, err && err.stack ? err.stack : err);
    return json({ error: 'server_error', message: String((err && err.message) || err) }, 500);
  }
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return null;
  }
}

async function listAllFiles(env) {
  const files = [];
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await env.MY_BUCKET.list({ limit: 500, cursor: cursor });
    for (const obj of listed.objects) {
      if (isSystemKey(obj.key)) continue;
      files.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded),
      });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }
  files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return files;
}
