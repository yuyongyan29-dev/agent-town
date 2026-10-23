import { localDate, localMinute, projectName, clip, ASK_TOOLS, LONG_TOOLS } from './util.js';

const RING_MS = 24 * 3600e3;
const RING_MAX = 30000;
const DAYS_KEEP = 31;

const WAIT_GUESS_MS = 8000; // 非长耗时工具挂起超过 8s 视为在等批准
const STALL_MS = 10 * 60e3; // 运行中 10 分钟无动静 = 需留意
const ABANDON_MS = 2 * 3600e3; // 运行中 2 小时无动静 = 视为已中断
const DONE_MS = 30 * 60e3; // 结束 30 分钟内显示“刚完成”
const SLEEP_MS = 6 * 3600e3; // 6 小时无动静 = 休眠，不在小镇里显示

const emptyBucket = () => ({ prompts: 0, turns: 0, tools: 0, errors: 0, tokens: 0, output: 0, cacheRead: 0, minutes: new Set(), cats: {} });

/** 会话状态、按日统计与事件环形缓冲 */
export class Store {
  constructor() {
    this.sessions = new Map();
    this.agents = new Map(); // id -> { id, name, color, log }
    this.days = new Map(); // date -> { agent -> { project -> bucket } }
    this.ring = [];
    this.live = false; // 初次全量读取期间不推送
    this.listeners = new Set();
    this.seq = 0;
    this.dirty = true;
  }

