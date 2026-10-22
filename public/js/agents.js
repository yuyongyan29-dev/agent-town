// Agent 角色：Claude Code 是陶土色小螃蟹，Codex 是紫色小云朵，其他 agent 是主题色小机器人
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { AGENT } from './util.js';

const std = (color, { roughness, metalness, ...o } = {}) => new THREE.MeshLambertMaterial({ color, ...o });

function add(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

function label(cls, html) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  return { el, obj: new CSS2DObject(el) };
}

/** Claude 的星芒标志：一圈白色细尖 */
function starburst(n = 10, r = 0.42) {
  const g = new THREE.Group();
  const mat = std('#fff8f0', { roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.15 });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const len = i % 2 ? r * 0.75 : r;
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.06, len, 6), mat);
    c.position.set(Math.cos(a) * len / 2, Math.sin(a) * len / 2, 0);
    c.rotation.z = a - Math.PI / 2;
    g.add(c);
  }
  g.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat));
  return g;
}

function buildClaude(root) {
  const body = new THREE.Group();
  const shell = std('#d97757', { roughness: 0.55 });
  const dark = std('#b85c3f');
  add(body, new RoundedBoxGeometry(2.2, 1.35, 1.6, 4, 0.5), shell, 0, 1.05, 0);
  const burst = starburst();
  burst.position.set(0, 1.15, 0.82);
  body.add(burst);
  const eyes = [];
  const eyeMat = std('#2a2220', { roughness: 0.3 });
  for (const x of [-0.5, 0.5]) {
    add(body, new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), dark, x, 1.85, 0.25);
    eyes.push(add(body, new THREE.SphereGeometry(0.17, 14, 10), eyeMat, x, 2.08, 0.25));
  }
  const legs = [];
  for (const side of [-1, 1]) for (const k of [-0.5, 0, 0.5]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.95, 0.65, k);
    const leg = add(pivot, new THREE.CylinderGeometry(0.08, 0.06, 0.7, 6), dark, side * 0.2, -0.3, 0);
    leg.rotation.z = side * 0.6;
    body.add(pivot);
    legs.push(pivot);
  }
  const claws = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 1.15, 1.05, 0.5);
    add(arm, new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8), dark, side * 0.2, 0, 0.15).rotation.set(Math.PI / 2.6, 0, side * 0.6);
    const claw = add(arm, new THREE.SphereGeometry(0.3, 14, 10), shell, side * 0.42, 0.05, 0.45);
    claw.scale.set(1, 0.8, 1.2);
    add(arm, new THREE.BoxGeometry(0.08, 0.1, 0.32), dark, side * 0.42, 0.05, 0.78);
    body.add(arm);
    claws.push(arm);
  }
  root.add(body);
  return { body, eyes, legs, claws, spin: burst };
}

function buildCodex(root) {
  const body = new THREE.Group();
  const cloud = std('#8f8dff', { roughness: 0.45 });
  const light = std('#b7b5ff', { roughness: 0.45 });
  for (const [x, y, z, r, m] of [[0, 1.15, 0, 0.9, cloud], [-0.75, 0.95, 0.05, 0.62, light], [0.75, 0.95, 0.05, 0.66, light], [-0.35, 1.65, -0.05, 0.6, cloud], [0.4, 1.7, -0.1, 0.55, light], [0, 0.8, 0.3, 0.6, cloud]]) {
    add(body, new THREE.SphereGeometry(r, 24, 16), m, x, y, z);
  }
  // 正面的 ">_" 屏幕
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = '#23224a'; g.beginPath(); g.roundRect(8, 8, 240, 144, 34); g.fill();
  g.fillStyle = '#ffffff'; g.font = 'bold 96px Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('>_', 128, 84);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.25 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.66), screenMat);
  screen.position.set(0, 1.2, 0.93);
  body.add(screen);
  const eyes = [screen];
  const legs = [];
  for (const x of [-0.42, 0.42]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.42, 0.05);
    const f = add(pivot, new THREE.SphereGeometry(0.24, 14, 10), std('#5f5ccf'), 0, -0.14, 0.08);
    f.scale.set(1, 0.6, 1.3);
    body.add(pivot);
    legs.push(pivot);
  }
  // 小天线
  const ant = new THREE.Group();
  ant.position.set(0.15, 2.15, -0.1);
  add(ant, new THREE.CylinderGeometry(0.035, 0.035, 0.4, 6), std('#5f5ccf'), 0, 0.2, 0);
  add(ant, new THREE.SphereGeometry(0.1, 12, 8), std('#ffd36b', { emissive: '#ffb800', emissiveIntensity: 0.6 }), 0, 0.45, 0);
  body.add(ant);
  root.add(body);
  return { body, eyes, legs, claws: [], spin: ant };
}

