(() => {
  const projectFolderName = "Spots";
  const directoryDbName = "dh-track-reader-project";
  const directoryStoreName = "handles";
  const directoryHandleKey = "project-directory";
  const manifestUrl = "Spots/index.json";
  const map = L.map("map", { zoomControl: true }).setView([46.5, 6.3], 8);

  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri"
  }).addTo(map);

  const spotLayer = L.layerGroup().addTo(map);
  let spots = [];
  let markers = new Map();
  let activeSpotId = null;
  let projectDirectoryHandle = null;
  let routeLine = null;

  function readSpots() {
    return [];
  }

  async function readProjectSpots() {
    if (!projectDirectoryHandle) return [];
    const found = [];
    try {
      const spotsDirectory = await projectDirectoryHandle.getDirectoryHandle(projectFolderName, { create: false });
      for await (const [name, handle] of spotsDirectory.entries()) {
        if (handle.kind !== "file" || !name.toLowerCase().endsWith(".json")) continue;
        try {
          const file = await handle.getFile();
          const saved = JSON.parse(await file.text());
          if (saved && typeof saved === "object" && !Array.isArray(saved)) found.push(saved);
        } catch {
          // Ignore malformed or inaccessible individual Spot files.
        }
      }
    } catch {
      return [];
    }
    return found;
  }

  function validSpots(saved) {
    const entries = Array.isArray(saved) ? saved : [saved];
    const unique = new Map();
    entries.filter((spot) =>
      spot && typeof spot.id === "string" && typeof spot.name === "string"
      && spot.start && Number.isFinite(spot.start.lat) && Number.isFinite(spot.start.lon)
      && spot.end && Number.isFinite(spot.end.lat) && Number.isFinite(spot.end.lon)
    ).forEach((spot) => unique.set(spot.id, spot));
    return [...unique.values()];
  }

  function persistLocalAndProject(nextSpots) {
    spots = nextSpots;
  }

  function openDirectoryDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB indisponible"));
        return;
      }
      const request = window.indexedDB.open(directoryDbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(directoryStoreName)) {
          request.result.createObjectStore(directoryStoreName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveDirectoryHandle(handle) {
    const database = await openDirectoryDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(directoryStoreName, "readwrite");
      transaction.objectStore(directoryStoreName).put(handle, directoryHandleKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function readDirectoryHandle() {
    try {
      const database = await openDirectoryDatabase();
      return await new Promise((resolve, reject) => {
        const request = database.transaction(directoryStoreName).objectStore(directoryStoreName).get(directoryHandleKey);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  }

  function spotFileName(spot) {
    const safeName = spot.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "spot";
    return `${safeName}.json`;
  }

  async function readManifestSpots() {
    try {
      const response = await fetch(manifestUrl, { cache: "no-store" });
      if (!response.ok) {
        console.warn(`Spot manifest unavailable: ${response.status} ${manifestUrl}`);
        return [];
      }
      const manifest = await response.json();
      if (!Array.isArray(manifest)) return [];
      const found = [];
      for (const entry of manifest) {
        const fileName = typeof entry === "string" ? entry : entry.file;
        if (!fileName || !fileName.toLowerCase().endsWith(".json")) continue;
        try {
          const spotResponse = await fetch(`Spots/${encodeURIComponent(fileName)}`, { cache: "no-store" });
          if (!spotResponse.ok) continue;
          const spot = await spotResponse.json();
          if (spot && typeof spot === "object" && !Array.isArray(spot)) found.push(spot);
        } catch {
          // Ignore missing or malformed manifest entries.
        }
      }
      return found;
    } catch {
      return [];
    }
  }

  async function writeProjectJson() {
    for (const spot of spots) {
      const blob = new Blob([JSON.stringify(spot, null, 2)], { type: "application/json" });
      if (projectDirectoryHandle) {
        try {
          const spotsDirectory = await projectDirectoryHandle.getDirectoryHandle(projectFolderName, { create: true });
          const fileHandle = await spotsDirectory.getFileHandle(spotFileName(spot), { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          await updateDirectoryManifest(spotsDirectory);
        } catch (error) {
          alert(`Impossible d'écrire ${spotFileName(spot)} : ${error.message}`);
        }
      } else {
        const download = document.createElement("a");
        download.href = URL.createObjectURL(blob);
        download.download = spotFileName(spot);
        download.click();
        URL.revokeObjectURL(download.href);
      }
    }
  }

  async function updateDirectoryManifest(spotsDirectory) {
    const fileNames = [];
    try {
      for await (const [name, handle] of spotsDirectory.entries()) {
        if (handle.kind === "file" && name.toLowerCase().endsWith(".json") && name !== "index.json") {
          fileNames.push(name);
        }
      }
      const manifestHandle = await spotsDirectory.getFileHandle("index.json", { create: true });
      const writable = await manifestHandle.createWritable();
      await writable.write(new Blob([JSON.stringify(fileNames, null, 2)], { type: "application/json" }));
      await writable.close();
    } catch {
      // The individual Spot files remain available even if index.json cannot be updated.
    }
  }

  function locationLabel(spot) {
    if (spot.location) return spot.location;
    const lat = spot.start.lat;
    const lon = spot.start.lon;
    return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "O"}`;
  }

  function difficultyLabel(spot) {
    return spot.difficulty || "Intermédiaire";
  }

  function surfaceLabel(spot) {
    return spot.surface || "Asphalte";
  }

  function sortSpots(spots, sortBy) {
    const copy = [...spots];
    const difficultyOrder = { "Facile": 1, "Intermédiaire": 2, "Difficile": 3 };
    copy.sort((a, b) => {
      if (sortBy === "difficulty") {
        return (difficultyOrder[difficultyLabel(a)] || 2) - (difficultyOrder[difficultyLabel(b)] || 2)
          || a.name.localeCompare(b.name, "fr");
      }
      if (sortBy === "location") return locationLabel(a).localeCompare(locationLabel(b), "fr");
      if (sortBy === "surface") return surfaceLabel(a).localeCompare(surfaceLabel(b), "fr");
      if (sortBy === "createdAt") return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
      return a.name.localeCompare(b.name, "fr");
    });
    return copy;
  }

  function markerIcon() {
    return L.divIcon({
      className: "",
      html: '<div class="spot-marker"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function renderMarkers() {
    spotLayer.clearLayers();
    markers = new Map();
    const showLabels = document.getElementById("show-spot-labels").checked;
    const bounds = [];

    spots.forEach((spot) => {
      const latLng = [spot.start.lat, spot.start.lon];
      const marker = L.marker(latLng, { icon: markerIcon(), title: spot.name }).addTo(spotLayer);
      if (showLabels) {
        marker.bindTooltip(spot.name, {
          permanent: true,
          direction: "top",
          offset: [0, -12],
          className: "spot-marker-label",
          opacity: 1
        });
      }
      marker.on("click", () => selectSpot(spot.id, true));
      markers.set(spot.id, marker);
      bounds.push(latLng);
    });

    if (bounds.length) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.25), { maxZoom: 15 });
    }
  }

  function selectSpot(id, panMap) {
    activeSpotId = id;
    document.querySelectorAll(".spot-list-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.spotId === id);
    });
    const spot = spots.find((item) => item.id === id);
    if (!spot) return;

    if (routeLine) map.removeLayer(routeLine);
    const routeCoordinates = Array.isArray(spot.route) && spot.route.length
      ? spot.route.map((point) => [point.lat, point.lon])
      : [[spot.start.lat, spot.start.lon], [spot.end.lat, spot.end.lon]];
    routeLine = L.polyline(routeCoordinates, {
      color: "#ffffff",
      weight: 4,
      opacity: 0.95
    }).addTo(map);

    const info = document.getElementById("spot-info");
    document.getElementById("spot-info-name").textContent = spot.name;
    document.getElementById("spot-info-distance").textContent =
      Number.isFinite(spot.distanceMeters) ? `${(spot.distanceMeters / 1000).toFixed(2)} km` : "—";
    document.getElementById("spot-info-grade").textContent =
      Number.isFinite(spot.averageGradePercent) ? `${spot.averageGradePercent.toFixed(1)} %` : "—";
    document.getElementById("spot-info-turns").textContent =
      Number.isFinite(spot.turnCount) ? String(spot.turnCount) : "0";
    document.getElementById("spot-info-speed").textContent =
      Number.isFinite(spot.topSpeedKmh) ? `${spot.topSpeedKmh.toFixed(1)} km/h` : "—";
    info.hidden = false;

    if (panMap) {
      map.fitBounds(L.latLngBounds([
        [spot.start.lat, spot.start.lon],
        [spot.end.lat, spot.end.lon]
      ]).pad(0.35), { maxZoom: 15 });
      markers.get(id)?.openTooltip();
    }
  }

  function renderList() {
    const list = document.getElementById("spot-list");
    const query = document.getElementById("spot-search").value.trim().toLocaleLowerCase("fr");
    const sortBy = document.getElementById("spot-sort").value;
    const filtered = sortSpots(spots, sortBy).filter((spot) =>
      `${spot.name} ${locationLabel(spot)} ${difficultyLabel(spot)} ${surfaceLabel(spot)}`
        .toLocaleLowerCase("fr").includes(query));

    list.replaceChildren();
    filtered.forEach((spot) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "spot-list-item";
      item.dataset.spotId = spot.id;
      if (spot.id === activeSpotId) item.classList.add("active");

      const icon = document.createElement("span");
      icon.className = "spot-list-icon";
      icon.textContent = "◆";
      const copy = document.createElement("span");
      copy.className = "spot-list-copy";
      const name = document.createElement("strong");
      name.textContent = spot.name;
      const meta = document.createElement("span");
      meta.textContent = `${locationLabel(spot)} · ${surfaceLabel(spot)}`;
      copy.append(name, meta);
      const difficulty = document.createElement("span");
      difficulty.className = "spot-difficulty";
      difficulty.textContent = difficultyLabel(spot);

      item.append(icon, copy, difficulty);
      item.addEventListener("click", () => selectSpot(spot.id, true));
      list.append(item);
    });
  }

  function setMenuVisibility(visible) {
    document.getElementById("top-menu").hidden = !visible;
    document.getElementById("show-menu").hidden = visible;
    document.getElementById("hide-menu").setAttribute("aria-expanded", String(visible));
    document.getElementById("show-menu").setAttribute("aria-expanded", String(!visible));
    requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  }

  document.getElementById("hide-menu").addEventListener("click", () => setMenuVisibility(false));
  document.getElementById("show-menu").addEventListener("click", () => setMenuVisibility(true));
  document.getElementById("spot-search").addEventListener("input", renderList);
  document.getElementById("spot-sort").addEventListener("change", renderList);
  document.getElementById("show-spot-labels").addEventListener("change", renderMarkers);
  document.getElementById("close-spot-info").addEventListener("click", () => {
    document.getElementById("spot-info").hidden = true;
    if (routeLine) map.removeLayer(routeLine);
  });
  document.getElementById("import-spots").addEventListener("click", () => {
    document.getElementById("import-spots-file").click();
  });
  document.getElementById("import-spots-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const imported = validSpots(JSON.parse(await file.text()));
      persistLocalAndProject([...spots, ...imported]);
      await writeProjectJson();
      refreshPage();
    } catch (error) {
      alert(`Impossible d'importer ce fichier : ${error.message}`);
    } finally {
      event.target.value = "";
    }
  });
  document.getElementById("export-spots").addEventListener("click", writeProjectJson);
  document.getElementById("choose-folder").addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      alert("Ce navigateur ne permet pas de sélectionner directement un dossier. Le bouton Exporter téléchargera chaque Spot séparément.");
      return;
    }
    try {
      projectDirectoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      await saveDirectoryHandle(projectDirectoryHandle);
      await writeProjectJson();
      alert(`Dossier choisi. Chaque Spot sera enregistré comme fichier JSON individuel dans ${projectFolderName}.`);
    } catch (error) {
      if (error.name !== "AbortError") alert(`Impossible d'utiliser ce dossier : ${error.message}`);
    }
  });

  function refreshPage() {
    document.getElementById("spot-count").textContent = String(spots.length);
    document.getElementById("spot-empty").style.display = spots.length ? "none" : "grid";
    renderMarkers();
    renderList();
  }

  async function initialize() {
    projectDirectoryHandle = await readDirectoryHandle();
    if (projectDirectoryHandle && projectDirectoryHandle.queryPermission) {
      const permission = await projectDirectoryHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") projectDirectoryHandle = null;
    }

    if (location.protocol === "file:" && !projectDirectoryHandle) {
      const empty = document.getElementById("spot-empty");
      empty.querySelector("strong").textContent = "Chargement automatique bloqué";
      empty.querySelector("span").textContent =
        "Ouvrez cette page depuis un serveur HTTP ou choisissez « Dossier Spots ».";
    }

    const projectSpots = validSpots([
      ...await readManifestSpots(),
      ...await readProjectSpots()
    ]);
    persistLocalAndProject(projectSpots);
    refreshPage();
  }

  initialize();
})();
