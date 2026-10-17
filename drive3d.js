(function () {
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";

const VECTOR_Z = 14;
const CHUNK_RADIUS = 1;
const M_PER_DEG_LAT = 111320;
const EYE_HEIGHT = 1.7;
const ROAD_WIDTH = 9;

const TERRAIN_ON = true;
const TERRAIN_Z = 14;
const BASE_GRID = 220;
const DRAPE_STEP = 12;
const DRAPE_MAXN = 40;
const FOUNDATION = 6;

// Layer heights above the terrain. These must exceed the small mismatch between
// the base ground grid and the independently-draped overlays, otherwise layers
// flicker through / sink into the ground. Flat overlays at this scale look flush.
const WATER_Y = 0.05;
const AREA_LAYER_BASE = { water: WATER_Y, landcover: 0.25, landuse: 0.4, park: 0.55 };
const AREA_LAYER_BAND = { water: 0.01, landcover: 0.1, landuse: 0.1, park: 0.1 };
const ROAD_Y = 0.75;
const ROUTE_Y = 0.9;
const BASE_SINK = 0.15;

const CAR = {
  maxForward: 42,
  maxReverse: -9,
  accel: 15,
  brake: 30,
  coast: 7,
  offRoad: 10,
  steer: 68,
  roadWidth: 24,
  radius: 1.4,
};

const WATER_MARGIN = 6;
const LINE_HALF = 10;
const LINE_DEPTH = 4;
const LINE_COLS = 10;
const LINE_Y = 1.05;
const START_BACK = 8;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

const tileBufferCache = new Map();
function fetchTileBuffer(template, z, x, y) {
  const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  if (!tileBufferCache.has(url)) {
    const promise = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : null))
      .catch(() => null);
    tileBufferCache.set(url, promise);
  }
  return tileBufferCache.get(url);
}

const demTiles = new Map();
const demPromises = new Map();
const DEM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Terrarium heightmap: height (m) = R*256 + G + B/256 - 32768.
function loadDem(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demTiles.has(key)) return Promise.resolve(demTiles.get(key));
  if (demPromises.has(key)) return demPromises.get(key);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const w = img.width || 256;
        const h = img.height || 256;
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const heights = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          heights[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
        }
        resolve({ w, h, heights });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = DEM_URL(z, x, y);
  }).then((v) => {
    demTiles.set(key, v);
    demPromises.delete(key);
    while (demTiles.size > 64) {
      const oldest = demTiles.keys().next().value;
      if (oldest === key) break;
      demTiles.delete(oldest);
    }
    return v;
  });
  demPromises.set(key, promise);
  return promise;
}