function buildBot(root, color) {
  const body = new THREE.Group();
  const shell = std(color, { roughness: 0.5 });
  const dark = std(new THREE.Color(color).multiplyScalar(0.7));
  add(body, new RoundedBoxGeometry(1.7, 1.5, 1.4, 4, 0.35), shell, 0, 1.2, 0);
  add(body, new RoundedBoxGeometry(1.3, 0.8, 0.1, 3, 0.05), std('#23243a', { roughness: 0.3 }), 0, 1.3, 0.68);
  const eyeMat = std('#9ff5e6', { emissive: '#6ff0d8', emissiveIntensity: 0.8 });
  const eyes = [-0.3, 0.3].map((x) => add(body, new THREE.SphereGeometry(0.12, 12, 8), eyeMat, x, 1.32, 0.74));
  const legs = [];
  for (const x of [-0.45, 0.45]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.48, 0);
    add(pivot, new RoundedBoxGeometry(0.4, 0.4, 0.55, 2, 0.12), dark, 0, -0.18, 0.05);
    body.add(pivot);
    legs.push(pivot);
  }
  const claws = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.95, 1.35, 0);
    add(arm, new THREE.CylinderGeometry(0.08, 0.08, 0.6, 8), dark, 0, -0.3, 0);
    add(arm, new THREE.SphereGeometry(0.16, 12, 8), shell, 0, -0.62, 0);
    body.add(arm);
    claws.push(arm);
  }
  const ant = new THREE.Group();
  ant.position.set(0, 1.95, 0);
  add(ant, new THREE.CylinderGeometry(0.035, 0.035, 0.4, 6), dark, 0, 0.2, 0);
  add(ant, new THREE.SphereGeometry(0.1, 12, 8), std('#ffd36b', { emissive: '#ffb800', emissiveIntensity: 0.6 }), 0, 0.45, 0);
  body.add(ant);
  root.add(body);
  return { body, eyes, legs, claws, spin: ant };
}

