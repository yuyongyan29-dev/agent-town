// 入口：渲染器、相机与后期，把实时数据接到 3D 小镇和 HUD 上；每个 agent 一个街区，铺在可平移缩放的无限画布上
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { World, loadTown, releaseTextures } from './world.js';
import { AgentActor } from './agents.js';
import { ParcelSystem } from './parcels.js';
import { Hud } from './hud.js';
import { alerts } from './alerts.js';
import { connect, getJSON } from './api.js';
import { CAMERA_HOME, DISTRICT, SLOT_Z } from './layout.js';
import { AGENT, CAT, STATUS, clamp, esc, fmtDur, displayTitle, loadPrefs, savePrefs, setAgents, localParts, smooth } from './util.js';

const prefs = loadPrefs();
let raf = 0, timer = 0; // 帧调度（见主循环 kick / loop）
const WEATHERS = ['auto', 'clear', 'cloudy', 'rain', 'snow', 'storm', 'fog'];
const WEATHER_NAME = { clear: '晴', partly: '多云', cloudy: '阴', fog: '雾', rain: '雨', snow: '雪', storm: '雷雨' };
const TIMES = ['auto', 'day', 'night'];
const TIME_NAME = { auto: '昼夜：自动', day: '昼夜：白天', night: '昼夜：夜晚' };
const RANK = { waiting: 0, stalled: 1, working: 2, done: 3, idle: 4, sleep: 5 };

// ---------- 渲染器与相机 ----------
const host = document.getElementById('scene');
// 省电优先：不强制独显；光照阴影都烘焙在贴图里，不开实时阴影
// 高分屏本身像素够密，不开多重采样抗锯齿：它要额外分配几块全屏缓冲，占上百 MB 显存
const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 1.5, powerPreference: 'low-power' });
// 默认按 1 倍清晰度渲染：贴图里的光影本来就柔和，和 1.5 倍几乎看不出差别，画布显存省一半；「画质：高」时 2 倍。
// 不做泛光、移轴这类全屏后期：每画一帧都要多跑好几遍全屏，在高分屏上能把 GPU 吃到八成
renderer.setPixelRatio(Math.min(devicePixelRatio, prefs.hq ? 2 : 1));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
host.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
labels.domElement.className = 'labels';
document.body.appendChild(labels.domElement);

const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 1, 1600);
camera.position.set(...CAMERA_HOME.pos);
// 地图式操作：左键平移、右键旋转、滚轮朝光标缩放
const controls = new MapControls(camera, renderer.domElement);
controls.target.set(...CAMERA_HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.25;
controls.minDistance = 25;
controls.maxDistance = 600;
controls.zoomToCursor = true;
controls.update();

// ---------- 场景 ----------
await loadTown(); // 烘焙好的模型和布局（public/assets）
releaseTextures(renderer);
const world = new World();
const actors = {};
const parcels = new ParcelSystem(world, actors);

// 街区位置：存在本机浏览器，拖动过的保持原位；新 agent 从原点向外找第一块空地
const LAYOUT_KEY = 'agent-town:districts';
let spots = {};
try { spots = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch {}
const saveSpots = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(spots)); } catch {} };
// 画布是一整片无限的大地：街区可以放在任何地方，只是不能互相压住；新街区之间隔一片森林
const GAP = 24;
const overlaps = ([x, z], except) => Object.values(world.districts).some((d) => d !== except && Math.abs(d.group.position.x - x) < DISTRICT.w + 6 && Math.abs(d.group.position.z - z) < DISTRICT.d + 6);
const RING = [];
for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) RING.push([i * (DISTRICT.w + GAP), j * (DISTRICT.d + GAP)]);
RING.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
function placeDistrict(agent) {
  const others = Object.entries(spots).filter(([a]) => a !== agent && !world.districts[a]).map(([, p]) => p);
  const free = (c) => !overlaps(c) && !others.some(([x, z]) => Math.abs(x - c[0]) < DISTRICT.w + 6 && Math.abs(z - c[1]) < DISTRICT.d + 6);
  if (!spots[agent] || overlaps(spots[agent])) spots[agent] = RING.find(free) || [0, 0];
  saveSpots();
  return spots[agent];
}
function ensureAgent(id) {
  if (world.districts[id]) return;
  if (!AGENT[id]) setAgents([{ id }]);
  world.addDistrict(id, AGENT[id], placeDistrict(id));
  actors[id] = new AgentActor(world, id);
  actors[id].onClick = (agent) => hud.setFilter({ agent });
}
const toWorld = (v, D) => new THREE.Vector3().copy(v).add(D.group.position);
const factoryPos = (D, i) => D.factories[i].group.getWorldPosition(new THREE.Vector3());

