function initFreeDrive() {
  const searchInput = document.getElementById("fd-search");
  const resultsEl = document.getElementById("fd-search-results");
  const startBtn = document.getElementById("fd-start");
  const locateBtn = document.getElementById("fd-locate");
  const statusEl = document.getElementById("fd-status");

  let pick = null;
  let searchTimer = null;
  let searchSeq = 0;

  function hideResults() {
    resultsEl.classList.add("hidden");
    resultsEl.innerHTML = "";
  }

  function showMessage(text) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = text;
    resultsEl.innerHTML = "";
    resultsEl.appendChild(div);
    resultsEl.classList.remove("hidden");
  }

  function resultLabel(props) {
    const parts = [];
    if (props.name) parts.push(props.name);
    const locality = props.city || props.district || props.county || props.state;
    if (locality && locality !== props.name) parts.push(locality);
    if (props.country && props.country !== props.name) parts.push(props.country);
    return [...new Set(parts)].join(", ") || "Unnamed place";
  }

  function setPick(lon, lat, label) {
    pick = { lon, lat };
    startBtn.disabled = false;
    statusEl.textContent = label ? `Start: ${label}` : "Start selected.";
  }

  function showResults(features) {
    if (!features.length) {
      showMessage("No matches.");
      return;
    }
    resultsEl.innerHTML = "";
    for (const feature of features) {
      const [lng, lat] = feature.geometry.coordinates;
      const label = resultLabel(feature.properties || {});
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        hideResults();
        searchInput.value = "";
        setPick(lng, lat, label);
      });
      resultsEl.appendChild(btn);
    }
    resultsEl.classList.remove("hidden");
  }

  async function runSearch(query) {
    const seq = ++searchSeq;
    try {
      const url = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("search service unavailable");
      const data = await res.json();
      if (seq !== searchSeq) return;
      showResults(data.features || []);
    } catch (err) {
      if (seq !== searchSeq) return;
      showMessage(err.message);
    }
  }

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (query.length < 3) {
      hideResults();
      return;
    }
    searchTimer = setTimeout(() => runSearch(query), 300);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideResults();
      searchInput.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query.length >= 2) {
        clearTimeout(searchTimer);
        runSearch(query);
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) hideResults();
  });

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      statusEl.textContent = "Location isn't available in this browser.";
      return;
    }
    locateBtn.disabled = true;
    statusEl.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        setPick(pos.coords.longitude, pos.coords.latitude, "your location");
      },
      () => {
        locateBtn.disabled = false;
        statusEl.textContent = "Couldn't get your location — search instead.";
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

  startBtn.addEventListener("click", () => {
    if (!pick) return;
    game.track = null;
    game.freeRoam = { lon: pick.lon, lat: pick.lat };
    openScreen("drive3d");
  });
}

registerScreen("free-drive", { enter: initFreeDrive });
