import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const AGENT_HINT = /claude|codex|agent|llm|openai|anthropic/i;

/** 本机定时任务总览：crontab + 用户 LaunchAgents，算出下次运行时间 */
export async function listSchedules() {
  const items = [];
  try {
    const { stdout } = await run('crontab', ['-l'], { timeout: 3000 });
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line || /^[A-Z_]+=/.test(line)) continue;
      const disabled = line.startsWith('#');
      const body = disabled ? line.replace(/^#\s*/, '') : line;
      const m = body.match(/^(@\w+|(?:\S+\s+){4}\S+)\s+(.+)$/);
      if (!m || !isCron(m[1])) continue;
      const [expr, cmd] = [m[1], m[2]];
      const comment = cmd.match(/#\s*(.+)$/)?.[1];
      items.push({
        source: 'crontab', name: comment || shortCmd(cmd), command: cmd.replace(/\s+#.*$/, ''), schedule: expr,
        human: humanCron(expr), next: disabled ? null : nextCron(expr), enabled: !disabled, agentRelated: AGENT_HINT.test(cmd),
      });
    }
  } catch {}

  let files = [];
  try { files = (await fs.readdir(AGENTS_DIR)).filter((f) => f.endsWith('.plist')); } catch {}
  for (const f of files) {
    try {
      const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', path.join(AGENTS_DIR, f)], { timeout: 3000 });
      const p = JSON.parse(stdout);
      const cmd = (p.ProgramArguments || [p.Program]).filter(Boolean).join(' ');
      let human = '', next = null, schedule = '';
      if (p.StartCalendarInterval) {
        const list = [].concat(p.StartCalendarInterval);
        schedule = JSON.stringify(list);
        human = list.map(calendarHuman).join('；');
        next = Math.min(...list.map(nextCalendar).filter(Boolean)) || null;
      } else if (p.StartInterval) {
        schedule = `every ${p.StartInterval}s`;
        human = `每 ${fmtInterval(p.StartInterval)}`;
      } else if (p.RunAtLoad || p.KeepAlive) {
        human = p.KeepAlive ? '常驻' : '登录时运行';
      } else continue;
      items.push({ source: 'launchd', name: p.Label || f, command: cmd, schedule, human, next, enabled: !p.Disabled, agentRelated: AGENT_HINT.test(cmd + (p.Label || '')) });
    } catch {}
  }
  items.sort((a, b) => (b.agentRelated - a.agentRelated) || ((a.next || Infinity) - (b.next || Infinity)));
  return items;
}

const isCron = (e) => e.startsWith('@') || e.split(/\s+/).every((f) => /^[\d*,\-/A-Za-z]+$/.test(f));
const shortCmd = (c) => path.basename(c.split(/\s+/).find((x) => x.includes('/')) || c.split(/\s+/)[0] || c);

const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

function parseField(f, min, max) {
  const set = new Set();
  for (const part of f.split(',')) {
    let [range, step] = part.split('/');
    step = step ? +step : 1;
    let lo = min, hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      lo = +a; hi = b !== undefined ? +b : (part.includes('/') ? max : +a);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** 5 段 cron 的下次运行时间（按本机时区解释，cron 本身就是这么跑的） */
export function nextCron(expr, from = Date.now()) {
  expr = MACROS[expr] || expr;
  if (expr.startsWith('@')) return null;
  const [mi, h, dom, mon, dow] = expr.split(/\s+/);
  const M = parseField(mi, 0, 59), H = parseField(h, 0, 23), D = parseField(dom, 1, 31), MO = parseField(mon, 1, 12);
  const W = parseField(dow.replace(/7/g, '0'), 0, 6);
  const domAny = dom === '*', dowAny = dow === '*';
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 400; i++) {
    const dayOk = domAny && dowAny ? true : domAny ? W.has(d.getDay()) : dowAny ? D.has(d.getDate()) : D.has(d.getDate()) || W.has(d.getDay());
    if (MO.has(d.getMonth() + 1) && dayOk) {
      if (H.has(d.getHours())) {
        if (M.has(d.getMinutes())) return d.getTime();
        d.setMinutes(d.getMinutes() + 1);
      } else d.setHours(d.getHours() + 1, 0);
    } else d.setDate(d.getDate() + 1), d.setHours(0, 0);
  }
  return null;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function humanCron(expr) {
  expr = MACROS[expr] || expr;
  const [mi, h, dom, mon, dow] = expr.split(/\s+/);
  const t = /^\d+$/.test(h) && /^\d+$/.test(mi) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : null;
  if (t && dom === '*' && mon === '*' && dow === '*') return `每天 ${t}`;
  if (t && dom === '*' && mon === '*' && /^\d$/.test(dow)) return `每周${WEEK[+dow % 7]} ${t}`;
  if (mi === '0' && h === '*' && dom === '*') return '每小时整点';
  if (/^\*\/\d+$/.test(mi) && h === '*') return `每 ${mi.slice(2)} 分钟`;
  return expr;
}

function calendarHuman(c) {
  const t = c.Hour !== undefined ? `${String(c.Hour).padStart(2, '0')}:${String(c.Minute || 0).padStart(2, '0')}` : `每小时第 ${c.Minute || 0} 分`;
  if (c.Weekday !== undefined) return `每周${WEEK[c.Weekday % 7]} ${t}`;
  if (c.Day !== undefined) return `每月 ${c.Day} 日 ${t}`;
  return c.Hour !== undefined ? `每天 ${t}` : t;
}

function nextCalendar(c) {
  const f = (v, all) => (v === undefined ? all : String(v));
  return nextCron([f(c.Minute, '0'), f(c.Hour, '*'), f(c.Day, '*'), f(c.Month, '*'), f(c.Weekday, '*')].join(' '));
}

function fmtInterval(s) {
  if (s % 86400 === 0) return `${s / 86400} 天`;
  if (s % 3600 === 0) return `${s / 3600} 小时`;
  if (s % 60 === 0) return `${s / 60} 分钟`;
  return `${s} 秒`;
}
