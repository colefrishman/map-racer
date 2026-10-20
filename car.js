const CAR_STYLES = [
  { id: "sedan", name: "Sedan" },
  { id: "hatchback", name: "Hatchback" },
  { id: "sports", name: "Sports" },
  { id: "muscle", name: "Muscle" },
  { id: "suv", name: "SUV" },
  { id: "pickup", name: "Pickup" },
  { id: "van", name: "Van" },
  { id: "semi", name: "Semi" },
  { id: "gokart", name: "Go Kart" },
  { id: "bike", name: "Bike" },
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

// Low-poly cars facing -Z (front at -z, rear at +z), wheels resting on y = 0.
// Shared by the 3D drive modes and the menu preview.
function buildCarMesh(style, color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x232a33 });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x2c3e52 });
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x131820 });
  const hubMat = new THREE.MeshLambertMaterial({ color: 0xb9c1c9 });
  const chromeMat = new THREE.MeshLambertMaterial({ color: 0x9aa4ad });
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xe9ecef });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });

  function box(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || bodyMat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }

  function cyl(radius, height, x, y, z, mat, axis) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), mat || chromeMat);
    mesh.position.set(x, y, z);
    if (axis === "z") mesh.rotation.x = Math.PI / 2;
    else if (axis === "x") mesh.rotation.z = Math.PI / 2;
    group.add(mesh);
    return mesh;
  }

  const boltGeo = new THREE.BoxGeometry(0.035, 0.075, 0.075);
  function wheel(radius, x, z, width) {
    const w = width || 0.32;
    // Steer pivot (yaw) wraps a spin pivot (axle) so drive3d can animate both.
    const steer = new THREE.Group();
    steer.position.set(x, radius, z);
    steer.userData.wheel = { radius, front: z < 0, spin: 0 };
    const spin = new THREE.Group();
    steer.add(spin);

    const t = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, w, 16), tireMat);
    t.rotation.z = Math.PI / 2;
    spin.add(t);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, w + 0.03, 10), hubMat);
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);

    // Lug nuts make the spin readable; a smooth cylinder looks static.
    const faces = x === 0 ? [-1, 1] : [Math.sign(x)];
    for (const face of faces) {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const bolt = new THREE.Mesh(boltGeo, darkMat);
        bolt.position.set(
          face * (w / 2 + 0.02),
          Math.cos(a) * radius * 0.32,
          Math.sin(a) * radius * 0.32
        );
        spin.add(bolt);
      }
    }
    group.add(steer);
  }

  function lights(z, y, halfW, mat, w, h) {
    box(w || 0.32, h || 0.14, 0.12, -halfW, y, z, mat);
    box(w || 0.32, h || 0.14, 0.12, halfW, y, z, mat);
  }

  function mirror(halfW, y, z) {
    box(0.16, 0.1, 0.26, -halfW, y, z, darkMat);
    box(0.16, 0.1, 0.26, halfW, y, z, darkMat);
  }

  if (style === "hatchback") {
    box(1.8, 0.52, 3.9, 0, 0.62, 0);
    box(1.58, 0.5, 2.1, 0, 1.08, 0.35, glassMat);
    box(1.62, 0.14, 2.15, 0, 1.35, 0.45);
    box(1.85, 0.2, 0.32, 0, 0.44, -1.9, chromeMat);
    box(0.9, 0.2, 0.1, 0, 0.62, -1.98, darkMat);
    lights(-1.98, 0.72, 0.6, headMat);
    lights(1.94, 0.9, 0.6, tailMat, 0.32, 0.2);
    mirror(0.92, 1.06, -0.5);
    wheel(0.33, -0.84, -1.18);
    wheel(0.33, 0.84, -1.18);
    wheel(0.33, -0.84, 1.18);
    wheel(0.33, 0.84, 1.18);
  } else if (style === "sports") {
    box(1.95, 0.34, 4.3, 0, 0.5, 0);
    box(1.5, 0.34, 1.5, 0, 0.8, -0.05, glassMat);
    box(1.54, 0.12, 1.55, 0, 0.97, -0.05);
    box(1.9, 0.14, 0.3, 0, 0.4, -2.12, darkMat);
    box(1.7, 0.06, 0.42, 0, 0.86, 2.0);
    box(0.08, 0.24, 0.42, -0.7, 0.74, 2.0, darkMat);
    box(0.08, 0.24, 0.42, 0.7, 0.74, 2.0, darkMat);
    box(0.5, 0.1, 0.06, 0, 0.52, -2.16, darkMat);
    lights(-2.14, 0.6, 0.66, headMat, 0.4, 0.1);
    lights(2.14, 0.62, 0.66, tailMat, 0.4, 0.1);
    mirror(0.98, 0.82, -0.42);
    wheel(0.34, -0.9, -1.45);
    wheel(0.34, 0.9, -1.45);
    wheel(0.34, -0.9, 1.45);
    wheel(0.34, 0.9, 1.45);
  } else if (style === "muscle") {
    box(1.98, 0.5, 4.8, 0, 0.62, 0);
    box(1.72, 0.44, 1.7, 0, 1.04, 0.6, glassMat);
    box(1.76, 0.14, 1.75, 0, 1.3, 0.6);
    box(0.7, 0.12, 1.0, 0, 0.92, -1.1);
    box(1.94, 0.16, 0.34, 0, 0.46, -2.38, darkMat);
    box(0.6, 0.06, 0.4, 0, 0.9, 2.28);
    lights(-2.34, 0.68, 0.66, headMat);
    lights(2.34, 0.72, 0.66, tailMat, 0.36, 0.16);
    mirror(0.99, 1.02, -0.15);
    wheel(0.37, -0.9, -1.55);
    wheel(0.37, 0.9, -1.55);
    wheel(0.37, -0.9, 1.55);
    wheel(0.37, 0.9, 1.55);
  } else if (style === "suv") {
    box(1.95, 0.82, 4.6, 0, 0.85, 0);
    box(1.82, 0.62, 2.9, 0, 1.52, 0.15, glassMat);
    box(1.86, 0.14, 2.95, 0, 1.84, 0.15);
    box(0.08, 0.08, 2.7, -0.7, 1.95, 0.15, chromeMat);
    box(0.08, 0.08, 2.7, 0.7, 1.95, 0.15, chromeMat);
    box(2.0, 0.22, 0.36, 0, 0.5, -2.3, darkMat);
    box(2.0, 0.22, 0.36, 0, 0.5, 2.3, darkMat);
    lights(-2.34, 1.0, 0.66, headMat, 0.36, 0.2);
    lights(2.34, 1.0, 0.66, tailMat, 0.36, 0.2);
    mirror(0.99, 1.5, -0.35);
    wheel(0.44, -0.9, -1.5);
    wheel(0.44, 0.9, -1.5);
    wheel(0.44, -0.9, 1.5);
    wheel(0.44, 0.9, 1.5);
  } else if (style === "pickup") {
    box(2.0, 0.5, 4.9, 0, 0.7, 0);
    box(1.92, 0.72, 1.55, 0, 1.28, -1.35, glassMat);
    box(1.96, 0.14, 1.6, 0, 1.64, -1.35);
    box(1.9, 0.5, 2.2, 0, 1.05, 1.15);
    box(1.66, 0.3, 2.0, 0, 1.0, 1.15, darkMat);
    box(2.05, 0.24, 0.36, 0, 0.5, -2.4, chromeMat);
    box(0.98, 0.22, 0.1, 0, 0.66, -2.46, darkMat);
    lights(-2.44, 0.82, 0.66, headMat);
    lights(2.4, 0.8, 0.7, tailMat, 0.36, 0.18);
    mirror(1.0, 1.28, -0.9);
    wheel(0.46, -0.92, -1.55);
    wheel(0.46, 0.92, -1.55);
    wheel(0.46, -0.92, 1.55);
    wheel(0.46, 0.92, 1.55);
  } else if (style === "van") {
    box(2.0, 1.35, 5.0, 0, 1.08, 0);
    box(1.9, 0.55, 0.16, 0, 1.55, -2.5, glassMat);
    box(0.14, 0.5, 1.7, -0.99, 1.5, -1.2, glassMat);
    box(0.14, 0.5, 1.7, 0.99, 1.5, -1.2, glassMat);
    box(2.04, 0.22, 0.4, 0, 0.55, -2.55, darkMat);
    box(0.9, 0.4, 0.1, 0, 0.75, -2.55, darkMat);
    lights(-2.54, 0.9, 0.7, headMat);
    lights(2.54, 1.1, 0.7, tailMat, 0.3, 0.24);
    mirror(1.03, 1.5, -1.6);
    wheel(0.4, -0.95, -1.7);
    wheel(0.4, 0.95, -1.7);
    wheel(0.4, -0.95, 1.7);
    wheel(0.4, 0.95, 1.7);
  } else if (style === "semi") {
    box(2.2, 1.9, 2.6, 0, 1.75, -3.25);
    box(1.95, 0.7, 0.16, 0, 2.12, -4.5, glassMat);
    box(0.16, 0.7, 1.2, -1.05, 2.0, -3.7, glassMat);
    box(0.16, 0.7, 1.2, 1.05, 2.0, -3.7, glassMat);
    cyl(0.08, 2.4, -1.05, 2.1, -2.2, chromeMat, "y");
    cyl(0.08, 2.4, 1.05, 2.1, -2.2, chromeMat, "y");
    box(2.3, 0.4, 7.2, 0, 0.75, 0.5, darkMat);
    box(2.15, 0.2, 0.35, 0, 0.55, -4.62, chromeMat);
    lights(-4.6, 0.95, 0.75, headMat, 0.32, 0.16);
    box(2.35, 2.5, 5.6, 0, 2.05, 1.9, whiteMat);
    box(2.39, 2.54, 0.14, 0, 2.05, -0.9, chromeMat);
    lights(4.68, 0.95, 0.8, tailMat, 0.32, 0.18);
    wheel(0.5, -1.06, -3.6, 0.42);
    wheel(0.5, 1.06, -3.6, 0.42);
    wheel(0.5, -1.06, -2.4, 0.42);
    wheel(0.5, 1.06, -2.4, 0.42);
    wheel(0.5, -1.06, 3.9, 0.42);
    wheel(0.5, 1.06, 3.9, 0.42);
  } else if (style === "gokart") {
    box(0.62, 0.08, 1.7, 0, 0.2, 0, darkMat);
    box(0.5, 0.22, 0.5, 0, 0.32, -0.95);
    box(0.12, 0.24, 1.0, -0.42, 0.32, 0.05);
    box(0.12, 0.24, 1.0, 0.42, 0.32, 0.05);
    box(0.42, 0.5, 0.16, 0, 0.5, 0.35, darkMat);
    box(0.42, 0.1, 0.42, 0, 0.28, 0.18, darkMat);
    box(0.42, 0.34, 0.44, 0, 0.4, 0.85, darkMat);
    box(0.06, 0.7, 0.06, -0.28, 0.7, 0.36, chromeMat);
    box(0.06, 0.7, 0.06, 0.28, 0.7, 0.36, chromeMat);
    box(0.62, 0.06, 0.06, 0, 1.03, 0.36, chromeMat);
    cyl(0.02, 0.42, 0, 0.55, -0.35, chromeMat, "z");
    wheel(0.24, -0.6, 0.6, 0.22);
    wheel(0.24, 0.6, 0.6, 0.22);
    wheel(0.2, -0.52, -0.7, 0.16);
    wheel(0.2, 0.52, -0.7, 0.16);
  } else if (style === "bike") {
    wheel(0.34, 0, -0.72, 0.14);
    wheel(0.34, 0, 0.72, 0.16);
    box(0.14, 0.3, 1.4, 0, 0.5, 0, darkMat);
    box(0.3, 0.32, 0.44, 0, 0.44, -0.02, darkMat);
    box(0.3, 0.26, 0.55, 0, 0.72, -0.12);
    box(0.28, 0.12, 0.55, 0, 0.72, 0.42, darkMat);
    box(0.2, 0.08, 0.5, 0, 0.6, 0.6);
    cyl(0.03, 0.62, 0, 0.98, -0.5, chromeMat, "x");
    cyl(0.04, 0.62, 0, 0.7, -0.62, chromeMat, "z");
    cyl(0.12, 0.1, 0, 0.92, -0.66, headMat, "z");
    cyl(0.05, 0.7, 0.18, 0.42, 0.3, chromeMat, "z");
  } else {
    box(1.85, 0.5, 4.5, 0, 0.62, 0);
    box(1.62, 0.46, 2.05, 0, 1.06, 0.1, glassMat);
    box(1.66, 0.14, 2.1, 0, 1.32, 0.1);
    box(1.9, 0.2, 0.34, 0, 0.42, -2.18, chromeMat);
    box(1.9, 0.2, 0.34, 0, 0.42, 2.18, chromeMat);
    box(0.98, 0.2, 0.1, 0, 0.62, -2.28, darkMat);
    lights(-2.28, 0.72, 0.62, headMat, 0.34, 0.14);
    lights(2.28, 0.74, 0.62, tailMat, 0.34, 0.14);
    mirror(0.96, 1.04, -0.72);
    wheel(0.34, -0.86, -1.4);
    wheel(0.34, 0.86, -1.4);
    wheel(0.34, -0.86, 1.4);
    wheel(0.34, 0.86, 1.4);
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

  const frame = { center: new THREE.Vector3(0, 0.85, 0), radius: 2.4 };
  function reframe() {
    const bb = new THREE.Box3().setFromObject(car);
    if (bb.isEmpty()) return;
    bb.getCenter(frame.center);
    const size = new THREE.Vector3();
    bb.getSize(size);
    frame.radius = Math.max(size.x, size.y, size.z) * 0.5 || 2.4;
  }
  reframe();

  function rebuild() {
    while (car.children.length) {
      const child = car.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    car.add(...buildCarMesh(carSettings.style, carSettings.color).children);
    reframe();
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
    const r = frame.radius * 3.1;
    camera.position.set(
      frame.center.x + Math.sin(angle) * r,
      frame.center.y + frame.radius * 1.35,
      frame.center.z + Math.cos(angle) * r
    );
    camera.lookAt(frame.center);
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
