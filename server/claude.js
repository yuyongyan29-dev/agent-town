import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { toolCategory, toolLabel } from './util.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');

// 行首就能认出、且用不上的记录类型：不做 JSON.parse
const SKIP_PREFIX = /^\{"type":"(api-request|api-request-blob|api-request-shape|attachment|file-history|frame-link|bridge-session|atis-latch|queue-operation|last-prompt|artifact-|cost-state|mode"|agent-name)/;
const ATTACHMENT = /^\{"parentUuid":[^,]*,"isSidechain":(true|false),"attachment":/;
const filter = (line) => !SKIP_PREFIX.test(line) && !ATTACHMENT.test(line);

/** Claude Code：~/.claude/projects/<项目>/<会话>.jsonl 与 <会话>/subagents/*.jsonl */
export class ClaudeSource {
  constructor(store, tailer, { days = 31 } = {}) {
    this.store = store;
    this.tailer = tailer;
    this.maxAge = days * 86400e3;
    this.files = new Map(); // file -> { sid, sub, seenMsg:Set, lastTs }
  }

  async discover() {
    const found = [];
    let dirs = [];
    try { dirs = await fs.readdir(ROOT, { withFileTypes: true }); } catch { return found; }
    const cutoff = Date.now() - this.maxAge;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ROOT, d.name);
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          found.push({ file: path.join(dir, e.name), sid: e.name.slice(0, -6), sub: false });
        } else if (e.isDirectory()) {
          const subDir = path.join(dir, e.name, 'subagents');
          let subs = [];
          try { subs = await fs.readdir(subDir); } catch { continue; }
          for (const f of subs) if (f.endsWith('.jsonl')) found.push({ file: path.join(subDir, f), sid: e.name, sub: true });
        }
      }
    }
    const fresh = [];
    for (const f of found) {
      if (this.files.has(f.file)) { fresh.push(f); continue; }
      try {
        const st = await fs.stat(f.file);
        if (st.mtimeMs >= cutoff) fresh.push(f);
      } catch {}
    }
    return fresh;
  }

  async poll() {
    const list = await this.discover();
    for (const f of list) {
      let ctx = this.files.get(f.file);
      if (!ctx) { ctx = { ...f, seenMsg: new Set(), lastTs: 0 }; this.files.set(f.file, ctx); }
      await this.tailer.read(f.file, (rec) => this.handle(ctx, rec), filter);
    }
  }

  handle(ctx, rec) {
    const store = this.store;
    const sid = ctx.sid;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : ctx.lastTs || Date.now();
    if (rec.timestamp) ctx.lastTs = ts;
    const base = { sid, agent: 'claude', ts, cwd: rec.cwd };
    const sub = ctx.sub;

    switch (rec.type) {
      case 'custom-title':
        if (!sub && rec.customTitle) store.apply({ ...base, kind: 'meta', title: rec.customTitle });
        return;
      case 'summary':
        if (!sub && rec.summary && !store.session(sid, 'claude').title) store.apply({ ...base, kind: 'meta', title: rec.summary });
        return;
      case 'permission-mode':
        if (!sub) store.apply({ ...base, kind: 'meta', permissionMode: rec.permissionMode });
        return;
      case 'system':
        if (rec.subtype === 'compact_boundary' && !sub) store.apply({ ...base, kind: 'compact' });
        if (!sub && (rec.subtype === 'stop_hook_summary' || rec.subtype === 'turn_duration')) store.apply({ ...base, kind: 'turnEnd', reason: 'done' });
        if (rec.subtype === 'api_error' || rec.level === 'error') store.apply({ ...base, kind: 'error', text: rec.content || rec.error?.message || 'API 错误' });
        return;
      case 'user':
        return this.handleUser(ctx, rec, base);
      case 'assistant':
        return this.handleAssistant(ctx, rec, base);
    }
  }

  handleUser(ctx, rec, base) {
    const store = this.store;
    if (!ctx.sub) {
      store.apply({ ...base, kind: 'meta', file: ctx.file, ...(rec.permissionMode ? { permissionMode: rec.permissionMode } : {}) });
    }
    const content = rec.message?.content;
    if (rec.isMeta || rec.isCompactSummary) return;
    if (typeof content === 'string') {
      if (ctx.sub) return;
      return this.prompt(content, base);
    }
    if (!Array.isArray(content)) return;
    let text = '';
    for (const b of content) {
      if (b.type === 'tool_result') {
        const errText = b.is_error ? flatten(b.content) : '';
        store.apply({ ...base, kind: 'toolEnd', toolId: b.tool_use_id, isError: !!b.is_error && !/^(The user doesn't want|User rejected|\[Request interrupted)/.test(errText), errorText: errText });
      } else if (b.type === 'text') text += b.text;
    }
    if (text && !ctx.sub) this.prompt(text, base);
  }

  prompt(text, base) {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('[Request interrupted')) return this.store.apply({ ...base, kind: 'turnEnd', reason: 'interrupted' });
    if (/^<(command-name|local-command|command-message|bash-input|bash-stdout)/.test(t)) return;
    let label = t;
    if (t.startsWith('<task-notification')) label = '后台任务回报';
    else if (t.startsWith('<')) label = t.replace(/<[^>]+>/g, ' ');
    this.store.apply({ ...base, kind: 'turnStart', prompt: label });
  }

  handleAssistant(ctx, rec, base) {
    const store = this.store;
    const msg = rec.message || {};
    if (msg.model && msg.model !== '<synthetic>' && !ctx.sub) store.apply({ ...base, kind: 'meta', model: msg.model });
    if (msg.id && msg.usage && !ctx.seenMsg.has(msg.id)) {
      ctx.seenMsg.add(msg.id);
      const u = msg.usage;
      store.apply({ ...base, kind: 'tokens', input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
    }
    for (const b of msg.content || []) {
      if (b.type !== 'tool_use') continue;
      store.apply({ ...base, kind: 'toolStart', toolId: b.id, tool: b.name, cat: toolCategory(b.name), label: toolLabel(b.name, b.input), sub: ctx.sub });
    }
    if (msg.stop_reason === 'end_turn' && !ctx.sub) {
      const s = store.session(base.sid, 'claude');
      if (![...s.pending.values()].some((p) => !p.sub)) store.apply({ ...base, kind: 'turnEnd', reason: 'done' });
    }
    if (rec.isApiErrorMessage || rec.error) store.apply({ ...base, kind: 'error', text: flatten(msg.content) || 'API 错误' });
  }
}

function flatten(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.text || '')).join(' ');
  return '';
}