// 左侧面板盖住画面时，把投影中心右移，让小镇落在空出来的区域
function frame() {
  const show = prefs.panel !== false && !document.body.classList.contains('tank') && innerWidth >= 900;
  const left = show ? document.getElementById('left').getBoundingClientRect().right : 0;
  camera.setViewOffset(innerWidth, innerHeight, -left / 2, 0, innerWidth, innerHeight);
}

// ---------- HUD ----------
let snap = null;
let replay = null;
let tour = null;
let tween = null;

const hud = new Hud({
  onAction,
  onSelectSession: () => {},
  onFilter: (f) => {
    document.body.classList.toggle('filtered', !!f);
    const D = world.districts[f?.agent];
    if (D) flyTo(toWorld(D.plaza.agentPos, D), 34);
    else if (f?.project) {
      const P = Object.values(world.districts).find((d) => d.slots.includes(f.project));
      if (P) flyTo(factoryPos(P, P.slots.indexOf(f.project)), 34);
    }
  },
});
hud.showSleep = prefs.showSleep;
document.getElementById('show-sleep').checked = prefs.showSleep;

labels.domElement.addEventListener('click', (e) => {
  const lod = world.districts[e.target.closest('.lod-pill')?.dataset.agent];
  if (lod) return flyTo(lod.group.position, 75);
  const pill = e.target.closest('.factory-pill');
  const name = world.districts[pill?.dataset.agent]?.slots[pill.dataset.slot];
  if (name) hud.setFilter({ project: name });
});

// ---------- 实时数据 ----------
let prev = new Map();
let first = true;

function onState(s) {
  snap = s;
  setAgents(s.agents);
  for (const a of s.agents || []) ensureAgent(a.id);
  for (const x of s.sessions) ensureAgent(x.agent);
  // 被移除的 agent：街区、角色、包裹一起收走
  const live = new Set([...(s.agents || []).map((a) => a.id), ...s.sessions.map((x) => x.agent)]);
  for (const id of Object.keys(world.districts)) {
    if (live.has(id)) continue;
    for (const [k, p] of parcels.items) if (p.agent === id) parcels.release(k);
    world.removeDistrict(id);
    delete actors[id];
    delete spots[id];
    saveSpots();
  }
  hud.setState(s);
  hud.setClock(s.now);

  parcels.activeAgents.clear();
  for (const [a, D] of Object.entries(world.districts)) {
    // 项目 → 车间：该 agent 最近活跃的 7 个项目各占一个车间，已有的保持原位
    const byProject = new Map();
    for (const x of s.sessions) {
      if (x.agent !== a || (x.status === 'sleep' && !prefs.showSleep)) continue;
      const g = byProject.get(x.project) || byProject.set(x.project, []).get(x.project);
      g.push(x);
    }
    const top = [...byProject.entries()]
      .map(([p, list]) => [p, list, Math.max(...list.map((x) => x.lastActivity)), Math.min(...list.map((x) => RANK[x.status]))])
      .sort((a, b) => a[3] - b[3] || b[2] - a[2])
      .slice(0, SLOT_Z.length);
    const keep = new Set(top.map((x) => x[0]));
    const slots = D.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i] && !keep.has(slots[i]) && !replay) slots[i] = null;
    for (const [p] of top) D.slotOf(p);
    D.activeSlots.clear();
    for (let i = 0; i < slots.length; i++) {
      const list = byProject.get(slots[i]);
      if (!list) { D.setFactory(i, null); continue; }
      const st = list.reduce((a, x) => (RANK[x.status] < RANK[a] ? x.status : a), 'sleep');
      const active = list.some((x) => ['working', 'waiting', 'stalled'].includes(x.status));
      if (active) D.activeSlots.add(i);
      D.setFactory(i, {
        name: slots[i],
        count: list.length,
        status: st,
        statusColor: STATUS[st].color,
        active,
        title: `${slots[i]} · ${list.length} 个会话 · ${STATUS[st].text}`,
      });
    }
    const list = s.sessions.filter((x) => x.agent === a);
    actors[a].setSessions(list);
    if (list.some((x) => ['working', 'waiting', 'stalled'].includes(x.status))) parcels.activeAgents.add(a);
    D.setLod(STATUS[actors[a].state].color, actors[a].summary);
  }
  if (!replay) parcels.reconcile(s.sessions);
  alerts.badge(s.sessions.filter((x) => x.status === 'waiting').length);
  kick();

  // 状态变化提醒（首个快照只记基线）
  const next = new Map(s.sessions.map((x) => [x.id, x.status]));
  if (!first) {
    for (const x of s.sessions) {
      const was = prev.get(x.id);
      if (was === x.status || was == null) continue;
      const name = displayTitle(x);
      const who = AGENT[x.agent]?.name || x.agent;
      if (x.status === 'waiting') {
        hud.toast({ kind: 'wait', title: `${who} 等你处理`, body: `${name} · ${x.reason || '切回终端看看'}`, sid: x.id });
        alerts.play('wait');
        alerts.push(`${who} 等你处理`, `${x.project} · ${name}`, `wait:${x.id}`);
      } else if (x.status === 'done' && (was === 'working' || was === 'stalled')) {
        const dur = x.lastTurnEndAt && x.turnStartedAt ? ` · 用时 ${fmtDur(x.lastTurnEndAt - x.turnStartedAt)}` : '';
        hud.toast({ kind: 'done', title: `${who} 干完了`, body: `${name}${dur}`, sid: x.id });
        alerts.play('done');
        alerts.push(`${who} 干完了`, `${x.project} · ${name}`, `done:${x.id}`);
        actors[x.agent]?.celebrate();
      } else if (x.status === 'stalled') {
        hud.toast({ kind: 'stalled', title: '需留意', body: `${name} 很久没动静了，可能卡住`, sid: x.id });
      }
    }
  }
  prev = next;
  first = false;
}

