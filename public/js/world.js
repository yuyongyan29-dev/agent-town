// 3D 小镇：模型由 Blender 建好并把光照、阴影烘焙进贴图（tools/bake_town.py → public/assets/*.glb）。
// 网页里一律用不受光照的材质显示烘焙贴图：不再实时算光影，GPU 只做最基本的贴图绘制。
// World 管全局的天气、昼夜调色与街区调度；每个 agent 一个 District（车间、传送带、中转站、广场、池塘、树林）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ISLAND, POND, blocked } from './layout.js';
import { rng, clamp, hash } from './util.js';

const col = (c) => new THREE.Color(c);
const mix = (a, b, t) => a + (b - a) * t;
const LOD_DIST = 170; // 相机离街区超过这个距离只留街区名牌，树和小部件不画
const GROUND = 3000; // 无限大地：一张跟着镜头走的大平面，边缘藏在雾里
const MACRO = 160; // 大尺度明暗变化的周期（米），盖住草地贴图的重复感；大地按它的整数倍挪动，图案不会跟着动
const CHUNK = 24; // 森林按块生成，同一块每次长出同样的树

const WEATHER = {
  clear: { cloud: 1, rain: 0, snow: 0, fog: 0, storm: 0 },
  partly: { cloud: 0.85, rain: 0, snow: 0, fog: 0, storm: 0 },
  cloudy: { cloud: 0.55, rain: 0, snow: 0, fog: 0, storm: 0 },
  fog: { cloud: 0.5, rain: 0, snow: 0, fog: 1, storm: 0 },
  rain: { cloud: 0.4, rain: 1, snow: 0, fog: 0.2, storm: 0 },
  snow: { cloud: 0.6, rain: 0, snow: 1, fog: 0.15, storm: 0 },
  storm: { cloud: 0.3, rain: 1, snow: 0, fog: 0.25, storm: 1 },
};

function radialTex(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

// ---------- 素材 ----------
export let T = null; // town.json：布局、车间、树的摆放清单
export const MODELS = {}; // 名字 → 网格（只读，用的时候 clone）
const baked = new Set(); // 所有烘焙材质：昼夜、天气调色时一起乘上同一层颜色

/** 烘焙材质：不受光照，颜色 = 贴图 × 自身底色（tint，用于屋顶漆色、胶带品类色）× 昼夜调色 */
export function bakedMat(map, tint = '#ffffff') {
  const m = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  m.userData.tint = col(tint);
  m.color.copy(m.userData.tint);
  baked.add(m);
  return m;
}

/** 贴图传到显卡后，把网页内存里那份解码好的图释放掉（烘焙贴图不会再改） */
export function releaseTextures(renderer) {
  for (const m of baked) {
    const t = m.map;
    if (!t || t.userData.released) continue;
    renderer.initTexture(t);
    t.image?.close?.();
    t.userData.released = true;
  }
}

export const TEX = {}; // 草地、街区阴影图、大尺度明暗

/** 能无缝重复的大尺度明暗图：几层随机光斑，在四边绕回去画，接缝看不出来 */
function macroTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
  const r = rng(21);
  for (let i = 0; i < 90; i++) {
    const x = r() * 256, y = r() * 256, rad = 20 + r() * 60, a = 0.05 + r() * 0.07;
    for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
      const gr = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
      gr.addColorStop(0, `rgba(60,70,40,${a})`); gr.addColorStop(1, 'rgba(60,70,40,0)');
      g.fillStyle = gr; g.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 贴图按世界坐标对齐：平面中心在 (x, z)、尺寸 w×d，图案每 tile 米重复一次，不同平面的同一位置图案一致 */
function align(t, x, z, w, d, tile) {
  t.repeat.set(w / tile, d / tile);
  t.offset.set((x - w / 2) / tile, -(z + d / 2) / tile);
}

/** 草地材质：无缝草地 × 大尺度明暗（× 可选的阴影图），按世界坐标铺 */
function groundMat(x, z, w, d, shadow) {
  const map = TEX.grass.clone(), ao = TEX.macro.clone();
  align(map, x, z, w, d, T.grassTile);
  align(ao, x, z, w, d, MACRO);
  const m = bakedMat(map);
  m.aoMap = ao;
  if (shadow) { m.lightMap = shadow; m.lightMapIntensity = Math.PI / T.groundLit; }
  return m;
}

export async function loadTown() {
  T = await (await fetch('/assets/town.json')).json();
  const tl = new THREE.TextureLoader();
  const [grass, shadow] = await Promise.all(['grass', 'district-shadow'].map((n) => tl.loadAsync(`/assets/${n}.webp`)));
  grass.colorSpace = shadow.colorSpace = THREE.SRGBColorSpace;
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.anisotropy = 8;
  shadow.channel = 1; // 阴影图用第二套 UV（铺满整块街区），草地和明暗用第一套（按世界坐标重复）
  Object.assign(TEX, { grass, shadow, macro: macroTex() });
  const loader = new GLTFLoader();
  await Promise.all(['district', 'trees', 'factories', 'props'].map(async (f) => {
    const g = await loader.loadAsync(`/assets/${f}.glb`);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      const map = o.material.map;
      if (map) map.anisotropy = 4;
      o.material = bakedMat(map);
      MODELS[o.name] = o;
    });
  }));
}

