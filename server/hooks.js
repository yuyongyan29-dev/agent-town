// 事件名归一化思路参考 pixel-agents（MIT, Copyright (c) 2026 Pablo De Lucca），见 THIRD_PARTY_NOTICES.md
import { toolLabel, toolCategory, clip } from './util.js';

export const AGENT_ID = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const KINDS = new Set(['meta', 'turnStart', 'toolStart', 'toolEnd', 'tokens', 'turnEnd', 'wait', 'resume', 'compact', 'sessionEnd', 'error']);
const FIELDS = ['cwd', 'title', 'model', 'prompt', 'permissionMode', 'tool', 'toolId', 'cat', 'label', 'isError', 'errorText', 'input', 'output', 'cacheRead', 'cacheWrite', 'reason', 'text', 'sub'];

/**
 * 有日志适配器的 agent（Claude Code / Codex）：hooks 只补日志里拿不准的“状态”，工具与 token 以日志为准，避免算两次。
 * 其他 agent 没有日志可读：hooks 就是全部来源，工具、回合都从这里来。
 * 事件名兼容 Claude Code 系（PreToolUse…）与 Gemini CLI 系（BeforeTool…）。
 */
export function applyHook(store, agent, body) {
  const sid = body.session_id || body.sessionId;
  const event = body.hook_event_name || body.hookEventName || body.event;
  if (!sid || !event) return false;
  const full = !store.agent(agent).log;
  const base = { sid, agent, ts: Date.now(), cwd: body.cwd };
  const tool = body.tool_name || body.toolName;
  const toolId = body.tool_use_id || body.tool_call_id || tool;
  switch (event) {
    case 'PermissionRequest':
      store.apply({ ...base, kind: 'wait', source: 'hook', toolId: body.tool_use_id, reason: `等你批准：${toolLabel(tool, body.tool_input)}` });
      return true;
    case 'Notification': {
      const type = body.notification_type || '';
      if (type === 'permission_prompt' || /permission|approve|批准/i.test(body.message || '')) {
        store.apply({ ...base, kind: 'wait', source: 'hook', reason: body.message || '等你批准' });
      } else if (type === 'elicitation_dialog') {
        store.apply({ ...base, kind: 'wait', source: 'hook', reason: body.message || '等你回答' });
      }
      return true;
    }
    case 'PreToolUse':
    case 'BeforeTool':
      if (full && tool) store.apply({ ...base, kind: 'toolStart', tool, toolId, cat: toolCategory(tool), label: toolLabel(tool, body.tool_input) });
      return true;
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'AfterTool':
      if (full && tool) {
        const err = event === 'PostToolUseFailure' || body.tool_response?.error || body.error;
        store.apply({ ...base, kind: 'toolEnd', toolId, isError: !!err, errorText: typeof err === 'string' ? err : '' });
      } else store.apply({ ...base, kind: 'resume' });
      return true;
    case 'UserPromptSubmit':
    case 'BeforeAgent':
      store.apply({ ...base, kind: full ? 'turnStart' : 'resume', prompt: body.prompt });
      return true;
    case 'Stop':
    case 'StopFailure':
    case 'AfterAgent':
      store.apply({ ...base, kind: full ? 'turnEnd' : 'resume', reason: event === 'StopFailure' ? 'error' : 'done' });
      return true;
    case 'PreCompact':
    case 'PreCompress':
      if (full) store.apply({ ...base, kind: 'compact' });
      return true;
    case 'SessionEnd':
      store.apply({ ...base, kind: 'sessionEnd' });
      return true;
    case 'SessionStart':
      store.apply({ ...base, kind: 'meta', cwd: body.cwd });
      return true;
  }
  return true;
}

/**
 * 通用推送：POST /api/ingest，body 是一个事件、事件数组，或 { agent, name, color, events: [...] }。
 * 事件字段与 Store.apply 一致：{ agent, sid, kind, ts?, cwd?, tool?, toolId?, ... }，返回收下的条数。
 */
export function ingest(store, body) {
  const list = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
  const def = Array.isArray(body) ? {} : body;
  let n = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const agent = String(raw.agent || def.agent || '').toLowerCase();
    const sid = raw.sid || raw.session_id || def.sid;
    if (!AGENT_ID.test(agent) || !sid || !KINDS.has(raw.kind)) continue;
    store.agent(agent, { name: raw.name || def.name, color: raw.color || def.color });
    const ev = { agent, sid: clip(sid, 128), kind: raw.kind, ts: typeof raw.ts === 'string' ? Date.parse(raw.ts) : +raw.ts || Date.now() };
    for (const k of FIELDS) if (raw[k] != null) ev[k] = raw[k];
    if (ev.kind === 'toolStart' || ev.kind === 'toolEnd') ev.toolId = String(ev.toolId || ev.tool || 'tool');
    if (ev.kind === 'toolStart') {
      ev.tool = String(ev.tool || '工具');
      ev.cat ||= toolCategory(ev.tool);
      ev.label = clip(ev.label || toolLabel(ev.tool, ev.input), 60);
    }
    store.apply(ev);
    n++;
  }
  return n;
}
