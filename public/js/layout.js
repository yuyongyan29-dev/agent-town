// 街区布局常量（街区局部坐标）：环境装饰与物流线共用同一份坐标；每个 agent 一个街区
export const ISLAND = { hw: 36, hd: 26 };
export const HUB = { x: -2, z: 0, r: 4.8 };
export const PLAZA = { x: 16, z: 0, r: 6.5 };
export const DISTRICT = { w: ISLAND.hw * 2, d: ISLAND.hd * 2 }; // 画布网格：街区一格一个，边挨着边
export const FACTORY_X = -25;
export const SLOT_Z = [-18, -12, -6, 0, 6, 12, 18];
export const POND = { x: 1, z: 16, r: 3.8 };
export const BELT_Y = 0.75;
export const CAMERA_HOME = { pos: [22, 50, 56], target: [-4, 0, 1] };
export const LAMPS = [
  [-18, -21.5], [-18, 21.5], [-4, -8], [-4, 8], [6.5, 3.2], [26, 0.5], [8, -17.5], [8, 18.5],
  [-3.5, 20.5], [5.8, 12.2], [28, -20], [28, 20.5], [-29, -23], [-29, 23],
];

function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

/** 该位置是否被建筑、传送带或水面占用（种树、摆装饰时避开） */
export function blocked(x, z, pad = 0) {
  if (Math.abs(x) > ISLAND.hw - 0.8 - pad || Math.abs(z) > ISLAND.hd - 0.8 - pad) return true;
  if (Math.hypot(x - HUB.x, z - HUB.z) < HUB.r + 1.8 + pad) return true;
  if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < PLAZA.r + 1.2 + pad) return true;
  if (segDist(x, z, HUB.x, HUB.z, PLAZA.x, PLAZA.z) < 1.6 + pad) return true;
  if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 0.9 + pad) return true;
  if (x < -18.5 && x > -31 && Math.abs(z) < 21.5) return true; // 工厂区
  if (x >= -18.5 && x < HUB.x - HUB.r + 1 && Math.abs(z) < 19.5 + pad) return true; // 进料传送带
  for (const [lx, lz] of LAMPS) if (Math.hypot(x - lx, z - lz) < 0.9 + pad) return true;
  return false;
}
