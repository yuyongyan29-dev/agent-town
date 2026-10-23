import path from 'node:path';

// 一律按本机时区
const dateFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const minuteFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 本机时区的业务日期 YYYY-MM-DD */
export const localDate = (ts) => dateFmt.format(new Date(ts));
/** 本机时区 HH:MM，用于统计活跃分钟 */
export const localMinute = (ts) => minuteFmt.format(new Date(ts));

export const projectName = (cwd) => (cwd ? path.basename(cwd) || cwd : '未知项目');

export const clip = (s, n = 80) => {
  if (s == null) return '';
  s = String(s).replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : s;
};

const base = (p) => (p ? path.basename(String(p)) : '');

/** 工具分类：决定包裹颜色 */
export function toolCategory(name = '') {
  const n = name.toLowerCase();
  if (/^(read|grep|glob|ls|notebookread|view_image|read_file|list_dir|search_files|find)$/.test(n) || n.includes('read_') || n.endsWith('__read')) return 'read';
  if (/^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create_file)$/.test(n) || n.includes('apply_patch')) return 'edit';
  if (/^(bash|exec|exec_command|shell|local_shell|write_stdin|monitor|unified_exec|run)$/.test(n) || n.includes('shell') || n.includes('terminal')) return 'bash';
  if (/web|browser|fetch|search|chrome|navigate|http/.test(n)) return 'web';
  if (/^(task|agent|workflow|spawn_agent|sendmessage|send_input|wait)$/.test(n) || n.includes('subagent')) return 'task';
  return 'other';
}

/** 工具动作的中文短描述（参考 pixel-agents formatToolStatus，MIT） */
export function toolLabel(name = '', input = {}) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = { raw: input }; }
  }
  input = input || {};
  const n = name;
  switch (n) {
    case 'Read': return `读 ${base(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `改 ${base(input.file_path)}`;
    case 'Write': return `写 ${base(input.file_path)}`;
    case 'NotebookEdit': return `改 ${base(input.notebook_path)}`;
    case 'Grep': return `搜 “${clip(input.pattern, 24)}”`;
    case 'Glob': return `找 ${clip(input.pattern, 24)}`;
    case 'Bash': return `执行 ${clip(input.description || input.command, 36)}`;
    case 'WebFetch': return `浏览 ${clip(safeHost(input.url), 30)}`;
    case 'WebSearch': return `搜网 “${clip(input.query, 24)}”`;
    case 'Task': case 'Agent': return `派子代理 ${clip(input.description || input.subagent_type, 24)}`;
    case 'AskUserQuestion': return '向你提问';
    case 'ExitPlanMode': return '等你确认计划';
    case 'TodoWrite': return '更新待办';
    case 'Skill': return `技能 ${clip(input.skill, 24)}`;
  }
  // Codex
  if (n === 'exec_command' || n === 'shell' || n === 'local_shell') {
    const cmd = Array.isArray(input.command) ? input.command.join(' ') : input.cmd || input.command;
    return `执行 ${clip(cmd, 36)}`;
  }
  if (n === 'exec') return `执行脚本 ${clip(input.title || input.raw, 30)}`;
  if (n === 'apply_patch') {
    const m = String(input.raw || input.input || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    return `改 ${m ? base(m[1]) : '文件'}`;
  }
  if (input.title) return clip(input.title, 36);
  const short = n.replace(/^mcp__[^_]+(__)?/, '').replace(/^.*__/, '');
  return `调用 ${clip(short || n, 28)}`;
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return u; }
}

/** 需要你回应的工具：一旦挂起就算“等你处理” */
export const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input']);
/** 长时间挂起也不当作“等你批准”的工具 */
export const LONG_TOOLS = new Set(['Bash', 'Task', 'Agent', 'Workflow', 'WebFetch', 'WebSearch', 'Monitor', 'exec', 'exec_command', 'shell', 'wait', 'Skill']);
