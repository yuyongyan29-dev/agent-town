// 3D 小镇：World 管全局的光照、天气与街区调度；每个 agent 一个 District（车间、传送带、中转站、广场、池塘、树林）
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ISLAND, HUB, PLAZA, FACTORY_X, SLOT_Z, POND, BELT_Y, LAMPS, DISTRICT, blocked } from './layout.js';
import { ROOF_COLORS, rng, clamp, hash } from './util.js';

const col = (c) => new THREE.Color(c);
const mix = (a, b, t) => a + (b - a) * t;
const TOP = BELT_Y; // 传送带、转盘顶面高度，包裹中心 = TOP + 0.35
export const PARCEL_Y = TOP + 0.36;

const WEATHER = {
  clear: { cloud: 1, rain: 0, snow: 0, fog: 0, storm: 0 },
  partly: { cloud: 0.85, rain: 0, snow: 0, fog: 0, storm: 0 },
  cloudy: { cloud: 0.55, rain: 0, snow: 0, fog: 0, storm: 0 },
  fog: { cloud: 0.5, rain: 0, snow: 0, fog: 1, storm: 0 },
  rain: { cloud: 0.4, rain: 1, snow: 0, fog: 0.2, storm: 0 },
  snow: { cloud: 0.6, rain: 0, snow: 1, fog: 0.15, storm: 0 },
  storm: { cloud: 0.3, rain: 1, snow: 0, fog: 0.25, storm: 1 },
};

function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

function radialTex(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const t = canvasTex(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** 沿曲线铺一条平带（UV 的 u 为世界长度，便于贴图按米重复） */
function ribbon(points, width, y = 0) {
  const pos = [], uv = [], idx = [];
  let len = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l, nz = tx / l;
    if (i) len += p.distanceTo(points[i - 1]);
    pos.push(p.x + nx * width / 2, p.y + y, p.z + nz * width / 2, p.x - nx * width / 2, p.y + y, p.z - nz * width / 2);
    uv.push(len, 0, len, 1);
    if (i < points.length - 1) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function offsetCurve(points, d, dy = 0) {
  const out = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, l = Math.hypot(tx, tz) || 1;
    return new THREE.Vector3(p.x - tz / l * d, p.y + dy, p.z + tx / l * d);
  });
  return new THREE.CatmullRomCurve3(out);
}

function mesh(geo, mat, { x = 0, y = 0, z = 0, cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast; m.receiveShadow = receive;
  return m;
}

// 统一用 Lambert：微缩场景几乎全是哑光面，PBR 的逐像素高光对观感帮助很小，却是填充率的大头
const lambert = ({ roughness, metalness, clearcoat, ...o }) => new THREE.MeshLambertMaterial(o);
const std = (color, o = {}) => lambert({ color, ...o });
const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** 一批相同零件合成一次绘制；list 每项 [x, y, z, sx, sy, sz, ry] */
function instanced(geo, mat, list, cast = true) {
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  list.forEach(([x, y, z, sx = 1, sy = 1, sz = 1, ry = 0], i) => im.setMatrixAt(i, m.compose(v.set(x, y, z), q.setFromEuler(e.set(0, ry, 0)), sc.set(sx, sy, sz))));
  im.castShadow = cast;
  im.receiveShadow = true;
  return im;
}

/** 把组里不再变化的网格按材质合并成一个，绘制调用少一个数量级；标了 live（会换材质、变色、动）的保留原样 */
function mergeStatic(group) {
  const buckets = new Map();
  for (const c of [...group.children]) {
    if (c.isGroup) { mergeStatic(c); continue; }
    const m = c.material;
    if (!c.isMesh || c.isInstancedMesh || !c.visible || c.userData.live || c.userData.pick || Array.isArray(m) || m.userData.live) continue;
    const key = [m.userData.shared ? m.uuid : [m.type, m.color?.getHex(), m.roughness, m.metalness, m.map?.uuid, m.emissive?.getHex(), m.emissiveIntensity, m.transparent, m.opacity].join(), c.castShadow, c.receiveShadow, c.renderOrder].join('|');
    (buckets.get(key) || buckets.set(key, []).get(key)).push(c);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos = list.map((c) => {
      c.updateMatrix();
      const g = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
      for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv') g.deleteAttribute(a);
      return g.applyMatrix4(c.matrix);
    });
    if (geos.some((g) => !g.attributes.uv || !g.attributes.normal)) continue;
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const one = mesh(merged, list[0].material, { cast: list[0].castShadow, receive: list[0].receiveShadow });
    one.renderOrder = list[0].renderOrder;
    for (const c of list) group.remove(c);
    group.add(one);
  }
}

/** 一块地皮：草皮、两层土、积雪层；格子大小正好一格，相邻地皮严丝合缝 */
function groundMeshes(world) {
  const W = DISTRICT.w, D = DISTRICT.d;
  const grass = once('grass', () => canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#93c46e'; g.fillRect(0, 0, w, h);
    const r = rng(3);
    for (let i = 0; i < 4200; i++) {
      const v = r();
      g.fillStyle = v < 0.4 ? 'rgba(120,176,88,0.55)' : v < 0.75 ? 'rgba(168,210,120,0.5)' : 'rgba(96,150,70,0.45)';
      const s = 2 + r() * 5;
      g.beginPath(); g.ellipse(r() * w, r() * h, s, s * 0.6, r() * 3, 0, Math.PI * 2); g.fill();
    }
  }, [10, 7]));
  const top = mesh(once('topGeo', () => new THREE.BoxGeometry(W, 0.6, D)), once('grassMat', () => std('#ffffff', { map: grass, roughness: 0.95 })), { y: -0.3, cast: false });
  const soil = mesh(once('soilGeo', () => new THREE.BoxGeometry(W, 3.2, D)), once('soilMat', () => std('#a7774f')), { y: -1.9, cast: false });
  const soil2 = mesh(once('soil2Geo', () => new THREE.BoxGeometry(W, 1.2, D)), once('soil2Mat', () => std('#8b6142')), { y: -3.6, cast: false });
  const snow = mesh(once('snowGeo', () => new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2)), world.snowMat, { y: 0.006, cast: false });
  return [top, soil, soil2, snow];
}