const v3 = (p) => new THREE.Vector3(...p);
const label = (cls, html) => {
  const el = document.createElement('div');
  el.className = 'label ' + cls;
  el.innerHTML = html;
  return { el, obj: new CSS2DObject(el) };
};
/** 能点、但不画出来的拾取体 */
const hitbox = (geo, pick) => {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
  m.userData.pick = pick;
  return m;
};

/** 平滑的随机起伏（值噪声），0~1：决定森林哪里密、哪里是林间空地 */
function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const h = (i, j) => (hash(`${xi + i},${zi + j}`) % 1000) / 1000;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  return (h(0, 0) * (1 - sx) + h(1, 0) * sx) * (1 - sz) + (h(0, 1) * (1 - sx) + h(1, 1) * sx) * sz;
}

/** 按 town.json 的清单把树摆出来：每个原型一批实例，一次绘制 */
function forest(list) {
  const by = new Map();
  for (const t of list) (by.get(t[0]) || by.set(t[0], []).get(t[0])).push(t);
  const g = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  for (const [idx, items] of by) {
    const src = MODELS[`tree${idx}`];
    const im = new THREE.InstancedMesh(src.geometry, src.material, items.length);
    items.forEach(([, x, z, ry, sc, sy], i) => im.setMatrixAt(i, m.compose(p.set(x, 0, z), q.setFromEuler(e.set(0, ry, 0)), s.set(sc, sy, sc))));
    im.computeBoundingSphere();
    g.add(im);
  }
  return g;
}

export class World {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = col('#cfe6c4');
    this.scene.fog = new THREE.Fog('#cfe6c4', 90, 220);
    this.pickables = [];
    this.districts = {};
    this.env = { night: 0, day: 0.5, ...WEATHER.partly };
    this.target = { night: 0, day: 0.5, ...WEATHER.partly };
    this.flash = 0;
    this.nextFlash = 3;
    this.camDist = 75;
    this.frustum = new THREE.Frustum();
    this.box = new THREE.Box3();
    this.shade = col('#000000'); // 第一次 applyEnv 一定会刷新
    // 共用材质：玻璃罩、亮灯的窗、夜里路灯的光晕
    this.glass = new THREE.MeshBasicMaterial({ color: '#eef6fb', transparent: true, opacity: 0.12, depthWrite: false });
    this.winOn = new THREE.MeshBasicMaterial({ color: '#ffd27a', toneMapped: false });
    this.winOff = bakedMat(null, '#2b3540');
    this.glowMat = new THREE.SpriteMaterial({ map: radialTex('rgba(255,214,150,1)', 'rgba(255,214,150,0)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTex('rgba(255,200,130,1)', 'rgba(255,200,130,0)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.buildWeather();
    this.buildGround();
    this.applyEnv(0);
  }

  /** 新开一个街区；pos 是街区中心在画布上的 [x, z] */
  addDistrict(agent, meta, pos) {
    const d = new District(this, agent, meta, pos);
    this.districts[agent] = d;
    this.scene.add(d.group);
    this.forestKey = '';
    return d;
  }

  removeDistrict(agent) {
    const d = this.districts[agent];
    if (!d) return;
    d.group.removeFromParent();
    d.group.traverse((o) => o.element?.remove()); // 名牌是 DOM，跟着拿掉
    const inD = (o) => { for (; o; o = o.parent) if (o === d.group) return true; return false; };
    this.pickables = this.pickables.filter((o) => !inD(o));
    delete this.districts[agent];
    this.forestKey = '';
  }

  // ---------- 无限大地与森林 ----------
  buildGround() {
    this.groundMat = groundMat(0, 0, GROUND, GROUND);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND, GROUND).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.material.depthWrite = false; // 垫在最底下，街区自己的地面直接盖在上面，不会闪
    this.ground.renderOrder = -1;
    this.ground.position.y = -0.02;
    this.scene.add(this.ground);
    // 森林：每个树原型一批实例，镜头走到哪长到哪；树下压一圈柔和的影子
    this.trees = Object.keys(MODELS).filter((k) => /^tree\d$/.test(k)).sort().map((k) => {
      const im = new THREE.InstancedMesh(MODELS[k].geometry, MODELS[k].material, 3000);
      im.count = 0;
      this.scene.add(im);
      return im;
    });
    const blob = new THREE.MeshBasicMaterial({ map: radialTex('rgba(18,28,40,0.55)', 'rgba(18,28,40,0)'), transparent: true, depthWrite: false });
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blob, 8000);
    this.blobs.count = 0;
    this.blobs.renderOrder = 1;
    this.scene.add(this.blobs);
    this.forestKey = '';
  }

