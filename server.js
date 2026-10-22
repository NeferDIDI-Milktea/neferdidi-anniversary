'use strict';

// Built with Node.js core modules only: no npm install is required.
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'submissions.json');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe-2026-OnlyLocal';
const MAX_UPLOAD_MB = Math.min(500, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const submissionRates = new Map();
const loginRates = new Map();

for (const dir of [UPLOAD_DIR, DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]\n', 'utf8');
if (ADMIN_PASSWORD === 'ChangeMe-2026-OnlyLocal') {
  console.warn('\n[SECURITY] ADMIN_PASSWORD is using the local demo password. Set a unique ADMIN_PASSWORD before exposing this site publicly.\n');
}

const extensions = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function json(res, status, value, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(payload);
}
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}
function getIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 100); }
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}
function safeEquals(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function isSecureRequest(req) { return !!(req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'); }
function parseCookies(req) {
  const result = {};
  for (const entry of String(req.headers.cookie || '').split(';')) {
    const i = entry.indexOf('='); if (i < 0) continue;
    const key = entry.slice(0, i).trim();
    try { result[key] = decodeURIComponent(entry.slice(i + 1).trim()); } catch { result[key] = ''; }
  }
  return result;
}
function cookieHeader(req, sid, clear = false) {
  const parts = [`nd_admin=${clear ? '' : encodeURIComponent(sid)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isSecureRequest(req)) parts.push('Secure');
  parts.push(`Max-Age=${clear ? 0 : Math.floor(SESSION_TTL_MS / 1000)}`);
  return parts.join('; ');
}
function authorized(req) {
  const sid = parseCookies(req).nd_admin;
  const session = sid && sessions.get(sid);
  if (!session || session.expiresAt <= Date.now()) { if (sid) sessions.delete(sid); return false; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}
function apiAuth(req, res) {
  if (authorized(req)) return true;
  json(res, 401, { error: 'سجّل الدخول الأول.' }, { 'Set-Cookie': cookieHeader(req, '', true) });
  return false;
}
async function readSubmissions() {
  try {
    const raw = await fsp.readFile(DB_FILE, 'utf8'); const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) { if (err.code === 'ENOENT') return []; throw new Error('تعذر قراءة سجل المشاركات.'); }
}
async function writeSubmissions(items) {
  const temp = `${DB_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, DB_FILE);
}
function publicSubmission(item) {
  return { id: item.id, name: item.name, branch: item.branch, note: item.note, fileType: item.fileType, fileSize: item.fileSize,
    originalName: item.originalName, createdAt: item.createdAt, consentMarketing: item.consentMarketing, consentSubmit: item.consentSubmit };
}
function parseDisposition(header) {
  const result = {};
  const name = /(?:^|;)\s*name="((?:[^"\\]|\\.)*)"/i.exec(header || '');
  const filename = /(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/i.exec(header || '');
  if (name) result.name = name[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (filename) result.filename = filename[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return result;
}
function parseMultipart(buffer, contentType) {
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!match) throw new Error('نوع الطلب غير صحيح.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  if (boundary.length < 5 || boundary.length > 200) throw new Error('حدود الملف غير صحيحة.');
  const nextMarker = Buffer.concat([Buffer.from('\r\n'), boundary]);
  const fields = {}; let file = null; let cursor = 0; let parts = 0;
  while (cursor < buffer.length) {
    let boundaryPos = buffer.indexOf(boundary, cursor);
    if (boundaryPos < 0) break;
    let partStart = boundaryPos + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
    if (buffer.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), partStart);
    if (headerEnd < 0) throw new Error('تعذر قراءة بيانات الملف.');
    const headerText = buffer.subarray(partStart, headerEnd).toString('utf8');
    const headers = {};
    for (const line of headerText.split('\r\n')) { const ix = line.indexOf(':'); if (ix > 0) headers[line.slice(0, ix).trim().toLowerCase()] = line.slice(ix + 1).trim(); }
    const disposition = parseDisposition(headers['content-disposition']);
    const dataStart = headerEnd + 4;
    const nextPos = buffer.indexOf(nextMarker, dataStart);
    if (nextPos < 0) throw new Error('الملف المرفوع غير مكتمل.');
    const data = buffer.subarray(dataStart, nextPos);
    parts++;
    if (parts > 20) throw new Error('عدد الحقول أكبر من المسموح.');
    if (disposition.filename !== undefined && disposition.name === 'media') {
      if (file) throw new Error('ارفع ملفًا واحدًا فقط.');
      file = { originalName: disposition.filename || 'neferdidi-moment', mimeType: (headers['content-type'] || 'application/octet-stream').toLowerCase(), data };
    } else if (disposition.name) {
      fields[disposition.name] = data.toString('utf8');
    }
    cursor = nextPos + 2;
  }
  return { fields, file };
}
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let finished = false;
    req.on('data', chunk => {
      if (finished) return;
      total += chunk.length;
      if (total > limit) {
        finished = true; reject(Object.assign(new Error('حجم الطلب أكبر من الحد المسموح.'), { statusCode: 413 }));
        req.resume(); return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks, total)); } });
    req.on('error', err => { if (!finished) { finished = true; reject(err); } });
  });
}
async function readJsonBody(req, limit = 64 * 1024) {
  const body = await readRequestBody(req, limit);
  try { return body.length ? JSON.parse(body.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('بيانات الطلب غير صحيحة.'), { statusCode: 400 }); }
}
function rateCheck(store, ip, limit, windowMs) {
  const now = Date.now(); let record = store.get(ip);
  if (!record || now >= record.resetAt) record = { count: 0, resetAt: now + windowMs };
  record.count++; store.set(ip, record);
  return record.count <= limit;
}
function sendStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded === '/admin') decoded = '/admin.html';
  const target = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('الصفحة مش موجودة.'); return; }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(target).pipe(res);
  });
}
function sendProtectedMedia(req, res, mediaPath, type, downloadName) {
  fs.stat(mediaPath, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: 'ملف المشاركة مش موجود على السيرفر.' });
    const safeName = path.basename(downloadName || 'neferdidi-moment').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Type', type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    const disposition = req.url.includes('/download') ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startRaw, endRaw] = range.slice(6).split('-');
      let start = startRaw ? Number(startRaw) : Math.max(0, stat.size - Number(endRaw));
      let end = endRaw && startRaw ? Number(endRaw) : stat.size - 1;
      if (!startRaw && endRaw) end = stat.size - 1;
      if (start < 0 || end < start || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(mediaPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size }); fs.createReadStream(mediaPath).pipe(res);
    }
  });
}