function onEvent(ev) {
  hud.pushEvent(ev);
  if (ev.kind === 'toolEnd' && ev.isError) alerts.play('error');
  if (!replay) parcels.onEvent(ev);
  kick();
}

connect({ onState, onEvent, onStatus: (ok) => hud.setLive(ok) });
parcels.onShip = (agent) => { alerts.play('pop'); actors[agent]?.hop(); };

// ---------- 天气与昼夜 ----------
let weather = null;
async function loadWeather() {
  try { weather = await getJSON('/api/weather'); } catch { weather = null; }
  applyEnv();
}
function applyEnv() {
  const now = Date.now();
  const mins = localParts(now).minutes;
  const toMin = (ts) => localParts(ts).minutes;
  // 天气城市和本机同一时区时才用它的日出日落，否则按本机时间 6:30 / 18:00 算昼夜
  const sameZone = weather?.ok && weather.sunrise && weather.utcOffset === -new Date().getTimezoneOffset() * 60;
  const rise = sameZone ? toMin(weather.sunrise) : 390;
  const set = sameZone ? toMin(weather.sunset) : 1080;
  // 日出前后、日落前后各 20 分钟平滑过渡
  let night = 1 - smooth(rise - 20, rise + 20, mins) * (1 - smooth(set - 20, set + 20, mins));
  let day = clamp((mins - rise) / Math.max(1, set - rise));
  if (prefs.time === 'day') { night = 0; day = 0.45; }
  if (prefs.time === 'night') night = 1;
  const kind = prefs.weather === 'auto' ? weather?.kind || 'partly' : prefs.weather;
  world.setEnv({ night, day, kind });
  document.body.classList.toggle('night', night > 0.5);
  hud.setWeather(weather, prefs.weather === 'auto' ? null : WEATHER_NAME[prefs.weather]);
  hud.setToggle('weather', prefs.weather !== 'auto', prefs.weather === 'auto' ? '天气：实况' : `天气：${WEATHER_NAME[prefs.weather]}`);
  hud.setToggle('time', prefs.time !== 'auto', TIME_NAME[prefs.time]);
  kick();
}
loadWeather();
setInterval(loadWeather, 10 * 60e3);
setInterval(applyEnv, 60e3);

