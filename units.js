const UNITS = {
  imperial: { speed: "mph", distance: "mi", speedFactor: 2.236936, distanceFactor: 1 / 1609.344, scale: "imperial" },
  metric: { speed: "km/h", distance: "km", speedFactor: 3.6, distanceFactor: 1 / 1000, scale: "metric" },
};

const settings = {
  units: localStorage.getItem("racer.units") === "metric" ? "metric" : "imperial",
};

const unitListeners = [];

function onUnitsChange(fn) {
  unitListeners.push(fn);
}

function activeUnits() {
  return UNITS[settings.units];
}

function setUnits(units) {
  if (!UNITS[units] || settings.units === units) return;
  settings.units = units;
  localStorage.setItem("racer.units", units);
  syncUnitsButtons();
  for (const fn of unitListeners) fn();
}

function speedText(metersPerSecond) {
  return String(Math.round(metersPerSecond * activeUnits().speedFactor));
}

function speedUnit() {
  return activeUnits().speed;
}

function distanceText(meters) {
  const value = meters * activeUnits().distanceFactor;
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ${activeUnits().distance}`;
}

function scaleUnit() {
  return activeUnits().scale;
}

function syncUnitsButtons() {
  document.querySelectorAll("[data-units]").forEach((el) => {
    el.classList.toggle("active", el.dataset.units === settings.units);
  });
}

document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-units]");
  if (button) setUnits(button.dataset.units);
});

window.addEventListener("DOMContentLoaded", syncUnitsButtons);
