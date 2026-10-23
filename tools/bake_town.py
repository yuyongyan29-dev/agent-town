# 用 Blender 生成小镇的 3D 模型：程序化建模 → Cycles 把光照、阴影、环境光遮蔽烘焙进贴图 → 导出 GLB。
# 网页里只用不受光照的材质显示烘焙贴图，不再实时算光影，GPU 只做最基本的贴图绘制。
# 用法：npm run assets（等价于 Blender -b -P tools/bake_town.py -- public/assets [--quick]）
# 世界坐标与网页一致：x 向右，y 向上，z 朝南（朝镜头）；写入 Blender 时换成 (x, -z, y)。
# 写实路线：真实天空光 + 带纹理和凹凸的材质（砖、彩钢瓦、混凝土、镀锌钢、橡胶、木纹、铺路石、纸箱），树冠用噪声置换出起伏。
import bpy, bmesh, math, json, os, sys, random
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(next((a for a in ARGS if not a.startswith('--')), 'public/assets'))
QUICK = '--quick' in ARGS
os.makedirs(OUT, exist_ok=True)

# ---------- 布局（网页从 town.json 读同一份） ----------
HW, HD = 36, 26
HUB = dict(x=-2, z=0, r=4.8)
PLAZA = dict(x=16, z=0, r=6.5)
FACTORY_X = -25
SLOT_Z = [-18, -12, -6, 0, 6, 12, 18]
POND = dict(x=1, z=16, r=3.8)
BELT_Y = 0.75
LAMPS = [(-18, -21.5), (-18, 21.5), (-4, -8), (-4, 8), (7, 5), (26, 0.5), (8, -17.5), (8, 18.5),
         (-3.5, 20.5), (5.8, 12.2), (28, -20), (28, 20.5), (-29, -23), (-29, 23)]
ROOF_COLORS = ['#5b7fa6', '#b5523b', '#4f8a6a', '#c9962e', '#7d6aa8', '#3f8fa3', '#b56a7a']  # 彩钢瓦常见的几种漆色
CAT = {'read': '#3f86e0', 'edit': '#f07b2a', 'bash': '#7d8796', 'web': '#3aa86a', 'task': '#8a5cf0', 'other': '#2fb0aa', 'error': '#d63a35'}

SUN = Vector((0.55, -0.8, -0.25)).normalized()  # 阳光行进方向（世界坐标）：从左后上方照过来


def bl(x, y, z):
    return Vector((x, -z, y))


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1]


def shade(h, k):
    """把十六进制颜色按比例变亮（k>1）或变暗（k<1）"""
    h = h.lstrip('#')
    return '#' + ''.join(f'{max(0, min(255, round(int(h[i:i + 2], 16) * k))):02x}' for i in (0, 2, 4))


# ---------- 材质库 ----------
LIB = {}


def pbr(key, base, rough=0.8, metal=0.0, pattern='noise', scale=2.0, bump=0.0, vary=None, emit=0.0, emit_color=None,
        alpha=1.0, transmission=0.0, coat=0.0, sss=0.0, hue=0.0, mortar=None):
    """通用写实材质。pattern：noise（斑驳）/ brick（砌块）/ wave（瓦楞、卷帘）/ stone（铺路石）/ wood（木纹）/ flat"""
    if key in LIB:
        return LIB[key]
    m = bpy.data.materials.new(key)
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    p = N['Principled BSDF']
    tc = N.new('ShaderNodeTexCoord')
    vec = tc.outputs['Object']
    vary = vary or shade(base, 0.85)
    color = height = None
    if pattern == 'brick':
        # 竖直墙面：水平方向用 x+y，竖直方向用 z，两个朝向的墙都能铺上
        sep = N.new('ShaderNodeSeparateXYZ'); L.new(vec, sep.inputs[0])
        add = N.new('ShaderNodeMath'); add.operation = 'ADD'; L.new(sep.outputs[0], add.inputs[0]); L.new(sep.outputs[1], add.inputs[1])
        comb = N.new('ShaderNodeCombineXYZ'); L.new(add.outputs[0], comb.inputs[0]); L.new(sep.outputs[2], comb.inputs[1])
        br = N.new('ShaderNodeTexBrick')
        br.inputs['Color1'].default_value = srgb(base); br.inputs['Color2'].default_value = srgb(vary)
        br.inputs['Mortar'].default_value = srgb(mortar or '#cfc8bb')
        br.inputs['Scale'].default_value = scale; br.inputs['Mortar Size'].default_value = 0.015
        L.new(comb.outputs[0], br.inputs['Vector'])
        color, height = br.outputs['Color'], br.outputs['Fac']
    elif pattern == 'wave':
        wv = N.new('ShaderNodeTexWave'); wv.wave_type = 'BANDS'; wv.bands_direction = 'Y'
        wv.inputs['Scale'].default_value = scale; wv.inputs['Distortion'].default_value = 0
        L.new(vec, wv.inputs['Vector'])
        nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 3; L.new(vec, nz.inputs['Vector'])
        rp = N.new('ShaderNodeValToRGB'); rp.color_ramp.elements[0].color = srgb(vary); rp.color_ramp.elements[1].color = srgb(base)
        L.new(nz.outputs['Fac'], rp.inputs['Fac'])
        color, height = rp.outputs['Color'], wv.outputs['Fac']
    elif pattern == 'stone':
        v1 = N.new('ShaderNodeTexVoronoi'); v1.inputs['Scale'].default_value = scale; L.new(vec, v1.inputs['Vector'])
        v2 = N.new('ShaderNodeTexVoronoi'); v2.feature = 'DISTANCE_TO_EDGE'; v2.inputs['Scale'].default_value = scale; L.new(vec, v2.inputs['Vector'])
        rp = N.new('ShaderNodeValToRGB'); rp.color_ramp.elements[0].color = srgb(vary); rp.color_ramp.elements[1].color = srgb(base)
        bw = N.new('ShaderNodeSeparateColor'); L.new(v1.outputs['Color'], bw.inputs[0]); L.new(bw.outputs[0], rp.inputs['Fac'])
        gr = N.new('ShaderNodeValToRGB')  # 石缝
        gr.color_ramp.elements[0].position = 0.0; gr.color_ramp.elements[0].color = srgb(mortar or shade(vary, 0.7))
        gr.color_ramp.elements[1].position = 0.06; gr.color_ramp.elements[1].color = (1, 1, 1, 1)
        L.new(v2.outputs['Distance'], gr.inputs['Fac'])
        mx = N.new('ShaderNodeMix'); mx.data_type = 'RGBA'; mx.blend_type = 'MULTIPLY'; mx.inputs['Factor'].default_value = 1
        L.new(rp.outputs['Color'], mx.inputs[6]); L.new(gr.outputs['Color'], mx.inputs[7])
        color, height = mx.outputs[2], gr.outputs['Alpha'] if False else v2.outputs['Distance']
    elif pattern == 'wood':
        wv = N.new('ShaderNodeTexWave'); wv.wave_type = 'BANDS'; wv.bands_direction = 'X'
        wv.inputs['Scale'].default_value = scale; wv.inputs['Distortion'].default_value = 6; wv.inputs['Detail'].default_value = 3
        L.new(vec, wv.inputs['Vector'])
        rp = N.new('ShaderNodeValToRGB'); rp.color_ramp.elements[0].color = srgb(vary); rp.color_ramp.elements[1].color = srgb(base)
        L.new(wv.outputs['Fac'], rp.inputs['Fac'])
        color, height = rp.outputs['Color'], wv.outputs['Fac']
    elif pattern == 'noise':
        nz = N.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = scale; nz.inputs['Detail'].default_value = 8
        L.new(vec, nz.inputs['Vector'])
        rp = N.new('ShaderNodeValToRGB'); rp.color_ramp.elements[0].color = srgb(vary); rp.color_ramp.elements[1].color = srgb(base)
        rp.color_ramp.elements[0].position = 0.3; rp.color_ramp.elements[1].position = 0.7
        L.new(nz.outputs['Fac'], rp.inputs['Fac'])
        color, height = rp.outputs['Color'], nz.outputs['Fac']
    if color is None:
        p.inputs['Base Color'].default_value = srgb(base)
    elif hue:
        # 同一个原型的多棵树：按物体随机数轻微改色，免得一片树一个颜色
        oi = N.new('ShaderNodeObjectInfo')
        ma = N.new('ShaderNodeMapRange'); ma.inputs['To Min'].default_value = 0.5 - hue; ma.inputs['To Max'].default_value = 0.5 + hue
        L.new(oi.outputs['Random'], ma.inputs['Value'])
        hs = N.new('ShaderNodeHueSaturation'); L.new(ma.outputs['Result'], hs.inputs['Hue']); L.new(color, hs.inputs['Color'])
        L.new(hs.outputs['Color'], p.inputs['Base Color'])
    else:
        L.new(color, p.inputs['Base Color'])
    if bump and height is not None:
        bp = N.new('ShaderNodeBump'); bp.inputs['Strength'].default_value = bump; bp.inputs['Distance'].default_value = 0.02
        L.new(height, bp.inputs['Height']); L.new(bp.outputs['Normal'], p.inputs['Normal'])
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if coat: p.inputs['Coat Weight'].default_value = coat
    if sss: p.inputs['Subsurface Weight'].default_value = sss
    if transmission:
        p.inputs['Transmission Weight'].default_value = transmission
        p.inputs['IOR'].default_value = 1.45
    if emit:
        p.inputs['Emission Color'].default_value = srgb(emit_color or base)
        p.inputs['Emission Strength'].default_value = emit
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
    LIB[key] = m
    return m