async function loadSchedule() {
  try { hud.setSchedule(await getJSON('/api/schedule')); } catch { hud.setSchedule([]); }
}
loadSchedule();
setInterval(loadSchedule, 60e3);

// ---------- 相机动作 ----------
function flyTo(pos, dist, dur = 1.1) {
  const off = camera.position.clone().sub(controls.target).setLength(dist ?? camera.position.distanceTo(controls.target));
  const to = new THREE.Vector3(pos.x, 0, pos.z);
  tweenTo(to.clone().add(off), to, dur);
}
function tweenTo(pos, tgt, dur = 1) {
  tween = { t: 0, dur, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: tgt };
  kick();
}
function orbit(deg) {
  const off = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
  tweenTo(controls.target.clone().add(off), controls.target.clone(), 0.7);
}
function zoom(f) {
  const off = camera.position.clone().sub(controls.target);
  off.setLength(clamp(off.length() * f, controls.minDistance, controls.maxDistance));
  tweenTo(controls.target.clone().add(off), controls.target.clone(), 0.5);
}
// 全景：把所有街区框进画面
function home() {
  const ps = Object.values(world.districts).map((d) => d.group.position);
  if (!ps.length) ps.push(new THREE.Vector3());
  const box = new THREE.Box3().setFromPoints(ps);
  const c = box.getCenter(new THREE.Vector3());
  const span = Math.max(box.max.x - box.min.x + DISTRICT.w, (box.max.z - box.min.z + DISTRICT.d) * 1.4);
  const off = new THREE.Vector3(...CAMERA_HOME.pos).sub(new THREE.Vector3(...CAMERA_HOME.target));
  off.setLength(Math.min(controls.maxDistance, Math.max(off.length(), off.length() * span / DISTRICT.w)));
  const tgt = c.add(new THREE.Vector3(...CAMERA_HOME.target));
  tweenTo(tgt.clone().add(off), tgt);
}

// 巡游：逐个街区看 全景 → 在用的车间 → 中转站 → agent 广场
function tourStops() {
  const stops = [];
  for (const D of Object.values(world.districts)) {
    const o = D.group.position;
    stops.push({ pos: [o.x + CAMERA_HOME.pos[0], CAMERA_HOME.pos[1], o.z + CAMERA_HOME.pos[2]], tgt: [o.x + CAMERA_HOME.target[0], 0, o.z + CAMERA_HOME.target[2]] });
    D.slots.forEach((name, i) => {
      if (!name) return;
      const p = factoryPos(D, i);
      stops.push({ pos: [p.x + 16, 14, p.z + 18], tgt: [p.x + 2, 2, p.z] });
    });
    stops.push({ pos: [o.x - 2 + 14, 16, o.z + 18], tgt: [o.x - 2, 1, o.z] });
    const p = toWorld(D.plaza.agentPos, D);
    stops.push({ pos: [p.x + 12, 11, p.z + 16], tgt: [p.x, 2.4, p.z] });
  }
  return stops;
}
function startTour() {
  const stops = tourStops();
  tour = { i: 0, stops, timer: null };
  const go = () => {
    if (!tour) return;
    const s = tour.stops[tour.i % tour.stops.length];
    tweenTo(new THREE.Vector3(...s.pos), new THREE.Vector3(...s.tgt), 2.2);
    tour.i++;
    tour.timer = setTimeout(go, 6000);
  };
  go();
  hud.setToggle('tour', true);
}
function stopTour() {
  if (!tour) return;
  clearTimeout(tour.timer);
  tour = null;
  hud.setToggle('tour', false);
}
controls.addEventListener('start', () => { stopTour(); tween = null; });

// 鱼缸模式：隐藏所有面板，缓慢自转，适合挂在副屏
function setTank(on) {
  document.body.classList.toggle('tank', on);
  controls.autoRotate = on;
  controls.autoRotateSpeed = 0.4;
  document.getElementById('tank-hint').classList.toggle('show', on);
  if (on) setTimeout(() => document.getElementById('tank-hint').classList.remove('show'), 3000);
  hud.setToggle('tank', on);
  frame();
  if (on) home();
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (document.body.classList.contains('tank')) setTank(false); else hud.closeDrawer(); }
});
renderer.domElement.addEventListener('dblclick', () => { if (document.body.classList.contains('tank')) setTank(false); });

