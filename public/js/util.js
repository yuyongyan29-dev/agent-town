// 前端共用的配色、文案与格式化
export const CAT = {
  read: { color: '#6aa8ff', name: '读取' },
  edit: { color: '#ff9a52', name: '修改' },
  bash: { color: '#9aa3b2', name: '命令' },
  web: { color: '#5cc98a', name: '联网' },
  task: { color: '#a47bff', name: '子代理' },
  other: { color: '#4cc6c0', name: '其他' },
};

// 内置两个；其余 agent 由服务端快照里的 agents 列表动态补进来
export const AGENT = {
  claude: { name: 'Claude Code', color: '#e07a5f', resume: (id) => `claude --resume ${id}` },
  codex: { name: 'Codex', color: '#7b7cff', resume: (id) => `codex resume ${id}` },
};

/** 用快照里的 [{id, name, color}] 更新 AGENT；没给颜色的按名字算一个 */
export function setAgents(list = []) {
  for (const { id, name, color } of list) {
    const a = AGENT[id] || (AGENT[id] = {});
    a.name = name || a.name || id;
    a.color = color || a.color || `hsl(${hash(id) % 360}, 55%, 62%)`;
  }
}

export const STATUS = {
  working: { text: '运行中', color: '#3fae5a' },
  waiting: { text: '等你处理', color: '#f08c2e' },
  stalled: { text: '需留意', color: '#d9a21b' },
  done: { text: '刚完成', color: '#4a8fe0' },
  idle: { text: '待命', color: '#9aa0a6' },
  sleep: { text: '休眠', color: '#c2c6cc' },
};

export const ROOF_COLORS = ['#7fa7d9', '#e58a6d', '#86c5a4', '#f2c26b', '#b59ce0', '#7fc6d9', '#e89aa8'];

const TZ = 'Asia/Shanghai';
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const WEEK = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' };

/** 北京时间的各个部分 */
export function shanghaiParts(ts = Date.now()) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : p.hour;
  return { hh, mm: p.minute, month: +p.month, day: +p.day, week: WEEK[p.weekday] || p.weekday, minutes: +hh * 60 + +p.minute };
}

export const fmtClock = (ts) => timeFmt.format(new Date(ts));
export const fmtHM = (ts) => fmtClock(ts).slice(0, 5);

export function fmtDur(ms) {
  if (!ms || ms < 0) return '0秒';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? (s % 60) + '秒' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60 ? (m % 60) + '分' : ''}`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return '—';
  const d = now - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  return `${Math.floor(d / 86400e3)} 天前`;
}

export function fmtNum(n) {
  n = n || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万`;
  return String(Math.round(n));
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 可复现的伪随机数（种树、摆石头每次位置一致） */
export function rng(seed = 1) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// 会话改名只存本机浏览器
const NAMES_KEY = 'agent-town:names';
let names = {};
try { names = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}'); } catch {}
export const displayTitle = (s) => names[s.id] || s.title || '未命名会话';
export function rename(id, title) {
  if (title) names[id] = title; else delete names[id];
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch {}
}

const PREFS_KEY = 'agent-town:prefs';
export function loadPrefs() {
  const def = { sound: false, notify: false, labels: true, weather: 'auto', time: 'auto', showSleep: false };
  try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
}
export function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} }
