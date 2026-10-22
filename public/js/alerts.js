// 提醒：合成音效 + 系统通知 + 标签页标题角标
let ctx = null;

function tone(freq, start, dur, type = 'sine', gain = 0.12) {
  const t0 = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

const SOUNDS = {
  done: () => { tone(660, 0, 0.25); tone(990, 0.12, 0.4); },
  wait: () => { tone(520, 0, 0.18, 'triangle', 0.14); tone(520, 0.24, 0.18, 'triangle', 0.14); },
  error: () => { tone(180, 0, 0.3, 'sawtooth', 0.05); tone(140, 0.1, 0.35, 'sawtooth', 0.05); },
  pop: () => tone(880, 0, 0.08, 'sine', 0.04),
};

export const alerts = {
  sound: false,
  notify: false,
  lastPlayed: {},

  /** 浏览器要求音频必须在用户点击后启用 */
  unlock() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  },

  play(name) {
    if (!this.sound || !ctx) return;
    const now = performance.now();
    if (now - (this.lastPlayed[name] || 0) < 1200) return; // 同类音效 1.2 秒内只响一次
    this.lastPlayed[name] = now;
    SOUNDS[name]?.();
  },

  async requestNotify() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  },

  push(title, body, tag) {
    if (!this.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  },

  badge(waiting) {
    document.title = waiting ? `(${waiting}) 等你处理 · Agent 小镇` : 'Agent 小镇';
  },
};