// ---------- 回放最近 1 小时 ----------
async function startReplay(speed = 30) {
  let events;
  try { events = await getJSON(`/api/events?since=${Date.now() - 3600e3}`); } catch { events = []; }
  events = events.filter((e) => e.kind === 'toolStart' || e.kind === 'toolEnd' || e.kind === 'turnEnd' || e.kind === 'sessionEnd');
  if (!events.length) { hud.toast({ kind: 'info', title: '没有可回放的事件', body: '最近 1 小时 agent 没调用过工具' }); return; }
  stopTour();
  parcels.clear();
  const t0 = events[0].ts, t1 = events[events.length - 1].ts;
  replay = { events, i: 0, clock: t0, t0, t1: Math.max(t1, t0 + 1), speed };
  parcels.timeScale = Math.min(6, speed / 10);
  hud.setToggle('replay', true);
  kick();
}
function stopReplay() {
  if (!replay) return;
  replay = null;
  parcels.clear();
  parcels.timeScale = 1;
  parcels.seeded = false;
  hud.replayBar(null);
  hud.setToggle('replay', false);
  if (snap) parcels.reconcile(snap.sessions);
}
function stepReplay(dt) {
  if (!replay) return;
  replay.clock += dt * 1000 * replay.speed;
  while (replay.i < replay.events.length && replay.events[replay.i].ts <= replay.clock) parcels.onEvent(replay.events[replay.i++]);
  hud.replayBar({ clock: replay.clock, progress: clamp((replay.clock - replay.t0) / (replay.t1 - replay.t0)), speed: replay.speed });
  if (replay.i >= replay.events.length && replay.clock > replay.t1 + 8000) stopReplay();
}
document.getElementById('replay').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !replay) return;
  if (b.id === 'replay-stop') stopReplay();
  else { replay.speed = +b.dataset.speed; parcels.timeScale = Math.min(6, replay.speed / 10); }
});

// ---------- 工具栏 ----------
async function onAction(act, value) {
  switch (act) {
    case 'home': stopTour(); home(); break;
    case 'rotL': orbit(-45); break;
    case 'rotR': orbit(45); break;
    case 'zoomIn': zoom(0.8); break;
    case 'zoomOut': zoom(1.25); break;
    case 'labels': prefs.labels = !prefs.labels; break;
    case 'tour': tour ? stopTour() : startTour(); break;
    case 'tank': setTank(!document.body.classList.contains('tank')); break;
    case 'weather': prefs.weather = WEATHERS[(WEATHERS.indexOf(prefs.weather) + 1) % WEATHERS.length]; applyEnv(); break;
    case 'time': prefs.time = TIMES[(TIMES.indexOf(prefs.time) + 1) % TIMES.length]; applyEnv(); break;
    case 'sound':
      prefs.sound = !prefs.sound;
      if (prefs.sound) { alerts.unlock(); alerts.sound = true; alerts.play('done'); }
      break;
    case 'notify':
      prefs.notify = !prefs.notify && (await alerts.requestNotify());
      if (!prefs.notify && Notification?.permission === 'denied') hud.toast({ kind: 'info', title: '通知被浏览器拦截了', body: '在地址栏左侧的网站设置里允许通知' });
      break;
    case 'replay': replay ? stopReplay() : startReplay(); break;
    case 'panel': prefs.panel = !(prefs.panel ?? true); break;
    case 'quality': prefs.hq = !prefs.hq; pr = MAX_PR(); renderer.setPixelRatio(pr); break;
    case 'showSleep': prefs.showSleep = value; if (snap) onState(snap); break;
  }
  syncPrefs();
}
function syncPrefs() {
  alerts.sound = prefs.sound;
  alerts.notify = prefs.notify;
  document.body.classList.toggle('nolabels', !prefs.labels);
  document.body.classList.toggle('nopanel', prefs.panel === false);
  hud.setToggle('labels', prefs.labels);
  hud.setToggle('sound', prefs.sound);
  hud.setToggle('notify', prefs.notify);
  hud.setToggle('panel', prefs.panel !== false);
  hud.setToggle('quality', prefs.hq, prefs.hq ? '画质：高' : '画质：省电');
  frame();
  savePrefs(prefs);
  kick();
}
syncPrefs();
addEventListener('pointerdown', () => { if (prefs.sound) alerts.unlock(); }, { once: true });

