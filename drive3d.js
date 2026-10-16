(function () {
const TILEJSON_URL = "https://tiles.openfreemap.org/planet";

const VECTOR_Z = 14;
const CHUNK_RADIUS = 1;
const M_PER_DEG_LAT = 111320;
const EYE_HEIGHT = 1.7;
const ROAD_WIDTH = 9;

const WATER_Y = 0.02;
const AREA_Y = 0.03;
const ROAD_Y = 0.08;

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
    empty: document.getElementById("d3-empty"),
    end: document.getElementById("d3-end"),
    endDistance: document.getElementById("d3-end-distance"),
    endTime: document.getElementById("d3-end-time"),
    controls: document.querySelector("#drive3d .drive-controls"),
  };

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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

  const baseMaterial = new THREE.MeshBasicMaterial({ color: 0xe6e4dc });
  const flatMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const routeMaterial = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

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
    startedAt: null,
    lastTime: 0,
    chunks: new Map(),
    chunkCenter: null,
    nextTileCheck: 0,
    blocked: false,
  };

  function toWorld(lon, lat) {
    const o = state.origin;
    return {
      x: (lon - o.lon) * M_PER_DEG_LAT * o.cosLat,
      z: -(lat - o.lat) * M_PER_DEG_LAT,
    };
  }

  function nearest(lon, lat) {
    const track = state.track;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let bestDist = Infinity;
    let bestAlong = 0;
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
      }
    }
    return { dist: bestDist, along: bestAlong };
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
    grass: new THREE.Color(0xcdebb0),
    wood: new THREE.Color(0xa9cf9a),
    farm: new THREE.Color(0xeef0d5),
    sand: new THREE.Color(0xf0e8c8),
    rock: new THREE.Color(0xdcdcd2),
    wetland: new THREE.Color(0xc9e0d4),
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
    if (layerName === "water") return GROUND_COLORS.water;
    if (layerName === "park") return GROUND_COLORS.park;
    const cls = p.class;
    const sub = p.subclass;
    if (layerName === "landcover") {
      if (cls === "wood" || sub === "wood" || sub === "forest") return GROUND_COLORS.wood;
      if (cls === "farmland" || cls === "farm") return GROUND_COLORS.farm;
      if (cls === "sand" || sub === "sand" || sub === "beach") return GROUND_COLORS.sand;
      if (cls === "rock" || sub === "rock") return GROUND_COLORS.rock;
      if (cls === "wetland" || sub === "wetland") return GROUND_COLORS.wetland;
      return GROUND_COLORS.grass;
    }
    if (layerName === "landuse") {
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
      if (
        cls === "pitch" ||
        cls === "playground" ||
        cls === "theme_park" ||
        cls === "recreation_ground" ||
        cls === "garden" ||
        cls === "park" ||
        cls === "cemetery" ||
        cls === "military" ||
        cls === "track" ||
        cls === "grass" ||
        cls === "meadow" ||
        cls === "village_green"
      )
        return GROUND_COLORS.grass;
      if (cls === "sand") return GROUND_COLORS.sand;
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

  function pushPolygon(geometry, color, y, positions, colors) {
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
        for (const idx of tri) {
          const v = verts[idx];
          if (!v) continue;
          positions.push(v.x, y, v.y);
          colors.push(color.r, color.g, color.b);
        }
      }
    }
  }

  function pushRibbon(line, width, y, color, positions, colors) {
    const half = width / 2;
    for (let i = 0; i < line.length - 1; i++) {
      const a = toWorld(line[i][0], line[i][1]);
      const b = toWorld(line[i + 1][0], line[i + 1][1]);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = (-dz / len) * half;
      const nz = (dx / len) * half;
      const ax = a.x + nx;
      const az = a.z + nz;
      const bx = a.x - nx;
      const bz = a.z - nz;
      const cx = b.x - nx;
      const cz = b.z - nz;
      const dxe = b.x + nx;
      const dze = b.z + nz;
      positions.push(ax, y, az, bx, y, bz, cx, y, cz, ax, y, az, cx, y, cz, dxe, y, dze);
      for (let k = 0; k < 6; k++) colors.push(color.r, color.g, color.b);
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

  function addGroundAreas(vt, x, y, z, positions, colors) {
    for (const name of ["water", "landcover", "landuse", "park"]) {
      const layer = vt.layers[name];
      if (!layer) continue;
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
        pushPolygon(geo.geometry, c, name === "water" ? WATER_Y : AREA_Y, positions, colors);
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
          pushRibbon(line, width, WATER_Y, GROUND_COLORS.water, positions, colors);
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
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [nw.x, 0, nw.z, se.x, 0, nw.z, se.x, 0, se.z, nw.x, 0, se.z],
        3
      )
    );
    geometry.setIndex([0, 2, 1, 0, 3, 2]);
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
    const buffer = await fetchTileBuffer(template, z, x, y);
    if (state.chunks.get(key) !== chunk) return;

    const group = new THREE.Group();
    let footprints = [];
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
        addGroundAreas(vt, x, y, z, areaPositions, areaColors);
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
        geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      } catch {
        continue;
      }
      if (!geometry.attributes.position || geometry.attributes.position.count === 0) continue;
      geometry.clearGroups();
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, minHeight, 0);

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
  function buildRoute() {
    const path = state.track.map(([lon, lat]) => toWorld(lon, lat));
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
      positions.push(path[i].x + nx * half, 0.15, path[i].z + nz * half);
      positions.push(path[i].x - nx * half, 0.15, path[i].z - nz * half);
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
    const markerGeo = new THREE.CylinderGeometry(3, 3, 0.3, 20);
    const start = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x16a34a }));
    const p0 = path[0];
    start.position.set(p0.x, 0.2, p0.z);
    const end = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xdc2626 }));
    const pN = path[path.length - 1];
    end.position.set(pN.x, 0.2, pN.z);
    markerGroup.add(start, end);
  }

  // ----- simulation -----
  function resetCar() {
    const track = state.track;
    state.car.lon = track[0][0];
    state.car.lat = track[0][1];
    state.car.heading = track.length > 1 ? bearing(track[0], track[1]) : 0;
    state.car.speed = 0;
    state.progress = 0;
    state.done = false;
    state.offRoad = false;
    state.startedAt = null;
    state.blocked = false;
    el.end.classList.add("hidden");
    for (const key of Object.keys(state.input)) state.input[key] = false;
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

    if (state.startedAt === null && Math.abs(car.speed) > 0.5) {
      state.startedAt = performance.now();
    }

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

    const at = nearest(car.lon, car.lat);
    state.progress = state.total ? clamp(at.along / state.total, 0, 1) : 0;
    const finishAt = state.total - Math.min(25, state.total * 0.2);
    if (!state.done && state.total && at.along >= finishAt) {
      state.done = true;
      finishRoute();
    }
  }

  function updateCamera() {
    const car = state.car;
    const w = toWorld(car.lon, car.lat);
    const h = (car.heading * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    camera.position.set(w.x, EYE_HEIGHT, w.z);
    camera.lookAt(w.x + fx * 60, EYE_HEIGHT - 3, w.z + fz * 60);
  }

  function updateHud() {
    el.speed.textContent = speedText(Math.abs(state.car.speed));
    el.speedUnit.textContent = speedUnit();
    el.progress.textContent = `${Math.round(state.progress * 100)}%`;
    el.progressFill.style.width = `${state.progress * 100}%`;
    el.warning.classList.toggle("hidden", !state.offRoad);
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
    clearChunks();
    state.nextTileCheck = 0;
    buildRoute();
    resetCar();
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
