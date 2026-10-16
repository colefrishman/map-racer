const game = { track: null };
window.game = game;

const screens = new Map();

function registerScreen(id, hooks = {}) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Screen element #${id} not found`);
  screens.set(id, { el, started: false, instance: null, ...hooks });
}

function openScreen(id) {
  if (!screens.has(id)) id = "home";

  screens.forEach((screen, key) => {
    screen.el.classList.toggle("hidden", key !== id);
  });

  const screen = screens.get(id);
  if (typeof screen.enter === "function") {
    if (!screen.started) {
      screen.started = true;
      screen.instance = screen.enter();
    } else if (screen.instance && typeof screen.instance.resize === "function") {
      screen.instance.resize();
    }
  }

  if (location.hash !== `#${id}`) {
    history.replaceState(null, "", `#${id}`);
  }
}

document.querySelectorAll("[data-screen]").forEach((el) => {
  el.addEventListener("click", () => openScreen(el.dataset.screen));
});

window.addEventListener("hashchange", () => {
  openScreen(location.hash.slice(1));
});

window.addEventListener("DOMContentLoaded", () => {
  registerScreen("home");
  openScreen(location.hash.slice(1) || "home");
});
