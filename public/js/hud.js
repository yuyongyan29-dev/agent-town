// 2D 面板：统计条、会话列表、右侧抽屉（详情 / 报表 / 定时 / 派单 / 事件）、工具栏、提示
import { getJSON, postJSON } from './api.js';
import { AGENT, CAT, STATUS, esc, fmtAgo, fmtDur, fmtHM, fmtClock, fmtNum, localParts, displayTitle, rename } from './util.js';

const $ = (id) => document.getElementById(id);
const ORDER = { waiting: 0, stalled: 1, working: 2, done: 3, idle: 4, sleep: 5 };

const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  rotL: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  rotR: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6M11 8v6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6"/>',
  labels: '<path d="M4 7h16v10H4z"/><path d="M8 11h8"/>',
  tour: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  tank: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 14c2-3 4-3 6 0s4 3 4 0"/>',
  weather: '<path d="M7 17a4 4 0 1 1 1-7.9A5 5 0 0 1 18 10a3.5 3.5 0 0 1 0 7z"/>',
  time: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  notify: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  replay: '<path d="M12 7v5l3 2"/><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  quality: '<path d="M12 3l2.4 5.6L20 9.3l-4.3 3.9 1.2 5.8L12 16l-4.9 3 1.2-5.8L4 9.3l5.6-.7z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  dispatch: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  agents: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>',
};
const TOOLS = [
  ['home', '回到全景'], ['rotL', '左转'], ['rotR', '右转'], ['zoomIn', '放大'], ['zoomOut', '缩小'], '|',
  ['labels', '名牌'], ['tour', '巡游'], ['tank', '鱼缸'], ['weather', '天气'], ['time', '昼夜'], ['quality', '画质'], '|',
  ['sound', '声音'], ['notify', '通知'], ['replay', '回放'], ['report', '报表'], ['dispatch', '派单'], ['agents', 'agent'], ['panel', '面板'],
];

const agentTag = (a) => `<span class="ag" style="--c:${AGENT[a]?.color || '#888'}">${esc(AGENT[a]?.name || a)}</span>`;
const chip = (st) => `<span class="chip" style="--c:${STATUS[st]?.color || '#999'}">${STATUS[st]?.text || st}</span>`;
const sum = (a, b) => { for (const k of ['prompts', 'turns', 'tools', 'errors', 'tokens', 'output', 'cacheRead', 'minutes']) a[k] = (a[k] || 0) + (b?.[k] || 0); return a; };

function eventText(ev) {
  switch (ev.kind) {
    case 'turnStart': return `提问：${ev.prompt || ''}`;
    case 'toolStart': return `${ev.sub ? '子代理 · ' : ''}${ev.label || ev.tool}`;
    case 'toolEnd': return ev.isError ? `出错：${ev.errorText || ev.label || ev.tool}` : `${ev.label || ev.tool} 完成 · ${fmtDur(ev.dur)}`;
    case 'turnEnd': return ev.reason === 'interrupted' ? '本轮被中断' : `本轮完成 · ${fmtDur(ev.dur)}`;
    case 'wait': return `等你处理：${ev.reason || ''}`;
    case 'compact': return '压缩上下文';
    case 'sessionEnd': return '会话结束';
    default: return ev.kind;
  }
}
const eventColor = (ev) => (ev.isError ? '#d64541' : ev.kind === 'wait' ? STATUS.waiting.color : ev.kind === 'turnEnd' ? STATUS.done.color : ev.kind === 'turnStart' ? '#1f2633' : CAT[ev.cat]?.color || '#bbb');

