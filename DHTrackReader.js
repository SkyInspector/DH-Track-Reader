(() => {
  const $ = (id) => document.getElementById(id);
  const map = L.map("map", { zoomControl: true, rotate: true, rotateControl: false }).setView([46.5, 6.3], 8);
  const trackRenderer = L.canvas({ padding: 0.5 });
  const segmentSensitivity = 5;
  const imagery = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri"
  });
  const streets = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; OpenStreetMap contributors, and the GIS User Community"
  });
  streets.on("tileerror", (event) => {
    event.tile.style.display = "none";
    $("map").classList.add("tiles-blocked");
    showNotice("Le fond cartographique routier est inaccessible depuis ce réseau. Le tracé reste visible.", true);
  });
  streets.on("tileload", () => {
    $("map").classList.remove("tiles-blocked");
    clearNotice();
  });
  imagery.addTo(map);
  const layer = L.layerGroup().addTo(map);
  const speedMarkerLayer = L.layerGroup().addTo(map);
  const slidingLayer = L.layerGroup().addTo(map);
  const airbrakeLayer = L.layerGroup().addTo(map);
  const spotStorageKey = "dh-track-reader.spots.v1";
  const spotMatchRadiusMeters = 1500;
  let records = [];
  let rawRows = [];
  let spots = [];
  let activeSelection = null;
  let spotMatches = [];
  let viewMode = "csv";
  let chronoSpotId = null;
  let chronoViewNeedsFit = false;
  let spotStorageError = null;
  let hoverMapPoints = [];
  let hoverPixelPoints = [];
  let hoverSpeedTooltip = null;
  let chartPoints = [];
  let chartDisplaySpeeds = [];
  let chartRange = null;
  let chartView = null;
  let chartPan = null;
  let followRider = false;
  let followTargetElapsed = null;
  let followPanInProgress = false;
  let hoverPixelsDirty = false;
  let compassDrag = null;
  let trimStartIndex = 0;
  let trimEndIndex = 0;
  let selectedPointIndex = null;
  const hoverRouteDot = document.createElement("div");
  hoverRouteDot.className = "hover-route-point";
  map.getContainer().appendChild(hoverRouteDot);
  const mapTools = L.control({ position: "topright" });
  mapTools.onAdd = () => {
    const container = L.DomUtil.create("div", "leaflet-control map-tools");
    const compass = L.DomUtil.create("button", "map-tool-button map-compass", container);
    compass.type = "button";
    compass.title = "Glisser pour orienter la carte; cliquer pour remettre le nord en haut";
    compass.setAttribute("aria-label", compass.title);
    compass.innerHTML = '<span class="map-compass-north">N</span><span class="map-compass-needle" aria-hidden="true">▲</span>';
    const follow = L.DomUtil.create("button", "map-tool-button map-follow", container);
    follow.type = "button";
    follow.title = "Suivre le rider";
    follow.setAttribute("aria-label", follow.title);
    follow.setAttribute("aria-pressed", "false");
    follow.innerHTML = '<span class="map-follow-icon" aria-hidden="true">⌖</span><span>Suivre le rider</span>';
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    const needle = compass.querySelector(".map-compass-needle");
    const updateCompass = () => {
      needle.style.transform = `rotate(${map.getBearing()}deg)`;
    };
    map.on("rotate", updateCompass);
    compass.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      compassDrag = { pointerId: event.pointerId, startX: event.clientX, startBearing: map.getBearing(), moved: false };
      compass.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    compass.addEventListener("pointermove", (event) => {
      if (!compassDrag || compassDrag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - compassDrag.startX;
      if (Math.abs(deltaX) > 2) compassDrag.moved = true;
      map.setBearing(compassDrag.startBearing + deltaX);
    });
    compass.addEventListener("pointerup", (event) => {
      if (!compassDrag || compassDrag.pointerId !== event.pointerId) return;
      const moved = compassDrag.moved;
      compassDrag = null;
      if (!moved) map.setBearing(0);
    });
    compass.addEventListener("pointercancel", () => { compassDrag = null; });
    follow.addEventListener("click", () => {
      followRider = !followRider;
      follow.classList.toggle("active", followRider);
      follow.setAttribute("aria-pressed", String(followRider));
      follow.title = followRider ? "Désactiver le suivi du rider" : "Suivre le rider";
      follow.setAttribute("aria-label", follow.title);
      if (followRider && selectedPointIndex !== null) {
        followTargetElapsed = chartPoints[selectedPointIndex].elapsed;
        updateFollowRider();
      }
    });
    return container;
  };
  mapTools.addTo(map);

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function interpolateColor(start, end, factor) {
    const channel = (a, b) => Math.round(a + (b - a) * factor);
    return `rgb(${channel(start[0], end[0])}, ${channel(start[1], end[1])}, ${channel(start[2], end[2])})`;
  }

  function speedToColor(speed, minThreshold, maxThreshold) {
    const range = maxThreshold - minThreshold;
    if (!Number.isFinite(speed) || range <= 0) return "#39ff88";
    const ratio = clamp((speed - minThreshold) / range, 0, 1);
    const green = [0, 255, 120];
    const yellow = [255, 220, 0];
    const orange = [255, 136, 0];
    const red = [255, 35, 80];
    if (ratio <= 0.33) return interpolateColor(green, yellow, ratio / 0.33);
    if (ratio <= 0.66) return interpolateColor(yellow, orange, (ratio - 0.33) / 0.33);
    return interpolateColor(orange, red, (ratio - 0.66) / 0.34);
  }

  function syncColorLimits() {
    const minInput = $("color-min-speed");
    const maxInput = $("color-max-speed");
    let minValue = Number(minInput.value);
    let maxValue = Number(maxInput.value);

    if (minValue >= maxValue) {
      if (document.activeElement === minInput) {
        maxValue = minValue + 1;
        maxInput.value = maxValue;
      } else {
        minValue = maxValue - 1;
        minInput.value = minValue;
      }
    }

    $("color-min-speed-value").textContent = `${minValue.toFixed(0)} km/h`;
  }

  function setColorDefaultsForSession() {
    const topSpeed = records.reduce((maximum, row) => Math.max(maximum, row.speed), 0);
    const minInput = $("color-min-speed");
    const maxInput = $("color-max-speed");
    maxInput.max = String(Math.max(200, topSpeed));
    maxInput.value = topSpeed.toFixed(2);
    minInput.value = String(Math.min(30, Math.max(0, topSpeed - 0.01)));
    syncColorLimits();
  }

  function showNotice(message, error = false) {
    const notice = $("notice");
    notice.textContent = message;
    notice.className = `notice${error ? " error" : ""}`;
    notice.style.display = "block";
  }

  function clearNotice() {
    $("notice").style.display = "none";
  }

  function isValidCoordinate(point) {
    return point && Number.isFinite(point.lat) && Number.isFinite(point.lon);
  }

  function readSavedSpots() {
    let serialized;
    try {
      serialized = window.localStorage.getItem(spotStorageKey);
    } catch (error) {
      spotStorageError = `Impossible d’accéder aux Spots enregistrés dans ce navigateur : ${error.message}`;
      showNotice(spotStorageError, true);
      return [];
    }
    if (!serialized) return [];

    try {
      const saved = JSON.parse(serialized);
      const valid = Array.isArray(saved) && saved.every((spot) =>
        spot && typeof spot.id === "string" && typeof spot.name === "string"
        && isValidCoordinate(spot.start) && isValidCoordinate(spot.end)
        && Array.isArray(spot.runs) && spot.runs.every((run) =>
          run && typeof run.key === "string" && typeof run.fileLabel === "string"
          && Number.isFinite(run.seconds) && typeof run.savedAt === "string"));
      if (!valid) throw new Error("format de données invalide");
      spotStorageError = null;
      return saved;
    } catch (error) {
      spotStorageError = `Impossible de lire les Spots enregistrés : ${error.message}`;
      showNotice(spotStorageError, true);
      return [];
    }
  }

  function persistSpots(nextSpots) {
    try {
      window.localStorage.setItem(spotStorageKey, JSON.stringify(nextSpots));
      spots = nextSpots;
      spotStorageError = null;
      return true;
    } catch (error) {
      spotStorageError = `Impossible d’enregistrer le Spot dans ce navigateur : ${error.message}`;
      showNotice(spotStorageError, true);
      return false;
    }
  }

  function findSpotSegment(spot) {
    let nearestStart = null;
    let bestSegment = null;
    records.forEach((point, index) => {
      const startDistance = distanceMeters(point, spot.start);
      if (startDistance <= spotMatchRadiusMeters
        && (!nearestStart || startDistance < nearestStart.distance)) {
        nearestStart = { index, distance: startDistance };
      }

      if (!nearestStart || index <= nearestStart.index) return;
      const endDistance = distanceMeters(point, spot.end);
      if (endDistance > spotMatchRadiusMeters) return;
      const totalDistance = nearestStart.distance + endDistance;
      if (!bestSegment || totalDistance < bestSegment.totalDistance) {
        bestSegment = {
          spot,
          startIndex: nearestStart.index,
          endIndex: index,
          startDistance: nearestStart.distance,
          endDistance,
          totalDistance
        };
      }
    });
    return bestSegment;
  }

  function recomputeSpotMatches() {
    spotMatches = records.length
      ? spots.map(findSpotSegment).filter(Boolean).sort((a, b) => a.totalDistance - b.totalDistance)
      : [];
  }

  function renderSpotDetails(panel, match) {
    const header = document.createElement("div");
    header.className = "spot-panel-header";
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "spot-back-button";
    backButton.textContent = "←";
    backButton.setAttribute("aria-label", "Retour aux Spots et quitter la vue Chrono");
    backButton.addEventListener("click", selectCsvView);
    const heading = document.createElement("h2");
    heading.textContent = match.spot.name;
    header.append(backButton, heading);

    const descriptionLabel = document.createElement("strong");
    descriptionLabel.className = "spot-detail-label";
    descriptionLabel.textContent = "Description";
    const description = document.createElement("p");
    description.className = "spot-detail-description";
    description.textContent = "Une descente fluide avec quelques virages prononcés, idéale pour une belle session.";

    const details = document.createElement("div");
    details.className = "spot-detail-grid";
    [
      ["Type", "Descente"],
      ["Difficulté", "Intermédiaire"],
      ["Revêtement", "Asphalte"],
      ["Départ détecté", `${Math.round(match.startDistance)} m`],
      ["Arrivée détectée", `${Math.round(match.endDistance)} m`]
    ].forEach(([label, value]) => {
      const item = document.createElement("div");
      item.className = "spot-detail-item";
      const itemLabel = document.createElement("span");
      itemLabel.textContent = label;
      const itemValue = document.createElement("strong");
      itemValue.textContent = value;
      item.append(itemLabel, itemValue);
      details.append(item);
    });

    const note = document.createElement("p");
    note.className = "spot-detail-note";
    note.textContent = "Les informations du Spot seront complétées ultérieurement.";
    panel.append(header, descriptionLabel, description, details, note);
  }

  function renderSpotPanel() {
    const panel = $("spot-panel");
    panel.replaceChildren();
    if (!spotMatches.length) {
      panel.hidden = true;
      return;
    }

    const selectedMatch = viewMode === "chrono"
      ? spotMatches.find((match) => match.spot.id === chronoSpotId)
      : null;
    if (selectedMatch) {
      renderSpotDetails(panel, selectedMatch);
      panel.hidden = false;
      return;
    }

    const heading = document.createElement("h2");
    heading.textContent = "Spots reconnus";
    const choices = document.createElement("div");
    choices.className = "spot-choices";
    spotMatches.forEach((match) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "spot-choice";
      if (viewMode === "chrono" && chronoSpotId === match.spot.id) button.classList.add("active");
      const name = document.createElement("strong");
      name.textContent = match.spot.name;
      const distance = document.createElement("span");
      const current = viewMode === "chrono" && chronoSpotId === match.spot.id;
      distance.textContent = `${current ? "Vue Chrono active · " : "Vue Chrono · "}départ ${Math.round(match.startDistance)} m · arrivée ${Math.round(match.endDistance)} m`;
      button.append(name, distance);
      button.addEventListener("click", () => selectChronoView(match));
      choices.append(button);
    });
    panel.append(heading, choices);
    panel.hidden = false;
  }

  function selectChronoView(match) {
    viewMode = "chrono";
    chronoSpotId = match.spot.id;
    trimStartIndex = match.startIndex;
    trimEndIndex = match.endIndex;
    chartView = null;
    chronoViewNeedsFit = true;
    updateView();
  }

  function selectCsvView() {
    viewMode = "csv";
    chronoSpotId = null;
    trimStartIndex = 0;
    trimEndIndex = records.length - 1;
    chartView = null;
    chronoViewNeedsFit = false;
    updateView();
  }

  function createSpotId() {
    return `spot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function saveCurrentSpot(name) {
    if (!activeSelection) return false;
    const spot = {
      id: createSpotId(),
      name,
      start: activeSelection.start,
      end: activeSelection.end,
      createdAt: new Date().toISOString(),
      runs: []
    };
    if (!persistSpots([...spots, spot])) return false;
    recomputeSpotMatches();
    renderSpotPanel();
    return true;
  }

  function parseCsvRow(line) {
    const values = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          value += '"';
          index++;
        } else {
          quoted = !quoted;
        }
      } else if (character === "," && !quoted) {
        values.push(value.trim());
        value = "";
      } else {
        value += character;
      }
    }
    values.push(value.trim());
    return values;
  }

  function parseFile(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const csvHeaderIndex = lines.findIndex((line) => /^\s*Record\s*,\s*Time\s*,\s*Latitude\s*,\s*Longitude\s*,\s*Altitude\s*,\s*Speed\s*,/i.test(line));
    if (csvHeaderIndex >= 0) {
      const headers = parseCsvRow(lines[csvHeaderIndex]).map((header) => header.toLowerCase());
      const column = (name) => headers.indexOf(name.toLowerCase());
      const requiredColumns = ["time", "latitude", "longitude", "altitude", "speed", "gyrox", "gyroy", "gyroz"];
      if (requiredColumns.some((name) => column(name) < 0)) {
        throw new Error("Le CSV RaceBox doit contenir l'heure, les données GPS, la vitesse et les trois axes GyroX/Y/Z.");
      }
      rawRows = lines.slice(csvHeaderIndex + 1).map(parseCsvRow)
        .filter((values) => values.length >= headers.length)
        .map((values, index) => {
          const numberAt = (name) => {
            const value = Number(values[column(name)]);
            return Number.isFinite(value) ? value : null;
          };
          return {
            index,
            record: numberAt("record"),
            time: values[column("time")],
            latitude: numberAt("latitude"),
            longitude: numberAt("longitude"),
            altitude: numberAt("altitude"),
            speed: numberAt("speed"),
            gForceX: numberAt("gforcex"),
            gForceY: numberAt("gforcey"),
            gForceZ: numberAt("gforcez"),
            lap: numberAt("lap"),
            gyroX: numberAt("gyrox"),
            gyroY: numberAt("gyroy"),
            gyroZ: numberAt("gyroz")
          };
        })
        .filter((row) => row.time && row.latitude !== null && row.longitude !== null
          && row.altitude !== null && row.speed !== null && Number.isFinite(Date.parse(row.time)))
        .map((row, index) => ({ ...row, index }));

      if (rawRows.length < 2) throw new Error("Le CSV RaceBox ne contient pas assez de mesures GPS exploitables.");
      records = calculateGrades(rawRows.map((row) => ({
        ...row,
        lat: row.latitude,
        lon: row.longitude
      })));
      trimStartIndex = 0;
      trimEndIndex = records.length - 1;
      chartView = null;
      selectedPointIndex = null;
      viewMode = "csv";
      chronoSpotId = null;
      chronoViewNeedsFit = false;
      const invalid = records.filter((row) => Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180);
      if (invalid.length) throw new Error("Les coordonnées GPS du CSV ne sont pas valides.");
      return;
    }

    const dataIndex = lines.findIndex((line) => /^\s*\[data\]\s*$/i.test(line));
    if (dataIndex < 0) throw new Error("En-tête CSV RaceBox introuvable. Vérifiez le format du fichier .csv.");

    rawRows = lines.slice(dataIndex + 1).map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 7 && parts.slice(1, 7).every((part) => Number.isFinite(Number(part))))
      .map((parts, index) => ({
        index,
        time: parts[1],
        latitude: Number(parts[2]),
        longitude: Number(parts[3]),
        speed: Number(parts[4]),
        heading: Number(parts[5]),
        altitude: Number(parts[6])
      }));

    if (rawRows.length < 2) throw new Error("Le fichier ne contient pas assez de mesures GPS exploitables.");
    const coordinateFormat = detectCoordinateFormat(rawRows);
    records = calculateGrades(rawRows.map((row) => ({
      ...row,
      lat: toDegrees(row.latitude, coordinateFormat, true),
      lon: toDegrees(row.longitude, coordinateFormat, false)
    })));
    trimStartIndex = 0;
    trimEndIndex = records.length - 1;
    chartView = null;
    selectedPointIndex = null;
    viewMode = "csv";
    chronoSpotId = null;
    chronoViewNeedsFit = false;
    const invalid = records.filter((row) => Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180);
    if (invalid.length) throw new Error("Les coordonnées ne correspondent pas à un format GPS reconnu.");
  }

  function detectCoordinateFormat(rows) {
    const lat = rows.map((row) => Math.abs(row.latitude)).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const lon = rows.map((row) => Math.abs(row.longitude)).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    if (lat <= 90 && lon <= 180) return { type: "decimal", label: "degrés décimaux" };
    const ddmIsValid = (value) => {
      const abs = Math.abs(value);
      return Math.floor(abs / 100) <= 90 && abs - Math.floor(abs / 100) * 100 < 60;
    };
    if (ddmIsValid(lat) && ddmIsValid(lon)) return { type: "ddm", label: "degrés/minutes" };
    return { type: "minutes", label: "minutes totales" };
  }

  function toDegrees(value, format, isLatitude) {
    const sign = Math.sign(value) || 1;
    const abs = Math.abs(value);
    if (format.type === "decimal") return value;
    if (format.type === "minutes") return sign * abs / 60;
    const degrees = Math.floor(abs / 100);
    const minutes = abs - degrees * 100;
    const result = degrees + minutes / 60;
    if ((isLatitude && result > 90) || (!isLatitude && result > 180)) throw new Error("Coordonnées degrés/minutes hors limites.");
    return sign * result;
  }

  function distanceMeters(a, b) {
    const radians = (value) => value * Math.PI / 180;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  function calculateGrades(points) {
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      const isMoving = points[i].speed >= 5 && points[i - 1].speed >= 5;
      distances.push(distances[i - 1] + (isMoving ? distanceMeters(points[i - 1], points[i]) : 0));
    }
    const movingIndices = points.map((point, index) => point.speed >= 5 ? index : -1).filter((index) => index >= 0);
    const movingDistances = movingIndices.map((index) => distances[index]);

    const lowerBound = (value) => {
      let low = 0;
      let high = movingDistances.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (movingDistances[middle] < value) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const upperBound = (value) => {
      let low = 0;
      let high = movingDistances.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (movingDistances[middle] <= value) low = middle + 1;
        else high = middle;
      }
      return low;
    };

    return points.map((point, index) => {
      if (point.speed < 5) return { ...point, gradePercent: null };
      const center = distances[index];
      const start = lowerBound(center - 5);
      const end = upperBound(center + 5);
      const count = end - start;
      if (count < 3) return { ...point, gradePercent: null };

      let sumX = 0;
      let sumY = 0;
      let sumXX = 0;
      let sumXY = 0;
      for (let i = start; i < end; i++) {
        const pointIndex = movingIndices[i];
        const x = movingDistances[i] - center;
        const y = points[pointIndex].altitude;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumXY += x * y;
      }
      const denominator = count * sumXX - sumX * sumX;
      if (denominator <= 0) return { ...point, gradePercent: null };
      const slope = (count * sumXY - sumX * sumY) / denominator;
      return { ...point, gradePercent: slope * 100 };
    });
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const remainder = total % 60;
    return hours ? `${hours} h ${String(minutes).padStart(2, "0")} min` : `${minutes} min ${String(remainder).padStart(2, "0")} s`;
  }

  function positionChartCursor(index) {
    if (!chartPoints.length || !chartRange) return;
    const point = chartPoints[index];
    const x = chartRange.left + ((point.elapsed - chartRange.viewStart) / chartRange.viewDuration) * chartRange.width;
    const speed = chartDisplaySpeeds[index] ?? point.speed;
    const y = chartRange.bottom - (speed / chartRange.maxSpeed) * chartRange.height;
    $("chart-cursor").setAttribute("x1", x);
    $("chart-cursor").setAttribute("x2", x);
    $("chart-point").setAttribute("cx", x);
    $("chart-point").setAttribute("cy", y);
  }

  function smoothChartSpeeds(points, windowSeconds) {
    const halfWindow = windowSeconds / 2;
    const smoothed = new Array(points.length);
    let start = 0;
    let end = 0;
    let sum = 0;

    for (let index = 0; index < points.length; index++) {
      const windowStart = points[index].elapsed - halfWindow;
      const windowEnd = points[index].elapsed + halfWindow;
      while (start < points.length && points[start].elapsed < windowStart) {
        sum -= points[start].speed;
        start++;
      }
      if (end < start) end = start;
      while (end < points.length && points[end].elapsed <= windowEnd) {
        sum += points[end].speed;
        end++;
      }
      smoothed[index] = sum / Math.max(1, end - start);
    }
    return smoothed;
  }

  function chartIndexAtPointer(event) {
    const targetTime = chartTimeAtPointer(event);
    let low = 0;
    let high = chartPoints.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (chartPoints[middle].elapsed < targetTime) low = middle + 1;
      else high = middle;
    }
    const previous = Math.max(0, low - 1);
    return targetTime - chartPoints[previous].elapsed <= chartPoints[low].elapsed - targetTime ? previous : low;
  }

  function chartTimeAtPointer(event) {
    const bounds = $("speed-chart").getBoundingClientRect();
    const relativeX = (event.clientX - bounds.left) / bounds.width * 1000;
    const fraction = clamp((relativeX - chartRange.left) / chartRange.width, 0, 1);
    return chartRange.viewStart + fraction * chartRange.viewDuration;
  }

  function interpolateRiderAtTime(targetTime) {
    let low = 0;
    let high = chartPoints.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (chartPoints[middle].elapsed < targetTime) low = middle + 1;
      else high = middle;
    }
    const end = Math.min(low, chartPoints.length - 1);
    const start = Math.max(0, end - 1);
    const first = chartPoints[start];
    const second = chartPoints[end];
    const span = second.elapsed - first.elapsed;
    const ratio = span > 0 ? clamp((targetTime - first.elapsed) / span, 0, 1) : 0;
    return {
      lat: first.lat + (second.lat - first.lat) * ratio,
      mapLon: first.mapLon + (second.mapLon - first.mapLon) * ratio,
      speed: first.speed + (second.speed - first.speed) * ratio
    };
  }

  function selectChartPoint(index, reveal = true) {
    if (!chartPoints.length || !chartRange) return;
    index = clamp(index, trimStartIndex, trimEndIndex);
    selectedPointIndex = index;
    let point = chartPoints[index];
    followTargetElapsed = point.elapsed;
    if (reveal && (point.elapsed < chartRange.viewStart || point.elapsed > chartRange.viewEnd)) {
      const viewDuration = chartRange.viewDuration;
      const start = clamp(point.elapsed - viewDuration / 2,
        viewMode === "chrono" ? chartPoints[trimStartIndex].elapsed : 0,
        (viewMode === "chrono" ? chartPoints[trimEndIndex].elapsed : chartRange.duration) - viewDuration);
      chartView = { start, end: start + viewDuration };
      renderSpeedChart(chartPoints, false);
      point = chartPoints[index];
    }
    positionChartCursor(index);
    $("current-speed").innerHTML = `${point.speed.toFixed(1)} <small>km/h</small>`;
    $("current-altitude").innerHTML = `${point.altitude.toFixed(0)} <small>m</small>`;
    $("current-grade").innerHTML = Number.isFinite(point.gradePercent)
      ? `${point.gradePercent >= 0 ? "+" : ""}${point.gradePercent.toFixed(1)} <small>%</small>`
      : "—";
      $("current-gyro").innerHTML = Number.isFinite(point.gyroX)
        ? `${point.gyroX.toFixed(0)} / ${point.gyroY.toFixed(0)} / ${point.gyroZ.toFixed(0)} <small>°/s</small>`
        : "—";
      $("current-gforce").innerHTML = Number.isFinite(point.gForceX)
        ? `${point.gForceX.toFixed(2)} / ${point.gForceY.toFixed(2)} / ${point.gForceZ.toFixed(2)} <small>g</small>`
        : "—";
    $("chart-time").textContent = formatDuration(viewMode === "chrono"
      ? point.elapsed - chartPoints[trimStartIndex].elapsed
      : point.elapsed);
    showMapPoint(index);
  }

  function renderSpeedChart(points, restoreCursor = true) {
    const previousSelection = selectedPointIndex;
    const clock = points.map((point) => parseClockSeconds(point.time));
    let elapsed = 0;
    chartPoints = points.map((point, index) => {
      if (index > 0) {
        let interval = clock[index] - clock[index - 1];
        if (interval < 0) interval += 86400;
        elapsed += Number.isFinite(interval) && interval >= 0 ? interval : 1;
      }
      return { ...point, elapsed };
    });
    const duration = chartPoints[chartPoints.length - 1].elapsed || Math.max(1, chartPoints.length - 1);
    if (chartPoints[chartPoints.length - 1].elapsed === 0) {
      chartPoints.forEach((point, index) => { point.elapsed = index; });
    }
    const fullDuration = chartPoints[chartPoints.length - 1].elapsed || duration;
    const chronoStart = viewMode === "chrono" ? chartPoints[trimStartIndex].elapsed : 0;
    const chronoEnd = viewMode === "chrono" ? chartPoints[trimEndIndex].elapsed : fullDuration;
    if (viewMode === "chrono" && chronoViewNeedsFit) {
      chartView = { start: chronoStart, end: chronoEnd };
      chronoViewNeedsFit = false;
    }
    if (!chartView) chartView = { start: 0, end: fullDuration };
    const minViewDuration = viewMode === "chrono"
      ? Math.min(fullDuration, Math.max(0.01, Math.min(1, chronoEnd - chronoStart)))
      : Math.min(fullDuration, 1);
    const viewDuration = clamp(chartView.end - chartView.start, minViewDuration, fullDuration);
    const viewStart = clamp(chartView.start, viewMode === "chrono" ? chronoStart : 0,
      (viewMode === "chrono" ? chronoEnd : fullDuration) - viewDuration);
    const viewEnd = viewStart + viewDuration;
    const axisStart = viewMode === "chrono" ? viewStart - chronoStart : viewStart;
    const axisEnd = viewMode === "chrono" ? viewEnd - chronoStart : viewEnd;
    chartView = { start: viewStart, end: viewEnd };
    const maxSpeed = Math.max(10, Math.ceil(points.reduce((maximum, point) => Math.max(maximum, point.speed), 0) / 10) * 10);
    const left = 48;
    const right = 990;
    const top = 10;
    const bottom = 158;
    const width = right - left;
    const height = bottom - top;
    chartRange = { left, bottom, width, height, duration: fullDuration, viewStart, viewEnd, viewDuration, maxSpeed };
    chartDisplaySpeeds = points.map((point) => point.speed);
    if ($("smooth-chart").checked) {
      chartDisplaySpeeds = smoothChartSpeeds(chartPoints, Number($("smoothing-strength").value));
    }
    const coordinates = chartPoints.map((point, index) => ({
      x: left + ((point.elapsed - viewStart) / viewDuration) * width,
      y: bottom - (chartDisplaySpeeds[index] / maxSpeed) * height
    }));
    const pathFor = (pathPoints) => pathPoints.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    const path = pathFor(coordinates);
    const selectedPath = pathFor(coordinates.slice(trimStartIndex, trimEndIndex + 1));
    const brakingModes = findBrakingModes(points);
    const weakBraking = brakingModes.filter((zone) => zone.mode === "weak");
    const strongBraking = brakingModes.filter((zone) => zone.mode === "strong");
    const brakingPath = (zones) => zones.map((zone) => {
      const start = Math.max(zone.start, trimStartIndex);
      const end = Math.min(zone.end, trimEndIndex);
      return end > start ? pathFor(coordinates.slice(start, end + 1)) : "";
    }).filter(Boolean).join(" ");
    const yTicks = 4;
    const grid = Array.from({ length: yTicks + 1 }, (_, index) => {
      const value = maxSpeed * (yTicks - index) / yTicks;
      const y = top + height * index / yTicks;
      return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${right}" y2="${y}"></line><text x="${left - 8}" y="${y + 4}" text-anchor="end">${value.toFixed(0)}</text>`;
    }).join("");
    const firstPoint = coordinates[0];
    const startX = coordinates[trimStartIndex].x;
    const endX = coordinates[trimEndIndex].x;
    const visibleStartX = clamp(startX, left, right);
    const visibleEndX = clamp(endX, left, right);
    const bracket = (x) => `M${x - 5},${top}H${x + 5}M${x},${top}V${bottom}M${x - 5},${bottom}H${x + 5}`;
    const trimControls = viewMode === "chrono" ? "" : `<rect class="chart-trim-hit" data-trim-handle="start" x="${clamp(startX, left, right) - 9}" y="${top}" width="18" height="${height}" style="${startX < left || startX > right ? "display:none" : ""}"></rect><rect class="chart-trim-hit" data-trim-handle="end" x="${clamp(endX, left, right) - 9}" y="${top}" width="18" height="${height}" style="${endX < left || endX > right ? "display:none" : ""}"></rect><path class="chart-trim-bracket" d="${bracket(visibleStartX)} ${bracket(visibleEndX)}"></path>`;
    const svg = $("speed-chart");
    svg.innerHTML = `${grid}<text x="${left}" y="182">${formatDuration(axisStart)}</text><text x="${right}" y="182" text-anchor="end">${formatDuration(axisEnd)}</text><defs><clipPath id="chart-plot-clip"><rect x="${left}" y="${top}" width="${width}" height="${height}"></rect></clipPath></defs><g clip-path="url(#chart-plot-clip)"><path class="chart-line" d="${path}"></path><rect class="chart-excluded" x="${left}" y="${top}" width="${Math.max(0, visibleStartX - left)}" height="${height}"></rect><rect class="chart-excluded" x="${visibleEndX}" y="${top}" width="${Math.max(0, right - visibleEndX)}" height="${height}"></rect><path class="chart-selected-line" d="${selectedPath}"></path><path class="chart-braking-weak" d="${brakingPath(weakBraking)}"></path><path class="chart-braking-strong" d="${brakingPath(strongBraking)}"></path><line id="chart-cursor" class="chart-cursor" x1="${firstPoint.x}" y1="${top}" x2="${firstPoint.x}" y2="${bottom}"></line><circle id="chart-point" class="chart-point" cx="${firstPoint.x}" cy="${firstPoint.y}" r="5"></circle></g><rect class="chart-pan-hit" x="${left}" y="${top}" width="${width}" height="${height}"></rect>${trimControls}`;
    $("chart-empty").style.display = "none";
    if (selectedPointIndex !== null && selectedPointIndex >= trimStartIndex && selectedPointIndex <= trimEndIndex) {
      positionChartCursor(selectedPointIndex);
    }
    if (restoreCursor && previousSelection !== null && previousSelection < chartPoints.length) {
      positionChartCursor(previousSelection);
    }
  }

  function markerIcon(color, text = "") {
    return L.divIcon({
      className: "",
      html: `<div style="width:15px;height:15px;border:2px solid #fff;border-radius:50%;background:${color};box-shadow:0 0 0 2px rgba(255,255,255,.35), 0 0 10px ${color};color:#fff;font-size:11px;font-weight:800;display:grid;place-items:center">${text}</div>`,
      iconSize: [15, 15],
      iconAnchor: [7, 7]
    });
  }

  function refreshHoverPixelPoints(points = hoverMapPoints) {
    hoverMapPoints = points;
    hoverPixelPoints = points.map((point) => ({
      pixel: map.latLngToContainerPoint([point.lat, point.mapLon]),
      lat: point.lat,
      lon: point.mapLon,
      speed: point.speed,
      index: point.index
    }));
  }

  function showMapPoint(index) {
    const row = chartPoints[index];
    if (!row) return;
    const location = [row.lat, row.mapLon];
    const pixel = map.latLngToContainerPoint(location);
    hoverRouteDot.style.left = `${pixel.x}px`;
    hoverRouteDot.style.top = `${pixel.y}px`;
    hoverRouteDot.style.display = "block";
    if (!hoverSpeedTooltip) {
      hoverSpeedTooltip = L.tooltip({
        direction: "top",
        offset: [0, -18],
        className: "hover-speed-tooltip",
        opacity: 1
      });
    }
    hoverSpeedTooltip
      .setLatLng(location)
      .setContent(`${row.speed.toFixed(1)} km/h`)
      .addTo(map);
  }

  function updateFollowRider() {
    if (!followRider || !chartPoints.length || followTargetElapsed === null) return;
    const rider = interpolateRiderAtTime(followTargetElapsed);
    const location = [rider.lat, rider.mapLon];
    const pixel = map.latLngToContainerPoint(location);
    hoverRouteDot.style.left = `${pixel.x}px`;
    hoverRouteDot.style.top = `${pixel.y}px`;
    hoverRouteDot.style.display = "block";
    if (!hoverSpeedTooltip) {
      hoverSpeedTooltip = L.tooltip({
        direction: "top",
        offset: [0, -18],
        className: "hover-speed-tooltip",
        opacity: 1
      });
    }
    hoverSpeedTooltip
      .setLatLng(location)
      .setContent(`${rider.speed.toFixed(1)} km/h`)
      .addTo(map);
    if (map.getCenter().distanceTo(location) > 0.5) {
      followPanInProgress = true;
      map.panTo(location, { animate: false });
      followPanInProgress = false;
      hoverPixelsDirty = true;
    }
  }

  function showNearestSpeed(event) {
    if (hoverPixelsDirty) {
      refreshHoverPixelPoints();
      hoverPixelsDirty = false;
    }
    const mapBounds = map.getContainer().getBoundingClientRect();
    const cursor = L.point(event.clientX - mapBounds.left, event.clientY - mapBounds.top);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const point of hoverPixelPoints) {
      const dx = point.pixel.x - cursor.x;
      const dy = point.pixel.y - cursor.y;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    if (!nearest || nearestDistance > 50 * 50) {
      hideHoverDetails();
      return;
    }
    selectChartPoint(nearest.index);
  }

  function hideHoverDetails() {
    if (hoverSpeedTooltip) hoverSpeedTooltip.remove();
    hoverRouteDot.style.display = "none";
  }

  function parseClockSeconds(time) {
    const timestamp = Date.parse(time);
    if (Number.isFinite(timestamp)) return timestamp / 1000;
    const match = time.match(/^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/);
    if (!match) return null;
    const [, hours, minutes, seconds, fraction = "0"] = match;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
  }

  function findSpeedSegments(points, sensitivity) {
    const clock = points.map((point) => parseClockSeconds(point.time));
    const intervals = [];
    for (let i = 1; i < clock.length; i++) {
      if (clock[i] === null || clock[i - 1] === null) continue;
      let interval = clock[i] - clock[i - 1];
      if (interval < 0) interval += 86400;
      if (interval > 0) intervals.push(interval);
    }
    intervals.sort((a, b) => a - b);
    const samplePeriod = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0.05;
    const sampleCount = (seconds) => Math.max(1, Math.round(seconds / samplePeriod));
    const smoothRadius = sampleCount(0.5);
    const extremaRadius = sampleCount(1.5);
    const flankRadius = sampleCount(10);
    const mergeRadius = sampleCount(6);
    const prefix = [0];
    for (const point of points) prefix.push(prefix[prefix.length - 1] + point.speed);
    const smoothSpeed = points.map((point, index) => {
      const start = Math.max(0, index - smoothRadius);
      const end = Math.min(points.length, index + smoothRadius + 1);
      return (prefix[end] - prefix[start]) / (end - start);
    });
    const candidates = [];
    let lastStoppedCandidateIndex = null;

    for (let i = Math.max(extremaRadius, flankRadius); i < points.length - flankRadius; i++) {
      let localMin = true;
      let leftMin = Infinity;
      let rightMin = Infinity;
      for (let j = i - extremaRadius; j <= i + extremaRadius; j++) {
        if (j === i) continue;
        if (smoothSpeed[j] < smoothSpeed[i]) localMin = false;
        if (j < i) leftMin = Math.min(leftMin, smoothSpeed[j]);
        else rightMin = Math.min(rightMin, smoothSpeed[j]);
      }
      if (!localMin || (smoothSpeed[i] >= leftMin && smoothSpeed[i] >= rightMin)) continue;

      let beforeMax = -Infinity;
      let afterMax = -Infinity;
      for (let j = i - flankRadius; j < i; j++) beforeMax = Math.max(beforeMax, smoothSpeed[j]);
      for (let j = i + 1; j <= i + flankRadius; j++) afterMax = Math.max(afterMax, smoothSpeed[j]);
      const speedDrop = beforeMax - smoothSpeed[i];
      const speedRecovery = afterMax - smoothSpeed[i];
      if (smoothSpeed[i] < 8) {
        if (speedDrop < sensitivity) continue;
        const resumedSinceLastStop = lastStoppedCandidateIndex !== null
          && smoothSpeed.slice(lastStoppedCandidateIndex + 1, i + 1).some((speed) => speed >= 8);
        if (lastStoppedCandidateIndex !== null && !resumedSinceLastStop) continue;
        lastStoppedCandidateIndex = i;
      } else if (speedDrop < sensitivity || speedRecovery < sensitivity) {
        continue;
      }

      const searchRadius = sampleCount(0.5);
      let minIndex = i;
      for (let j = Math.max(0, i - searchRadius); j <= Math.min(points.length - 1, i + searchRadius); j++) {
        if (points[j].speed < points[minIndex].speed) minIndex = j;
      }
      candidates.push({ index: i, minIndex, speed: smoothSpeed[i] });
    }

    const corners = [];
    for (const candidate of candidates) {
      const previous = corners[corners.length - 1];
      if (previous && candidate.index - previous.index < mergeRadius) {
        if (candidate.speed < previous.speed) corners[corners.length - 1] = candidate;
      } else {
        corners.push(candidate);
      }
    }

    return corners.map((corner, index) => {
      const start = index ? corners[index - 1].minIndex : 0;
      let maxIndex = start;
      for (let i = start + 1; i < corner.minIndex; i++) {
        if (smoothSpeed[i] > smoothSpeed[maxIndex]) maxIndex = i;
      }
      const searchRadius = sampleCount(0.5);
      let maxRecordIndex = maxIndex;
      for (let i = Math.max(start, maxIndex - searchRadius); i <= Math.min(corner.minIndex, maxIndex + searchRadius); i++) {
        if (points[i].speed > points[maxRecordIndex].speed) maxRecordIndex = i;
      }
      return { max: points[maxRecordIndex], min: points[corner.minIndex] };
    }).filter((segment) => segment.max !== segment.min);
  }

  function findBrakingModes(points) {
    if (points.length < 2) return [];
    const clock = points.map((point) => parseClockSeconds(point.time));
    const intervals = [];
    for (let index = 1; index < clock.length; index++) {
      intervals.push(clock[index] !== null && clock[index - 1] !== null
        ? Math.max(0, clock[index] - clock[index - 1])
        : 0);
    }
    const validIntervals = intervals.filter((interval) => interval > 0).sort((a, b) => a - b);
    const samplePeriod = validIntervals.length ? validIntervals[Math.floor(validIntervals.length / 2)] : 0.05;
    const sampleCount = (seconds) => Math.max(1, Math.round(seconds / samplePeriod));
    const smoothRadius = sampleCount(0.12);
    const window = sampleCount(0.6);
    const weakWindow = sampleCount(2);
    const weakTrendWindow = sampleCount(1.5);
    const mergeGap = sampleCount(0.2);
    const prefix = (values) => {
      const sums = [0];
      for (const value of values) sums.push(sums[sums.length - 1] + value);
      return sums;
    };
    const average = (sums, start, end) => (sums[end] - sums[start]) / (end - start);
    const speedPrefix = prefix(points.map((point) => point.speed));
    const smoothSpeed = points.map((point, index) => {
      const start = Math.max(0, index - smoothRadius);
      const end = Math.min(points.length, index + smoothRadius + 1);
      return average(speedPrefix, start, end);
    });
    const weakSmoothRadius = sampleCount(0.75);
    const weakSmoothSpeed = points.map((point, index) => {
      const start = Math.max(0, index - weakSmoothRadius);
      const end = Math.min(points.length, index + weakSmoothRadius + 1);
      return average(speedPrefix, start, end);
    });
    const elapsed = [0];
    const gapPrefix = [0];
    for (const interval of intervals) {
      elapsed.push(elapsed[elapsed.length - 1] + interval);
      gapPrefix.push(gapPrefix[gapPrefix.length - 1] + Number(interval > samplePeriod * 3));
    }
    const yawZ = points.map((point) => Math.abs(point.gyroZ || 0));
    const gValues = points.map((point) => [point.gForceX, point.gForceY, point.gForceZ]);
    const baseline = [0, 1, 2].map((axis) => {
      const values = gValues.map((axes) => axes[axis]).filter(Number.isFinite).sort((a, b) => a - b);
      return values.length ? values[Math.floor(values.length / 2)] : 0;
    });
    const gMotion = gValues.map((axes) => axes.every(Number.isFinite)
      ? Math.hypot(axes[0] - baseline[0], axes[1] - baseline[1], axes[2] - baseline[2])
      : 0);
    const gPrefix = prefix(gMotion);
    const candidates = [];

    for (let index = 0; index + window < points.length; index++) {
      const end = index + window;
      if (gapPrefix[end] - gapPrefix[index] > 0) continue;
      const duration = elapsed[end] - elapsed[index];
      if (duration <= 0) continue;
      const speedLoss = smoothSpeed[index] - smoothSpeed[end];
      const deceleration = speedLoss / duration;
      const meanGMotion = average(gPrefix, index, end + 1);
      let maxYawZ = 0;
      for (let sample = index; sample <= end; sample++) {
        maxYawZ = Math.max(maxYawZ, yawZ[sample]);
      }
      candidates.push({ index, end, duration, speedLoss, deceleration, maxYawZ, meanGMotion, startSpeed: smoothSpeed[index] });
    }

    const modes = new Uint8Array(points.length);

    for (const candidate of candidates) {
      if (candidate.startSpeed < 12 || candidate.speedLoss < 1.5 || candidate.deceleration < 2) continue;
      const gpsDecelerationG = candidate.deceleration / 35.316;
      const hasGSupport = candidate.meanGMotion >= 0.04 || gpsDecelerationG >= 0.08;
      if (!hasGSupport) continue;
      const sliding = candidate.maxYawZ > 50;
      if (!sliding) continue;
      for (let index = candidate.index; index <= candidate.end; index++) {
        modes[index] = 2;
      }
    }

    for (let index = 0; index + weakWindow < points.length; index++) {
      const end = index + weakWindow;
      if (gapPrefix[end] - gapPrefix[index] > 0 || weakSmoothSpeed[index] < 12) continue;
      const duration = elapsed[end] - elapsed[index];
      const speedLoss = weakSmoothSpeed[index] - weakSmoothSpeed[end];
      if (duration <= 0 || speedLoss < 1) continue;
      let maxYawZ = 0;
      for (let sample = index; sample <= end; sample++) {
        maxYawZ = Math.max(maxYawZ, yawZ[sample]);
      }
      if (maxYawZ > 50) continue;

      for (let sample = index + weakTrendWindow; sample <= end; sample++) {
        const localSpeedLoss = weakSmoothSpeed[sample - weakTrendWindow] - weakSmoothSpeed[sample];
        if (localSpeedLoss >= 0.5) {
          for (let trendIndex = sample - weakTrendWindow + 1; trendIndex <= sample; trendIndex++) {
            modes[trendIndex] = Math.max(modes[trendIndex], 1);
          }
        }
      }
    }

    const zones = [];
    let runMode = 0;
    let runStart = 0;
    let lastActive = 0;
    const finishRun = () => {
      if (runMode && lastActive - runStart + 1 >= sampleCount(0.2)) {
        zones.push({ start: runStart, end: lastActive, mode: runMode === 2 ? "strong" : "weak" });
      }
    };
    for (let index = 0; index < modes.length; index++) {
      const mode = modes[index];
      if (mode === runMode && mode !== 0) {
        lastActive = index;
      } else if (mode === 0 && runMode !== 0 && index - lastActive <= mergeGap) {
        continue;
      } else {
        finishRun();
        runMode = mode;
        runStart = index;
        lastActive = index;
      }
    }
    finishRun();
    return zones;
  }

  function updateView() {
    if (!records.length) return;
    const minSpeed = Number($("color-min-speed").value);
    const maxSpeed = Number($("color-max-speed").value);
    const fullPoints = records.map((row) => ({ ...row, mapLon: row.lon }));
    trimStartIndex = clamp(trimStartIndex, 0, Math.max(0, fullPoints.length - 2));
    trimEndIndex = clamp(trimEndIndex, trimStartIndex + 1, fullPoints.length - 1);
    const points = fullPoints.slice(trimStartIndex, trimEndIndex + 1);
    const vmax = points.reduce((best, row) => row.speed > best.speed ? row : best, points[0]);
    const minAltitude = Math.min(...points.map((row) => row.altitude));
    const maxAltitude = Math.max(...points.map((row) => row.altitude));
    const distance = points.slice(1).reduce((sum, row, index) => sum + distanceMeters(points[index], row), 0);
    $("vmax").innerHTML = `${vmax.speed.toFixed(1)} <small>km/h</small>`;
    $("distance").innerHTML = `${distance >= 1000 ? (distance / 1000).toFixed(2) : Math.round(distance)} <small>${distance >= 1000 ? "km" : "m"}</small>`;
    $("altitude").innerHTML = `${minAltitude.toFixed(0)} <small>/</small> ${maxAltitude.toFixed(0)} <small>m</small>`;

    const segments = findSpeedSegments(points, segmentSensitivity);
    const brakingModes = findBrakingModes(points);
    const weakBrakingZones = brakingModes.filter((zone) => zone.mode === "weak");
    const strongBrakingZones = brakingModes.filter((zone) => zone.mode === "strong");
    renderSpeedChart(fullPoints);
    $("duration").textContent = formatDuration(
      chartPoints[trimEndIndex].elapsed - chartPoints[trimStartIndex].elapsed
    );
    if (hoverSpeedTooltip) hoverSpeedTooltip.remove();
    refreshHoverPixelPoints(points);
    layer.clearLayers();
    speedMarkerLayer.clearLayers();
    slidingLayer.clearLayers();
    airbrakeLayer.clearLayers();
    const latLngs = points.map((row) => [row.lat, row.mapLon]);
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const current = points[i];
      const avgSpeed = (previous.speed + current.speed) / 2;
      L.polyline([[previous.lat, previous.mapLon], [current.lat, current.mapLon]], {
        color: speedToColor(avgSpeed, minSpeed, maxSpeed),
        weight: 5,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        renderer: trackRenderer,
        interactive: false
      }).addTo(layer);
    }
    weakBrakingZones.forEach((zone) => {
      const zoneLatLngs = points.slice(zone.start, zone.end + 1).map((point) => [point.lat, point.mapLon]);
      if (zoneLatLngs.length >= 2) {
        L.polyline(zoneLatLngs, {
          color: "#168dff",
          weight: 6,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
          renderer: trackRenderer,
          interactive: false
        }).addTo(airbrakeLayer);
      }
    });
    strongBrakingZones.forEach((zone) => {
      const zoneLatLngs = points.slice(zone.start, zone.end + 1).map((point) => [point.lat, point.mapLon]);
      if (zoneLatLngs.length >= 2) {
        L.polyline(zoneLatLngs, {
          color: "#7b2cff",
          weight: 7,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
          renderer: trackRenderer,
          interactive: false
        }).addTo(slidingLayer);
      }
    });
    L.circleMarker(latLngs[0], { radius: 5, color: "#fff", weight: 2, fillColor: "#3287ff", fillOpacity: 1 }).bindPopup("Départ").addTo(layer);
    L.circleMarker(latLngs[latLngs.length - 1], { radius: 5, color: "#fff", weight: 2, fillColor: "#a477ff", fillOpacity: 1 }).bindPopup("Arrivée").addTo(layer);
    segments.forEach((segment) => {
      const maxPoint = segment.max;
      const minPoint = segment.min;
      L.marker([maxPoint.lat, maxPoint.mapLon], { icon: markerIcon("#35c789"), zIndexOffset: 1000 })
        .bindTooltip(`${maxPoint.speed.toFixed(1)} km/h`, {
          permanent: true, direction: "top", offset: [0, -14], className: "speed-tooltip vmax-tooltip", opacity: 1
        }).addTo(speedMarkerLayer);
      L.marker([minPoint.lat, minPoint.mapLon], { icon: markerIcon("#f0a144"), zIndexOffset: 900 })
        .bindTooltip(`${minPoint.speed.toFixed(1)} km/h`, {
          permanent: true, direction: "top", offset: [0, -14], className: "speed-tooltip vmin-tooltip", opacity: 1
        }).addTo(speedMarkerLayer);
    });
    map.fitBounds(L.latLngBounds(latLngs).pad(.12), { maxZoom: 17 });
    refreshHoverPixelPoints(points);
    selectChartPoint(trimEndIndex);
    $("empty").style.display = "none";

    const lon = points[0].mapLon;
    if (lon < 0 || Math.abs(lon) > 25) showNotice(`La trace est située vers ${Math.abs(lon).toFixed(1)}° ${lon < 0 ? "Ouest" : "Est"}. Vérifiez les coordonnées si cela ne correspond pas au lieu de votre session.`);
    else if (segments.length === 0) showNotice("Aucun ralentissement marqué suivi d'une reprise n'a été détecté pour placer les repères VMax/VMin.");
    else clearNotice();

    activeSelection = {
      start: { lat: points[0].lat, lon: points[0].lon },
      end: { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon },
      seconds: Math.max(0, chartPoints[trimEndIndex].elapsed - chartPoints[trimStartIndex].elapsed)
    };
    $("save-spot").disabled = false;
    $("return-to-csv").hidden = viewMode !== "chrono";
    renderSpotPanel();
    if (spotStorageError) showNotice(spotStorageError, true);
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      parseFile(text);
      setColorDefaultsForSession();
      $("file-name").textContent = file.name;
      recomputeSpotMatches();
      $("empty").style.display = "none";
      updateView();
    } catch (error) {
      records = [];
      layer.clearLayers();
      speedMarkerLayer.clearLayers();
      slidingLayer.clearLayers();
      airbrakeLayer.clearLayers();
      chartPoints = [];
      chartRange = null;
      selectedPointIndex = null;
      hideHoverDetails();
      $("speed-chart").replaceChildren();
      $("chart-empty").style.display = "grid";
      $("current-speed").textContent = "—";
      $("current-altitude").textContent = "—";
      $("current-grade").textContent = "—";
      $("current-gyro").textContent = "—";
      $("current-gforce").textContent = "—";
      $("chart-time").textContent = "—";
      ["vmax", "distance", "duration", "altitude"].forEach((id) => { $(id).textContent = "—"; });
      activeSelection = null;
      spotMatches = [];
      viewMode = "csv";
      chronoSpotId = null;
      chronoViewNeedsFit = false;
      $("save-spot").disabled = true;
      $("return-to-csv").hidden = true;
      renderSpotPanel();
      $("empty").style.display = "block";
      showNotice(error.message || "Impossible de lire ce fichier.", true);
    }
  }

  $("file-input").addEventListener("change", (event) => loadFile(event.target.files[0]));
  $("save-spot").addEventListener("click", () => {
    if (!activeSelection) return;
    $("spot-name").value = "";
    $("spot-name").setCustomValidity("");
    $("spot-dialog").showModal();
    $("spot-name").focus();
  });
  $("cancel-spot").addEventListener("click", () => $("spot-dialog").close());
  $("spot-name").addEventListener("input", (event) => event.target.setCustomValidity(""));
  $("spot-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const nameInput = $("spot-name");
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity("Saisissez un nom pour le Spot.");
      nameInput.reportValidity();
      return;
    }
    if (saveCurrentSpot(name)) {
      $("spot-dialog").close();
    }
  });
  $("return-to-csv").addEventListener("click", selectCsvView);
  function setMenuVisibility(visible) {
    $("top-menu").hidden = !visible;
    $("show-menu").hidden = visible;
    $("hide-menu").setAttribute("aria-expanded", String(visible));
    $("show-menu").setAttribute("aria-expanded", String(!visible));
    requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  }
  $("hide-menu").addEventListener("click", () => setMenuVisibility(false));
  $("show-menu").addEventListener("click", () => setMenuVisibility(true));
  $("show-sliding-zone").addEventListener("change", (event) => {
    if (event.target.checked) slidingLayer.addTo(map);
    else map.removeLayer(slidingLayer);
  });
  $("show-airbrake-zone").addEventListener("change", (event) => {
    if (event.target.checked) airbrakeLayer.addTo(map);
    else map.removeLayer(airbrakeLayer);
  });
  $("show-speed-markers").addEventListener("change", (event) => {
    if (event.target.checked) speedMarkerLayer.addTo(map);
    else map.removeLayer(speedMarkerLayer);
  });
  $("speed-chart").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !chartPoints.length || !chartRange) return;
    const handle = event.target.closest("[data-trim-handle]");
    if (handle) {
      chartPan = { mode: handle.dataset.trimHandle, pointerId: event.pointerId };
    } else {
      chartPan = {
        mode: "pan",
        pointerId: event.pointerId,
        clientX: event.clientX,
        start: chartView.start,
        end: chartView.end
      };
      $("speed-chart").classList.add("is-panning");
    }
    $("speed-chart").setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  $("speed-chart").addEventListener("pointermove", (event) => {
    if (!chartPoints.length || !chartRange) return;
    if (chartPan && chartPan.pointerId === event.pointerId) {
      if (chartPan.mode === "pan") {
        const bounds = $("speed-chart").getBoundingClientRect();
        const shift = (event.clientX - chartPan.clientX) * 1000 / bounds.width
          * chartRange.viewDuration / chartRange.width;
        const duration = chartPan.end - chartPan.start;
        const domainStart = viewMode === "chrono" ? chartPoints[trimStartIndex].elapsed : 0;
        const domainEnd = viewMode === "chrono" ? chartPoints[trimEndIndex].elapsed : chartRange.duration;
        const start = clamp(chartPan.start - shift, domainStart, domainEnd - duration);
        chartView = { start, end: start + duration };
      } else {
        const index = chartIndexAtPointer(event);
        if (chartPan.mode === "start") trimStartIndex = clamp(index, 0, trimEndIndex - 1);
        else trimEndIndex = clamp(index, trimStartIndex + 1, chartPoints.length - 1);
      }
      renderSpeedChart(chartPoints, false);
      return;
    }
    selectChartPoint(clamp(chartIndexAtPointer(event), trimStartIndex, trimEndIndex));
    followTargetElapsed = chartTimeAtPointer(event);
  });
  const finishChartPointer = (event) => {
    if (!chartPan || chartPan.pointerId !== event.pointerId) return;
    const wasTrimming = chartPan.mode !== "pan";
    chartPan = null;
    $("speed-chart").classList.remove("is-panning");
    if (wasTrimming) updateView();
  };
  $("speed-chart").addEventListener("pointerup", finishChartPointer);
  $("speed-chart").addEventListener("pointercancel", finishChartPointer);
  $("speed-chart").addEventListener("wheel", (event) => {
    if (!chartPoints.length || !chartRange) return;
    event.preventDefault();
    const bounds = $("speed-chart").getBoundingClientRect();
    const relativeX = (event.clientX - bounds.left) / bounds.width * 1000;
    const fraction = clamp((relativeX - chartRange.left) / chartRange.width, 0, 1);
    const oldDuration = chartRange.viewDuration;
    const samplePeriod = chartRange.duration / Math.max(1, chartPoints.length - 1);
    const domainStart = viewMode === "chrono" ? chartPoints[trimStartIndex].elapsed : 0;
    const domainEnd = viewMode === "chrono" ? chartPoints[trimEndIndex].elapsed : chartRange.duration;
    const domainDuration = domainEnd - domainStart;
    const minimumDuration = Math.min(domainDuration, Math.max(0.5, samplePeriod * 10));
    const nextDuration = clamp(oldDuration * (event.deltaY < 0 ? 0.8 : 1.25), minimumDuration, domainDuration);
    const anchor = chartRange.viewStart + fraction * oldDuration;
    const start = clamp(anchor - fraction * nextDuration, domainStart, domainEnd - nextDuration);
    chartView = { start, end: start + nextDuration };
    renderSpeedChart(chartPoints, false);
  }, { passive: false });
  $("chart-reset-zoom").addEventListener("click", () => {
    if (!chartPoints.length || !chartRange) return;
    chartView = viewMode === "chrono"
      ? { start: chartPoints[trimStartIndex].elapsed, end: chartPoints[trimEndIndex].elapsed }
      : { start: 0, end: chartRange.duration };
    renderSpeedChart(chartPoints, false);
  });
  const syncSmoothingControls = () => {
    const strength = $("smoothing-strength");
    strength.disabled = !$("smooth-chart").checked;
    $("smoothing-strength-value").textContent = `${Number(strength.value).toFixed(1).replace(".", ",")} s`;
  };
  $("smooth-chart").addEventListener("change", () => {
    syncSmoothingControls();
    if (chartPoints.length) renderSpeedChart(chartPoints, false);
  });
  $("smoothing-strength").addEventListener("input", () => {
    syncSmoothingControls();
    if (chartPoints.length && $("smooth-chart").checked) renderSpeedChart(chartPoints, false);
  });
  $("color-min-speed").addEventListener("input", () => { syncColorLimits(); if (records.length) updateView(); });
  $("color-max-speed").addEventListener("input", () => { syncColorLimits(); if (records.length) updateView(); });
  map.on("zoomstart movestart", () => {
    if (!followPanInProgress) hideHoverDetails();
  });
  window.setInterval(updateFollowRider, 40);
  map.on("zoomend moveend", () => {
    if (followPanInProgress) {
      hoverPixelsDirty = true;
      return;
    }
    refreshHoverPixelPoints();
    hoverPixelsDirty = false;
    if (selectedPointIndex !== null) showMapPoint(selectedPointIndex);
  });
  map.getContainer().addEventListener("mousemove", showNearestSpeed);
  map.getContainer().addEventListener("mouseleave", hideHoverDetails);
  $("satellite").addEventListener("change", (event) => {
    if (event.target.checked) {
      map.removeLayer(streets);
      imagery.addTo(map);
      $("map").classList.remove("tiles-blocked");
      clearNotice();
    } else {
      map.removeLayer(imagery);
      streets.addTo(map);
    }
  });
  const dropZone = $("drop-zone");
  dropZone.addEventListener("dragover", (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    loadFile(event.dataTransfer.files[0]);
  });
  window.addEventListener("resize", () => map.invalidateSize());

  spots = readSavedSpots();
  syncColorLimits();
  syncSmoothingControls();

  const params = new URLSearchParams(location.search);
  if (params.get("file")) {
    fetch(params.get("file"))
      .then((response) => {
        if (!response.ok) throw new Error(`Chargement du fichier impossible (${response.status}).`);
        return response.text();
      })
      .then((text) => {
        parseFile(text);
        setColorDefaultsForSession();
        $("file-name").textContent = params.get("file").split(/[\\/]/).pop();
        recomputeSpotMatches();
        updateView();
      })
      .catch((error) => showNotice(error.message, true));
  }
})();