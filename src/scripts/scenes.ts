// Procedural point-cloud scenes. Everything is generated client-side from a seed,
// so the site ships no point data and every visit renders the same scene.

export type V3 = [number, number, number];

export const CLASS_COLORS: string[] = [
  '#8b7355', // 0  ground
  '#5d6573', // 1  road surface
  '#ffffff', // 2  road marking
  '#8fd14f', // 3  low vegetation
  '#2fb35a', // 4  high vegetation
  '#f2a541', // 5  building / structure
  '#3df5c4', // 6  pole / tower / signage
  '#ff5ea8', // 7  conductor
  '#8a96ff', // 8  vehicle
  '#e4703a', // 9  stockpile
  '#ff3b3b', // 10 clearance risk (vectors only)
  '#3a8dde', // 11 water
];

export interface LegendItem {
  cls: number;
  name: string;
}

export interface Scene {
  positions: Float32Array; // xyz
  attrs: Float32Array; // class, intensity
  count: number;
  lines: Float32Array; // xyz, class, revealX per vertex
  lineVerts: number;
  objects: number[]; // revealX per extracted feature, for HUD counters
  bounds: { min: V3; max: V3 };
  legend: LegendItem[];
  camera: { radius: number; elevation: number; azimuth: number; target: V3 };
  /** Splat size multiplier for scenes viewed from further away. */
  pointScale?: number;
}

// ---------- maths helpers ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x: number, z: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
}

