const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_ENTRIES = 5000;
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
  '.txt':  'text/plain; charset=utf-8'
};

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
  const role = body.role === 'teacher' ? 'teacher' : 'student';
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

function getClientIp(req) {
  const h = req.headers['x-forwarded-for'];
  if (typeof h === 'string' && h.length) return h.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function genId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function handleApi(req, res, url) {
  if (url === '/api/leaderboard' && req.method === 'GET') {
    return sendJSON(res, 200, { list: readBoard() });
  }
  if (url === '/api/leaderboard' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (!rateOk(ip)) return sendJSON(res, 429, { error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
    let body;
    try { body = await readJSONBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const { errs, clean } = validateEntry(body);
    if (errs && errs.length) return sendJSON(res, 400, { error: '유효하지 않은 요청', details: errs });
    const list = readBoard();
    const entry = Object.assign({ id: genId(), timestamp: Date.now() }, clean);
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    await writeBoard(list);
    return sendJSON(res, 201, { entry, list });
  }
  if (url === '/api/leaderboard/clear' && req.method === 'POST') {
    if (!ADMIN_TOKEN) return sendJSON(res, 503, { error: '서버에 ADMIN_TOKEN이 설정되지 않았습니다.' });
    const token = req.headers['x-admin-token'] || '';
    if (token !== ADMIN_TOKEN) return sendJSON(res, 401, { error: '관리자 토큰이 올바르지 않습니다.' });
    await writeBoard([]);
    return sendJSON(res, 200, { ok: true });
  }
  if (url === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, entries: readBoard().length });
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

server.listen(PORT, HOST, () => {
  console.log(`wonang-plants server listening on http://${HOST}:${PORT}`);
  console.log(`data file: ${DATA_FILE}`);
  if (!ADMIN_TOKEN) console.log('ADMIN_TOKEN not set — /api/leaderboard/clear is disabled.');
});