def M_(name):
    """常用材质"""
    return {
        'grass': lambda: pbr('grass', '#6f8c47', 0.95, pattern='noise', scale=0.9, bump=0.35, vary='#526e35'),
        'soil': lambda: pbr('soil', '#7a5236', 0.95, pattern='noise', scale=1.5, bump=0.5, vary='#5a3a24'),
        'rock': lambda: pbr('rock', '#8f8a80', 0.85, pattern='noise', scale=3.5, bump=0.8, vary='#6c675e'),
        'concrete': lambda: pbr('concrete', '#bdb8ae', 0.9, pattern='noise', scale=4, bump=0.15, vary='#a7a299'),
        'concrete_dark': lambda: pbr('concrete_dark', '#9c978e', 0.9, pattern='noise', scale=4, bump=0.2, vary='#86817a'),
        'brick': lambda: pbr('brick', '#a4563c', 0.9, pattern='brick', scale=2.2, bump=0.6, vary='#8b4632', mortar='#cbc3b4'),
        'block': lambda: pbr('block', '#c9c4ba', 0.9, pattern='brick', scale=1.2, bump=0.4, vary='#b7b2a8', mortar='#9e998f'),
        'plaster': lambda: pbr('plaster', '#e8e0cf', 0.9, pattern='noise', scale=6, bump=0.12, vary='#d8cfbd'),
        'galv': lambda: pbr('galv', '#b9bfc6', 0.4, 0.85, pattern='noise', scale=5, bump=0.05, vary='#a3a9b1'),
        'galv_rib': lambda: pbr('galv_rib', '#b9bfc6', 0.4, 0.85, pattern='wave', scale=9, bump=0.5, vary='#a3a9b1'),
        'steel': lambda: pbr('steel', '#8d939b', 0.35, 0.9, pattern='noise', scale=8, bump=0.03, vary='#7b8189'),
        'steel_dark': lambda: pbr('steel_dark', '#3d434c', 0.45, 0.8, pattern='flat'),
        'rubber': lambda: pbr('rubber', '#2a2d32', 0.75, pattern='noise', scale=12, bump=0.12, vary='#222428'),
        'wood': lambda: pbr('wood', '#b48558', 0.7, pattern='wood', scale=2.5, bump=0.25, vary='#8a6038'),
        'wood_dark': lambda: pbr('wood_dark', '#8a6038', 0.7, pattern='wood', scale=3, bump=0.25, vary='#664425'),
        'paving': lambda: pbr('paving', '#c9c2b2', 0.92, pattern='stone', scale=2.2, bump=0.4, vary='#aea694'),
        'paving_dark': lambda: pbr('paving_dark', '#a49d8d', 0.92, pattern='stone', scale=2.6, bump=0.4, vary='#8d8676'),
        'water': lambda: pbr('water', '#24525e', 0.04, pattern='noise', scale=1.2, bump=0.08, vary='#1c4450', coat=1),
        'sand': lambda: pbr('sand', '#cdbf9c', 0.95, pattern='noise', scale=8, bump=0.3, vary='#b7a883'),
        'glass': lambda: pbr('glass', '#27323d', 0.06, pattern='flat', coat=1),
        'glass_lit': lambda: pbr('glass_lit', '#ffe2a6', 0.3, pattern='flat', emit=3, emit_color='#ffc46b'),
        'frame': lambda: pbr('frame', '#eeeeea', 0.5, pattern='flat'),
        'bark': lambda: pbr('bark', '#5e4632', 0.9, pattern='noise', scale=10, bump=0.6, vary='#463424'),
        'leaf': lambda: pbr('leaf', '#5b8f3a', 0.65, pattern='noise', scale=5, bump=0.3, vary='#3d6d27', sss=0.15, hue=0.035),
        'leaf_light': lambda: pbr('leaf_light', '#7ea64a', 0.65, pattern='noise', scale=5, bump=0.3, vary='#5b8a33', sss=0.15, hue=0.03),
        'leaf_autumn': lambda: pbr('leaf_autumn', '#d08a2c', 0.65, pattern='noise', scale=5, bump=0.3, vary='#a5501f', sss=0.15, hue=0.04),
        'needle': lambda: pbr('needle', '#3f6b3a', 0.7, pattern='noise', scale=8, bump=0.4, vary='#2c5030', sss=0.1, hue=0.02),
        'yellow': lambda: pbr('yellow', '#e0b23a', 0.45, 0.2, pattern='noise', scale=6, vary='#c99b2a'),
        'red_paint': lambda: pbr('red_paint', '#b8423a', 0.5, 0.2, pattern='wave', scale=6, bump=0.3, vary='#9c3530'),
        'blue_paint': lambda: pbr('blue_paint', '#2f5d8a', 0.45, 0.3, pattern='flat'),
        'orange_paint': lambda: pbr('orange_paint', '#d9641e', 0.45, 0.3, pattern='flat'),
        'cardboard': lambda: pbr('cardboard', '#b98d5f', 0.85, pattern='noise', scale=14, bump=0.1, vary='#a67c50'),
        'lamp': lambda: pbr('lamp', '#fff3d6', 0.3, pattern='flat', emit=1.2, emit_color='#ffd38a'),
        'teal_light': lambda: pbr('teal_light', '#7fe0d6', 0.3, pattern='flat', emit=4, emit_color='#4cc6c0'),
    }[name]()


# ---------- 网格拼装：同一材质的零件拼成一个物体 ----------
class Builder:
    def __init__(self, coll, origin=(0, 0)):
        self.coll = coll
        self.parts = {}
        self.ox, self.oz = origin

    def bm(self, m):
        if m.name not in self.parts:
            self.parts[m.name] = (m, bmesh.new())
        return self.parts[m.name][1]

    def M(self, x, y, z, ry=0.0, scale=(1, 1, 1), pre=None):
        T = Matrix.Translation(bl(x + self.ox, y, z + self.oz)) @ Matrix.Rotation(ry, 4, 'Z')
        S = Matrix.Diagonal((scale[0], scale[2], scale[1], 1))
        return T @ (pre or Matrix.Identity(4)) @ S

    def box(self, m, w, h, d, x, y, z, ry=0.0, bevel=0.0, rz=0.0):
        b = self.bm(m)
        pre = Matrix.Rotation(-rz, 4, 'Y') if rz else None  # 绕世界 z 轴倾斜
        r = bmesh.ops.create_cube(b, size=1.0, matrix=self.M(x, y, z, ry, (w, h, d), pre))
        if bevel:
            vs = r['verts']
            es = list({e for v in vs for e in v.link_edges})
            bmesh.ops.bevel(b, geom=vs + es, offset=bevel, segments=3, affect='EDGES', profile=0.5)

    def seg(self, m, p, q, w, h, dy=0.0):
        """沿两点之间放一根横截面 w×h 的方料（传送带侧板、栏杆之类）"""
        dx, dz = q[0] - p[0], q[2] - p[2]
        ln = math.hypot(dx, dz)
        if ln < 1e-4: return
        self.box(m, ln + 0.01, h, w, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2 + dy, (p[2] + q[2]) / 2, ry=-math.atan2(dz, dx))

    def cyl(self, m, r1, r2, h, x, y, z, seg=24, rx=0.0, ry=0.0):
        pre = Matrix.Rotation(rx, 4, 'X') if rx else None
        bmesh.ops.create_cone(self.bm(m), cap_ends=True, cap_tris=False, segments=seg, radius1=r2, radius2=r1, depth=h,
                              matrix=self.M(x, y, z, ry, pre=pre))

    def sphere(self, m, r, x, y, z, sx=1, sy=1, sz=1, seg=(14, 9)):
        bmesh.ops.create_uvsphere(self.bm(m), u_segments=seg[0], v_segments=seg[1], radius=r, matrix=self.M(x, y, z, 0, (sx, sy, sz)))

    def prism(self, m, hw, h, d, x, y, z):
        # 人字山墙：底宽 2*hw、高 h 的三角形沿 z 拉伸 d
        b = self.bm(m)
        tri = [(-hw, 0), (hw, 0), (0, h)]
        f = [b.verts.new(bl(x + self.ox + px, y + py, z + self.oz + d / 2)) for px, py in tri]
        k = [b.verts.new(bl(x + self.ox + px, y + py, z + self.oz - d / 2)) for px, py in tri]
        b.faces.new(f); b.faces.new(k[::-1])
        for i in range(3):
            j = (i + 1) % 3
            b.faces.new((f[j], f[i], k[i], k[j]))

    def disk(self, m, r, x, y, z, seg=48):
        bmesh.ops.create_circle(self.bm(m), cap_ends=True, segments=seg, radius=r, matrix=self.M(x, y, z))

    def annulus(self, m, r0, r1, x, y, z, seg=64):
        b = self.bm(m)
        for i in range(seg):
            a0, a1 = i / seg * 2 * math.pi, (i + 1) / seg * 2 * math.pi
            vs = [b.verts.new(bl(x + self.ox + r_ * math.cos(a), y, z + self.oz + r_ * math.sin(a))) for r_, a in ((r0, a0), (r1, a0), (r1, a1), (r0, a1))]
            b.faces.new(vs[::-1])

    def torus(self, m, R0, r, x, y, z, seg=(64, 8)):
        b = self.bm(m)
        M = self.M(x, y, z)
        ring = []
        for i in range(seg[0]):
            a = 2 * math.pi * i / seg[0]
            row = []
            for j in range(seg[1]):
                t = 2 * math.pi * j / seg[1]
                rr = R0 + r * math.cos(t)
                row.append(b.verts.new(M @ bl(rr * math.cos(a), r * math.sin(t), rr * math.sin(a))))
            ring.append(row)
        for i in range(seg[0]):
            for j in range(seg[1]):
                a, c = ring[i], ring[(i + 1) % seg[0]]
                b.faces.new((a[j], c[j], c[(j + 1) % seg[1]], a[(j + 1) % seg[1]]))

    def ribbon(self, m, pts, width, dy=0.0):
        b = self.bm(m)
        prev = None
        for i, p in enumerate(pts):
            a, c = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
            tx, tz = c[0] - a[0], c[2] - a[2]
            l = math.hypot(tx, tz) or 1
            nx, nz = -tz / l * width / 2, tx / l * width / 2
            row = (b.verts.new(bl(p[0] + nx + self.ox, p[1] + dy, p[2] + nz + self.oz)), b.verts.new(bl(p[0] - nx + self.ox, p[1] + dy, p[2] - nz + self.oz)))
            if prev:
                b.faces.new((prev[1], prev[0], row[0], row[1]))  # 法线朝上（烘焙按法线方向取光，朝下会烘成黑的）
            prev = row

    def tube(self, m, pts, r, seg=8):
        b = self.bm(m)
        rings = []
        for i, p in enumerate(pts):
            a, c = Vector(pts[max(0, i - 1)]), Vector(pts[min(len(pts) - 1, i + 1)])
            t = (c - a).normalized()
            n = Vector((-t.z, 0, t.x)).normalized()
            up = n.cross(t).normalized() if abs(t.y) > 0.5 else Vector((0, 1, 0))
            ring = []
            for j in range(seg):
                ang = 2 * math.pi * j / seg
                q = Vector(p) + n * (r * math.cos(ang)) + up * (r * math.sin(ang))
                ring.append(b.verts.new(bl(q.x + self.ox, q.y, q.z + self.oz)))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for j in range(seg):
                b.faces.new((rings[i][j], rings[i + 1][j], rings[i + 1][(j + 1) % seg], rings[i][(j + 1) % seg]))

    def done(self):
        objs = []
        for name, (m, b) in self.parts.items():
            me = bpy.data.meshes.new(name)
            b.normal_update()
            b.to_mesh(me)
            b.free()
            me.shade_smooth()
            me.set_sharp_from_angle(angle=math.radians(40))
            ob = bpy.data.objects.new(name, me)
            ob.data.materials.append(m)
            self.coll.objects.link(ob)
            objs.append(ob)
        self.parts = {}
        return objs


