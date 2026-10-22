import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { toolCategory, toolLabel } from './util.js';

const HOME = path.join(os.homedir(), '.codex');
const SESSIONS = path.join(HOME, 'sessions');
const INDEX = path.join(HOME, 'session_index.jsonl');

// 体积大又用不上的记录：推理密文、开发者上下文、世界状态
const SKIP = /^\{"timestamp":"[^"]*","ordinal":\d+,"type":"(world_state|compacted)"|"type":"reasoning"|"role":"developer"/;
const filter = (line) => !SKIP.test(line.slice(0, 200));
const EXIT_FAIL = /(exit code|exit status|Process exited with code)[:\s]+[1-9]/i;

/** Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，标题来自 session_index.jsonl */
export class CodexSource {
  constructor(store, tailer, { days = 31 } = {}) {
    this.store = store;
    this.tailer = tailer;
    this.maxAge = days * 86400e3;
    this.files = new Map();
    this.titles = new Map();
    this.indexMtime = 0;
  }

  async loadIndex() {
    try {
      const st = await fs.stat(INDEX);
      if (st.mtimeMs === this.indexMtime) return;
      this.indexMtime = st.mtimeMs;
      const text = await fs.readFile(INDEX, 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o.id && o.thread_name) this.titles.set(o.id, o.thread_name);
        } catch {}
      }
      for (const [id, title] of this.titles) {
        if (this.store.sessions.has(id)) this.store.apply({ sid: id, agent: 'codex', kind: 'meta', title });
      }
    } catch {}
  }

  async discover() {
    const cutoff = Date.now() - this.maxAge;
    const out = [];
    const walk = async (dir, depth) => {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) {
          // 目录名是 年/月/日，太旧的整段跳过
          if (depth === 2) {
            const [y, m] = dir.split(path.sep).slice(-2);
            const dayStart = Date.UTC(+y, +m - 1, +e.name);
            if (dayStart && dayStart < cutoff - 2 * 86400e3 && !this.hasFileUnder(p)) continue;
          }
          await walk(p, depth + 1);
        } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
      }
    };
    await walk(SESSIONS, 0);
    const fresh = [];
    for (const file of out) {
      if (this.files.has(file)) { fresh.push(file); continue; }
      try { if ((await fs.stat(file)).mtimeMs >= cutoff) fresh.push(file); } catch {}
    }
    return fresh;
  }

  hasFileUnder(dir) {
    for (const f of this.files.keys()) if (f.startsWith(dir)) return true;
    return false;
  }

  async poll() {
    await this.loadIndex();
    for (const file of await this.discover()) {
      let ctx = this.files.get(file);
      if (!ctx) {
        const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
        ctx = { file, sid: m ? m[1] : file, usageRecords: false, lastTs: 0, titled: false };
        this.files.set(file, ctx);
      }
      await this.tailer.read(file, (rec) => this.handle(ctx, rec), filter);
    }
  }

  handle(ctx, rec) {
    const store = this.store;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : ctx.lastTs || Date.now();
    ctx.lastTs = ts;
    const p = rec.payload || {};
    if (rec.type === 'session_meta' && p.id) ctx.sid = p.id;
    const base = { sid: ctx.sid, agent: 'codex', ts };
    if (!ctx.titled) {
      ctx.titled = true;
      store.apply({ ...base, kind: 'meta', file: ctx.file, title: this.titles.get(ctx.sid) });
    }

    switch (rec.type) {
      case 'session_meta':
        store.apply({ ...base, kind: 'meta', cwd: p.cwd, file: ctx.file });
        return;
      case 'turn_context':
        store.apply({ ...base, kind: 'meta', cwd: p.cwd, model: p.model, permissionMode: policy(p.approval_policy) });
        return;
      case 'token_usage_record': {
        ctx.usageRecords = true;
        const u = p.usage || {};
        const cached = u.cached_input_tokens || 0;
        store.apply({ ...base, kind: 'tokens', input: Math.max(0, (u.input_tokens || 0) - cached), cacheRead: cached, output: u.output_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0 });
        return;
      }
      case 'response_item':
        return this.item(ctx, p, base);
      case 'event_msg':
        return this.event(ctx, p, base);
    }
  }

  item(ctx, p, base) {
    const store = this.store;
    switch (p.type) {
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const name = p.name || (p.type === 'local_shell_call' ? 'local_shell' : 'tool');
        const input = p.arguments ?? p.input ?? p.action ?? {};
        const inObj = typeof input === 'string' && p.type === 'custom_tool_call' ? { raw: input } : input;
        store.apply({ ...base, kind: 'toolStart', toolId: p.call_id || p.id, tool: name, cat: toolCategory(name), label: toolLabel(name, inObj) });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const text = outputText(p.output);
        const isError = EXIT_FAIL.test(text.slice(0, 600)) || /^(error|failed)[:\s]/i.test(text.trim());
        store.apply({ ...base, kind: 'toolEnd', toolId: p.call_id || p.id, isError, errorText: isError ? text : '' });
        return;
      }
    }
  }

  event(ctx, p, base) {
    const store = this.store;
    const t = p.type || '';
    switch (t) {
      case 'task_started':
        store.apply({ ...base, kind: 'turnStart', prompt: '' });
        return;
      case 'item_completed':
        if (p.item?.type === 'UserMessage') {
          const text = (p.item.content || []).map((c) => c.text || '').join(' ');
          store.apply({ ...base, kind: 'meta', prompt: text });
        }
        return;
      case 'user_message':
        if (p.message) store.apply({ ...base, kind: 'meta', prompt: p.message });
        return;
      case 'thread_settings_applied': {
        const ts = p.thread_settings || {};
        store.apply({ ...base, kind: 'meta', model: ts.model, cwd: ts.cwd, permissionMode: policy(ts.approval_policy) });
        return;
      }
      case 'token_count': {
        if (ctx.usageRecords) return;
        const u = p.info?.last_token_usage;
        if (!u) return;
        const cached = u.cached_input_tokens || 0;
        store.apply({ ...base, kind: 'tokens', input: Math.max(0, (u.input_tokens || 0) - cached), cacheRead: cached, output: u.output_tokens || 0 });
        return;
      }
      case 'task_complete':
        store.apply({ ...base, kind: 'turnEnd', reason: 'done' });
        return;
      case 'turn_aborted':
        store.apply({ ...base, kind: 'turnEnd', reason: 'interrupted' });
        return;
      case 'error':
      case 'stream_error':
        store.apply({ ...base, kind: 'error', text: p.message || 'Codex 报错' });
        return;
    }
    if (t.includes('approval') || t === 'request_user_input') {
      store.apply({ ...base, kind: 'wait', reason: t.includes('patch') ? '等你批准改文件' : t.includes('exec') ? '等你批准执行命令' : '等你回应' });
    }
  }
}

function policy(p) {
  if (!p) return undefined;
  return p === 'never' ? 'bypassPermissions' : p;
}

function outputText(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map((x) => x.text || '').join('\n');
  if (o.content) return outputText(o.content);
  return '';
}
