const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');
const GUESTBOOK_FILE = path.join(DATA_DIR, 'guestbook.json');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN_RAW = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');
// HTTP headers must be ISO-8859-1. If the env-provided token contains
// non-ASCII characters we hash it so the over-the-wire value is always hex.
const ADMIN_TOKEN = /^[\x20-\x7E]+$/.test(ADMIN_TOKEN_RAW)
  ? ADMIN_TOKEN_RAW
  : crypto.createHash('sha256').update(ADMIN_TOKEN_RAW).digest('hex');
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ENTRIES = 5000;
const MAX_GUEST_ENTRIES = 2000;
const MAX_MSG_LEN = 500;
const GRADE_CLASS_MAP = {
  1: [1, 2],
  2: [1, 2],
  3: [1, 2],
  4: [1, 2],
  5: [1, 2, 3],
  6: [1, 2, 3]
};

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
if (!fs.existsSync(DATA_FILE)) {
  try { fs.writeFileSync(DATA_FILE, '[]', 'utf-8'); } catch (e) {}
}
if (!fs.existsSync(GUESTBOOK_FILE)) {
  try { fs.writeFileSync(GUESTBOOK_FILE, '[]', 'utf-8'); } catch (e) {}
}

function dedupBoard(list) {
  const bestByUser = new Map();
  for (const e of list) {
    const k = userKey(e);
    const prev = bestByUser.get(k);
    if (!prev || isBetter(e, prev)) bestByUser.set(k, e);
  }
  return Array.from(bestByUser.values());
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav'
};
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.wav']);
const AUDIO_DIR = path.join(ROOT, 'audio');

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const cleaned = decoded.replace(/\\/g, '/').replace(/\/+/g, '/');
  const resolved = path.normalize(path.join(root, cleaned));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function readBoard() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

let writeChain = Promise.resolve();
function writeBoard(list) {
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(list), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DATA_FILE, (err2) => err2 ? reject(err2) : resolve());
    });
  })).catch((err) => { console.error('writeBoard failed', err); });
  return writeChain;
}

function readGuestbook() {
  try {
    const raw = fs.readFileSync(GUESTBOOK_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

let guestWriteChain = Promise.resolve();
function writeGuestbook(list) {
  guestWriteChain = guestWriteChain.then(() => new Promise((resolve, reject) => {
    const tmp = GUESTBOOK_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(list), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, GUESTBOOK_FILE, (err2) => err2 ? reject(err2) : resolve());
    });
  })).catch((err) => { console.error('writeGuestbook failed', err); });
  return guestWriteChain;
}

const AUTHOR_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const REACTION_TYPES = ['heart', 'thumbs'];
const VALID_ROLES = ['student', 'teacher', 'guest'];
function normalizeRole(r) {
  return VALID_ROLES.includes(r) ? r : 'student';
}

function validateGuestPost(body) {
  if (!body || typeof body !== 'object') return { errs: ['invalid body'] };
  const errs = [];
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) errs.push('name required');
  const role = normalizeRole(body.role);
  let grade = null, classNum = null;
  if (role === 'student') {
    grade = Math.floor(Number(body.grade));
    classNum = Math.floor(Number(body.classNum));
    const allowed = GRADE_CLASS_MAP[grade];
    if (!allowed) errs.push('grade must be 1-6');
    else if (!Number.isFinite(classNum) || !allowed.includes(classNum)) {
      errs.push('classNum not allowed for this grade');
    }
  }
  const message = String(body.message || '').replace(/\r\n/g, '\n').trim();
  if (!message) errs.push('message required');
  else if (message.length > MAX_MSG_LEN) errs.push('message too long');
  const authorKey = body.authorKey == null ? '' : String(body.authorKey);
  if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) errs.push('authorKey invalid');
  if (errs.length) return { errs };
  return { errs, clean: { name, role, grade, classNum, message, authorKey: authorKey || null } };
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function validateEntry(body) {
  if (!body || typeof body !== 'object') return { errs: ['invalid body'] };
  const errs = [];
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) errs.push('name required');
  const role = normalizeRole(body.role);
  const total = Math.floor(Number(body.total));
  if (!Number.isFinite(total) || total <= 0 || total > 200) errs.push('total out of range');
  const correct = Math.floor(Number(body.correct));
  if (!Number.isFinite(correct) || correct < 0 || (Number.isFinite(total) && correct > total)) errs.push('correct out of range');
  const score = Math.floor(Number(body.score));
  const maxScore = (Number.isFinite(total) && total > 0 ? total : 200) * 10;
  if (!Number.isFinite(score) || score < 0 || score > maxScore) errs.push('score out of range');
  const durationMs = Math.floor(Number(body.durationMs));
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) errs.push('duration out of range');

  let grade = null, classNum = null;
  if (role === 'student') {
    grade = Math.floor(Number(body.grade));
    classNum = Math.floor(Number(body.classNum));
    const allowed = GRADE_CLASS_MAP[grade];
    if (!allowed) errs.push('grade must be 1-6');
    else if (!Number.isFinite(classNum) || !allowed.includes(classNum)) {
      errs.push('classNum not allowed for this grade');
    }
  }
  if (errs.length) return { errs };
  return {
    errs,
    clean: { name, role, total, correct, score, durationMs, grade, classNum }
  };
}

