// 本机 agent：检测装了哪些 AI 编程 agent 的命令行工具，管理用户手动添加的 agent（存在 ~/.agent-town/agents.json）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_ID } from './hooks.js';

const HOME = os.homedir();
const FILE = path.join(HOME, '.agent-town', 'agents.json');

// 常见的 AI 编程 agent：命令名 + 配置目录（任一存在就算装了）
const KNOWN = [
  { id: 'claude', name: 'Claude Code', color: '#e07a5f', bins: ['claude'], dirs: ['.claude'] },
  { id: 'codex', name: 'Codex', color: '#7b7cff', bins: ['codex'], dirs: ['.codex'] },
  { id: 'gemini', name: 'Gemini CLI', color: '#4aa3df', bins: ['gemini'], dirs: ['.gemini'] },
  { id: 'cursor', name: 'Cursor Agent', color: '#7d8796', bins: ['cursor-agent'], dirs: ['.cursor'] },
  { id: 'copilot', name: 'GitHub Copilot CLI', color: '#6e40c9', bins: ['copilot'], dirs: ['.copilot'] },
  { id: 'opencode', name: 'OpenCode', color: '#f5a524', bins: ['opencode'], dirs: ['.config/opencode', '.local/share/opencode'] },
  { id: 'qwen', name: 'Qwen Code', color: '#615ced', bins: ['qwen'], dirs: ['.qwen'] },
  { id: 'aider', name: 'Aider', color: '#14b014', bins: ['aider'], dirs: ['.aider'] },
  { id: 'goose', name: 'Goose', color: '#e0b62f', bins: ['goose'], dirs: ['.config/goose'] },
  { id: 'amp', name: 'Amp', color: '#ff5543', bins: ['amp'], dirs: ['.config/amp'] },
  { id: 'crush', name: 'Crush', color: '#ff6dc2', bins: ['crush'], dirs: ['.config/crush'] },
  { id: 'kiro', name: 'Kiro CLI', color: '#7b4ce0', bins: ['kiro-cli'], dirs: ['.kiro'] },
];

/** 去 PATH 和常见安装目录里找命令 */
function which(bin) {
  const dirs = new Set([...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'),
    path.join(HOME, '.npm-global/bin'), path.join(HOME, '.bun/bin'), path.join(HOME, '.cargo/bin'), path.join(HOME, '.volta/bin')]);
  try { for (const v of fs.readdirSync(path.join(HOME, '.nvm/versions/node'))) dirs.add(path.join(HOME, '.nvm/versions/node', v, 'bin')); } catch {}
  for (const d of dirs) {
    const f = path.join(d, bin);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

export function detectAgents(store) {
  return KNOWN.map((k) => {
    const bin = k.bins.map(which).find(Boolean);
    const dir = k.dirs.map((d) => path.join(HOME, d)).find((d) => fs.existsSync(d));
    const a = store.agents.get(k.id);
    return { id: k.id, name: k.name, color: k.color, installed: !!(bin || dir), path: bin ? bin.replace(HOME, '~') : dir ? dir.replace(HOME, '~') : '', added: !!a, log: !!a?.log };
  }).sort((a, b) => b.installed - a.installed);
}

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = (list) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); };

/** 启动时把手动添加过的 agent 登记回来 */
export function loadManualAgents(store) {
  for (const a of load()) if (AGENT_ID.test(a.id)) store.agent(a.id, { ...a, manual: true });
}

export function addAgent(store, { id, name, color }) {
  id = String(id || '').toLowerCase();
  if (!AGENT_ID.test(id)) throw new Error('agent 标识只能用小写字母、数字和 _.-，最长 32 个字符');
  const known = KNOWN.find((k) => k.id === id);
  const a = store.agent(id, { name: name || known?.name || id, color: color || known?.color, manual: true });
  save([...load().filter((x) => x.id !== id), { id, name: a.name, color: a.color }]);
  return a;
}

/** 移除手动添加的 agent（连同它推送过来的会话）；读本机日志的 agent 不能移除 */
export function removeAgent(store, id) {
  const a = store.agents.get(id);
  if (!a) return false;
  if (a.log) throw new Error(`${a.name} 读的是本机日志，不能移除`);
  store.agents.delete(id);
  for (const [sid, s] of store.sessions) if (s.agent === id) store.sessions.delete(sid);
  save(load().filter((x) => x.id !== id));
  return true;
}