function fbm(x: number, z: number) {
  return noise2(x, z) * 0.6 + noise2(x * 2.1, z * 2.1) * 0.28 + noise2(x * 4.3, z * 4.3) * 0.12;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ---------- builder ----------

class Builder {
  p: number[] = [];
  a: number[] = [];
  l: number[] = [];
  objects: number[] = [];
  /** Optional terrain height; wall points that fall below it are culled. */
  ground?: (x: number, z: number) => number;
  constructor(
    public r: () => number,
    public density: number,
  ) {}

  n(count: number) {
    return Math.max(1, Math.round(count * this.density));
  }

  j(s: number) {
    return (this.r() - 0.5) * s;
  }

  gauss() {
    const u = 1 - this.r();
    const v = this.r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pt(x: number, y: number, z: number, cls: number, intensity: number) {
    this.p.push(x, y, z);
    this.a.push(cls, clamp01(intensity));
  }

  seg(a: V3, b: V3, cls: number) {
    const reveal = Math.min(a[0], b[0]);
    this.l.push(a[0], a[1], a[2], cls, reveal, b[0], b[1], b[2], cls, reveal);
  }

  polyline(pts: V3[], cls: number) {
    for (let i = 1; i < pts.length; i++) this.seg(pts[i - 1], pts[i], cls);
  }

  boxLines(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cls: number, isObject = true) {
    const c: V3[] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    for (let i = 0; i < e.length; i += 2) this.seg(c[e[i]], c[e[i + 1]], cls);
    if (isObject) this.objects.push(Math.min(x0, x1));
  }

  // Sample the faces of an axis-aligned box. `inten(u, y)` lets walls carry window patterns.
  boxShell(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    cls: number, dens: number, inten: (u: number, y: number) => number, roof = true,
  ) {
    const w = x1 - x0;
    const h = y1 - y0;
    const d = z1 - z0;
    if (roof) {
      for (let i = this.n(w * d * dens * 1.2); i--; ) {
        this.pt(x0 + this.r() * w, y1 + this.j(0.08), z0 + this.r() * d, cls, inten(-1, y1));
      }
    }
    const walls: [number, number][] = [[w, 0], [d, 1], [w, 2], [d, 3]];
    for (const [len, side] of walls) {
      for (let i = this.n(len * h * dens); i--; ) {
        const u = this.r() * len;
        const y = y0 + this.r() * h;
        let x: number, z: number;
        if (side === 0) [x, z] = [x0 + u, z0];
        else if (side === 1) [x, z] = [x1, z0 + u];
        else if (side === 2) [x, z] = [x1 - u, z1];
        else [x, z] = [x0, z1 - u];
        if (this.ground && y < this.ground(x, z) - 0.1) continue;
        this.pt(x + this.j(0.06), y, z + this.j(0.06), cls, inten(u, y - y0));
      }
    }
  }

  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, count: number, cls: number, inten: number) {
    for (let i = this.n(count); i--; ) {
      let gx = this.gauss();
      let gy = this.gauss();
      let gz = this.gauss();
      const len = Math.hypot(gx, gy, gz) || 1;
      const k = 0.62 + 0.38 * Math.sqrt(this.r());
      gx = (gx / len) * k;
      gy = (gy / len) * k;
      gz = (gz / len) * k;
      const wob = 1 + 0.18 * noise2(gx * 3 + cx, gz * 3 + cz);
      this.pt(cx + gx * rx * wob, cy + gy * ry * wob, cz + gz * rz * wob, cls, inten + this.j(0.2));
    }
  }

  cylinder(cx: number, cz: number, y0: number, y1: number, rad: number, count: number, cls: number, inten: number) {
    for (let i = this.n(count); i--; ) {
      const t = this.r() * Math.PI * 2;
      this.pt(cx + Math.cos(t) * rad, y0 + this.r() * (y1 - y0), cz + Math.sin(t) * rad, cls, inten + this.j(0.1));
    }
  }

  line(a: V3, b: V3, count: number, cls: number, inten: number, spread = 0.05) {
    for (let i = this.n(count); i--; ) {
      const t = this.r();
      this.pt(
        lerp(a[0], b[0], t) + this.j(spread),
        lerp(a[1], b[1], t) + this.j(spread),
        lerp(a[2], b[2], t) + this.j(spread),
        cls,
        inten + this.j(0.1),
      );
    }
  }

  // Catenary-ish conductor between two attachment points; returns its vector polyline.
  wire(a: V3, b: V3, sag: number, count: number, cls: number) {
    const at = (t: number): V3 => [
      lerp(a[0], b[0], t),
      lerp(a[1], b[1], t) - sag * (1 - (2 * t - 1) ** 2),
      lerp(a[2], b[2], t),
    ];
    for (let i = this.n(count); i--; ) {
      const p = at(this.r());
      this.pt(p[0], p[1] + this.j(0.05), p[2] + this.j(0.05), cls, 0.5 + this.j(0.15));
    }
    const pts: V3[] = [];
    for (let i = 0; i <= 10; i++) pts.push(at(i / 10));
    this.polyline(pts, cls);
    return at;
  }

  car(x: number, y: number, z: number, along: 'x' | 'z', len = 4.4, wid = 1.8, hgt = 1.45, dens = 1) {
    const tone = 0.55 + this.r() * 0.4;
    const [lx, lz] = along === 'x' ? [len, wid] : [wid, len];
    this.boxShell(x - lx / 2, y + 0.3, z - lz / 2, x + lx / 2, y + hgt * 0.62, z + lz / 2, 8, 28 * dens, () => tone + this.j(0.1));
    const cx = along === 'x' ? lx * 0.28 : lx / 2;
    const cz = along === 'x' ? lz / 2 : lz * 0.28;
    this.boxShell(x - cx, y + hgt * 0.62, z - cz, x + cx, y + hgt, z + cz, 8, 22 * dens, () => tone * 0.6 + this.j(0.1));
    this.boxLines(x - lx / 2, y + 0.3, z - lz / 2, x + lx / 2, y + hgt, z + lz / 2, 8);
  }

  tree(x: number, gy: number, z: number, scale = 1, pts = 26) {
    const th = (2.2 + this.r() * 2.2) * scale;
    const cr = (2.4 + this.r() * 2.2) * scale;
    const ry = cr * (0.8 + this.r() * 0.45);
    const tone = 0.32 + this.r() * 0.18;
    this.line([x, gy, z], [x, gy + th + ry * 0.5, z], 14 * scale, 4, tone, 0.18);
    this.blob(x + this.j(0.6), gy + th + ry * 0.85, z + this.j(0.6), cr, ry, cr * (0.85 + this.r() * 0.3), cr * cr * pts, 4, tone);
    return gy + th + ry * 1.8;
  }

  build(legend: LegendItem[], camera: Scene['camera']): Scene {
    const positions = new Float32Array(this.p);
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    return {
      positions,
      attrs: new Float32Array(this.a),
      count: positions.length / 3,
      lines: new Float32Array(this.l),
      lineVerts: this.l.length / 5,
      objects: this.objects,
      bounds: { min, max },
      legend,
      camera,
    };
  }
}

// ---------- scenes ----------

export function cityScene(seed = 11, density = 1): Scene {
  const r = rng(seed);
  const b = new Builder(r, density);
  const X = 120;
  const Z = 84;
  const CX = 22; // cross street centreline

  // The main street runs along a valley floor; hills rise on both sides, steeper on the far (south) side.
  const roadY = (x: number) => 1.4 * Math.sin(x * 0.017 + 0.6) + 0.6 * Math.sin(x * 0.043 + 2);
  const crossY = (z: number) => roadY(CX) + 0.035 * z + 0.0011 * z * z;
  const terrain = (x: number, z: number) =>
    roadY(x) * 0.7 +
    4.2 * fbm(x * 0.02 + 3, z * 0.02 - 1) +
    (z < 0 ? 18 : 8) * smooth(20, 92, Math.abs(z)) * (0.6 + 0.4 * fbm(x * 0.012 + 9, z * 0.012)) +
    0.12 * noise2(x * 0.4, z * 0.4);
  const streetDist = (x: number, z: number) => Math.min(Math.abs(z), Math.abs(x - CX));
  const streetY = (x: number, z: number) => lerp(roadY(x), crossY(z), smooth(-3, 3, Math.abs(z) - Math.abs(x - CX)));
  const groundY = (x: number, z: number) => {
    const d = streetDist(x, z);
    let y = lerp(streetY(x, z), terrain(x, z), smooth(10, 26, d));
    if (d > 7.2 && d < 10) y += 0.15;
    return y;
  };
  b.ground = groundY;

  const footprints: [number, number, number, number][] = [];
  const parks: [number, number, number, number][] = [];
  const baseOf = (x0: number, x1: number, z0: number, z1: number) =>
    Math.min(groundY(x0, z0), groundY(x1, z0), groundY(x0, z1), groundY(x1, z1), groundY((x0 + x1) / 2, (z0 + z1) / 2)) - 0.3;

  // Glazing reads dark in lidar intensity, so façades get a floor/bay window pattern.
  const facade = (t: number, floor: number, bay: number, glass = 0.35) => (u: number, y: number) => {
    if (u < 0) return t + 0.15 + b.j(0.12);
    const fy = (y % floor) / floor;
    const fu = (u % bay) / bay;
    return (fy > 0.28 && fy < 0.84 && fu > 0.14 && fu < 0.86 ? t * glass : t) + b.j(0.1);
  };

  const rooftop = (x0: number, x1: number, z0: number, z1: number, y: number, n: number) => {
    for (let k = n; k--; ) {
      const w = 2 + r() * 3;
      const d = 2 + r() * 3;
      const hx = lerp(x0 + 1, x1 - w - 1, r());
      const hz = lerp(z0 + 1, z1 - d - 1, r());
      b.boxShell(hx, y, hz, hx + w, y + 1.2 + r() * 1.4, hz + d, 5, 3, () => 0.72 + b.j(0.1));
    }
  };

  // Flat-roofed block with a parapet: walls run 0.9 m above the roof deck.
  const block = (x0: number, x1: number, z0: number, z1: number, base: number, h: number, t: number, isObject = true) => {
    b.boxShell(x0, base, z0, x1, base + h, z1, 5, 1.7, facade(t, 3.4, 2.4 + r() * 1.6), false);
    for (let i = b.n((x1 - x0) * (z1 - z0) * 2.2); i--; ) {
      b.pt(lerp(x0 + 0.3, x1 - 0.3, r()), base + h - 0.9 + b.j(0.06), lerp(z0 + 0.3, z1 - 0.3, r()), 5, t + 0.2 + b.j(0.1));
    }
    b.boxLines(x0, base, z0, x1, base + h, z1, 5, isObject);
    rooftop(x0, x1, z0, z1, base + h - 0.9, r() < 0.6 ? 1 + Math.floor(r() * 3) : 0);
  };

  // Podium, glazed tower and an optional setback crown.
  const tower = (x0: number, x1: number, z0: number, z1: number) => {
    const base = baseOf(x0, x1, z0, z1);
    const t = 0.4 + r() * 0.3;
    const podium = 5 + r() * 4;
    block(x0, x1, z0, z1, base, podium, t);
    const inset = 2 + r() * 2.5;
    const [tx0, tx1, tz0, tz1] = [x0 + inset, x1 - inset, z0 + inset, z1 - inset];
    const H = 26 + r() * 34;
    const setback = H > 38 && r() < 0.7;
    const lower = setback ? H * (0.6 + r() * 0.15) : H;
    b.boxShell(tx0, base + podium, tz0, tx1, base + podium + lower, tz1, 5, 1.6, facade(t, 3.6, 1.6, 0.22), !setback);
    b.boxLines(tx0, base + podium, tz0, tx1, base + podium + lower, tz1, 5, false);
    let top = base + podium + lower;
    let [cx0, cx1, cz0, cz1] = [tx0, tx1, tz0, tz1];
    if (setback) {
      const s = 2 + r() * 2;
      [cx0, cx1, cz0, cz1] = [tx0 + s, tx1 - s, tz0 + s, tz1 - s];
      for (let i = b.n((tx1 - tx0) * (tz1 - tz0) * 2.2); i--; ) {
        const x = lerp(tx0, tx1, r());
        const z = lerp(tz0, tz1, r());
        if (x < cx0 || x > cx1 || z < cz0 || z > cz1) b.pt(x, top, z, 5, t + 0.2 + b.j(0.1));
      }
      b.boxShell(cx0, top, cz0, cx1, base + podium + H, cz1, 5, 1.6, facade(t, 3.6, 1.6, 0.22));
      b.boxLines(cx0, top, cz0, cx1, base + podium + H, cz1, 5, false);
      top = base + podium + H;
    }
    rooftop(cx0, cx1, cz0, cz1, top, 1);
    if (H > 48) b.line([(cx0 + cx1) / 2, top, (cz0 + cz1) / 2], [(cx0 + cx1) / 2, top + 9, (cz0 + cz1) / 2], 40, 6, 0.8, 0.12);
    footprints.push([x0, x1, z0, z1]);
  };

  const midrise = (x0: number, x1: number, z0: number, z1: number) => {
    const t = 0.32 + r() * 0.4;
    if (r() < 0.45 && x1 - x0 > 16) {
      // L-shaped: a street-front bar plus a rear wing of a different height.
      const zf = z0 + (z1 - z0) * (0.35 + r() * 0.15);
      const front = Math.abs(z0) < Math.abs(z1);
      const [bz0, bz1] = front ? [z0, zf] : [zf, z1];
      const [wz0, wz1] = front ? [zf, z1] : [z0, zf];
      const wx0 = r() < 0.5 ? x0 : x1 - (x1 - x0) * 0.45;
      const wx1 = wx0 + (x1 - x0) * 0.45;
      block(x0, x1, bz0, bz1, baseOf(x0, x1, bz0, bz1), 9 + r() * 12, t);
      block(wx0, wx1, wz0, wz1, baseOf(wx0, wx1, wz0, wz1), 6 + r() * 14, t, false);
      footprints.push([x0, x1, bz0, bz1], [wx0, wx1, wz0, wz1]);
    } else {
      block(x0, x1, z0, z1, baseOf(x0, x1, z0, z1), 8 + r() * 16, t);
      footprints.push([x0, x1, z0, z1]);
    }
  };

  // Detached house with a pitched roof; the ridge runs along the longer side.
  const house = (x0: number, z0: number, w: number, d: number) => {
    const [x1, z1] = [x0 + w, z0 + d];
    const base = baseOf(x0, x1, z0, z1);
    const top = base + (r() < 0.55 ? 3 : 5.6) + r() * 0.5;
    const rise = 2.2 + r() * 1.8;
    const t = 0.38 + r() * 0.3;
    const roofT = 0.4 + r() * 0.45;
    b.boxShell(x0, base, z0, x1, top, z1, 5, 1.9, facade(t, 2.8, 2.6, 0.45), false);
    const alongX = w >= d;
    const [L, S] = alongX ? [w, d] : [d, w];
    const P = (u: number, v: number, y: number): V3 => (alongX ? [x0 + u, y, z0 + v] : [x0 + v, y, z0 + u]);
    const o = 0.5;
    for (let i = b.n((L + 2 * o) * (S + 2 * o) * 2.8); i--; ) {
      const u = -o + r() * (L + 2 * o);
      const v = -o + r() * (S + 2 * o);
      const p = P(u, v, top + rise * (1 - Math.abs(v - S / 2) / (S / 2)) + b.j(0.05));
      b.pt(p[0], p[1], p[2], 5, roofT + b.j(0.08));
    }
    for (const u of [0, L]) {
      for (let i = b.n(S * rise * 1.0); i--; ) {
        const v = r() * S;
        const p = P(u, v, top + r() * rise * (1 - Math.abs(v - S / 2) / (S / 2)));
        b.pt(p[0], p[1], p[2], 5, t + b.j(0.1));
      }
    }
    b.boxLines(x0, base, z0, x1, top, z1, 5);
    const ridge: [V3, V3] = [P(0, S / 2, top + rise), P(L, S / 2, top + rise)];
    b.seg(ridge[0], ridge[1], 5);
    for (const u of [0, L]) {
      b.seg(P(u, 0, top), P(u, S / 2, top + rise), 5);
      b.seg(P(u, S, top), P(u, S / 2, top + rise), 5);
    }
    if (r() < 0.35) {
      const c = P(L * (0.2 + r() * 0.6), S * 0.3, 0);
      b.boxShell(c[0] - 0.5, top + rise * 0.4, c[2] - 0.5, c[0] + 0.5, top + rise + 0.9, c[2] + 0.5, 5, 6, () => 0.5);
    }
    footprints.push([x0, x1, z0, z1]);
  };

  // Lots along both sides of the main street, densest at the intersection.
  const zRange = (side: number, near: number, far: number): [number, number] => (side > 0 ? [near, far] : [-far, -near]);
  for (const side of [-1, 1]) {
    let x = -X + 3 + r() * 5;
    while (x < X - 10) {
      if (x > CX - 12 && x < CX + 12) {
        x = CX + 12 + r() * 2;
        continue;
      }
      let w = 12 + r() * 18;
      if (x < CX - 12 && x + w > CX - 12) w = CX - 12 - x;
      w = Math.min(w, X - 2 - x);
      if (w < 8) {
        x += w + 1;
        continue;
      }
      const downtown = 1 - smooth(20, 80, Math.abs(x + w / 2 - CX));
      const near = 16.5 + r() * 2.5;
      const [z0, z1] = zRange(side, near, near + 16 + r() * 18);
      const roll = r();
      if (roll < 0.22) {
        parks.push([x, x + w, z0, z1]);
      } else if (downtown > 0.5 && roll < 0.85) {
        tower(x, x + w, z0, z1);
      } else if (downtown > 0.18) {
        midrise(x, x + w, z0, z1);
      } else {
        let hx = x;
        while (hx < x + w - 8) {
          const hw = 8 + r() * 5;
          const [hz0] = zRange(side, near + 2 + r() * 3, near + 12);
          const hd = 8 + r() * 4;
          house(hx, hz0, Math.min(hw, x + w - hx), hd);
          hx += hw + 6 + r() * 5;
        }
      }
      x += w + 10 + r() * 14;
    }
  }

  // Hillside streets of houses behind the main street.
  for (const side of [-1, 1]) {
    for (let x = -X + 4 + r() * 6; x < X - 12; ) {
      if (x > CX - 14 && x < CX + 14) {
        x = CX + 14;
        continue;
      }
      const w = 9 + r() * 5;
      const d = 8 + r() * 4;
      const near = 58 + r() * 8;
      const [z0] = zRange(side, near, near + d);
      house(x, z0, w, d);
      const tz = side * (near + d + 4 + r() * 4);
      if (Math.abs(tz) < Z - 2) b.tree(x + r() * w, groundY(x + w / 2, tz), tz, 0.8 + r() * 0.4);
      x += w + 18 + r() * 18;
    }
  }

  const inFootprint = (x: number, z: number) => footprints.some(([a, c, d, e]) => x > a && x < c && z > d && z < e);

  // Ground, roads and sidewalks.
  for (let i = b.n(2 * X * 2 * Z * 1.6); i--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    if (inFootprint(x, z)) continue;
    const d = streetDist(x, z);
    const y = groundY(x, z) + b.j(0.04);
    if (d < 7.2) b.pt(x, y, z, 1, 0.2 + 0.08 * fbm(x * 0.3, z * 0.3) + b.j(0.06));
    else if (d < 10) b.pt(x, y, z, 0, 0.58 + b.j(0.1));
    else b.pt(x, y, z, 0, 0.32 + 0.2 * fbm(x * 0.06, z * 0.06) + b.j(0.1));
  }

  // Road markings: solid edge lines, dashed centre lines, zebra crossings at the intersection.
  const mark = (x: number, z: number) => b.pt(x, groundY(x, z) + 0.02, z, 2, 0.95);
  const markPts = (pts: V3[]) => b.polyline(pts.map(([x, , z]) => [x, groundY(x, z) + 0.05, z] as V3), 2);
  for (const e of [-6.6, 6.6]) {
    for (let i = b.n(2 * X * 7); i--; ) {
      const x = (r() * 2 - 1) * X;
      if (Math.abs(x - CX) > 7.4) mark(x, e + b.j(0.18));
    }
    for (let i = b.n(2 * Z * 7); i--; ) {
      const z = (r() * 2 - 1) * Z;
      if (Math.abs(z) > 7.4) mark(CX + e + b.j(0.18), z);
    }
    markPts([[-X, 0, e], [CX - 7.4, 0, e]]);
    markPts([[CX + 7.4, 0, e], [X, 0, e]]);
    markPts([[CX + e, 0, -Z], [CX + e, 0, -7.4]]);
    markPts([[CX + e, 0, 7.4], [CX + e, 0, Z]]);
  }
  for (let x0 = -X; x0 < X; x0 += 9) {
    if (Math.abs(x0 + 2.25 - CX) < 12) continue;
    for (let i = b.n(4.5 * 8); i--; ) mark(x0 + r() * 4.5, b.j(0.18));
    markPts([[x0, 0, 0], [x0 + 4.5, 0, 0]]);
  }
  for (let z0 = -Z; z0 < Z; z0 += 9) {
    if (Math.abs(z0 + 2.25) < 12) continue;
    for (let i = b.n(4.5 * 8); i--; ) mark(CX + b.j(0.18), z0 + r() * 4.5);
  }
  for (const s of [-1, 1]) {
    for (let k = -5; k <= 5; k++) {
      for (let i = b.n(18); i--; ) mark(CX + s * 9 + b.j(3), k * 1.2 + b.j(0.55));
      for (let i = b.n(18); i--; ) mark(CX + k * 1.2 + b.j(0.55), s * 9 + b.j(3));
    }
  }

  // Street trees along both streets.
  for (const side of [-1, 1]) {
    for (let x = -X + 6; x < X - 4; x += 18 + r() * 8) {
      if (Math.abs(x - CX) < 14) continue;
      const z = side * (11.6 + r() * 0.8);
      b.tree(x, groundY(x, z), z);
    }
    for (let z = 16; z < Z - 4; z += 18 + r() * 8) {
      const x = CX + side * (11.6 + r() * 0.6);
      const zz = side * z;
      if (!inFootprint(x, zz)) b.tree(x, groundY(x, zz), zz, 0.9);
    }
  }

  // Parks: trees, shrubs and a footpath.
  for (const [x0, x1, z0, z1] of parks) {
    for (let k = 3 + Math.floor(r() * 4); k--; ) {
      const x = lerp(x0 + 3, x1 - 3, r());
      const z = lerp(z0 + 3, z1 - 3, r());
      b.tree(x, groundY(x, z), z, 0.9 + r() * 0.6);
    }
    for (let k = 4; k--; ) {
      const x = lerp(x0, x1, r());
      const z = lerp(z0, z1, r());
      b.blob(x, groundY(x, z) + 0.45, z, 1 + r(), 0.55, 1 + r(), 70, 3, 0.4);
    }
  }

  // Garden hedges and shrubs around the houses.
  for (let k = b.n(25); k--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() < 0.5 ? -1 : 1) * (14 + r() * (Z - 16));
    if (inFootprint(x, z) || streetDist(x, z) < 12) continue;
    b.blob(x, groundY(x, z) + 0.5, z, 0.8 + r() * 1.4, 0.6, 0.8 + r(), 50, 3, 0.42);
  }

  // Power poles with three conductors on the north side; street lights opposite and on the cross street.
  const poleXs: number[] = [];
  for (let x = -112; x <= 112; x += 28) if (Math.abs(x - CX) > 12) poleXs.push(x);
  for (const px of poleXs) {
    const z = 8.7;
    const gy = groundY(px, z);
    b.cylinder(px, z, gy, gy + 11, 0.14, 110, 6, 0.6);
    b.line([px, gy + 10.3, z - 1.3], [px, gy + 10.3, z + 1.3], 30, 6, 0.6);
    b.boxLines(px - 0.5, gy, z - 1.4, px + 0.5, gy + 11, z + 1.4, 6);
  }
  for (let i = 1; i < poleXs.length; i++) {
    const [xa, xb] = [poleXs[i - 1], poleXs[i]];
    for (const dz of [-1.1, 0, 1.1]) {
      const z = 8.7 + dz;
      b.wire([xa, groundY(xa, 8.7) + 10.4, z], [xb, groundY(xb, 8.7) + 10.4, z], (xb - xa) * 0.03, 130, 7);
    }
  }
  const light = (x: number, z: number, dx: number, dz: number) => {
    const y = groundY(x, z);
    b.cylinder(x, z, y, y + 8.5, 0.11, 70, 6, 0.6);
    b.line([x, y + 8.5, z], [x + dx * 2.6, y + 8.5, z + dz * 2.6], 18, 6, 0.7);
    b.boxLines(Math.min(x, x + dx * 2.6) - 0.4, y, Math.min(z, z + dz * 2.6) - 0.4, Math.max(x, x + dx * 2.6) + 0.4, y + 8.6, Math.max(z, z + dz * 2.6) + 0.4, 6);
  };
  for (let x = -100; x < X; x += 48) if (Math.abs(x - CX) > 12) light(x, -8.7, 0, 1);
  for (const z of [-48, 42]) light(CX - 8.7, z, 1, 0);

  // Traffic on both streets.
  for (let k = 0; k < 9; k++) {
    const x = -X + 12 + (k / 9) * (2 * X - 24) + b.j(10);
    if (Math.abs(x - CX) < 10) continue;
    b.car(x, roadY(x), (r() < 0.5 ? -1 : 1) * 3.3, 'x');
  }
  for (const z of [-48, -20, 26, 60]) {
    const x = CX + (z > 0 ? -3.3 : 3.3);
    b.car(x, groundY(x, z), z, 'z');
  }

  return b.build(
    [
      { cls: 0, name: 'Ground' },
      { cls: 1, name: 'Road surface' },
      { cls: 2, name: 'Road marking' },
      { cls: 4, name: 'Vegetation' },
      { cls: 5, name: 'Building' },
      { cls: 6, name: 'Pole' },
      { cls: 7, name: 'Conductor' },
      { cls: 8, name: 'Vehicle' },
    ],
    { radius: 212, elevation: 0.4, azimuth: 0.72, target: [12, 13, -6] },
  );
}

