#!/usr/bin/env node
// 由各 agent 的 hooks 调用（node hook.js <agent>）：把 stdin 里的事件转发给小镇，失败静默，不阻塞 agent
const agent = /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(process.argv[2] || '') ? process.argv[2] : 'claude';
const port = process.env.AGENT_TOWN_PORT || 4317;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', async () => {
  try {
    await fetch(`http://127.0.0.1:${port}/hook/${agent}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: data || '{}', signal: AbortSignal.timeout(800),
    });
  } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 1500);
