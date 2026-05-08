const http = require('http');
const https = require('https');
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

const PDF_CACHE_DIR = path.join(DATA_DIR, 'pdf-cache');
const PDF_GUIDE_FILE = path.join(PDF_CACHE_DIR, 'wonang-plant-guide.pdf');
const PDF_GUIDE_SOURCE = 'https://github.com/xxhanddrgn/wonang-plants/releases/download/guide-v1/wonang-plant-guide.pdf';
try { fs.mkdirSync(PDF_CACHE_DIR, { recursive: true }); } catch (_) {}

let pdfCachePromise = null;
function downloadFollow(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return downloadFollow(next, destPath, redirects + 1).then(resolve, reject);
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('http ' + code));
      }
      const tmp = destPath + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => fs.rename(tmp, destPath, (err) => err ? reject(err) : resolve())));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}
function ensurePdfGuideCached() {
  if (fs.existsSync(PDF_GUIDE_FILE)) return Promise.resolve();
  if (!pdfCachePromise) {
    console.log('caching PDF guide from', PDF_GUIDE_SOURCE);
    pdfCachePromise = downloadFollow(PDF_GUIDE_SOURCE, PDF_GUIDE_FILE)
      .then(() => console.log('PDF guide cached at', PDF_GUIDE_FILE))
      .catch((err) => { console.error('PDF cache failed', err); pdfCachePromise = null; throw err; });
  }
  return pdfCachePromise;
}
// Kick off the cache on startup so the first user request is fast.
ensurePdfGuideCached().catch(() => {});

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
const VALID_ROLES = ['student', 'teacher', 'parent', 'guest'];
function normalizeRole(r) {
  return VALID_ROLES.includes(r) ? r : 'student';
}

