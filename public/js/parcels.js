// 包裹物流：每次工具调用是一个包裹，工厂 → 传送带 → 中转站 → Agent 工作台 → 托盘（失败进次品箱）
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { HUB, BELT_Y } from './layout.js';
import { CAT } from './util.js';

const SPEED = 6;
const MAX_PARCELS = 160;
const PALLET_MAX = 36;
const BENCH_MAX = 18;
const STALE_MS = 10 * 60e3;
const BOX = 0.7;

const boxGeo = new RoundedBoxGeometry(BOX, BOX, BOX, 2, 0.1);
const tapeGeo = new THREE.BoxGeometry(0.2, 0.02, BOX + 0.02);
const tapeMat = new THREE.MeshLambertMaterial({ color: '#f3e7cc' });
const ERROR_COLOR = '#d64541';

export class ParcelSystem {
  constructor(world, actors) {
    this.world = world;
    this.actors = actors;
    this.items = new Map();
    this.pool = [];
    this.skipped = new Set();
    this.serial = 0;
    this.activeAgents = new Set();
    this.timeScale = 1;
    this.onShip = null;
    this.seeded = false;
  }

  // ---------- 包裹对象 ----------
  make(cat, sub, D) {
    let m = this.pool.pop();
    if (!m) {
      m = new THREE.Mesh(boxGeo, new THREE.MeshLambertMaterial({ emissive: '#000000' }));
      m.receiveShadow = true; // 包裹一直在动，不投影（阴影贴图不实时重画）
      m.add(new THREE.Mesh(tapeGeo, tapeMat));
      m.children[0].position.y = BOX / 2;
    }
    const c = CAT[cat]?.color || CAT.other.color;
    m.material.color.set(c);
    m.material.emissive.set(c);
    m.material.emissiveIntensity = 0;
    m.material.opacity = 1;
    m.material.transparent = false;
    m.scale.setScalar(sub ? 0.7 : 1);
    m.visible = true;
    D.full.add(m); // 包裹挂在街区下，坐标都是街区局部坐标
    return m;
  }

  release(key) {
    const p = this.items.get(key);
    if (!p) return;
    this.items.delete(key);
    p.mesh.removeFromParent();
    this.pool.push(p.mesh);
    const D = this.world.districts[p.agent];
    for (const list of [D.bench, D.pallet]) {
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
    }
  }

  spawn(key, ev, { at = 'belt1', done = false, isError = false } = {}) {
    if (this.items.has(key)) return this.items.get(key);
    if (this.items.size >= MAX_PARCELS) { this.skipped.add(key); return null; }
    const agent = ev.agent;
    const D = this.world.districts[agent];
    if (!D) return null;
    const slot = D.slotOf(ev.project);
    const s = ev.sub ? 0.7 : 1;
    const p = { key, sid: ev.sid, agent, slot, s, cat: ev.cat || 'other', done, isError, state: at, u: 0, t: 0, born: Date.now(), doneAt: done ? performance.now() : 0, mesh: this.make(ev.cat, ev.sub, D) };
    p.mesh.userData.pick = { kind: 'parcel', sid: ev.sid };
    this.items.set(key, p);
    if (isError) this.paintError(p);
    if (at === 'bench') this.toBench(p, true);
    else if (at === 'reject') this.hop(p, D.belt2.curve.getPointAt(1).setY(this.y(p)), this.rejectSpot(p), 'reject', 0.7);
    else this.place(p);
    return p;
  }

  paintError(p) {
    p.isError = true;
    p.mesh.material.color.set(ERROR_COLOR);
    p.mesh.material.emissive.set(ERROR_COLOR);
  }

  y(p) { return BELT_Y + BOX / 2 * p.s; }

  // ---------- 事件入口 ----------
  onEvent(ev) {
    if (ev.kind === 'toolStart') {
      if (ev.toolId) this.spawn(ev.toolId, ev);
    } else if (ev.kind === 'toolEnd') {
      if (ev.tool === 'error' && !ev.toolId) {
        this.spawn(`err:${++this.serial}`, ev, { at: 'reject', done: true, isError: true });
        this.actors[ev.agent]?.flinch();
        return;
      }
      if (this.skipped.delete(ev.toolId)) return;
      let p = this.items.get(ev.toolId) || this.items.get(`cur:${ev.sid}`);
      if (!p) p = this.spawn(ev.toolId || `end:${++this.serial}`, ev);
      if (p) this.finish(p, ev.isError);
    } else if (ev.kind === 'turnEnd' || ev.kind === 'sessionEnd') {
      for (const p of this.items.values()) if (p.sid === ev.sid && !p.done && (ev.kind === 'sessionEnd' || ev.reason !== 'done' || p.s === 1)) this.finish(p, false);
    }
  }