// ---------- 悬停与点击 ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
let hoverAt = 0;
function pick(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([...world.pickables, ...parcels.pickables()], true);
  for (const h of hits) {
    let o = h.object;
    if (!shown(o)) continue; // 射线不管可见性：跳过被 LOD 或裁剪藏起来的

    while (o && !o.userData.pick) o = o.parent;
    if (o) return o.userData.pick;
  }
  return null;
}
function shown(o) {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
function describe(p) {
  if (!p || !snap) return null;
  const now = snap.now;
  if (p.kind === 'factory') {
    const name = world.districts[p.agent].slots[p.slot];
    if (!name) return '<b>空闲车间</b><span>有新项目开工时会在这里亮灯</span>';
    const list = snap.sessions.filter((s) => s.agent === p.agent && s.project === name && (prefs.showSleep || s.status !== 'sleep'));
    return `<b>${esc(name)}</b>${list.slice(0, 5).map((s) => `<span style="color:${STATUS[s.status].color}">● </span><span>${esc(displayTitle(s))} · ${STATUS[s.status].text}</span>`).join('<br>')}<span>点击只看这个项目</span>`;
  }
  if (p.kind === 'agent') {
    const list = snap.sessions.filter((s) => s.agent === p.agent && ['working', 'waiting', 'stalled'].includes(s.status));
    return `<b>${esc(AGENT[p.agent].name)}</b><span>${list.length ? list.map((s) => `${esc(displayTitle(s))}${s.current ? ` → ${esc(s.current.label || s.current.tool)}` : ''}`).join('<br>') : '现在没有在跑的会话'}</span>`;
  }
  if (p.kind === 'parcel') {
    const s = snap.sessions.find((x) => x.id === p.sid);
    if (!s) return '<b>包裹</b><span>来自一个已结束的会话</span>';
    const c = s.current;
    return `<b>${esc(displayTitle(s))}</b><span>${esc(AGENT[s.agent]?.name || s.agent)} · ${esc(s.project)}${c ? `<br><i style="color:${CAT[c.cat]?.color}">■</i> ${esc(c.label || c.tool)} · ${fmtDur(now - c.since)}` : ''}<br>点击看详情</span>`;
  }
  if (p.kind === 'hub') {
    const n = [...parcels.items.values()].filter((x) => x.agent === p.agent && ['belt1', 'hub', 'belt2'].includes(x.state)).length;
    return `<b>${esc(AGENT[p.agent].name)} · 中转站</b><span>传送带上 ${n} 件 · 已发货 ${world.districts[p.agent].shipped} 托<br>点击看实时事件</span>`;
  }
  if (p.kind === 'district' && world.districts[p.agent].lod.visible) return `<b>${esc(AGENT[p.agent].name)}</b><span>${esc(actors[p.agent]?.summary || '')}<br>点击飞过去 · Shift+拖动挪位置</span>`;
  return null;
}
// Shift+拖动街区：捕获阶段先拦下，不让地图控件开始平移
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let drag = null;
function groundAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(floor, new THREE.Vector3());
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!e.shiftKey || e.button !== 0) return;
  const D = world.districts[pick(e.clientX, e.clientY)?.agent];
  const hit = D && groundAt(e.clientX, e.clientY);
  if (!hit) return;
  e.stopImmediatePropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  drag = { D, off: D.group.position.clone().sub(hit) };
  stopTour();
}, true);
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (drag) {
    const p = drag.D.group.position;
    spots[drag.D.agent] = [Math.round(p.x * 2) / 2, Math.round(p.z * 2) / 2];
    saveSpots();
    drag = null;
    return;
  }
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  down = null;
  const p = pick(e.clientX, e.clientY);
  if (!p) return;
  const name = p.kind === 'factory' && world.districts[p.agent].slots[p.slot];
  if (name) hud.setFilter({ project: name });
  else if (p.kind === 'agent') hud.setFilter({ agent: p.agent });
  else if (p.kind === 'parcel') hud.openDetail(p.sid);
  else if (p.kind === 'hub') hud.openTab('events');
  else if (p.kind === 'district' && world.districts[p.agent].lod.visible) flyTo(world.districts[p.agent].group.position, 75);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (drag) {
    const h = groundAt(e.clientX, e.clientY);
    // 跟着鼠标连续移动；会压到别的街区时停在原地
    const to = h && [h.x + drag.off.x, h.z + drag.off.z];
    if (to && !overlaps(to, drag.D)) drag.D.moveTo(...to);
    return;
  }
  if (e.buttons || performance.now() - hoverAt < 60) return;
  hoverAt = performance.now();
  const html = describe(pick(e.clientX, e.clientY));
  renderer.domElement.style.cursor = html ? 'pointer' : '';
  hud.tip(html ? e.clientX : null, e.clientY, html);
});
renderer.domElement.addEventListener('pointerleave', () => hud.tip(null));

