const DRIVE_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const CAR = {
  maxForward: 42,
  maxReverse: -9,
  accel: 15,
  brake: 30,
  coast: 7,
  offRoad: 10,
  steer: 68,
  roadWidth: 24,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
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

function initDrive() {
  const screenEl = document.getElementById("drive");
  const el = {
    speed: document.getElementById("drive-speed"),
    speedUnit: document.getElementById("drive-speed-unit"),
    progress: document.getElementById("drive-progress"),
    progressFill: document.getElementById("drive-progress-fill"),
    warning: document.getElementById("drive-warning"),
    empty: document.getElementById("drive-empty"),
    end: document.getElementById("drive-end"),
    endDistance: document.getElementById("end-distance"),
    endTime: document.getElementById("end-time"),
    controls: document.querySelector(".drive-controls"),
  };

  const map = new maplibregl.Map({
    container: "drive-map",
    style: DRIVE_STYLE,
    center: [2.3522, 48.8566],
    zoom: 17,
  });

  const state = {
    ready: false,
    track: null,
    loadedRef: null,
    cum: [],
    total: 0,
    car: { lon: 0, lat: 0, heading: 0, speed: 0 },
    input: { left: false, right: false, accel: false, brake: false },
    offRoad: false,
    progress: 0,
    done: false,
    startedAt: null,
    lastTime: 0,
  };

  const carEl = document.createElement("div");
  carEl.className = "car";
  carEl.innerHTML = `
    <svg viewBox="0 0 20 40" width="100%" height="100%">
      <rect x="0.5" y="7" width="4" height="9" rx="1.5" fill="#111827"/>
      <rect x="15.5" y="7" width="4" height="9" rx="1.5" fill="#111827"/>
      <rect x="0.5" y="25" width="4" height="9" rx="1.5" fill="#111827"/>
      <rect x="15.5" y="25" width="4" height="9" rx="1.5" fill="#111827"/>
      <rect x="3" y="1" width="14" height="38" rx="6" fill="#e63946"/>
      <path d="M5.2 9.5 h9.6 l-1.4 6.5 h-6.8 z" fill="#bfe3ff"/>
      <rect x="5" y="17.5" width="10" height="7" rx="2" fill="#c92a39"/>
      <path d="M6.4 27.5 h7.2 l-1.1 5 h-5 z" fill="#bfe3ff"/>
    </svg>`;
  const carMarker = new maplibregl.Marker({ element: carEl, rotationAlignment: "viewport" });

  const startMarker = new maplibregl.Marker({
    element: Object.assign(document.createElement("div"), { className: "stop start" }),
  });
  const endMarker = new maplibregl.Marker({
    element: Object.assign(document.createElement("div"), { className: "stop end" }),
  });

  function nearest(lon, lat) {
    const track = state.track;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let bestDist = Infinity;
    let bestAlong = 0;

    for (let i = 0; i < track.length - 1; i++) {
      const ax = (track[i][0] - lon) * 111320 * cosLat;
      const ay = (track[i][1] - lat) * 111320;
      const bx = (track[i + 1][0] - lon) * 111320 * cosLat;
      const by = (track[i + 1][1] - lat) * 111320;
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
    el.end.classList.add("hidden");

    for (const key of Object.keys(state.input)) state.input[key] = false;

    if (!carEl.isConnected) carMarker.addTo(map);
    carMarker.setLngLat([state.car.lon, state.car.lat]).setRotation(state.car.heading);
    map.jumpTo({ center: [state.car.lon, state.car.lat] });
  }

  function buildTrack() {
    const path = game.track;
    state.track = path;
    state.cum = [0];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      total += haversine(path[i - 1], path[i]);
      state.cum.push(total);
    }
    state.total = total;

    const source = map.getSource("track");
    if (source) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: path },
      });
    }

    startMarker.setLngLat(path[0]);
    endMarker.setLngLat(path[path.length - 1]);
    if (!startMarker.getElement().isConnected) startMarker.addTo(map);
    if (!endMarker.getElement().isConnected) endMarker.addTo(map);

    resetCar();
  }

  function syncTrack() {
    const hasTrack = state.ready && !!game.track && game.track.length >= 2;
    el.empty.classList.toggle("hidden", hasTrack);
    el.controls.classList.toggle("hidden", !hasTrack);

    if (!hasTrack) {
      state.track = null;
      return;
    }
    if (game.track !== state.loadedRef) {
      state.loadedRef = game.track;
      buildTrack();
    }
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
    const step = car.speed * dt;
    car.lat += (Math.cos(h) * step) / 111320;
    car.lon += (Math.sin(h) * step) / (111320 * Math.cos((car.lat * Math.PI) / 180));

    const at = nearest(car.lon, car.lat);
    state.progress = state.total ? clamp(at.along / state.total, 0, 1) : 0;
    const finishAt = state.total - Math.min(25, state.total * 0.2);
    if (!state.done && state.total && at.along >= finishAt) {
      state.done = true;
      finishRoute();
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

  function render() {
    el.speed.textContent = speedText(Math.abs(state.car.speed));
    el.speedUnit.textContent = speedUnit();
    el.progress.textContent = `${Math.round(state.progress * 100)}%`;
    el.progressFill.style.width = `${state.progress * 100}%`;
    el.warning.classList.toggle("hidden", !state.offRoad);

    carMarker.setLngLat([state.car.lon, state.car.lat]).setRotation(state.car.heading);
    map.jumpTo({ center: [state.car.lon, state.car.lat] });
  }

  function loop(time) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (time - state.lastTime) / 1000 || 0);
    state.lastTime = time;

    if (screenEl.classList.contains("hidden") || !state.track) return;
    update(dt);
    render();
  }

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

  holdButton("ctrl-left", "left");
  holdButton("ctrl-right", "right");
  holdButton("ctrl-accel", "accel");
  holdButton("ctrl-brake", "brake");

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

  document.getElementById("drive-restart").addEventListener("click", () => {
    if (state.track) resetCar();
  });
  document.getElementById("end-again").addEventListener("click", () => {
    if (state.track) resetCar();
  });

  onUnitsChange(() => {
    if (state.track) render();
    if (state.done) el.endDistance.textContent = distanceText(state.total);
  });

  map.on("load", () => {
    map.addSource("track", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "track-casing",
      type: "line",
      source: "track",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.9 },
    });
    map.addLayer({
      id: "track-line",
      type: "line",
      source: "track",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#2563eb", "line-width": 6, "line-opacity": 0.85 },
    });

    state.ready = true;
    syncTrack();
  });

  requestAnimationFrame(loop);

  return {
    resize() {
      map.resize();
      syncTrack();
    },
  };
}

registerScreen("drive", { enter: initDrive });