export function corridorScene(seed = 3, density = 1): Scene {
  const r = rng(seed);
  const b = new Builder(r, density);
  const X = 120;
  const Z = 70;
  const zc = (x: number) => 16 * Math.sin(x * 0.013 + 0.4);
  const roadY = (x: number) => 2.5 * Math.sin(x * 0.017);
  const terrain = (x: number, z: number) => roadY(x) + 7 * fbm(x * 0.02 + 5, z * 0.02) + 0.06 * Math.abs(z - zc(x));
  const groundY = (x: number, z: number) => {
    const dz = Math.abs(z - zc(x));
    return lerp(roadY(x), terrain(x, z), smooth(13, 30, dz));
  };

  for (let i = b.n(2 * X * 2 * Z * 1.5); i--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    const dz = Math.abs(z - zc(x));
    const y = groundY(x, z) + b.j(0.05);
    if (dz > 2 && dz < 10) b.pt(x, y, z, 1, 0.2 + 0.07 * fbm(x * 0.4, z * 0.4) + b.j(0.05));
    else if (dz <= 2) b.pt(x, y, z, 3, 0.42 + b.j(0.15));
    else if (dz < 30 && r() < 0.35) b.pt(x, y + 0.3 + r() * 0.4, z, 3, 0.4 + b.j(0.15));
    else b.pt(x, y, z, 0, 0.36 + 0.18 * fbm(x * 0.08, z * 0.08) + b.j(0.1));
  }

  // Lane lines on both carriageways.
  const laneOffsets: [number, boolean][] = [[2.3, false], [6, true], [9.7, false]];
  for (const sign of [-1, 1]) {
    for (const [off, dashed] of laneOffsets) {
      const at = (x: number): V3 => [x, roadY(x) + 0.03, zc(x) + sign * off];
      for (let i = b.n(2 * X * 6); i--; ) {
        const x = (r() * 2 - 1) * X;
        if (dashed && ((x + X) % 12) > 4) continue;
        const p = at(x);
        b.pt(p[0], p[1], p[2] + b.j(0.16), 2, 0.95);
      }
      if (dashed) for (let x = -X; x < X; x += 12) b.seg(at(x), at(x + 4), 2);
      else {
        const pts: V3[] = [];
        for (let x = -X; x <= X; x += 8) pts.push(at(x));
        b.polyline(pts, 2);
      }
    }
  }

  // Median barrier and lighting.
  const barrier: V3[] = [];
  for (let x = -X; x <= X; x += 6) barrier.push([x, roadY(x) + 0.8, zc(x)]);
  for (let i = b.n(2 * X * 10); i--; ) {
    const x = (r() * 2 - 1) * X;
    b.pt(x, roadY(x) + 0.3 + r() * 0.5, zc(x) + b.j(0.3), 6, 0.75);
  }
  b.polyline(barrier, 6);
  for (let x = -X + 10; x < X; x += 36) {
    const z = zc(x);
    const y = roadY(x);
    b.cylinder(x, z, y, y + 12, 0.13, 100, 6, 0.65);
    b.line([x, y + 12, z - 3], [x, y + 12, z + 3], 30, 6, 0.65);
    b.boxLines(x - 0.4, y, z - 3, x + 0.4, y + 12.2, z + 3, 6);
  }

  // Overhead sign gantry.
  {
    const gx = 34;
    const z = zc(gx);
    const y = roadY(gx);
    for (const s of [-1, 1]) b.cylinder(gx, z + s * 11.5, y, y + 7.5, 0.25, 110, 6, 0.7);
    b.line([gx, y + 7.2, z - 11.5], [gx, y + 7.2, z + 11.5], 160, 6, 0.7, 0.3);
    for (const s of [-1, 1]) b.boxShell(gx - 0.1, y + 5, z + s * 6 - 2.5, gx + 0.1, y + 7, z + s * 6 + 2.5, 6, 30, () => 0.98);
    b.boxLines(gx - 0.4, y, z - 11.8, gx + 0.4, y + 7.6, z + 11.8, 6);
  }

  // Roadside signs.
  for (let x = -X + 20; x < X; x += 45 + r() * 20) {
    const z = zc(x) + 11.5;
    const y = groundY(x, z);
    b.line([x, y, z], [x, y + 2.4, z], 30, 6, 0.6);
    b.boxShell(x - 0.05, y + 2.4, z - 0.6, x + 0.05, y + 3.6, z + 0.6, 6, 60, () => 0.98);
    b.boxLines(x - 0.3, y, z - 0.7, x + 0.3, y + 3.7, z + 0.7, 6);
  }

  // Woodland beyond the verge.
  for (let k = b.n(160); k--; ) {
    const x = (r() * 2 - 1) * X;
    const z = zc(x) + (r() < 0.5 ? -1 : 1) * (24 + r() * 46);
    if (Math.abs(z) > Z) continue;
    b.tree(x, groundY(x, z), z, 0.9 + r() * 0.6, 18);
  }

  // Traffic, including a truck.
  for (let k = 0; k < 10; k++) {
    const sign = k % 2 ? 1 : -1;
    const lane = r() < 0.5 ? 4.1 : 7.9;
    const x = -X + 10 + (k / 10) * (2 * X - 20) + b.j(8);
    if (k === 4) {
      const y = roadY(x);
      const z = zc(x) + sign * lane;
      b.boxShell(x - 7, y + 0.6, z - 1.25, x + 5, y + 4, z + 1.25, 8, 10, () => 0.8 + b.j(0.1));
      b.boxLines(x - 7, y + 0.6, z - 1.25, x + 7, y + 4, z + 1.25, 8);
      b.boxShell(x + 5.2, y + 0.6, z - 1.2, x + 7, y + 3.2, z + 1.2, 8, 18, () => 0.6);
    } else b.car(x, roadY(x), zc(x) + sign * lane, 'x');
  }

  return b.build(
    [
      { cls: 0, name: 'Ground' },
      { cls: 1, name: 'Pavement' },
      { cls: 2, name: 'Lane marking' },
      { cls: 3, name: 'Low vegetation' },
      { cls: 4, name: 'Trees' },
      { cls: 6, name: 'Barrier & signage' },
      { cls: 8, name: 'Vehicle' },
    ],
    { radius: 175, elevation: 0.5, azimuth: 0.55, target: [0, 3, 0] },
  );
}

