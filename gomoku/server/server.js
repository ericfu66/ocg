'use strict';
/**
 * 五子棋 AI 对弈网站 —— HTTP 静态文件 + WebSocket 对弈接口。
 *
 * 环境变量：
 *   PORT          监听端口（默认 8080）
 *   HOST          监听地址（默认 0.0.0.0）
 *   ENGINE_DIR    Rapfi 引擎所在目录（含 pbrain-rapfi、config.toml、权重）
 *   ENGINE_BIN    引擎可执行文件名（默认 pbrain-rapfi）
 *   POOL_SIZE     同时进行搜索的引擎进程数（默认 2）
 *   THREADS       高难度使用的线程数（默认 = CPU 核数）
 *   HASH_MB       每个引擎的置换表大小 MB（默认 512）
 *   TOP_TIME_MS   最高难度每步思考时间（默认 20000）
 *   MAX_CONN_PER_IP 每个 IP 最多 WebSocket 连接数（默认 8）
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { EnginePool } = require('./engine');

const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ENGINE_DIR = path.resolve(process.env.ENGINE_DIR || path.join(__dirname, '..', 'engine'));
const ENGINE_BIN = process.env.ENGINE_BIN || 'pbrain-rapfi';
const POOL_SIZE = Math.max(1, +(process.env.POOL_SIZE || 2));
const THREADS = Math.max(1, +(process.env.THREADS || os.cpus().length));
const HASH_MB = Math.max(16, +(process.env.HASH_MB || 512));
const TOP_TIME_MS = Math.max(1000, +(process.env.TOP_TIME_MS || 20000));
const MAX_CONN_PER_IP = Math.max(1, +(process.env.MAX_CONN_PER_IP || 8));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));

/**
 * 难度定义。strength 是 Rapfi 内置的强度参数（0~100，100 为全力），
 * 低于 100 时引擎会限制搜索深度并在候选着法中随机选择，模拟人类失误。
 */
const LEVELS = [
  { id: 1, name: '新手', desc: '刚学会规则，会犯明显错误', strength: 0, timeMs: 400, threads: 1, caution: 1 },
  { id: 2, name: '入门', desc: '能看到简单的冲四活三', strength: 30, timeMs: 700, threads: 1, caution: 1 },
  { id: 3, name: '业余', desc: '有一定战术，偶尔失误', strength: 60, timeMs: 1200, threads: 1, caution: 2 },
  { id: 4, name: '高手', desc: '计算扎实，很少失误', strength: 85, timeMs: 2000, threads: Math.min(2, THREADS), caution: 3 },
  { id: 5, name: '大师', desc: 'Rapfi 全力搜索，每步约 5 秒', strength: 100, timeMs: 5000, threads: THREADS, caution: 3 },
  {
    id: 6, name: '宗师', desc: `Rapfi + NNUE 满血，每步约 ${Math.round(TOP_TIME_MS / 1000)} 秒`,
    strength: 100, timeMs: TOP_TIME_MS, threads: THREADS, caution: 3,
  },
];
const HINT_LEVEL = { strength: 100, timeMs: 3000, threads: THREADS, caution: 3 };

const SIZES = { freestyle: [15, 19, 20], standard: [15], renju: [15] };

const pool = new EnginePool({ engineDir: ENGINE_DIR, engineBin: ENGINE_BIN, poolSize: POOL_SIZE, hashMB: HASH_MB });

let engineAbout = '';
pool.withUtil((e) => e.about()).then((s) => { engineAbout = s; console.log('Engine:', s); })
  .catch((e) => console.error('Failed to query engine:', e.message));

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, queue: pool.queueLength() });
  if (url.pathname === '/api/info') {
    return sendJSON(res, 200, {
      engine: engineAbout,
      levels: LEVELS.map(({ id, name, desc, timeMs }) => ({ id, name, desc, timeMs })),
      sizes: SIZES,
      threads: THREADS,
      poolSize: POOL_SIZE,
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const connPerIp = new Map();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}

/** 校验客户端发来的局面，返回规范化后的数据或抛出错误 */
function validatePosition(msg) {
  const rule = msg.rule;
  if (!SIZES[rule]) throw new Error('未知规则');
  const size = +msg.size;
  if (!SIZES[rule].includes(size)) throw new Error('不支持的棋盘大小');
  if (!Array.isArray(msg.moves) || msg.moves.length >= size * size) throw new Error('局面无效');
  const seen = new Set();
  const moves = msg.moves.map((m) => {
    if (!Array.isArray(m) || m.length !== 2) throw new Error('着法无效');
    const [x, y] = m.map((v) => +v);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) throw new Error('着法越界');
    const k = x * 100 + y;
    if (seen.has(k)) throw new Error('重复落子');
    seen.add(k);
    return [x, y];
  });
  return { rule, size, moves };
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const n = (connPerIp.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) {
    ws.close(1008, 'too many connections');
    return;
  }
  connPerIp.set(ip, n);

  let current = null; // 当前进行中的搜索 { id, abort, cancel }
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const cancelCurrent = () => {
    if (current) { current.abort.abort(); current.cancel(); current = null; }
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const id = msg.id;

    if (msg.type === 'cancel') return cancelCurrent();

    if (msg.type === 'forbid') {
      try {
        const pos = validatePosition({ ...msg, rule: 'renju' });
        const points = pos.moves.length % 2 === 0 ? await pool.withUtil((e) => e.forbids(pos)) : [];
        send({ type: 'forbid', id, points });
      } catch (err) {
        send({ type: 'error', id, message: err.message });
      }
      return;
    }

    if (msg.type === 'think') {
      let pos, level;
      try {
        pos = validatePosition(msg);
        level = msg.hint ? HINT_LEVEL : LEVELS.find((l) => l.id === +msg.level);
        if (!level) throw new Error('未知难度');
      } catch (err) {
        return send({ type: 'error', id, message: err.message });
      }
      cancelCurrent(); // 每个连接同一时间只允许一个搜索

      const abort = new AbortController();
      let lastInfoAt = 0;
      const { promise, cancel } = pool.acquire(
        (engine) => {
          if (abort.signal.aborted) throw new Error('cancelled');
          send({ type: 'start', id });
          return engine.think({
            ...pos, level, signal: abort.signal,
            onInfo: (info) => {
              const now = Date.now();
              if (info.kind === 'depth' && now - lastInfoAt < 120) return; // 节流
              lastInfoAt = now;
              send({ type: 'info', id, ...info });
            },
          });
        },
        (position) => send({ type: 'queued', id, position })
      );
      const me = { id, abort, cancel };
      current = me;
      try {
        const result = await promise;
        if (abort.signal.aborted) return;
        send({ type: 'move', id, x: result.x, y: result.y, final: result.final });
      } catch (err) {
        if (!abort.signal.aborted && err.message !== 'cancelled') send({ type: 'error', id, message: '引擎出错，请重试' });
      } finally {
        if (current === me) current = null;
      }
    }
  });

  ws.on('close', () => {
    cancelCurrent();
    const c = (connPerIp.get(ip) || 1) - 1;
    if (c <= 0) connPerIp.delete(ip); else connPerIp.set(ip, c);
  });
});

// 心跳，清理死连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

server.listen(PORT, HOST, () => {
  console.log(`Gomoku server listening on http://${HOST}:${PORT}`);
  console.log(`Engine dir: ${ENGINE_DIR}, pool=${POOL_SIZE}, threads=${THREADS}, hash=${HASH_MB}MB, top=${TOP_TIME_MS}ms`);
});

function shutdown() {
  console.log('Shutting down...');
  pool.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