def collection(name, link=True):
    c = bpy.data.collections.new(name)
    if link:
        bpy.context.scene.collection.children.link(c)
    return c


# ---------- 曲线：向心 Catmull-Rom，按弧长等距采样 ----------
def catmull(points, n_per=24):
    P = [Vector(p) for p in points]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        t0 = 0
        t1 = t0 + max((p1 - p0).length ** 0.5, 1e-4)
        t2 = t1 + max((p2 - p1).length ** 0.5, 1e-4)
        t3 = t2 + max((p3 - p2).length ** 0.5, 1e-4)
        for k in range(n_per):
            t = t1 + (t2 - t1) * k / n_per
            a1 = p0 * ((t1 - t) / (t1 - t0)) + p1 * ((t - t0) / (t1 - t0))
            a2 = p1 * ((t2 - t) / (t2 - t1)) + p2 * ((t - t1) / (t2 - t1))
            a3 = p2 * ((t3 - t) / (t3 - t2)) + p3 * ((t - t2) / (t3 - t2))
            b1 = a1 * ((t2 - t) / (t2 - t0)) + a2 * ((t - t0) / (t2 - t0))
            b2 = a2 * ((t3 - t) / (t3 - t1)) + a3 * ((t - t1) / (t3 - t1))
            out.append(b1 * ((t2 - t) / (t2 - t1)) + b2 * ((t - t1) / (t2 - t1)))
    out.append(P[-2])
    # 等距重采样（每 0.33 米一个点）
    acc = [0.0]
    for i in range(1, len(out)):
        acc.append(acc[-1] + (out[i] - out[i - 1]).length)
    total, step, res, j = acc[-1], 0.33, [], 0
    n = max(2, int(total / step) + 1)
    for k in range(n):
        s = total * k / (n - 1)
        while j < len(acc) - 2 and acc[j + 1] < s:
            j += 1
        f = (s - acc[j]) / max(acc[j + 1] - acc[j], 1e-6)
        q = out[j].lerp(out[j + 1], f)
        res.append((round(q.x, 3), round(q.y, 3), round(q.z, 3)))
    return res


def offset(pts, d, dy=0.0):
    res = []
    for i, p in enumerate(pts):
        a, c = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        tx, tz = c[0] - a[0], c[2] - a[2]
        l = math.hypot(tx, tz) or 1
        res.append((p[0] - tz / l * d, p[1] + dy, p[2] + tx / l * d))
    return res