  finish(p, isError) {
    if (p.done) return;
    p.done = true;
    p.doneAt = performance.now();
    if (isError) this.paintError(p);
  }

  /** 用快照兜底：会话已没有进行中的工具时，它名下没完成的包裹都算完成 */
  reconcile(sessions) {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    if (!this.seeded) {
      this.seeded = true;
      for (const s of sessions) {
        if (!s.current || (s.status !== 'working' && s.status !== 'waiting')) continue;
        this.spawn(`cur:${s.id}`, { sid: s.id, agent: s.agent, project: s.project, cat: s.current.cat, sub: false }, { at: 'bench' });
      }
    }
    const now = Date.now();
    for (const p of this.items.values()) {
      if (p.done) continue;
      const s = byId.get(p.sid);
      if (!s || !s.current || now - p.born > STALE_MS) this.finish(p, false);
    }
  }

  clear() {
    for (const k of [...this.items.keys()]) this.release(k);
    this.skipped.clear();
    this.seeded = true;
  }

  pickables() { return [...this.items.values()].map((p) => p.mesh); }

  /** 有包裹在路上（传送带、跳跃、发货、次品）；静止在工作台和托盘上的不算 */
  moving() { for (const p of this.items.values()) if (p.state !== 'bench' && p.state !== 'pallet') return true; return false; }

  // ---------- 位置 ----------
  benchSpot(p, i) {
    const P = this.world.districts[p.agent].plaza;
    const layer = Math.floor(i / 6), k = i % 6;
    const a = (k % 2 ? 0.37 : -0.37), c = [-0.92, 0, 0.92][Math.floor(k / 2)];
    return P.bench.clone().addScaledVector(P.dir, a).addScaledVector(P.perp, c).setY(P.benchTop + BOX / 2 * p.s + layer * 0.72);
  }

  palletSpot(p, i) {
    const P = this.world.districts[p.agent].plaza;
    const layer = Math.floor(i / 9), k = i % 9;
    return P.pallet.clone().addScaledVector(P.dir, (k % 3 - 1) * 0.82).addScaledVector(P.perp, (Math.floor(k / 3) - 1) * 0.82).setY(P.palletTop + BOX / 2 + layer * 0.72);
  }

