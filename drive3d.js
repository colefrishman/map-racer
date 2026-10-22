(function () {
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";

const VECTOR_Z = 14;
const CHUNK_RADIUS = 1;
// Streaming budget: fetch a few tiles at a time and build at most one chunk per
// frame so a burst of resolving tiles can't stall the UI thread.
const CONCURRENT_LOADS = 6;
const UNLOAD_GRACE = 1200;
const M_PER_DEG_LAT = 111320;
const EYE_HEIGHT = 1.7;
const ROAD_WIDTH = 9;

const TERRAIN_ON = true;
const TERRAIN_Z = 14;
const BASE_GRID = 220;
const DRAPE_STEP = 12;
const DRAPE_MAXN = 40;
const FOUNDATION = 6;

// Everything on the ground is drawn as painter's-order passes matching the
// OpenFreeMap "liberty" style (bottom to top): park, built-up landuse,
// landcover, landuse details, water, sand, then roads. None of them write
// depth, so a later pass cleanly paints over an earlier one no matter how the
// layers overlap in height (that ordering is what keeps a bridge over its
// river). They only need to clear the depth-writing base terrain, hence the
// small shared lift; height is otherwise cosmetic.
const WATER_Y = 0.3;
const AREA_BASE = 0.3;
const AREA_BAND_COUNT = 6;
const RENDER_ORDER = {
  areas: 10,
  buildings: 20,
  roads: 30,
  route: 40,
  markers: 50,
  car: 60,
};
const ROAD_Y = 0.3;
const ROUTE_Y = 0.5;
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

const CHASE_DIST = 7;
const CHASE_HEIGHT = 3;
// Buildings come from z14 vector tiles, where footprints are generalised and
// can swallow narrow alleys, station roofs, and tunnel mouths that OSRM still
// routes along. The route wins: anything this close to its centreline is
// drivable even if a footprint says otherwise.
const ROUTE_CLEAR = 6;
// Seconds for the chase camera's yaw to catch up to the car. A little lag lets
// the body swing into view through a turn instead of the camera locking to it.
const CAM_LAG = 0.28;

const WATER_MARGIN = 6;
const LINE_HALF = 10;
const LINE_DEPTH = 4;
const LINE_COLS = 10;
const LINE_Y = 0.6;
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
    window.__tileFetches = window.__tileFetches || [];
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

// Draping samples this tens of thousands of times per chunk, so cache the last
// tile lookup to avoid building a Map key string on every vertex.
let demCacheX = -1;
let demCacheY = -1;
let demCache = null;
let demCacheValid = false;

function sampleDem(lon, lat) {
  const z = TERRAIN_Z;
  const tx = lonToTileX(lon, z);
  const ty = latToTileY(lat, z);
  const xi = Math.floor(tx);
  const yi = Math.floor(ty);
  // Re-look-up while the tile is still null: an early sample (before the DEM
  // arrived) must not pin the whole tile to height 0 for the rest of the run.
  if (!demCacheValid || !demCache || xi !== demCacheX || yi !== demCacheY) {
    demCache = demTiles.get(`${z}/${xi}/${yi}`) || null;
    demCacheX = xi;
    demCacheY = yi;
    demCacheValid = true;
  }
  if (!demCache) return 0;
  return demValue(demCache, (tx - xi) * demCache.w - 0.5, (ty - yi) * demCache.h - 0.5);
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
    arrow: document.getElementById("d3-arrow"),
    pause: document.getElementById("d3-pause"),
    pauseMenu: document.getElementById("d3-pause-menu"),
    empty: document.getElementById("d3-empty"),
    end: document.getElementById("d3-end"),
    endDistance: document.getElementById("d3-end-distance"),
    endTime: document.getElementById("d3-end-time"),
    loading: document.getElementById("d3-loading"),
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

  // Low-poly car, shown only in third-person view. Built facing -Z, matching
  // the heading convention (rotation.y = -heading). Body/color come from the
  // shared garage settings.
  const carGroup = new THREE.Group();
  carGroup.visible = false;
  scene.add(carGroup);

  let carLength = 4.5;
  let carWheels = [];
  function refreshCar() {
    carGroup.traverse((o) => {
      if (!o.isMesh) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    while (carGroup.children.length) carGroup.remove(carGroup.children[0]);
    carGroup.add(...buildCarMesh(carSettings.style, carSettings.color).children);
    carWheels = [];
    carGroup.traverse((o) => {
      if (o.userData.wheel) carWheels.push(o);
      if (o.isMesh) o.renderOrder = RENDER_ORDER.car;
    });
    carGroup.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(carGroup).getSize(size);
    carLength = size.z || 4.5;
  }
  refreshCar();
  onCarChange(refreshCar);

  const baseMaterial = new THREE.MeshBasicMaterial({ color: 0xe6e4dc, side: THREE.DoubleSide });
  // Every ground layer (areas, water, roads, stripes) shares one non-depth-
  // writing material: they paint strictly in RENDER_ORDER, so a bridge always
  // draws over its river and a road never fights a park for the same pixels.
  const flatMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const areaMaterial = flatMaterial;
  const buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  // Buildings the route runs through (tunnels, station roofs, over-generalised
  // z14 blocks) go translucent instead of hiding the road inside them.
  const ghostMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  const routeMaterial = new THREE.MeshBasicMaterial({ color: 0x2563eb, side: THREE.DoubleSide });

  const state = {
    track: null,
    loadedRef: null,
    origin: null,
    cum: [],
    total: 0,
    car: { lon: 0, lat: 0, heading: 0, speed: 0 },
    input: { left: false, right: false, accel: false, brake: false },
    axis: { steer: 0, throttle: 0 },
    scheme: "buttons",
    offRoad: false,
    progress: 0,
    done: false,
    started: false,
    startedAt: null,
    startLine: null,
    finishLine: null,
    lastTime: 0,
    chunks: new Map(),
    wanted: new Set(),
    pendingLoads: [],
    buildQueue: [],
    inflight: 0,
    chunkCenter: null,
    nextTileCheck: 0,
    blocked: false,
    waterUntil: 0,
    ready: false,
    readySince: 0,
    free: false,
    spawn: null,
    freeRef: null,
    third: true,
    camHeading: null,
    paused: false,
    lastNav: 0,
    routeGrid: null,
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
    let blocked = false;
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
        if (pointInRing(fp.ring, w.x, w.z) || distToRing(fp.ring, w.x, w.z) < r) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
    }
    if (!blocked) return false;
    if (state.track && nearest(lon, lat).dist < ROUTE_CLEAR) return false;
    return true;
  }

  const ROUTE_GRID_CELL = 24;

  // Sample the track every few metres into a coarse grid so tile builds can ask
  // "does the route run through this footprint?" without re-walking the track.
  function buildRouteGrid(path) {
    const grid = new Map();
    const add = (lon, lat) => {
      const w = toWorld(lon, lat);
      const key = `${Math.floor(w.x / ROUTE_GRID_CELL)},${Math.floor(w.z / ROUTE_GRID_CELL)}`;
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(w);
    };
    for (let i = 0; i < path.length; i++) {
      add(path[i][0], path[i][1]);
      const b = path[i + 1];
      if (!b) continue;
      const w0 = toWorld(path[i][0], path[i][1]);
      const w1 = toWorld(b[0], b[1]);
      const steps = Math.floor(Math.hypot(w1.x - w0.x, w1.z - w0.z) / 8);
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1);
        add(path[i][0] + (b[0] - path[i][0]) * t, path[i][1] + (b[1] - path[i][1]) * t);
      }
    }
    return grid;
  }

  function routeIntersectsFootprint(fp) {
    const grid = state.routeGrid;
    if (!grid) return false;
    const x0 = Math.floor(fp.minX / ROUTE_GRID_CELL);
    const x1 = Math.floor(fp.maxX / ROUTE_GRID_CELL);
    const z0 = Math.floor(fp.minZ / ROUTE_GRID_CELL);
    const z1 = Math.floor(fp.maxZ / ROUTE_GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = grid.get(`${cx},${cz}`);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          if (pointInRing(fp.ring, cell[i].x, cell[i].z)) return true;
        }
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

  // Draw priority matching the liberty style's fill order (0 = bottom).
  function groundAreaRank(layerName, p) {
    const cls = p.class;
    const sub = p.subclass;
    if (layerName === "park") return 0;
    if (layerName === "water") return 4;
    if (layerName === "landcover") {
      if (cls === "sand" || sub === "sand" || sub === "beach") return 5;
      return 2;
    }
    if (layerName === "landuse") {
      if (
        cls === "pitch" ||
        cls === "track" ||
        cls === "playground" ||
        cls === "cemetery" ||
        cls === "grave_yard" ||
        cls === "hospital" ||
        cls === "school" ||
        cls === "college" ||
        cls === "university" ||
        cls === "kindergarten" ||
        cls === "theme_park" ||
        cls === "garden" ||
        cls === "park" ||
        cls === "recreation_ground" ||
        cls === "village_green" ||
        cls === "military" ||
        cls === "orchard" ||
        cls === "vineyard" ||
        cls === "grass" ||
        cls === "meadow"
      )
        return 3;
      return 1;
    }
    return 1;
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

  // A water body is a flat sheet at the terrain height of its interior. The DEM
  // already stores the water surface as its flat level, so this keeps
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
    // Sample one interior point (the average of the ring) rather than the ring
    // itself: a tile-clipped lake ring runs along the tile edge, where the DEM
    // neighbours are often not loaded yet and would drag the level toward 0.
    let sumX = 0;
    let sumZ = 0;
    let n = 0;
    for (const poly of polys) {
      for (const [lon, latPt] of poly[0]) {
        const w = toWorld(lon, latPt);
        sumX += w.x;
        sumZ += w.z;
        n++;
      }
    }
    return n ? terrainY(sumX / n, sumZ / n) : 0;
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

  function addGroundAreas(vt, x, y, z, bands, waters) {
    for (const name of ["water", "landcover", "landuse", "park"]) {
      const layer = vt.layers[name];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const color = groundAreaColor(name, feature.properties);
        if (!color) continue;
        let geo;
        try {
          geo = feature.toGeoJSON(x, y, z);
        } catch {
          continue;
        }
        const isWater = name === "water";
        const level = isWater ? waterLevel(geo) : 0;
        if (isWater && waters) collectWaterRings(geo, waters, level);
        const rank = groundAreaRank(name, feature.properties);
        // Water is a flat sheet at its real surface; land drapes on the terrain.
        const h = isWater ? WATER_Y + level : AREA_BASE;
        bands[rank].push({ geometry: geo.geometry, color, h, flat: isWater });
      }
    }
  }

  function buildAreaBands(bands, group) {
    for (let rank = 0; rank < bands.length; rank++) {
      const items = bands[rank];
      if (!items.length) continue;
      const positions = [];
      const colors = [];
      for (const item of items) {
        pushPolygon(item.geometry, item.color, item.h, positions, colors, item.flat);
      }
      buildFlatMesh(positions, colors, group, areaMaterial, RENDER_ORDER.areas + rank);
    }
  }

  function addGroundRoads(vt, x, y, z, positions, colors, waterPositions, waterColors) {
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
          // Rivers belong to the water pass, not the road pass: a bridge is a
          // road and must paint over its river instead of racing it on height.
          pushRibbon(
            line,
            width,
            WATER_Y + level,
            GROUND_COLORS.water,
            waterPositions,
            waterColors,
            true
          );
        }
      }
    }
  }

  function buildFlatMesh(positions, colors, group, material = flatMaterial, order = 0) {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = order;
    group.add(mesh);
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
    group.add(new THREE.Mesh(geometry, baseMaterial));
  }

  // The CPU-heavy half of a chunk (tile decode, triangulation, draping, building
  // extrude + merge). Split out so it can be drained by the per-frame scheduler.
  function buildChunkGeometry(chunk, x, y, buffer) {
    const z = VECTOR_Z;
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
        const bands = Array.from({ length: AREA_BAND_COUNT }, () => []);
        const roadPositions = [];
        const roadColors = [];
        const waterwayPositions = [];
        const waterwayColors = [];
        addGroundAreas(vt, x, y, z, bands, waters);
        addGroundRoads(vt, x, y, z, roadPositions, roadColors, waterwayPositions, waterwayColors);
        addBaseQuad(group, x, y, z);
        buildAreaBands(bands, group);
        buildFlatMesh(
          waterwayPositions,
          waterwayColors,
          group,
          areaMaterial,
          RENDER_ORDER.areas + 4
        );
        buildFlatMesh(roadPositions, roadColors, group, flatMaterial, RENDER_ORDER.roads);
        footprints = addBuildingsFromTile(vt, x, y, z, group);
      }
    }
    chunk.group = group;
    chunk.footprints = footprints;
    chunk.water = waters;
    chunkGroup.add(group);
  }

  // Fetch + DEM decode are async and never touch the scene; the decoded buffer
  // is handed to the build queue rather than built inline.
  async function startChunkLoad(z, x, y, chunk, key) {
    try {
      const template = await getTileTemplate();
      const [buffer] = await Promise.all([fetchTileBuffer(template, z, x, y), loadDem(z, x, y)]);
      if (state.chunks.get(key) === chunk) {
        chunk.buffer = buffer;
        state.buildQueue.push({ key, chunk, x, y, buffer });
      }
    } catch {
      /* leave the placeholder queued for a later tile-edge pass */
    } finally {
      chunk.loading = false;
      state.inflight--;
    }
  }

  function pumpLoads() {
    if (!state.pendingLoads.length) return;
    const [cx, cy] = state.chunkCenter || [0, 0];
    while (state.inflight < CONCURRENT_LOADS && state.pendingLoads.length) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < state.pendingLoads.length; i++) {
        const it = state.pendingLoads[i];
        const d = (it.x - cx) ** 2 + (it.y - cy) ** 2;
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      const item = state.pendingLoads.splice(bi, 1)[0];
      const key = `${VECTOR_Z}/${item.x}/${item.y}`;
      const chunk = state.chunks.get(key);
      if (!chunk || chunk.loading || chunk.group || chunk.buffer !== undefined) continue;
      chunk.loading = true;
      state.inflight++;
      startChunkLoad(VECTOR_Z, item.x, item.y, chunk, key);
    }
  }

  // Build at most one chunk per frame, nearest to the car first, so a burst of
  // tiles that resolve together spreads across frames instead of one long stall.
  function pumpBuild() {
    if (!state.buildQueue.length || screenEl.classList.contains("hidden")) return;
    const [cx, cy] = state.chunkCenter || [0, 0];
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < state.buildQueue.length; i++) {
      const it = state.buildQueue[i];
      if (state.chunks.get(it.key) !== it.chunk || !state.wanted.has(it.key)) {
        state.buildQueue.splice(i, 1);
        i--;
        continue;
      }
      const d = (it.x - cx) ** 2 + (it.y - cy) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bi < 0) return;
    const item = state.buildQueue.splice(bi, 1)[0];
    buildChunkGeometry(item.chunk, item.x, item.y, item.buffer);
    item.chunk.buffer = null;
  }

  function unloadChunk(key, chunk) {
    if (chunk.group) {
      chunkGroup.remove(chunk.group);
      disposeGroup(chunk.group);
      chunk.group = null;
    }
    chunk.buffer = null;
    state.chunks.delete(key);
  }

  // Keep unwanted chunks around briefly (and drop at most one per frame) so
  // driving back and forth across a tile edge doesn't thrash load/dispose.
  function sweepChunks(now) {
    let dropped = false;
    for (const [key, chunk] of [...state.chunks]) {
      if (state.wanted.has(key)) {
        chunk.dropAt = 0;
        continue;
      }
      if (!chunk.group) {
        if (!chunk.loading) state.chunks.delete(key);
        continue;
      }
      if (!chunk.dropAt) chunk.dropAt = now + UNLOAD_GRACE;
      else if (now > chunk.dropAt && !dropped) {
        unloadChunk(key, chunk);
        dropped = true;
      }
    }
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
          pending.push({ x, y });
        }
      }
    }
    state.wanted = wanted;
    state.pendingLoads = pending;
  }

  function clearChunks() {
    for (const [key, chunk] of [...state.chunks]) unloadChunk(key, chunk);
    state.chunks.clear();
    state.chunkCenter = null;
    state.wanted = new Set();
    state.pendingLoads = [];
    state.buildQueue = [];
    state.inflight = 0;
    state.blocked = false;
  }

  // ----- buildings -----
  const BUILDING_PALETTE = [
    0xd9cfc2, 0xcdbfae, 0xb9a892, 0xc9c6c0, 0xb2aca4, 0x9a928a, 0xb98a6a, 0xa5674f,
    0xd8d4c9, 0x9aa3a8, 0xc2b6a3, 0x8c8a86,
  ];
  const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  function hash01(a, b) {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // OSM `colour` tag when present, otherwise a stable palette pick per building.
  function buildingColor(props, a, b) {
    const tag = typeof props.colour === "string" ? props.colour.trim() : "";
    if (HEX_RE.test(tag)) return new THREE.Color(tag);
    const i = Math.floor(hash01(a, b) * BUILDING_PALETTE.length) % BUILDING_PALETTE.length;
    return new THREE.Color(BUILDING_PALETTE[i]);
  }

  function addBuilding(feature, x, y, z, out, footprints, ghosts) {
    const props = feature.properties;
    const height = Math.max(3, Number(props.render_height) || 0);
    const minHeight = Number(props.render_min_height) || 0;
    const geo = feature.toGeoJSON(x, y, z);
    const polygons =
      geo.geometry.type === "Polygon" ? [geo.geometry.coordinates] : geo.geometry.coordinates;

    for (const polygon of polygons) {
      let ghost = false;
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
        if (ring.length >= 3) {
          const fp = { minX, maxX, minZ, maxZ, ring };
          ghost = routeIntersectsFootprint(fp);
          footprints.push(fp);
        }
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

      // Facade color per building; roofs and the base of the walls read darker,
      // and walls get a subtle base-to-top gradient so blocks don't look flat.
      const c = buildingColor(props, worldRing[0].x, worldRing[0].z);
      const roofR = c.r * 0.72;
      const roofG = c.g * 0.72;
      const roofB = c.b * 0.72;
      const baseR = c.r * 0.8;
      const baseG = c.g * 0.8;
      const baseB = c.b * 0.8;
      const pa = geometry.attributes.position.array;
      const na = geometry.attributes.normal ? geometry.attributes.normal.array : null;
      const count = geometry.attributes.position.count;
      const colors = new Float32Array(count * 3);
      const yBase = baseY + minHeight;
      const span = Math.max(1, height);
      for (let i = 0; i < count; i++) {
        let r;
        let g;
        let b;
        const ny = na ? na[i * 3 + 1] : 0;
        if (ny > 0.5) {
          r = roofR;
          g = roofG;
          b = roofB;
        } else if (ny < -0.5) {
          r = baseR;
          g = baseG;
          b = baseB;
        } else {
          const t = clamp((pa[i * 3 + 1] - yBase) / span, 0, 1);
          r = baseR + (c.r - baseR) * t;
          g = baseG + (c.g - baseG) * t;
          b = baseB + (c.b - baseB) * t;
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      (ghost && ghosts ? ghosts : out).push(geometry);
    }
  }

  function addBuildingsFromTile(vt, x, y, z, group) {
    const layer = vt.layers["building"];
    const footprints = [];
    if (!layer) return footprints;

    const geometries = [];
    const ghostGeometries = [];
    for (let i = 0; i < layer.length; i++) {
      try {
        addBuilding(layer.feature(i), x, y, z, geometries, footprints, ghostGeometries);
      } catch {
        /* skip malformed feature */
      }
    }
    if (geometries.length) {
      const merged = mergeGeometries(geometries);
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, buildingMaterial);
        mesh.renderOrder = RENDER_ORDER.buildings;
        group.add(mesh);
      }
    }
    if (ghostGeometries.length) {
      const mergedGhost = mergeGeometries(ghostGeometries);
      if (mergedGhost) {
        mergedGhost.computeBoundingSphere();
        const mesh = new THREE.Mesh(mergedGhost, ghostMaterial);
        mesh.renderOrder = RENDER_ORDER.buildings + 1;
        group.add(mesh);
      }
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
    const mesh = new THREE.Mesh(geometry, flatMaterial);
    mesh.renderOrder = RENDER_ORDER.markers;
    group.add(mesh);
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

    disposeGroup(routeGroup);
    const routeMesh = new THREE.Mesh(geometry, routeMaterial);
    routeMesh.renderOrder = RENDER_ORDER.route;
    routeGroup.add(routeMesh);

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
  function openPause() {
    if (state.paused || !state.ready || state.done) return;
    if (!state.track && !state.free) return;
    state.paused = true;
    screenEl.classList.add("paused");
    el.pauseMenu.classList.remove("hidden");
    el.controls.classList.add("hidden");
    for (const key of Object.keys(state.input)) state.input[key] = false;
    state.axis.steer = 0;
    state.axis.throttle = 0;
  }

  function closePause() {
    if (!state.paused) return;
    state.paused = false;
    screenEl.classList.remove("paused");
    el.pauseMenu.classList.add("hidden");
    if (state.track || state.free) el.controls.classList.remove("hidden");
  }

  function resetCar() {
    state.car.speed = 0;
    state.camHeading = null;
    state.progress = 0;
    state.done = false;
    state.started = false;
    state.offRoad = false;
    state.startedAt = null;
    state.blocked = false;
    state.waterUntil = 0;
    closePause();
    el.end.classList.add("hidden");
    for (const key of Object.keys(state.input)) state.input[key] = false;

    if (state.free) {
      // Free roam: respawn at the chosen drop-in point.
      const spawn = state.spawn;
      state.car.lon = spawn.lon;
      state.car.lat = spawn.lat;
      state.car.heading = spawn.heading || 0;
      return;
    }

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

    const throttle = clamp(
      state.axis.throttle + (input.accel ? 1 : 0) - (input.brake ? 1 : 0),
      -1,
      1
    );
    if (throttle > 0) car.speed += CAR.accel * throttle * dt;
    else if (throttle < 0) car.speed += CAR.brake * throttle * dt;
    else {
      const d = CAR.coast * dt;
      car.speed = Math.abs(car.speed) <= d ? 0 : car.speed - Math.sign(car.speed) * d;
    }
    if (state.done) car.speed = Math.max(0, car.speed);
    car.speed = clamp(car.speed, CAR.maxReverse, CAR.maxForward);

    const prevLon = car.lon;
    const prevLat = car.lat;

    const steer = clamp(
      state.axis.steer + (input.right ? 1 : 0) - (input.left ? 1 : 0),
      -1,
      1
    );
    state.steer = steer;
    const absSpeed = Math.abs(car.speed);
    if (steer && absSpeed > 0.4) {
      const factor = Math.min(1, absSpeed / 8) * (1 - Math.min(0.4, absSpeed / 130));
      car.heading =
        (car.heading + steer * CAR.steer * factor * dt * Math.sign(car.speed) + 360) % 360;
    }

    if (state.free) {
      state.offRoad = false;
    } else {
      state.offRoad = nearest(car.lon, car.lat).dist > CAR.roadWidth;
      if (state.offRoad) {
        const d = CAR.offRoad * dt;
        car.speed = Math.abs(car.speed) <= d ? 0 : car.speed - Math.sign(car.speed) * d;
      }
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
        // In free roam the water is a hard edge (no route to snap back to),
        // but a car that starts in it - "keep driving" from a bridge finish or
        // a water drop-in - may drive out rather than being frozen.
        const inFreeWater =
          state.free && inWater(nlon, nlat) && !inWater(car.lon, car.lat);
        if (blockedAt(nlon, nlat) || inFreeWater) {
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

    if (state.free) return;

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

  function updateWheels(dt) {
    if (!carWheels.length) return;
    const car = state.car;
    const steer = state.steer || 0;
    for (const pivot of carWheels) {
      const wheel = pivot.userData.wheel;
      wheel.spin += (car.speed / wheel.radius) * dt;
      const spinner = pivot.children[0];
      if (spinner) spinner.rotation.x = -wheel.spin;
      pivot.rotation.y = wheel.front ? -steer * 0.5 : 0;
    }
  }

  function updateCamera(dt) {
    const car = state.car;
    const w = toWorld(car.lon, car.lat);
    const h = (car.heading * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const gy = terrainY(w.x, w.z);

    carGroup.visible = state.third;

    if (state.third) {
      // Ease the camera's yaw toward the car's, shortest way around. The car's
      // body keeps its true heading, so while the camera catches up you see its
      // side rather than a rigid rear view.
      let ch = state.camHeading;
      if (ch == null || !(dt > 0)) {
        ch = h;
      } else {
        let turn = h - ch;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        ch += turn * (1 - Math.exp(-dt / CAM_LAG));
      }
      state.camHeading = ch;
      const cfx = Math.sin(ch);
      const cfz = -Math.cos(ch);

      // Roads/route sit lifted above the bare terrain, so seat the car on the
      // surface it drives on rather than on the ground (else it clips through).
      const lift = state.free ? ROAD_Y : ROUTE_Y;
      const base = gy + lift;
      carGroup.position.set(w.x, base, w.z);
      carGroup.rotation.y = -h;
      // Longer vehicles (semi) need the camera pulled back further.
      const scale = clamp(carLength / 4.5, 0.7, 2.8);
      const camX = w.x - cfx * CHASE_DIST * scale;
      const camZ = w.z - cfz * CHASE_DIST * scale;
      const camY = Math.max(base + CHASE_HEIGHT * scale, terrainY(camX, camZ) + 0.6);
      camera.position.set(camX, camY, camZ);
      camera.lookAt(w.x + cfx * 5 * scale, base + 1.4, w.z + cfz * 5 * scale);
      return;
    }

    state.camHeading = h;
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

    if (state.track) {
      el.arrow.classList.remove("hidden");
      const now = performance.now();
      if (now - state.lastNav > 100) {
        state.lastNav = now;
        const at = nearest(state.car.lon, state.car.lat);
        let target = at.heading;
        if (at.dist > 12) {
          target = bearing([state.car.lon, state.car.lat], [at.lon, at.lat]);
        }
        const rel = ((target - state.car.heading + 540) % 360) - 180;
        el.arrow.style.transform = `rotate(${rel}deg)`;
      }
    } else {
      el.arrow.classList.add("hidden");
    }
  }

  function finishRoute() {
    const elapsed = state.startedAt ? performance.now() - state.startedAt : 0;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    el.endDistance.textContent = distanceText(state.total);
    el.endTime.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
    el.end.classList.remove("hidden");
  }

  // Roll a finished (or restarted) route straight into free roam: keep the
  // world, chunks and momentum where they are, just drop the route and let the
  // player wander from the finish line.
  function keepDriving() {
    if (!state.track && !state.free) return;
    const car = state.car;
    state.free = true;
    state.track = null;
    state.loadedRef = null;
    state.cum = [];
    state.total = 0;
    state.progress = 0;
    state.startLine = null;
    state.finishLine = null;
    state.routeGrid = null;
    state.done = false;
    state.started = false;
    state.startedAt = null;
    state.offRoad = false;
    state.blocked = false;
    state.waterUntil = 0;
    state.spawn = { lon: car.lon, lat: car.lat, heading: car.heading };
    game.track = null;
    game.freeRoam = { lon: car.lon, lat: car.lat, heading: car.heading };
    state.freeRef = game.freeRoam;
    disposeGroup(routeGroup);
    disposeGroup(markerGroup);
    // Buildings the route ran through were built translucent; make them solid.
    chunkGroup.traverse((obj) => {
      if (obj.isMesh && obj.material === ghostMaterial) {
        obj.material = buildingMaterial;
        obj.renderOrder = RENDER_ORDER.buildings;
      }
    });
    el.end.classList.add("hidden");
    screenEl.classList.add("free");
    closePause();
  }

  function loop(time) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (time - state.lastTime) / 1000 || 0);
    state.lastTime = time;

    if (screenEl.classList.contains("hidden") || (!state.track && !state.free)) return;

    if (!state.ready) {
      if (!state.readySince) state.readySince = time;
      let built = 0;
      for (const key of state.wanted) {
        const chunk = state.chunks.get(key);
        if (chunk && chunk.group) built++;
      }
      if ((state.wanted.size && built >= state.wanted.size) || time - state.readySince > 8000) {
        state.ready = true;
        el.loading.classList.add("hidden");
      }
    }

    if (!state.paused) {
      update(state.ready ? dt : 0);
      updateWheels(state.ready ? dt : 0);
    }
    updateCamera(state.ready ? dt : 0);
    updateHud();

    if (time > state.nextTileCheck) {
      state.nextTileCheck = time + 200;
      const z = VECTOR_Z;
      const cx = Math.floor(lonToTileX(state.car.lon, z));
      const cy = Math.floor(latToTileY(state.car.lat, z));
      updateChunks(cx, cy);
    }

    pumpLoads();
    pumpBuild();
    sweepChunks(time);

    renderer.render(scene, camera);
  }

  function resize() {
    const w = screenEl.clientWidth || 1;
    const h = screenEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // Hold driving until the chunks around the spawn point are built so the
  // player never drops into an empty world. The timeout keeps a bad tile from
  // blocking the game forever.
  function beginLoad() {
    state.ready = false;
    state.readySince = 0;
    el.loading.classList.remove("hidden");
  }

  // Free roam: no route, just a drop-in point. Chunks stream around the car.
  function loadFree(spawn) {
    state.free = true;
    closePause();
    state.track = null;
    state.loadedRef = null;
    state.cum = [];
    state.total = 0;
    state.startLine = null;
    state.finishLine = null;
    state.routeGrid = null;
    state.spawn = spawn;
    state.origin = {
      lon: spawn.lon,
      lat: spawn.lat,
      cosLat: Math.cos((spawn.lat * Math.PI) / 180),
    };
    disposeGroup(routeGroup);
    disposeGroup(markerGroup);
    clearChunks();
    state.nextTileCheck = 0;
    beginLoad();
    resetCar();
  }

  function loadTrack() {
    state.free = false;
    const path = game.track;
    state.track = path;
    closePause();
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
    state.routeGrid = buildRouteGrid(path);
    clearChunks();
    state.nextTileCheck = 0;
    beginLoad();
    buildRoute();
    resetCar();
    drapeRoute();
  }

  function syncTrack() {
    const free = !!game.freeRoam;
    const hasTrack = !!game.track && game.track.length >= 2;
    screenEl.classList.toggle("free", free);
    el.empty.classList.toggle("hidden", hasTrack || free);
    el.controls.classList.toggle("hidden", !(hasTrack || free));

    if (free) {
      if (game.freeRoam !== state.freeRef) {
        state.freeRef = game.freeRoam;
        state.loadedRef = null;
        loadFree(game.freeRoam);
      }
      resize();
      return;
    }

    state.freeRef = null;
    if (!hasTrack) {
      state.free = false;
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

  // ----- control schemes: on-screen pad, tilt steering, one-hand stick -----
  const SCHEMES = ["buttons", "tilt", "hand"];
  const schemeButtons = [...document.querySelectorAll("#d3-scheme button")];
  const stick = document.getElementById("d3-stick");
  const stickKnob = document.getElementById("d3-stick-knob");
  let tiltAttached = false;

  function setScheme(scheme) {
    if (!SCHEMES.includes(scheme)) scheme = "buttons";
    state.scheme = scheme;
    screenEl.classList.remove("scheme-buttons", "scheme-tilt", "scheme-hand");
    screenEl.classList.add("scheme-" + scheme);
    for (const button of schemeButtons) {
      button.classList.toggle("active", button.dataset.scheme === scheme);
    }
    state.axis.steer = 0;
    state.axis.throttle = 0;
    stickKnob.style.transform = "";
    try {
      localStorage.setItem("racer.controls", scheme);
    } catch {}
  }

  function attachTilt() {
    if (tiltAttached) return;
    tiltAttached = true;
    window.addEventListener("deviceorientation", (e) => {
      if (state.scheme !== "tilt" || screenEl.classList.contains("hidden")) return;
      const gamma = e.gamma || 0;
      const dead = 4;
      state.axis.steer =
        Math.abs(gamma) < dead ? 0 : clamp((gamma - Math.sign(gamma) * dead) / 22, -1, 1);
    });
  }

  // iOS 13+ gates device orientation behind a user gesture.
  function requestTilt() {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      DeviceOrientationEvent.requestPermission()
        .then((result) => {
          if (result === "granted") attachTilt();
        })
        .catch(() => {});
    } else {
      attachTilt();
    }
  }

  for (const button of schemeButtons) {
    button.addEventListener("click", () => {
      if (button.dataset.scheme === "tilt") requestTilt();
      setScheme(button.dataset.scheme);
    });
  }

  // One-hand thumbstick: up accelerates, down brakes/reverses, sides steer.
  let stickPointer = null;
  function moveStick(clientX, clientY) {
    const rect = stick.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (clientX - (rect.left + radius)) / radius;
    let dy = (clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    const dead = 0.14;
    const axis = (v) => (Math.abs(v) < dead ? 0 : (v - Math.sign(v) * dead) / (1 - dead));
    state.axis.steer = clamp(axis(dx), -1, 1);
    state.axis.throttle = clamp(-axis(dy), -1, 1);
    const travel = 0.4 * radius;
    stickKnob.style.transform = `translate(${dx * travel}px, ${dy * travel}px)`;
  }
  stick.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stickPointer = e.pointerId;
    try {
      stick.setPointerCapture(e.pointerId);
    } catch {}
    moveStick(e.clientX, e.clientY);
  });
  stick.addEventListener("pointermove", (e) => {
    if (e.pointerId === stickPointer) moveStick(e.clientX, e.clientY);
  });
  const releaseStick = (e) => {
    if (stickPointer != null && e.pointerId !== stickPointer) return;
    stickPointer = null;
    state.axis.steer = 0;
    state.axis.throttle = 0;
    stickKnob.style.transform = "";
  };
  stick.addEventListener("pointerup", releaseStick);
  stick.addEventListener("pointercancel", releaseStick);

  let savedScheme = "buttons";
  try {
    savedScheme = localStorage.getItem("racer.controls") || "buttons";
  } catch {}
  setScheme(savedScheme);
  if (savedScheme === "tilt") attachTilt();

  const KEYS = {
    ArrowUp: "accel", w: "accel", W: "accel",
    ArrowDown: "brake", s: "brake", S: "brake",
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
  };

  window.addEventListener("keydown", (e) => {
    if (screenEl.classList.contains("hidden")) return;
    if (e.key === "Escape" || e.key === "p" || e.key === "P") {
      if (!state.ready || (!state.track && !state.free)) return;
      e.preventDefault();
      if (state.paused) closePause();
      else openPause();
      return;
    }
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

  const viewBtn = document.getElementById("d3-view");
  function updateViewButton() {
    viewBtn.textContent = state.third ? "First person" : "Third person";
    screenEl.classList.toggle("view-third", state.third);
    screenEl.classList.toggle("view-first", !state.third);
  }
  viewBtn.addEventListener("click", () => {
    state.third = !state.third;
    state.camHeading = null;
    updateViewButton();
  });
  updateViewButton();

  el.pause.addEventListener("click", openPause);
  el.pauseMenu.addEventListener("click", (e) => {
    if (e.target === el.pauseMenu) closePause();
  });
  document.getElementById("d3-resume").addEventListener("click", closePause);
  document.getElementById("d3-back").addEventListener("click", () => {
    closePause();
    openScreen("home");
  });

  document.getElementById("d3-restart").addEventListener("click", () => {
    if (state.track || state.free) resetCar();
  });
  document.getElementById("d3-again").addEventListener("click", () => {
    if (state.track || state.free) resetCar();
  });
  document.getElementById("d3-keep").addEventListener("click", keepDriving);

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