export class AgentActor {
  constructor(world, agent) {
    this.agent = agent;
    this.world = world;
    this.district = world.districts[agent];
    const info = this.district.plaza;
    this.info = info;
    this.accent = AGENT[agent].color;
    this.root = new THREE.Group();
    this.root.position.copy(info.agentPos);
    this.root.userData.pick = { kind: 'agent', agent };
    this.district.full.add(this.root); // 角色、彩纸、小分身都用街区局部坐标
    world.pickables.push(this.root);

    const ped = new THREE.Group();
    add(ped, new THREE.CylinderGeometry(1.7, 1.85, 0.28, 40), std('#f7f2ea'), 0, 0.14, 0);
    this.ringMat = new THREE.MeshLambertMaterial({ color: this.accent, emissive: this.accent, emissiveIntensity: 0.4 });
    add(ped, new THREE.TorusGeometry(1.75, 0.07, 8, 64).rotateX(Math.PI / 2), this.ringMat, 0, 0.29, 0).castShadow = false;
    this.root.add(ped);

    this.model = new THREE.Group();
    this.model.position.y = 0.28;
    this.root.add(this.model);
    this.parts = agent === 'claude' ? buildClaude(this.model) : agent === 'codex' ? buildCodex(this.model) : buildBot(this.model, this.accent);

    const name = label('label pill agent-pill', `<i style="background:${this.accent}"></i><b></b><span></span>`);
    name.el.querySelector('b').textContent = AGENT[agent].name;
    name.obj.position.set(0, 3.6, 0);
    this.root.add(name.obj);
    this.nameEl = name.el;
    name.el.addEventListener('click', () => this.onClick?.(agent));

    const bubble = label('bubble', '!');
    bubble.obj.position.set(0.9, 3.0, 0);
    bubble.obj.visible = false; // CSS2DRenderer 每帧会改 display，显隐只能用 visible
    this.root.add(bubble.obj);
    this.bubble = bubble;

    const zzz = label('zzz', '<span>z</span><span>z</span><span>Z</span>');
    zzz.obj.position.set(0.7, 2.6, 0);
    zzz.obj.visible = false;
    this.root.add(zzz.obj);
    this.zzz = zzz;

    // 彩纸
    const N = 80;
    this.confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.12, 0.08), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), N);
    this.confetti.count = 0;
    this.confetti.frustumCulled = false;
    this.bits = [];
    const palette = ['#ff8a65', '#ffd54f', '#81c784', '#64b5f6', '#ba68c8', '#ffffff'];
    for (let i = 0; i < N; i++) this.confetti.setColorAt(i, new THREE.Color(palette[i % palette.length]));
    this.district.full.add(this.confetti);

    // 子代理小分身
    this.minis = [];
    this.miniGroup = new THREE.Group();
    this.miniGroup.position.copy(info.center);
    this.district.full.add(this.miniGroup);

    this.state = 'idle';
    this.counts = {};
    this.hopT = 1;
    this.spinT = 1;
    this.shakeT = 1;
    this.face = 0;
  }

  /** 汇总该 agent 名下所有会话的状态 */
  setSessions(list) {
    const c = { working: 0, waiting: 0, stalled: 0, done: 0, idle: 0, sleep: 0 };
    let subs = 0;
    for (const s of list) { c[s.status] = (c[s.status] || 0) + 1; subs += s.subagents?.length || 0; }
    const awake = list.length - c.sleep;
    const st = c.waiting ? 'waiting' : c.working || c.stalled ? 'working' : c.done ? 'done' : awake ? 'idle' : 'sleep';
    this.state = st;
    this.counts = c;
    const parts = [];
    if (c.working + c.stalled) parts.push(`${c.working + c.stalled} 运行中`);
    if (c.waiting) parts.push(`<em>${c.waiting} 等你</em>`);
    if (!parts.length) parts.push(awake ? '待命' : '休眠');
    this.nameEl.querySelector('span').innerHTML = ' · ' + parts.join(' · ');
    this.summary = parts.join(' · ').replace(/<[^>]+>/g, '');
    this.bubble.obj.visible = !!c.waiting;
    this.bubble.el.textContent = c.waiting > 1 ? `!${c.waiting}` : '!';
    this.zzz.obj.visible = st === 'sleep';
    this.setMinis(Math.min(6, subs));
  }

  setMinis(n) {
    while (this.minis.length < n) {
      const g = new THREE.Group();
      const mat = std(this.accent, { roughness: 0.5 });
      if (this.agent === 'claude') add(g, new RoundedBoxGeometry(0.6, 0.4, 0.45, 2, 0.15), mat, 0, 0.3, 0);
      else { add(g, new THREE.SphereGeometry(0.3, 14, 10), mat, 0, 0.32, 0); add(g, new THREE.SphereGeometry(0.2, 12, 8), mat, 0.25, 0.25, 0); }
      add(g, new THREE.SphereGeometry(0.05, 8, 6), std('#222'), -0.1, 0.4, 0.22);
      add(g, new THREE.SphereGeometry(0.05, 8, 6), std('#222'), 0.1, 0.4, 0.22);
      g.traverse((o) => (o.castShadow = false)); // 一直在绕圈，阴影贴图不实时重画
      g.userData.phase = this.minis.length / 6;
      this.miniGroup.add(g);
      this.minis.push(g);
    }
    while (this.minis.length > n) this.miniGroup.remove(this.minis.pop());
  }

  hop() { if (this.hopT >= 1) this.hopT = 0; }
  celebrate() {
    this.spinT = 0;
    const base = this.root.position;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 3;
      this.bits.push({ p: new THREE.Vector3(base.x, base.y + 2.4, base.z), v: new THREE.Vector3(Math.cos(a) * v * 0.5, 4 + Math.random() * 3, Math.sin(a) * v * 0.5), r: Math.random() * 6, life: 1.6 + Math.random() * 0.6 });
    }
    this.bits.splice(0, Math.max(0, this.bits.length - 80));
  }
  flinch() { this.shakeT = 0; }

  update(dt, t, camera) {
    const P = this.parts, st = this.state;
    // 朝向镜头（模型正面是 +z）
    const o = this.district.group.position;
    const want = Math.atan2(camera.position.x - o.x - this.root.position.x, camera.position.z - o.z - this.root.position.z);
    let d = want - this.face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.face += d * Math.min(1, dt * 3);

    let y = 0, rotY = 0, rotZ = 0;
    const working = st === 'working';
    if (working) y = Math.abs(Math.sin(t * 7)) * 0.12;
    else if (st === 'waiting') y = Math.abs(Math.sin(t * 3)) * 0.2;
    else if (st === 'sleep') y = -0.12 + Math.sin(t * 1.2) * 0.03;
    else y = Math.sin(t * 1.6) * 0.04;

    if (this.hopT < 1) { this.hopT = Math.min(1, this.hopT + dt / 0.45); y += Math.sin(this.hopT * Math.PI) * 0.6; }
    if (this.spinT < 1) { this.spinT = Math.min(1, this.spinT + dt / 1.1); rotY = this.spinT * Math.PI * 2; y += Math.sin(this.spinT * Math.PI) * 0.9; }
    if (this.shakeT < 1) { this.shakeT = Math.min(1, this.shakeT + dt / 0.6); rotZ = Math.sin(this.shakeT * 40) * 0.15 * (1 - this.shakeT); }
    this.model.position.y = 0.28 + y;
    this.model.rotation.set(0, this.face + rotY, rotZ);

    P.legs.forEach((l, i) => { l.rotation.x = working ? Math.sin(t * 14 + i * 1.7) * 0.5 : 0; });
    P.claws.forEach((c, i) => { c.rotation.x = working ? Math.sin(t * 9 + i * Math.PI) * 0.35 : st === 'waiting' ? -0.6 + Math.sin(t * 5) * 0.3 : 0; });
    if (P.spin) {
      if (this.agent === 'claude') P.spin.rotation.z += dt * (working ? 3 : 0.4);
      else P.spin.rotation.z = working ? Math.sin(t * 8) * 0.3 : 0;
    }
    const blink = (t % 4.3) < 0.12;
    for (const e of P.eyes) e.scale.y = st === 'sleep' ? 0.15 : blink ? 0.2 : 1;
    this.ringMat.emissiveIntensity = st === 'waiting' ? 1 + Math.sin(t * 6) : working ? 0.8 + Math.sin(t * 3) * 0.4 : 0.3;
    this.ringMat.emissive.set(st === 'waiting' ? '#f08c2e' : this.accent);

    // 子代理绕广场转圈
    this.minis.forEach((m, i) => {
      const a = t * 0.5 + m.userData.phase * Math.PI * 2;
      const r = this.info.center.distanceTo(this.root.position) + 0.2;
      m.position.set(Math.cos(a) * (r * 0.5 + 2.4), Math.abs(Math.sin(t * 8 + i)) * 0.15, Math.sin(a) * (r * 0.5 + 2.4));
      m.rotation.y = -a;
    });

    // 彩纸
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1);
    this.bits = this.bits.filter((b) => (b.life -= dt) > 0);
    this.bits.forEach((b, i) => {
      b.v.y -= 9 * dt; b.v.multiplyScalar(1 - dt * 0.8);
      b.p.addScaledVector(b.v, dt);
      if (b.p.y < 0.55) { b.p.y = 0.55; b.v.set(0, 0, 0); }
      b.r += dt * 8;
      M.compose(b.p, q.setFromEuler(e.set(b.r, b.r * 0.7, 0)), s);
      this.confetti.setMatrixAt(i, M);
    });
    this.confetti.count = this.bits.length;
    this.confetti.instanceMatrix.needsUpdate = true;
  }
}