/** 一片树林：每棵树 1～2 团树冠 + 树干，下雪时盖帽；spots 每项 [x, z, 大小, 随机数] */
function forest(spots, r, capMat) {
  const n = spots.length;
  const greens = ['#5f9e4f', '#6bab55', '#4f8a45', '#7bb85d', '#86bf63', '#5a9a5a'];
  const autumn = ['#e0a43a', '#d9822b', '#c9622f', '#e8c14a', '#d4a03c'];
  const foliage = new THREE.InstancedMesh(once('leafGeo', () => new THREE.SphereGeometry(1, 11, 8)), once('leafMat', () => std('#ffffff', { roughness: 0.8 })), n * 2);
  const trunks = new THREE.InstancedMesh(once('trunkGeo', () => new THREE.CylinderGeometry(0.12, 0.18, 1, 6)), once('trunkMat', () => std('#8a6244')), n);
  const caps = new THREE.InstancedMesh(once('capGeo', () => new THREE.SphereGeometry(1.05, 11, 4, 0, Math.PI * 2, 0, Math.PI * 0.3)), capMat, n * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
  let fi = 0;
  spots.forEach(([x, z, k, h], i) => {
    const th = 0.55 * k;
    m.compose(v.set(x, th / 2, z), q.identity(), s.set(k, th, k));
    trunks.setMatrixAt(i, m);
    const c = col(h < 0.16 ? autumn[i % autumn.length] : greens[i % greens.length]);
    c.offsetHSL(0, 0, (r() - 0.5) * 0.06);
    const blobs = h > 0.7 ? [[0, th + 0.75 * k, 0, 0.85 * k], [0.1 * k, th + 1.45 * k, -0.05 * k, 0.55 * k]] : [[0, th + 0.8 * k, 0, 0.95 * k]];
    for (const [bx, by, bz, br] of blobs) {
      m.compose(v.set(x + bx, by, z + bz), q.identity(), s.set(br, br * 0.92, br));
      foliage.setMatrixAt(fi, m);
      foliage.setColorAt(fi, c);
      caps.setMatrixAt(fi, m);
      fi++;
    }
  });
  foliage.count = fi; caps.count = fi;
  foliage.castShadow = true; foliage.receiveShadow = true; trunks.castShadow = true;
  return [foliage, trunks, caps];
}

/** 接触阴影：一批柔和的暗圈，list 每项 [x, y, z, 宽, 1, 深] */
function aoBlobs(list) {
  const mat = once('aoMat', () => new THREE.MeshBasicMaterial({ map: radialTex('rgba(0,0,0,1)', 'rgba(0,0,0,0)'), transparent: true, opacity: 0.32, depthWrite: false }));
  const blobs = instanced(once('aoGeo', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), mat, list, false);
  blobs.receiveShadow = false;
  blobs.renderOrder = 1;
  return blobs;
}
const LOD_DIST = 170; // 相机离街区超过这个距离只画简化方块
const shared = {}; // 各街区共用的贴图，只画一次
const once = (k, f) => shared[k] || (shared[k] = f());

export class World {
  constructor() {
    this.scene = new THREE.Scene();
    this.pickables = [];
    this.districts = {};
    this.env = { night: 0, day: 0.5, ...WEATHER.partly };
    this.target = { night: 0, day: 0.5, ...WEATHER.partly };
    this.flash = 0;
    this.nextFlash = 3;
    this.camDist = 75;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.frustum = new THREE.Frustum();
    // 阴影贴图只在镜头挪远、太阳转动、街区增减或远近切换时重画（动的东西都不投影）
    this.shadowDirty = true;
    this.shadowAt = -1e9;
    this.shadowPos = new THREE.Vector3(1e9, 0, 0);
    this.box = new THREE.Box3();

    // 随昼夜、天气变化的材质，所有街区共用
    this.winOn = std('#ffe3a3', { emissive: '#ffcf70', emissiveIntensity: 0.2, roughness: 0.4 });
    this.winOff = std('#9fb3c8', { roughness: 0.3, metalness: 0.2 });
    this.lampHead = lambert({ color: '#fff1cf', emissive: '#ffc96b', emissiveIntensity: 0.3 });
    this.decalMat = new THREE.MeshBasicMaterial({ map: radialTex('rgba(255,210,140,1)', 'rgba(255,210,140,0)'), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.hubCore = lambert({ color: '#7fe0d6', emissive: '#4cc6c0', emissiveIntensity: 0.8 });
    this.waterMat = std('#7cc6dd', { roughness: 0.12, metalness: 0.15, emissive: '#1d3a52', emissiveIntensity: 0 });
    this.snowMat = lambert({ color: '#eef2f8', roughness: 1, transparent: true, opacity: 0, depthWrite: false });
    this.capMat = lambert({ color: '#f4f7fb', roughness: 1, transparent: true, opacity: 0 });
    for (const m of [this.winOn, this.winOff, this.lampHead, this.decalMat, this.hubCore, this.waterMat, this.snowMat, this.capMat]) m.userData.shared = true;
    this.wilds = new Map(); // "i,j" → 空地

    this.buildLights();
    this.buildWeather();
    this.applyEnv(0);
  }

  /** 新开一个街区；pos 是街区中心在画布上的 [x, z] */
  addDistrict(agent, meta, pos) {
    const d = new District(this, agent, meta, pos);
    this.districts[agent] = d;
    this.scene.add(d.group);
    this.layoutWilds();
    return d;
  }

  /** 街区围成的矩形里没人占的格子铺上树林，画布连成一整片 */
  layoutWilds() {
    const W = DISTRICT.w, D = DISTRICT.d;
    const cells = Object.values(this.districts).map((d) => [Math.round(d.group.position.x / W), Math.round(d.group.position.z / D)]);
    const used = new Set(cells.map((c) => c.join()));
    const need = new Set();
    const [is, js] = [cells.map((c) => c[0]), cells.map((c) => c[1])];
    for (let i = Math.min(...is); i <= Math.max(...is); i++) for (let j = Math.min(...js); j <= Math.max(...js); j++) if (!used.has(`${i},${j}`)) need.add(`${i},${j}`);
    this.shadowDirty = true;
    for (const [k, w] of this.wilds) if (!need.has(k)) w.group.removeFromParent();
    for (const k of need) {
      if (!this.wilds.has(k)) { const [i, j] = k.split(',').map(Number); this.wilds.set(k, new Wild(this, [i * W, j * D])); }
      this.scene.add(this.wilds.get(k).group);
    }
  }

  // ---------- 光照 ----------
  buildLights() {
    const s = this.scene;
    s.background = col('#cfe6c4');
    s.fog = new THREE.Fog('#cfe6c4', 90, 220);
    this.hemi = new THREE.HemisphereLight('#dff1ff', '#7a9a62', 1.2);
    s.add(this.hemi);
    const d = new THREE.DirectionalLight('#fff3df', 2.6);
    d.castShadow = true;
    d.shadow.mapSize.set(2048, 2048);
    Object.assign(d.shadow.camera, { left: -48, right: 48, top: 40, bottom: -40, near: 1, far: 220 });
    d.shadow.bias = -0.0004;
    d.shadow.normalBias = 0.03;
    d.shadow.radius = 3;
    s.add(d, d.target);
    this.sun = d;
    // 夜间暖光：只给镜头所在的街区点亮（中转站、广场、车间），灯多了会拖慢所有材质
    this.nightSpots = [[HUB.x, HUB.z], [PLAZA.x, PLAZA.z], [FACTORY_X + 4, 0]];
    this.nightLights = this.nightSpots.map(() => {
      const l = new THREE.PointLight('#ffd9a0', 0, 26, 1.6);
      s.add(l);
      return l;
    });
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
    const e = this.env, T = this.target;
    const k = dt ? 1 - Math.exp(-dt * 1.2) : 1;
    for (const key of Object.keys(T)) e[key] += (T[key] - e[key]) * k;
    const n = clamp(e.night), cloud = e.cloud, gray = (1 - cloud) * (1 - n);

    const sunCol = col('#fff3df').lerp(col('#9fb2ff'), n);
    this.sun.color.copy(sunCol);
    this.sun.intensity = mix(2.6, 0.55, n) * mix(cloud, 1, n * 0.6);
    const phi = mix(0.15, 0.85, clamp(e.day)) * Math.PI;
    const el = n > 0.5 ? (50 * Math.PI) / 180 : Math.max((25 * Math.PI) / 180, Math.sin(clamp(e.day) * Math.PI) * (62 * Math.PI) / 180);
    const dirx = n > 0.5 ? -0.4 : Math.cos(phi), dirz = n > 0.5 ? 0.6 : Math.sin(phi);
    this.sunDir.set(dirx * Math.cos(el), Math.sin(el), dirz * Math.cos(el)).multiplyScalar(80);

    const sky = col('#dff1ff').lerp(col('#c9d2da'), gray * 0.7).lerp(col('#4b5aa8'), n);
    this.hemi.color.copy(sky);
    this.hemi.groundColor.copy(col('#7a9a62').lerp(col('#2a3050'), n));
    this.hemi.intensity = mix(1.25, 0.75, n) * mix(1, 0.9, 1 - cloud) + this.flash * 3;

    const bg = col('#cfe6c4').lerp(col('#c3cac9'), gray * 0.8).lerp(col('#1d2547'), n);
    if (this.flash > 0) bg.lerp(col('#e9ecff'), this.flash * 0.6);
    this.scene.background.copy(bg);
    this.scene.fog.color.copy(bg);
    const far = Math.max(0, this.camDist - 75); // 拉远看全图时雾跟着退开
    this.scene.fog.near = mix(90, 25, e.fog) + far;
    this.scene.fog.far = mix(220, 105, e.fog) + far * 1.6;

    this.winOn.emissiveIntensity = 0.2 + n * 2.2;
    this.lampHead.emissiveIntensity = 0.3 + n * 3;
    this.decalMat.opacity = n * 0.85;
    this.hubCore.emissiveIntensity = 0.8 + n * 1.5;
    this.waterMat.emissiveIntensity = n * 0.6;
    this.nightLights.forEach((l) => (l.intensity = n * 22));

    this.snowMat.opacity = e.snow * 0.82;
    this.capMat.visible = e.snow > 0.05;
    this.capMat.opacity = clamp(e.snow * 1.2);
    this.rain.visible = e.rain > 0.03;
    this.rain.material.opacity = e.rain * 0.5;
    this.snow.visible = e.snow > 0.03;
    this.snow.material.opacity = e.snow * 0.95;
    this.flies.visible = n > 0.1;
    this.flies.material.opacity = n * (1 - e.rain * 0.8) * (1 - e.snow * 0.8);
  }

  /** 每帧：天气与昼夜、视锥裁剪与 LOD，再推进看得见的街区；target 是镜头注视点 */
  update(dt, t, camera, target) {
    this.camDist = camera.position.distanceTo(target);
    this.applyEnv(dt);
    this.focus(target);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const size = new THREE.Vector3(ISLAND.hw * 2, 12, ISLAND.hd * 2);
    for (const d of [...Object.values(this.districts), ...[...this.wilds.values()].filter((w) => w.group.parent)]) {
      const o = d.group.position;
      const seen = this.frustum.intersectsBox(this.box.setFromCenterAndSize(new THREE.Vector3(o.x, 3, o.z), size));
      if (seen !== d.group.visible) { d.group.visible = seen; this.shadowDirty = true; }
      if (!seen) continue;
      const far = camera.position.distanceTo(o) > LOD_DIST;
      if (far === d.full.visible) this.shadowDirty = true;
      d.full.visible = !far;
      d.lod.visible = far;
      if (!far) d.update?.(dt, t);
    }
    // 雷电
    if (this.env.storm > 0.5) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flash = 1; this.nextFlash = 4 + Math.random() * 9; }
    }
    this.flash = Math.max(0, this.flash - dt * (this.flash > 0.5 ? 3 : 1.5));
    if (this.flash > 0.3 && this.flash < 0.45 && Math.random() < 0.3) this.flash = 0.9; // 闪两下

    // 雨雪
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
    if (this.flies.visible) {
      const a = this.flies.geometry.attributes.position.array;
      this.flies.position.copy(this.near?.group.position || this.flies.position);
      this.flyBase.forEach(([x, y, z, s], i) => {
        a[i * 3] = x + Math.sin(t * 0.5 + s) * 1.2;
        a[i * 3 + 1] = y + Math.sin(t * 1.3 + s * 2) * 0.4;
        a[i * 3 + 2] = z + Math.cos(t * 0.4 + s) * 1.2;
      });
      this.flies.geometry.attributes.position.needsUpdate = true;
    }
  }

  /** 阳光、阴影、天气粒子和夜灯跟着镜头走 */
  focus(target) {
    const now = performance.now();
    if (this.shadowDirty || now - this.shadowAt > 10e3 || Math.hypot(target.x - this.shadowPos.x, target.z - this.shadowPos.z) > 4) {
      this.sun.target.position.set(target.x, 0, target.z);
      this.sun.position.set(target.x, 0, target.z).add(this.sunDir);
      this.shadowPos.set(target.x, 0, target.z);
      this.shadowAt = now;
      this.shadowDirty = true;
    }
    this.rain.position.set(target.x, 0, target.z);
    this.snow.position.set(target.x, 0, target.z);
    let near = null, best = Infinity;
    for (const d of Object.values(this.districts)) {
      const k = Math.hypot(d.group.position.x - target.x, d.group.position.z - target.z);
      if (k < best) { best = k; near = d; }
    }
    if (near && near !== this.near) {
      this.near = near;
      this.nightSpots.forEach(([x, z], i) => this.nightLights[i].position.set(near.group.position.x + x, 3, near.group.position.z + z));
      this.nightLights[1].color.set(near.accent).lerp(col('#ffffff'), 0.4);
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
    this.full = new THREE.Group(); // 细节模型
    this.lod = new THREE.Group(); // 拉远后的简化方块
    this.group.add(this.full, this.lod);
    this.factories = [];
    this.belts1 = [];
    this.beltSpeed = {};
    this.beltSamples = [];
    this.frames = []; // 窗框与窗台
    this.ao = []; // 接触阴影
    // 物流状态：工作台、托盘、已发货托数
    this.bench = [];
    this.pallet = [];
    this.shipped = 0;
    this.activeSlots = new Set();
    // 项目 → 车间槽位
    this.slots = new Array(SLOT_Z.length).fill(null);
    this.slotUsed = new Array(SLOT_Z.length).fill(0);

    this.buildGround();
    this.buildFactories();
    this.buildBelts();
    this.buildHub();
    this.buildPlaza();
    this.buildPond();
    this.buildPaths();
    this.buildLamps();
    this.buildTrees();
    this.buildFlowers();
    this.buildCart();
    this.buildAO();
    this.buildLod(meta.name);
    mergeStatic(this.full);
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

  // ---------- 地面 ----------
  buildGround() {
    const [top, ...rest] = groundMeshes(this.world);
    top.userData.pick = { kind: 'district', agent: this.agent };
    this.world.pickables.push(top);
    this.full.add(top, ...rest);
  }

  // ---------- 工厂 ----------
  buildFactories() {
    const floor = mesh(new RoundedBoxGeometry(12.5, 0.2, 43, 2, 0.08), std('#e4ddcf'), { x: -24.75, y: 0.0, cast: false });
    this.full.add(floor);
    const lines = new THREE.MeshBasicMaterial({ color: '#cfc6b4' });
    for (const z of SLOT_Z) {
      const l = mesh(new THREE.PlaneGeometry(12, 0.08), lines, { x: -24.75, y: 0.105, z: z + 3, cast: false });
      l.rotation.x = -Math.PI / 2;
      this.full.add(l);
    }
    SLOT_Z.forEach((z, i) => this.factories.push(this.makeFactory(i, FACTORY_X, z)));
    this.full.add(instanced(unitBox, std('#ffffff', { roughness: 0.6 }), this.frames, false));

    // 车间背后的货架：立柱、隔板、纸箱
    const r = rng(17), ups = [], boards = [], boxes = [];
    const rx = FACTORY_X - 4.3;
    for (const z of SLOT_Z) {
      for (const dx of [-0.45, 0.45]) for (const dz of [-1.15, 1.15]) ups.push([rx + dx, 0.95, z + dz, 0.08, 1.7, 0.08]);
      for (const y of [0.35, 0.95, 1.55]) boards.push([rx, 0.1 + y, z, 1.0, 0.06, 2.4]);
      for (const y of [0.35, 0.95]) for (const dz of [-0.75, 0, 0.75]) {
        if (r() < 0.25) continue;
        const k = 0.42 + r() * 0.16;
        boxes.push([rx + (r() - 0.5) * 0.15, 0.13 + y + k / 2, z + dz, k, k * (0.8 + r() * 0.3), k, (r() - 0.5) * 0.3]);
      }
    }
    const steel = std('#5b7fa6', { metalness: 0.4, roughness: 0.45 });
    this.full.add(instanced(unitBox, steel, ups), instanced(unitBox, std('#e9ecef', { metalness: 0.2, roughness: 0.5 }), boards));
    const kraft = instanced(new RoundedBoxGeometry(1, 1, 1, 2, 0.08), std('#ffffff', { roughness: 0.75 }), boxes);
    boxes.forEach((_, i) => kraft.setColorAt(i, col(['#d9b98c', '#cfa877', '#e3c79d'][i % 3])));
    this.full.add(kraft);

    // 厂区栏杆：北、南、西三面，东面留给传送带
    const posts = [], rails = [];
    const fx0 = -30.7, fx1 = -19, fz = 21.2;
    for (let x = fx0; x <= fx1; x += 1.3) for (const s of [-1, 1]) posts.push([x, 0.48, s * fz, 0.1, 0.76, 0.1]);
    for (let z = -fz; z <= fz; z += 1.3) posts.push([fx0, 0.48, z, 0.1, 0.76, 0.1]);
    for (const y of [0.5, 0.82]) {
      for (const s of [-1, 1]) rails.push([(fx0 + fx1) / 2, y, s * fz, fx1 - fx0, 0.06, 0.06]);
      rails.push([fx0, y, 0, 0.06, 0.06, fz * 2]);
    }
    this.full.add(instanced(unitBox, std('#f2c26b', { roughness: 0.5 }), posts), instanced(unitBox, std('#f2c26b', { roughness: 0.5 }), rails));
  }

  makeFactory(slot, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0.1, z);
    const cream = std('#f5efe4');
    const roof = std(ROOF_COLORS[slot % ROOF_COLORS.length], { roughness: 0.7 });
    const trim = std('#e2d6c3');
    const windows = [];
    const win = (wx, wy, wz, w = 0.5, h = 0.55, side = 'x') => {
      const m = mesh(new THREE.BoxGeometry(side === 'x' ? 0.06 : w, h, side === 'x' ? w : 0.06), this.world.winOff, { x: wx, y: wy, z: wz, cast: false });
      windows.push(m);
      const X = x + wx, Y = 0.1 + wy, Z = z + wz;
      if (side === 'x') this.frames.push([X - 0.01, Y, Z, 0.05, h + 0.14, w + 0.14], [X + 0.05, Y - h / 2 - 0.05, Z, 0.16, 0.06, w + 0.22]);
      else this.frames.push([X, Y, Z - 0.01, w + 0.14, h + 0.14, 0.05], [X, Y - h / 2 - 0.05, Z + 0.05, w + 0.22, 0.06, 0.16]);
    };
    const variant = slot % 3;
    let chimneyTop;
    if (variant === 0) {
      g.add(mesh(new RoundedBoxGeometry(3.6, 2.4, 3.8, 2, 0.1), cream, { y: 1.2 }));
      const r = 2.45;
      const rg = new THREE.CylinderGeometry(r, r, 4.3, 3).rotateX(-Math.PI / 2).scale(1, 0.45, 1);
      g.add(mesh(rg, roof, { y: 2.4 + r * 0.5 * 0.45 }));
      g.add(mesh(new THREE.BoxGeometry(3.75, 0.12, 3.95), trim, { y: 2.38 })); // 屋檐
      g.add(mesh(new THREE.BoxGeometry(0.5, 1.2, 0.5), std('#c9b8a4'), { x: -0.8, y: 3.4, z: 1.1 }));
      chimneyTop = new THREE.Vector3(-0.8, 4.1, 1.1);
      for (const wz of [-1.1, 1.1]) win(1.81, 1.6, wz);
      win(0, 1.5, 1.91, 0.6, 0.55, 'z'); win(-1, 1.5, 1.91, 0.6, 0.55, 'z');
    } else if (variant === 1) {
      g.add(mesh(new RoundedBoxGeometry(3.4, 2, 3.4, 2, 0.1), cream, { x: 0.3, y: 1 }));
      g.add(mesh(new RoundedBoxGeometry(3.6, 0.25, 3.6, 2, 0.08), roof, { x: 0.3, y: 2.1 }));
      g.add(mesh(new THREE.BoxGeometry(3.5, 0.12, 3.5), trim, { x: 0.3, y: 1.94 }));
      for (const [sx, sz, h] of [[-1.5, -1.0, 3.6], [-1.5, 1.0, 3.0]]) {
        g.add(mesh(new THREE.CylinderGeometry(0.75, 0.75, h, 20), std('#e7e2d8', { metalness: 0.2, roughness: 0.5 }), { x: sx, y: h / 2, z: sz }));
        g.add(mesh(new THREE.ConeGeometry(0.85, 0.7, 20), roof, { x: sx, y: h + 0.35, z: sz }));
      }
      chimneyTop = new THREE.Vector3(-1.5, 4.4, -1.0);
      for (const wz of [-0.8, 0.8]) win(2.01, 1.2, wz);
    } else {
      g.add(mesh(new RoundedBoxGeometry(3, 3.6, 3.2, 2, 0.1), cream, { y: 1.8 }));
      g.add(mesh(new RoundedBoxGeometry(3.3, 0.3, 3.5, 2, 0.08), roof, { y: 3.7 }));
      g.add(mesh(new THREE.BoxGeometry(3.15, 0.12, 3.35), trim, { y: 3.5 }));
      g.add(mesh(new THREE.BoxGeometry(3.08, 0.08, 3.28), trim, { y: 2.0 })); // 楼层腰线
      g.add(mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.9, 16), std('#d8d0c2'), { x: -0.5, y: 4.3, z: -0.6 }));
      g.add(mesh(new THREE.ConeGeometry(0.62, 0.4, 16), roof, { x: -0.5, y: 4.95, z: -0.6 }));
      chimneyTop = new THREE.Vector3(0.7, 4.1, 0.9);
      g.add(mesh(new THREE.BoxGeometry(0.4, 0.7, 0.4), std('#c9b8a4'), { x: 0.7, y: 4.1, z: 0.9 }));
      for (const wy of [1.4, 2.6]) for (const wz of [-0.8, 0.8]) win(1.51, wy, wz, 0.5, 0.6);
    }
    // 窗户合成一个网格，亮灯时整体换材质
    const glass = mesh(mergeGeometries(windows.map((w) => { w.updateMatrix(); return w.geometry.applyMatrix4(w.matrix); })), this.world.winOff, { cast: false });
    glass.userData.live = true;
    g.add(glass);
    windows.length = 0;
    windows.push(glass);
    // 卷帘门与装货台
    g.add(mesh(new THREE.BoxGeometry(0.08, 1.1, 1.2), std('#7d8796', { metalness: 0.3 }), { x: variant === 1 ? 2.02 : variant === 0 ? 1.82 : 1.52, y: 0.55, z: 0 }));
    g.add(mesh(new RoundedBoxGeometry(1.4, 0.5, 1.6, 2, 0.05), std('#d6cfc2'), { x: 2.5, y: 0.25, z: 0 }));
    g.add(mesh(new THREE.BoxGeometry(0.06, 0.62, 1.4), std('#7d8796', { metalness: 0.3 }), { x: 3.17, y: 0.3, z: 0 })); // 装货台护板
    this.ao.push([x, 0.105, z, 6, 1, 6], [x + 2.5, 0.105, z, 2.2, 1, 2.4]);
    // 状态灯
    const lampMat = lambert({ color: '#9aa0a6', emissive: '#9aa0a6', emissiveIntensity: 0 });
    lampMat.userData.live = true;
    const beacon = mesh(new THREE.SphereGeometry(0.2, 16, 12), lampMat, { x: 1.2, y: variant === 2 ? 4.05 : variant === 1 ? 2.45 : 3.6, z: -1.2, cast: false });
    g.add(beacon);
    // 烟
    const smokeMat = lambert({ color: '#ffffff', transparent: true, opacity: 0.7, roughness: 1, depthWrite: false });
    const puffs = [0, 1, 2, 3].map((k) => {
      const p = mesh(new THREE.SphereGeometry(0.35, 12, 8), smokeMat.clone(), { cast: false, receive: false });
      p.userData.phase = k / 4;
      p.visible = false;
      g.add(p);
      return p;
    });
    // 名牌
    const el = document.createElement('div');
    el.className = 'label pill factory-pill empty';
    el.innerHTML = '<i></i><b>空闲车间</b><em></em>';
    el.dataset.slot = slot;
    el.dataset.agent = this.agent;
    const label = new CSS2DObject(el);
    label.position.set(0.5, 5.6, 0);
    g.add(label);

    g.userData.pick = { kind: 'factory', agent: this.agent, slot };
    this.full.add(g);
    this.world.pickables.push(g);
    return { group: g, roof, windows, beacon, lampMat, puffs, chimneyTop, el, info: null, roofColor: ROOF_COLORS[slot % ROOF_COLORS.length] };
  }

  /** info: {name, count, status, color} 或 null（空闲车间） */
  setFactory(slot, info) {
    const f = this.factories[slot];
    if (!f) return;
    f.info = info;
    f.el.classList.toggle('empty', !info);
    f.el.querySelector('b').textContent = info ? info.name : '空闲车间';
    f.el.querySelector('em').textContent = info?.count ? String(info.count) : '';
    f.el.querySelector('i').style.background = info?.statusColor || '#c2c6cc';
    f.el.title = info?.title || '';
    f.roof.color.set(info ? f.roofColor : '#c4c7cc');
    for (const w of f.windows) w.material = info && info.active ? this.world.winOn : this.world.winOff;
    f.lampMat.color.set(info?.statusColor || '#9aa0a6');
    f.lampMat.emissive.set(info?.statusColor || '#9aa0a6');
    f.status = info?.status || 'idle';
  }

  // ---------- 传送带 ----------
  beltTexture() {
    const t = once('belt', () => canvasTex(128, 64, (g, w, h) => {
      g.fillStyle = '#4b505b'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#5d6370';
      for (let i = 0; i < 2; i++) {
        const x0 = i * 64;
        g.beginPath(); g.moveTo(x0 + 10, 8); g.lineTo(x0 + 34, h / 2); g.lineTo(x0 + 10, h - 8); g.lineTo(x0 + 22, h - 8); g.lineTo(x0 + 46, h / 2); g.lineTo(x0 + 22, 8); g.fill();
      }
      g.fillStyle = '#3c4049'; g.fillRect(0, 0, w, 5); g.fillRect(0, h - 5, w, 5);
    }, [0.5, 1])).clone(); // 共用画布，各自滚动 offset
    t.needsUpdate = true;
    return t;
  }

  makeBelt(points, key, railColor) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const pts = curve.getSpacedPoints(Math.ceil(curve.getLength() * 3));
    const tex = this.beltTexture();
    const top = mesh(ribbon(pts, 1.1, 0), std('#ffffff', { map: tex, roughness: 0.6 }), { cast: false });
    const base = mesh(ribbon(pts, 1.45, -0.14), std('#aeb4bd', { metalness: 0.3, roughness: 0.5 }));
    const railMat = std(railColor, { metalness: 0.35, roughness: 0.4 });
    // 底座和护栏直接挂在街区下，好和其他传送带合并；支腿和滚筒攒起来最后一次实例化
    this.full.add(top, base);
    for (const d of [0.66, -0.66]) {
      const c = offsetCurve(pts, d, 0.12);
      this.full.add(mesh(new THREE.TubeGeometry(c, pts.length, 0.07, 6), railMat));
    }
    const len = curve.getLength();
    for (let s = 1.2; s < len - 0.8; s += 2.6) {
      const p = curve.getPointAt(s / len);
      this.legs.push([p.x, (BELT_Y - 0.1) / 2, p.z]);
    }
    // 滚筒：夹在带面与底座之间，两端从侧面露出来
    for (let s = 0.4; s < len - 0.3; s += 0.7) {
      const p = curve.getPointAt(s / len), tan = curve.getTangentAt(s / len);
      this.rollers.push([p.x, p.y - 0.1, p.z, 1, 1, 1, -Math.atan2(tan.z, tan.x)]);
    }
    for (const p of pts) this.beltSamples.push(p);
    this.beltSpeed[key] = 0;
    return { curve, len, tex, key };
  }

  buildBelts() {
    this.legs = [];
    this.rollers = [];
    SLOT_Z.forEach((z, i) => {
      const th = Math.PI - (z / 18) * 0.75;
      const end = new THREE.Vector3(HUB.x + (HUB.r + 0.15) * Math.cos(th), TOP, HUB.z + (HUB.r + 0.15) * Math.sin(th));
      const pre = new THREE.Vector3(HUB.x + (HUB.r + 2.6) * Math.cos(th), TOP, HUB.z + (HUB.r + 2.6) * Math.sin(th));
      const pts = [
        new THREE.Vector3(FACTORY_X + 3.3, TOP, z),
        new THREE.Vector3(-17.5, TOP, z),
        new THREE.Vector3((-17.5 + pre.x) / 2, TOP, (z + pre.z) / 2 + (z - pre.z) * 0.12),
        pre, end,
      ];
      const b = this.makeBelt(pts, `f${i}`, '#cfd4dc');
      b.angle = th;
      this.belts1.push(b);
    });
    {
      const p = PLAZA;
      const dir = new THREE.Vector3(p.x - HUB.x, 0, p.z - HUB.z).normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const start = new THREE.Vector3(HUB.x, TOP, HUB.z).addScaledVector(dir, HUB.r + 0.15);
      const end = new THREE.Vector3(p.x, TOP, p.z).addScaledVector(dir, -(p.r - 1.4));
      const mid = start.clone().lerp(end, 0.5).addScaledVector(perp, -0.9);
      const pts = [start, start.clone().addScaledVector(dir, 1.6), mid, end.clone().addScaledVector(dir, -1.6), end];
      const b = this.makeBelt(pts, 'out', this.accent);
      b.angle = Math.atan2(dir.z, dir.x);
      this.belt2 = b;
    }
    this.full.add(
      instanced(new THREE.CylinderGeometry(0.1, 0.14, BELT_Y - 0.1, 8), std('#8d939d', { metalness: 0.4 }), this.legs),
      instanced(new THREE.CylinderGeometry(0.08, 0.08, 1.58, 10).rotateX(Math.PI / 2), std('#c3c8cf', { metalness: 0.6, roughness: 0.3 }), this.rollers, false),
    );
  }

  setBeltSpeed(key, v) { this.beltSpeed[key] = v; }

  // ---------- 中转站 ----------
  buildHub() {
    const g = new THREE.Group();
    g.position.set(HUB.x, 0, HUB.z);
    g.add(mesh(new THREE.CylinderGeometry(HUB.r + 0.4, HUB.r + 0.6, TOP - 0.1, 48), std('#e9e3d7'), { y: (TOP - 0.1) / 2 }));
    const diskTex = once('disk', () => canvasTex(512, 512, (c, w) => {
      c.fillStyle = '#f4efe5'; c.fillRect(0, 0, w, w);
      c.translate(w / 2, w / 2);
      c.strokeStyle = '#dcd3c3'; c.lineWidth = 6;
      for (const r of [80, 150, 230]) { c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke(); }
      c.lineWidth = 3;
      for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * 80, Math.sin(a) * 80); c.lineTo(Math.cos(a) * 250, Math.sin(a) * 250); c.stroke(); }
      c.fillStyle = '#f2c26b';
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.beginPath(); c.arc(Math.cos(a) * 190, Math.sin(a) * 190, 9, 0, Math.PI * 2); c.fill(); }
    }));
    this.disk = mesh(new THREE.CylinderGeometry(HUB.r - 0.1, HUB.r - 0.1, 0.1, 64), [std('#e2dbcd'), std('#ffffff', { map: diskTex, roughness: 0.6 }), std('#e2dbcd')], { y: TOP - 0.05, cast: false });
    this.disk.userData.live = true;
    g.add(this.disk);
    // 中心柱
    g.add(mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.4, 24), std('#dfe6ee', { metalness: 0.4, roughness: 0.35 }), { y: TOP + 0.7 }));
    g.add(mesh(new THREE.TorusGeometry(0.78, 0.08, 8, 32).rotateX(Math.PI / 2), this.world.hubCore, { y: TOP + 1.2, cast: false }));
    // 玻璃穹顶
    const dome = mesh(new THREE.SphereGeometry(HUB.r + 0.05, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1),
      lambert({ color: '#e8f6ff', transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0, clearcoat: 1, depthWrite: false }), { y: TOP - 0.05, cast: false, receive: false });
    dome.renderOrder = 2;
    g.add(dome);
    const frame = std('#e4e9ef', { metalness: 0.55, roughness: 0.35 });
    for (let k = 0; k < 4; k++) {
      const m = mesh(new THREE.TorusGeometry(HUB.r + 0.05, 0.06, 6, 48, Math.PI).scale(1, 0.75, 1), frame, { y: TOP - 0.05, cast: false });
      m.rotation.y = (k * Math.PI) / 4 + Math.PI / 8;
      g.add(m);
    }
    g.add(mesh(new THREE.TorusGeometry(HUB.r + 0.05, 0.1, 8, 64).rotateX(Math.PI / 2), frame, { y: TOP }));
    g.add(mesh(new THREE.SphereGeometry(0.28, 16, 12), frame, { y: TOP - 0.05 + (HUB.r + 0.05) * 0.75 }));
    g.userData.pick = { kind: 'hub', agent: this.agent };
    this.ao.push([HUB.x, 0.02, HUB.z, (HUB.r + 1.6) * 2.4, 1, (HUB.r + 1.6) * 2.4]);
    this.full.add(g);
    this.world.pickables.push(g);

    const el = document.createElement('div');
    el.className = 'label pill hub-pill';
    el.innerHTML = '<b>中转站</b><span>在转 0 件</span>';
    this.hubLabel = new CSS2DObject(el);
    this.hubLabel.position.set(HUB.x, TOP + HUB.r * 0.75 + 1.6, HUB.z);
    this.full.add(this.hubLabel);
    this.hubEl = el;
  }

  setHubCount(n) { this.hubEl.querySelector('span').textContent = `在转 ${n} 件`; }

  // ---------- Agent 广场 ----------
  buildPlaza() {
    {
      const p = PLAZA, agent = this.agent, accent = this.accent;
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.z);
      g.add(mesh(new THREE.CylinderGeometry(p.r, p.r + 0.2, 0.5, 64), std('#ece4d6'), { y: 0.25 }));
      const tex = canvasTex(1024, 1024, (c, w) => {
        c.fillStyle = '#f3ece0'; c.fillRect(0, 0, w, w);
        c.translate(w / 2, w / 2);
        const rings = [[500, '#e6dccb'], [430, '#f6f0e6'], [360, '#ebe1d1'], [250, '#f7f2e9']];
        for (const [r, f] of rings) { c.fillStyle = f; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill(); }
        c.strokeStyle = 'rgba(0,0,0,0.06)'; c.lineWidth = 3;
        for (const [r] of rings) for (let i = 0; i < 36; i++) {
          const a = (i / 36) * Math.PI * 2;
          c.beginPath(); c.moveTo(Math.cos(a) * (r - 70), Math.sin(a) * (r - 70)); c.lineTo(Math.cos(a) * r, Math.sin(a) * r); c.stroke();
        }
        c.strokeStyle = accent; c.globalAlpha = 0.55; c.lineWidth = 14;
        c.beginPath(); c.arc(0, 0, 395, 0, Math.PI * 2); c.stroke();
        c.globalAlpha = 1;
      });
      const topm = mesh(new THREE.CircleGeometry(p.r - 0.02, 64), std('#ffffff', { map: tex, roughness: 0.9 }), { y: 0.505, cast: false });
      topm.rotation.x = -Math.PI / 2;
      g.add(topm);
      g.add(mesh(new THREE.TorusGeometry(p.r, 0.12, 8, 96).rotateX(Math.PI / 2), std(accent, { roughness: 0.5 }), { y: 0.5 }));
      this.full.add(g);

      const b = this.belt2;
      const dir = new THREE.Vector3(p.x - HUB.x, 0, p.z - HUB.z).normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const center = new THREE.Vector3(p.x, 0.5, p.z);
      const at = (a, c) => center.clone().addScaledVector(dir, a).addScaledVector(perp, c);
      const info = { agent, center, dir, perp, beltEnd: b.curve.getPointAt(1) };
      // 工作台
      info.bench = at(-3.0, 0);
      info.benchTop = 0.5 + 0.8;
      const bench = new THREE.Group();
      bench.position.copy(info.bench);
      bench.rotation.y = -Math.atan2(dir.z, dir.x);
      bench.add(mesh(new RoundedBoxGeometry(1.5, 0.14, 2.8, 2, 0.05), std('#c99a6b'), { y: 0.73 }));
      for (const [lx, lz] of [[-0.6, -1.25], [0.6, -1.25], [-0.6, 1.25], [0.6, 1.25]]) bench.add(mesh(new THREE.BoxGeometry(0.12, 0.66, 0.12), std('#9a7250'), { x: lx, y: 0.33, z: lz }));
      this.full.add(bench);
      // 托盘
      info.pallet = at(1.2, 3.6);
      info.palletTop = 0.5 + 0.32;
      const pallet = new THREE.Group();
      pallet.position.copy(info.pallet);
      pallet.rotation.y = -Math.atan2(dir.z, dir.x);
      const wood = std('#c8a274');
      for (const s of [-1, 0, 1]) pallet.add(mesh(new THREE.BoxGeometry(2.6, 0.14, 0.36), wood, { y: 0.07, z: s * 1.1 }));
      for (let s = -2; s <= 2; s++) pallet.add(mesh(new THREE.BoxGeometry(0.42, 0.08, 2.6), wood, { x: s * 0.55, y: 0.18 }));
      this.full.add(pallet);
      // 次品箱
      info.reject = at(-0.6, -4.0);
      const bin = new THREE.Group();
      bin.position.copy(info.reject);
      const red = std('#d0574b', { roughness: 0.6 });
      bin.add(mesh(new THREE.BoxGeometry(1.6, 0.12, 1.6), red, { y: 0.06 }));
      for (const [wx, wz, sx, sz] of [[0.74, 0, 0.12, 1.6], [-0.74, 0, 0.12, 1.6], [0, 0.74, 1.6, 0.12], [0, -0.74, 1.6, 0.12]]) bin.add(mesh(new THREE.BoxGeometry(sx, 1.0, sz), red, { x: wx, y: 0.5, z: wz }));
      this.full.add(bin);
      // 角色位置
      info.agentPos = at(0.9, -0.4);
      this.ao.push([p.x, 0.02, p.z, (p.r + 1.4) * 2.3, 1, (p.r + 1.4) * 2.3]);
      this.at = at;
      this.plaza = info;
    }
  }

  // ---------- 池塘 ----------
  buildPond() {
    const g = new THREE.Group();
    g.position.set(POND.x, 0, POND.z);
    const w = mesh(new THREE.CircleGeometry(POND.r, 64), this.world.waterMat, { y: 0.03, cast: false });
    w.rotation.x = -Math.PI / 2;
    g.add(w);
    const sand = mesh(new THREE.RingGeometry(POND.r - 0.1, POND.r + 0.5, 64), std('#d9cfb6'), { y: 0.02, cast: false });
    sand.rotation.x = -Math.PI / 2;
    g.add(sand);
    const r = rng(11);
    const peb = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), std('#b8b4ac'), 70);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2 + r() * 0.05, rad = POND.r + 0.25 + r() * 0.2, k = 0.16 + r() * 0.14;
      m.compose(v.set(Math.cos(a) * rad, 0.06, Math.sin(a) * rad), q.setFromEuler(new THREE.Euler(0, r() * 3, 0)), s.set(k * 1.3, k * 0.6, k));
      peb.setMatrixAt(i, m);
      peb.setColorAt(i, col(['#bdb8ae', '#a9a59c', '#cfcac0'][i % 3]));
    }
    peb.castShadow = true;
    g.add(peb);
    const padMat = std('#5d9d4c', { roughness: 0.7 });
    for (const [px, pz, pr] of [[-1.6, -0.8, 0.5], [1.2, 1.4, 0.42], [0.6, -1.9, 0.38], [-0.4, 1.9, 0.46], [2.2, -0.4, 0.34], [-2.3, 0.9, 0.4]]) {
      const pad = mesh(new THREE.CircleGeometry(pr, 20, 0.35, Math.PI * 2 - 0.7), padMat, { x: px, y: 0.05, z: pz, cast: false });
      pad.rotation.set(-Math.PI / 2, 0, px * 2);
      g.add(pad);
    }
    for (const [px, pz] of [[-1.6, -0.8], [-0.4, 1.9]]) g.add(mesh(new THREE.SphereGeometry(0.13, 10, 8), std('#f4a7c0'), { x: px, y: 0.12, z: pz }));
    this.full.add(g);
  }

  // ---------- 石板路与长椅 ----------
  buildPaths() {
    const tex = once('path', () => canvasTex(256, 128, (g, w, h) => {
      g.fillStyle = '#cfc6b5'; g.fillRect(0, 0, w, h);
      const r = rng(5);
      for (let y = 0; y < h; y += 32) for (let x = -(y / 32 % 2) * 24; x < w; x += 48) {
        g.fillStyle = ['#e6dfd1', '#ddd5c5', '#eae4d8'][Math.floor(r() * 3)];
        g.beginPath(); g.roundRect(x + 3, y + 3, 42, 26, 8); g.fill();
      }
    }, [1 / 3, 1]));
    const mat = std('#ffffff', { map: tex, roughness: 0.95 });
    this.pathSegs = [
      [[HUB.x + 1, HUB.z + HUB.r + 1.2], [POND.x - 0.5, POND.z - POND.r - 0.6]],
      [[PLAZA.x + 1, PLAZA.z + PLAZA.r], [PLAZA.x + 3, ISLAND.hd - 0.6]],
      [[PLAZA.x + 1, PLAZA.z - PLAZA.r], [PLAZA.x + 3, -ISLAND.hd + 0.6]],
      [[PLAZA.x + PLAZA.r, PLAZA.z + 2], [ISLAND.hw - 0.6, PLAZA.z + 5]],
      [[POND.x + POND.r + 0.5, POND.z + 1], [PLAZA.x - 3, PLAZA.z + PLAZA.r - 0.8]],
    ];
    for (const [[ax, az], [bx, bz]] of this.pathSegs) {
      const mx = (ax + bx) / 2 + (bz - az) * 0.08, mz = (az + bz) / 2 - (bx - ax) * 0.08;
      const c = new THREE.QuadraticBezierCurve3(new THREE.Vector3(ax, 0, az), new THREE.Vector3(mx, 0, mz), new THREE.Vector3(bx, 0, bz));
      this.full.add(mesh(ribbon(c.getSpacedPoints(40), 1.6, 0.015), mat, { cast: false }));
    }
    const ringM = mesh(new THREE.RingGeometry(HUB.r + 0.6, HUB.r + 1.6, 64), std('#dcd3c2', { roughness: 0.95 }), { x: HUB.x, y: 0.012, z: HUB.z, cast: false });
    ringM.rotation.x = -Math.PI / 2;
    this.full.add(ringM);
    // 长椅
    const wood = std('#b9875a'), iron = std('#4a4f59', { metalness: 0.5 });
    for (const [bx, bz, ry] of [[-0.6, 9.2, Math.PI / 2], [3.4, 9.6, -Math.PI / 2], [26.5, -3.2, 0], [10.5, 20.6, 0.3]]) {
      const g = new THREE.Group();
      g.position.set(bx, 0, bz); g.rotation.y = ry;
      g.add(mesh(new THREE.BoxGeometry(1.6, 0.08, 0.5), wood, { y: 0.45 }));
      g.add(mesh(new THREE.BoxGeometry(1.6, 0.4, 0.08), wood, { y: 0.72, z: -0.24 }));
      for (const lx of [-0.65, 0.65]) g.add(mesh(new THREE.BoxGeometry(0.08, 0.45, 0.45), iron, { x: lx, y: 0.22 }));
      this.full.add(g);
    }
  }

  onPath(x, z, pad = 1.2) {
    for (const [[ax, az], [bx, bz]] of this.pathSegs) {
      const dx = bx - ax, dz = bz - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz));
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) < pad) return true;
    }
    return false;
  }

  // ---------- 路灯 ----------
  buildLamps() {
    const post = std('#3d4350', { metalness: 0.5, roughness: 0.4 });
    for (const [x, z] of LAMPS) {
      this.full.add(mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.3, 8), post, { x, y: 1.15, z }));
      this.full.add(mesh(new THREE.CylinderGeometry(0.22, 0.14, 0.12, 12), post, { x, y: 2.36, z }));
      this.full.add(mesh(new THREE.SphereGeometry(0.2, 14, 10), this.world.lampHead, { x, y: 2.5, z, cast: false }));
      const d = mesh(new THREE.PlaneGeometry(5, 5), this.world.decalMat, { x, y: 0.05, z, cast: false, receive: false });
      d.rotation.x = -Math.PI / 2;
      d.renderOrder = 1;
      this.full.add(d);
    }
  }

  // ---------- 树林 ----------
  buildTrees() {
    const r = rng(42);
    const spots = [];
    const step = 1.75;
    for (let x = -ISLAND.hw + 0.9; x < ISLAND.hw - 0.5; x += step) {
      for (let z = -ISLAND.hd + 0.9; z < ISLAND.hd - 0.5; z += step) {
        const tx = x + (r() - 0.5) * 1.3, tz = z + (r() - 0.5) * 1.3;
        if (r() < 0.12) continue;
        if (blocked(tx, tz, 0.4) || this.onPath(tx, tz)) continue;
        spots.push([tx, tz, 0.7 + r() * 0.6, r()]);
      }
    }
    for (const [x, z, k] of spots) this.ao.push([x, 0.02, z, k * 2.8, 1, k * 2.8]);
    this.full.add(...forest(spots, r, this.world.capMat));
  }

  buildFlowers() {
    const r = rng(99);
    const pos = [];
    const inField = (x, z) => x >= -18.5 && x < HUB.x - HUB.r + 1 && Math.abs(z) < 19.5;
    const nearBelt = (x, z) => this.beltSamples.some((p) => Math.abs(p.x - x) < 1.3 && Math.abs(p.z - z) < 1.3);
    let tries = 0;
    while (pos.length < 120 && tries++ < 3000) {
      const x = (r() * 2 - 1) * (ISLAND.hw - 2), z = (r() * 2 - 1) * (ISLAND.hd - 2);
      const ok = inField(x, z) ? !nearBelt(x, z) : !blocked(x, z, 0.2) && !this.onPath(x, z, 1);
      if (ok) pos.push([x, z]);
    }
    const colors = ['#b9a3e3', '#a88fdc', '#f3d1e0', '#fff1b8', '#ffffff'];
    const n = pos.length * 9;
    const fl = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), std('#ffffff', { roughness: 0.6 }), n);
    const bush = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), std('#ffffff', { roughness: 0.85 }), pos.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();
    let k = 0;
    pos.forEach(([x, z], i) => {
      const c = colors[i % colors.length];
      const isBush = i % 4 === 0;
      if (isBush) {
        const b = 0.35 + r() * 0.3;
        m.compose(v.set(x, b * 0.6, z), q.identity(), s.set(b, b * 0.75, b));
        bush.setMatrixAt(i, m);
        bush.setColorAt(i, col(['#6fae58', '#5d9b4e', '#7cbc64'][i % 3]));
      } else {
        m.makeScale(0, 0, 0); bush.setMatrixAt(i, m); bush.setColorAt(i, col('#000'));
      }
      for (let j = 0; j < 9; j++) {
        const a = r() * Math.PI * 2, d = r() * 0.8, sz = 0.09 + r() * 0.06;
        m.compose(v.set(x + Math.cos(a) * d, 0.12 + r() * 0.12, z + Math.sin(a) * d), q.identity(), s.set(sz, sz, sz));
        fl.setMatrixAt(k, m); fl.setColorAt(k, col(c)); k++;
      }
    });
    fl.receiveShadow = true;
    bush.castShadow = true;
    this.full.add(fl, bush);
  }

  // ---------- 广场小推车与空托盘 ----------
  buildCart() {
    const g = new THREE.Group();
    g.position.copy(this.at(-1.7, 4.2));
    g.rotation.y = 0.5;
    const metal = std('#4a5260', { metalness: 0.5, roughness: 0.4 });
    g.add(mesh(new RoundedBoxGeometry(1.1, 0.08, 0.7, 2, 0.03), std(this.accent, { roughness: 0.5 }), { y: 0.3 }));
    for (const z of [-0.3, 0.3]) {
      g.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 14).rotateX(Math.PI / 2), metal, { x: 0.38, y: 0.12, z }));
      g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 10).rotateX(Math.PI / 2), metal, { x: -0.42, y: 0.08, z }));
      g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6), metal, { x: -0.55, y: 0.66, z }));
    }
    g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.66, 6).rotateX(Math.PI / 2), metal, { x: -0.55, y: 1.03 }));
    g.add(mesh(new RoundedBoxGeometry(0.55, 0.45, 0.5, 2, 0.06), std('#d9b98c'), { x: 0.1, y: 0.57 }));
    this.full.add(g);
    // 叠起来的空托盘
    const stack = new THREE.Group();
    stack.position.copy(this.at(-4.4, 3.2));
    stack.rotation.y = 0.2;
    const wood = std('#c8a274');
    for (let k = 0; k < 3; k++) {
      for (const s of [-1, 0, 1]) stack.add(mesh(new THREE.BoxGeometry(1.4, 0.1, 0.22), wood, { y: 0.05 + k * 0.2, z: s * 0.55 }));
      for (const s of [-1, 0, 1]) stack.add(mesh(new THREE.BoxGeometry(0.26, 0.06, 1.4), wood, { x: s * 0.55, y: 0.13 + k * 0.2 }));
    }
    this.full.add(stack);
  }

  // ---------- 接触阴影：建筑、树、广场底下压一圈柔和的暗 ----------
  buildAO() {
    for (const [x, z] of LAMPS) this.ao.push([x, 0.02, z, 1.4, 1, 1.4]);
    this.full.add(aoBlobs(this.ao));
  }

  // ---------- 远景简化 ----------
  buildLod(name) {
    const ground = mesh(once('lodGeo', () => new THREE.BoxGeometry(DISTRICT.w, 0.8, DISTRICT.d)), once('lodMat', () => std('#93c46e')), { y: -0.4, cast: false });
    ground.userData.pick = { kind: 'district', agent: this.agent };
    this.world.pickables.push(ground);
    this.lod.add(ground);
    this.lod.add(mesh(new THREE.BoxGeometry(11, 3, 42), std('#f5efe4'), { x: FACTORY_X, y: 1.5, cast: false }));
    this.lod.add(mesh(new THREE.BoxGeometry(18, 0.3, 1.2), std('#5d6370'), { x: (HUB.x + PLAZA.x) / 2, y: 0.4, cast: false }));
    this.lod.add(mesh(new THREE.CylinderGeometry(HUB.r, HUB.r, 1.5, 24), std('#e9e3d7'), { x: HUB.x, y: 0.75, z: HUB.z, cast: false }));
    this.lod.add(mesh(new THREE.CylinderGeometry(PLAZA.r, PLAZA.r, 0.6, 32), std(this.accent), { x: PLAZA.x, y: 0.3, z: PLAZA.z, cast: false }));
    const el = document.createElement('div');
    el.className = 'label pill lod-pill';
    el.innerHTML = `<i></i><b></b><span></span>`;
    el.querySelector('b').textContent = name;
    el.dataset.agent = this.agent;
    const label = new CSS2DObject(el);
    label.position.set(0, 6, 0);
    this.lod.add(label);
    this.lodEl = el;
    this.lod.visible = false;
  }

  /** 远景名牌上的状态灯与文字 */
  setLod(color, text) {
    this.lodEl.querySelector('i').style.background = color;
    this.lodEl.querySelector('span').textContent = text;
  }

  update(dt, t) {
    // 传送带纹理滚动（贴图 repeat 0.5 → 1 米 = 0.5 个周期）
    for (const b of [...this.belts1, this.belt2]) b.tex.offset.x -= (this.beltSpeed[b.key] || 0) * dt * 0.5;
    this.disk.rotation.y -= dt * (this.hubSpin ?? 0.35);

    // 工厂状态灯与烟
    for (const f of this.factories) {
      const st = f.status;
      const pulse = st === 'waiting' ? 0.5 + 0.5 * Math.sin(t * 6) : st === 'working' ? 0.6 + 0.4 * Math.sin(t * 3) : 0.15;
      f.lampMat.emissiveIntensity = f.info ? pulse * 2 : 0;
      const smoking = st === 'working';
      for (const p of f.puffs) {
        p.visible = smoking;
        if (!smoking) continue;
        const ph = (t * 0.35 + p.userData.phase) % 1;
        p.position.set(f.chimneyTop.x + ph * 0.8, f.chimneyTop.y + ph * 2.4, f.chimneyTop.z - ph * 0.3);
        p.scale.setScalar(0.4 + ph * 1.1);
        p.material.opacity = 0.65 * (1 - ph);
      }
    }
  }
}

