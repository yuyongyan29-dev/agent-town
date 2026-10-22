#!/usr/bin/env node
// 把小镇的 hook 合并进 ~/.claude/settings.json 与 ~/.codex/hooks.json；保留已有 hook，先备份。
// 用法：node scripts/install-hooks.js [--uninstall]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const uninstall = process.argv.includes('--uninstall');
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'hook.js');
const MARK = 'agent-town';
const cmd = (agent) => `node ${JSON.stringify(HOOK)} ${agent} # ${MARK}`;

const CLAUDE_EVENTS = ['PermissionRequest', 'Notification', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionStart', 'SessionEnd'];
const CODEX_EVENTS = ['PermissionRequest', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'];

function edit(file, events, agent) {
  let cfg = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    cfg = text.trim() ? JSON.parse(text) : {};
    fs.writeFileSync(`${file}.agent-town.bak`, text);
  }
  cfg.hooks ||= {};
  for (const ev of Object.keys(cfg.hooks)) {
    cfg.hooks[ev] = (cfg.hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
  }
  if (!uninstall) {
    for (const ev of events) {
      (cfg.hooks[ev] ||= []).push({ matcher: '*', hooks: [{ type: 'command', command: cmd(agent), timeout: 5 }] });
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`${uninstall ? '已移除' : '已写入'} ${file}（备份：${file}.agent-town.bak）`);
}

edit(path.join(os.homedir(), '.claude', 'settings.json'), CLAUDE_EVENTS, 'claude');
edit(path.join(os.homedir(), '.codex', 'hooks.json'), CODEX_EVENTS, 'codex');