export function powerlineScene(seed = 5, density = 1): Scene {
  const r = rng(seed);
  const b = new Builder(r, density);
  const X = 130;
  const Z = 70;
  const groundY = (x: number, z: number) => 9 * fbm(x * 0.012 + 2, z * 0.012 + 7) + 3 * Math.sin(x * 0.02);

  for (let i = b.n(2 * X * 2 * Z * 1.2); i--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    const y = groundY(x, z) + b.j(0.08);
    if (Math.abs(z) < 18 && r() < 0.3) b.pt(x, y + 0.2 + r() * 0.6, z, 3, 0.4 + b.j(0.15));
    else b.pt(x, y, z, 0, 0.33 + 0.18 * fbm(x * 0.07, z * 0.07) + b.j(0.1));
  }

  // Forest either side of the easement.
  for (let k = b.n(420); k--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() < 0.5 ? -1 : 1) * (19 + r() * 50);
    b.tree(x, groundY(x, z), z, 1 + r() * 0.7, 14);
  }

  // Lattice towers.
  const towerXs = [-110, -38, 34, 106];
  const H = 36;
  const arms: [number, number][] = [[24, 9], [29.5, 7.5]];
  const attach: V3[][] = towerXs.map(() => []);
  towerXs.forEach((tx, ti) => {
    const gy = groundY(tx, 0) - 0.3;
    const legs: V3[] = [];
    const tops: V3[] = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const bottom: V3 = [tx + sx * 4.2, gy, sz * 4.2];
      const top: V3 = [tx + sx * 1.1, gy + H, sz * 1.1];
      legs.push(bottom);
      tops.push(top);
      b.line(bottom, top, 160, 6, 0.65, 0.12);
      b.seg(bottom, top, 6);
    }
    // Cross bracing on each face.
    for (let f = 0; f < 4; f++) {
      const [a0, a1, b0, b1] = [legs[f], legs[(f + 1) % 4], tops[f], tops[(f + 1) % 4]];
      for (let s = 0; s < 6; s++) {
        const t0 = s / 6;
        const t1 = (s + 1) / 6;
        const p = (t: number, i: 0 | 1): V3 => {
          const [lo, hi] = i ? [a1, b1] : [a0, b0];
          return [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
        };
        b.line(p(t0, 0), p(t1, 1), 22, 6, 0.6, 0.08);
        b.line(p(t0, 1), p(t1, 0), 22, 6, 0.6, 0.08);
      }
    }
    for (const [ay, half] of arms) {
      const y = gy + ay;
      b.line([tx, y, -half], [tx, y, half], 90, 6, 0.65, 0.15);
      b.seg([tx, y, -half], [tx, y, half], 6);
      attach[ti].push([tx, y - 2.5, -half], [tx, y - 2.5, half]);
    }
    attach[ti].push([tx, gy + H, 0]);
    b.objects.push(tx - 4.2);
  });

  // Conductors and earth wire, with clearance flags where trees creep under the span.
  for (let i = 1; i < towerXs.length; i++) {
    attach[i].forEach((p, k) => b.wire(attach[i - 1][k], p, k === 4 ? 4.5 : 6.5, 320, 7));
    const mid = (towerXs[i - 1] + towerXs[i]) / 2;
    for (let k = 0; k < 2; k++) {
      const x = mid + b.j(30);
      const z = (k ? 1 : -1) * (12 + r() * 4);
      const gy = groundY(x, z);
      const top = b.tree(x, gy, z, 2.1, 12);
      b.boxLines(x - 6, gy, z - 6, x + 6, top, z + 6, 10);
    }
  }

  return b.build(
    [
      { cls: 0, name: 'Ground' },
      { cls: 3, name: 'Low vegetation' },
      { cls: 4, name: 'Trees' },
      { cls: 6, name: 'Tower' },
      { cls: 7, name: 'Conductor' },
      { cls: 10, name: 'Clearance risk' },
    ],
    { radius: 190, elevation: 0.42, azimuth: 0.65, target: [0, 14, 0] },
  );
}