// Admin-only override of an existing post / comment / answer's identity.
// Returns true when something changed. Trims and length-caps name; lets the
// admin reassign role and (for students) grade / classNum too.
function applyAdminIdentity(target, body, isAdmin) {
  if (!isAdmin || !target || !body) return false;
  let changed = false;
  if (typeof body.name === 'string') {
    const name = body.name.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (name && name !== target.name) { target.name = name; changed = true; }
  }
  if (typeof body.role === 'string' && body.role) {
    const role = normalizeRole(body.role);
    if (role !== target.role) {
      target.role = role;
      if (role !== 'student') { target.grade = null; target.classNum = null; }
      changed = true;
    }
  }
  if (target.role === 'student') {
    if (body.grade != null) {
      const g = Math.floor(Number(body.grade));
      if (Number.isFinite(g) && GRADE_CLASS_MAP[g] && g !== target.grade) {
        target.grade = g; changed = true;
      }
    }
    if (body.classNum != null) {
      const c = Math.floor(Number(body.classNum));
      const allowed = GRADE_CLASS_MAP[target.grade] || [];
      if (Number.isFinite(c) && allowed.includes(c) && c !== target.classNum) {
        target.classNum = c; changed = true;
      }
    }
  }
  return changed;
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
  const audioCheck = validateAudio(body.audio);
  if (audioCheck.err) errs.push(audioCheck.err);
  if (errs.length) return { errs };
  return { errs, clean: { name, role, grade, classNum, message, authorKey: authorKey || null, audio: audioCheck.audio || null } };
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJSONBody(req, max) {
  const limit = Number.isFinite(max) && max > 0 ? max : MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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
  if (role === 'parent') return 'parent|' + name;
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
    try { body = await readJSONBody(req, 5_000_000); }
    catch (e) { return sendJSON(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
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
    try { body = await readJSONBody(req, 5_000_000); }
    catch (e) { return sendJSON(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
    const id = String(body && body.id || '');
    const authorKey = String(body && body.authorKey || '');
    const message = String(body && body.message || '').replace(/\r\n/g, '\n').trim();
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!isAdmin && (!authorKey || !AUTHOR_KEY_RE.test(authorKey))) return sendJSON(res, 400, { error: 'authorKey required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > MAX_MSG_LEN) return sendJSON(res, 400, { error: 'message too long' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!isAdmin && (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey))) {
      return sendJSON(res, 403, { error: '본인이 작성한 방명록만 수정할 수 있어요.' });
    }
    list[idx].message = message;
    applyAdminIdentity(list[idx], body, isAdmin);
    if (body && Object.prototype.hasOwnProperty.call(body, 'audio')) {
      if (body.audio === null || body.audio === '') {
        list[idx].audio = null;
      } else {
        const audioCheck = validateAudio(body.audio);
        if (audioCheck.err) return sendJSON(res, 400, { error: audioCheck.err });
        list[idx].audio = audioCheck.audio;
      }
    }
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
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!isAdmin && (!authorKey || !AUTHOR_KEY_RE.test(authorKey))) return sendJSON(res, 400, { error: 'authorKey required' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!isAdmin && (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey))) {
      return sendJSON(res, 403, { error: '본인이 작성한 방명록만 삭제할 수 있어요.' });
    }
    list.splice(idx, 1);
    await writeGuestbook(list);
    return sendJSON(res, 200, { ok: true, list });
  }
  if (url === '/api/guestbook/comment' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String(body && body.postId || '');
    if (!postId) return sendJSON(res, 400, { error: 'postId required' });
    const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return sendJSON(res, 400, { error: 'name required' });
    const role = normalizeRole(body && body.role);
    let grade = null, classNum = null;
    if (role === 'student') {
      grade = Math.floor(Number(body && body.grade));
      classNum = Math.floor(Number(body && body.classNum));
      const allowed = GRADE_CLASS_MAP[grade];
      if (!allowed) return sendJSON(res, 400, { error: 'grade must be 1-6' });
      if (!Number.isFinite(classNum) || !allowed.includes(classNum)) return sendJSON(res, 400, { error: 'classNum not allowed for this grade' });
    }
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > 300) return sendJSON(res, 400, { error: 'message too long' });
    const authorKey = body && body.authorKey == null ? '' : String(body.authorKey);
    if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey invalid' });
    const list = readGuestbook();
    const idx = list.findIndex((e) => e.id === postId);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    const post = list[idx];
    if (!Array.isArray(post.comments)) post.comments = [];
    if (post.comments.length >= 500) return sendJSON(res, 400, { error: '댓글이 너무 많아요.' });
    const comment = {
      id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      name, role, grade, classNum, message,
      authorKey: authorKey || null
    };
    post.comments.push(comment);
    await writeGuestbook(list);
    return sendJSON(res, 201, { comment, entry: post, list });
  }
  if (url === '/api/guestbook/comment/delete' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String(body && body.postId || '');
    const commentId = String(body && body.commentId || '');
    const authorKey = String(body && body.authorKey || '');
    if (!postId || !commentId) return sendJSON(res, 400, { error: 'postId and commentId required' });
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    const list = readGuestbook();
    const pIdx = list.findIndex((e) => e.id === postId);
    if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
    const post = list[pIdx];
    if (!Array.isArray(post.comments)) post.comments = [];
    const cIdx = post.comments.findIndex((c) => c.id === commentId);
    if (cIdx === -1) return sendJSON(res, 404, { error: 'comment not found' });
    const comment = post.comments[cIdx];
    if (!isAdmin) {
      if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
      if (!comment.authorKey || !timingSafeEq(comment.authorKey, authorKey)) {
        return sendJSON(res, 403, { error: '본인이 작성한 댓글만 삭제할 수 있어요.' });
      }
    }
    post.comments.splice(cIdx, 1);
    await writeGuestbook(list);
    return sendJSON(res, 200, { ok: true, entry: post, list });
  }
  if (url === '/api/guestbook/comment/edit' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String(body && body.postId || '');
    const commentId = String(body && body.commentId || '');
    const authorKey = String(body && body.authorKey || '');
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!postId || !commentId) return sendJSON(res, 400, { error: 'postId and commentId required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > 300) return sendJSON(res, 400, { error: 'message too long' });
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    const list = readGuestbook();
    const pIdx = list.findIndex((e) => e.id === postId);
    if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
    const post = list[pIdx];
    if (!Array.isArray(post.comments)) post.comments = [];
    const cIdx = post.comments.findIndex((c) => c.id === commentId);
    if (cIdx === -1) return sendJSON(res, 404, { error: 'comment not found' });
    const comment = post.comments[cIdx];
    if (!isAdmin) {
      if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
      if (!comment.authorKey || !timingSafeEq(comment.authorKey, authorKey)) {
        return sendJSON(res, 403, { error: '본인이 작성한 댓글만 수정할 수 있어요.' });
      }
    }
    comment.message = message;
    applyAdminIdentity(comment, body, isAdmin);
    comment.editedAt = Date.now();
    await writeGuestbook(list);
    return sendJSON(res, 200, { ok: true, comment, entry: post, list });
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
  if (url === '/api/admin/rename' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const board = String((body && body.board) || '');
    const postId = String((body && body.postId) || '');
    const commentId = String((body && body.commentId) || '');
    const answerId = String((body && body.answerId) || '');
    if (!postId) return sendJSON(res, 400, { error: 'postId required' });
    let list, target;
    if (board === 'guestbook') {
      list = readGuestbook();
      const post = list.find((e) => e.id === postId);
      if (!post) return sendJSON(res, 404, { error: 'post not found' });
      if (commentId) {
        if (!Array.isArray(post.comments)) post.comments = [];
        target = post.comments.find((c) => c.id === commentId);
        if (!target) return sendJSON(res, 404, { error: 'comment not found' });
      } else {
        target = post;
      }
    } else if (POST_TYPES[board]) {
      list = readPostFile(board);
      const post = list.find((e) => e.id === postId);
      if (!post) return sendJSON(res, 404, { error: 'post not found' });
      if (answerId) {
        if (!Array.isArray(post.answers)) post.answers = [];
        target = post.answers.find((a) => a.id === answerId);
        if (!target) return sendJSON(res, 404, { error: 'answer not found' });
      } else if (commentId) {
        if (!Array.isArray(post.comments)) post.comments = [];
        target = post.comments.find((c) => c.id === commentId);
        if (!target) return sendJSON(res, 404, { error: 'comment not found' });
      } else {
        target = post;
      }
    } else {
      return sendJSON(res, 400, { error: 'unknown board' });
    }
    const changed = applyAdminIdentity(target, body, true);
    if (!changed) return sendJSON(res, 400, { error: '바꿀 내용이 없어요.' });
    target.editedAt = Date.now();
    if (board === 'guestbook') await writeGuestbook(list);
    else await writePostFile(board, list);
    return sendJSON(res, 200, { ok: true, target, list });
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
  // ==================== Generic posts (student / qa / nature) ====================
  const postsMatch = /^\/api\/posts\/([a-z]+)(?:\/(.*))?$/.exec(url);
  if (postsMatch) {
    const type = postsMatch[1];
    const sub = postsMatch[2] || '';
    if (!POST_TYPES[type]) return sendJSON(res, 404, { error: 'unknown post type' });
    return handlePostsApi(req, res, type, sub);
  }
  // ==================== Mini-game leaderboards ====================
  const gameMatch = /^\/api\/games\/([a-z]+)\/(leaderboard|score|leaderboard\/clear)$/.exec(url);
  if (gameMatch) {
    const gameType = gameMatch[1];
    const sub = gameMatch[2];
    if (!GAME_TYPES[gameType]) return sendJSON(res, 404, { error: 'unknown game type' });
    return handleGameApi(req, res, gameType, sub);
  }
  if (url === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, entries: readBoard().length, guestbook: readGuestbook().length });
  }
  if (url.startsWith('/api/notifications') && !url.startsWith('/api/notifications/my-posts') && req.method === 'GET') {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (_) { return sendJSON(res, 400, { error: 'bad url' }); }
    const authorKey = u.searchParams.get('authorKey') || '';
    const nameParam = (u.searchParams.get('name') || '').trim();
    const roleParam = (u.searchParams.get('role') || '').trim();
    const gradeParam = u.searchParams.get('grade') || '';
    const classParam = u.searchParams.get('classNum') || '';
    if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey invalid' });
    if (!authorKey && !nameParam) return sendJSON(res, 200, { comments: 0, reactions: 0 });
    const isMine = (obj) => {
      if (!obj) return false;
      if (authorKey && obj.authorKey === authorKey) return true;
      if (nameParam && obj.name === nameParam) {
        const objRole = obj.role || '';
        if (roleParam && objRole !== roleParam) return false;
        if (roleParam === 'student') {
          return String(obj.grade || '') === gradeParam && String(obj.classNum || '') === classParam;
        }
        return true;
      }
      return false;
    };
    let comments = 0, reactions = 0;
    const countUniqueReactors = (obj) => {
      if (!obj || typeof obj !== 'object') return 0;
      const reactors = new Set();
      for (const key of Object.keys(obj)) {
        const arr = Array.isArray(obj[key]) ? obj[key] : [];
        for (const k of arr) {
          if (!k) continue;
          if (authorKey && k === authorKey) continue;
          reactors.add(k);
        }
      }
      return reactors.size;
    };
    const scanPost = (p) => {
      if (!isMine(p)) return;
      if (Array.isArray(p.comments)) {
        for (const c of p.comments) {
          if (isMine(c)) continue;
          comments++;
        }
      }
      reactions += countUniqueReactors(p.reactions);
      if (Array.isArray(p.answers)) {
        for (const a of p.answers) {
          if (!isMine(a)) comments++;
        }
      }
    };
    for (const type of Object.keys(POST_TYPES)) {
      const list = readPostFile(type);
      for (const p of list) scanPost(p);
    }
    const guest = readGuestbook();
    for (const p of guest) scanPost(p);
    return sendJSON(res, 200, { comments, reactions });
  }
  if (url.startsWith('/api/notifications/my-posts') && req.method === 'GET') {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch (_) { return sendJSON(res, 400, { error: 'bad url' }); }
    const authorKey = u.searchParams.get('authorKey') || '';
    const nameParam = (u.searchParams.get('name') || '').trim();
    const roleParam = (u.searchParams.get('role') || '').trim();
    const gradeParam = u.searchParams.get('grade') || '';
    const classParam = u.searchParams.get('classNum') || '';
    if ((!authorKey || !AUTHOR_KEY_RE.test(authorKey)) && !nameParam) {
      return sendJSON(res, 400, { error: 'authorKey or name required' });
    }
    // Identifies a post / comment / answer as belonging to the current user.
    // authorKey is per-browser, so also accept a match on (name + role + grade + classNum)
    // so posts created from another device or before a storage reset are still recognised.
    const isMine = (obj) => {
      if (!obj) return false;
      if (authorKey && obj.authorKey === authorKey) return true;
      if (nameParam && obj.name === nameParam) {
        const objRole = obj.role || '';
        if (roleParam && objRole !== roleParam) return false;
        if (roleParam === 'student') {
          return String(obj.grade || '') === gradeParam && String(obj.classNum || '') === classParam;
        }
        return true;
      }
      return false;
    };
    const countUniqueReactors = (obj) => {
      if (!obj || typeof obj !== 'object') return 0;
      const reactors = new Set();
      for (const key of Object.keys(obj)) {
        const arr = Array.isArray(obj[key]) ? obj[key] : [];
        for (const k of arr) {
          if (!k) continue;
          if (authorKey && k === authorKey) continue;
          reactors.add(k);
        }
      }
      return reactors.size;
    };
    const sumActivityTs = (p) => {
      let t = p.timestamp || 0;
      if (Array.isArray(p.comments)) for (const c of p.comments) if (c.timestamp && c.timestamp > t) t = c.timestamp;
      if (Array.isArray(p.answers)) for (const a of p.answers) if (a.timestamp && a.timestamp > t) t = a.timestamp;
      return t;
    };
    const myPosts = [];
    const collect = (board, boardLabel, p) => {
      if (!isMine(p)) return;
      const reactionCount = countUniqueReactors(p.reactions);
      const comments = Array.isArray(p.comments)
        ? p.comments.filter((c) => c && !isMine(c)).map((c) => ({
            id: c.id, name: c.name, role: c.role, grade: c.grade, classNum: c.classNum,
            message: (c.message || '').slice(0, 200), timestamp: c.timestamp || 0
          }))
        : [];
      const answers = Array.isArray(p.answers)
        ? p.answers.filter((a) => a && !isMine(a)).map((a) => ({
            id: a.id, name: a.name, role: a.role, grade: a.grade, classNum: a.classNum,
            message: (a.message || '').slice(0, 200), timestamp: a.timestamp || 0
          }))
        : [];
      if (reactionCount === 0 && comments.length === 0 && answers.length === 0) return;
      myPosts.push({
        board, boardLabel,
        postId: p.id,
        title: p.title || (p.message || '').slice(0, 40) || '(제목 없음)',
        timestamp: p.timestamp || 0,
        latestActivity: sumActivityTs(p),
        reactionCount,
        comments,
        answers
      });
    };
    const boardLabels = { student: '식물앨범', nature: '자연 이야기', qa: '질문 꽃', guestbook: '방명록' };
    for (const type of Object.keys(POST_TYPES)) {
      const list = readPostFile(type);
      for (const p of list) collect(type, boardLabels[type] || type, p);
    }
    for (const p of readGuestbook()) collect('guestbook', boardLabels.guestbook, p);
    myPosts.sort((a, b) => (b.latestActivity || 0) - (a.latestActivity || 0));
    return sendJSON(res, 200, { posts: myPosts });
  }
  return sendJSON(res, 404, { error: 'not found' });
}

// ==================== POSTS CONTENT TYPES ====================
const MAX_PHOTO_BODY = 1_200_000;   // ~1.15 MB, fits 500KB base64 JPEG + overhead
const MAX_POSTS_ENTRIES = 2000;
const MAX_AUDIO_BYTES = 4_200_000;   // ~4.2 MB base64 ≈ 3 MB raw
const AUDIO_DATA_RE = /^data:audio\/(mpeg|mp3|mp4|wav|wave|x-wav|ogg|webm|aac|m4a|x-m4a);base64,[A-Za-z0-9+/=]+$/;
// A "light" version of a post with its heavy media stripped down to just
// what the list cards need: a single cover photo for the thumbnail, and
// boolean flags for audio + photo count. The detail screen fetches the
// full post via /api/posts/:type/item/:id when the card is opened.
function toLightPost(p) {
  if (!p || typeof p !== 'object') return p;
  const o = Object.assign({}, p);
  if (Array.isArray(p.photos)) {
    o.photoCount = p.photos.length;
    o.photos = p.photos.length ? [p.photos[0]] : [];
  }
  if (typeof p.photo === 'string' && p.photo) {
    o.hasPhoto = true;
    // Keep p.photo for QA cards' thumbnail; that one's already a single image.
  }
  if (typeof p.audio === 'string' && p.audio) {
    o.hasAudio = true;
    o.audio = null;
  } else {
    o.hasAudio = false;
  }
  return o;
}
function toLightList(list) {
  return Array.isArray(list) ? list.map(toLightPost) : list;
}
function validateAudio(raw) {
  if (!raw) return { audio: null };
  if (typeof raw !== 'string') return { err: 'audio invalid' };
  if (!AUDIO_DATA_RE.test(raw)) return { err: 'audio invalid' };
  if (raw.length > MAX_AUDIO_BYTES) return { err: 'audio too large' };
  return { audio: raw };
}
const POST_TYPES = {
  student: {
    file: path.join(DATA_DIR, 'posts-student.json'),
    extras: ['location', 'title', 'photos', 'audio'],
    maxMsgLen: 500,
    hasPhoto: true,
    photoBodyLimit: 8_500_000
  },
  qa: {
    file: path.join(DATA_DIR, 'posts-qa.json'),
    extras: ['title', 'photo', 'audio'],
    maxMsgLen: 2000,
    hasAnswers: true,
    hasOptionalPhoto: true,
    photoBodyLimit: 5_500_000
  },
  nature: {
    file: path.join(DATA_DIR, 'posts-nature.json'),
    extras: ['title', 'origin', 'source', 'photos', 'audio'],
    maxMsgLen: 2000,
    hasOptionalPhotos: true,
    photoBodyLimit: 8_500_000
  }
};
// Ensure each data file exists as []
for (const t of Object.keys(POST_TYPES)) {
  const f = POST_TYPES[t].file;
  if (!fs.existsSync(f)) { try { fs.writeFileSync(f, '[]', 'utf-8'); } catch (_) {} }
}
const postWriteChains = {};
function readPostFile(type) {
  try {
    const raw = fs.readFileSync(POST_TYPES[type].file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writePostFile(type, list) {
  const f = POST_TYPES[type].file;
  postWriteChains[type] = (postWriteChains[type] || Promise.resolve()).then(() => new Promise((resolve, reject) => {
    const tmp = f + '.tmp';
    fs.writeFile(tmp, JSON.stringify(list), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, f, (err2) => err2 ? reject(err2) : resolve());
    });
  })).catch((err) => { console.error('writePostFile ' + type + ' failed', err); });
  return postWriteChains[type];
}

// One-time migration: comments posted on Q&A through the brief
// generic-comment system are recovered by promoting them into the
// answers list so they remain visible.
function migrateQaCommentsIntoAnswers() {
  try {
    const list = readPostFile('qa');
    let dirty = false;
    for (const p of list) {
      if (!Array.isArray(p.comments) || p.comments.length === 0) continue;
      if (!Array.isArray(p.answers)) p.answers = [];
      const sorted = p.comments.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const c of sorted) {
        const message = (typeof c.message === 'string' ? c.message : '').trim();
        if (!message) continue;
        p.answers.push({
          id: 'a_' + (c.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
          timestamp: c.timestamp || Date.now(),
          name: c.name || '익명',
          role: c.role || null,
          grade: c.grade || null,
          classNum: c.classNum || null,
          message,
          authorKey: c.authorKey || null,
          reactions: {},
          migratedFromComment: true
        });
      }
      p.comments = [];
      dirty = true;
    }
    if (dirty) writePostFile('qa', list);
  } catch (e) { console.error('qa comment migration failed:', e); }
}
migrateQaCommentsIntoAnswers();

function validatePostCommon(body, { maxMsgLen }) {
  const errs = [];
  const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) errs.push('name required');
  const role = normalizeRole(body && body.role);
  let grade = null, classNum = null;
  if (role === 'student') {
    grade = Math.floor(Number(body && body.grade));
    classNum = Math.floor(Number(body && body.classNum));
    const allowed = GRADE_CLASS_MAP[grade];
    if (!allowed) errs.push('grade must be 1-6');
    else if (!Number.isFinite(classNum) || !allowed.includes(classNum)) errs.push('classNum not allowed for this grade');
  }
  const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
  if (!message) errs.push('message required');
  else if (message.length > maxMsgLen) errs.push('message too long');
  const authorKey = body && body.authorKey == null ? '' : String(body.authorKey);
  if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) errs.push('authorKey invalid');
  return { errs, clean: { name, role, grade, classNum, message, authorKey: authorKey || null } };
}

function validateStudentExtras(body) {
  const errs = [];
  const title = String((body && body.title) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!title) errs.push('title required');
  const location = body && body.location === 'offsite' ? 'offsite' : 'onsite';
  const photosRaw = body && body.photos;
  const photos = [];
  if (!Array.isArray(photosRaw) || photosRaw.length === 0) {
    errs.push('at least 1 photo required');
  } else if (photosRaw.length > 3) {
    errs.push('max 3 photos');
  } else {
    for (const p of photosRaw) {
      if (typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) {
        errs.push('photo invalid'); break;
      }
      if (p.length > 900000) { errs.push('photo too large'); break; }
      photos.push(p);
    }
  }
  const audioCheck = validateAudio(body && body.audio);
  if (audioCheck.err) errs.push(audioCheck.err);
  return { errs, clean: { location, title, photos, audio: audioCheck.audio || null } };
}
function validateQaExtras(body) {
  const errs = [];
  const title = String((body && body.title) || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!title) errs.push('title required');
  const photoRaw = typeof (body && body.photo) === 'string' ? body.photo : '';
  let photo = null;
  if (photoRaw) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photoRaw)) errs.push('photo invalid');
    else if (photoRaw.length > 900000) errs.push('photo too large');
    else photo = photoRaw;
  }
  const audioCheck = validateAudio(body && body.audio);
  if (audioCheck.err) errs.push(audioCheck.err);
  return { errs, clean: { title, photo, audio: audioCheck.audio || null } };
}
function validateNatureExtras(body) {
  const errs = [];
  const title = String((body && body.title) || '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!title) errs.push('title required');
  const origin = body && body.origin === 'quoted' ? 'quoted' : 'self';
  let source = null;
  if (origin === 'quoted') {
    source = String((body && body.source) || '').trim().slice(0, 120);
    if (!source) errs.push('source required for quoted');
  }
  const photosRaw = body && body.photos;
  const photos = [];
  if (Array.isArray(photosRaw)) {
    if (photosRaw.length > 3) errs.push('max 3 photos');
    else {
      for (const p of photosRaw) {
        if (typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p)) {
          errs.push('photo invalid'); break;
        }
        if (p.length > 900000) { errs.push('photo too large'); break; }
        photos.push(p);
      }
    }
  }
  const audioCheck = validateAudio(body && body.audio);
  if (audioCheck.err) errs.push(audioCheck.err);
  return { errs, clean: { title, origin, source, photos, audio: audioCheck.audio || null } };
}

