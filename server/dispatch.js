import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOG_DIR = path.join(os.homedir(), '.agent-town', 'dispatch');
const jobs = [];

/**
 * 派单：在已知项目目录里起一个无头 agent。
 * 目录只能是小镇里见过的会话 cwd，防止网页被拿去在任意目录跑命令。
 */
export function dispatch({ agent, cwd, prompt }, allowedCwds) {
  if (!['claude', 'codex'].includes(agent)) throw new Error('agent 只能是 claude 或 codex');
  if (!prompt || !String(prompt).trim()) throw new Error('任务内容不能为空');
  if (!allowedCwds.has(cwd) || !fs.existsSync(cwd)) throw new Error('只能派到小镇里已有的项目目录');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${agent}`;
  const log = path.join(LOG_DIR, `${id}.log`);
  const fd = fs.openSync(log, 'a');
  const args = agent === 'claude' ? ['-p', prompt] : ['exec', '--skip-git-repo-check', prompt];
  const child = spawn(agent, args, { cwd, detached: true, stdio: ['ignore', fd, fd], env: process.env });
  const job = { id, agent, cwd, prompt: String(prompt).slice(0, 200), log, pid: child.pid, startedAt: Date.now(), exitCode: null, endedAt: 0 };
  child.on('error', (e) => { fs.appendFileSync(log, `\n[agent-town] 启动失败：${e.message}\n`); job.exitCode = -1; job.endedAt = Date.now(); });
  child.on('exit', (code) => { job.exitCode = code; job.endedAt = Date.now(); });
  child.unref();
  fs.closeSync(fd);
  jobs.unshift(job);
  jobs.splice(20);
  return job;
}

export const listJobs = () => jobs.map((j) => ({ ...j, tail: tail(j.log) }));

function tail(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return t.slice(-600);
  } catch { return ''; }
}
