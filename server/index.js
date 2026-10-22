import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Tailer } from './tail.js';
import { ClaudeSource } from './claude.js';
import { CodexSource } from './codex.js';
import { applyHook, ingest, AGENT_ID } from './hooks.js';
import { listSchedules } from './schedule.js';
import { getWeather } from './weather.js';
import { dispatch, listJobs } from './dispatch.js';

const PORT = +(process.env.PORT || 4317);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const store = new Store();
const tailer = new Tailer();
// 日志适配器：每个都实现 poll()，新增一种 agent 日志就在这里加一个
const sources = [new ClaudeSource(store, tailer), new CodexSource(store, tailer)];
store.agent('claude', { name: 'Claude Code', color: '#e07a5f', log: true });
store.agent('codex', { name: 'Codex', color: '#7b7cff', log: true });

const t0 = Date.now();
for (const s of sources) await s.poll();
store.live = true;
console.log(`[agent-town] 读完最近 31 天日志：${store.sessions.size} 个会话，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try { for (const s of sources) await s.poll(); } catch (e) { console.error('[agent-town] 轮询失败', e); }
  polling = false;
}, 1000);
setInterval(() => store.prune(), 10 * 60e3);

// SSE：事件即时推送，状态快照最多每秒一次
const clients = new Set();
store.listeners.add((ev) => broadcast('event', ev));
setInterval(() => {
  if (!clients.size) return;
  broadcast('state', store.snapshot());
}, 1000);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20e3);
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const json = (res, data, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file, base) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(base + path.sep)) return json(res, { error: 'not found' }, 404);
  fs.readFile(resolved, (err, buf) => {
    if (err) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream', 'cache-control': base === THREE ? 'max-age=86400' : 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  // 只接受本机地址，挡住 DNS rebinding
  if (!HOSTS.has(req.headers.host)) return json(res, { error: 'bad host' }, 403);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST') {
      // hook 脚本不带 Origin；浏览器请求必须来自本页面
      const origin = req.headers.origin;
      if (origin && !ORIGINS.has(origin)) return json(res, { error: 'bad origin' }, 403);
      const body = await readBody(req);
      const hm = p.match(/^\/hook\/([^/]+)$/);
      if (hm && AGENT_ID.test(hm[1])) return json(res, { ok: applyHook(store, hm[1], body) });
      if (p === '/api/ingest') return json(res, { accepted: ingest(store, body) });
      if (p === '/api/dispatch') {
        const allowed = new Set([...store.sessions.values()].map((s) => s.cwd).filter(Boolean));
        try { return json(res, dispatch(body, allowed)); } catch (e) { return json(res, { error: e.message }, 400); }
      }
      return json(res, { error: 'not found' }, 404);
    }

    if (p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/state') return json(res, store.snapshot());
    if (p === '/api/events') return json(res, store.events(+url.searchParams.get('since') || 0, url.searchParams.get('sid') || undefined));
    if (p.startsWith('/api/session/')) {
      const d = store.sessionDetail(decodeURIComponent(p.slice(13)));
      return d ? json(res, d) : json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/report') return json(res, store.report(Math.min(31, +url.searchParams.get('days') || 7)));
    if (p === '/api/schedule') return json(res, await listSchedules());
    if (p === '/api/weather') return json(res, await getWeather());
    if (p === '/api/projects') {
      const map = new Map();
      for (const s of store.sessions.values()) if (s.cwd && (!map.has(s.cwd) || map.get(s.cwd) < s.lastActivity)) map.set(s.cwd, s.lastActivity);
      return json(res, [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([cwd, last]) => ({ cwd, name: path.basename(cwd), last })));
    }
    if (p === '/api/jobs') return json(res, listJobs());

    if (p.startsWith('/vendor/three/')) return serveFile(res, path.join(THREE, p.slice(14)), THREE);
    return serveFile(res, path.join(PUBLIC, p === '/' ? 'index.html' : p), PUBLIC);
  } catch (e) {
    console.error(e);
    json(res, { error: String(e.message || e) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[agent-town] http://localhost:${PORT}`));