  rejectSpot(p) {
    const P = this.world.districts[p.agent].plaza;
    return P.reject.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.7, 0, (Math.random() - 0.5) * 0.7)).setY(P.reject.y + 0.12 + BOX / 2 * p.s);
  }

  hop(p, from, to, next, dur = 0.5, height = 1.4) {
    p.state = 'hop';
    p.from = from.clone();
    p.to = to;
    p.next = next;
    p.t = 0;
    p.dur = dur;
    p.height = height;
  }

  toBench(p, instant = false) {
    const list = this.world.districts[p.agent].bench;
    if (list.length >= BENCH_MAX) this.finish(list.find((q) => !q.done) || list[0], false);
    list.push(p);
    p.benchAt = performance.now();
    const spot = this.benchSpot(p, list.length - 1);
    if (instant) { p.state = 'bench'; p.mesh.position.copy(spot); return; }
    this.hop(p, p.mesh.position, spot, 'bench', 0.5, 1.2);
  }

  /** 工作台上的包裹按顺序重新排位（有包裹离开后补位） */
  relayoutBench(agent) {
    this.world.districts[agent].bench.forEach((q, i) => {
      if (q.state === 'bench') q.mesh.position.copy(this.benchSpot(q, i));
      else if (q.state === 'hop' && q.next === 'bench') q.to = this.benchSpot(q, i);
    });
  }

  leaveBench(p) {
    const list = this.world.districts[p.agent].bench;
    list.splice(list.indexOf(p), 1);
    this.relayoutBench(p.agent);
    if (p.isError) {
      this.hop(p, p.mesh.position, this.rejectSpot(p), 'reject', 0.7, 1.8);
      this.actors[p.agent]?.flinch();
      return;
    }
    const pal = this.world.districts[p.agent].pallet;
    if (pal.length >= PALLET_MAX) this.ship(p.agent);
    pal.push(p);
    this.hop(p, p.mesh.position, this.palletSpot(p, pal.length - 1), 'pallet', 0.6, 1.6);
  }

  ship(agent) {
    const D = this.world.districts[agent];
    const pal = D.pallet.splice(0);
    for (const q of pal) { q.state = 'ship'; q.t = 0; q.from = q.mesh.position.clone(); }
    D.shipped++;
    this.onShip?.(agent, D.shipped);
  }

  place(p) {
    const w = this.world.districts[p.agent];
    if (p.state === 'belt1') {
      const b = w.belts1[p.slot];
      const pt = b.curve.getPointAt(Math.min(1, p.u));
      const tan = b.curve.getTangentAt(Math.min(1, p.u));
      p.mesh.position.set(pt.x, pt.y + BOX / 2 * p.s, pt.z);
      p.mesh.rotation.set(0, -Math.atan2(tan.z, tan.x), 0);
    } else if (p.state === 'hub') {
      const a = p.a0 + p.da * p.u;
      const rad = HUB.r + 0.15 + (HUB.r - 1.3 - HUB.r - 0.15) * Math.sin(Math.PI * p.u);
      p.mesh.position.set(HUB.x + rad * Math.cos(a), this.y(p), HUB.z + rad * Math.sin(a));
      p.mesh.rotation.set(0, -a, 0);
    } else if (p.state === 'belt2') {
      const b = w.belt2;
      const pt = b.curve.getPointAt(Math.min(1, p.u));
      const tan = b.curve.getTangentAt(Math.min(1, p.u));
      p.mesh.position.set(pt.x, pt.y + BOX / 2 * p.s, pt.z);
      p.mesh.rotation.set(0, -Math.atan2(tan.z, tan.x), 0);
    }
  }

  // ---------- 每帧 ----------
  update(dt, t) {
    const ds = this.world.districts;
    const k = this.items.size > 60 ? 2.5 : 1;
    const v = SPEED * k * this.timeScale;
    const now = performance.now();
    const busy = new Set();
    const transit = {};
    for (const p of [...this.items.values()]) {
      const m = p.mesh;
      const w = ds[p.agent];
      if (p.state === 'belt1') {
        busy.add(`${p.agent}:f${p.slot}`);
        transit[p.agent] = (transit[p.agent] || 0) + 1;
        p.u += (v * dt) / w.belts1[p.slot].len;
        if (p.u >= 1) {
          const a0 = w.belts1[p.slot].angle, a1 = w.belt2.angle;
          p.state = 'hub'; p.u = 0; p.a0 = a0;
          p.da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
          p.hubLen = Math.max(1, Math.abs(p.da) * (HUB.r - 0.6));
        }
        this.place(p);
      } else if (p.state === 'hub') {
        transit[p.agent] = (transit[p.agent] || 0) + 1;
        p.u += (v * dt) / p.hubLen;
        if (p.u >= 1) { p.state = 'belt2'; p.u = 0; }
        this.place(p);
      } else if (p.state === 'belt2') {
        busy.add(p.agent);
        transit[p.agent] = (transit[p.agent] || 0) + 1;
        p.u += (v * dt) / w.belt2.len;
        if (p.u >= 1) { p.u = 1; this.place(p); this.toBench(p); }
        else this.place(p);
      } else if (p.state === 'hop') {
        p.t = Math.min(1, p.t + (dt * this.timeScale) / p.dur);
        m.position.lerpVectors(p.from, p.to, p.t);
        m.position.y += Math.sin(Math.PI * p.t) * p.height;
        m.rotation.y += dt * 4;
        if (p.t >= 1) {
          p.state = p.next;
          m.position.copy(p.to);
          if (p.next === 'bench') this.actors[p.agent]?.hop();
          if (p.next === 'reject') p.t = 0;
        }
      } else if (p.state === 'bench') {
        // 进行中的包裹发一点光；完成后至少停 0.5 秒再搬去托盘
        m.material.emissiveIntensity = p.done ? 0 : 0.25 + 0.2 * Math.sin(t * 5 + p.slot);
        if (p.done && now - Math.max(p.doneAt, p.benchAt) > 500 / this.timeScale) { m.material.emissiveIntensity = 0; this.leaveBench(p); }
      } else if (p.state === 'reject') {
        p.t += dt;
        if (p.t > 2.5) {
          m.material.transparent = true;
          m.material.opacity = Math.max(0, 1 - (p.t - 2.5) / 0.8);
          if (p.t > 3.3) this.release(p.key);
        }
      } else if (p.state === 'ship') {
        p.t += dt / 1.5;
        m.position.set(p.from.x, p.from.y + p.t * p.t * 6, p.from.z);
        m.scale.setScalar(p.s * Math.max(0.01, 1 - p.t));
        if (p.t >= 1) this.release(p.key);
      }
      if (p.state === 'hop' && !p.done && p.next === 'bench') m.material.emissiveIntensity = 0.3;
    }
    for (const [a, w] of Object.entries(ds)) {
      for (let i = 0; i < w.belts1.length; i++) w.setBeltSpeed(`f${i}`, busy.has(`${a}:f${i}`) ? v : w.activeSlots.has(i) ? 1.5 : 0);
      const active = this.activeAgents.has(a), n = transit[a] || 0;
      w.setBeltSpeed('out', busy.has(a) ? v : active ? 1.5 : 0);
      w.hubSpin = n ? 0.6 : active ? 0.2 : 0.05;
      if (n !== w.lastTransit) { w.lastTransit = n; w.setHubCount(n); }
    }
  }
}