function demValue(dem, u, v) {
  const { w, h, heights } = dem;
  const x = clamp(u, 0, w - 1);
  const y = clamp(v, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = heights[y0 * w + x0];
  const b = heights[y0 * w + x1];
  const c = heights[y1 * w + x0];
  const d = heights[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function sampleDem(lon, lat) {
  const z = TERRAIN_Z;
  const tx = lonToTileX(lon, z);
  const ty = latToTileY(lat, z);
  const xi = Math.floor(tx);
  const yi = Math.floor(ty);
  const dem = demTiles.get(`${z}/${xi}/${yi}`);
  if (!dem) return 0;
  return demValue(dem, (tx - xi) * dem.w - 0.5, (ty - yi) * dem.h - 0.5);
}

let tileTemplatePromise = null;
function getTileTemplate() {
  if (!tileTemplatePromise) {
    tileTemplatePromise = fetch(TILEJSON_URL)
      .then((r) => r.json())
      .then((j) => j.tiles[0]);
  }
  return tileTemplatePromise;
}

function initDrive3D() {
  const screenEl = document.getElementById("drive3d");
  const canvas = document.getElementById("drive3d-canvas");
  const el = {
    speed: document.getElementById("d3-speed"),
    speedUnit: document.getElementById("d3-speed-unit"),
    progress: document.getElementById("d3-progress"),
    progressFill: document.getElementById("d3-progress-fill"),
    warning: document.getElementById("d3-warning"),
    water: document.getElementById("d3-water"),
    empty: document.getElementById("d3-empty"),
    end: document.getElementById("d3-end"),
    endDistance: document.getElementById("d3-end-distance"),
    endTime: document.getElementById("d3-end-time"),
    controls: document.querySelector("#drive3d .drive-controls"),
  };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  scene.fog = new THREE.Fog(0x9fc4e8, 180, 1100);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.3, 4000);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6f78, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-80, 160, 60);
  scene.add(sun);

  const chunkGroup = new THREE.Group();
  const routeGroup = new THREE.Group();
  const markerGroup = new THREE.Group();
  scene.add(chunkGroup, routeGroup, markerGroup);

  const baseMaterial = new THREE.MeshBasicMaterial({ color: 0xe6e4dc, side: THREE.DoubleSide });
  const flatMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const routeMaterial = new THREE.MeshBasicMaterial({ color: 0x2563eb, side: THREE.DoubleSide });

  const state = {
    track: null,
    loadedRef: null,
    origin: null,
    cum: [],
    total: 0,
    car: { lon: 0, lat: 0, heading: 0, speed: 0 },
    input: { left: false, right: false, accel: false, brake: false },
    offRoad: false,
    progress: 0,
    done: false,
    started: false,
    startedAt: null,
    startLine: null,
    finishLine: null,
    lastTime: 0,
    chunks: new Map(),
    chunkCenter: null,
    nextTileCheck: 0,
    blocked: false,
    waterUntil: 0,
  };

  function toWorld(lon, lat) {
    const o = state.origin;
    return {
      x: (lon - o.lon) * M_PER_DEG_LAT * o.cosLat,
      z: -(lat - o.lat) * M_PER_DEG_LAT,
    };
  }

  // Ground elevation (m) at a world-space point, from the DEM.
  function terrainY(x, z) {
    if (!TERRAIN_ON || !state.origin) return 0;
    const o = state.origin;
    const lon = o.lon + x / (M_PER_DEG_LAT * o.cosLat);
    const lat = o.lat - z / M_PER_DEG_LAT;
    return sampleDem(lon, lat);
  }

  function nearest(lon, lat) {
    const track = state.track;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let bestDist = Infinity;
    let bestAlong = 0;
    let bestI = 0;
    for (let i = 0; i < track.length - 1; i++) {
      const ax = (track[i][0] - lon) * M_PER_DEG_LAT * cosLat;
      const ay = (track[i][1] - lat) * M_PER_DEG_LAT;
      const bx = (track[i + 1][0] - lon) * M_PER_DEG_LAT * cosLat;
      const by = (track[i + 1][1] - lat) * M_PER_DEG_LAT;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
      t = clamp(t, 0, 1);
      const dist = Math.hypot(ax + dx * t, ay + dy * t);
      if (dist < bestDist) {
        bestDist = dist;
        bestAlong = state.cum[i] + t * (state.cum[i + 1] - state.cum[i]);
        bestI = i;
      }
    }
    const a = track[bestI];
    const b = track[bestI + 1] || a;
    const segLen = state.cum[bestI + 1] - state.cum[bestI];
    const ratio = segLen ? (bestAlong - state.cum[bestI]) / segLen : 0;
    let heading = bearing(a, b);
    heading = ((heading % 360) + 360) % 360;
    return {
      dist: bestDist,
      along: bestAlong,
      lon: a[0] + (b[0] - a[0]) * ratio,
      lat: a[1] + (b[1] - a[1]) * ratio,
      heading,
    };
  }

  const pointInRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x;
      const zi = ring[i].z;
      const xj = ring[j].x;
      const zj = ring[j].z;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };

  function distToSegment(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    t = clamp(t, 0, 1);
    const cx = ax + t * dx;
    const cz = az + t * dz;
    return Math.hypot(px - cx, pz - cz);
  }

  function distToRing(ring, x, z) {
    let best = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const d = distToSegment(x, z, ring[j].x, ring[j].z, ring[i].x, ring[i].z);
      if (d < best) best = d;
    }
    return best;
  }

  function blockedAt(lon, lat) {
    const w = toWorld(lon, lat);
    const r = CAR.radius;
    for (const chunk of state.chunks.values()) {
      const footprints = chunk.footprints;
      if (!footprints || !footprints.length) continue;
      for (let i = 0; i < footprints.length; i++) {
        const fp = footprints[i];
        if (
          w.x < fp.minX - r ||
          w.x > fp.maxX + r ||
          w.z < fp.minZ - r ||
          w.z > fp.maxZ + r
        )
          continue;
        if (pointInRing(fp.ring, w.x, w.z) || distToRing(fp.ring, w.x, w.z) < r) return true;
      }
    }
    return false;
  }

  function inWater(lon, lat) {
    const w = toWorld(lon, lat);
    const g = terrainY(w.x, w.z);
    for (const chunk of state.chunks.values()) {
      const rings = chunk.water;
      if (!rings || !rings.length) continue;
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i];
        if (w.x < r.minX || w.x > r.maxX || w.z < r.minZ || w.z > r.maxZ) continue;
        // Only wet where the ground sits at/below this body's flat water sheet;
        // above it the draped land has covered the water.
        if (g <= (r.level || 0) + WATER_Y + 0.5 && pointInRing(r.ring, w.x, w.z)) return true;
      }
    }
    return false;
  }

  function disposeGroup(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry) child.geometry.dispose();
    }
  }

  // ----- ground -----
  const GROUND_COLORS = {
    water: new THREE.Color(0x9dc3e6),
    park: new THREE.Color(0xc3e6a8),
    natureReserve: new THREE.Color(0xaed694),
    nationalPark: new THREE.Color(0x9fd08a),
    grass: new THREE.Color(0xcdebb0),
    meadow: new THREE.Color(0xd9ecb8),
    villageGreen: new THREE.Color(0xbfe0a0),
    garden: new THREE.Color(0xb7dd98),
    recreation: new THREE.Color(0xc8e6a4),
    wood: new THREE.Color(0x9cc79a),
    farm: new THREE.Color(0xeef0d5),
    orchard: new THREE.Color(0xd8e6b0),
    vineyard: new THREE.Color(0xd0dca0),
    sand: new THREE.Color(0xf0e8c8),
    rock: new THREE.Color(0xdcdcd2),
    wetland: new THREE.Color(0xb9d8c8),
    pitch: new THREE.Color(0x8fc46b),
    playground: new THREE.Color(0xf0d2a0),
    track: new THREE.Color(0xd79a6a),
    themePark: new THREE.Color(0xf3c6a2),
    cemetery: new THREE.Color(0xaec6a2),
    military: new THREE.Color(0xc2c8ac),
    flowerbed: new THREE.Color(0xe6b8c8),
    residential: new THREE.Color(0xe4e2dd),
    commercial: new THREE.Color(0xe8dcd4),
    institution: new THREE.Color(0xeceae2),
    roadMajor: new THREE.Color(0x8f969e),
    road: new THREE.Color(0x9aa1a9),
    roadMinor: new THREE.Color(0xacb2b9),
    path: new THREE.Color(0xc4c4c4),
    rail: new THREE.Color(0x8a8a8a),
  };

  function groundAreaColor(layerName, p) {
    const cls = p.class;
    const sub = p.subclass;
    if (layerName === "water") return GROUND_COLORS.water;
    if (layerName === "park") {
      if (cls === "nature_reserve") return GROUND_COLORS.natureReserve;
      if (cls === "national_park") return GROUND_COLORS.nationalPark;
      if (cls === "marine") return GROUND_COLORS.water;
      return GROUND_COLORS.park;
    }
    if (layerName === "landcover") {
      if (sub === "wood" || cls === "wood" || sub === "forest") return GROUND_COLORS.wood;
      if (sub === "garden") return GROUND_COLORS.garden;
      if (sub === "park") return GROUND_COLORS.park;
      if (sub === "recreation_ground") return GROUND_COLORS.recreation;
      if (sub === "flowerbed") return GROUND_COLORS.flowerbed;
      if (sub === "grass" || cls === "grass") return GROUND_COLORS.grass;
      if (cls === "farmland" || cls === "farm" || sub === "farmland") return GROUND_COLORS.farm;
      if (cls === "sand" || sub === "sand" || sub === "beach") return GROUND_COLORS.sand;
      if (cls === "rock" || sub === "rock" || sub === "bare_rock") return GROUND_COLORS.rock;
      if (cls === "wetland" || sub === "wetland") return GROUND_COLORS.wetland;
      return GROUND_COLORS.grass;
    }
    if (layerName === "landuse") {
      if (cls === "pitch") return GROUND_COLORS.pitch;
      if (cls === "playground") return GROUND_COLORS.playground;
      if (cls === "track") return GROUND_COLORS.track;
      if (cls === "theme_park") return GROUND_COLORS.themePark;
      if (cls === "garden") return GROUND_COLORS.garden;
      if (cls === "park") return GROUND_COLORS.park;
      if (cls === "recreation_ground") return GROUND_COLORS.recreation;
      if (cls === "cemetery" || cls === "grave_yard") return GROUND_COLORS.cemetery;
      if (cls === "military") return GROUND_COLORS.military;
      if (cls === "grass") return GROUND_COLORS.grass;
      if (cls === "meadow") return GROUND_COLORS.meadow;
      if (cls === "village_green") return GROUND_COLORS.villageGreen;
      if (cls === "orchard") return GROUND_COLORS.orchard;
      if (cls === "vineyard") return GROUND_COLORS.vineyard;
      if (cls === "residential" || cls === "suburb" || cls === "neighbourhood" || cls === "quarter")
        return GROUND_COLORS.residential;
      if (
        cls === "commercial" ||
        cls === "retail" ||
        cls === "industrial" ||
        cls === "construction" ||
        cls === "railway" ||
        cls === "garages"
      )
        return GROUND_COLORS.commercial;
      if (
        cls === "hospital" ||
        cls === "school" ||
        cls === "college" ||
        cls === "university" ||
        cls === "kindergarten"
      )
        return GROUND_COLORS.institution;
      if (cls === "sand") return GROUND_COLORS.sand;
      if (cls === "farmland" || cls === "farm") return GROUND_COLORS.farm;
      return null;
    }
    return null;
  }

  function roadStyle(p) {
    const cls = p.class;
    const sub = p.subclass;
    if (cls === "rail" || cls === "transit") return { width: 3, color: GROUND_COLORS.rail };
    if (cls === "motorway" || cls === "trunk") return { width: 16, color: GROUND_COLORS.roadMajor };
    if (cls === "primary") return { width: 12, color: GROUND_COLORS.roadMajor };
    if (cls === "secondary") return { width: 10, color: GROUND_COLORS.road };
    if (cls === "tertiary") return { width: 8, color: GROUND_COLORS.road };
    if (cls === "minor") return { width: 6, color: GROUND_COLORS.roadMinor };
    if (cls === "service") return { width: 4, color: GROUND_COLORS.roadMinor };
    if (cls === "track") return { width: 3, color: GROUND_COLORS.path };
    if (sub === "pedestrian") return { width: 4, color: GROUND_COLORS.path };
    if (sub === "footway" || sub === "path" || sub === "steps" || sub === "cycleway")
      return { width: 2, color: GROUND_COLORS.path };
    return { width: 5, color: GROUND_COLORS.roadMinor };
  }

  function ringToVec2(ring) {
    const out = [];
    for (const [lon, lat] of ring) {
      const w = toWorld(lon, lat);
      const last = out[out.length - 1];
      if (!last || Math.abs(last.x - w.x) > 1e-6 || Math.abs(last.y - w.z) > 1e-6) {
        out.push(new THREE.Vector2(w.x, w.z));
      }
    }
    if (out.length > 1) {
      const first = out[0];
      const last = out[out.length - 1];
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) out.pop();
    }
    return out;
  }

  // A flat polygon only gets raised at its (sparse) boundary vertices, so its
  // interior chord sinks below (convex) or pokes through (concave) the terrain.
  // Subdivide each triangle and sample the DEM so the layer drapes over hills.
  function drapeTriangle(a, b, c, y, color, positions, colors) {
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const n = clamp(Math.ceil(Math.max(ab, bc, ca) / DRAPE_STEP), 1, DRAPE_MAXN);
    const emit = (p) => {
      positions.push(p[0], p[1], p[2]);
      colors.push(color.r, color.g, color.b);
    };
    if (n === 1) {
      emit([a.x, y + terrainY(a.x, a.y), a.y]);
      emit([b.x, y + terrainY(b.x, b.y), b.y]);
      emit([c.x, y + terrainY(c.x, c.y), c.y]);
      return;
    }
    const grid = new Map();
    const P = (i, j) => {
      const key = i * (DRAPE_MAXN + 1) + j;
      let v = grid.get(key);
      if (!v) {
        const x = a.x + (i / n) * (b.x - a.x) + (j / n) * (c.x - a.x);
        const z = a.y + (i / n) * (b.y - a.y) + (j / n) * (c.y - a.y);
        v = [x, y + terrainY(x, z), z];
        grid.set(key, v);
      }
      return v;
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        emit(P(i, j));
        emit(P(i + 1, j));
        emit(P(i, j + 1));
        if (j < n - i - 1) {
          emit(P(i + 1, j));
          emit(P(i + 1, j + 1));
          emit(P(i, j + 1));
        }
      }
    }
  }

  function pushPolygon(geometry, color, y, positions, colors, flat) {
    if (!geometry) return;
    const polys =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : null;
    if (!polys) return;

    for (const poly of polys) {
      const contour = ringToVec2(poly[0]);
      if (contour.length < 3) continue;
      const holes = [];
      for (let h = 1; h < poly.length; h++) {
        const hole = ringToVec2(poly[h]);
        if (hole.length >= 3) holes.push(hole);
      }

      let triangles;
      try {
        triangles = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }

      const verts = contour.concat(...holes);
      for (const tri of triangles) {
        if (flat) {
          for (const idx of tri) {
            const v = verts[idx];
            if (!v) continue;
            positions.push(v.x, y, v.y);
            colors.push(color.r, color.g, color.b);
          }
          continue;
        }
        const a = verts[tri[0]];
        const b = verts[tri[1]];
        const c = verts[tri[2]];
        if (!a || !b || !c) continue;
        drapeTriangle(a, b, c, y, color, positions, colors);
      }
    }
  }

  function pushRibbon(line, width, y, color, positions, colors, flat) {
    const half = width / 2;
    for (let i = 0; i < line.length - 1; i++) {
      const A = toWorld(line[i][0], line[i][1]);
      const B = toWorld(line[i + 1][0], line[i + 1][1]);
      const dx = B.x - A.x;
      const dz = B.z - A.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = (-dz / len) * half;
      const nz = (dx / len) * half;
      const steps = clamp(Math.ceil(len / DRAPE_STEP), 1, 256);
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        const ax = A.x + dx * t0 + nx;
        const az = A.z + dz * t0 + nz;
        const bx = A.x + dx * t0 - nx;
        const bz = A.z + dz * t0 - nz;
        const cx = A.x + dx * t1 - nx;
        const cz = A.z + dz * t1 - nz;
        const dxe = A.x + dx * t1 + nx;
        const dze = A.z + dz * t1 + nz;
        positions.push(
          ax, flat ? y : y + terrainY(ax, az), az,
          bx, flat ? y : y + terrainY(bx, bz), bz,
          cx, flat ? y : y + terrainY(cx, cz), cz,
          ax, flat ? y : y + terrainY(ax, az), az,
          cx, flat ? y : y + terrainY(cx, cz), cz,
          dxe, flat ? y : y + terrainY(dxe, dze), dze
        );
        for (let m = 0; m < 6; m++) colors.push(color.r, color.g, color.b);
      }
    }
  }

  function lineCoords(feature, x, y, z) {
    let geo;
    try {
      geo = feature.toGeoJSON(x, y, z);
    } catch {
      return [];
    }
    if (geo.geometry.type === "LineString") return [geo.geometry.coordinates];
    if (geo.geometry.type === "MultiLineString") return geo.geometry.coordinates;
    return [];
  }

  function geoBBoxArea(geo) {
    const geometry = geo.geometry;
    if (!geometry) return 0;
    const polys =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : null;
    if (!polys) return 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const poly of polys) {
      for (const [lon, latPt] of poly[0]) {
        const w = toWorld(lon, latPt);
        if (w.x < minX) minX = w.x;
        if (w.x > maxX) maxX = w.x;
        if (w.z < minZ) minZ = w.z;
        if (w.z > maxZ) maxZ = w.z;
      }
    }
    return (maxX - minX) * (maxZ - minZ);
  }

  // A water body is a flat sheet at the mean terrain height of its shoreline.
  // The DEM already stores the water surface as its flat level, so this keeps
  // lakes/rivers visible instead of hiding them under the draped land.
  function waterLevel(geo) {
    const geometry = geo.geometry;
    if (!geometry) return 0;
    const polys =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    let sum = 0;
    let n = 0;
    for (const poly of polys) {
      for (const [lon, latPt] of poly[0]) {
        const w = toWorld(lon, latPt);
        sum += terrainY(w.x, w.z);
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  function collectWaterRings(geo, waters, level) {
    const geometry = geo.geometry;
    if (!geometry) return;
    const polys =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    for (const poly of polys) {
      const ring = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [lon, latPt] of poly[0]) {
        const w = toWorld(lon, latPt);
        ring.push({ x: w.x, z: w.z });
        if (w.x < minX) minX = w.x;
        if (w.x > maxX) maxX = w.x;
        if (w.z < minZ) minZ = w.z;
        if (w.z > maxZ) maxZ = w.z;
      }
      if (ring.length >= 3) waters.push({ minX, maxX, minZ, maxZ, ring, level });
    }
  }

  function addGroundAreas(vt, x, y, z, positions, colors, waters) {
    for (const name of ["water", "landcover", "landuse", "park"]) {
      const layer = vt.layers[name];
      if (!layer) continue;

      const items = [];
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const c = groundAreaColor(name, feature.properties);
        if (!c) continue;
        let geo;
        try {
          geo = feature.toGeoJSON(x, y, z);
        } catch {
          continue;
        }
        const level = name === "water" ? waterLevel(geo) : 0;
        items.push({ color: c, geo, area: geoBBoxArea(geo), level });
        if (name === "water" && waters) collectWaterRings(geo, waters, level);
      }

      // Larger areas lower, smaller details (fields, paths) on top, so no two
      // polygons in the same layer are coplanar (which causes z-fighting).
      items.sort((a, b) => b.area - a.area);
      const base = AREA_LAYER_BASE[name];
      const band = AREA_LAYER_BAND[name];
      const step = Math.min(0.0005, band / (items.length + 1));
      for (let i = 0; i < items.length; i++) {
        // Water is always a flat sheet at sea level, never draped on the terrain.
        const isWater = name === "water";
        const h = isWater ? WATER_Y + items[i].level + i * step : base + i * step;
        pushPolygon(items[i].geo.geometry, items[i].color, h, positions, colors, isWater);
      }
    }
  }

  function addGroundRoads(vt, x, y, z, positions, colors) {
    const roads = vt.layers["transportation"];
    if (roads) {
      for (let i = 0; i < roads.length; i++) {
        const feature = roads.feature(i);
        const p = feature.properties;
        if (p.brunnel === "tunnel" || (typeof p.layer === "number" && p.layer < 0)) continue;
        const style = roadStyle(p);
        for (const line of lineCoords(feature, x, y, z)) {
          pushRibbon(line, style.width, ROAD_Y, style.color, positions, colors);
        }
      }
    }

    const waterways = vt.layers["waterway"];
    if (waterways) {
      for (let i = 0; i < waterways.length; i++) {
        const feature = waterways.feature(i);
        if (feature.properties.brunnel === "tunnel") continue;
        const width = feature.properties.class === "river" ? 28 : 4;
        for (const line of lineCoords(feature, x, y, z)) {
          let sum = 0;
          let n = 0;
          for (const [lon, latPt] of line) {
            const w = toWorld(lon, latPt);
            sum += terrainY(w.x, w.z);
            n++;
          }
          const level = n ? sum / n : 0;
          pushRibbon(line, width, WATER_Y + level, GROUND_COLORS.water, positions, colors, true);
        }
      }
    }
  }

  function buildFlatMesh(positions, colors, group) {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, flatMaterial));
  }

  function addBaseQuad(group, x, y, z) {
    const nw = toWorld(tileXToLon(x, z), tileYToLat(y, z));
    const se = toWorld(tileXToLon(x + 1, z), tileYToLat(y + 1, z));
    const n = TERRAIN_ON ? BASE_GRID : 1;
    const positions = [];
    const indices = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const wx = nw.x + (se.x - nw.x) * (i / n);
        const wz = nw.z + (se.z - nw.z) * (j / n);
        positions.push(wx, terrainY(wx, wz) - BASE_SINK, wz);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, baseMaterial));
  }

  async function loadChunk(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const chunk = state.chunks.get(key);
    if (!chunk || chunk.loading || chunk.group) return;
    chunk.loading = true;

    let template;
    try {
      template = await getTileTemplate();
    } catch {
      chunk.loading = false;
      return;
    }
    const [buffer] = await Promise.all([fetchTileBuffer(template, z, x, y), loadDem(z, x, y)]);
    if (state.chunks.get(key) !== chunk) return;

    const group = new THREE.Group();
    let footprints = [];
    let waters = [];
    if (buffer && buffer.length) {
      let vt = null;
      try {
        vt = new VectorTile(new Pbf(buffer));
      } catch {
        vt = null;
      }
      if (vt) {
        const areaPositions = [];
        const areaColors = [];
        const roadPositions = [];
        const roadColors = [];
        addGroundAreas(vt, x, y, z, areaPositions, areaColors, waters);
        addGroundRoads(vt, x, y, z, roadPositions, roadColors);
        addBaseQuad(group, x, y, z);
        buildFlatMesh(areaPositions, areaColors, group);
        buildFlatMesh(roadPositions, roadColors, group);
        footprints = addBuildingsFromTile(vt, x, y, z, group);
      }
    }

    if (state.chunks.get(key) !== chunk) {
      disposeGroup(group);
      return;
    }
    chunk.loading = false;
    chunk.group = group;
    chunk.footprints = footprints;
    chunk.water = waters;
    chunkGroup.add(group);
  }

  function unloadChunk(key, chunk) {
    if (chunk.group) {
      chunkGroup.remove(chunk.group);
      disposeGroup(chunk.group);
      chunk.group = null;
    }
    state.chunks.delete(key);
  }

  function updateChunks(cx, cy) {
    if (state.chunkCenter && state.chunkCenter[0] === cx && state.chunkCenter[1] === cy) return;
    state.chunkCenter = [cx, cy];

    const z = VECTOR_Z;
    const wanted = new Set();
    const pending = [];
    for (let j = -CHUNK_RADIUS; j <= CHUNK_RADIUS; j++) {
      for (let i = -CHUNK_RADIUS; i <= CHUNK_RADIUS; i++) {
        const x = cx + i;
        const y = cy + j;
        const key = `${z}/${x}/${y}`;
        wanted.add(key);
        if (!state.chunks.has(key)) {
          state.chunks.set(key, { loading: false, group: null });
          pending.push({ x, y, distance: i * i + j * j });
        }
      }
    }

    for (const [key, chunk] of [...state.chunks]) {
      if (!wanted.has(key)) unloadChunk(key, chunk);
    }

    pending.sort((a, b) => a.distance - b.distance);
    for (const item of pending) loadChunk(z, item.x, item.y);
  }

  function clearChunks() {
    for (const [key, chunk] of [...state.chunks]) unloadChunk(key, chunk);
    state.chunks.clear();
    state.chunkCenter = null;
    state.blocked = false;
  }

  // ----- buildings -----
  const color = new THREE.Color();
  function colorFor(height) {
    const lightness = 0.62 + Math.min(0.22, height / 260);
    color.setHSL(0.09, 0.1, lightness);
    return color;
  }

  function addBuilding(feature, x, y, z, out, footprints) {
    const props = feature.properties;
    const height = Math.max(3, Number(props.render_height) || 0);
    const minHeight = Number(props.render_min_height) || 0;
    const geo = feature.toGeoJSON(x, y, z);
    const polygons =
      geo.geometry.type === "Polygon" ? [geo.geometry.coordinates] : geo.geometry.coordinates;

    for (const polygon of polygons) {
      if (footprints) {
        const ring = [];
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const [lon, latPt] of polygon[0]) {
          const w = toWorld(lon, latPt);
          ring.push({ x: w.x, z: w.z });
          if (w.x < minX) minX = w.x;
          if (w.x > maxX) maxX = w.x;
          if (w.z < minZ) minZ = w.z;
          if (w.z > maxZ) maxZ = w.z;
        }
        if (ring.length >= 3) footprints.push({ minX, maxX, minZ, maxZ, ring });
      }

      const shape = new THREE.Shape();
      polygon[0].forEach(([lon, latPt], i) => {
        const w = toWorld(lon, latPt);
        if (i === 0) shape.moveTo(w.x, -w.z);
        else shape.lineTo(w.x, -w.z);
      });
      for (let h = 1; h < polygon.length; h++) {
        const hole = new THREE.Path();
        polygon[h].forEach(([lon, latPt], i) => {
          const w = toWorld(lon, latPt);
          if (i === 0) hole.moveTo(w.x, -w.z);
          else hole.lineTo(w.x, -w.z);
        });
        shape.holes.push(hole);
      }

      let geometry;
      try {
        geometry = new THREE.ExtrudeGeometry(shape, {
          depth: height + FOUNDATION,
          bevelEnabled: false,
        });
      } catch {
        continue;
      }
      if (!geometry.attributes.position || geometry.attributes.position.count === 0) continue;

      // Sit the building on the lowest ground under its footprint (so it never
      // floats), and extrude a foundation skirt to bury any slope gaps.
      const worldRing = polygon[0].map(([lon, latPt]) => toWorld(lon, latPt));
      let baseY = Infinity;
      let sx = 0;
      let sz = 0;
      for (let vi = 0; vi < worldRing.length; vi++) {
        const w = worldRing[vi];
        const n = worldRing[(vi + 1) % worldRing.length];
        sx += w.x;
        sz += w.z;
        baseY = Math.min(baseY, terrainY(w.x, w.z));
        baseY = Math.min(baseY, terrainY((w.x + n.x) / 2, (w.z + n.z) / 2));
      }
      baseY = Math.min(baseY, terrainY(sx / worldRing.length, sz / worldRing.length));
      if (!Number.isFinite(baseY)) baseY = 0;

      geometry.clearGroups();
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, minHeight + baseY - FOUNDATION, 0);

      const c = colorFor(height);
      const count = geometry.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      out.push(geometry);
    }
  }

  function addBuildingsFromTile(vt, x, y, z, group) {
    const layer = vt.layers["building"];
    const footprints = [];
    if (!layer) return footprints;

    const geometries = [];
    for (let i = 0; i < layer.length; i++) {
      try {
        addBuilding(layer.feature(i), x, y, z, geometries, footprints);
      } catch {
        /* skip malformed feature */
      }
    }
    if (!geometries.length) return footprints;

    const merged = mergeGeometries(geometries);
    if (merged) {
      merged.computeBoundingSphere();
      group.add(new THREE.Mesh(merged, buildingMaterial));
    }
    return footprints;
  }

  // ----- route ribbon -----
  function addStripe(group, line, colorA, colorB) {
    const P = line.P;
    const d = line.dir;
    const px = -d.z;
    const pz = d.x;
    const rows = 2;
    const cw = (LINE_HALF * 2) / LINE_COLS;
    const cd = LINE_DEPTH / rows;
    const positions = [];
    const colors = [];
    const ca = new THREE.Color(colorA);
    const cb = new THREE.Color(colorB);
    const pt = (u, v) => ({ x: P.x + px * u + d.x * v, z: P.z + pz * u + d.z * v });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < LINE_COLS; c++) {
        const u0 = -LINE_HALF + c * cw;
        const u1 = u0 + cw;
        const v0 = -LINE_DEPTH / 2 + r * cd;
        const v1 = v0 + cd;
        const a = pt(u0, v0);
        const b = pt(u1, v0);
        const cc = pt(u1, v1);
        const e = pt(u0, v1);
        positions.push(
          a.x, LINE_Y + terrainY(a.x, a.z), a.z,
          b.x, LINE_Y + terrainY(b.x, b.z), b.z,
          cc.x, LINE_Y + terrainY(cc.x, cc.z), cc.z,
          a.x, LINE_Y + terrainY(a.x, a.z), a.z,
          cc.x, LINE_Y + terrainY(cc.x, cc.z), cc.z,
          e.x, LINE_Y + terrainY(e.x, e.z), e.z
        );
        const col = (r + c) % 2 === 0 ? ca : cb;
        for (let k = 0; k < 6; k++) colors.push(col.r, col.g, col.b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    group.add(new THREE.Mesh(geometry, flatMaterial));
  }

  function buildRoute() {
    const base = state.track.map(([lon, lat]) => toWorld(lon, lat));
    const path = [];
    for (let i = 0; i < base.length; i++) {
      path.push(base[i]);
      const nxt = base[i + 1];
      if (!nxt) break;
      const dx = nxt.x - base[i].x;
      const dz = nxt.z - base[i].z;
      const len = Math.hypot(dx, dz);
      const steps = clamp(Math.ceil(len / DRAPE_STEP), 1, 256);
      for (let k = 1; k < steps; k++) {
        path.push({ x: base[i].x + (dx * k) / steps, z: base[i].z + (dz * k) / steps });
      }
    }
    const positions = [];
    const indices = [];
    const half = ROAD_WIDTH / 2;

    for (let i = 0; i < path.length; i++) {
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      const lx = path[i].x + nx * half;
      const lz = path[i].z + nz * half;
      const rx = path[i].x - nx * half;
      const rz = path[i].z - nz * half;
      positions.push(lx, ROUTE_Y + terrainY(lx, lz), lz);
      positions.push(rx, ROUTE_Y + terrainY(rx, rz), rz);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    disposeGroup(routeGroup);
    routeGroup.add(new THREE.Mesh(geometry, routeMaterial));

    disposeGroup(markerGroup);
    if (state.startLine) addStripe(markerGroup, state.startLine, 0xffffff, 0x16a34a);
    if (state.finishLine) addStripe(markerGroup, state.finishLine, 0xffffff, 0x111111);
  }

  // The DEM streams in per tile, but the route is built the instant the screen
  // opens (before any tile has loaded), so terrainY reads 0 and the ribbon would
  // sit at sea level under the real ground. Rebuild it once every tile it crosses
  // has elevation.
  function drapeRoute() {
    const track = state.track;
    if (!TERRAIN_ON || !track || track.length < 2) return;
    const seen = new Set();
    const jobs = [];
    const want = (lon, lat) => {
      const z = TERRAIN_Z;
      const x = Math.floor(lonToTileX(lon, z));
      const y = Math.floor(latToTileY(lat, z));
      const key = `${z}/${x}/${y}`;
      if (seen.has(key)) return;
      seen.add(key);
      jobs.push(loadDem(z, x, y));
    };
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i];
      const b = track[i + 1];
      const n = Math.max(1, Math.ceil(haversine(a, b) / 800));
      for (let k = 0; k <= n; k++) {
        want(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      }
    }
    Promise.all(jobs).then(() => {
      if (state.track === track) buildRoute();
    });
  }

  // ----- simulation -----
  function resetCar() {
    const track = state.track;
    const o = state.origin;
    const line = state.startLine;
    let lon = track[0][0];
    let lat = track[0][1];
    if (line) {
      lon -= (line.dir.x * START_BACK) / (M_PER_DEG_LAT * o.cosLat);
      lat += (line.dir.z * START_BACK) / M_PER_DEG_LAT;
    }
    state.car.lon = lon;
    state.car.lat = lat;
    state.car.heading = track.length > 1 ? bearing(track[0], track[1]) : 0;
    state.car.speed = 0;
    state.progress = 0;
    state.done = false;
    state.started = false;
    state.offRoad = false;
    state.startedAt = null;
    state.blocked = false;
    state.waterUntil = 0;
    el.end.classList.add("hidden");
    for (const key of Object.keys(state.input)) state.input[key] = false;
  }

  // True when the movement from -> to crosses the race line (forward only,
  // within the line's width).
  function crossLine(from, to, line) {
    const P = line.P;
    const d = line.dir;
    const sp = (from.x - P.x) * d.x + (from.z - P.z) * d.z;
    const sc = (to.x - P.x) * d.x + (to.z - P.z) * d.z;
    if (!(sp < 0 && sc >= 0)) return false;
    const t = sp === sc ? 0 : sp / (sp - sc);
    const cx = from.x + (to.x - from.x) * t;
    const cz = from.z + (to.z - from.z) * t;
    const lat = Math.abs((cx - P.x) * -d.z + (cz - P.z) * d.x);
    return lat <= LINE_HALF;
  }

  function update(dt) {
    const car = state.car;
    const input = state.input;

    if (input.accel) car.speed += CAR.accel * dt;
    else if (input.brake) car.speed -= CAR.brake * dt;
    else {
      const d = CAR.coast * dt;
      car.speed = Math.abs(car.speed) <= d ? 0 : car.speed - Math.sign(car.speed) * d;
    }
    if (state.done) car.speed = Math.max(0, car.speed);
    car.speed = clamp(car.speed, CAR.maxReverse, CAR.maxForward);

    const prevLon = car.lon;
    const prevLat = car.lat;

    const steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const absSpeed = Math.abs(car.speed);
    if (steer && absSpeed > 0.4) {
      const factor = Math.min(1, absSpeed / 8) * (1 - Math.min(0.4, absSpeed / 130));
      car.heading =
        (car.heading + steer * CAR.steer * factor * dt * Math.sign(car.speed) + 360) % 360;
    }

    state.offRoad = nearest(car.lon, car.lat).dist > CAR.roadWidth;
    if (state.offRoad) {
      const d = CAR.offRoad * dt;
      car.speed = Math.abs(car.speed) <= d ? 0 : car.speed - Math.sign(car.speed) * d;
    }

    const h = (car.heading * Math.PI) / 180;
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    const step = car.speed * dt;

    if (state.blocked && blockedAt(car.lon, car.lat)) {
      // Already overlapping (spawn or newly streamed-in geometry): let the
      // body move so it can slide out instead of being frozen in place.
      car.lat += (cosH * step) / M_PER_DEG_LAT;
      car.lon += (sinH * step) / (M_PER_DEG_LAT * Math.cos((car.lat * Math.PI) / 180));
      state.blocked = blockedAt(car.lon, car.lat);
    } else {
      // Sub-step so a fast car can't tunnel through a wall in one frame, and
      // stop the body (radius) against the wall to keep the camera out.
      const maxStep = Math.max(0.5, CAR.radius);
      let remaining = step;
      let hit = false;
      while (Math.abs(remaining) > 1e-4) {
        const s = clamp(remaining, -maxStep, maxStep);
        const nlat = car.lat + (cosH * s) / M_PER_DEG_LAT;
        const nlon = car.lon + (sinH * s) / (M_PER_DEG_LAT * Math.cos((nlat * Math.PI) / 180));
        if (blockedAt(nlon, nlat)) {
          hit = true;
          break;
        }
        car.lon = nlon;
        car.lat = nlat;
        remaining -= s;
      }
      if (hit) car.speed = 0;
      state.blocked = blockedAt(car.lon, car.lat);
    }

    let at = nearest(car.lon, car.lat);

    // Driving into water rings you out back onto the route.
    let teleported = false;
    if (at.dist > WATER_MARGIN && inWater(car.lon, car.lat)) {
      car.lon = at.lon;
      car.lat = at.lat;
      car.heading = at.heading;
      car.speed = 0;
      state.blocked = false;
      state.waterUntil = performance.now() + 1600;
      at = nearest(car.lon, car.lat);
      teleported = true;
    }

    state.progress = state.total ? clamp(at.along / state.total, 0, 1) : 0;

    // Race lines: cross the start line to begin, cross the finish line to win.
    if (!teleported && !state.done) {
      const from = toWorld(prevLon, prevLat);
      const to = toWorld(car.lon, car.lat);
      if (!state.started && state.startLine && crossLine(from, to, state.startLine)) {
        state.started = true;
        state.startedAt = performance.now();
      }
      if (state.finishLine && crossLine(from, to, state.finishLine)) {
        state.done = true;
        finishRoute();
      }
    }
  }

  function updateCamera() {
    const car = state.car;
    const w = toWorld(car.lon, car.lat);
    const h = (car.heading * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const gy = terrainY(w.x, w.z);
    camera.position.set(w.x, gy + EYE_HEIGHT, w.z);
    camera.lookAt(w.x + fx * 60, gy + EYE_HEIGHT - 3, w.z + fz * 60);
  }

  function updateHud() {
    el.speed.textContent = speedText(Math.abs(state.car.speed));
    el.speedUnit.textContent = speedUnit();
    el.progress.textContent = `${Math.round(state.progress * 100)}%`;
    el.progressFill.style.width = `${state.progress * 100}%`;
    el.warning.classList.toggle("hidden", !state.offRoad);
    el.water.classList.toggle("hidden", !(performance.now() < state.waterUntil));
  }

  function finishRoute() {
    const elapsed = state.startedAt ? performance.now() - state.startedAt : 0;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    el.endDistance.textContent = distanceText(state.total);
    el.endTime.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    el.end.classList.remove("hidden");
  }

  function loop(time) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (time - state.lastTime) / 1000 || 0);
    state.lastTime = time;

    if (screenEl.classList.contains("hidden") || !state.track) return;

    update(dt);
    updateCamera();
    updateHud();

    if (time > state.nextTileCheck) {
      state.nextTileCheck = time + 200;
      const z = VECTOR_Z;
      const cx = Math.floor(lonToTileX(state.car.lon, z));
      const cy = Math.floor(latToTileY(state.car.lat, z));
      updateChunks(cx, cy);
    }

    renderer.render(scene, camera);
  }

  function resize() {
    const w = screenEl.clientWidth || 1;
    const h = screenEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function loadTrack() {
    const path = game.track;
    state.track = path;
    state.cum = [0];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversine(path[i - 1], path[i]);
      state.cum.push(total);
    }
    state.total = total;
    state.origin = { lon: path[0][0], lat: path[0][1], cosLat: Math.cos((path[0][1] * Math.PI) / 180) };
    const dirAt = (a, b) => {
      const w0 = toWorld(a[0], a[1]);
      const w1 = toWorld(b[0], b[1]);
      const dx = w1.x - w0.x;
      const dz = w1.z - w0.z;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    };
    const pN = path[path.length - 1];
    const pM = path[path.length - 2] || pN;
    state.startLine = { P: toWorld(path[0][0], path[0][1]), dir: dirAt(path[0], path[1] || path[0]) };
    state.finishLine = { P: toWorld(pN[0], pN[1]), dir: dirAt(pM, pN) };
    clearChunks();
    state.nextTileCheck = 0;
    buildRoute();
    resetCar();
    drapeRoute();
  }

  function syncTrack() {
    const hasTrack = !!game.track && game.track.length >= 2;
    el.empty.classList.toggle("hidden", hasTrack);
    el.controls.classList.toggle("hidden", !hasTrack);
    if (!hasTrack) {
      state.track = null;
      return;
    }
    if (game.track !== state.loadedRef) {
      state.loadedRef = game.track;
      loadTrack();
    }
    resize();
  }

  // ----- controls -----
  function holdButton(id, key) {
    const button = document.getElementById(id);
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      state.input[key] = true;
      if (e.pointerId != null) {
        try {
          button.setPointerCapture(e.pointerId);
        } catch {}
      }
    });
    const release = (e) => {
      if (e) e.preventDefault();
      state.input[key] = false;
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
    button.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  holdButton("d3-left", "left");
  holdButton("d3-right", "right");
  holdButton("d3-accel", "accel");
  holdButton("d3-brake", "brake");

  const KEYS = {
    ArrowUp: "accel", w: "accel", W: "accel",
    ArrowDown: "brake", s: "brake", S: "brake",
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
  };

  window.addEventListener("keydown", (e) => {
    if (screenEl.classList.contains("hidden")) return;
    const key = KEYS[e.key];
    if (key) {
      state.input[key] = true;
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (screenEl.classList.contains("hidden")) return;
    const key = KEYS[e.key];
    if (key) {
      state.input[key] = false;
      e.preventDefault();
    }
  });

  document.getElementById("d3-restart").addEventListener("click", () => {
    if (state.track) resetCar();
  });
  document.getElementById("d3-again").addEventListener("click", () => {
    if (state.track) resetCar();
  });

  onUnitsChange(() => {
    updateHud();
    if (state.done) el.endDistance.textContent = distanceText(state.total);
  });

  window.addEventListener("resize", resize);

  syncTrack();
  requestAnimationFrame(loop);

  return {
    resize() {
      resize();
      syncTrack();
    },
  };
}

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const rad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
}

window.registerScreen("drive3d", { enter: initDrive3D });
})();