// ---------- 主循环 ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  frame();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
  kick();
});

// ---------- 小地图 ----------
const map = document.getElementById('minimap');
const mctx = map.getContext('2d');
let mapView = null; // 世界坐标 → 小地图像素的换算
function drawMinimap() {
  const ds = Object.values(world.districts);
  const W = map.clientWidth, H = map.clientHeight;
  if (!ds.length || !W) return;
  const dpr = Math.min(devicePixelRatio, 2);
  if (map.width !== W * dpr) { map.width = W * dpr; map.height = H * dpr; }
  // 镜头看到的地面范围：屏幕四角投到地面
  const view = [[0, 0], [innerWidth, 0], [innerWidth, innerHeight], [0, innerHeight]].map(([x, y]) => groundAt(x, y) || null);
  const box = new THREE.Box3();
  for (const d of ds) box.expandByPoint(d.group.position);
  box.min.x -= DISTRICT.w / 2; box.max.x += DISTRICT.w / 2; box.min.z -= DISTRICT.d / 2; box.max.z += DISTRICT.d / 2;
  box.expandByPoint(controls.target);
  const k = Math.min((W - 12) / (box.max.x - box.min.x), (H - 12) / (box.max.z - box.min.z));
  const ox = W / 2 - ((box.min.x + box.max.x) / 2) * k, oz = H / 2 - ((box.min.z + box.max.z) / 2) * k;
  mapView = { k, ox, oz };
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, W, H);
  const w = DISTRICT.w * k, h = DISTRICT.d * k;
  mctx.fillStyle = '#a9d08a'; // 大地是无限的，底色铺满
  mctx.fillRect(0, 0, W, H);
  for (const d of ds) {
    const p = d.group.position;
    const x = p.x * k + ox - w / 2, y = p.z * k + oz - h / 2;
    mctx.fillStyle = '#93c46e';
    mctx.fillRect(x, y, w, h);
    mctx.strokeStyle = 'rgba(255,255,255,0.7)'; mctx.lineWidth = 1;
    mctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    mctx.fillStyle = d.accent;
    mctx.beginPath(); mctx.arc(x + w * 0.72, y + h / 2, Math.max(3, h * 0.13), 0, Math.PI * 2); mctx.fill();
    mctx.fillStyle = STATUS[actors[d.agent]?.state]?.color || '#9aa0a6';
    mctx.beginPath(); mctx.arc(x + 7, y + 7, 3.5, 0, Math.PI * 2); mctx.fill();
    mctx.fillStyle = 'rgba(31,38,51,0.85)';
    mctx.font = '600 10px system-ui, sans-serif';
    mctx.fillText(AGENT[d.agent]?.name || d.agent, x + 13, y + 11, w - 16);
  }
  if (view.every(Boolean)) {
    mctx.save();
    mctx.beginPath(); mctx.rect(0, 0, W, H); mctx.clip();
    mctx.strokeStyle = 'rgba(31,38,51,0.75)'; mctx.lineWidth = 1.5;
    mctx.beginPath();
    view.forEach((v, i) => mctx[i ? 'lineTo' : 'moveTo'](v.x * k + ox, v.z * k + oz));
    mctx.closePath(); mctx.stroke();
    mctx.restore();
  }
  mctx.fillStyle = '#1f2633';
  mctx.beginPath(); mctx.arc(controls.target.x * k + ox, controls.target.z * k + oz, 2.5, 0, Math.PI * 2); mctx.fill();
}
map.addEventListener('click', (e) => {
  if (!mapView) return;
  const r = map.getBoundingClientRect();
  stopTour();
  flyTo({ x: (e.clientX - r.left - mapView.ox) / mapView.k, z: (e.clientY - r.top - mapView.oz) / mapView.k });
});