export class Hud {
  constructor({ onAction, onSelectSession, onFilter }) {
    this.onAction = onAction;
    this.onSelectSession = onSelectSession;
    this.onFilter = onFilter;
    this.snap = null;
    this.filter = null;
    this.showSleep = false;
    this.tab = null;
    this.sid = null;
    this.events = [];
    this.schedule = [];
    this.report = { days: 7, metric: 'turns', data: null, at: 0 };
    this.html = {};
    this.toastsShown = new Map();
    this.timers = {};

    this.buildToolbar();
    $('sessions').addEventListener('click', (e) => {
      const row = e.target.closest('[data-sid]');
      if (row) return this.openDetail(row.dataset.sid);
      const g = e.target.closest('[data-project]');
      if (g) this.setFilter({ project: g.dataset.project });
    });
    $('agent-cards').addEventListener('click', (e) => {
      const c = e.target.closest('[data-agent]');
      if (c) this.setFilter(this.filter?.agent === c.dataset.agent ? null : { agent: c.dataset.agent });
    });
    $('filter').addEventListener('click', (e) => { if (e.target.closest('button')) this.setFilter(null); });
    $('show-sleep').addEventListener('change', (e) => { this.showSleep = e.target.checked; this.onAction('showSleep', this.showSleep); this.renderSessions(); });
    $('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.id === 'drawer-close') this.closeDrawer();
      else this.openTab(b.dataset.tab);
    });
    document.querySelector('.sec-title a').addEventListener('click', (e) => { e.preventDefault(); this.openTab('schedule'); });
    $('stats').addEventListener('click', (e) => {
      const s = e.target.closest('[data-click]');
      if (s) this.openTab(s.dataset.click);
    });
    $('toasts').addEventListener('click', (e) => {
      const t = e.target.closest('.toast');
      if (!t) return;
      if (t.dataset.sid) this.openDetail(t.dataset.sid);
      t.remove();
    });
    $('drawer-body').addEventListener('click', (e) => this.onDrawerClick(e));
    $('drawer-body').addEventListener('submit', (e) => { e.preventDefault(); e.target.id === 'agent-form' ? this.addAgent(e.target) : this.submitDispatch(e.target); });
  }

  // ---------- 工具栏 ----------
  buildToolbar() {
    $('toolbar').innerHTML = TOOLS.map((t) => (t === '|' ? '<i class="tb-sep"></i>'
      : `<button class="tb" data-act="${t[0]}" title="${t[1]}"><svg viewBox="0 0 24 24">${ICONS[t[0]]}</svg><span>${t[1]}</span></button>`)).join('');
    $('toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'report' || act === 'dispatch' || act === 'agents') this.tab === act ? this.closeDrawer() : this.openTab(act);
      else this.onAction(act);
    });
  }

  setToggle(act, on, title) {
    const b = document.querySelector(`.tb[data-act="${act}"]`);
    if (!b) return;
    b.classList.toggle('on', !!on);
    if (title) { b.title = title; b.querySelector('span').textContent = title; }
  }

  setLive(ok) {
    $('live').classList.toggle('off', !ok);
    $('live').querySelector('em').textContent = ok ? '实时' : '重连中';
  }

  put(id, html) {
    if (this.html[id] === html) return;
    this.html[id] = html;
    $(id).innerHTML = html;
  }

  // ---------- 快照 ----------
  setState(snap) {
    this.snap = snap;
    const c = {};
    for (const s of snap.sessions) c[s.status] = (c[s.status] || 0) + 1;
    const t = snap.today?.total || {};
    this.put('stats', [
      ['run', c.working || 0, '运行中'],
      ['hot', c.waiting || 0, '等你处理'],
      ['warn', c.stalled || 0, '需留意'],
      ['', t.turns || 0, '今日完成轮次', 'report'],
      ['', fmtNum(t.tokens), '今日 tokens', 'report'],
      ['', `${Math.round(t.minutes || 0)}`, '今日工作分钟', 'report'],
    ].map(([cls, n, label, click]) => `<div class="stat ${cls && n ? cls : ''}"${click ? ` data-click="${click}"` : ''}><b>${n}</b><span>${label}</span></div>`).join(''));
    this.renderSessions();
    this.renderAgents();
    if (this.tab === 'detail' && this.sid && !this.detailAt) this.loadDetail();
  }

  setFilter(f) {
    this.filter = f;
    const el = $('filter');
    if (f) {
      el.hidden = false;
      el.innerHTML = `<span>${esc(f.project || AGENT[f.agent]?.name || f.agent)}</span><button title="清除筛选">×</button>`;
    } else el.hidden = true;
    this.onFilter?.(f);
    this.renderSessions();
    this.renderAgents();
  }

  renderSessions() {
    if (!this.snap) return;
    const now = this.snap.now;
    let list = this.snap.sessions;
    if (this.filter?.project) list = list.filter((s) => s.project === this.filter.project);
    if (this.filter?.agent) list = list.filter((s) => s.agent === this.filter.agent);
    const hidden = this.showSleep ? 0 : list.filter((s) => s.status === 'sleep').length;
    if (!this.showSleep) list = list.filter((s) => s.status !== 'sleep');
    list = [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.lastActivity - a.lastActivity);

    const groups = new Map();
    for (const s of list) {
      if (!groups.has(s.project)) groups.set(s.project, []);
      groups.get(s.project).push(s);
    }
    let html = '';
    for (const [project, items] of groups) {
      const top = items[0].status;
      html += `<div class="group"><div class="group-head" data-project="${esc(project)}" title="只看这个项目"><span class="sq" style="background:${STATUS[top].color}"></span><b>${esc(project)}</b><em>${items.length}</em></div>`;
      for (const s of items) {
        const doing = s.current ? `→ ${esc(s.current.label || s.current.tool)}` : s.status === 'waiting' ? esc(s.reason || '等你确认') : esc(s.lastPrompt || '');
        html += `<div class="sess ${s.status}${s.id === this.sid && this.tab === 'detail' ? ' sel' : ''}" data-sid="${esc(s.id)}">
          <span class="dot" style="background:${STATUS[s.status].color}"></span>
          <div class="sess-main"><b>${esc(displayTitle(s))}</b><div class="sub">${agentTag(s.agent)}${doing} · ${fmtAgo(s.lastActivity, now)}</div></div>
          ${chip(s.status)}</div>`;
      }
      html += '</div>';
    }
    if (!list.length) html = `<div class="empty-tip">${this.filter ? '筛选条件下没有会话' : '还没有活跃的会话。<br>打开 Claude Code 或 Codex 干点活，这里就热闹了。'}</div>`;
    if (hidden) html += `<div class="hidden-tip">另有 ${hidden} 个休眠会话（超过 24 小时没动静）</div>`;
    this.put('sessions', html);
  }

  renderAgents() {
    if (!this.snap) return;
    const by = this.snap.today?.byAgent || {};
    this.put('agent-cards', Object.keys(AGENT).map((a) => {
      const ss = this.snap.sessions.filter((s) => s.agent === a);
      const live = ss.filter((s) => ['working', 'waiting', 'stalled'].includes(s.status)).length;
      const b = by[a] || {};
      const cats = b.cats || {};
      const total = Object.values(cats).reduce((x, y) => x + y, 0) || 1;
      const bar = Object.keys(CAT).map((k) => (cats[k] ? `<i style="width:${(cats[k] / total) * 100}%;background:${CAT[k].color}" title="${CAT[k].name} ${cats[k]}"></i>` : '')).join('');
      return `<div class="agent-card${this.filter?.agent === a ? ' sel' : ''}" data-agent="${a}" style="--c:${AGENT[a].color}">
        <div class="top"><i></i>${esc(AGENT[a].name)}</div>
        <div class="nums"><span>在跑 <b>${live}</b></span><span>今日 <b>${b.turns || 0}</b> 轮</span><span><b>${fmtNum(b.tokens)}</b> tok</span></div>
        <div class="catbar">${bar}</div></div>`;
    }).join(''));
  }

  // ---------- 时钟、天气、定时 ----------
  setClock(now) {
    const p = localParts(now);
    $('clock-time').textContent = `${p.hh}:${p.mm}`;
    $('clock-date').textContent = `${p.month}月${p.day}日 周${p.week}`;
  }

  setWeather(w, override) {
    const text = w?.ok ? `${w.city} · ${w.text} ${Math.round(w.temp)}°` : '天气暂不可用';
    $('clock-weather').textContent = override ? `${text}（演示：${override}）` : text;
  }

  setSchedule(items) {
    this.schedule = items || [];
    const top = this.schedule.filter((x) => x.enabled).slice(0, 4);
    this.put('sched-mini', top.length ? top.map((x) => `<div class="sched-row" title="${esc(x.command)}"><b>${esc(x.name)}</b><span>${x.next ? fmtHM(x.next) : esc(x.human)}</span></div>`).join('')
      : '<div class="sched-row"><span>没有找到定时任务</span></div>');
    if (this.tab === 'schedule') this.renderTab();
  }

  // ---------- 抽屉 ----------
  openDetail(sid) {
    this.sid = sid;
    this.detail = null;
    this.onSelectSession?.(sid);
    this.openTab('detail');
  }

  openTab(tab) {
    if (tab === 'detail' && !this.sid) tab = 'report';
    this.tab = tab;
    $('drawer').hidden = false;
    document.body.classList.add('drawer-open');
    for (const b of $('tabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    clearInterval(this.timers.tab);
    this.renderTab();
    this.renderSessions();
    if (tab === 'detail') { this.loadDetail(); this.timers.tab = setInterval(() => this.loadDetail(), 3000); }
    if (tab === 'report') this.loadReport();
    if (tab === 'dispatch') { this.loadDispatch(); this.timers.tab = setInterval(() => this.loadJobs(), 3000); }
    if (tab === 'agents') this.loadAgents();
  }

  closeDrawer() {
    this.tab = null;
    clearInterval(this.timers.tab);
    $('drawer').hidden = true;
    document.body.classList.remove('drawer-open');
    this.renderSessions();
  }

  renderTab() {
    const body = $('drawer-body');
    const keep = body.scrollTop;
    const html = this.tab === 'detail' ? this.detailHtml()
      : this.tab === 'report' ? this.reportHtml()
      : this.tab === 'schedule' ? this.scheduleHtml()
      : this.tab === 'dispatch' ? this.dispatchHtml()
      : this.tab === 'agents' ? this.agentsHtml()
      : this.tab === 'events' ? this.eventsHtml(this.events) : '';
    if (this.html.drawer === html) return;
    // 派单、添加 agent 的表单正在输入时不整块重绘
    if (this.tab === 'dispatch' && body.querySelector('form')) { this.renderJobs(); return; }
    if (this.tab === 'agents' && body.querySelector('#agent-form input:focus')) return;
    this.html.drawer = html;
    body.innerHTML = html;
    body.scrollTop = keep;
  }

  // 详情
  async loadDetail() {
    if (!this.sid) return;
    const sid = this.sid;
    try {
      const d = await getJSON(`/api/session/${encodeURIComponent(sid)}`);
      if (sid !== this.sid) return;
      this.detail = d;
    } catch { this.detail = { missing: true }; }
    if (this.tab === 'detail') this.renderTab();
  }

  detailHtml() {
    const d = this.detail;
    if (!d) return '<div class="empty-tip">加载中…</div>';
    if (d.missing) return '<div class="empty-tip">这个会话已经不在了</div>';
    const now = Date.now();
    const st = STATUS[d.status] || STATUS.idle;
    const resume = AGENT[d.agent]?.resume ? `cd ${JSON.stringify(d.cwd || '.')} && ${AGENT[d.agent].resume(d.id)}` : '';
    const t = d.today || {};
    let h = `<h3><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${st.color}"></span>${esc(displayTitle(d))}</h3>
      <div class="row">${agentTag(d.agent)}${chip(d.status)}<span class="hint" style="margin:0">${d.guess ? '状态为推断 · ' : ''}${fmtAgo(d.lastActivity, now)}活跃</span></div>
      <div class="btns"><button class="btn" data-do="rename">改名</button>${resume ? `<button class="btn" data-do="copy" data-text="${esc(resume)}">复制恢复命令</button>` : ''}<button class="btn" data-do="filter" data-project="${esc(d.project)}">只看这个项目</button></div>
      <div class="kv"><span>项目</span><b>${esc(d.project)}</b><span>目录</span><code>${esc(d.cwd || '—')}</code>
      <span>模型</span><code>${esc(d.model || '—')}</code><span>权限模式</span><code>${esc(d.permissionMode || '—')}</code>
      <span>开始于</span><span style="color:inherit">${d.createdAt ? `${fmtClock(d.createdAt)} · ${fmtAgo(d.createdAt, now)}` : '—'}</span>
      <span>会话 ID</span><code>${esc(d.id)}</code></div>`;
    if (d.status === 'waiting') h += `<div class="box" style="border-left:3px solid ${STATUS.waiting.color}"><b>等你处理</b><br>${esc(d.reason || '切回终端看看它在问什么')}</div>`;
    if (d.current) h += `<div class="box"><b>正在做</b>：<span style="color:${CAT[d.current.cat]?.color}">■</span> ${esc(d.current.label || d.current.tool)} · 已 ${fmtDur(now - d.current.since)}</div>`;
    if (d.subagents?.length) h += `<div class="box"><b>子代理 ${d.subagents.length} 个</b>${d.subagents.map((s) => `<br>· ${esc(s.label)} · ${fmtDur(now - s.since)}`).join('')}</div>`;
    if (d.lastError) h += `<div class="box err"><b>最近错误</b><br>${esc(d.lastError.text || d.lastError)}</div>`;
    if (d.lastPrompt) h += `<h4>最近一次提问</h4><div class="box">${esc(d.lastPrompt)}</div>`;
    h += `<h4>今天</h4><div class="mini-stats"><div><b>${t.turns || 0}</b><span>轮次</span></div><div><b>${t.tools || 0}</b><span>工具调用</span></div><div><b>${t.errors || 0}</b><span>出错</span></div><div><b>${fmtNum(t.tokens)}</b><span>tokens</span></div></div>`;
    if (d.tokens) h += `<div class="hint">会话累计：输入 ${fmtNum(d.tokens.input)} · 输出 ${fmtNum(d.tokens.output)} · 缓存读 ${fmtNum(d.tokens.cacheRead)}</div>`;
    if (d.tools?.length) {
      h += `<h4>工具耗时</h4><table><tr><th>工具</th><th class="num">次数</th><th class="num">平均</th><th class="num">最长</th><th class="num">出错</th></tr>${d.tools.slice(0, 12).map((x) => `<tr><td>${esc(x.tool)}</td><td class="num">${x.n}</td><td class="num">${fmtDur(x.avg)}</td><td class="num">${fmtDur(x.max)}</td><td class="num">${x.errors || ''}</td></tr>`).join('')}</table>`;
    }
    h += `<h4>时间线</h4>${this.eventsHtml([...(d.timeline || [])].reverse(), true)}`;
    return h;
  }

  // 报表
  async loadReport(force) {
    const r = this.report;
    if (!force && r.data && r.data.length === r.days && Date.now() - r.at < 60e3) return;
    try {
      r.data = await getJSON(`/api/report?days=${r.days}`);
      r.at = Date.now();
    } catch { r.data = []; }
    if (this.tab === 'report') this.renderTab();
  }

  reportHtml() {
    const r = this.report;
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, t]) => `<button data-${key}="${v}" class="${String(r[key]) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    let h = `<h3>报表</h3><div class="row" style="margin-top:8px">${seg('days', [[7, '近 7 天'], [30, '近 30 天']])}${seg('metric', [['turns', '轮次'], ['tokens', 'tokens'], ['minutes', '工作分钟']])}</div>`;
    if (!r.data) return h + '<div class="empty-tip">加载中…</div>';
    const metric = r.metric;
    const val = (b) => (b?.[metric] || 0);
    const agents = Object.keys(AGENT);
    const max = Math.max(1, ...r.data.map((d) => agents.reduce((s, a) => s + val(d.byAgent?.[a]), 0)));
    const W = 380, H = 160, pad = 22, bw = (W - pad) / r.data.length;
    let bars = '';
    r.data.forEach((d, i) => {
      let y = H - 18;
      for (const a of agents) {
        const hgt = (val(d.byAgent?.[a]) / max) * (H - 34);
        if (hgt > 0) bars += `<rect x="${pad + i * bw + bw * 0.15}" y="${y - hgt}" width="${bw * 0.7}" height="${hgt}" rx="2" fill="${AGENT[a].color}"><title>${d.date} ${esc(AGENT[a].name)}：${fmtNum(val(d.byAgent?.[a]))}</title></rect>`;
        y -= hgt;
      }
      const step = r.data.length > 10 ? 5 : 1;
      if (i % step === 0 || i === r.data.length - 1) bars += `<text x="${pad + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${d.date.slice(5).replace('-', '/')}</text>`;
    });
    const grid = [0, 0.5, 1].map((f) => { const y = H - 18 - f * (H - 34); return `<line class="grid" x1="${pad}" x2="${W}" y1="${y}" y2="${y}"/><text x="${pad - 3}" y="${y + 3}" text-anchor="end">${fmtNum(max * f)}</text>`; }).join('');
    const total = r.data.reduce((acc, d) => sum(acc, d.total), {});
    h += `<div class="big-total"><div><b>${total.turns || 0}</b><span>轮次</span></div><div><b>${total.tools || 0}</b><span>工具调用</span></div><div><b>${fmtNum(total.tokens)}</b><span>tokens</span></div><div><b>${Math.round(total.minutes || 0)}</b><span>工作分钟</span></div><div><b>${total.errors || 0}</b><span>出错</span></div></div>
      <div class="legend">${agents.map((a) => `<span><i style="background:${AGENT[a].color}"></i>${esc(AGENT[a].name)}</span>`).join('')}</div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${bars}</svg>`;
    // 项目汇总
    const projects = {};
    for (const d of r.data) for (const [p, b] of Object.entries(d.byProject || {})) {
      const x = projects[p] || (projects[p] = { agents: {} });
      sum(x, b);
      for (const [a, ab] of Object.entries(b.agents || {})) x.agents[a] = sum(x.agents[a] || {}, ab);
    }
    const rows = Object.entries(projects).sort((a, b) => (b[1][metric] || 0) - (a[1][metric] || 0)).slice(0, 15);
    if (rows.length) {
      h += `<h4>按项目</h4><table><tr><th>项目</th><th class="num">轮次</th><th class="num">工具</th><th class="num">出错</th><th class="num">tokens</th><th class="num">分钟</th></tr>${rows.map(([p, b]) => {
        const dots = Object.keys(b.agents).map((a) => `<span style="color:${AGENT[a]?.color}">●</span>`).join('');
        return `<tr><td>${dots} ${esc(p)}</td><td class="num">${b.turns || 0}</td><td class="num">${b.tools || 0}</td><td class="num">${b.errors || ''}</td><td class="num">${fmtNum(b.tokens)}</td><td class="num">${Math.round(b.minutes || 0)}</td></tr>`;
      }).join('')}</table>`;
    } else h += '<div class="empty-tip">这段时间没有记录</div>';
    const cats = {};
    for (const d of r.data) for (const [k, n] of Object.entries(d.total?.cats || {})) cats[k] = (cats[k] || 0) + n;
    const ct = Object.values(cats).reduce((a, b) => a + b, 0);
    if (ct) h += `<h4>工具类型</h4><div class="catbar" style="height:10px">${Object.keys(CAT).map((k) => (cats[k] ? `<i style="width:${(cats[k] / ct) * 100}%;background:${CAT[k].color}"></i>` : '')).join('')}</div>
      <div class="legend" style="flex-wrap:wrap">${Object.keys(CAT).filter((k) => cats[k]).map((k) => `<span><i style="background:${CAT[k].color}"></i>${CAT[k].name} ${cats[k]}</span>`).join('')}</div>`;
    return h;
  }

  // 定时
  scheduleHtml() {
    const items = this.schedule;
    let h = '<h3>定时任务</h3><div class="hint">来自本机 crontab、launchd、Claude 定时任务等；和 agent 有关的排在前面。</div>';
    if (!items.length) return h + '<div class="empty-tip">没有找到定时任务</div>';
    return h + items.map((x) => `<div class="sched"><div class="row"><b>${esc(x.name)}</b>${x.agentRelated ? '<span class="tag agent">agent</span>' : ''}<span class="tag${x.enabled ? '' : ' off'}">${esc(x.source)}</span></div>
      <div class="hint" style="margin-top:2px">${esc(x.human || x.schedule)}${x.next ? ` · 下次 ${fmtClock(x.next).slice(0, 5)}（${fmtAgo(2 * Date.now() - x.next).replace('前', '后')}）` : ''}${x.enabled ? '' : ' · 已停用'}</div>
      <code class="mono">${esc(x.command)}</code></div>`).join('');
  }

  // 派单
  async loadDispatch() {
    try { this.projects = await getJSON('/api/projects'); } catch { this.projects = []; }
    this.html.drawer = null;
    if (this.tab === 'dispatch') {
      const body = $('drawer-body');
      body.innerHTML = this.html.drawer = this.dispatchHtml();
    }
    this.loadJobs();
  }

  async loadJobs() {
    try { this.jobs = await getJSON('/api/jobs'); } catch { this.jobs = []; }
    if (this.tab === 'dispatch') this.renderJobs();
  }

  dispatchHtml() {
    const ps = this.projects || [];
    return `<h3>派单</h3><div class="hint">在一个已有项目目录里启动无头 agent（<code class="mono">claude -p</code> / <code class="mono">codex exec</code>），跑完自动退出，进度会出现在小镇里。它拿到的权限和你在终端里直接运行一样。</div>
      <form class="form"><label>交给谁</label><div class="seg" id="dispatch-agent">${Object.keys(AGENT).filter((a) => AGENT[a].resume).map((a, i) => `<button type="button" data-agent-pick="${a}" class="${i ? '' : 'on'}">${esc(AGENT[a].name)}</button>`).join('')}</div>
      <label>在哪个项目</label><select name="cwd">${ps.length ? ps.map((p) => `<option value="${esc(p.cwd)}">${esc(p.name)} — ${esc(p.cwd)}</option>`).join('') : '<option value="">（还没有见过任何项目目录）</option>'}</select>
      <label>任务</label><textarea name="prompt" placeholder="例如：跑一遍测试，把失败的用例修好"></textarea>
      <div class="btns"><button class="btn primary" type="submit"${ps.length ? '' : ' disabled'}>派出去</button><span class="hint" id="dispatch-msg" style="margin:0;align-self:center"></span></div></form>
      <h4>最近派出的任务</h4><div id="jobs"></div>`;
  }

  renderJobs() {
    const el = document.getElementById('jobs');
    if (!el) return;
    const jobs = this.jobs || [];
    const html = jobs.length ? jobs.map((j) => {
      const st = j.exitCode == null ? ['运行中', STATUS.working.color] : j.exitCode === 0 ? ['已完成', STATUS.done.color] : [`退出码 ${j.exitCode}`, '#d64541'];
      return `<div class="job"><div class="row">${agentTag(j.agent)}<b title="${esc(j.prompt)}">${esc(j.prompt)}</b><span class="chip" style="--c:${st[1]}">${st[0]}</span></div>
        <div class="hint" style="margin-top:3px">${esc(j.cwd)} · ${fmtAgo(j.startedAt)}${j.endedAt ? ` · 用时 ${fmtDur(j.endedAt - j.startedAt)}` : ''}</div>${j.tail ? `<pre>${esc(j.tail)}</pre>` : ''}</div>`;
    }).join('') : '<div class="empty-tip">还没有派过任务</div>';
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  }

  async submitDispatch(form) {
    const agent = form.querySelector('[data-agent-pick].on')?.dataset.agentPick || 'claude';
    const cwd = form.cwd.value, prompt = form.prompt.value.trim();
    const msg = document.getElementById('dispatch-msg');
    if (!prompt) { msg.textContent = '先写任务内容'; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    msg.textContent = '派单中…';
    try {
      await postJSON('/api/dispatch', { agent, cwd, prompt });
      form.prompt.value = '';
      msg.textContent = '已派出';
      this.loadJobs();
    } catch (e) { msg.textContent = e.message; }
    btn.disabled = false;
  }

  // agent：检测本机装了哪些 agent，手动添加或移除
  async loadAgents() {
    try { this.detected = await getJSON('/api/agents/detect'); } catch { this.detected = []; }
    if (this.tab === 'agents') this.renderTab();
  }

  agentsHtml() {
    const list = this.detected;
    const known = new Set((list || []).map((a) => a.id));
    const added = Object.entries(AGENT).filter(([id]) => !known.has(id));
    const row = (a) => {
      const on = !!AGENT[a.id] || a.added;
      const btn = on ? (a.log ? '<span class="hint" style="margin:0">读本机日志</span>' : `<button class="btn" data-agent-remove="${esc(a.id)}">移除</button>`)
        : `<button class="btn primary" data-agent-add="${esc(a.id)}">添加</button>`;
      const where = a.installed ? (a.path.includes('/bin/') ? `找到命令 <code class="mono">${esc(a.path)}</code>` : `找到配置目录 <code class="mono">${esc(a.path)}</code>`) : '本机没找到';
      return `<div class="agent-row"><i style="background:${a.color}"></i><div><b>${esc(a.name)}</b><div class="hint" style="margin:2px 0 0">${where}</div></div>${btn}</div>`;
    };
    let h = `<h3>agent</h3><div class="hint">检测本机装了哪些 AI 编程 agent。添加后小镇里会为它开一个街区。Claude Code 和 Codex 直接读本机日志；其他 agent 需要把事件推给小镇，方法见下面。</div>`;
    h += list ? list.map(row).join('') : '<div class="empty-tip">检测中…</div>';
    if (added.length) h += `<h4>自定义添加的</h4>${added.map(([id, a]) => row({ id, name: a.name, color: a.color, installed: false, path: '', added: true, log: false }).replace('本机没找到', `标识 <code class="mono">${esc(id)}</code>`)).join('')}`;
    h += `<h4>添加其他 agent</h4><form class="form" id="agent-form"><label>名称</label><input name="name" placeholder="例如：我的脚本 agent" maxlength="24">
      <label>颜色</label><input name="color" type="color" value="#4aa3df">
      <div class="btns"><button class="btn primary" type="submit">添加</button><span class="hint" id="agent-msg" style="margin:0;align-self:center"></span></div></form>
      <h4>怎么把事件推给小镇</h4><div class="hint">支持 hook 的 agent：在它的 hook 配置里调用 <code class="mono">node scripts/hook.js &lt;标识&gt;</code>。其他程序：向 <code class="mono">POST /api/ingest</code> 推事件，格式见 README。</div>`;
    return h;
  }

  async changeAgent(kind, id) {
    try {
      if (kind === 'add') { const a = this.detected?.find((x) => x.id === id); await postJSON('/api/agents', { id, name: a?.name, color: a?.color }); }
      else await postJSON('/api/agents/remove', { id });
      if (kind === 'remove') delete AGENT[id];
    } catch (e) { this.toast({ kind: 'error', title: kind === 'add' ? '添加失败' : '移除失败', body: e.message }); }
    this.loadAgents();
  }

  async addAgent(form) {
    const name = form.name.value.trim();
    const msg = document.getElementById('agent-msg');
    if (!name) { msg.textContent = '先填名称'; return; }
    // 标识由名称生成；名称里没有英文字母或数字时（比如纯中文），用时间戳兜底
    const id = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `agent-${Date.now().toString(36)}`;
    try {
      await postJSON('/api/agents', { id, name, color: form.color.value });
      form.name.value = '';
      msg.textContent = `已添加，标识 ${id}`;
    } catch (e) { msg.textContent = e.message; }
    this.loadAgents();
  }

  // 事件
  pushEvent(ev) {
    this.events.unshift(ev);
    if (this.events.length > 200) this.events.length = 200;
    if (this.tab === 'events' && !this.timers.ev) this.timers.ev = setTimeout(() => { this.timers.ev = null; this.renderTab(); }, 400);
  }

  eventsHtml(list, inDetail) {
    if (!list.length) return '<div class="empty-tip">还没有事件，agent 一干活这里就会滚动起来</div>';
    const names = new Map((this.snap?.sessions || []).map((s) => [s.id, displayTitle(s)]));
    return `${inDetail ? '' : '<h3>实时事件</h3><div class="hint">最近 200 条，点一条看对应会话。</div>'}<ul class="tl">${list.map((ev) => `<li${inDetail ? '' : ` data-sid="${esc(ev.sid)}" style="cursor:pointer"`}><time>${fmtClock(ev.ts)}</time><i class="ic" style="background:${eventColor(ev)}"></i>
      <div class="tx${ev.isError ? ' err' : ''}">${inDetail ? '' : `<span class="who">${esc(AGENT[ev.agent]?.name || ev.agent)} · ${esc(names.get(ev.sid) || ev.project)}：</span>`}${esc(eventText(ev))}</div></li>`).join('')}</ul>`;
  }

  onDrawerClick(e) {
    const t = e.target;
    const add = t.closest('[data-agent-add]'), del = t.closest('[data-agent-remove]');
    if (add || del) return this.changeAgent(add ? 'add' : 'remove', (add || del).dataset.agentAdd || del.dataset.agentRemove);
    const days = t.closest('[data-days]'), metric = t.closest('[data-metric]');
    if (days) { this.report.days = +days.dataset.days; this.html.drawer = null; this.renderTab(); this.loadReport(true); return; }
    if (metric) { this.report.metric = metric.dataset.metric; this.renderTab(); return; }
    const pick = t.closest('[data-agent-pick]');
    if (pick) { for (const b of pick.parentElement.children) b.classList.toggle('on', b === pick); return; }
    const act = t.closest('[data-do]');
    if (act?.dataset.do === 'rename' && this.detail) {
      const name = prompt('给这个会话起个好认的名字（只存在本机浏览器，留空恢复原名）', displayTitle(this.detail));
      if (name !== null) { rename(this.detail.id, name.trim()); this.html = {}; this.renderSessions(); this.renderTab(); }
    } else if (act?.dataset.do === 'copy') {
      navigator.clipboard?.writeText(act.dataset.text).then(() => { act.textContent = '已复制'; setTimeout(() => (act.textContent = '复制恢复命令'), 1500); });
    } else if (act?.dataset.do === 'filter') this.setFilter({ project: act.dataset.project });
    const ev = t.closest('li[data-sid]');
    if (ev) this.openDetail(ev.dataset.sid);
  }

  // ---------- 提示 ----------
  toast({ kind, title, body, sid }) {
    const key = `${kind}:${sid}:${title}`;
    const now = Date.now();
    if (now - (this.toastsShown.get(key) || 0) < 3000) return;
    this.toastsShown.set(key, now);
    const color = kind === 'wait' ? STATUS.waiting.color : kind === 'done' ? STATUS.done.color : kind === 'error' ? '#d64541' : kind === 'stalled' ? STATUS.stalled.color : '#3b7ddd';
    const el = document.createElement('div');
    el.className = 'toast';
    el.style.setProperty('--c', color);
    if (sid) el.dataset.sid = sid;
    el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
    const box = $('toasts');
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'wait' ? 9000 : 5000);
  }

  tip(x, y, html) {
    const el = $('tooltip');
    if (x == null) { el.hidden = true; return; }
    el.hidden = false;
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.min(innerWidth - w - 8, x + 14)}px`;
    el.style.top = `${Math.min(innerHeight - h - 8, y + 14)}px`;
  }

  replayBar(st) {
    const el = $('replay');
    if (!st) { el.hidden = true; return; }
    el.hidden = false;
    $('replay-clock').textContent = fmtClock(st.clock);
    $('replay-progress').style.width = `${(st.progress * 100).toFixed(1)}%`;
    for (const b of el.querySelectorAll('[data-speed]')) b.classList.toggle('on', +b.dataset.speed === st.speed);
  }
}