async function handle(req, res) {
  setSecurityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, service: 'neferdidi-anniversary' });

  if (req.method === 'POST' && pathname === '/api/submissions') {
    if (!rateCheck(submissionRates, getIp(req), 5, 60 * 60 * 1000)) return json(res, 429, { error: 'وصلنا عدد كبير من المحاولات من نفس الاتصال. جرّب بعد شوية.' });
    let uploadedPath = null;
    try {
      const buffer = await readRequestBody(req, MAX_UPLOAD_BYTES + 1024 * 1024);
      const { fields, file } = parseMultipart(buffer, req.headers['content-type']);
      if (!file || !file.data.length) return json(res, 400, { error: 'اختار صورة أو فيديو الأول.' });
      if (file.data.length > MAX_UPLOAD_BYTES) return json(res, 413, { error: `حجم الملف أكبر من الحد المسموح (${MAX_UPLOAD_MB} ميجابايت).` });
      if (!Object.prototype.hasOwnProperty.call(extensions, file.mimeType)) return json(res, 400, { error: 'نوع الملف غير مدعوم.' });
      const name = cleanText(fields.name, 80); const branch = cleanText(fields.branch, 80); const note = cleanText(fields.note, 300);
      const consentSubmit = fields.consentSubmit === 'true'; const consentMarketing = fields.consentMarketing === 'true';
      if (!name) return json(res, 400, { error: 'اكتب اسمك علشان نكمل.' });
      if (!consentSubmit) return json(res, 400, { error: 'الموافقة على إرسال المشاركة مطلوبة.' });
      const id = crypto.randomUUID(); const storedName = `${id}${extensions[file.mimeType]}`;
      uploadedPath = path.join(UPLOAD_DIR, storedName);
      await fsp.writeFile(uploadedPath, file.data, { flag: 'wx', mode: 0o600 });
      const now = new Date().toISOString(); const items = await readSubmissions();
      const originalName = path.basename(file.originalName || 'neferdidi-moment').replace(/[\r\n\u0000]/g, '_').slice(0, 180);
      items.unshift({ id, name, branch, note, fileType: file.mimeType, fileSize: file.data.length, originalName, storedName,
        createdAt: now, consentSubmit, consentMarketing, consentSubmitAt: now, consentMarketingAt: consentMarketing ? now : null });
      await writeSubmissions(items);
      return json(res, 201, { ok: true, id, message: 'تم استلام مشاركتك بنجاح.' });
    } catch (err) {
      if (uploadedPath) await fsp.unlink(uploadedPath).catch(() => {});
      console.error('Submission error:', err.message);
      const status = err.statusCode || (err.message.includes('نوع الملف') || err.message.includes('الملف') || err.message.includes('حدود') ? 400 : 500);
      return json(res, status, { error: status === 500 ? 'حصلت مشكلة في حفظ المشاركة. جرّب تاني.' : err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (!rateCheck(loginRates, getIp(req), 10, 15 * 60 * 1000)) return json(res, 429, { error: 'محاولات تسجيل الدخول كتير. جرّب بعد 15 دقيقة.' });
    try {
      const body = await readJsonBody(req, 16 * 1024);
      if (!safeEquals(typeof body.password === 'string' ? body.password : '', ADMIN_PASSWORD)) return json(res, 401, { error: 'كلمة المرور غير صحيحة.' });
      const sid = crypto.randomBytes(32).toString('hex'); sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL_MS });
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, sid) });
    } catch (err) { return json(res, err.statusCode || 400, { error: err.message }); }
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!apiAuth(req, res)) return;
    if (req.method === 'POST' && pathname === '/api/admin/logout') {
      const sid = parseCookies(req).nd_admin; sessions.delete(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', true) });
    }
    if (req.method === 'GET' && pathname === '/api/admin/me') return json(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/api/admin/submissions') {
      try {
        const items = await readSubmissions(); const q = cleanText(url.searchParams.get('q') || '', 80).toLocaleLowerCase();
        const consentValue = url.searchParams.get('consent'); const consent = consentValue === 'yes' ? true : consentValue === 'no' ? false : null;
        const filtered = items.filter(item => {
          const matchesText = !q || [item.name, item.branch, item.note, item.originalName].some(value => String(value || '').toLocaleLowerCase().includes(q));
          return matchesText && (consent === null || Boolean(item.consentMarketing) === consent);
        });
        return json(res, 200, { items: filtered.map(publicSubmission), total: items.length, filtered: filtered.length });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    const mediaMatch = /^\/api\/admin\/submissions\/([^/]+)\/(media|download)$/.exec(pathname);
    if (req.method === 'GET' && mediaMatch) {
      try {
        const id = decodeURIComponent(mediaMatch[1]); const items = await readSubmissions(); const item = items.find(entry => entry.id === id);
        if (!item) return json(res, 404, { error: 'المشاركة مش موجودة.' });
        const fileName = path.basename(item.storedName || ''); const mediaPath = path.join(UPLOAD_DIR, fileName);
        return sendProtectedMedia(req, res, mediaPath, item.fileType, mediaMatch[2] === 'download' ? item.originalName : fileName);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    const deleteMatch = /^\/api\/admin\/submissions\/([^/]+)$/.exec(pathname);
    if (req.method === 'DELETE' && deleteMatch) {
      try {
        const id = decodeURIComponent(deleteMatch[1]); const items = await readSubmissions(); const index = items.findIndex(item => item.id === id);
        if (index < 0) return json(res, 404, { error: 'المشاركة مش موجودة.' });
        const [item] = items.splice(index, 1); await writeSubmissions(items);
        await fsp.unlink(path.join(UPLOAD_DIR, path.basename(item.storedName || ''))).catch(err => { if (err.code !== 'ENOENT') throw err; });
        return json(res, 200, { ok: true });
      } catch { return json(res, 500, { error: 'تعذر حذف المشاركة.' }); }
    }
    return json(res, 404, { error: 'المسار المطلوب مش موجود.' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return sendStatic(req, res, pathname);
  return json(res, 405, { error: 'طريقة الطلب غير مدعومة.' }, { Allow: 'GET, HEAD' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('Request error:', err.message);
    if (!res.headersSent) json(res, 500, { error: 'حصل خطأ غير متوقع في السيرفر.' });
    else res.destroy();
  });
});
server.listen(PORT, () => {
  console.log(`Neferdidi Anniversary is running at http://localhost:${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
  console.log(`Upload limit: ${MAX_UPLOAD_MB} MB`);
});

// Periodically discard expired auth and rate-limit entries.
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
  for (const map of [submissionRates, loginRates]) for (const [key, value] of map) if (value.resetAt <= now) map.delete(key);
}, 10 * 60 * 1000).unref();