function validatePost(type, body) {
  const cfg = POST_TYPES[type];
  const base = validatePostCommon(body, { maxMsgLen: cfg.maxMsgLen });
  if (base.errs.length) return base;
  let extra = { errs: [], clean: {} };
  if (type === 'student') extra = validateStudentExtras(body);
  else if (type === 'qa') extra = validateQaExtras(body);
  else if (type === 'nature') extra = validateNatureExtras(body);
  if (extra.errs.length) return { errs: extra.errs };
  return { errs: [], clean: Object.assign({}, base.clean, extra.clean) };
}

function genPostId(type) {
  return type[0] + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function handlePostsApi(req, res, type, sub) {
  const cfg = POST_TYPES[type];
  const ip = getClientIp(req);
  const bodyLimit = cfg.photoBodyLimit || ((cfg.hasPhoto || cfg.hasOptionalPhoto || cfg.hasOptionalPhotos) ? MAX_PHOTO_BODY : MAX_BODY_BYTES);

  // GET /api/posts/:type
  // Always returns a light list with media stripped — the album/nature/qa
  // boards used to push every base64 photo and audio in one response,
  // which made the page take seconds to load for a board with many posts.
  // Detail screens refetch the full post via /api/posts/:type/item/:id.
  if (sub === '' && req.method === 'GET') {
    return sendJSON(res, 200, { list: toLightList(readPostFile(type)) });
  }
  // GET /api/posts/:type/item/:id — full post, used by the detail screen.
  if (req.method === 'GET' && /^item\/[A-Za-z0-9_-]+$/.test(sub)) {
    const id = sub.slice('item/'.length);
    const post = readPostFile(type).find((e) => e.id === id);
    if (!post) return sendJSON(res, 404, { error: 'not found' });
    return sendJSON(res, 200, { entry: post });
  }
  // POST /api/posts/:type  (create)
  if (sub === '' && req.method === 'POST') {
    if (!rateOk(ip)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req, bodyLimit); }
    catch (e) { return sendJSON(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
    const { errs, clean } = validatePost(type, body);
    if (errs && errs.length) return sendJSON(res, 400, { error: '유효하지 않은 요청', details: errs });
    const list = readPostFile(type);
    const entry = Object.assign({
      id: genPostId(type), timestamp: Date.now(),
      reactions: {}, comments: []
    }, clean);
    if (cfg.hasAnswers) entry.answers = [];
    list.push(entry);
    if (list.length > MAX_POSTS_ENTRIES) list.splice(0, list.length - MAX_POSTS_ENTRIES);
    await writePostFile(type, list);
    return sendJSON(res, 201, { entry, list: toLightList(list) });
  }
  // POST /api/posts/:type/user-edit
  if (sub === 'user-edit' && req.method === 'POST') {
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req, bodyLimit); }
    catch (e) { return sendJSON(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
    const id = String((body && body.id) || '');
    const authorKey = String((body && body.authorKey) || '');
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!isAdmin && (!authorKey || !AUTHOR_KEY_RE.test(authorKey))) return sendJSON(res, 400, { error: 'authorKey required' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!isAdmin && (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey))) {
      return sendJSON(res, 403, { error: '본인이 작성한 글만 수정할 수 있어요.' });
    }
    // Apply the subset of fields the type allows. Always accept message; plus type extras that make sense to edit.
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > cfg.maxMsgLen) return sendJSON(res, 400, { error: 'message too long' });
    list[idx].message = message;
    applyAdminIdentity(list[idx], body, isAdmin);
    if (body && Object.prototype.hasOwnProperty.call(body, 'audio')) {
      if (body.audio === null || body.audio === '') {
        list[idx].audio = null;
      } else {
        const audioCheck = validateAudio(body.audio);
        if (audioCheck.err) return sendJSON(res, 400, { error: audioCheck.err });
        list[idx].audio = audioCheck.audio;
      }
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'photo') && type === 'qa') {
      if (body.photo === null || body.photo === '') {
        list[idx].photo = null;
      } else if (typeof body.photo === 'string') {
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(body.photo) || body.photo.length > 900000) {
          return sendJSON(res, 400, { error: 'photo invalid' });
        }
        list[idx].photo = body.photo;
      }
    }
    if (type === 'student') {
      if (body && body.location) list[idx].location = body.location === 'offsite' ? 'offsite' : 'onsite';
      if (body && typeof body.title === 'string') {
        const t = body.title.trim().replace(/\s+/g, ' ').slice(0, 40);
        if (t) list[idx].title = t;
      }
      if (Array.isArray(body && body.photos)) {
        if (body.photos.length === 0 || body.photos.length > 3) {
          return sendJSON(res, 400, { error: 'photos must have 1-3 items' });
        }
        for (const p of body.photos) {
          if (typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) || p.length > 900000) {
            return sendJSON(res, 400, { error: 'photo invalid' });
          }
        }
        list[idx].photos = body.photos.slice();
      }
    } else if (type === 'qa' || type === 'nature') {
      if (body && typeof body.title === 'string') {
        const t = body.title.trim().replace(/\s+/g, ' ').slice(0, 100);
        if (t) list[idx].title = t;
      }
      if (type === 'nature') {
        if (body && body.origin === 'self') { list[idx].origin = 'self'; list[idx].source = null; }
        else if (body && body.origin === 'quoted') {
          list[idx].origin = 'quoted';
          const src = String((body && body.source) || '').trim().slice(0, 120);
          if (!src) return sendJSON(res, 400, { error: 'source required for quoted' });
          list[idx].source = src;
        }
        if (Array.isArray(body && body.photos)) {
          if (body.photos.length > 3) {
            return sendJSON(res, 400, { error: 'photos must be 0-3 items' });
          }
          for (const p of body.photos) {
            if (typeof p !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p) || p.length > 900000) {
              return sendJSON(res, 400, { error: 'photo invalid' });
            }
          }
          list[idx].photos = body.photos.slice();
        }
      }
    }
    list[idx].editedAt = Date.now();
    await writePostFile(type, list);
    return sendJSON(res, 200, { entry: list[idx], list: toLightList(list) });
  }
  // POST /api/posts/:type/user-delete
  if (sub === 'user-delete' && req.method === 'POST') {
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String((body && body.id) || '');
    const authorKey = String((body && body.authorKey) || '');
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!isAdmin && (!authorKey || !AUTHOR_KEY_RE.test(authorKey))) return sendJSON(res, 400, { error: 'authorKey required' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    if (!isAdmin && (!list[idx].authorKey || !timingSafeEq(list[idx].authorKey, authorKey))) {
      return sendJSON(res, 403, { error: '본인이 작성한 글만 삭제할 수 있어요.' });
    }
    list.splice(idx, 1);
    await writePostFile(type, list);
    return sendJSON(res, 200, { ok: true, list: toLightList(list) });
  }
  // POST /api/posts/:type/react
  if (sub === 'react' && req.method === 'POST') {
    if (!rateOk(ip, 20, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String((body && body.id) || '');
    const authorKey = String((body && body.authorKey) || '');
    const reaction = String((body && body.reaction) || '');
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
    if (!REACTION_TYPES.includes(reaction)) return sendJSON(res, 400, { error: 'reaction invalid' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    const post = list[idx];
    if (!post.reactions || typeof post.reactions !== 'object') post.reactions = {};
    const bucket = Array.isArray(post.reactions[reaction]) ? post.reactions[reaction] : [];
    const pos = bucket.indexOf(authorKey);
    if (pos === -1) bucket.push(authorKey);
    else bucket.splice(pos, 1);
    post.reactions[reaction] = bucket;
    await writePostFile(type, list);
    return sendJSON(res, 200, { entry: post, list: toLightList(list) });
  }
  // POST /api/posts/:type/comment
  if (sub === 'comment' && req.method === 'POST') {
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String((body && body.postId) || '');
    if (!postId) return sendJSON(res, 400, { error: 'postId required' });
    const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) return sendJSON(res, 400, { error: 'name required' });
    const role = normalizeRole(body && body.role);
    let grade = null, classNum = null;
    if (role === 'student') {
      grade = Math.floor(Number(body && body.grade));
      classNum = Math.floor(Number(body && body.classNum));
      const allowed = GRADE_CLASS_MAP[grade];
      if (!allowed) return sendJSON(res, 400, { error: 'grade must be 1-6' });
      if (!Number.isFinite(classNum) || !allowed.includes(classNum)) return sendJSON(res, 400, { error: 'classNum not allowed for this grade' });
    }
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > 300) return sendJSON(res, 400, { error: 'message too long' });
    const authorKey = body && body.authorKey == null ? '' : String(body.authorKey);
    if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey invalid' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === postId);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    const post = list[idx];
    if (!Array.isArray(post.comments)) post.comments = [];
    if (post.comments.length >= 500) return sendJSON(res, 400, { error: '댓글이 너무 많아요.' });
    let parentId = null;
    const parentIdRaw = body && body.parentId;
    if (parentIdRaw) {
      const parent = post.comments.find((c) => c.id === parentIdRaw);
      if (!parent) return sendJSON(res, 400, { error: 'parent comment not found' });
      if (parent.parentId) return sendJSON(res, 400, { error: '답글은 한 단계까지만 가능해요.' });
      parentId = parent.id;
    }
    const comment = {
      id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      name, role, grade, classNum, message,
      parentId,
      authorKey: authorKey || null
    };
    post.comments.push(comment);
    await writePostFile(type, list);
    return sendJSON(res, 201, { comment, entry: post, list: toLightList(list) });
  }
  // POST /api/posts/:type/comment/delete
  if (sub === 'comment/delete' && req.method === 'POST') {
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String((body && body.postId) || '');
    const commentId = String((body && body.commentId) || '');
    const authorKey = String((body && body.authorKey) || '');
    if (!postId || !commentId) return sendJSON(res, 400, { error: 'postId and commentId required' });
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    const list = readPostFile(type);
    const pIdx = list.findIndex((e) => e.id === postId);
    if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
    const post = list[pIdx];
    if (!Array.isArray(post.comments)) post.comments = [];
    const cIdx = post.comments.findIndex((c) => c.id === commentId);
    if (cIdx === -1) return sendJSON(res, 404, { error: 'comment not found' });
    const comment = post.comments[cIdx];
    if (!isAdmin) {
      if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
      if (!comment.authorKey || !timingSafeEq(comment.authorKey, authorKey)) {
        return sendJSON(res, 403, { error: '본인이 작성한 댓글만 삭제할 수 있어요.' });
      }
    }
    post.comments.splice(cIdx, 1);
    await writePostFile(type, list);
    return sendJSON(res, 200, { ok: true, entry: post, list: toLightList(list) });
  }
  if (sub === 'comment/edit' && req.method === 'POST') {
    if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const postId = String((body && body.postId) || '');
    const commentId = String((body && body.commentId) || '');
    const authorKey = String((body && body.authorKey) || '');
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!postId || !commentId) return sendJSON(res, 400, { error: 'postId and commentId required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > 300) return sendJSON(res, 400, { error: 'message too long' });
    const adminHeader = req.headers['x-admin-token'] || '';
    const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
    const list = readPostFile(type);
    const pIdx = list.findIndex((e) => e.id === postId);
    if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
    const post = list[pIdx];
    if (!Array.isArray(post.comments)) post.comments = [];
    const cIdx = post.comments.findIndex((c) => c.id === commentId);
    if (cIdx === -1) return sendJSON(res, 404, { error: 'comment not found' });
    const comment = post.comments[cIdx];
    if (!isAdmin) {
      if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
      if (!comment.authorKey || !timingSafeEq(comment.authorKey, authorKey)) {
        return sendJSON(res, 403, { error: '본인이 작성한 댓글만 수정할 수 있어요.' });
      }
    }
    comment.message = message;
    applyAdminIdentity(comment, body, isAdmin);
    comment.editedAt = Date.now();
    await writePostFile(type, list);
    return sendJSON(res, 200, { ok: true, comment, entry: post, list: toLightList(list) });
  }
  // Admin: edit / delete / clear
  if (sub === 'edit' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readJSONBody(req, bodyLimit); }
    catch (e) { return sendJSON(res, e.message === 'body too large' ? 413 : 400, { error: e.message }); }
    const id = String((body && body.id) || '');
    const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    if (!message) return sendJSON(res, 400, { error: 'message required' });
    if (message.length > cfg.maxMsgLen) return sendJSON(res, 400, { error: 'message too long' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    list[idx].message = message;
    list[idx].editedAt = Date.now();
    await writePostFile(type, list);
    return sendJSON(res, 200, { entry: list[idx], list: toLightList(list) });
  }
  if (sub === 'delete' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const id = String((body && body.id) || '');
    if (!id) return sendJSON(res, 400, { error: 'id required' });
    const list = readPostFile(type);
    const idx = list.findIndex((e) => e.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'not found' });
    list.splice(idx, 1);
    await writePostFile(type, list);
    return sendJSON(res, 200, { ok: true, list: toLightList(list) });
  }
  if (sub === 'clear' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    await writePostFile(type, []);
    return sendJSON(res, 200, { ok: true });
  }
  // Q&A answer system
  if (type === 'qa' && cfg.hasAnswers) {
    if (sub === 'answer' && req.method === 'POST') {
      if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const postId = String((body && body.postId) || '');
      if (!postId) return sendJSON(res, 400, { error: 'postId required' });
      const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!name) return sendJSON(res, 400, { error: 'name required' });
      const role = normalizeRole(body && body.role);
      let grade = null, classNum = null;
      if (role === 'student') {
        grade = Math.floor(Number(body && body.grade));
        classNum = Math.floor(Number(body && body.classNum));
        const allowed = GRADE_CLASS_MAP[grade];
        if (!allowed) return sendJSON(res, 400, { error: 'grade must be 1-6' });
        if (!Number.isFinite(classNum) || !allowed.includes(classNum)) return sendJSON(res, 400, { error: 'classNum not allowed for this grade' });
      }
      const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
      if (!message) return sendJSON(res, 400, { error: 'message required' });
      if (message.length > 2000) return sendJSON(res, 400, { error: 'message too long' });
      const authorKey = body && body.authorKey == null ? '' : String(body.authorKey);
      if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey invalid' });
      const list = readPostFile('qa');
      const pIdx = list.findIndex((e) => e.id === postId);
      if (pIdx === -1) return sendJSON(res, 404, { error: 'not found' });
      const post = list[pIdx];
      if (!Array.isArray(post.answers)) post.answers = [];
      if (post.answers.length >= 200) return sendJSON(res, 400, { error: '답변이 너무 많아요.' });
      const answer = {
        id: 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        timestamp: Date.now(),
        name, role, grade, classNum, message,
        authorKey: authorKey || null,
        reactions: {}
      };
      post.answers.push(answer);
      await writePostFile('qa', list);
      return sendJSON(res, 201, { answer, entry: post, list: toLightList(list) });
    }
    if (sub === 'answer/delete' && req.method === 'POST') {
      if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const postId = String((body && body.postId) || '');
      const answerId = String((body && body.answerId) || '');
      const authorKey = String((body && body.authorKey) || '');
      if (!postId || !answerId) return sendJSON(res, 400, { error: 'postId and answerId required' });
      const adminHeader = req.headers['x-admin-token'] || '';
      const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
      const list = readPostFile('qa');
      const pIdx = list.findIndex((e) => e.id === postId);
      if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
      const post = list[pIdx];
      if (!Array.isArray(post.answers)) post.answers = [];
      const aIdx = post.answers.findIndex((a) => a.id === answerId);
      if (aIdx === -1) return sendJSON(res, 404, { error: 'answer not found' });
      const ans = post.answers[aIdx];
      if (!isAdmin) {
        if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
        if (!ans.authorKey || !timingSafeEq(ans.authorKey, authorKey)) {
          return sendJSON(res, 403, { error: '본인이 작성한 답변만 삭제할 수 있어요.' });
        }
      }
      post.answers.splice(aIdx, 1);
      await writePostFile('qa', list);
      return sendJSON(res, 200, { ok: true, entry: post, list: toLightList(list) });
    }
    if (sub === 'answer/edit' && req.method === 'POST') {
      if (!rateOk(ip, 10, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const postId = String((body && body.postId) || '');
      const answerId = String((body && body.answerId) || '');
      const authorKey = String((body && body.authorKey) || '');
      const message = String((body && body.message) || '').replace(/\r\n/g, '\n').trim();
      if (!postId || !answerId) return sendJSON(res, 400, { error: 'postId and answerId required' });
      if (!message) return sendJSON(res, 400, { error: 'message required' });
      if (message.length > 2000) return sendJSON(res, 400, { error: 'message too long' });
      const adminHeader = req.headers['x-admin-token'] || '';
      const isAdmin = ADMIN_TOKEN && adminHeader && timingSafeEq(adminHeader, ADMIN_TOKEN);
      const list = readPostFile('qa');
      const pIdx = list.findIndex((e) => e.id === postId);
      if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
      const post = list[pIdx];
      if (!Array.isArray(post.answers)) post.answers = [];
      const aIdx = post.answers.findIndex((a) => a.id === answerId);
      if (aIdx === -1) return sendJSON(res, 404, { error: 'answer not found' });
      const ans = post.answers[aIdx];
      if (!isAdmin) {
        if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
        if (!ans.authorKey || !timingSafeEq(ans.authorKey, authorKey)) {
          return sendJSON(res, 403, { error: '본인이 작성한 댓글만 수정할 수 있어요.' });
        }
      }
      ans.message = message;
      applyAdminIdentity(ans, body, isAdmin);
      ans.editedAt = Date.now();
      await writePostFile('qa', list);
      return sendJSON(res, 200, { ok: true, answer: ans, entry: post, list: toLightList(list) });
    }
    if (sub === 'answer/react' && req.method === 'POST') {
      if (!rateOk(ip, 20, 10000)) return sendJSON(res, 429, { error: '요청이 너무 많아요.' });
      let body;
      try { body = await readJSONBody(req); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const postId = String((body && body.postId) || '');
      const answerId = String((body && body.answerId) || '');
      const authorKey = String((body && body.authorKey) || '');
      const reaction = String((body && body.reaction) || '');
      if (!postId || !answerId) return sendJSON(res, 400, { error: 'postId and answerId required' });
      if (!authorKey || !AUTHOR_KEY_RE.test(authorKey)) return sendJSON(res, 400, { error: 'authorKey required' });
      if (!REACTION_TYPES.includes(reaction)) return sendJSON(res, 400, { error: 'reaction invalid' });
      const list = readPostFile('qa');
      const pIdx = list.findIndex((e) => e.id === postId);
      if (pIdx === -1) return sendJSON(res, 404, { error: 'post not found' });
      const post = list[pIdx];
      if (!Array.isArray(post.answers)) post.answers = [];
      const ans = post.answers.find((a) => a.id === answerId);
      if (!ans) return sendJSON(res, 404, { error: 'answer not found' });
      if (!ans.reactions || typeof ans.reactions !== 'object') ans.reactions = {};
      const bucket = Array.isArray(ans.reactions[reaction]) ? ans.reactions[reaction] : [];
      const pos = bucket.indexOf(authorKey);
      if (pos === -1) bucket.push(authorKey);
      else bucket.splice(pos, 1);
      ans.reactions[reaction] = bucket;
      await writePostFile('qa', list);
      return sendJSON(res, 200, { entry: post, list: toLightList(list) });
    }
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
    const size = stat.size;
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    const rangeHeader = req.headers['range'];
    // Mobile Safari (and some Android builds) refuse to play <audio> from
    // sources that don't honor Range requests. Support partial content
    // for everything — cheap for non-audio files too.
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': cache
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function servePdfGuide(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }
  const reply = () => {
    fs.stat(PDF_GUIDE_FILE, (err, stat) => {
      if (err || !stat.isFile()) {
        // Cache failed; redirect so the user still gets the file (will download).
        res.writeHead(302, { Location: PDF_GUIDE_SOURCE });
        return res.end();
      }
      const size = stat.size;
      const baseHeaders = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="wonang-plant-guide.pdf"',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      };
      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (m) {
          let start = m[1] === '' ? 0 : parseInt(m[1], 10);
          let end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
            return res.end();
          }
          res.writeHead(206, Object.assign({}, baseHeaders, {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': end - start + 1
          }));
          if (req.method === 'HEAD') return res.end();
          return fs.createReadStream(PDF_GUIDE_FILE, { start, end }).pipe(res);
        }
      }
      res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Length': size }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(PDF_GUIDE_FILE).pipe(res);
    });
  };
  if (fs.existsSync(PDF_GUIDE_FILE)) return reply();
  ensurePdfGuideCached().then(reply, () => reply());
}

const server = http.createServer((req, res) => {
  const urlOnly = (req.url || '/').split('?')[0];
  if (urlOnly === '/pdf/wonang-plant-guide.pdf') {
    return servePdfGuide(req, res);
  }
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

// ==================== MINI-GAME LEADERBOARDS ====================
const MAX_GAME_ENTRIES = 5000;
const GAME_TYPES = {
  memory:     { file: path.join(DATA_DIR, 'games-memory.json') },
  wordsearch: { file: path.join(DATA_DIR, 'games-wordsearch.json') }
};
for (const t of Object.keys(GAME_TYPES)) {
  const f = GAME_TYPES[t].file;
  if (!fs.existsSync(f)) { try { fs.writeFileSync(f, '[]', 'utf-8'); } catch (_) {} }
}
const gameWriteChains = {};
function readGameBoard(type) {
  try {
    const raw = fs.readFileSync(GAME_TYPES[type].file, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeGameBoard(type, list) {
  const f = GAME_TYPES[type].file;
  gameWriteChains[type] = (gameWriteChains[type] || Promise.resolve()).then(() => new Promise((resolve, reject) => {
    const tmp = f + '.tmp';
    fs.writeFile(tmp, JSON.stringify(list), 'utf-8', (err) => {
      if (err) return reject(err);
      fs.rename(tmp, f, (err2) => err2 ? reject(err2) : resolve());
    });
  })).catch((err) => { console.error('writeGameBoard ' + type + ' failed', err); });
  return gameWriteChains[type];
}
function isGameBetter(a, b) {
  if (!b) return true;
  if (a.completed !== b.completed) return !!a.completed;
  if (a.completed && b.completed) {
    return (a.durationMs || 0) < (b.durationMs || 0);
  }
  // Both incomplete: more progress wins, then less time
  const aProg = a.progress || 0, bProg = b.progress || 0;
  if (aProg !== bProg) return aProg > bProg;
  return (a.durationMs || 0) < (b.durationMs || 0);
}
function gameUserKey(e) {
  const role = normalizeRole(e && e.role);
  const name = String((e && e.name) || '').trim();
  if (role === 'teacher') return 'teacher|' + name;
  if (role === 'parent') return 'parent|' + name;
  if (role === 'guest') return 'guest|' + name;
  const g = e && Number.isFinite(Number(e.grade)) ? Number(e.grade) : '';
  const c = e && Number.isFinite(Number(e.classNum)) ? Number(e.classNum) : '';
  return 'student|' + g + '|' + c + '|' + name;
}

async function handleGameApi(req, res, gameType, sub) {
  const ip = getClientIp(req);
  if (sub === 'leaderboard' && req.method === 'GET') {
    return sendJSON(res, 200, { list: readGameBoard(gameType) });
  }
  if (sub === 'leaderboard/clear' && req.method === 'POST') {
    const adminHeader = req.headers['x-admin-token'] || '';
    if (!ADMIN_TOKEN || !adminHeader || !timingSafeEq(adminHeader, ADMIN_TOKEN)) {
      return sendJSON(res, 401, { error: '관리자 인증 필요' });
    }
    await writeGameBoard(gameType, []);
    return sendJSON(res, 200, { ok: true });
  }
  if (sub === 'score' && req.method === 'POST') {
    if (!rateOk(ip)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const errs = [];
    const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!name) errs.push('name required');
    const role = normalizeRole(body && body.role);
    let grade = null, classNum = null;
    if (role === 'student') {
      grade = Math.floor(Number(body && body.grade));
      classNum = Math.floor(Number(body && body.classNum));
      const allowed = GRADE_CLASS_MAP[grade];
      if (!allowed) errs.push('grade must be 1-6');
      else if (!Number.isFinite(classNum) || !allowed.includes(classNum)) errs.push('classNum not allowed for this grade');
    }
    const durationMs = Math.max(0, Math.min(60 * 60 * 1000, Math.floor(Number(body && body.durationMs) || 0)));
    const completed = !!(body && body.completed);
    const progress = Math.max(0, Math.min(1, Number(body && body.progress) || (completed ? 1 : 0)));
    const authorKey = body && body.authorKey == null ? '' : String(body.authorKey);
    if (authorKey && !AUTHOR_KEY_RE.test(authorKey)) errs.push('authorKey invalid');
    if (errs.length) return sendJSON(res, 400, { error: '유효하지 않은 요청', details: errs });

    const entry = {
      id: 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      name, role, grade, classNum,
      durationMs, completed, progress,
      authorKey: authorKey || null
    };
    let list = readGameBoard(gameType);
    const sameUserIdxs = [];
    for (let i = 0; i < list.length; i++) {
      if (gameUserKey(list[i]) === gameUserKey(entry)) sameUserIdxs.push(i);
    }
    let kept = entry;
    if (sameUserIdxs.length) {
      let bestIdx = sameUserIdxs[0];
      for (const i of sameUserIdxs) if (isGameBetter(list[i], list[bestIdx])) bestIdx = i;
      const prevBest = list[bestIdx];
      list = list.filter((_, i) => !sameUserIdxs.includes(i));
      if (isGameBetter(entry, prevBest)) {
        list.push(entry);
        kept = entry;
      } else {
        list.push(prevBest);
        kept = prevBest;
      }
    } else {
      list.push(entry);
    }
    if (list.length > MAX_GAME_ENTRIES) list.splice(0, list.length - MAX_GAME_ENTRIES);
    await writeGameBoard(gameType, list);
    return sendJSON(res, 201, { entry: kept, submitted: entry, list });
  }
  return sendJSON(res, 404, { error: 'not found' });
}

server.listen(PORT, HOST, () => {
  console.log(`wonang-plants server listening on http://${HOST}:${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
  if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN env not set — a random one was generated for this run.');
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.log(`Admin credentials: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD} (override via ADMIN_USERNAME / ADMIN_PASSWORD env).`);
  }
});
