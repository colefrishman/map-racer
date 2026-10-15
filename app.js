const OSRM = "https://router.project-osrm.org";
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const START = [2.3522, 48.8566];

const colorInput = document.getElementById("color");
const statusEl = document.getElementById("status");

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,
  center: START,
  zoom: 13,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
map.addControl(new maplibregl.FullscreenControl(), "top-right");

const routes = [];
let current = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function toFeature(geometry, color) {
  return { type: "Feature", properties: { color }, geometry };
}

function newRoute() {
  current = { color: colorInput.value, points: [], line: null };
  routes.push(current);
  drawRoutes();
  setStatus("Click a road to add a point.");
}

function drawRoutes() {
  const source = map.getSource("routes");
  if (!source) return;

  const features = [];
  for (const route of routes) {
    if (route.line) features.push(toFeature(route.line, route.color));
    for (const point of route.points) {
      features.push(toFeature({ type: "Point", coordinates: point }, route.color));
    }
  }

  source.setData({ type: "FeatureCollection", features });
}

async function traceActiveRoute() {
  if (!current) return;

  if (current.points.length < 2) {
    current.line = null;
    drawRoutes();
    setStatus(`${current.points.length} point added — click another road to trace.`);
    return;
  }

  const path = current.points.map((p) => p.join(",")).join(";");
  const url = `${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson`;

  setStatus("Following roads…");

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("routing service unavailable");

    const data = await res.json();
    if (data.code !== "Ok" || !data.routes.length) {
      throw new Error("no connected road route found");
    }

    const route = data.routes[0];
    current.line = route.geometry;
    const km = (route.distance / 1000).toFixed(2);
    setStatus(`${current.points.length} points · ${km} km`);
  } catch (err) {
    current.line = null;
    setStatus(err.message);
  }

  drawRoutes();
}

map.on("load", () => {
  map.addSource("routes", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "routes",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 11, "line-opacity": 0.85 },
  });

  map.addLayer({
    id: "route-lines",
    type: "line",
    source: "routes",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 6, "line-opacity": 0.9 },
  });

  map.addLayer({
    id: "route-points",
    type: "circle",
    source: "routes",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 6,
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  newRoute();
});

map.on("click", (e) => {
  if (!current) newRoute();
  current.points.push([e.lngLat.lng, e.lngLat.lat]);
  traceActiveRoute();
});

document.getElementById("new").addEventListener("click", newRoute);
document.getElementById("undo").addEventListener("click", () => {
  if (current && current.points.length) {
    current.points.pop();
    traceActiveRoute();
  }
});
document.getElementById("clear").addEventListener("click", () => {
  routes.length = 0;
  newRoute();
});

colorInput.addEventListener("input", () => {
  if (current) {
    current.color = colorInput.value;
    drawRoutes();
  }
});