// 按需渲染：操作镜头时跟着屏幕刷新；有包裹在路上、下雨雪、角色在跳、巡游鱼缸时 30 帧；
// 只剩烟、信标、角色干活的小动作、萤火虫时 12 帧；什么都不动就完全停下，等新数据、鼠标、天气变化再唤醒
// 掉帧时先降像素比、富余时再升回来
const MAX_PR = () => Math.min(devicePixelRatio, prefs.hq ? 2 : 1);
let pr = MAX_PR(), lastInput = -1e9, lastDraw = 0, lastDrop = -1e9;
const perf = { n: 0, ms: 0 };
const lastCam = new THREE.Vector3(), lastTgt = new THREE.Vector3();
for (const type of ['pointerdown', 'pointermove', 'wheel']) renderer.domElement.addEventListener(type, () => { lastInput = performance.now(); kick(); }, { passive: true });
controls.addEventListener('change', kick);
function adapt(now) {
  if (now - lastDraw > 200) return; // 刚从后台切回来，不算
  perf.n++; perf.ms += now - lastDraw;
  if (perf.ms < 2000) return;
  const fps = (perf.n * 1000) / perf.ms;
  perf.n = perf.ms = 0;
  let next = pr;
  if (fps < 45 && pr > 1) { next = Math.max(1, pr - 0.25); lastDrop = now; }
  else if (fps > 58 && pr < MAX_PR() && now - lastDrop > 30e3) next = Math.min(MAX_PR(), pr + 0.25);
  if (next !== pr) { pr = next; renderer.setPixelRatio(pr); }
}

const clock = new THREE.Clock();
let lastMap = 0;
function kick() {
  if (raf) return;
  clearTimeout(timer); timer = 0;
  raf = requestAnimationFrame(loop);
}
function loop(now) {
  raf = 0;
  const hot = now - lastInput < 300 || tween || drag || !camera.position.equals(lastCam) || !controls.target.equals(lastTgt);
  if (hot) adapt(now);
  lastDraw = now;
  const dt = Math.min(0.1, clock.getDelta());
  const t = clock.elapsedTime;
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / tween.dur);
    const k = smooth(0, 1, tween.t);
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    controls.target.lerpVectors(tween.t0, tween.t1, k);
    if (tween.t >= 1) tween = null;
  }
  lastCam.copy(camera.position);
  lastTgt.copy(controls.target);
  controls.update(); // 阻尼还在滑动时会改相机，下一帧 hot 仍为真
  stepReplay(dt);
  world.update(dt, t, camera, controls.target);
  for (const a of Object.values(actors)) if (shown(a.root)) a.update(dt, t, camera);
  parcels.update(dt, t);
  renderer.render(world.scene, camera);
  labels.render(world.scene, camera);
  if (now - lastMap > 250) { lastMap = now; drawMinimap(); }

  const tank = document.body.classList.contains('tank');
  const fast = tour || replay || tank || world.rain.visible || world.snow.visible || world.flash > 0 || parcels.moving() || Object.values(actors).some((a) => a.busy());
  // 萤火虫只在别的东西需要重画时顺带动，夜里没动静也能完全停帧
  const ambient = world.envMoving || Object.values(actors).some((a) => !a.calm())
    || Object.values(world.districts).some((d) => d.factories.some((f) => f.status === 'working' || f.status === 'waiting'));
  if (hot) kick();
  else if (fast) timer = setTimeout(kick, 33);
  else if (ambient) timer = setTimeout(kick, 83);
  else timer = setTimeout(drawMinimap, 300); // 停下前把小地图补成最终位置
}
setInterval(() => { if (!snap) hud.setClock(Date.now()); }, 1000);
kick();