def seg_dist(x, z, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    return math.hypot(x - ax - t * dx, z - az - t * dz)


def blocked(x, z, pad=0.0):
    if abs(x) > HW - 0.8 - pad or abs(z) > HD - 0.8 - pad: return True
    if math.hypot(x - HUB['x'], z - HUB['z']) < HUB['r'] + 1.8 + pad: return True
    if math.hypot(x - PLAZA['x'], z - PLAZA['z']) < PLAZA['r'] + 1.2 + pad: return True
    if seg_dist(x, z, HUB['x'], HUB['z'], PLAZA['x'], PLAZA['z']) < 1.6 + pad: return True
    if math.hypot(x - POND['x'], z - POND['z']) < POND['r'] + 0.9 + pad: return True
    if -31 < x < -18.5 and abs(z) < 21.5: return True
    if -18.5 <= x < HUB['x'] - HUB['r'] + 1 and abs(z) < 19.5 + pad: return True
    return any(math.hypot(x - lx, z - lz) < 0.9 + pad for lx, lz in LAMPS)


# ---------- 树：几个原型，场景里用实例摆放（每棵按随机数微调颜色） ----------
PROTOS = []


def canopy_object(coll, name, blobs, m, strength=0.28, tex_scale=0.45, subdiv=2):
    """一团树冠：几个球体拼在一起，再用云纹理置换出凹凸，像一簇簇叶子"""
    b = bmesh.new()
    for x, y, z, r in blobs:
        bmesh.ops.create_icosphere(b, subdivisions=subdiv, radius=r, matrix=Matrix.Translation(bl(x, y, z)))
    me = bpy.data.meshes.new(name)
    b.to_mesh(me); b.free()
    me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(m)
    tex = bpy.data.textures.new(name + 'tex', 'CLOUDS')
    tex.noise_scale = tex_scale
    tex.noise_depth = 2
    d = ob.modifiers.new('leaves', 'DISPLACE')
    d.texture = tex; d.strength = strength; d.mid_level = 0.5
    dec = ob.modifiers.new('web', 'DECIMATE')  # 网页里要摆几百棵，面数压到几百个三角形
    dec.ratio = 0.35
    coll.objects.link(ob)
    return ob


def build_protos():
    rnd = random.Random(3)
    bark = M_('bark')
    kinds = [('leaf', 'broad'), ('leaf', 'broad'), ('leaf_light', 'broad'), ('leaf', 'tall'), ('needle', 'pine'), ('needle', 'pine'), ('leaf_light', 'bush'), ('leaf_autumn', 'broad')]
    for i, (leaf, shape) in enumerate(kinds):
        c = collection(f'proto{i}', link=False)
        b = Builder(c)
        if shape == 'pine':
            h = 3.2 + rnd.random()
            b.cyl(bark, 0.07, 0.14, 1.0, 0, 0.5, 0, seg=8)
            b.done()
            blobs = []
            bm_ = bmesh.new()
            for k in range(5):
                y0, r0 = 0.6 + k * (h - 0.8) / 5, 1.1 * (1 - k / 5.5)
                bmesh.ops.create_cone(bm_, cap_ends=True, segments=14, radius1=r0, radius2=r0 * 0.25, depth=1.0, matrix=Matrix.Translation(bl(0, y0 + 0.5, 0)))
            me = bpy.data.meshes.new(f'pine{i}'); bm_.to_mesh(me); bm_.free(); me.shade_smooth()
            ob = bpy.data.objects.new(f'pine{i}', me); ob.data.materials.append(M_(leaf)); c.objects.link(ob)
            tex = bpy.data.textures.new(f'pinetex{i}', 'CLOUDS'); tex.noise_scale = 0.25
            d = ob.modifiers.new('needles', 'DISPLACE'); d.texture = tex; d.strength = 0.15
            sub = ob.modifiers.new('sub', 'SUBSURF'); sub.levels = sub.render_levels = 1
            ob.modifiers.move(1, 0)
            dec = ob.modifiers.new('web', 'DECIMATE'); dec.ratio = 0.45
            PROTOS.append((c, 1.2))
            continue
        if shape == 'bush':
            blobs = [(rnd.uniform(-0.3, 0.3), 0.35 + rnd.random() * 0.15, rnd.uniform(-0.3, 0.3), 0.35 + rnd.random() * 0.2) for _ in range(5)]
            canopy_object(c, f'bush{i}', blobs, M_(leaf), 0.18, 0.3)
            PROTOS.append((c, 0.8))
            continue
        th = 1.0 if shape == 'broad' else 1.6
        b.cyl(bark, 0.08, 0.15, th + 0.4, 0, (th + 0.4) / 2, 0, seg=10)
        # 几根伸进树冠的枝
        for k in range(3):
            a = k / 3 * 2 * math.pi + rnd.random()
            tip = (math.cos(a) * 0.5, th + 0.5, math.sin(a) * 0.5)
            b.tube(bark, [(0, th * 0.75, 0), tip], 0.04, seg=6)
        b.done()
        top = th + 0.6
        n = 7 if shape == 'broad' else 6
        blobs = []
        for k in range(n):
            a = rnd.random() * 2 * math.pi
            rr = rnd.uniform(0.2, 0.55) if shape == 'broad' else rnd.uniform(0.1, 0.35)
            blobs.append((math.cos(a) * rr, top + rnd.uniform(-0.15, 0.6 if shape == 'broad' else 1.0), math.sin(a) * rr, rnd.uniform(0.45, 0.7)))
        blobs.append((0, top + 0.35, 0, 0.75))
        canopy_object(c, f'crown{i}', blobs, M_(leaf))
        PROTOS.append((c, 1.0))


def place_trees(coll, spots, rnd, autumn=0.12):
    """烘焙时放真实例（给地面投影），同时返回清单给网页按原型批量绘制：[原型, x, z, 转角, 横向缩放, 纵向缩放]"""
    out = []
    for i, (x, z, k, h) in enumerate(spots):
        # 秋色树少量，其余按大小挑原型
        if h < autumn: idx = 7
        elif h > 0.85: idx = 6  # 灌木
        else: idx = int(rnd.random() * 6)
        pc, base = PROTOS[idx]
        ob = bpy.data.objects.new(f't{i}', None)
        ob.instance_type = 'COLLECTION'
        ob.instance_collection = pc
        ob.location = bl(x, 0, z)
        ry = (rnd.random() - 0.5) * 0.8  # 烘焙的光照方向固定，转角不宜大
        ob.rotation_euler = (0, 0, ry)
        s = k * base
        sy = s * rnd.uniform(0.9, 1.15)
        ob.scale = (s, s, sy)
        coll.objects.link(ob)
        out.append((idx, round(x, 3), round(z, 3), round(ry, 3), round(s, 3), round(sy, 3)))
    return out


# ---------- 地皮（街区与空地共用） ----------
def ground(b, rnd, ok):
    W, D = HW * 2, HD * 2
    b.box(M_('grass'), W, 0.6, D, 0, -0.3, 0)
    b.box(M_('soil'), W, 2.6, D, 0, -1.9, 0)
    b.box(M_('rock'), W, 1.4, D, 0, -3.8, 0)



def flowers(b, rnd, ok, n=120):
    colors = ['#c9b2ec', '#a88fdc', '#f3c9d8', '#fff1b8', '#ffffff', '#e86f6a']
    pos, tries = [], 0
    while len(pos) < n and tries < 3000:
        tries += 1
        x, z = (rnd.random() * 2 - 1) * (HW - 2), (rnd.random() * 2 - 1) * (HD - 2)
        if ok(x, z):
            pos.append((x, z))
    for i, (x, z) in enumerate(pos):
        c = pbr('flower' + colors[i % len(colors)], colors[i % len(colors)], 0.6, pattern='flat', sss=0.2)
        stem = pbr('stem', '#4e7a2f', 0.8, pattern='flat')
        for _ in range(7):
            a, d, sz = rnd.random() * 6.28, rnd.random() * 0.7, 0.06 + rnd.random() * 0.05
            fx, fz = x + math.cos(a) * d, z + math.sin(a) * d
            hgt = 0.15 + rnd.random() * 0.15
            b.cyl(stem, 0.012, 0.012, hgt, fx, hgt / 2, fz, seg=4)
            b.sphere(c, sz, fx, hgt + sz * 0.5, fz, 1, 0.6, 1, seg=(6, 4))


def path_ribbon(b, a, c, m):
    ax, az = a
    cx, cz = c
    mx, mz = (ax + cx) / 2 + (cz - az) * 0.08, (az + cz) / 2 - (cx - ax) * 0.08
    pts = []
    for i in range(41):
        t = i / 40
        x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * mx + t * t * cx
        z = (1 - t) ** 2 * az + 2 * (1 - t) * t * mz + t * t * cz
        pts.append((x, 0, z))
    b.ribbon(m, pts, 1.6, 0.02)
    # 路缘石
    for d in (0.84, -0.84): b.ribbon(M_('concrete'), offset(pts, d), 0.1, 0.045)
    return pts


def street_lamp(b, x, z):
    post, base = M_('steel_dark'), M_('concrete_dark')
    b.cyl(base, 0.16, 0.2, 0.18, x, 0.09, z, seg=12)
    b.cyl(post, 0.045, 0.07, 2.4, x, 1.3, z, seg=10)
    b.box(post, 0.5, 0.06, 0.08, x + 0.22, 2.46, z)
    b.box(post, 0.32, 0.1, 0.18, x + 0.42, 2.42, z, bevel=0.02)
    b.box(M_('lamp'), 0.26, 0.02, 0.14, x + 0.42, 2.36, z)


# ---------- 街区底图 ----------
def build_district(coll):
    b = Builder(coll)
    info = {}
    rnd = random.Random(42)

    # 传送带路径先算出来（种草、种花都要避开）
    belts1, samples = [], []
    for i, z in enumerate(SLOT_Z):
        th = math.pi - (z / 18) * 0.75
        end = (HUB['x'] + (HUB['r'] + 0.15) * math.cos(th), BELT_Y, HUB['z'] + (HUB['r'] + 0.15) * math.sin(th))
        pre = (HUB['x'] + (HUB['r'] + 2.6) * math.cos(th), BELT_Y, HUB['z'] + (HUB['r'] + 2.6) * math.sin(th))
        pts = catmull([(FACTORY_X + 3.3, BELT_Y, z), (-17.5, BELT_Y, z), ((-17.5 + pre[0]) / 2, BELT_Y, (z + pre[2]) / 2 + (z - pre[2]) * 0.12), pre, end])
        belts1.append(dict(pts=pts, angle=th))
    d = Vector((PLAZA['x'] - HUB['x'], 0, PLAZA['z'] - HUB['z'])).normalized()
    perp = Vector((-d.z, 0, d.x))
    start = Vector((HUB['x'], BELT_Y, HUB['z'])) + d * (HUB['r'] + 0.15)
    end = Vector((PLAZA['x'], BELT_Y, PLAZA['z'])) - d * (PLAZA['r'] - 1.4)
    mid = start.lerp(end, 0.5) - perp * 0.9
    pts2 = catmull([tuple(start), tuple(start + d * 1.6), tuple(mid), tuple(end - d * 1.6), tuple(end)])
    for bt in belts1: samples.extend(bt['pts'])
    samples.extend(pts2)
    info['belts1'] = belts1
    info['belt2'] = dict(pts=pts2, angle=math.atan2(d.z, d.x))

    px, pz, pr = PLAZA['x'], PLAZA['z'], PLAZA['r']
    segs = [((HUB['x'] + 1, HUB['z'] + HUB['r'] + 1.2), (POND['x'] - 0.5, POND['z'] - POND['r'] - 0.6)),
            ((px + 1, pz + pr), (px + 3, HD - 0.01)),
            ((px + 1, pz - pr), (px + 3, -HD + 0.01)),
            ((px + pr, pz + 2), (HW - 0.01, pz + 5)),
            ((POND['x'] + POND['r'] + 0.5, POND['z'] + 1), (px - 3, pz + pr - 0.8))]
    paths = [path_ribbon(b, a, c, M_('paving')) for a, c in segs]
    def on_path(x, z, pad=1.2):
        return any(math.hypot(x - p[0], z - p[2]) < pad for pts in paths for p in pts[::2])
    near_belt = lambda x, z, pad=1.0: any(abs(p[0] - x) < pad and abs(p[2] - z) < pad for p in samples[::3])
    in_field = lambda x, z: -18.5 <= x < HUB['x'] - HUB['r'] + 1 and abs(z) < 19.5
    open_ground = lambda x, z: (not near_belt(x, z)) if in_field(x, z) else (not blocked(x, z, 0.1) and not on_path(x, z, 0.95))
    ground(b, rnd, open_ground)

    # 车间地坪：混凝土，黄色安全线
    b.box(M_('concrete'), 12.5, 0.2, 43, -24.75, 0.0, 0, bevel=0.04)
    for z in SLOT_Z:
        b.box(M_('yellow'), 12, 0.012, 0.1, -24.75, 0.106, z + 3)
        b.box(M_('yellow'), 0.1, 0.012, 4.6, -21.3, 0.106, z)
    # 车间背后的货架：蓝色立柱、橙色横梁、纸箱
    rx = FACTORY_X - 4.3
    for z in SLOT_Z:
        for dx in (-0.45, 0.45):
            for dz in (-1.15, 1.15):
                b.box(M_('blue_paint'), 0.08, 1.8, 0.08, rx + dx, 1.0, z + dz)
        for y in (0.35, 0.95, 1.55):
            for dx in (-0.45, 0.45): b.box(M_('orange_paint'), 0.06, 0.1, 2.36, rx + dx, 0.1 + y, z)
            b.box(M_('galv'), 0.9, 0.03, 2.3, rx, 0.15 + y, z)
        for y in (0.35, 0.95, 1.55):
            for dz in (-0.75, 0, 0.75):
                if rnd.random() < 0.3: continue
                k = 0.4 + rnd.random() * 0.14
                b.box(M_('cardboard'), k, k * (0.8 + rnd.random() * 0.3), k, rx + (rnd.random() - 0.5) * 0.12, 0.17 + y + k * 0.45, z + dz, ry=(rnd.random() - 0.5) * 0.2, bevel=0.015)
    # 厂区栏杆：黄色钢管
    fx0, fx1, fz = -30.7, -19, 21.2
    x = fx0
    while x <= fx1:
        for s in (-1, 1): b.cyl(M_('yellow'), 0.04, 0.04, 0.9, x, 0.55, s * fz, seg=8)
        x += 1.3
    z = -fz
    while z <= fz:
        b.cyl(M_('yellow'), 0.04, 0.04, 0.9, fx0, 0.55, z, seg=8)
        z += 1.3
    for y in (0.55, 0.98):
        for s in (-1, 1): b.tube(M_('yellow'), [(fx0, y, s * fz), (fx1, y, s * fz)], 0.035)
        b.tube(M_('yellow'), [(fx0, y, -fz), (fx0, y, fz)], 0.035)

    # 传送带：橡胶带面加横档，镀锌钢槽侧板，方管支腿带横撑
    def belt(pts):
        b.ribbon(M_('rubber'), pts, 1.06, 0)
        b.ribbon(M_('galv'), pts, 1.3, -0.16)
        for side in (0.6, -0.6):
            sp = offset(pts, side)
            for i in range(1, len(sp)): b.seg(M_('galv'), sp[i - 1], sp[i], 0.05, 0.24, 0.02)
        for i in range(1, len(pts)):
            p, q = pts[i - 1], pts[i]
            ang = -math.atan2(q[2] - p[2], q[0] - p[0])
            if i % 2 == 0: b.box(M_('rubber'), 0.035, 0.03, 1.0, q[0], q[1] + 0.015, q[2], ry=ang)
            if i % 8 == 4:
                for side in (0.52, -0.52):
                    lp = offset([p, q], side)[1]
                    b.box(M_('galv'), 0.08, BELT_Y - 0.16, 0.08, lp[0], (BELT_Y - 0.16) / 2, lp[2])
                b.box(M_('galv'), 0.05, 0.05, 1.04, q[0], 0.25, q[2], ry=ang)
                b.box(M_('steel_dark'), 0.2, 0.02, 1.25, q[0], 0.01, q[2], ry=ang)
    for bt in belts1: belt(bt['pts'])
    belt(pts2)

    # 中转站：混凝土台、钢板转盘、黄色安全圈、中心柱（玻璃罩单独渲染成前景层）
    hx, hz, hr = HUB['x'], HUB['z'], HUB['r']
    b.cyl(M_('concrete'), hr + 0.4, hr + 0.6, BELT_Y - 0.1, hx, (BELT_Y - 0.1) / 2, hz, seg=72)
    b.cyl(M_('steel'), hr - 0.1, hr - 0.1, 0.1, hx, BELT_Y - 0.05, hz, seg=72)
    b.torus(M_('yellow'), hr - 0.35, 0.06, hx, BELT_Y, hz, seg=(72, 6))
    for i in range(16):
        a = i / 16 * 2 * math.pi
        b.box(M_('steel_dark'), hr - 1.3, 0.012, 0.025, hx + math.cos(a) * (hr / 2 + 0.25), BELT_Y + 0.003, hz + math.sin(a) * (hr / 2 + 0.25), ry=-a)
        b.cyl(M_('steel_dark'), 0.05, 0.05, 0.03, hx + math.cos(a) * (hr - 0.6), BELT_Y + 0.01, hz + math.sin(a) * (hr - 0.6), seg=8)
    b.cyl(M_('steel'), 0.7, 0.85, 1.4, hx, BELT_Y + 0.7, hz, seg=36)
    b.torus(M_('teal_light'), 0.76, 0.06, hx, BELT_Y + 1.2, hz, seg=(36, 8))
    b.cyl(M_('steel_dark'), 0.5, 0.7, 0.12, hx, BELT_Y + 1.46, hz, seg=36)
    b.torus(M_('steel'), hr + 0.05, 0.1, hx, BELT_Y, hz, seg=(72, 8))
    b.annulus(M_('paving_dark'), hr + 0.6, hr + 1.6, hx, 0.015, hz)

    # 广场：铺路石台面，花岗岩边，木面工作台，木托盘，红色废料箱，推车
    b.cyl(M_('concrete_dark'), pr, pr + 0.2, 0.5, px, 0.25, pz, seg=96)
    b.cyl(M_('paving'), pr - 0.15, pr - 0.15, 0.02, px, 0.505, pz, seg=96)
    b.annulus(M_('paving_dark'), pr * 0.58, pr * 0.66, px, 0.52, pz, seg=96)
    b.torus(M_('concrete'), pr - 0.05, 0.12, px, 0.5, pz, seg=(96, 8))
    center = Vector((px, 0.5, pz))
    at = lambda a, c: center + d * a + perp * c
    rot = -math.atan2(d.z, d.x)
    info.update(center=tuple(center), dir=tuple(d), perp=tuple(perp))
    bench = at(-3.0, 0)
    b.box(M_('wood'), 1.5, 0.1, 2.8, bench.x, 0.5 + 0.75, bench.z, ry=rot, bevel=0.02)
    for lx, lz in ((-0.62, -1.28), (0.62, -1.28), (-0.62, 1.28), (0.62, 1.28)):
        q = bench + d * lx + perp * lz
        b.box(M_('steel_dark'), 0.06, 0.7, 0.06, q.x, 0.5 + 0.35, q.z, ry=rot)
    b.box(M_('steel_dark'), 1.3, 0.04, 2.6, bench.x, 0.5 + 0.2, bench.z, ry=rot)
    info.update(bench=tuple(bench), benchTop=1.3)
    pallet = at(1.2, 3.6)
    for s in (-1, 0, 1):
        q = pallet + perp * (s * 1.1)
        b.box(M_('wood'), 2.6, 0.12, 0.32, q.x, 0.5 + 0.06, q.z, ry=rot)
    for s in range(-3, 4):
        q = pallet + d * (s * 0.4)
        b.box(M_('wood'), 0.3, 0.06, 2.6, q.x, 0.5 + 0.15, q.z, ry=rot)
    info.update(pallet=tuple(pallet), palletTop=0.68)
    rej = at(-0.6, -4.0)
    b.box(M_('red_paint'), 1.6, 0.1, 1.6, rej.x, 0.56, rej.z)
    for wx, wz, sx, sz in ((0.75, 0, 0.1, 1.6), (-0.75, 0, 0.1, 1.6), (0, 0.75, 1.6, 0.1), (0, -0.75, 1.6, 0.1)):
        b.box(M_('red_paint'), sx, 1.0, sz, rej.x + wx, 1.0, rej.z + wz)
    b.box(M_('steel_dark'), 1.7, 0.05, 1.7, rej.x, 1.5, rej.z)
    info['reject'] = tuple(rej)
    info['agentPos'] = tuple(at(0.9, -0.4))
    cart = at(-1.7, 4.2)
    b.box(M_('galv'), 1.1, 0.05, 0.7, cart.x, 0.78, cart.z, ry=0.5)
    for zz in (-0.3, 0.3):
        b.cyl(M_('rubber'), 0.12, 0.12, 0.07, cart.x + 0.38, 0.62, cart.z + zz, seg=16, rx=math.pi / 2, ry=0.5)
    b.tube(M_('steel_dark'), [(cart.x - 0.5, 0.8, cart.z - 0.3), (cart.x - 0.55, 1.5, cart.z - 0.3), (cart.x - 0.55, 1.5, cart.z + 0.3), (cart.x - 0.5, 0.8, cart.z + 0.3)], 0.025)
    b.box(M_('cardboard'), 0.55, 0.45, 0.5, cart.x, 1.03, cart.z, ry=0.5, bevel=0.02)
    stack = at(-4.4, 3.2)
    for k in range(4):
        for s in (-1, 0, 1): b.box(M_('wood'), 1.4, 0.08, 0.2, stack.x, 0.54 + k * 0.17, stack.z + s * 0.55, ry=0.2)
        for s in range(-2, 3): b.box(M_('wood'), 0.22, 0.04, 1.3, stack.x + s * 0.3, 0.6 + k * 0.17, stack.z, ry=0.2)

    # 池塘：深色水面、沙石岸、石头、芦苇、睡莲
    b.disk(M_('water'), POND['r'], POND['x'], 0.03, POND['z'], seg=72)
    b.annulus(M_('sand'), POND['r'] - 0.1, POND['r'] + 0.6, POND['x'], 0.02, POND['z'], seg=72)
    pr2 = random.Random(11)
    for i in range(46):
        a, rr, k = i / 46 * 2 * math.pi + pr2.random() * 0.1, POND['r'] + 0.15 + pr2.random() * 0.4, 0.14 + pr2.random() * 0.2
        b.sphere(M_('rock'), 1, POND['x'] + math.cos(a) * rr, 0.05, POND['z'] + math.sin(a) * rr, k * 1.4, k * 0.7, k, seg=(7, 5))
    reed = pbr('reed', '#7a8a3c', 0.8, pattern='flat')
    for _ in range(40):
        a = pr2.random() * 2 * math.pi
        rr = POND['r'] - 0.2 - pr2.random() * 0.4
        x, z = POND['x'] + math.cos(a) * rr, POND['z'] + math.sin(a) * rr
        if math.sin(a) < 0.2: continue
        h = 0.5 + pr2.random() * 0.5
        b.cyl(reed, 0.01, 0.018, h, x, h / 2, z, seg=4)
    pad = pbr('lily', '#4f8a3a', 0.6, pattern='noise', scale=6, vary='#3b6e2c')
    for lx, lz, lr in ((-1.6, -0.8, 0.45), (1.2, 1.4, 0.38), (0.6, -1.9, 0.34), (-0.4, 1.9, 0.42), (2.2, -0.4, 0.3), (-2.3, 0.9, 0.36)):
        b.cyl(pad, lr, lr, 0.015, POND['x'] + lx, 0.045, POND['z'] + lz, seg=20)
    for lx, lz in ((-1.6, -0.8), (-0.4, 1.9)):
        b.sphere(pbr('lotus', '#f4b6c8', 0.5, pattern='flat', sss=0.3), 0.1, POND['x'] + lx, 0.1, POND['z'] + lz, seg=(10, 6))

    # 长椅
    for bx, bz, ry in ((-0.6, 9.2, math.pi / 2), (3.4, 9.6, -math.pi / 2), (26.5, -3.2, 0), (10.5, 20.6, 0.3)):
        c_, s_ = math.cos(ry), math.sin(ry)
        loc = lambda lx, lz: (bx + lx * c_ + lz * s_, bz - lx * s_ + lz * c_)
        for k in range(3):
            x_, z_ = loc(0, -0.15 + k * 0.15); b.box(M_('wood'), 1.6, 0.04, 0.12, x_, 0.45, z_, ry=ry)
        for k in range(2):
            x_, z_ = loc(0, -0.25); b.box(M_('wood'), 1.6, 0.1, 0.03, x_, 0.62 + k * 0.15, z_, ry=ry)
        for lx in (-0.65, 0.65):
            x_, z_ = loc(lx, 0); b.box(M_('steel_dark'), 0.05, 0.45, 0.45, x_, 0.22, z_, ry=ry)

    for lx, lz in LAMPS: street_lamp(b, lx, lz)

    # 树林与花
    spots = []
    x = -HW + 0.9
    while x < HW - 0.5:
        z = -HD + 0.9
        while z < HD - 0.5:
            tx, tz = x + (rnd.random() - 0.5) * 1.3, z + (rnd.random() - 0.5) * 1.3
            if rnd.random() >= 0.12 and not blocked(tx, tz, 0.4) and not on_path(tx, tz):
                spots.append((tx, tz, 0.75 + rnd.random() * 0.55, rnd.random()))
            z += 1.75
        x += 1.75
    b.done()
    info['trees'] = place_trees(coll, spots, rnd)
    info['lamps'] = [(lx + 0.42, 2.36, lz) for lx, lz in LAMPS]
    return info


def build_wild(coll):
    b = Builder(coll)
    rnd = random.Random(7)
    glades = [((rnd.random() - 0.5) * HW * 1.2, (rnd.random() - 0.5) * HD * 1.2, 5 + rnd.random() * 5) for _ in range(2)]
    in_glade = lambda x, z, pad=0: any(math.hypot(x - gx, z - gz) < gr - pad for gx, gz, gr in glades)
    ground(b, rnd, lambda x, z: True)
    spots = []
    x = -HW + 0.9
    while x < HW - 0.5:
        z = -HD + 0.9
        while z < HD - 0.5:
            px_, pz_ = x + (rnd.random() - 0.5) * 1.3, z + (rnd.random() - 0.5) * 1.3
            if rnd.random() >= 0.15 and not in_glade(px_, pz_):
                spots.append((px_, pz_, 0.75 + rnd.random() * 0.55, rnd.random()))
            z += 1.9
        x += 1.9
    for _ in range(14):  # 空地上的几块石头
        gx, gz, gr = glades[int(rnd.random() * 2)]
        a, rr = rnd.random() * 6.28, rnd.random() * (gr - 1)
        k = 0.2 + rnd.random() * 0.35
        b.sphere(M_('rock'), 1, gx + math.cos(a) * rr, k * 0.3, gz + math.sin(a) * rr, k * 1.3, k * 0.8, k, seg=(8, 6))
    b.done()
    return place_trees(coll, spots, rnd)


def build_dome(coll):
    b = Builder(coll)
    hx, hz, hr = HUB['x'], HUB['z'], HUB['r']
    glass = pbr('dome_glass', '#eef6fb', 0.02, pattern='flat', transmission=1)
    frame = M_('steel')
    bmesh.ops.create_uvsphere(b.bm(glass), u_segments=48, v_segments=24, radius=hr + 0.05, matrix=b.M(hx, BELT_Y - 0.05, hz, 0, (1, 0.75, 1)))
    bmv = b.bm(glass)
    for v in [v for v in bmv.verts if v.co.z < BELT_Y - 0.06]:
        bmv.verts.remove(v)
    for k in range(8):
        ry = k * math.pi / 8
        pts = [((hr + 0.05) * math.cos(t) * math.cos(ry), BELT_Y - 0.05 + (hr + 0.05) * 0.75 * math.sin(t), -(hr + 0.05) * math.cos(t) * math.sin(ry)) for t in [i / 24 * math.pi for i in range(25)]]
        b.tube(frame, [(p[0] + hx, p[1], p[2] + hz) for p in pts], 0.045, seg=6)
    for t in (0.35, 0.7):
        rr = (hr + 0.05) * math.cos(t * math.pi / 2)
        b.torus(frame, rr, 0.04, hx, BELT_Y - 0.05 + (hr + 0.05) * 0.75 * math.sin(t * math.pi / 2), hz, seg=(64, 6))
    b.sphere(frame, 0.22, hx, BELT_Y - 0.05 + (hr + 0.05) * 0.75, hz)
    b.done()


# ---------- 车间（单独出图：空闲 / 有项目 / 在干活） ----------
def build_factory(coll, slot, state):
    b = Builder(coll)
    variant = slot % 3
    # neutral：屋顶烘成浅灰，网页里乘上每个车间的漆色
    roof_c = '#dcdcdc' if state == 'neutral' else ROOF_COLORS[slot] if state != 'empty' else '#9aa1a8'
    roof = pbr(f'roof{roof_c}', roof_c, 0.45, 0.5, pattern='wave', scale=9, bump=0.6, vary=shade(roof_c, 0.88))
    win = M_('glass_lit') if state == 'active' else M_('glass')
    frame, trim, door = M_('frame'), M_('concrete'), pbr('shutter', '#8c939b', 0.5, 0.6, pattern='wave', scale=14, bump=0.6)
    y0 = 0.1
    wins = []
    def w(wx, wy, wz, ww=0.5, wh=0.55, side='x'):
        if side == 'x':
            b.box(win, 0.04, wh, ww, wx + 0.01, y0 + wy, wz)
            b.box(frame, 0.05, wh + 0.1, ww + 0.1, wx - 0.01, y0 + wy, wz)
            b.box(frame, 0.04, 0.03, ww, wx + 0.03, y0 + wy, wz)  # 中梃
            b.box(trim, 0.14, 0.05, ww + 0.2, wx + 0.05, y0 + wy - wh / 2 - 0.06, wz)
        else:
            b.box(win, ww, wh, 0.04, wx, y0 + wy, wz + 0.01)
            b.box(frame, ww + 0.1, wh + 0.1, 0.05, wx, y0 + wy, wz - 0.01)
            b.box(frame, 0.03, wh, 0.04, wx, y0 + wy, wz + 0.03)
            b.box(trim, ww + 0.2, 0.05, 0.14, wx, y0 + wy - wh / 2 - 0.06, wz + 0.05)
        wins.append((wx, y0 + wy, wz))
    if variant == 0:
        # 红砖厂房：人字彩钢瓦屋顶、屋脊盖板、采光带、落水管
        b.box(M_('brick'), 3.6, 2.4, 3.8, 0, y0 + 1.2, 0)
        b.prism(M_('brick'), 1.8, 0.95, 3.8, 0, y0 + 2.4, 0)
        for sgn in (-1, 1):
            b.box(roof, 2.25, 0.08, 4.3, sgn * 0.98, y0 + 2.92, 0, rz=-sgn * 0.48)
            b.box(pbr('skylight', '#cfe3ee', 0.1, pattern='flat', coat=1), 0.5, 0.09, 3.2, sgn * 0.6, y0 + 3.13, 0, rz=-sgn * 0.48)
        b.box(M_('galv'), 0.22, 0.08, 4.35, 0, y0 + 3.43, 0)
        b.box(M_('concrete'), 3.7, 0.2, 3.9, 0, y0 + 0.1, 0)  # 勒脚
        for cx, cz in ((1.83, 1.93), (1.83, -1.93)):
            b.cyl(M_('galv'), 0.05, 0.05, 2.4, cx, y0 + 1.2, cz, seg=8)
        b.cyl(M_('galv'), 0.14, 0.14, 1.5, -0.8, y0 + 3.4, 1.1, seg=14)
        b.cyl(M_('steel_dark'), 0.2, 0.2, 0.06, -0.8, y0 + 4.18, 1.1, seg=14)
        chimney = (-0.8, y0 + 4.2, 1.1)
        for wz in (-1.1, 1.1): w(1.81, 1.6, wz)
        w(0, 1.5, 1.91, 0.6, 0.55, 'z'); w(-1, 1.5, 1.91, 0.6, 0.55, 'z')
        beacon = (1.2, y0 + 3.3, -1.2)
        door_x = 1.82
    elif variant == 1:
        # 砌块厂房加两座镀锌筒仓：平屋顶女儿墙、爬梯、输料管
        b.box(M_('block'), 3.4, 2, 3.4, 0.3, y0 + 1, 0)
        b.box(pbr('membrane', '#5d6168', 0.8, pattern='noise', scale=5, vary='#4f535a'), 3.3, 0.06, 3.3, 0.3, y0 + 2.03, 0)
        for sx_, sz_, ww, dd in ((0.3, 1.68, 3.4, 0.08), (0.3, -1.68, 3.4, 0.08), (1.98, 0, 0.08, 3.4), (-1.38, 0, 0.08, 3.4)):
            b.box(roof, ww + 0.04, 0.22, dd + 0.04, sx_, y0 + 2.1, sz_)
        for sx, sz, h in ((-1.5, -1.0, 3.6), (-1.5, 1.0, 3.0)):
            b.cyl(M_('galv_rib'), 0.75, 0.75, h, sx, y0 + h / 2, sz, seg=32)
            b.cyl(roof, 0.12, 0.8, 0.6, sx, y0 + h + 0.3, sz, seg=32)
            b.torus(M_('steel_dark'), 0.76, 0.03, sx, y0 + 0.3, sz, seg=(32, 6))
            for rx in (-0.12, 0.12): b.box(M_('steel_dark'), 0.03, h, 0.03, sx + 0.76, y0 + h / 2, sz + rx)
            for k in range(int(h / 0.3)): b.box(M_('steel_dark'), 0.03, 0.02, 0.24, sx + 0.76, y0 + 0.2 + k * 0.3, sz)
        b.tube(M_('galv'), [(-1.5, y0 + 2.4, -1.0), (-0.6, y0 + 2.4, -1.0), (-0.6, y0 + 1.9, -1.0)], 0.07)
        chimney = (-1.5, y0 + 4.4, -1.0)
        for wz in (-0.8, 0.8): w(2.01, 1.2, wz)
        beacon = (1.2, y0 + 2.4, -1.2)
        door_x = 2.02
    else:
        # 两层办公厂房：抹灰墙、层间腰线、窗格、屋顶空调机组和水箱
        b.box(M_('plaster'), 3, 3.6, 3.2, 0, y0 + 1.8, 0)
        b.box(trim, 3.08, 0.1, 3.28, 0, y0 + 2.0, 0)
        b.box(trim, 3.1, 0.2, 3.3, 0, y0 + 0.1, 0)
        for sx_, sz_, ww, dd in ((0, 1.6, 3.0, 0.1), (0, -1.6, 3.0, 0.1), (1.5, 0, 0.1, 3.2), (-1.5, 0, 0.1, 3.2)):
            b.box(roof, ww + 0.06, 0.25, dd + 0.06, sx_, y0 + 3.72, sz_)
        b.box(pbr('membrane', '#5d6168', 0.8, pattern='noise', scale=5, vary='#4f535a'), 2.9, 0.04, 3.1, 0, y0 + 3.62, 0)
        b.box(M_('galv'), 0.8, 0.5, 0.7, -0.4, y0 + 3.9, -0.6, bevel=0.03)
        b.cyl(M_('steel_dark'), 0.22, 0.22, 0.02, -0.4, y0 + 4.16, -0.6, seg=18)
        b.cyl(M_('galv_rib'), 0.35, 0.35, 0.7, 0.7, y0 + 4.0, 0.9, seg=20)
        b.cyl(M_('steel_dark'), 0.37, 0.37, 0.04, 0.7, y0 + 4.36, 0.9, seg=20)
        chimney = (-0.4, y0 + 4.2, -0.6)
        for wy in (1.3, 2.7):
            for wz in (-0.8, 0.8): w(1.51, wy, wz, 0.55, 0.65)
        b.box(trim, 0.5, 0.06, 1.5, 1.7, y0 + 1.25, 0)  # 门头雨棚
        beacon = (1.2, y0 + 4.0, -1.2)
        door_x = 1.52
    # 卷帘门、装货台（橡胶防撞块）、门灯
    b.box(door, 0.06, 1.1, 1.2, door_x, y0 + 0.55, 0)
    b.box(M_('steel_dark'), 0.08, 0.14, 1.3, door_x + 0.01, y0 + 1.15, 0)
    b.box(M_('concrete'), 1.4, 0.5, 1.6, 2.5, y0 + 0.25, 0, bevel=0.02)
    b.box(M_('steel'), 0.04, 0.06, 1.6, 3.2, y0 + 0.48, 0)
    for bz in (-0.55, 0.55): b.box(M_('rubber'), 0.08, 0.25, 0.22, 3.22, y0 + 0.3, bz)
    b.box(M_('lamp'), 0.06, 0.08, 0.18, door_x + 0.04, y0 + 1.32, 0.45)
    b.cyl(M_('steel_dark'), 0.09, 0.09, 0.08, beacon[0], beacon[1] - 0.06, beacon[2], seg=12)
    b.done()
    return dict(chimney=chimney, beacon=beacon, windows=wins)


# ---------- 包裹与角色 ----------
def build_parcel(coll, color):
    b = Builder(coll)
    tape = pbr('tape' + color, color, 0.35, pattern='flat', coat=0.5)
    b.box(M_('cardboard'), 0.7, 0.62, 0.7, 0, 0.31, 0, bevel=0.025)
    # 品类色胶带：顶上一圈压到两侧，侧面贴一张白标签
    b.box(tape, 0.18, 0.012, 0.72, 0, 0.625, 0)
    for s in (-1, 1): b.box(tape, 0.18, 0.3, 0.012, 0, 0.47, s * 0.355)
    b.box(pbr('label', '#f4f1ea', 0.6, pattern='flat'), 0.012, 0.18, 0.26, 0.355, 0.3, 0.12)
    b.done()


def build_ped(coll):
    b = Builder(coll)
    stone = pbr('granite', '#d9d5cf', 0.35, pattern='noise', scale=12, bump=0.05, vary='#bdb8b0', coat=0.3)
    b.cyl(stone, 1.7, 1.85, 0.28, 0, 0.14, 0, seg=64)
    b.torus(M_('steel'), 1.76, 0.05, 0, 0.29, 0, seg=(72, 8))
    b.done()


def starburst(b, m, cx, cy, cz, n=10, r=0.42):
    # Claude 的星芒：正面一圈朝外的细尖
    for i in range(n):
        a = i / n * 2 * math.pi
        ln = r * 0.75 if i % 2 else r
        M = Matrix.Translation(bl(cx + math.cos(a) * ln / 2, cy + math.sin(a) * ln / 2, cz)) @ Matrix.Rotation(math.pi / 2 - a, 4, 'Y')
        bmesh.ops.create_cone(b.bm(m), cap_ends=True, segments=6, radius1=0.06, radius2=0, depth=ln, matrix=M)
    b.sphere(m, 0.08, cx, cy, cz, seg=(10, 8))


def toy(key, color, rough=0.32, sss=0.0):
    """角色用的手办质感：光滑塑料、带清漆"""
    return pbr('toy' + key, color, rough, pattern='noise', scale=20, bump=0.02, vary=shade(color, 0.95), coat=0.6, sss=sss)


def build_agent(coll, kind):
    b = Builder(coll)
    y = 0.28
    if kind == 'claude':
        shell, dark = toy('shell', '#d97757'), toy('dark', '#a9533a')
        b.box(shell, 2.2, 1.35, 1.6, 0, y + 1.05, 0, bevel=0.45)
        starburst(b, toy('star', '#fff8f0', 0.25), 0, y + 1.15, 0.82)
        for x in (-0.5, 0.5):
            b.cyl(dark, 0.06, 0.06, 0.4, x, y + 1.85, 0.25, seg=10)
            b.sphere(toy('eye', '#1d1715', 0.15), 0.17, x, y + 2.08, 0.25, seg=(18, 12))
        for side in (-1, 1):
            for k in (-0.5, 0, 0.5):
                b.cyl(dark, 0.08, 0.06, 0.7, side * 1.25, y + 0.4, k, seg=10)
            b.sphere(shell, 0.3, side * 1.57, y + 1.1, 0.95, 1, 0.8, 1.2, seg=(18, 12))
            b.box(dark, 0.08, 0.1, 0.32, side * 1.57, y + 1.1, 1.28, bevel=0.02)
    elif kind == 'codex':
        cloud, light = toy('cloud', '#8f8dff', 0.4, 0.2), toy('cloud2', '#b7b5ff', 0.4, 0.2)
        for x, yy, z, r, m in ((0, 1.15, 0, 0.9, cloud), (-0.75, 0.95, 0.05, 0.62, light), (0.75, 0.95, 0.05, 0.66, light), (-0.35, 1.65, -0.05, 0.6, cloud), (0.4, 1.7, -0.1, 0.55, light), (0, 0.8, 0.3, 0.6, cloud)):
            b.sphere(m, r, x, y + yy, z, seg=(28, 18))
        b.box(toy('screen', '#23224a', 0.15), 1.05, 0.66, 0.06, 0, y + 1.2, 0.9, bevel=0.03)
        white = pbr('codex_glyph', '#ffffff', 0.3, pattern='flat', emit=1.5, emit_color='#ffffff')
        for s in (-1, 1): b.box(white, 0.26, 0.06, 0.03, -0.18, y + 1.2 + s * 0.07, 0.94, ry=s * 0.6)
        b.box(white, 0.22, 0.06, 0.03, 0.15, y + 1.03, 0.94)
        for x in (-0.42, 0.42): b.sphere(toy('feet', '#5f5ccf'), 0.24, x, y + 0.28, 0.13, 1, 0.6, 1.3)
        b.cyl(toy('feet', '#5f5ccf'), 0.035, 0.035, 0.4, 0.15, y + 2.35, -0.1, seg=8)
        b.sphere(pbr('bulb', '#ffd36b', 0.3, pattern='flat', emit=2, emit_color='#ffb800'), 0.1, 0.15, y + 2.6, -0.1)
    else:
        shell, dark = toy('bot', '#ecedf2'), toy('botdark', '#9fa3ad')
        b.box(shell, 1.7, 1.5, 1.4, 0, y + 1.2, 0, bevel=0.35)
        b.box(toy('visor', '#1e2032', 0.12), 1.3, 0.8, 0.1, 0, y + 1.3, 0.68, bevel=0.05)
        for x in (-0.3, 0.3): b.sphere(pbr('boteye', '#9ff5e6', 0.3, pattern='flat', emit=2.5, emit_color='#6ff0d8'), 0.12, x, y + 1.32, 0.74)
        for x in (-0.45, 0.45): b.box(dark, 0.4, 0.4, 0.55, x, y + 0.3, 0.05, bevel=0.12)
        for side in (-1, 1):
            b.cyl(dark, 0.08, 0.08, 0.6, side * 0.95, y + 1.05, 0, seg=10)
            b.sphere(shell, 0.16, side * 0.95, y + 0.73, 0)
        b.cyl(dark, 0.035, 0.035, 0.4, 0, y + 2.15, 0, seg=8)
        b.sphere(pbr('bulb', '#ffd36b', 0.3, pattern='flat', emit=2, emit_color='#ffb800'), 0.1, 0, y + 2.4, 0)
    b.done()


def build_mini(coll, kind):
    b = Builder(coll)
    m = toy('mini' + kind, {'claude': '#d97757', 'codex': '#8f8dff'}.get(kind, '#ecedf2'))
    if kind == 'claude':
        b.box(m, 0.6, 0.4, 0.45, 0, 0.3, 0, bevel=0.15)
    elif kind == 'codex':
        b.sphere(m, 0.3, 0, 0.32, 0); b.sphere(m, 0.2, 0.25, 0.25, 0)
    else:
        b.box(m, 0.5, 0.5, 0.45, 0, 0.3, 0, bevel=0.12)
    for x in (-0.1, 0.1): b.sphere(toy('eye', '#1d1715', 0.15), 0.05, x, 0.4, 0.22)
    b.done()


# ---------- 烘焙与导出 ----------
def setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for dv in prefs.devices: dv.use = True
        sc.cycles.device = 'GPU'
    except Exception as e:
        print('GPU 不可用，改用 CPU：', e)
    sc.cycles.use_denoising = False  # 烘焙不走降噪，靠采样数
    sc.render.bake.margin = 6
    # 天空光：物理天空（拿不到就退回纯色），太阳方向与阳光一致
    world = bpy.data.worlds.new('w')
    nt = world.node_tree
    bg = nt.nodes['Background']
    try:
        sky = nt.nodes.new('ShaderNodeTexSky')
        for t in ('NISHITA', 'MULTIPLE_SCATTERING', 'SINGLE_SCATTERING'):
            try: sky.sky_type = t; break
            except TypeError: continue
        if hasattr(sky, 'sun_disc'): sky.sun_disc = False
        if hasattr(sky, 'sun_elevation'): sky.sun_elevation = math.asin(-SUN.y)
        if hasattr(sky, 'sun_rotation'): sky.sun_rotation = math.atan2(-SUN.x, SUN.z)
        nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 0.18
    except Exception as e:
        print('物理天空不可用：', e)
        bg.inputs['Color'].default_value = srgb('#cfe3ff')
        bg.inputs['Strength'].default_value = 0.9
    sc.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 2.8  # 烘焙进 8 位贴图，亮部要留余量，不然会截成白色
    sun.data.angle = math.radians(2.5)
    sun.rotation_euler = bl(*SUN).normalized().to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(sun)
    return sc


def only(sc, colls):
    for lc in sc.view_layers[0].layer_collection.children:
        lc.exclude = lc.collection not in colls


def ctx(ob, objs=None):
    objs = objs or [ob]
    vl = bpy.context.view_layer
    for o in vl.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    vl.objects.active = ob
    return bpy.context.temp_override(active_object=ob, object=ob, selected_objects=objs, selected_editable_objects=objs)


def merge(objs, name):
    """把一组物体（含修改器、实例）实化并合成一个网格"""
    objs = [o for o in objs if o.type == 'MESH']
    with ctx(objs[0], objs):
        bpy.ops.object.convert(target='MESH')
        if len(objs) > 1: bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    return ob


def unwrap(ob, margin=0.002):
    me = ob.data
    while me.uv_layers: me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name='bake')
    with ctx(ob):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin, area_weight=1.0)
        bpy.ops.object.mode_set(mode='OBJECT')