export function mineScene(seed = 9, density = 1): Scene {
  const r = rng(seed);
  const b = new Builder(r, density);
  const X = 190;
  const Z = 150;
  const terrain = (x: number, z: number) => 3.5 * fbm(x * 0.01 + 1, z * 0.01 + 3) + 0.8 * fbm(x * 0.04, z * 0.04);

  // Pit outline: a stadium skeleton elongated along strike, warped by noise and a pushback lobe.
  const a = 0.25;
  const D: [number, number] = [Math.cos(a), Math.sin(a)];
  const N: [number, number] = [-Math.sin(a), Math.cos(a)];
  const L = 100;
  const Rp = 70;
  const A: [number, number] = [-15 - (D[0] * L) / 2, -5 - (D[1] * L) / 2];
  const B: [number, number] = [-15 + (D[0] * L) / 2, -5 + (D[1] * L) / 2];
  const Ptot = 2 * L + 2 * Math.PI * Rp;
  const lobe: [number, number] = [B[0] + 5, B[1] - 55];

  /** Horizontal distance inside the pit crest (negative outside). */
  const pitT = (x: number, z: number) => {
    const s = clamp01(((x - A[0]) * D[0] + (z - A[1]) * D[1]) / L);
    const d = Math.hypot(x - (A[0] + D[0] * L * s), z - (A[1] + D[1] * L * s)) - Rp;
    const warp = 7 * fbm(x * 0.014 + 4, z * 0.014 - 2);
    const bulge = 18 * Math.exp(-((x - lobe[0]) ** 2 + (z - lobe[1]) ** 2) / (2 * 34 * 34));
    return -(d + warp) + bulge;
  };

  // Position around the pit perimeter, measured along the skeleton's outer contour.
  const perim = (x: number, z: number) => {
    const px = x - A[0];
    const pz = z - A[1];
    const s = (px * D[0] + pz * D[1]) / L;
    if (s >= 0 && s <= 1) return px * N[0] + pz * N[1] >= 0 ? s * L : L + Math.PI * Rp + (1 - s) * L;
    if (s > 1) {
      const vx = x - B[0];
      const vz = z - B[1];
      return L + Math.atan2(vx * D[0] + vz * D[1], vx * N[0] + vz * N[1]) * Rp;
    }
    return 2 * L + Math.PI * Rp + Math.atan2(-(px * D[0] + pz * D[1]), -(px * N[0] + pz * N[1])) * Rp;
  };

  // Inverse of (perim, pitT): walk out along the skeleton normal until the warped distance matches.
  const pointAt = (u: number, t: number): [number, number] => {
    u = ((u % Ptot) + Ptot) % Ptot;
    let q: [number, number];
    let n: [number, number];
    if (u < L) [q, n] = [[A[0] + D[0] * u, A[1] + D[1] * u], N];
    else if (u < L + Math.PI * Rp) {
      const f = (u - L) / Rp;
      [q, n] = [B, [N[0] * Math.cos(f) + D[0] * Math.sin(f), N[1] * Math.cos(f) + D[1] * Math.sin(f)]];
    } else if (u < 2 * L + Math.PI * Rp) {
      const s = 1 - (u - L - Math.PI * Rp) / L;
      [q, n] = [[A[0] + D[0] * L * s, A[1] + D[1] * L * s], [-N[0], -N[1]]];
    } else {
      const f = (u - 2 * L - Math.PI * Rp) / Rp;
      [q, n] = [A, [-N[0] * Math.cos(f) - D[0] * Math.sin(f), -N[1] * Math.cos(f) - D[1] * Math.sin(f)]];
    }
    let rr = Rp - t;
    for (let k = 0; k < 8; k++) rr += pitT(q[0] + n[0] * rr, q[1] + n[1] * rr) - t;
    return [q[0] + n[0] * rr, q[1] + n[1] * rr];
  };

  // Bench design: 8 m faces at a steep batter, berms of varying width, then the pit floor.
  const H = 8;
  const face = 3.5;
  const benches = 6;
  const berms = Array.from({ length: benches }, () => 4.5 + r() * 2.5);
  const crests: number[] = [];
  let acc = 0;
  for (const berm of berms) {
    crests.push(acc);
    acc += face + berm;
  }
  const floorT = acc;
  const floorY = -benches * H;
  const profile = (t: number): [number, boolean] => {
    for (let i = 0; i < benches; i++) {
      if (t < crests[i] + face) return [-i * H - ((t - crests[i]) / face) * H, true];
      if (t < crests[i] + face + berms[i]) return [-(i + 1) * H, false];
    }
    return [floorY, false];
  };
  const rimBlend = (t: number) => 1 - smooth(0, 25, t);

  // Haul ramp: descends at 10% around the walls from the north crest to the floor.
  const grade = 0.1;
  const u0 = 0.6 * L;
  const qMax = -floorY / grade;
  const rampT = (q: number) => Math.min(floorT, ((q * grade) / H) * (floorT / benches));
  const ramp = (t: number, u: number): number | null => {
    for (let k = 0; k < 2; k++) {
      const q = ((((u - u0) % Ptot) + Ptot) % Ptot) + k * Ptot;
      if (q > qMax) break;
      if (Math.abs(t - rampT(q)) < 5.5) return q;
    }
    return null;
  };

  // Waste dump: two lifts on an irregular, flat-topped footprint to the north-east.
  const dumpC: [number, number] = [118, 108];
  const dumpR: [number, number] = [58, 34];
  const dumpShape = (th: number) => 1 + 0.1 * Math.sin(3 * th + 1) + 0.06 * Math.sin(5 * th + 2);
  const dumpT = (x: number, z: number) => {
    const dx = (x - dumpC[0]) / dumpR[0];
    const dz = (z - dumpC[1]) / dumpR[1];
    return (1 - Math.hypot(dx, dz) / dumpShape(Math.atan2(dz, dx))) * dumpR[1];
  };
  const dumpPoint = (th: number, t: number): [number, number] => {
    const k = (1 - t / dumpR[1]) * dumpShape(th);
    return [dumpC[0] + Math.cos(th) * dumpR[0] * k, dumpC[1] + Math.sin(th) * dumpR[1] * k];
  };
  const dumpH = (t: number) => (t < 0 ? 0 : t < 10 ? 1.4 * t : t < 16 ? 14 : t < 26 ? 14 + 1.4 * (t - 16) : 28);

  // ROM pad with crusher, and the haul roads linking pit, pad and dump.
  const pad: [number, number, number] = [-118, 104, 30];
  const exit = pointAt(u0, -6);
  const roads: V3[][] = [
    [[exit[0], 0, exit[1]], [exit[0] - 6, 0, exit[1] + 22], [-60, 0, 100], [pad[0] + 20, 0, pad[1] - 4]],
    [[exit[0] - 6, 0, exit[1] + 22], [20, 0, 104], [dumpPoint(Math.PI * 1.05, -4)[0], 0, dumpPoint(Math.PI * 1.05, -4)[1]]],
  ];
  const roadDist = (x: number, z: number) => {
    let best = Infinity;
    for (const road of roads) {
      for (let i = 1; i < road.length; i++) {
        const [ax, , az] = road[i - 1];
        const [bx, , bz] = road[i];
        const t = clamp01(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2));
        best = Math.min(best, Math.hypot(x - (ax + (bx - ax) * t), z - (az + (bz - az) * t)));
      }
    }
    return best;
  };
  const padY = terrain(pad[0], pad[1]);
  const outsideY = (x: number, z: number) => lerp(padY, terrain(x, z), smooth(pad[2], pad[2] + 15, Math.hypot(x - pad[0], z - pad[1])));

  const strata = (x: number, y: number, z: number) =>
    0.44 + 0.12 * Math.sin(y * 0.38 + 2 * fbm(x * 0.02, z * 0.02)) + 0.06 * noise2(x * 0.08, y * 0.3);

  const pitPoint = (x: number, z: number, t: number) => {
    const u = perim(x, z);
    const q = ramp(t, u);
    if (q !== null) {
      const y = -q * grade + terrain(x, z) * rimBlend(rampT(q));
      b.pt(x, y + b.j(0.08), z, 1, 0.27 + b.j(0.06));
      return false;
    }
    const [py, isFace] = profile(t);
    const y = py + terrain(x, z) * rimBlend(t) + b.j(0.12);
    if (t > floorT + 4 && fbm(x * 0.04, z * 0.04) > -0.15) {
      // Sump water returns few points.
      if (r() < 0.25) b.pt(x, floorY + 0.4, z, 11, 0.1 + b.j(0.05));
      return false;
    }
    b.pt(x, y, z, 0, strata(x, y, z) + (isFace ? -0.06 : 0.04) + b.j(0.08));
    return isFace;
  };

  for (let i = b.n(2 * X * 2 * Z * 0.9); i--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    const t = pitT(x, z);
    if (t > 0) {
      // Steep faces get extra samples so the benches read clearly.
      if (pitPoint(x, z, t)) {
        for (let k = 2; k--; ) {
          const jx = x + b.j(2);
          const jz = z + b.j(2);
          const jt = pitT(jx, jz);
          if (jt > 0) pitPoint(jx, jz, jt);
        }
      }
      continue;
    }
    const td = dumpT(x, z);
    const y = outsideY(x, z);
    if (td > 0) {
      b.pt(x, y + dumpH(td) + b.j(0.15), z, 9, 0.55 + 0.1 * fbm(x * 0.05, z * 0.05) + b.j(0.1));
    } else if (roadDist(x, z) < 6) {
      b.pt(x, y + 0.15 + b.j(0.05), z, 1, 0.3 + b.j(0.06));
    } else if (Math.hypot(x - pad[0], z - pad[1]) < pad[2]) {
      b.pt(x, y + b.j(0.05), z, 0, 0.62 + b.j(0.08));
    } else if (r() < 0.05 && t < -12) {
      b.pt(x, y + 0.2 + r() * 0.6, z, 3, 0.36 + b.j(0.1));
    } else {
      b.pt(x, y + b.j(0.08), z, 0, 0.5 + 0.12 * fbm(x * 0.03, z * 0.03) + b.j(0.08));
    }
  }

  // Scrub clumps beyond the disturbed area.
  for (let k = b.n(160); k--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    if (pitT(x, z) > -20 || dumpT(x, z) > -10 || roadDist(x, z) < 12 || Math.hypot(x - pad[0], z - pad[1]) < pad[2] + 8) continue;
    b.blob(x, outsideY(x, z) + 0.7, z, 1.2 + r() * 1.8, 0.8, 1.2 + r() * 1.5, 45, 3, 0.4);
  }

  // Vectors: bench crests, pit floor toe, ramp and haul road centrelines.
  const loop = (fn: (u: number) => V3, steps = 140) => {
    const pts: V3[] = [];
    for (let i = 0; i <= steps; i++) pts.push(fn((i / steps) * Ptot));
    return pts;
  };
  for (let i = 0; i < benches; i++) {
    b.polyline(loop((u) => {
      const [x, z] = pointAt(u, crests[i]);
      return [x, -i * H + terrain(x, z) * rimBlend(crests[i]) + 0.3, z];
    }), 6);
  }
  b.polyline(loop((u) => {
    const [x, z] = pointAt(u, floorT);
    return [x, floorY + 0.3, z];
  }), 6);
  b.objects.push(A[0] - Rp);
  const rampLine: V3[] = [];
  for (let q = 0; q <= qMax; q += 8) {
    const [x, z] = pointAt(u0 + q, rampT(q));
    rampLine.push([x, -q * grade + terrain(x, z) * rimBlend(rampT(q)) + 0.4, z]);
  }
  // Road centrelines drawn in white so they stand out against the dark pavement points.
  b.polyline(rampLine, 2);
  for (const road of roads) b.polyline(road.map(([x, , z]) => [x, outsideY(x, z) + 0.4, z] as V3), 2);

  // Dump toe and lift crests.
  for (const t of [0, 10, 16, 26]) {
    const pts: V3[] = [];
    for (let i = 0; i <= 90; i++) {
      const [x, z] = dumpPoint((i / 90) * Math.PI * 2, t);
      pts.push([x, outsideY(x, z) + dumpH(t) + 0.3, z]);
    }
    b.polyline(pts, 9);
  }
  b.objects.push(dumpC[0] - dumpR[0]);

  // ROM stockpiles, crusher, conveyor and processing plant.
  for (const [cx, cz, rad, h] of [[-128, 114, 11, 7], [-106, 116, 9, 6], [-116, 92, 8, 5]]) {
    for (let i = b.n(rad * rad * 7); i--; ) {
      const th = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * rad;
      b.pt(cx + Math.cos(th) * d, padY + h * (1 - d / rad) + b.j(0.1), cz + Math.sin(th) * d, 9, 0.6 + b.j(0.12));
    }
    const ring: V3[] = [];
    for (let i = 0; i <= 24; i++) ring.push([cx + Math.cos((i / 24) * Math.PI * 2) * rad, padY + 0.3, cz + Math.sin((i / 24) * Math.PI * 2) * rad]);
    b.polyline(ring, 9);
    b.objects.push(cx - rad);
  }
  b.boxShell(-146, padY, 84, -136, padY + 14, 94, 5, 2, () => 0.75 + b.j(0.1));
  b.boxLines(-146, padY, 84, -136, padY + 14, 94, 5);
  const plantY = terrain(-168, 50);
  const conveyor: [V3, V3] = [[-141, padY + 12, 84], [-166, plantY + 16, 58]];
  b.line(conveyor[0], conveyor[1], 220, 5, 0.7, 0.5);
  b.seg(conveyor[0], conveyor[1], 5);
  for (const [px, pz, w, d, h] of [[-184, 34, 26, 18, 13], [-178, 60, 14, 10, 18], [-156, 30, 12, 8, 7]]) {
    const y = terrain(px + w / 2, pz + d / 2) - 0.3;
    b.boxShell(px, y, pz, px + w, y + h, pz + d, 5, 1.4, () => 0.72 + b.j(0.12));
    b.boxLines(px, y, pz, px + w, y + h, pz + d, 5);
  }
  for (const [tx, tz] of [[-150, 52], [-150, 66]]) {
    const y = terrain(tx, tz);
    b.cylinder(tx, tz, y, y + 9, 5, 600, 5, 0.8);
    for (let i = b.n(80); i--; ) {
      const th = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 5;
      b.pt(tx + Math.cos(th) * d, y + 9, tz + Math.sin(th) * d, 5, 0.85);
    }
  }

  // Fleet: trucks on the ramp and haul roads, a shovel loading on the pit floor.
  for (const q of [70, 210, 360]) {
    const [x, z] = pointAt(u0 + q, rampT(q));
    const [x2, z2] = pointAt(u0 + q + 4, rampT(q + 4));
    const y = -q * grade + terrain(x, z) * rimBlend(rampT(q));
    b.car(x, y, z, Math.abs(x2 - x) > Math.abs(z2 - z) ? 'x' : 'z', 9, 5.5, 4.6, 0.12);
  }
  for (const [x, z, dir] of [[-75, 101, 'x'], [8, 103, 'x']] as const) b.car(x, outsideY(x, z), z, dir, 9, 5.5, 4.6, 0.12);
  {
    const [sx, sz] = pointAt(Ptot * 0.47, floorT + 2);
    b.boxShell(sx - 4, floorY, sz - 3, sx + 4, floorY + 6, sz + 3, 8, 6, () => 0.85 + b.j(0.1));
    b.boxLines(sx - 4, floorY, sz - 3, sx + 4, floorY + 6, sz + 3, 8);
    b.line([sx, floorY + 5, sz], [sx - 6, floorY + 12, sz + 7], 60, 8, 0.8, 0.3);
    b.car(sx + 12, floorY, sz + 4, 'x', 9, 5.5, 4.6, 0.12);
  }

  const scene = b.build(
    [
      { cls: 0, name: 'Pit & terrain' },
      { cls: 6, name: 'Crest & toe' },
      { cls: 1, name: 'Haul road & ramp' },
      { cls: 9, name: 'Waste dump & ROM' },
      { cls: 11, name: 'Sump water' },
      { cls: 8, name: 'Fleet' },
      { cls: 5, name: 'Plant' },
      { cls: 3, name: 'Scrub' },
    ],
    { radius: 320, elevation: 0.55, azimuth: Math.PI + 0.35, target: [-10, -16, 25] },
  );
  scene.pointScale = 1.35;
  return scene;
}