const rateMap = new Map();
function rateOk(ip, limit = 5, windowMs = 10000) {
  const now = Date.now();
  const arr = (rateMap.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { rateMap.set(ip, arr); return false; }
  arr.push(now);
  rateMap.set(ip, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rateMap.entries()) {
    const recent = arr.filter((t) => now - t < 60000);
    if (recent.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, recent);
  }
}, 60000).unref();

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    const pad = Buffer.alloc(Math.max(ab.length, bb.length, 1));
    try { crypto.timingSafeEqual(pad, pad); } catch (_) {}
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res) {
  const token = req.headers['x-admin-token'] || '';
  if (!ADMIN_TOKEN || !timingSafeEq(token, ADMIN_TOKEN)) {
    sendJSON(res, 401, { error: '관리자 권한이 필요합니다.' });
    return false;
  }
  return true;
}

function getClientIp(req) {
  const h = req.headers['x-forwarded-for'];
  if (typeof h === 'string' && h.length) return h.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function genId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function userKey(e) {
  const role = normalizeRole(e && e.role);
  const name = String((e && e.name) || '').trim();
  if (role === 'teacher') return 'teacher|' + name;
  if (role === 'guest') return 'guest|' + name;
  const g = e && Number.isFinite(Number(e.grade)) ? Number(e.grade) : '';
  const c = e && Number.isFinite(Number(e.classNum)) ? Number(e.classNum) : '';
  return 'student|' + g + '|' + c + '|' + name;
}
function isSameUser(a, b) { return userKey(a) === userKey(b); }
function accuracyOf(e) {
  const t = Number(e && e.total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const c = Number(e && e.correct) || 0;
  return c / t;
}
function isBetter(a, b) {
  const aa = accuracyOf(a), ab = accuracyOf(b);
  if (aa !== ab) return aa > ab;
  const ad = Number(a && a.durationMs), bd = Number(b && b.durationMs);
  const af = Number.isFinite(ad) ? ad : Infinity;
  const bf = Number.isFinite(bd) ? bd : Infinity;
  if (af !== bf) return af < bf;
  const at = Number(a && a.timestamp) || 0;
  const bt = Number(b && b.timestamp) || 0;
  return at < bt;
}

async function handleApi(req, res, url) {
  if (url === '/api/leaderboard' && req.method === 'GET') {
    return sendJSON(res, 200, { list: dedupBoard(readBoard()) });
  }
  if (url === '/api/leaderboard' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const { errs, clean } = validateEntry(body);
    if (errs && errs.length) return sendJSON(res, 400, { error: '유효하지 않은 요청', details: errs });
    let list = readBoard();
    const entry = Object.assign({ id: genId(), timestamp: Date.now() }, clean);
    const sameUserIdxs = [];
    for (let i = 0; i < list.length; i++) {
      if (isSameUser(list[i], entry)) sameUserIdxs.push(i);
    }
    let kept = entry;
    if (sameUserIdxs.length) {
      let bestIdx = sameUserIdxs[0];
      for (const i of sameUserIdxs) if (isBetter(list[i], list[bestIdx])) bestIdx = i;
      const prevBest = list[bestIdx];
      list = list.filter((_, i) => !sameUserIdxs.includes(i));
      if (isBetter(entry, prevBest)) {
        list.push(entry);
        kept = entry;
      } else {
        list.push(prevBest);
        kept = prevBest;
      }
    } else {
      list.push(entry);
    }
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    await writeBoard(list);
    return sendJSON(res, 201, { entry: kept, submitted: entry, list });
  }
  if (url === '/api/leaderboard/clear' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await writeBoard([]);
    return sendJSON(res, 200, { ok: true });
  }
  if (url === '/api/guestbook' && req.method === 'GET') {
    return sendJSON(res, 200, { list: readGuestbook() });
  }
  if (url === '/api/guestbook' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const { errs, clean } = validateGuestPost(body);
    if (errs && errs.length) return sendJSON(res, 400, { error: '유효하지 않은 요청', details: errs });
    const list = readGuestbook();
    const entry = Object.assign({ id: 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), timestamp: Date.now() }, clean);
    list.push(entry);
    if (list.length > MAX_GUEST_ENTRIES) list.splice(0, list.length - MAX_GUEST_ENTRIES);
    await writeGuestbook(list);
    return sendJSON(res, 201, { entry, list });
  }
  if (url === '/api/guestbook/user-edit' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String(body && body.id || '');
    const authorKey = String(body && body.authorKey || '');
    const message = String(body && body.message || '').replace(/\r\n/g, '\n').trim();
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > MAX_MSG_LEN) return sendJSON(res, 400, { error: 'message too long' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey)) {
      return sendJSON(res, 403, { error: '본인이 작성한 방명록만 수정할 수 있어요.' });
    }
    list[idx].message = message;
    list[idx].editedAt = Date.now();
    await writeGuestbook(list);
    return sendJSON(res, 200, { entry: list[idx], list });
  }
  if (url === '/api/guestbook/user-delete' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String(body && body.id || '');
    const authorKey = String(body && body.authorKey || '');
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey)) {
      return sendJSON(res, 403, { error: '본인이 작성한 방명록만 삭제할 수 있어요.' });
    }
    list.splice(idx, 1);
    await writeGuestbook(list);
    return sendJSON(res, 200, { ok: true, list });
  }
  if (url === '/api/guestbook/react' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 20, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String(body && body.id || '');
    const authorKey = String(body && body.authorKey || '');
    const reaction = String(body && body.reaction || '');
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
    if (!REACTION_TYPES.includes(reaction)) return sendJSON(res, 400, { error: 'reaction invalid' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    const post = list[idx];
    if (!post.reactions || typeof post.reactions !== 'object') post.reactions = {};
    const bucket = Array.isArray(post.reactions[reaction]) ? post.reactions[reaction] : [];
    const pos = bucket.indexOf(authorKey);
    if (pos === -1) bucket.push(authorKey);
    else bucket.splice(pos, 1);
    post.reactions[reaction] = bucket;
    await writeGuestbook(list);
    return sendJSON(res, 200, { entry: post, list });
  }
  if (url === '/api/guestbook/clear' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await writeGuestbook([]);
    return sendJSON(res, 200, { ok: true });
  }
  if (url === '/api/guestbook/edit' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String(body && body.id || '');
    const message = String(body && body.message || '').replace(/\r\n/g, '\n').trim();
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > MAX_MSG_LEN) return sendJSON(res, 400, { error: 'message too long' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    list[idx].message = message;
    list[idx].editedAt = Date.now();
    await writeGuestbook(list);
    return sendJSON(res, 200, { entry: list[idx], list });
  }
  if (url === '/api/guestbook/delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String(body && body.id || '');
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    list.splice(idx, 1);
    await writeGuestbook(list);
    return sendJSON(res, 200, { ok: true, list });
  }
  if (url === '/api/admin/login' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 8, 60000)) return sendJSON(res, 429, { error: '로그인 시도가 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const u = String(body && body.username || '');
    const p = String(body && body.password || '');
    const okUser = timingSafeEq(u, ADMIN_USERNAME);
    const okPass = timingSafeEq(p, ADMIN_PASSWORD);
    if (!(okUser && okPass)) return sendJSON(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    return sendJSON(res, 200, { token: ADMIN_TOKEN });
  }
  if (url === '/api/admin/verify' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    return sendJSON(res, 200, { ok: true });
  }
  if (url === '/api/audio/list' && req.method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(AUDIO_DIR)
        .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
        .filter((f) => !f.startsWith('.'))
        .sort()
        .map((f) => '/audio/' + encodeURIComponent(f));
    } catch (_) { /* directory may not exist yet */ }
    return sendJSON(res, 200, { files });
  }
  if (url === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, entries: readBoard().length, guestbook: readGuestbook().length });
  }
  return sendJSON(res, 404, { error: 'not found' });
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = safeJoin(ROOT, urlPath);
  if (!filePath) { res.writeHead(400); return res.end('Bad Request'); }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      fs.readFile(path.join(ROOT, 'index.html'), (e, data) => {
        if (e) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        if (req.method === 'HEAD') return res.end();
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const urlOnly = (req.url || '/').split('?')[0];
  if (urlOnly.startsWith('/api/')) {
    handleApi(req, res, urlOnly).catch((err) => {
      console.error('api error', err);
      sendJSON(res, 500, { error: 'internal error' });
    });
    return;
  }
  serveStatic(req, res);
});

try {
  const initial = readBoard();
  const deduped = dedupBoard(initial);
  if (deduped.length !== initial.length) {
    writeBoard(deduped);
    console.log(`leaderboard deduped on startup: ${initial.length} → ${deduped.length}`);
  }
} catch (e) { console.error('startup dedup failed', e); }

server.listen(PORT, HOST, () => {
  console.log(`wonang-plants server listening on http://${HOST}:${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
  if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN env not set — a random one was generated for this run.');
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.log(`Admin credentials: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD} (override via ADMIN_USERNAME / ADMIN_PASSWORD env).`);
  }
});