def bake(sc, ob, name, size, samples):
    """把物体在当前场景里看到的光照、颜色烘进一张图，然后换成只引用这张图的材质"""
    if QUICK: size, samples = max(128, size // 4), max(8, samples // 8)
    img = bpy.data.images.new(name, size, size, alpha=False)
    added = []
    for m in ob.data.materials:
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        n.image = img
        m.node_tree.nodes.active = n
        added.append((m, n))
    sc.cycles.samples = samples
    with ctx(ob):
        bpy.ops.object.bake(type='COMBINED', use_clear=True)
    for m, n in added: m.node_tree.nodes.remove(n)
    baked = bpy.data.materials.new(name)
    p = baked.node_tree.nodes['Principled BSDF']
    t = baked.node_tree.nodes.new('ShaderNodeTexImage'); t.image = img
    baked.node_tree.links.new(t.outputs['Color'], p.inputs['Base Color'])
    ob.data.materials.clear()
    ob.data.materials.append(baked)
    for poly in ob.data.polygons: poly.material_index = 0
    print('[bake]', name, size, flush=True)
    return ob


def plain(ob, name, color='#ffffff'):
    """不烘焙、网页里自己上色的部件（窗户、玻璃）：换成一个纯色材质"""
    m = bpy.data.materials.new(name)
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = srgb(color)
    ob.data.materials.clear(); ob.data.materials.append(m)
    for poly in ob.data.polygons: poly.material_index = 0
    ob.name = name
    return ob


def export(objs, name):
    only(bpy.context.scene, list({c for o in objs for c in o.users_collection}))
    with ctx(objs[0], objs):
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + '.glb'), export_format='GLB', use_selection=True,
                                  export_apply=True, export_image_format='WEBP', export_image_quality=88,
                                  export_normals=False, export_materials='EXPORT', export_yup=True)
    print('[export]', name, flush=True)