export function siteScene(seed = 21, density = 1): Scene {
  const r = rng(seed);
  const b = new Builder(r, density);
  const X = 90;
  const Z = 70;
  const groundY = (x: number, z: number) => {
    let y = 0.8 * fbm(x * 0.03, z * 0.03);
    // Excavated basement east of the structure.
    if (x > 22 && x < 62 && z > -22 && z < 18) {
      const e = Math.min(x - 22, 62 - x, z + 22, 18 - z);
      y -= Math.min(5, e * 1.2);
    }
    return y;
  };

  // Structure footprint.
  const [sx0, sx1, sz0, sz1] = [-46, 2, -18, 14];
  for (let i = b.n(2 * X * 2 * Z * 1.4); i--; ) {
    const x = (r() * 2 - 1) * X;
    const z = (r() * 2 - 1) * Z;
    if (x > sx0 && x < sx1 && z > sz0 && z < sz1) continue;
    const y = groundY(x, z) + b.j(0.06);
    const haul = Math.abs(z + 30) < 4 || Math.abs(x - 70) < 4;
    b.pt(x, y, z, haul ? 1 : 0, haul ? 0.28 + b.j(0.08) : 0.5 + 0.16 * fbm(x * 0.06, z * 0.06) + b.j(0.12));
  }

  // Columns, slabs and slab-edge vectors, with the upper floors still in progress.
  const floors = [0, 4.2, 8.4, 12.6, 16.8, 21];
  const cols: [number, number][] = [];
  for (let x = sx0; x <= sx1 + 0.1; x += 8) for (let z = sz0; z <= sz1 + 0.1; z += 8) cols.push([x, z]);
  floors.forEach((fy, fi) => {
    const extent = fi < 4 ? 1 : fi === 4 ? 0.62 : 0.3;
    const xe = lerp(sx0, sx1, extent);
    if (fi < floors.length - 1) {
      for (let i = b.n((xe - sx0) * (sz1 - sz0) * 2.2); i--; ) {
        b.pt(lerp(sx0, xe, r()), fy + 0.3 + b.j(0.05), lerp(sz0, sz1, r()), 5, 0.6 + b.j(0.15));
      }
      // Slab edges catch more returns than the soffit, so densify the perimeter.
      for (let i = b.n((xe - sx0 + sz1 - sz0) * 2 * 6); i--; ) {
        const t = r() * 2 * (xe - sx0 + sz1 - sz0);
        const w = xe - sx0;
        const d = sz1 - sz0;
        const [x, z] = t < w ? [sx0 + t, sz0] : t < w + d ? [xe, sz0 + t - w] : t < 2 * w + d ? [xe - (t - w - d), sz1] : [sx0, sz1 - (t - 2 * w - d)];
        b.pt(x, fy + r() * 0.4, z, 5, 0.75 + b.j(0.1));
      }
      b.polyline([[sx0, fy + 0.3, sz0], [xe, fy + 0.3, sz0], [xe, fy + 0.3, sz1], [sx0, fy + 0.3, sz1], [sx0, fy + 0.3, sz0]], 5);
    }
    if (fi > 0) {
      for (const [cx, cz] of cols) {
        if (cx > xe + 0.1) continue;
        b.cylinder(cx, cz, floors[fi - 1] + 0.3, fy, 0.35, 40, 5, 0.65);
      }
    }
  });
  b.objects.push(sx0);

  // Tower crane.
  {
    const [cx, cz] = [8, 22];
    const H = 52;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      b.line([cx + dx, 0, cz + dz], [cx + dx, H, cz + dz], 220, 6, 0.75, 0.1);
      b.seg([cx + dx, 0, cz + dz], [cx + dx, H, cz + dz], 6);
    }
    for (let y = 0; y < H; y += 3) b.line([cx - 1, y, cz - 1], [cx + 1, y + 3, cz + 1], 8, 6, 0.7, 0.05);
    const jib: [V3, V3] = [[cx - 16, H, cz], [cx + 50, H, cz - 20]];
    b.line(jib[0], jib[1], 380, 6, 0.75, 0.4);
    b.seg(jib[0], jib[1], 6);
    b.line([cx, H + 8, cz], [cx + 50, H, cz - 20], 120, 7, 0.55, 0.05);
    b.line([cx, H + 8, cz], [cx - 16, H, cz], 50, 7, 0.55, 0.05);
    b.line([cx - 1, H, cz - 1], [cx, H + 8, cz], 30, 6, 0.75, 0.08);
    b.boxShell(cx - 15, H - 3, cz - 1.5, cx - 10, H, cz + 1.5, 5, 6, () => 0.85);
    b.line([cx + 30, H, cz - 12], [cx + 30, 24, cz - 12], 60, 7, 0.55, 0.04);
  }

  // Plant, sheds and material.
  b.car(50, groundY(50, -30), -30, 'x', 9, 3.4, 3.6);
  b.car(70, groundY(70, 20), 20, 'z', 8, 3, 3.2);
  b.car(40, groundY(40, -5) , -5, 'x', 7, 3.2, 3.4);
  for (const [px, pz, w, d] of [[-70, 40, 12, 3], [-55, 40, 12, 3], [-78, -44, 18, 6]]) {
    const y = groundY(px, pz);
    b.boxShell(px, y, pz, px + w, y + 2.8, pz + d, 5, 3, () => 0.8 + b.j(0.1));
    b.boxLines(px, y, pz, px + w, y + 2.8, pz + d, 5);
  }
  for (const [px, pz, rad, h] of [[-20, -44, 9, 4.5], [-2, -48, 6, 3]]) {
    for (let i = b.n(rad * rad * 9); i--; ) {
      const t = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * rad;
      b.pt(px + Math.cos(t) * d, groundY(px, pz) + h * (1 - d / rad), pz + Math.sin(t) * d, 9, 0.5 + b.j(0.15));
    }
    b.boxLines(px - rad, 0, pz - rad, px + rad, h, pz + rad, 9);
  }
  for (let x = -X + 4; x < X; x += 11 + r() * 8) b.tree(x, groundY(x, 62), 62 + b.j(6), 0.9, 20);

  return b.build(
    [
      { cls: 0, name: 'Earthworks' },
      { cls: 1, name: 'Haul road' },
      { cls: 5, name: 'Structure' },
      { cls: 6, name: 'Crane' },
      { cls: 9, name: 'Material' },
      { cls: 8, name: 'Plant' },
      { cls: 4, name: 'Trees' },
    ],
    { radius: 185, elevation: 0.5, azimuth: 0.6, target: [-2, 14, 4] },
  );
}

export const SCENES = {
  city: cityScene,
  corridor: corridorScene,
  powerline: powerlineScene,
  mine: mineScene,
  site: siteScene,
} as const;

export type SceneName = keyof typeof SCENES;