  /** 镜头附近的森林：按块生成，块坐标定了树就定了；避开街区；离镜头越远看得越广 */
  updateForest(target) {
    const radius = Math.round(clamp(this.camDist * 1.5, 90, 220) / 30) * 30;
    const cx0 = Math.floor((target.x - radius) / CHUNK), cx1 = Math.floor((target.x + radius) / CHUNK);
    const cz0 = Math.floor((target.z - radius) / CHUNK), cz1 = Math.floor((target.z + radius) / CHUNK);
    const key = [cx0, cx1, cz0, cz1].join();
    if (key === this.forestKey) return;
    this.forestKey = key;
    // 大地跟着镜头挪，按明暗周期的整数倍挪，图案不动
    const gx = Math.round(target.x / MACRO) * MACRO, gz = Math.round(target.z / MACRO) * MACRO;
    this.ground.position.x = gx; this.ground.position.z = gz;
    align(this.groundMat.map, gx, gz, GROUND, GROUND, T.grassTile);
    align(this.groundMat.aoMap, gx, gz, GROUND, GROUND, MACRO);
    const W = T.island.hw + 1.5, D = T.island.hd + 1.5;
    const ds = Object.values(this.districts).map((d) => d.group.position);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    for (const im of this.trees) im.count = 0;
    let nb = 0;
    const cx = (cx0 + cx1) / 2 * CHUNK, cz = (cz0 + cz1) / 2 * CHUNK;
    // 从视野中心往外一块块种，树数到上限时少掉的是最远的一圈，而不是某一侧
    const chunks = [];
    for (let i = cx0; i <= cx1; i++) for (let j = cz0; j <= cz1; j++) chunks.push([i, j, Math.hypot((i + 0.5) * CHUNK - cx, (j + 0.5) * CHUNK - cz)]);
    chunks.sort((a, b) => a[2] - b[2]);
    for (const [i, j] of chunks) {
      const r = rng(hash(`forest:${i},${j}`));
      for (let gxx = 0; gxx < CHUNK; gxx += 2.2) for (let gzz = 0; gzz < CHUNK; gzz += 2.2) {
        const x = i * CHUNK + gxx + (r() - 0.5) * 2, z = j * CHUNK + gzz + (r() - 0.5) * 2;
        const pick = r(), size = r(), ry = (r() - 0.5) * 0.8, tall = r(), keep = r();
        if (Math.hypot(x - cx, z - cz) > radius) continue;
        // 林子有疏有密：大部分地方是稀疏的树，起伏最低的地方才是林间空地
        const dens = clamp(0.3 + (noise2(x / 45, z / 45) - 0.3) * 1.8) * 0.85;
        if (keep > dens) continue;
        if (ds.some((o) => Math.abs(x - o.x) < W && Math.abs(z - o.z) < D)) continue;
        const idx = pick < 0.08 ? 7 : pick > 0.9 ? 6 : Math.floor(pick * 6.6) % 6;
        const im = this.trees[idx];
        if (!im || im.count >= 3000 || nb >= 8000) continue;
        const k = 0.8 + size * 0.55;
        im.setMatrixAt(im.count++, m.compose(p.set(x, 0, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(k, k * (0.9 + tall * 0.25), k)));
        // 影子顺着阳光方向（往右后方）拉长，和街区里烘焙的树影一致
        this.blobs.setMatrixAt(nb++, m.compose(p.set(x + 0.9 * k, 0.03, z - 0.45 * k), q.setFromEuler(e.set(0, 0.42, 0)), sc.set(k * (idx === 6 ? 1.8 : 3.4), 1, k * (idx === 6 ? 1.4 : 2.2))));
      }
    }
    for (const im of [...this.trees, this.blobs]) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    this.blobs.count = nb;
  }

  // ---------- 天气粒子 ----------
  buildWeather() {
    const RN = 2500;
    const rp = new Float32Array(RN * 6);
    for (let i = 0; i < RN; i++) {
      const x = (Math.random() * 2 - 1) * 45, y = Math.random() * 32, z = (Math.random() * 2 - 1) * 34;
      rp.set([x, y, z, x - 0.12, y - 0.9, z - 0.06], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#b8cdea', transparent: true, opacity: 0 }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;

    const SN = 3000;
    const sp = new Float32Array(SN * 3);
    this.snowSeed = new Float32Array(SN);
    for (let i = 0; i < SN; i++) {
      sp.set([(Math.random() * 2 - 1) * 45, Math.random() * 32, (Math.random() * 2 - 1) * 34], i * 3);
      this.snowSeed[i] = Math.random() * 10;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.38, map: radialTex(), transparent: true, opacity: 0, depthWrite: false, color: '#ffffff' }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;

    // 萤火虫：池塘边 30 只，其余散在树林里（街区局部坐标，跟着镜头所在街区走）
    const FN = 50;
    const fp = new Float32Array(FN * 3);
    this.flyBase = [];
    const r = rng(8);
    for (let i = 0; i < FN; i++) {
      const near = i < 30;
      const a = r() * Math.PI * 2, d = near ? POND.r + 0.5 + r() * 4 : 0;
      let bx = POND.x + Math.cos(a) * d, bz = POND.z + Math.sin(a) * d;
      while (!near && blocked(bx, bz)) { bx = (r() * 2 - 1) * ISLAND.hw; bz = (r() * 2 - 1) * ISLAND.hd; }
      this.flyBase.push([bx, 0.6 + r() * 1.6, bz, r() * 10]);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    this.flies = new THREE.Points(fg, new THREE.PointsMaterial({ size: 0.32, map: radialTex('rgba(255,240,150,1)', 'rgba(255,220,100,0)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flies.frustumCulled = false;
    this.scene.add(this.rain, this.snow, this.flies);
  }

  // ---------- 环境 ----------
  /** night: 0 白天 … 1 夜里；day: 白天进度 0 日出 … 1 日落；kind: 天气 */
  setEnv({ night, day, kind }) {
    if (night != null) this.target.night = night;
    if (day != null) this.target.day = day;
    if (kind) Object.assign(this.target, WEATHER[kind] || WEATHER.partly);
  }

  applyEnv(dt) {
    const e = this.env, T_ = this.target;
    const k = dt ? 1 - Math.exp(-dt * 1.2) : 1;
    this.envMoving = false;
    for (const key of Object.keys(T_)) {
      if (Math.abs(T_[key] - e[key]) > 0.002) { e[key] += (T_[key] - e[key]) * k; this.envMoving = true; } else e[key] = T_[key];
    }
    const n = clamp(e.night), gray = (1 - e.cloud) * (1 - n);

    // 烘焙的是晴天白天的光照；阴天、夜晚在上面整体乘一层颜色
    const shade = col('#ffffff').lerp(col('#c2c8d0'), gray * 0.7).multiply(col('#ffffff').lerp(col('#3a4787'), n * 0.85));
    if (this.flash > 0) shade.lerp(col('#ffffff'), this.flash * 0.6);
    if (!shade.equals(this.shade)) {
      this.shade.copy(shade);
      for (const m of baked) m.color.copy(m.userData.tint).multiply(shade);
    }
    const bg = col('#cfe6c4').lerp(col('#c3cac9'), gray * 0.8).lerp(col('#1d2547'), n);
    if (this.flash > 0) bg.lerp(col('#e9ecff'), this.flash * 0.6);
    this.scene.background.copy(bg);
    this.scene.fog.color.copy(bg);
    const far = Math.max(0, this.camDist - 75); // 拉远看全图时雾跟着退开
    this.scene.fog.near = mix(90, 25, e.fog) + far;
    this.scene.fog.far = mix(220, 105, e.fog) + far * 1.6;

    this.glowMat.opacity = n * 0.9;
    this.poolMat.opacity = n * 0.55;
    this.glass.opacity = 0.12 + n * 0.08;
    this.rain.visible = e.rain > 0.03;
    this.rain.material.opacity = e.rain * 0.5;
    this.snow.visible = e.snow > 0.03;
    this.snow.material.opacity = e.snow * 0.95;
    this.flies.visible = n > 0.1;
    this.flies.material.opacity = n * (1 - e.rain * 0.8) * (1 - e.snow * 0.8);
  }

  /** 每帧：天气与昼夜、视锥裁剪与远近切换，再推进看得见的街区；target 是镜头注视点 */
  update(dt, t, camera, target) {
    this.camDist = camera.position.distanceTo(target);
    // 雷电
    if (this.env.storm > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flash = 1; this.nextFlash = 4 + Math.random() * 9; }
    }
    this.flash = Math.max(0, this.flash - dt * (this.flash > 0.5 ? 3 : 1.5));
    if (this.flash > 0.3 && this.flash < 0.45 && Math.random() < 0.3) this.flash = 0.9; // 闪两下
    this.applyEnv(dt);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const size = new THREE.Vector3(ISLAND.hw * 2, 12, ISLAND.hd * 2);
    let near = null, best = Infinity;
    this.updateForest(target);
    for (const d of Object.values(this.districts)) {
      const o = d.group.position;
      d.group.visible = this.frustum.intersectsBox(this.box.setFromCenterAndSize(new THREE.Vector3(o.x, 3, o.z), size));
      if (!d.group.visible) continue;
      const far = camera.position.distanceTo(o) > LOD_DIST;
      d.full.visible = !far;
      d.lod.visible = far;
      if (!far) d.update?.(dt, t);
      const k = Math.hypot(o.x - target.x, o.z - target.z);
      if (k < best) { best = k; near = d; }
    }
    this.rain.position.set(target.x, 0, target.z);
    this.snow.position.set(target.x, 0, target.z);

    if (this.rain.visible) {
      const a = this.rain.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i += 6) {
        a[i + 1] -= 30 * dt; a[i + 4] -= 30 * dt;
        if (a[i + 4] < 0) { a[i + 1] += 32; a[i + 4] += 32; }
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    if (this.snow.visible) {
      const a = this.snow.geometry.attributes.position.array;
      for (let i = 0, j = 0; i < a.length; i += 3, j++) {
        const sd = this.snowSeed[j];
        a[i] += Math.sin(t * 0.8 + sd) * dt * 0.6;
        a[i + 1] -= (1.2 + (sd % 1) * 0.8) * dt;
        a[i + 2] += Math.cos(t * 0.6 + sd) * dt * 0.4;
        if (a[i + 1] < 0) a[i + 1] += 32;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
    if (this.flies.visible && near) {
      const a = this.flies.geometry.attributes.position.array;
      this.flies.position.copy(near.group.position);
      this.flyBase.forEach(([x, y, z, s], i) => {
        a[i * 3] = x + Math.sin(t * 0.5 + s) * 1.2;
        a[i * 3 + 1] = y + Math.sin(t * 1.3 + s * 2) * 0.4;
        a[i * 3 + 2] = z + Math.cos(t * 0.4 + s) * 1.2;
      });
      this.flies.geometry.attributes.position.needsUpdate = true;
    }
  }
}

export class District {
  constructor(world, agent, meta, [x, z]) {
    this.world = world;
    this.agent = agent;
    this.accent = meta.color;
    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    this.full = new THREE.Group(); // 近看才画：树、信标、烟、名牌、包裹和角色
    this.lod = new THREE.Group(); // 远看：只留街区名牌
    this.group.add(this.full, this.lod);
    this.bench = []; this.pallet = []; this.shipped = 0;
    this.activeSlots = new Set();
    this.slots = new Array(T.slotZ.length).fill(null);
    this.slotUsed = new Array(T.slotZ.length).fill(0);
    const L = T.layout, W = T.island.hw * 2, D = T.island.hd * 2;

    // 地面：和无限大地同一种草，再叠上这块街区烘焙的阴影图，边缘看不出接缝
    const geo = new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2);
    geo.setAttribute('uv1', geo.attributes.uv.clone());
    this.groundMesh = new THREE.Mesh(geo, groundMat(x, z, W, D, TEX.shadow));
    this.group.add(this.groundMesh);
    // 传送带、中转站、广场等静态部分：一个网格一张烘焙贴图
    this.group.add(MODELS.district.clone());
    const dome = MODELS.dome_glass.clone();
    dome.material = world.glass;
    dome.renderOrder = 2;
    this.group.add(dome);
    const ground = hitbox(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), { kind: 'district', agent });
    this.group.add(ground);
    world.pickables.push(ground);
    this.full.add(forest(L.trees));

    // 夜里路灯的光晕
    for (const [lx, ly, lz] of L.lamps) {
      const s = new THREE.Sprite(world.glowMat);
      s.position.set(lx, ly - 0.05, lz); s.scale.setScalar(1.6);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2), world.poolMat);
      pool.position.set(lx, 0.06, lz);
      this.full.add(s, pool);
    }

    // 车间：三种造型轮换，屋顶按车间号上漆，窗户亮灯表示在干活
    this.factories = T.slotZ.map((sz, i) => {
      const v = i % 3, info = T.factories[v];
      const g = new THREE.Group();
      g.position.set(T.factoryX, 0, sz);
      const roofColor = T.roofColors[i];
      const roof = MODELS[`roof${v}`].clone();
      roof.material = bakedMat(roof.material.map, '#9aa1a8');
      const win = MODELS[`win${v}`].clone();
      win.material = world.winOff;
      g.add(MODELS[`factory${v}`].clone(), roof, win);
      const lampMat = new THREE.MeshBasicMaterial({ color: '#9aa0a6', toneMapped: false });
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), lampMat);
      beacon.position.set(...info.beacon);
      beacon.visible = false;
      const smokeMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false });
      const puffs = [0, 1, 2, 3].map((k) => {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), smokeMat.clone());
        p.userData.phase = k / 4;
        p.visible = false;
        g.add(p);
        return p;
      });
      g.add(beacon, hitbox(new THREE.BoxGeometry(5, 4.5, 4.6).translate(0.6, 2.25, 0), { kind: 'factory', agent, slot: i }));
      g.userData.pick = { kind: 'factory', agent, slot: i };
      world.pickables.push(g);
      const { el, obj } = label('pill factory-pill empty', '<i></i><b>空闲车间</b><em></em>');
      el.dataset.slot = i;
      el.dataset.agent = agent;
      obj.position.set(0.5, 5.6, 0);
      g.add(obj);
      this.full.add(g);
      return { group: g, roof, roofColor, win, beacon, lampMat, puffs, chimneyTop: v3(info.chimney), el, info: null, status: 'idle' };
    });

    // 传送带：只用来算包裹走的路线
    const curve = (pts) => { const c = new THREE.CatmullRomCurve3(pts.map(v3), false, 'centripetal'); return { curve: c, len: c.getLength() }; };
    this.belts1 = L.belts1.map((b, i) => ({ ...curve(b.pts), angle: b.angle, key: `f${i}` }));
    this.belt2 = { ...curve(L.belt2.pts), angle: L.belt2.angle, key: 'out' };

    // 中转站
    const hub = new THREE.Group();
    hub.position.set(T.hub.x, 0, T.hub.z);
    hub.add(hitbox(new THREE.CylinderGeometry(T.hub.r + 0.4, T.hub.r + 0.4, 4).translate(0, 2, 0), { kind: 'hub', agent }));
    hub.userData.pick = { kind: 'hub', agent };
    world.pickables.push(hub);
    this.full.add(hub);
    const h = label('pill hub-pill', '<b>中转站</b><span>在转 0 件</span>');
    h.obj.position.set(T.hub.x, T.beltY + T.hub.r * 0.75 + 1.6, T.hub.z);
    this.full.add(h.obj);
    this.hubEl = h.el;

    // 广场上的工作台、托盘、次品箱、角色位置（包裹和角色按这些点摆）
    this.plaza = { center: v3(L.center), dir: v3(L.dir), perp: v3(L.perp), bench: v3(L.bench), benchTop: L.benchTop, pallet: v3(L.pallet), palletTop: L.palletTop, reject: v3(L.reject), agentPos: v3(L.agentPos) };
    this.plaza.beltEnd = this.belt2.curve.getPointAt(1);

    const lod = label('pill lod-pill', '<i></i><b></b><span></span>');
    lod.el.querySelector('b').textContent = meta.name;
    lod.el.dataset.agent = agent;
    lod.obj.position.set(0, 6, 0);
    this.lod.add(lod.obj);
    this.lodEl = lod.el;
    this.lod.visible = false;
  }