  session(id, agent) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, agent, title: '', cwd: '', model: '', permissionMode: '',
        firstPrompt: '', lastPrompt: '', createdAt: 0, lastActivity: 0,
        turnActive: false, turnStartedAt: 0, lastTurnEndAt: 0, lastTurnEndReason: '',
        pending: new Map(), toolStats: new Map(), lastError: null,
        hookWait: null, softWait: null, ended: false, file: '',
        tokens: 0, today: null,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** 登记 agent 的显示名与颜色；log = 有本机日志适配器（hooks 只补状态） */
  agent(id, meta = {}) {
    const a = this.agents.get(id) || { id, name: id, color: '', log: false };
    if (meta.name) a.name = clip(meta.name, 24);
    if (/^#[0-9a-f]{6}$/i.test(meta.color || '')) a.color = meta.color;
    if (meta.log) a.log = true;
    this.agents.set(id, a);
    return a;
  }

  bucket(ts, agent, project) {
    const d = localDate(ts);
    let day = this.days.get(d);
    if (!day) { day = {}; this.days.set(d, day); }
    const a = (day[agent] ||= {});
    return (a[project] ||= emptyBucket());
  }

  /** 统一入口：所有来源（日志 / hooks）都转成事件交给这里 */
  apply(ev) {
    if (!this.agents.has(ev.agent)) this.agent(ev.agent);
    const s = this.session(ev.sid, ev.agent);
    const ts = ev.ts || Date.now();
    if (ev.cwd && !s.cwd) s.cwd = ev.cwd;
    if (!s.createdAt) s.createdAt = ts;
    const project = projectName(s.cwd);
    const activity = ev.kind !== 'meta';
    if (activity && ts > s.lastActivity) s.lastActivity = ts;
    const b = activity ? this.bucket(ts, s.agent, project) : null;
    if (b) b.minutes.add(localMinute(ts));
    let out = null; // 进入环形缓冲 / 推送给前端的事件

    switch (ev.kind) {
      case 'meta':
        if (ev.title) s.title = clip(ev.title, 60);
        if (ev.model) s.model = ev.model;
        if (ev.permissionMode) s.permissionMode = ev.permissionMode;
        if (ev.cwd) s.cwd = ev.cwd;
        if (ev.file) s.file = ev.file;
        if (ev.prompt) { s.lastPrompt = clip(ev.prompt, 140); if (!s.firstPrompt) s.firstPrompt = clip(ev.prompt, 60); }
        break;
      case 'turnStart':
        s.turnActive = true; s.turnStartedAt = ts; s.ended = false;
        s.softWait = null; s.hookWait = null;
        if (ev.prompt) { s.lastPrompt = clip(ev.prompt, 140); if (!s.firstPrompt) s.firstPrompt = clip(ev.prompt, 60); }
        b.prompts++;
        out = { kind: 'turnStart', prompt: clip(ev.prompt, 60) };
        break;
      case 'toolStart': {
        s.pending.set(ev.toolId, { tool: ev.tool, cat: ev.cat, label: ev.label, ts, sub: !!ev.sub });
        s.softWait = null;
        if (!ev.sub && !s.turnActive) { s.turnActive = true; s.turnStartedAt = ts; }
        b.tools++; b.cats[ev.cat] = (b.cats[ev.cat] || 0) + 1;
        out = { kind: 'toolStart', tool: ev.tool, cat: ev.cat, label: ev.label, sub: !!ev.sub, toolId: ev.toolId };
        break;
      }
      case 'toolEnd': {
        const p = s.pending.get(ev.toolId);
        s.pending.delete(ev.toolId);
        s.softWait = null;
        if (s.hookWait && (!s.hookWait.toolId || s.hookWait.toolId === ev.toolId || !p)) s.hookWait = null;
        const dur = p ? ts - p.ts : 0;
        const tool = p?.tool || ev.tool || '工具';
        if (p) {
          const st = s.toolStats.get(tool) || { n: 0, total: 0, max: 0, errors: 0 };
          st.n++; st.total += dur; st.max = Math.max(st.max, dur);
          if (ev.isError) st.errors++;
          s.toolStats.set(tool, st);
        }
        if (ev.isError) {
          b.errors++;
          s.lastError = { tool, label: p?.label || tool, ts, text: clip(ev.errorText, 160) };
        }
        out = { kind: 'toolEnd', tool, cat: p?.cat || 'other', label: p?.label || tool, isError: !!ev.isError, dur, sub: !!p?.sub, toolId: ev.toolId, errorText: ev.isError ? clip(ev.errorText, 120) : undefined };
        break;
      }
      case 'tokens': {
        const total = (ev.input || 0) + (ev.output || 0) + (ev.cacheRead || 0) + (ev.cacheWrite || 0);
        b.tokens += total; b.output += ev.output || 0; b.cacheRead += ev.cacheRead || 0;
        s.tokens += total;
        if (ev.model) s.model = ev.model;
        break;
      }
      case 'turnEnd':
        if (!s.turnActive && ev.reason !== 'interrupted') break;
        s.turnActive = false; s.lastTurnEndAt = ts; s.lastTurnEndReason = ev.reason || 'done';
        for (const [k, p] of s.pending) if (!p.sub || ev.reason !== 'done') s.pending.delete(k);
        s.hookWait = null; s.softWait = null;
        if (ev.reason === 'done') b.turns++;
        out = { kind: 'turnEnd', reason: ev.reason || 'done', dur: s.turnStartedAt ? ts - s.turnStartedAt : 0 };
        break;
      case 'wait':
        if (ev.source === 'hook') s.hookWait = { reason: ev.reason, ts, toolId: ev.toolId };
        else s.softWait = { reason: ev.reason, ts };
        out = { kind: 'wait', reason: ev.reason };
        break;
      case 'resume':
        s.hookWait = null; s.softWait = null;
        break;
      case 'compact':
        out = { kind: 'compact' };
        break;
      case 'sessionEnd':
        s.ended = true; s.turnActive = false; s.pending.clear();
        out = { kind: 'sessionEnd' };
        break;
      case 'error':
        b.errors++;
        s.lastError = { tool: '运行', label: clip(ev.text, 60), ts, text: clip(ev.text, 160) };
        out = { kind: 'toolEnd', tool: 'error', cat: 'other', label: clip(ev.text, 40), isError: true, dur: 0 };
        break;
    }
    this.dirty = true;
    if (out) {
      out.ts = ts; out.sid = s.id; out.agent = s.agent; out.project = project; out.seq = ++this.seq;
      if (ts > Date.now() - RING_MS) {
        this.ring.push(out);
        if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
      }
      if (this.live) for (const fn of this.listeners) fn(out);
    }
  }

  status(s, now = Date.now()) {
    if (s.ended && !s.turnActive) return { status: 'sleep', reason: '已退出' };
    const idleFor = now - s.lastActivity;
    if (s.hookWait) return { status: 'waiting', reason: s.hookWait.reason };
    if (s.turnActive && idleFor < ABANDON_MS) {
      for (const p of s.pending.values()) {
        if (p.sub) continue;
        if (ASK_TOOLS.has(p.tool)) return { status: 'waiting', reason: p.label };
      }
      if (s.softWait) return { status: 'waiting', reason: s.softWait.reason };
      if (s.permissionMode !== 'bypassPermissions') {
        for (const p of s.pending.values()) {
          if (p.sub || LONG_TOOLS.has(p.tool) || p.tool.startsWith('mcp__')) continue;
          if (now - p.ts > WAIT_GUESS_MS && (s.permissionMode !== 'acceptEdits' || p.cat !== 'edit')) return { status: 'waiting', reason: `可能在等你批准：${p.label}`, guess: true };
        }
      }
      if (idleFor > STALL_MS) return { status: 'stalled', reason: `${Math.round(idleFor / 60e3)} 分钟没有动静` };
      return { status: 'working', reason: '' };
    }
    if (s.lastTurnEndAt && now - s.lastTurnEndAt < DONE_MS) return { status: 'done', reason: s.lastTurnEndReason === 'interrupted' ? '已中断' : '刚完成' };
    if (idleFor > SLEEP_MS) return { status: 'sleep', reason: '' };
    return { status: 'idle', reason: '' };
  }

  currentTool(s) {
    let cur = null;
    for (const p of s.pending.values()) if (!cur || p.ts > cur.ts) cur = p;
    return cur && { tool: cur.tool, cat: cur.cat, label: cur.label, since: cur.ts, sub: cur.sub };
  }

  todayOf(s) {
    const day = this.days.get(localDate(Date.now()));
    return day?.[s.agent]?.[projectName(s.cwd)];
  }

  snapshot() {
    const now = Date.now();
    const sessions = [];
    for (const s of this.sessions.values()) {
      if (!s.lastActivity || now - s.lastActivity > 7 * 86400e3) continue;
      const st = this.status(s, now);
      const subs = [...s.pending.values()].filter((p) => p.cat === 'task' && !p.sub).map((p) => ({ label: p.label, since: p.ts }));
      sessions.push({
        id: s.id, agent: s.agent, title: s.title || s.firstPrompt || '未命名会话', project: projectName(s.cwd), cwd: s.cwd,
        model: s.model, permissionMode: s.permissionMode, status: st.status, reason: st.reason, guess: !!st.guess,
        lastActivity: s.lastActivity, createdAt: s.createdAt, turnStartedAt: s.turnActive ? s.turnStartedAt : 0,
        lastTurnEndAt: s.lastTurnEndAt, lastPrompt: s.lastPrompt, current: this.currentTool(s), subagents: subs,
        lastError: s.lastError, tokens: s.tokens,
      });
    }
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    return { now, sessions, agents: [...this.agents.values()], today: this.daySummary(localDate(now)) };
  }

  daySummary(date) {
    const day = this.days.get(date) || {};
    const res = { date, total: sumBuckets([]), byAgent: {}, byProject: {} };
    const all = [];
    for (const [agent, projects] of Object.entries(day)) {
      const list = Object.values(projects);
      all.push(...list);
      res.byAgent[agent] = sumBuckets(list);
      for (const [p, bk] of Object.entries(projects)) {
        const cur = (res.byProject[p] ||= { agents: {}, ...sumBuckets([]) });
        Object.assign(cur, sumBuckets([cur, bk].map(toPlain)));
        cur.agents[agent] = toPlain(bk);
      }
    }
    res.total = sumBuckets(all);
    return res;
  }

  report(days = 30) {
    const out = [];
    const now = Date.now();
    for (let i = days - 1; i >= 0; i--) out.push(this.daySummary(localDate(now - i * 86400e3)));
    return out;
  }

  events(since = 0, sid) {
    return this.ring.filter((e) => e.ts >= since && (!sid || e.sid === sid));
  }

  sessionDetail(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    const snap = this.snapshot().sessions.find((x) => x.id === id);
    const tools = [...s.toolStats.entries()].map(([tool, st]) => ({ tool, n: st.n, avg: Math.round(st.total / st.n), max: st.max, errors: st.errors })).sort((a, b) => b.n - a.n);
    return { ...snap, tools, timeline: this.events(0, id).slice(-120), today: toPlain(this.todayOf(s) || emptyBucket()) };
  }

  prune() {
    const cutoff = localDate(Date.now() - DAYS_KEEP * 86400e3);
    for (const d of this.days.keys()) if (d < cutoff) this.days.delete(d);
    const ringCut = Date.now() - RING_MS;
    while (this.ring.length && this.ring[0].ts < ringCut) this.ring.shift();
  }
}

function toPlain(b) {
  if (!b) return sumBuckets([]);
  return { prompts: b.prompts, turns: b.turns, tools: b.tools, errors: b.errors, tokens: b.tokens, output: b.output, cacheRead: b.cacheRead, minutes: b.minutes instanceof Set ? b.minutes.size : b.minutes, cats: { ...b.cats } };
}

function sumBuckets(list) {
  const r = { prompts: 0, turns: 0, tools: 0, errors: 0, tokens: 0, output: 0, cacheRead: 0, minutes: 0, cats: {} };
  const minuteSets = [];
  for (const raw of list) {
    const b = raw;
    r.prompts += b.prompts; r.turns += b.turns; r.tools += b.tools; r.errors += b.errors;
    r.tokens += b.tokens; r.output += b.output; r.cacheRead += b.cacheRead;
    if (b.minutes instanceof Set) minuteSets.push(b.minutes); else r.minutes += b.minutes || 0;
    for (const [k, v] of Object.entries(b.cats || {})) r.cats[k] = (r.cats[k] || 0) + v;
  }
  if (minuteSets.length) {
    // 同一分钟里多个会话并行只算一分钟“在岗”
    const u = new Set();
    for (const m of minuteSets) for (const x of m) u.add(x);
    r.minutes += u.size;
  }
  return r;
}
