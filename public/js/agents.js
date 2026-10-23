// Agent 角色：Claude Code 是陶土色小螃蟹，Codex 是紫色小云朵，其他 agent 是主题色小机器人
// 模型由 Blender 烘焙（public/assets/props.glb），这里只做整体的起伏、跳、转圈、抖动
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { AGENT } from './util.js';
import { MODELS, bakedMat } from './world.js';

function label(cls, html) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  return { el, obj: new CSS2DObject(el) };
}

const kindOf = (agent) => (agent === 'claude' || agent === 'codex' ? agent : 'bot');
/** 烘焙好的角色模型；机器人是浅灰的，按主题色上色 */
function figure(name, agent, color) {
  const m = MODELS[`${name}-${kindOf(agent)}`].clone();
  if (kindOf(agent) === 'bot') m.material = bakedMat(m.material.map, color);
  return m;
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

    this.root.add(MODELS.ped.clone());
    // 底座上的主题色光圈：等你处理时橙色闪，干活时呼吸
    this.ringMat = new THREE.MeshBasicMaterial({ color: this.accent, toneMapped: false });
    this.root.add(new THREE.Mesh(new THREE.TorusGeometry(1.76, 0.06, 8, 64).rotateX(Math.PI / 2).translate(0, 0.3, 0), this.ringMat));

    this.model = new THREE.Group();
    this.root.add(this.model);
    this.model.add(figure('agent', agent, this.accent));
    this.parts = { legs: [], claws: [], eyes: [], spin: null };

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
      g.add(figure('mini', this.agent, this.accent));
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
  /** 有一次性动作（跳、转圈、抖、彩纸、转身）在播：要按较高帧率继续画 */
  busy() { return this.hopT < 1 || this.spinT < 1 || this.shakeT < 1 || this.bits.length > 0 || this.turning; }
  /** 完全静止：没在干活、没在等你、没有子代理在转、没有动作在播。静止时不需要重画 */
  calm() { return this.state !== 'working' && this.state !== 'waiting' && !this.minis.length && !this.busy(); }

  update(dt, t, camera) {
    const P = this.parts, st = this.state;
    // 朝向镜头（模型正面是 +z）
    const o = this.district.group.position;
    const want = Math.atan2(camera.position.x - o.x - this.root.position.x, camera.position.z - o.z - this.root.position.z);
    let d = want - this.face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.face += d * Math.min(1, dt * 3);
    this.turning = Math.abs(d) > 0.01;

    let y = 0, rotY = 0, rotZ = 0;
    const working = st === 'working';
    if (working) y = Math.abs(Math.sin(t * 7)) * 0.12;
    else if (st === 'waiting') y = Math.abs(Math.sin(t * 3)) * 0.2;
    else if (st === 'sleep') y = -0.12; // 安静时不做呼吸起伏，画面才能完全停下

    if (this.hopT < 1) { this.hopT = Math.min(1, this.hopT + dt / 0.45); y += Math.sin(this.hopT * Math.PI) * 0.6; }
    if (this.spinT < 1) { this.spinT = Math.min(1, this.spinT + dt / 1.1); rotY = this.spinT * Math.PI * 2; y += Math.sin(this.spinT * Math.PI) * 0.9; }
    if (this.shakeT < 1) { this.shakeT = Math.min(1, this.shakeT + dt / 0.6); rotZ = Math.sin(this.shakeT * 40) * 0.15 * (1 - this.shakeT); }
    this.model.position.y = y; // 烘焙的模型自带站在底座上的高度
    this.model.rotation.set(0, this.face + rotY, rotZ);

    P.legs.forEach((l, i) => { l.rotation.x = working ? Math.sin(t * 14 + i * 1.7) * 0.5 : 0; });
    P.claws.forEach((c, i) => { c.rotation.x = working ? Math.sin(t * 9 + i * Math.PI) * 0.35 : st === 'waiting' ? -0.6 + Math.sin(t * 5) * 0.3 : 0; });
    if (P.spin) {
      if (this.agent === 'claude') P.spin.rotation.z += dt * (working ? 3 : 0.4);
      else P.spin.rotation.z = working ? Math.sin(t * 8) * 0.3 : 0;
    }
    const blink = !this.calm() && (t % 4.3) < 0.12;
    for (const e of P.eyes) e.scale.y = st === 'sleep' ? 0.15 : blink ? 0.2 : 1;
    const glow = st === 'waiting' ? 0.75 + 0.25 * Math.sin(t * 6) : working ? 0.7 + Math.sin(t * 3) * 0.2 : 0.45;
    this.ringMat.color.set(st === 'waiting' ? '#f08c2e' : this.accent).multiplyScalar(glow);

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
