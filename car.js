const CAR_STYLES = [
  { id: "sedan", name: "Sedan" },
  { id: "sports", name: "Sports" },
  { id: "truck", name: "Truck" },
];

const CAR_COLORS = [
  "#dc2626", "#f59e0b", "#16a34a", "#0ea5e9", "#2563eb", "#a855f7",
  "#ec4899", "#e2e8f0", "#94a3b8", "#111827",
];

const carSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("racer.car"));
    if (saved && CAR_STYLES.some((s) => s.id === saved.style) && /^#[0-9a-f]{6}$/i.test(saved.color)) {
      return { style: saved.style, color: saved.color };
    }
  } catch {}
  return { style: "sedan", color: "#dc2626" };
})();

const carListeners = [];

function onCarChange(fn) {
  carListeners.push(fn);
}

function saveCar() {
  try {
    localStorage.setItem("racer.car", JSON.stringify(carSettings));
  } catch {}
}

function notifyCar() {
  syncCarButtons();
  for (const fn of carListeners) fn(carSettings);
}

function setCarStyle(id) {
  if (!CAR_STYLES.some((s) => s.id === id) || carSettings.style === id) return;
  carSettings.style = id;
  saveCar();
  notifyCar();
}

function setCarColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color) || carSettings.color === color) return;
  carSettings.color = color;
  saveCar();
  notifyCar();
}

// Low-poly car facing -Z, wheels resting on y = 0. Shared by the 3D drive
// modes and the menu preview.
function buildCarMesh(style, color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const cabinMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111827 });

  function box(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || bodyMat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }

  function wheel(radius, x, z) {
    const geo = new THREE.CylinderGeometry(radius, radius, 0.32, 12);
    const mesh = new THREE.Mesh(geo, wheelMat);
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(x, radius, z);
    group.add(mesh);
  }

  if (style === "sports") {
    box(1.9, 0.4, 4.2, 0, 0.52, 0);
    box(1.5, 0.4, 1.6, 0, 0.9, -0.1, cabinMat);
    box(1.7, 0.08, 0.5, 0, 0.86, 2.0); // rear spoiler
    wheel(0.33, -0.98, -1.35);
    wheel(0.33, 0.98, -1.35);
    wheel(0.33, -0.98, 1.35);
    wheel(0.33, 0.98, 1.35);
  } else if (style === "truck") {
    box(2.0, 0.55, 4.4, 0, 0.72, 0);
    box(1.9, 0.75, 1.5, 0, 1.22, -1.25, cabinMat); // cab
    box(1.9, 0.5, 2.1, 0, 1.0, 0.95); // bed walls
    box(1.7, 0.1, 1.9, 0, 1.28, 0.95, cabinMat); // bed floor shadow
    wheel(0.44, -1.02, -1.4);
    wheel(0.44, 1.02, -1.4);
    wheel(0.44, -1.02, 1.4);
    wheel(0.44, 1.02, 1.4);
  } else {
    box(1.8, 0.55, 4.0, 0, 0.6, 0);
    box(1.6, 0.5, 2.0, 0, 1.05, -0.25, cabinMat);
    wheel(0.34, -0.92, -1.28);
    wheel(0.34, 0.92, -1.28);
    wheel(0.34, -0.92, 1.28);
    wheel(0.34, 0.92, 1.28);
  }

  return group;
}

function syncCarButtons() {
  document.querySelectorAll("[data-car-style]").forEach((el) => {
    el.classList.toggle("active", el.dataset.carStyle === carSettings.style);
  });
  document.querySelectorAll("[data-car-color]").forEach((el) => {
    el.classList.toggle("active", el.dataset.carColor.toLowerCase() === carSettings.color.toLowerCase());
  });
}

function initCarGarage() {
  const stylesEl = document.getElementById("car-styles");
  const colorsEl = document.getElementById("car-colors");
  if (!stylesEl || !colorsEl) return;

  for (const style of CAR_STYLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = style.name;
    btn.dataset.carStyle = style.id;
    btn.addEventListener("click", () => setCarStyle(style.id));
    stylesEl.appendChild(btn);
  }

  for (const color of CAR_COLORS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.dataset.carColor = color;
    btn.style.background = color;
    btn.setAttribute("aria-label", `Paint ${color}`);
    btn.addEventListener("click", () => setCarColor(color));
    colorsEl.appendChild(btn);
  }

  syncCarButtons();
}

function mountCarPreview(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4477aa, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-4, 8, 5);
  scene.add(sun);

  const car = buildCarMesh(carSettings.style, carSettings.color);
  scene.add(car);

  function rebuild() {
    while (car.children.length) {
      const child = car.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    car.add(...buildCarMesh(carSettings.style, carSettings.color).children);
  }
  onCarChange(rebuild);

  let angle = 0.6;

  function render() {
    const w = canvas.clientWidth || 200;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    angle += 0.008;
    const r = 7;
    camera.position.set(Math.sin(angle) * r, 2.7, Math.cos(angle) * r);
    camera.lookAt(0, 0.85, 0);
    renderer.render(scene, camera);
  }

  const home = document.getElementById("home");
  let rafId = null;
  function tick() {
    render();
    rafId = requestAnimationFrame(tick);
  }
  function update() {
    const visible = home && !home.classList.contains("hidden");
    if (visible && rafId == null) rafId = requestAnimationFrame(tick);
    else if (!visible && rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  if (home) new MutationObserver(update).observe(home, { attributes: true, attributeFilter: ["class"] });
  update();
}

function waitForThree(fn) {
  if (window.THREE) {
    fn();
    return;
  }
  let tries = 0;
  const timer = setInterval(() => {
    if (window.THREE) {
      clearInterval(timer);
      fn();
    } else if (++tries > 200) {
      clearInterval(timer);
    }
  }, 25);
}

window.addEventListener("DOMContentLoaded", () => {
  initCarGarage();
  waitForThree(() => {
    const canvas = document.getElementById("car-preview");
    if (canvas) mountCarPreview(canvas);
  });
});