def floor_for_bake(coll, y=0.0, r=6):
    """烘焙单个物件时垫一块地，提供接地的阴影与反光；不导出"""
    b = Builder(coll)
    b.box(M_('concrete'), r * 2, 0.1, r * 2, 0, y - 0.05, 0)
    return b.done()


def main():
    sc = setup()
    build_protos()
    meta = dict(island=dict(hw=HW, hd=HD), hub=HUB, plaza=PLAZA, factoryX=FACTORY_X, slotZ=SLOT_Z, pond=POND, beltY=BELT_Y, roofColors=ROOF_COLORS, cat=CAT)

    # 树原型：各自合成一个网格单独烘焙，网页按实例清单批量绘制
    tree_objs = []
    for i, (pc, _) in enumerate(PROTOS):
        tmp = collection(f'tp{i}')
        objs = [o.copy() for o in pc.objects]
        for o in objs:
            o.data = o.data.copy(); tmp.objects.link(o)
        only(sc, [tmp])
        t = merge(objs, f'tree{i}')
        unwrap(t)
        bake(sc, t, f'tree{i}', 512, 64)
        tree_objs.append(t)

    # 街区：车间（彩色屋顶）、树、玻璃罩框架都在场，阴影一起烘进地面
    c = collection('district')
    meta['layout'] = build_district(c)
    fc = collection('factories_shadow')
    # build_factory 自带 Builder，在原点建好再挪到车间位置
    for slot, z in enumerate(SLOT_Z):
        before = set(fc.objects)
        build_factory(fc, slot, 'on')
        for o in set(fc.objects) - before: o.location = bl(FACTORY_X, 0, z)
    dome = collection('dome')
    build_dome(dome)
    glass = [o for o in dome.objects if o.data.materials[0].name == 'dome_glass']
    frame = [o for o in dome.objects if o not in glass]
    gc = collection('dome_glass')  # 玻璃不参与烘焙：Cycles 里玻璃会挡住阳光，把转盘烘成黑的
    for o in glass: dome.objects.unlink(o); gc.objects.link(o)
    only(sc, [c, fc, dome])
    static = merge([o for o in c.objects if o.type == 'MESH'] + frame, 'district')
    unwrap(static, 0.001)
    bake(sc, static, 'district', 3072, 256)  # 4096 显存要 85MB，3072 约 48MB，清晰度差别很小
    only(sc, [gc])
    g = merge(glass, 'dome_glass')
    plain(g, 'dome_glass', '#eef6fb')
    export([static, g], 'district')

    # 空地：地皮 + 树
    w = collection('wild')
    meta['wildTrees'] = build_wild(w)
    only(sc, [w])
    wild = merge([o for o in w.objects if o.type == 'MESH'], 'wild')
    unwrap(wild, 0.001)
    bake(sc, wild, 'wild', 1536, 192)
    export([wild], 'wild')
    export(tree_objs, 'trees')

    # 车间：三种造型，主体烘焙；屋顶烘成浅灰由网页上色；窗户不烘焙，网页按亮灯与否上色
    meta['factories'] = []
    parts = []
    for v in range(3):
        fcol = collection(f'fv{v}')
        info = build_factory(fcol, v, 'neutral')
        floor_for_bake(fcol, 0.1)
        only(sc, [fcol])
        objs = [o for o in fcol.objects if o.type == 'MESH']
        roofs = [o for o in objs if o.data.materials[0].name.startswith('roof')]
        wins = [o for o in objs if o.data.materials[0].name in ('glass', 'glass_lit')]
        floor = objs[-1]
        body = [o for o in objs if o not in roofs and o not in wins and o is not floor]
        body = merge(body, f'factory{v}'); unwrap(body); bake(sc, body, f'factory{v}', 1024, 128)
        roof = merge(roofs, f'roof{v}'); unwrap(roof); bake(sc, roof, f'roof{v}', 512, 128)
        win = merge(wins, f'win{v}'); plain(win, f'win{v}', '#27323d')
        parts += [body, roof, win]
        meta['factories'].append(info)
    export(parts, 'factories')

    # 包裹（纸箱烘焙，胶带烘成白色由网页按品类上色）、底座、角色、子代理小分身
    parts = []
    pc_ = collection('parcel')
    build_parcel(pc_, '#f2f2f2')
    floor_for_bake(pc_, 0, 1.5)
    only(sc, [pc_])
    objs = [o for o in pc_.objects if o.type == 'MESH']
    tape = [o for o in objs if o.data.materials[0].name.startswith('tape')]
    box = [o for o in objs[:-1] if o not in tape]
    box = merge(box, 'parcel'); unwrap(box); bake(sc, box, 'parcel', 256, 96)
    tape = merge(tape, 'tape'); unwrap(tape); bake(sc, tape, 'tape', 128, 96)
    parts += [box, tape]
    for name, fn in (('ped', build_ped), ('agent-claude', lambda c: build_agent(c, 'claude')), ('agent-codex', lambda c: build_agent(c, 'codex')),
                     ('agent-bot', lambda c: build_agent(c, 'bot')), ('mini-claude', lambda c: build_mini(c, 'claude')),
                     ('mini-codex', lambda c: build_mini(c, 'codex')), ('mini-bot', lambda c: build_mini(c, 'bot'))):
        col = collection(name)
        fn(col)
        floor_for_bake(col, 0, 2.5)
        only(sc, [col])
        objs = [o for o in col.objects if o.type == 'MESH'][:-1]
        ob = merge(objs, name); unwrap(ob)
        bake(sc, ob, name, 512 if name.startswith(('agent', 'ped')) else 128, 128)
        parts.append(ob)
    export(parts, 'props')

    with open(os.path.join(OUT, 'town.json'), 'w') as fp:
        json.dump(meta, fp, ensure_ascii=False, separators=(',', ':'))
    print('[assets] 完成 →', OUT)


main()