  /** 挪到 (x, z)：地面贴图按世界坐标重新对齐，森林重新避让 */
  moveTo(x, z) {
    this.group.position.set(x, 0, z);
    const m = this.groundMesh.material, W = T.island.hw * 2, D = T.island.hd * 2;
    align(m.map, x, z, W, D, T.grassTile);
    align(m.aoMap, x, z, W, D, MACRO);
    this.world.forestKey = '';
  }

  /** 项目占用的车间；没见过的项目占用最久没用的槽位 */
  slotOf(project) {
    let i = this.slots.indexOf(project);
    if (i >= 0) { this.slotUsed[i] = Date.now(); return i; }
    i = this.slots.indexOf(null);
    if (i < 0) i = this.slotUsed.indexOf(Math.min(...this.slotUsed));
    this.slots[i] = project;
    this.slotUsed[i] = Date.now();
    return i;
  }

  /** info: {name, count, status, statusColor, active, title} 或 null（空闲车间） */
  setFactory(slot, info) {
    const f = this.factories[slot];
    if (!f) return;
    f.info = info;
    f.el.classList.toggle('empty', !info);
    f.el.querySelector('b').textContent = info ? info.name : '空闲车间';
    f.el.querySelector('em').textContent = info?.count ? String(info.count) : '';
    f.el.querySelector('i').style.background = info?.statusColor || '#c2c6cc';
    f.el.title = info?.title || '';
    f.roof.material.userData.tint.set(info ? f.roofColor : '#9aa1a8');
    f.roof.material.color.copy(f.roof.material.userData.tint).multiply(this.world.shade);
    f.win.material = info && info.active ? this.world.winOn : this.world.winOff;
    f.lampMat.color.set(info?.statusColor || '#9aa0a6');
    f.beacon.visible = !!info;
    f.status = info?.status || 'idle';
  }

  setBeltSpeed() {} // 带面是烘焙的，不滚动；运动感由包裹体现
  setHubCount(n) { this.hubEl.querySelector('span').textContent = `在转 ${n} 件`; }

  setLod(color, text) {
    this.lodEl.querySelector('i').style.background = color;
    this.lodEl.querySelector('span').textContent = text;
  }

  update(dt, t) {
    // 车间状态灯与烟
    for (const f of this.factories) {
      const st = f.status;
      if (f.info) f.beacon.scale.setScalar(st === 'waiting' ? 1 + 0.35 * Math.sin(t * 6) : st === 'working' ? 1.15 : 1);
      const smoking = st === 'working';
      for (const p of f.puffs) {
        p.visible = smoking;
        if (!smoking) continue;
        const ph = (t * 0.35 + p.userData.phase) % 1;
        p.position.set(f.chimneyTop.x + ph * 0.8, f.chimneyTop.y + ph * 2.4, f.chimneyTop.z - ph * 0.3);
        p.scale.setScalar(0.4 + ph * 1.1);
        p.material.opacity = 0.6 * (1 - ph);
        p.material.color.copy(this.world.shade);
      }
    }
  }
}