/** 街区之间的空地：只有树林，远看是一块绿地 */
class Wild {
  constructor(world, [x, z]) {
    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    this.full = new THREE.Group();
    this.lod = new THREE.Group();
    this.group.add(this.full, this.lod);
    this.full.add(...groundMeshes(world));
    const r = rng(hash(`${x},${z}`));
    // 一两片空地留成草坪，其余种满树
    const glades = [0, 1].map(() => [(r() - 0.5) * ISLAND.hw * 1.2, (r() - 0.5) * ISLAND.hd * 1.2, 5 + r() * 5]);
    const spots = [];
    for (let tx = -ISLAND.hw + 0.9; tx < ISLAND.hw - 0.5; tx += 1.9) for (let tz = -ISLAND.hd + 0.9; tz < ISLAND.hd - 0.5; tz += 1.9) {
      const px = tx + (r() - 0.5) * 1.3, pz = tz + (r() - 0.5) * 1.3;
      if (r() < 0.15 || glades.some(([gx, gz, gr]) => Math.hypot(px - gx, pz - gz) < gr)) continue;
      spots.push([px, pz, 0.7 + r() * 0.6, r()]);
    }
    this.full.add(...forest(spots, r, world.capMat), aoBlobs(spots.map(([sx, sz, k]) => [sx, 0.02, sz, k * 2.8, 1, k * 2.8])));
    this.lod.add(mesh(once('lodGeo', () => new THREE.BoxGeometry(DISTRICT.w, 0.8, DISTRICT.d)), once('lodMat', () => std('#93c46e')), { y: -0.4, cast: false }));
    this.lod.visible = false;
  }
}
