/* ============================================================
   APP.JS — WebGIS Hotel Yogyakarta
   Features: Search, Directions (OSRM), Surroundings,
             Analysis, Detail Panel
   ============================================================ */

// ── Routing ──────────────────────────────────────────────────
function showScreen(id) {
  ["s-landing", "s-map", "s-detail", "s-analysis"].forEach((s) => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle("active", s === id);
  });
}

function toast(msg, ms = 2800) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ── Globals ───────────────────────────────────────────────────
let map = null,
  mapInited = false,
  tileOSM = null;
let markerMap = {},
  selectedHotelId = null;
let detailMap = null,
  detailMapInited = false;
let routeLayer = null,
  routeMarkers = [];
let radiusLayer = null,
  surroundLayer = null;
let dirMode = false,
  dirFrom = null,
  dirTo = null;
let adminLayerGroup = null; // batas wilayah Yogyakarta
let clusterGroup = null; // MarkerCluster — atasi tumpang tindih saat zoom out

// ── Go to map ─────────────────────────────────────────────────
function goToMap() {
  showScreen("s-map");
  initMap();
}

// ─────────────────────────────────────────────────────────────
// MAP INIT
// ─────────────────────────────────────────────────────────────
function initMap() {
  if (mapInited) return;
  mapInited = true;

  map = L.map("map", {
    center: YOGYA_CENTER,
    zoom: YOGYA_ZOOM,
    zoomControl: false,
    attributionControl: true,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  tileOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
  }).addTo(map);

  /* Cluster group — marker gabung otomatis saat zoom out */
  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 50,
    disableClusteringAtZoom: 15,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      const n = cluster.getChildCount();
      const s = n < 10 ? 32 : n < 50 ? 38 : 44;
      return L.divIcon({
        html: `<div style="width:${s}px;height:${s}px;border-radius:50%;
          background:#1C2B4A;color:#fff;display:flex;align-items:center;
          justify-content:center;font-weight:700;font-size:.78rem;
          border:2.5px solid #0B9F97;box-shadow:0 2px 8px rgba(0,0,0,.3)">${n}</div>`,
        className: "",
        iconSize: [s, s],
        iconAnchor: [s / 2, s / 2],
      });
    },
  });

  HOTELS.forEach((h) => addMarker(h));
  clusterGroup.addTo(map);
  buildSidebarList();
  // loadYogyaBoundary();

  map.on("mousemove", (e) => {
    const el = document.getElementById("cursor-coord");
    if (el)
      el.textContent = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
  });

  map.on("zoomend", () => {
    const el = document.getElementById("zoom-level");
    if (el) el.textContent = map.getZoom();
    updateMobileMapState();
  });

  map.on("click", onMapClick);

  toast("✅ " + HOTELS.length + " hotel berhasil dimuat");
}

// ─────────────────────────────────────────────────────────────
// BATAS WILAYAH — Kota Yogyakarta + 14 Kecamatan
// Priority: Overpass API (data resmi OSM) → fallback hardcoded
// ─────────────────────────────────────────────────────────────
async function loadYogyaBoundary() {
  if (!adminLayerGroup) {
    adminLayerGroup = L.layerGroup();
  } else {
    adminLayerGroup.clearLayers();
  }
  adminLayerGroup.addTo(map);

  const sOuter = {
    color: "#b487ea",
    weight: 4,
    fillColor: "#c871fb",
    fillOpacity: 0.08,
    interactive: false,
  };

  // Fetch dengan timeout
  async function tFetch(url, opts, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: c.signal });
      clearTimeout(t);
      return r;
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  let gotOuter = false,
    gotKec = false;

  // ─── 1. Batas LUAR via Nominatim (data resmi, 1 request) ───
  try {
    const r = await tFetch(
      "https://nominatim.openstreetmap.org/search?q=Kota+Yogyakarta&format=json&polygon_geojson=1&limit=5&countrycodes=id",
      { headers: { "Accept-Language": "id" } },
      8000,
    );
    const d = await r.json();
    const hit =
      d.find(
        (x) =>
          x.geojson &&
          x.class === "boundary" &&
          (x.geojson.type === "Polygon" || x.geojson.type === "MultiPolygon"),
      ) || d.find((x) => x.geojson && x.geojson.type !== "Point");
    if (hit) {
      L.geoJSON(hit.geojson, { style: sOuter }).addTo(adminLayerGroup);
      gotOuter = true;
    }
  } catch (e) {
    console.warn("Nominatim:", e.message);
  }

  // ─── 2. Batas KECAMATAN via Overpass ───────────────────────
  try {
    const q = `[out:json][timeout:20];
area["name"="Kota Yogyakarta"]["admin_level"="5"]->.kota;
relation["admin_level"="6"](area.kota);
out geom;`;
    const r = await tFetch(
      "https://overpass-api.de/api/interpreter",
      { method: "POST", body: "data=" + encodeURIComponent(q) },
      15000,
    );
    const d = await r.json();
    if (d.elements && d.elements.length > 0) {
      d.elements.forEach((rel) => {
        (rel.members || [])
          .filter(
            (m) => m.role === "outer" && m.geometry && m.geometry.length > 2,
          )
          .forEach((m) =>
            L.polygon(
              m.geometry.map((p) => [p.lat, p.lon]),
              sKec,
            ).addTo(adminLayerGroup),
          );
      });
      gotKec = true;
    }
  } catch (e) {
    console.warn("Overpass:", e.message);
  }

  // ─── 3. Fallback hardcoded jika API gagal ──────────────────
  if (!gotOuter) {
    L.polygon(
      [
        [-7.7525, 110.3335],
        [-7.751, 110.3375],
        [-7.75, 110.345],
        [-7.7495, 110.353],
        [-7.7492, 110.3612],
        [-7.7493, 110.3695],
        [-7.7495, 110.3775],
        [-7.75, 110.3855],
        [-7.7512, 110.3935],
        [-7.7532, 110.4005],
        [-7.7562, 110.4068],
        [-7.7605, 110.4108],
        [-7.7665, 110.4125],
        [-7.7735, 110.4118],
        [-7.7802, 110.4095],
        [-7.7862, 110.4058],
        [-7.7918, 110.4002],
        [-7.7965, 110.3948],
        [-7.8005, 110.3912],
        [-7.8048, 110.3888],
        [-7.8088, 110.3865],
        [-7.8128, 110.3842],
        [-7.8162, 110.3815],
        [-7.8185, 110.3778],
        [-7.8198, 110.3732],
        [-7.8195, 110.3682],
        [-7.8182, 110.363],
        [-7.8162, 110.3578],
        [-7.8132, 110.3528],
        [-7.8092, 110.3485],
        [-7.8045, 110.3448],
        [-7.7995, 110.3415],
        [-7.794, 110.3385],
        [-7.7878, 110.336],
        [-7.7812, 110.334],
        [-7.774, 110.3328],
        [-7.7665, 110.3325],
        [-7.7588, 110.3325],
        [-7.7525, 110.333],
      ],
      sOuter,
    ).addTo(adminLayerGroup);
  }

  if (!gotKec) {
    [
      // Tegalrejo
      [
        [-7.7525, 110.333],
        [-7.7492, 110.361],
        [-7.766, 110.361],
        [-7.766, 110.333],
      ],
      // Jetis
      [
        [-7.7492, 110.361],
        [-7.7493, 110.37],
        [-7.766, 110.37],
        [-7.766, 110.361],
      ],
      // Gondokusuman
      [
        [-7.7493, 110.37],
        [-7.75, 110.3855],
        [-7.7562, 110.4068],
        [-7.7665, 110.4125],
        [-7.7802, 110.4095],
        [-7.7802, 110.37],
        [-7.766, 110.37],
      ],
      // Wirobrajan
      [
        [-7.766, 110.333],
        [-7.766, 110.361],
        [-7.78, 110.361],
        [-7.78, 110.333],
      ],
      // Gedongtengen
      [
        [-7.766, 110.361],
        [-7.766, 110.37],
        [-7.78, 110.37],
        [-7.78, 110.361],
      ],
      // Danurejan
      [
        [-7.766, 110.37],
        [-7.766, 110.38],
        [-7.78, 110.38],
        [-7.78, 110.37],
      ],
      // Ngampilan
      [
        [-7.78, 110.361],
        [-7.78, 110.37],
        [-7.794, 110.37],
        [-7.794, 110.361],
      ],
      // Gondomanan
      [
        [-7.78, 110.37],
        [-7.78, 110.38],
        [-7.794, 110.38],
        [-7.794, 110.37],
      ],
      // Kraton
      [
        [-7.78, 110.38],
        [-7.7802, 110.4095],
        [-7.7918, 110.4002],
        [-7.794, 110.39],
        [-7.794, 110.38],
      ],
      // Pakualaman/Kraton barat
      [
        [-7.78, 110.333],
        [-7.78, 110.361],
        [-7.794, 110.361],
        [-7.794, 110.333],
      ],
      // Mantrijeron
      [
        [-7.794, 110.333],
        [-7.794, 110.361],
        [-7.8195, 110.361],
        [-7.8162, 110.3578],
        [-7.8132, 110.3528],
        [-7.8045, 110.3448],
        [-7.7995, 110.3415],
        [-7.794, 110.3385],
      ],
      // Mergangsan
      [
        [-7.794, 110.361],
        [-7.794, 110.38],
        [-7.8195, 110.38],
        [-7.8195, 110.361],
      ],
      // Umbulharjo
      [
        [-7.794, 110.38],
        [-7.794, 110.39],
        [-7.7918, 110.4002],
        [-7.7965, 110.3948],
        [-7.8048, 110.3888],
        [-7.8128, 110.3842],
        [-7.8185, 110.3778],
        [-7.8198, 110.3732],
        [-7.8195, 110.38],
      ],
      // Kotagede
      [
        [-7.8195, 110.361],
        [-7.8195, 110.38],
        [-7.8198, 110.3732],
        [-7.8185, 110.3778],
        [-7.8162, 110.3815],
        [-7.8195, 110.368],
        [-7.8182, 110.363],
        [-7.8162, 110.3578],
        [-7.8195, 110.361],
      ],
    ].forEach((c) => L.polygon(c, sKec).addTo(adminLayerGroup));
  }

  // Markers tetap di depan
  Object.values(markerMap).forEach(({ marker }) => {
    try {
      marker.bringToFront();
    } catch {}
  });
}


// ── External hotel links (tanpa API/billing) ──────────────────
function hotelSearchQuery(h) {
  return encodeURIComponent(`${h.name} ${h.kecamatan || ""} Yogyakarta hotel`);
}

function openHotelPhoto(id) {
  const h = HOTELS.find((x) => x.id === id);
  if (!h) return;
  window.open(`https://www.google.com/search?tbm=isch&q=${hotelSearchQuery(h)}`, "_blank");
}

function openHotelGoogle(id) {
  const h = HOTELS.find((x) => x.id === id);
  if (!h) return;
  window.open(`https://www.google.com/search?q=${hotelSearchQuery(h)}`, "_blank");
}

// ── Markers ───────────────────────────────────────────────────
function makeIcon(cat, stars) {
  const meta = CAT_META[cat] || CAT_META["Bintang 3"];
  const color = meta.color;
  const w = 24,
    h = 32;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 24 32">
    <path d="M12 0C5.373 0 0 5.373 0 12c0 8 12 20 12 20S24 20 24 12C24 5.373 18.627 0 12 0z"
          fill="${color}" stroke="white" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="7" fill="white" opacity="0.92"/>
    <text x="12" y="16" text-anchor="middle" font-size="8"
          font-weight="800" fill="${color}" font-family="sans-serif">${stars || "?"}</text>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: "",
    iconSize: [w, h],
    iconAnchor: [w / 2, h],
    popupAnchor: [0, -(h + 4)],
  });
}

function addMarker(h) {
  const meta = CAT_META[h.category] || {};
  const starFull = `<span style="color:#D97706">★</span>`;
  const starEmpty = `<span style="color:#CBD5E1">☆</span>`;
  const starHtml =
    starFull.repeat(h.stars || 0) + starEmpty.repeat(5 - (h.stars || 0));

  /* WSM score & breakdown — hanya tampil jika data WSM ada */
  const wsm = h.wsm != null ? Number(h.wsm).toFixed(2) : null;
  const wsmColor = wsm
    ? parseFloat(wsm) >= 7
      ? "#16A34A"
      : parseFloat(wsm) >= 5
        ? "#D97706"
        : "#DC2626"
    : "#94A3B8";
  const jarak = h.jarakLandmark || {};
  const komp = h.wsmKomponen || {};

  const wsmBlock = wsm
    ? `
    <div style="margin:.65rem 0 0;padding:.6rem;background:#F8FAFC;
      border-radius:8px;border:1px solid #E2E8F0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.35rem">
        <div>
          <div style="font-size:.59rem;color:#64748B;font-family:monospace;letter-spacing:.06em;font-weight:600">
            WSM SCORE — Weighted Sum Model</div>
          <div style="font-size:.59rem;color:#94A3B8;margin-top:.04rem">
            0.25×Malioboro + 0.20×Kraton + 0.15×TamanSari + 0.10×Vredeburg + 0.10×AlunAlun + 0.20×Bintang
          </div>
        </div>
        <div style="font-family:monospace;font-size:1.55rem;font-weight:800;
          color:${wsmColor};line-height:1;margin-left:.5rem">${wsm}</div>
      </div>
      <div style="height:5px;background:#E2E8F0;border-radius:3px;overflow:hidden;margin-bottom:.4rem">
        <div style="height:100%;width:${Math.min(parseFloat(wsm) * 10, 100)}%;
          background:${wsmColor};border-radius:3px;transition:width .6s"></div>
      </div>
      ${[
        {
          lbl: "↔ Malioboro",
          jk: jarak.malioboro,
          sk: komp.malioboro,
          w: 0.25,
        },
        { lbl: "↔ Kraton", jk: jarak.kraton, sk: komp.kraton, w: 0.2 },
        {
          lbl: "↔ Taman Sari",
          jk: jarak.tamanSari,
          sk: komp.tamanSari,
          w: 0.15,
        },
        { lbl: "↔ Vredeburg", jk: jarak.vredeburg, sk: komp.vredeburg, w: 0.1 },
        { lbl: "↔ Alun-alun", jk: jarak.alunAlun, sk: komp.alunAlun, w: 0.1 },
        { lbl: "★ Bintang", jk: null, sk: komp.bintang, w: 0.2 },
      ]
        .map((c) => {
          const dist =
            c.jk != null
              ? ` <span style="color:#94A3B8;font-size:.56rem">${c.jk}km</span>`
              : "";
          const pct =
            c.sk != null ? Math.min((c.sk / (c.w * 10)) * 100, 100) : 0;
          return `<div style="display:flex;align-items:center;gap:.35rem;margin-bottom:.16rem">
          <span style="font-size:.59rem;color:#64748B;width:85px;flex-shrink:0">${c.lbl}${dist}</span>
          <div style="flex:1;height:3px;background:#E2E8F0;border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:#0B9F97;border-radius:2px"></div>
          </div>
          <span style="font-family:monospace;font-size:.59rem;color:#1C2B4A;
            font-weight:700;width:22px;text-align:right">${c.sk != null ? c.sk : "—"}</span>
        </div>`;
        })
        .join("")}
    </div>`
    : "";

  const popupHtml = `
    <div class="p-body">
      <div style="padding:.15rem 0 .55rem;border-bottom:1px solid #E2E8F0;margin-bottom:.55rem">
        <div class="p-title">${h.name}</div>
        <div class="p-sub">${h.kecamatan || "Kota Yogyakarta"} · ${h.category}</div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <div>${starHtml}</div>
        <span style="background:${meta.bg || "rgba(0,0,0,.1)"};color:${meta.color || "#64748B"};
          border:1px solid ${meta.color || "#64748B"}44;border-radius:4px;
          font-size:.62rem;font-weight:700;padding:.18rem .45rem;font-family:monospace">
          ${h.category}</span>
      </div>
      <div class="p-row">📍 ${h.address}</div>
      <div class="p-row">🚶 ${h.distance_tugu}</div>
      <div class="p-row">📞 ${h.phone || "—"}</div>
      ${wsmBlock}
      <div class="p-actions" style="margin-top:.6rem">
        <button class="p-btn p-btn-primary" onclick="openDetail('${h.id}')">DETAIL</button>
        <button class="p-btn p-btn-dir" onclick="startDirectionTo('${h.id}')">🗺️ Rute</button>
      </div>
      <div class="p-actions" style="margin-top:.4rem">
        <button class="p-btn p-btn-dir" onclick="openHotelPhoto('${h.id}')">📸 Foto</button>
        <button class="p-btn p-btn-dir" onclick="openHotelGoogle('${h.id}')">Open in Google</button>
      </div>
    </div>`;

  /* Masuk ke clusterGroup agar tidak tumpang tindih saat zoom out */
  const m = L.marker([h.lat, h.lng], {
    icon: makeIcon(h.category, h.stars),
  }).bindPopup(popupHtml, {
    maxWidth: window.innerWidth <= 768 ? 270 : 330,
    minWidth: window.innerWidth <= 768 ? 250 : 310,
    autoPan: true,
    keepInView: true,
    autoPanPaddingTopLeft: [14, 86],
    autoPanPaddingBottomRight: [14, window.innerWidth <= 768 ? 135 : 24],
  });

  m.on("click", () => {
    selectedHotelId = h.id;
    highlightSidebarItem(h.id);
    showSurroundings(h);
  });

  if (clusterGroup) clusterGroup.addLayer(m);
  else m.addTo(map);

  markerMap[h.id] = { marker: m, hotel: h };
}

function highlightSidebarItem(id) {
  document.querySelectorAll(".hli").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
}

// ── Sidebar List ──────────────────────────────────────────────
function buildSidebarList() {
  const container = document.getElementById("hotel-list");
  if (!container) return;
  container.innerHTML = HOTELS.map((h) => {
    const meta = CAT_META[h.category] || {};
    return `<div class="hli" data-id="${h.id}" onclick="flyToHotel('${h.id}')">
      <div class="hli-dot" style="background:${meta.color}"></div>
      <div class="hli-info">
        <div class="hli-name">${h.name}</div>
        <div class="hli-kec">${h.kecamatan} · ${h.category}</div>
      </div>
      <div class="hli-score">${h.wsm != null ? Number(h.wsm).toFixed(1) : "—"}</div>
    </div>`;
  }).join("");
}

function flyToHotel(id) {
  const item = markerMap[id];
  if (!item) return;
  selectedHotelId = id;
  highlightSidebarItem(id);
  map.flyTo([item.hotel.lat, item.hotel.lng], 16, { duration: 0.9 });
  setTimeout(() => item.marker.openPopup(), 950);
  showSurroundings(item.hotel);
}

function resetView() {
  if (map) map.flyTo(YOGYA_CENTER, YOGYA_ZOOM, { duration: 1 });
}

// ─────────────────────────────────────────────────────────────
// SEARCH (Nominatim + hotel name)
// ─────────────────────────────────────────────────────────────
let searchTimer = null;

function onSearchInput(val) {
  clearTimeout(searchTimer);
  const drop = document.getElementById("search-drop");
  if (val.length < 2) {
    drop.classList.remove("open");
    return;
  }
  searchTimer = setTimeout(() => performSearch(val), 350);
}

function performSearch(q) {
  const drop = document.getElementById("search-drop");
  drop.innerHTML = "";

  // Local hotel search first
  const localResults = HOTELS.filter(
    (h) =>
      h.name.toLowerCase().includes(q.toLowerCase()) ||
      h.address.toLowerCase().includes(q.toLowerCase()) ||
      h.kecamatan.toLowerCase().includes(q.toLowerCase()),
  ).slice(0, 4);

  localResults.forEach((h) => {
    const meta = CAT_META[h.category] || {};
    const item = document.createElement("div");
    item.className = "sr-item";
    item.innerHTML = `
      <span style="font-size:.9rem">🏨</span>
      <div>
        <div class="sr-name">${h.name}</div>
        <div class="sr-addr">${h.address}</div>
      </div>
      <span class="sr-badge" style="background:${meta.bg};color:${meta.color};border:1px solid ${meta.color}44">
        ${h.category}
      </span>`;
    item.onclick = () => {
      flyToHotel(h.id);
      clearSearch();
    };
    drop.appendChild(item);
  });

  // Nominatim geocoding for non-hotel results
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ", Yogyakarta")}&format=json&limit=3&addressdetails=1`;
  fetch(url, { headers: { "Accept-Language": "id" } })
    .then((r) => r.json())
    .then((data) => {
      data.slice(0, 3).forEach((place) => {
        const item = document.createElement("div");
        item.className = "sr-item";
        item.innerHTML = `
          <span style="font-size:.9rem">📍</span>
          <div>
            <div class="sr-name">${place.name || place.display_name.split(",")[0]}</div>
            <div class="sr-addr">${place.display_name.split(",").slice(1, 3).join(",").trim()}</div>
          </div>`;
        item.onclick = () => {
          map.flyTo([+place.lat, +place.lon], 17);
          L.popup()
            .setLatLng([+place.lat, +place.lon])
            .setContent(`<b>📍 ${place.display_name.split(",")[0]}</b>`)
            .openOn(map);
          clearSearch();
        };
        drop.appendChild(item);
      });
      drop.classList.toggle("open", drop.children.length > 0);
    })
    .catch(() => {
      drop.classList.toggle("open", drop.children.length > 0);
    });

  drop.classList.toggle("open", localResults.length > 0);
}

function clearSearch() {
  document.getElementById("search-input").value = "";
  document.getElementById("search-drop").classList.remove("open");
}

// ─────────────────────────────────────────────────────────────
// DIRECTIONS (OSRM)
// ─────────────────────────────────────────────────────────────
function startDirectionTo(hotelId) {
  const h = HOTELS.find((x) => x.id === hotelId);
  if (!h) return;
  dirTo = [h.lat, h.lng];
  document.getElementById("dir-to").value = h.name;
  document.getElementById("dir-panel").classList.add("open");
  toast("📍 Masukkan titik awal atau gunakan lokasi Anda");
}

function openDirPanel() {
  document.getElementById("dir-panel").classList.add("open");
}
function closeDirPanel() {
  document.getElementById("dir-panel").classList.remove("open");
}

function useMyLocation() {
  if (!navigator.geolocation) {
    toast("❌ Geolokasi tidak tersedia");
    return;
  }
  toast("🔍 Mencari lokasi Anda...");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      dirFrom = [pos.coords.latitude, pos.coords.longitude];
      document.getElementById("dir-from").value =
        `${dirFrom[0].toFixed(5)}, ${dirFrom[1].toFixed(5)}`;
      toast("✅ Lokasi ditemukan");
    },
    () => {
      toast("❌ Izin lokasi ditolak");
    },
  );
}

async function getDirections() {
  const fromVal = document.getElementById("dir-from").value.trim();
  const toVal = document.getElementById("dir-to").value.trim();
  if (!fromVal && !dirFrom) {
    toast("⚠️ Masukkan titik awal atau gunakan lokasi Anda");
    return;
  }
  if (!toVal && !dirTo) {
    toast("⚠️ Masukkan tujuan hotel");
    return;
  }

  toast("🔍 Mencari koordinat...");

  // Resolve origin
  if (!dirFrom) {
    const r = await geocode(fromVal);
    if (!r) {
      toast("❌ Titik awal tidak ditemukan. Coba nama jalan / landmark.");
      return;
    }
    dirFrom = r;
  }

  // Resolve destination
  if (!dirTo) {
    const found = HOTELS.find((h) =>
      h.name.toLowerCase().includes(toVal.toLowerCase()),
    );
    if (found) {
      dirTo = [found.lat, found.lng];
    } else {
      const r = await geocode(toVal);
      if (!r) {
        toast("❌ Tujuan tidak ditemukan.");
        return;
      }
      dirTo = r;
    }
  }

  toast("🛣️ Menghitung rute...");

  // Hapus rute lama (tapi simpan dirFrom/dirTo)
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  routeMarkers.forEach((m) => map.removeLayer(m));
  routeMarkers = [];

  // Coba beberapa OSRM endpoint (fallback)
  const OSRM_URLS = [
    `https://router.project-osrm.org/route/v1/driving/${dirFrom[1]},${dirFrom[0]};${dirTo[1]},${dirTo[0]}?overview=full&geometries=geojson`,
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${dirFrom[1]},${dirFrom[0]};${dirTo[1]},${dirTo[0]}?overview=full&geometries=geojson`,
  ];

  let success = false;
  for (const url of OSRM_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.code !== "Ok" || !data.routes.length) continue;

      const route = data.routes[0];
      const coords = route.geometry.coordinates.map((c) => [c[1], c[0]]);
      const dist = (route.distance / 1000).toFixed(1);
      const time = Math.round(route.duration / 60);

      // Gambar rute di peta
      routeLayer = L.polyline(coords, {
  color: "#1A73E8",
  weight: window.innerWidth <= 768 ? 5 : 6,
  opacity: 0.9,
  smoothFactor: 2,
  interactive: false
}).addTo(map);

      // Shadow rute (efek Google Maps)
      const shadowRoute = L.polyline(coords, {
  color: "#0D47A1",
  weight: 8,
  opacity: 0.18,
  interactive: false
}).addTo(map);

routeMarkers.push(shadowRoute);

      // Marker A dan B
      const mkA = L.marker(dirFrom, {
        icon: pinIcon("A", "#16A34A"),
        zIndexOffset: 1000,
      })
        .addTo(map)
        .bindPopup("📍 <b>Titik Awal</b>")
        .openPopup();
      const mkB = L.marker(dirTo, {
        icon: pinIcon("B", "#DC2626"),
        zIndexOffset: 1000,
      })
        .addTo(map)
        .bindPopup("🏨 <b>Tujuan</b>");
      routeMarkers.push(mkA, mkB);

      map.fitBounds(routeLayer.getBounds(), {
  paddingTopLeft: [20, 100],
  paddingBottomRight: [20, 180],
  animate: true,
  duration: 0.8,
  maxZoom: 16
});
      const result = document.getElementById("dir-result");
      result.innerHTML = `🛣️ <b>${dist} km</b> &nbsp;·&nbsp; ⏱️ <b>${time} menit</b> mengemudi`;
      result.style.display = "block";
      toast(`✅ Rute ditemukan: ${dist} km · ${time} menit`);
      success = true;
      break;
    } catch (e) {
      continue; // coba endpoint berikutnya
    }
  }

  if (!success) {
    // Fallback: gambar garis lurus
    routeLayer = L.polyline([dirFrom, dirTo], {
      color: "#1A73E8",
      weight: 4,
      opacity: 0.7,
      dashArray: "10,8",
    }).addTo(map);
    routeMarkers.push(routeLayer);
    const mkA = L.marker(dirFrom, { icon: pinIcon("A", "#16A34A") })
      .addTo(map)
      .bindPopup("📍 Titik Awal")
      .openPopup();
    const mkB = L.marker(dirTo, { icon: pinIcon("B", "#DC2626") })
      .addTo(map)
      .bindPopup("🏨 Tujuan");
    routeMarkers.push(mkA, mkB);
    map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
    const d = (map.distance(dirFrom, dirTo) / 1000).toFixed(1);
    const result = document.getElementById("dir-result");
    result.innerHTML = `📏 Jarak lurus: <b>${d} km</b> <small style="color:#D97706">(rute jalan tidak tersedia saat ini)</small>`;
    result.style.display = "block";
    toast("⚠️ Server routing sibuk, menampilkan jarak lurus");
  }
}

async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ", Yogyakarta")}&format=json&limit=1`;
  try {
    const r = await fetch(url, { headers: { "Accept-Language": "id" } });
    const d = await r.json();
    if (d.length) return [+d[0].lat, +d[0].lon];
  } catch {}
  return null;
}

function clearRoute() {
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  routeMarkers.forEach((m) => {
    try {
      map.removeLayer(m);
    } catch {}
  });
  routeMarkers = [];
  dirFrom = null;
  dirTo = null;
  document.getElementById("dir-from").value = "";
  document.getElementById("dir-to").value = "";
  const r = document.getElementById("dir-result");
  if (r) {
    r.innerHTML = "";
    r.style.display = "none";
  }
  toast("✕ Rute dihapus");
}

function pinIcon(label, color) {
  return L.divIcon({
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};
           color:#fff;font-weight:700;font-size:.78rem;display:flex;align-items:center;
           justify-content:center;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.3)">${label}</div>`,
    className: "",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// ─────────────────────────────────────────────────────────────
// SURROUNDINGS — multi-endpoint + fallback data statis rapat
// Selalu tampilkan data, tidak pernah kosong
// ─────────────────────────────────────────────────────────────
const TYPE_ICON = {
  restaurant: "🍽️",
  cafe: "☕",
  fast_food: "🍔",
  food_court: "🍱",
  atm: "🏧",
  bank: "🏦",
  pharmacy: "💊",
  hospital: "🏥",
  clinic: "🏥",
  fuel: "⛽",
  parking: "🅿️",
  school: "🏫",
  university: "🎓",
  mosque: "🕌",
  church: "⛪",
  place_of_worship: "🛕",
  supermarket: "🛒",
  convenience: "🏪",
  mall: "🏬",
  shop: "🛍️",
  attraction: "🗺️",
  museum: "🏛️",
  park: "🌳",
  playground: "🎠",
  stadium: "🏟️",
  station: "🚉",
  bus_stop: "🚌",
  marketplace: "🏪",
  viewpoint: "👁️",
  library: "📚",
  post_office: "📮",
};

/* ── Data statis rapat — melingkupi seluruh Kota Yogyakarta ── */
const POI_STATIC = [
  /* ── Kawasan Malioboro / Gedongtengen ── */
  {
    lat: -7.7928,
    lon: 110.365,
    icon: "🛍️",
    name: "Malioboro Mall",
    type: "Pusat Perbelanjaan",
  },
  {
    lat: -7.7945,
    lon: 110.3658,
    icon: "🏪",
    name: "Pasar Beringharjo",
    type: "Pasar Tradisional",
  },
  {
    lat: -7.7946,
    lon: 110.3662,
    icon: "🏛️",
    name: "Benteng Vredeburg",
    type: "Museum",
  },
  {
    lat: -7.792,
    lon: 110.364,
    icon: "🏧",
    name: "ATM BCA Malioboro",
    type: "ATM",
  },
  {
    lat: -7.795,
    lon: 110.3655,
    icon: "🍔",
    name: "KFC Malioboro",
    type: "Restoran",
  },
  {
    lat: -7.7935,
    lon: 110.3648,
    icon: "☕",
    name: "Starbucks Malioboro",
    type: "Kafe",
  },
  {
    lat: -7.7915,
    lon: 110.3645,
    icon: "⛽",
    name: "SPBU Malioboro",
    type: "SPBU",
  },
  {
    lat: -7.793,
    lon: 110.3638,
    icon: "🚌",
    name: "Halte Trans Jogja Malioboro",
    type: "Halte Bus",
  },
  {
    lat: -7.796,
    lon: 110.367,
    icon: "🏥",
    name: "Klinik Pratama Gedongtengen",
    type: "Klinik",
  },
  {
    lat: -7.794,
    lon: 110.368,
    icon: "💊",
    name: "Apotek K-24 Malioboro",
    type: "Apotek",
  },
  /* ── Kawasan Jetis / Tugu ── */
  {
    lat: -7.786,
    lon: 110.3677,
    icon: "🚉",
    name: "Stasiun Tugu",
    type: "Stasiun Kereta",
  },
  {
    lat: -7.7893,
    lon: 110.364,
    icon: "🏥",
    name: "RS Bethesda Yogyakarta",
    type: "Rumah Sakit",
  },
  {
    lat: -7.788,
    lon: 110.372,
    icon: "🏬",
    name: "Ramai Mall",
    type: "Pusat Perbelanjaan",
  },
  {
    lat: -7.7855,
    lon: 110.37,
    icon: "🍽️",
    name: "Restoran Progo",
    type: "Restoran",
  },
  {
    lat: -7.787,
    lon: 110.366,
    icon: "🏧",
    name: "ATM Mandiri Jetis",
    type: "ATM",
  },
  { lat: -7.7845, lon: 110.3655, icon: "⛽", name: "SPBU Jetis", type: "SPBU" },
  {
    lat: -7.783,
    lon: 110.368,
    icon: "🏫",
    name: "SMA Negeri 3 Yogyakarta",
    type: "Sekolah",
  },
  {
    lat: -7.7848,
    lon: 110.3636,
    icon: "🗺️",
    name: "Tugu Yogyakarta",
    type: "Landmark",
  },
  {
    lat: -7.7865,
    lon: 110.37,
    icon: "🕌",
    name: "Masjid Agung Jetis",
    type: "Masjid",
  },
  {
    lat: -7.79,
    lon: 110.3655,
    icon: "☕",
    name: "Angkringan Tugu",
    type: "Kafe",
  },
  /* ── Kawasan Gondomanan / Kraton ── */
  {
    lat: -7.8053,
    lon: 110.3643,
    icon: "🗺️",
    name: "Kraton Yogyakarta",
    type: "Objek Wisata",
  },
  {
    lat: -7.8012,
    lon: 110.3635,
    icon: "🌳",
    name: "Alun-alun Utara",
    type: "Taman Kota",
  },
  {
    lat: -7.791,
    lon: 110.371,
    icon: "🛍️",
    name: "Mirota Batik",
    type: "Toko Souvenir",
  },
  {
    lat: -7.7935,
    lon: 110.371,
    icon: "📚",
    name: "Gramedia Sudirman",
    type: "Toko Buku",
  },
  {
    lat: -7.791,
    lon: 110.3725,
    icon: "🏥",
    name: "RS Panti Rapih",
    type: "Rumah Sakit",
  },
  {
    lat: -7.7925,
    lon: 110.37,
    icon: "🏧",
    name: "ATM BNI Gondomanan",
    type: "ATM",
  },
  {
    lat: -7.79,
    lon: 110.372,
    icon: "🍽️",
    name: "Gudeg Yu Djum",
    type: "Restoran",
  },
  {
    lat: -7.795,
    lon: 110.372,
    icon: "🏬",
    name: "Malioboro Trade Center",
    type: "Pusat Perbelanjaan",
  },
  {
    lat: -7.801,
    lon: 110.367,
    icon: "🕌",
    name: "Masjid Gedhe Mataram",
    type: "Masjid",
  },
  /* ── Kawasan Ngampilan / Wirobrajan ── */
  {
    lat: -7.7962,
    lon: 110.3558,
    icon: "⛽",
    name: "SPBU Wirobrajan",
    type: "SPBU",
  },
  {
    lat: -7.798,
    lon: 110.358,
    icon: "🏪",
    name: "Pasar Kranggan",
    type: "Pasar Tradisional",
  },
  {
    lat: -7.802,
    lon: 110.3578,
    icon: "🏥",
    name: "RS PKU Muhammadiyah",
    type: "Rumah Sakit",
  },
  {
    lat: -7.8015,
    lon: 110.356,
    icon: "🏫",
    name: "SMP Negeri 8 Yogyakarta",
    type: "Sekolah",
  },
  {
    lat: -7.7975,
    lon: 110.36,
    icon: "🕌",
    name: "Masjid Nurul Huda Wirobrajan",
    type: "Masjid",
  },
  {
    lat: -7.794,
    lon: 110.357,
    icon: "🏧",
    name: "ATM BRI Ngampilan",
    type: "ATM",
  },
  {
    lat: -7.8035,
    lon: 110.355,
    icon: "🌳",
    name: "Taman Wirobrajan",
    type: "Taman",
  },
  {
    lat: -7.796,
    lon: 110.354,
    icon: "💊",
    name: "Apotek Kimia Farma Wirobrajan",
    type: "Apotek",
  },
  /* ── Kawasan Mergangsan / Prawirotaman ── */
  {
    lat: -7.805,
    lon: 110.372,
    icon: "🎨",
    name: "Kawasan Seni Prawirotaman",
    type: "Kawasan Wisata",
  },
  {
    lat: -7.8065,
    lon: 110.37,
    icon: "🛍️",
    name: "Batik Winotosastro",
    type: "Toko Batik",
  },
  { lat: -7.808, lon: 110.371, icon: "☕", name: "Kafe Via Via", type: "Kafe" },
  {
    lat: -7.8038,
    lon: 110.369,
    icon: "🏧",
    name: "ATM BCA Prawirotaman",
    type: "ATM",
  },
  {
    lat: -7.8058,
    lon: 110.366,
    icon: "🍽️",
    name: "Warung Brongto",
    type: "Restoran",
  },
  {
    lat: -7.8025,
    lon: 110.3675,
    icon: "💊",
    name: "Apotek Prawirotaman",
    type: "Apotek",
  },
  {
    lat: -7.809,
    lon: 110.3715,
    icon: "⛽",
    name: "SPBU Parangtritis",
    type: "SPBU",
  },
  /* ── Kawasan Umbulharjo ── */
  {
    lat: -7.7995,
    lon: 110.3878,
    icon: "🏪",
    name: "Pasar Giwangan",
    type: "Pasar Tradisional",
  },
  {
    lat: -7.8038,
    lon: 110.391,
    icon: "🏫",
    name: "SMA Negeri 8 Yogyakarta",
    type: "Sekolah",
  },
  {
    lat: -7.795,
    lon: 110.382,
    icon: "🏧",
    name: "ATM BCA Umbulharjo",
    type: "ATM",
  },
  {
    lat: -7.802,
    lon: 110.389,
    icon: "🕌",
    name: "Masjid Al-Ikhlas Umbulharjo",
    type: "Masjid",
  },
  {
    lat: -7.798,
    lon: 110.3845,
    icon: "⛽",
    name: "SPBU Kusumanegara",
    type: "SPBU",
  },
  {
    lat: -7.801,
    lon: 110.386,
    icon: "🍽️",
    name: "Restoran Lesehan Umbulharjo",
    type: "Restoran",
  },
  {
    lat: -7.796,
    lon: 110.384,
    icon: "💊",
    name: "Apotek Kimia Farma Umbulharjo",
    type: "Apotek",
  },
  {
    lat: -7.805,
    lon: 110.392,
    icon: "🏥",
    name: "Puskesmas Umbulharjo",
    type: "Puskesmas",
  },
  /* ── Kawasan Gondokusuman ── */
  {
    lat: -7.7815,
    lon: 110.3845,
    icon: "🏬",
    name: "Ambarukmo Plaza",
    type: "Pusat Perbelanjaan",
  },
  {
    lat: -7.783,
    lon: 110.38,
    icon: "🎓",
    name: "Universitas Gadjah Mada",
    type: "Universitas",
  },
  { lat: -7.78, lon: 110.382, icon: "🏧", name: "ATM BNI UGM", type: "ATM" },
  {
    lat: -7.785,
    lon: 110.383,
    icon: "☕",
    name: "Kafe Kopitiam Sagan",
    type: "Kafe",
  },
  {
    lat: -7.782,
    lon: 110.386,
    icon: "⛽",
    name: "SPBU Adisucipto",
    type: "SPBU",
  },
  {
    lat: -7.781,
    lon: 110.387,
    icon: "🍽️",
    name: "Ayam Geprek Sagan",
    type: "Restoran",
  },
  {
    lat: -7.784,
    lon: 110.381,
    icon: "🕌",
    name: "Masjid Kampus UGM",
    type: "Masjid",
  },
  { lat: -7.78, lon: 110.378, icon: "🏥", name: "Klinik UGM", type: "Klinik" },
  /* ── Kawasan Tegalrejo ── */
  {
    lat: -7.7715,
    lon: 110.3468,
    icon: "🕌",
    name: "Masjid Tegalrejo",
    type: "Masjid",
  },
  {
    lat: -7.773,
    lon: 110.348,
    icon: "🏫",
    name: "SMP Negeri 12 Yogyakarta",
    type: "Sekolah",
  },
  {
    lat: -7.7752,
    lon: 110.3445,
    icon: "⛽",
    name: "SPBU Magelang",
    type: "SPBU",
  },
  {
    lat: -7.77,
    lon: 110.346,
    icon: "🏪",
    name: "Pasar Tegalrejo",
    type: "Pasar",
  },
  {
    lat: -7.772,
    lon: 110.349,
    icon: "🏧",
    name: "ATM BRI Tegalrejo",
    type: "ATM",
  },
  {
    lat: -7.776,
    lon: 110.346,
    icon: "💊",
    name: "Apotek Tegalrejo",
    type: "Apotek",
  },
  /* ── Kawasan Kotagede ── */
  {
    lat: -7.8122,
    lon: 110.3845,
    icon: "⚙️",
    name: "Kawasan Perak Kotagede",
    type: "Kawasan Wisata",
  },
  {
    lat: -7.8108,
    lon: 110.3882,
    icon: "🕌",
    name: "Masjid Gedhe Mataram Kotagede",
    type: "Masjid",
  },
  {
    lat: -7.813,
    lon: 110.387,
    icon: "🛍️",
    name: "Toko Perak Kotagede",
    type: "Toko Kerajinan",
  },
  {
    lat: -7.8145,
    lon: 110.386,
    icon: "🍽️",
    name: "Warung Makan Kotagede",
    type: "Restoran",
  },
  {
    lat: -7.8118,
    lon: 110.3855,
    icon: "🏧",
    name: "ATM BRI Kotagede",
    type: "ATM",
  },
  { lat: -7.81, lon: 110.384, icon: "⛽", name: "SPBU Kotagede", type: "SPBU" },
  /* ── Kawasan Mantrijeron ── */
  {
    lat: -7.8105,
    lon: 110.3635,
    icon: "🏪",
    name: "Pasar Bantul Utara",
    type: "Pasar",
  },
  {
    lat: -7.807,
    lon: 110.365,
    icon: "🏧",
    name: "ATM BNI Mantrijeron",
    type: "ATM",
  },
  {
    lat: -7.809,
    lon: 110.362,
    icon: "🕌",
    name: "Masjid Mantrijeron",
    type: "Masjid",
  },
  {
    lat: -7.8115,
    lon: 110.361,
    icon: "🏫",
    name: "SMA Muhammadiyah 3 Yogyakarta",
    type: "Sekolah",
  },
  {
    lat: -7.8195,
    lon: 110.363,
    icon: "🌳",
    name: "Alun-alun Selatan",
    type: "Taman Kota",
  },
  {
    lat: -7.8099,
    lon: 110.3592,
    icon: "🗺️",
    name: "Taman Sari",
    type: "Objek Wisata",
  },
  {
    lat: -7.808,
    lon: 110.36,
    icon: "💊",
    name: "Apotek Kimia Farma Mantrijeron",
    type: "Apotek",
  },
  /* ── Kawasan Pakualaman / Danurejan ── */
  {
    lat: -7.7972,
    lon: 110.3765,
    icon: "🗺️",
    name: "Puro Pakualaman",
    type: "Objek Wisata",
  },
  {
    lat: -7.796,
    lon: 110.375,
    icon: "🏧",
    name: "ATM BCA Pakualaman",
    type: "ATM",
  },
  {
    lat: -7.795,
    lon: 110.374,
    icon: "🍽️",
    name: "Warung Soto Pak Dhe",
    type: "Restoran",
  },
  {
    lat: -7.7968,
    lon: 110.376,
    icon: "🕌",
    name: "Masjid Pakualaman",
    type: "Masjid",
  },
  {
    lat: -7.7982,
    lon: 110.3718,
    icon: "🏪",
    name: "Pasar Legi",
    type: "Pasar",
  },
  {
    lat: -7.7958,
    lon: 110.3712,
    icon: "🏫",
    name: "SMP Negeri 5 Yogyakarta",
    type: "Sekolah",
  },
  /* ── Kawasan Kraton ── */
  {
    lat: -7.8053,
    lon: 110.3643,
    icon: "🗺️",
    name: "Kraton Yogyakarta",
    type: "Objek Wisata",
  },
  {
    lat: -7.803,
    lon: 110.363,
    icon: "🏛️",
    name: "Museum Kereta Kraton",
    type: "Museum",
  },
  {
    lat: -7.804,
    lon: 110.362,
    icon: "🛍️",
    name: "Pasar Ngasem",
    type: "Pasar",
  },
  {
    lat: -7.8015,
    lon: 110.3615,
    icon: "🍽️",
    name: "Warung Pecel Bu Wiryo",
    type: "Restoran",
  },
  {
    lat: -7.8055,
    lon: 110.36,
    icon: "🏧",
    name: "ATM BNI Kraton",
    type: "ATM",
  },
];

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
];

async function fetchOverpass(query, ms = 8000) {
  for (const url of OVERPASS_URLS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      const r = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const d = await r.json();
      if (d && d.elements) return d;
    } catch (e) {
      /* coba endpoint berikutnya */
    }
  }
  return null;
}

/* Fallback statis — cari dalam radius, perluas jika perlu */
function staticPOI(lat, lng, maxR = 700) {
  let found = POI_STATIC.map((p) => ({
    ...p,
    dist: map.distance([lat, lng], [p.lat, p.lon]),
  }))
    .filter((p) => p.dist <= maxR)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);

  /* Jika kurang dari 3 item, perluas radius */
  if (found.length < 3) {
    found = POI_STATIC.map((p) => ({
      ...p,
      dist: map.distance([lat, lng], [p.lat, p.lon]),
    }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);
  }
  return found;
}

async function showSurroundings(h) {
  if (radiusLayer) {
    map.removeLayer(radiusLayer);
    radiusLayer = null;
  }
  if (surroundLayer) {
    map.removeLayer(surroundLayer);
    surroundLayer = null;
  }

  radiusLayer = L.circle([h.lat, h.lng], {
    radius: 500,
    color: "#0B9F97",
    fillColor: "#0B9F97",
    fillOpacity: 0.06,
    weight: 1.5,
    dashArray: "6,4",
  }).addTo(map);

  const panel = document.getElementById("surr-panel");
  const body = document.getElementById("surr-body");
  panel.classList.add("open");
  body.innerHTML = `<div class="surr-item">
    <span class="surr-icon">⏳</span>
    <span class="surr-name">Memuat area sekitar...</span>
  </div>`;

  const query = `[out:json][timeout:8];
(
  node["amenity"~"restaurant|cafe|fast_food|atm|hospital|clinic|pharmacy|bank|fuel|parking|school|mosque|place_of_worship|marketplace|supermarket|convenience|food_court|post_office|library"](around:600,${h.lat},${h.lng});
  node["tourism"~"attraction|museum|viewpoint"](around:600,${h.lat},${h.lng});
  node["shop"~"convenience|supermarket|souvenir|batik|mall"](around:600,${h.lat},${h.lng});
  node["leisure"~"park|playground|stadium"](around:600,${h.lat},${h.lng});
);
out 15;`;

  const data = await fetchOverpass(query, 7000);
  let items = [];
  let isAPI = false;

  if (data && data.elements) {
    const raw = data.elements
      .filter((el) => el.tags && el.tags.name)
      .map((el) => ({
        lat: el.lat,
        lon: el.lon,
        name: el.tags.name,
        type:
          el.tags.amenity ||
          el.tags.tourism ||
          el.tags.shop ||
          el.tags.leisure ||
          "",
        dist: map.distance([h.lat, h.lng], [el.lat, el.lon]),
      }))
      .filter((el) => el.dist <= 700)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 10);

    if (raw.length >= 2) {
      items = raw;
      isAPI = true;
    }
  }

  /* Fallback: data statis (selalu ada) */
  if (!isAPI) {
    const fb = staticPOI(h.lat, h.lng, 700);
    items = fb.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      name: p.name,
      type: p.type,
      icon: p.icon,
      dist: p.dist,
    }));
  }

  /* Render */
  const html = items
    .map((el) => {
      const icon =
        el.icon ||
        TYPE_ICON[el.type] ||
        TYPE_ICON[(el.type || "").split(";")[0]] ||
        "📍";
      const d =
        el.dist < 1000
          ? Math.round(el.dist) + "m"
          : (el.dist / 1000).toFixed(1) + "km";
      return `<div class="surr-item">
      <span class="surr-icon">${icon}</span>
      <span class="surr-name">${el.name}</span>
      <span class="surr-dist">${d}</span>
    </div>`;
    })
    .join("");

  body.innerHTML =
    (isAPI
      ? ""
      : `<div style="font-size:.63rem;color:#D97706;padding:.25rem .45rem;
      background:rgba(217,119,6,.1);border-radius:4px;margin-bottom:.35rem">
      📡 Data lokal — koneksi API terbatas</div>`) + html;

  /* Dots di peta */
  surroundLayer = L.layerGroup();
  items.forEach((el) => {
    const icon = el.icon || TYPE_ICON[el.type] || "📍";
    L.circleMarker([el.lat, el.lon], {
      radius: 5,
      color: "#2563EB",
      fillColor: "#2563EB",
      fillOpacity: 0.7,
      weight: 1.5,
    })
      .bindPopup(`${icon} <b>${el.name}</b>`)
      .addTo(surroundLayer);
  });
  surroundLayer.addTo(map);
}

function closeSurroundings() {
  document.getElementById("surr-panel").classList.remove("open");
  if (radiusLayer) {
    map.removeLayer(radiusLayer);
    radiusLayer = null;
  }
  if (surroundLayer) {
    map.removeLayer(surroundLayer);
    surroundLayer = null;
  }
}

// ── Map click (for direction picking) ────────────────────────
function onMapClick(e) {
  if (dirMode) {
    dirFrom = [e.latlng.lat, e.latlng.lng];
    document.getElementById("dir-from").value =
      `${dirFrom[0].toFixed(5)}, ${dirFrom[1].toFixed(5)}`;
    toast("✅ Titik awal dipilih");
    dirMode = false;
    map.getContainer().style.cursor = "";
  }
}

function pickFromMap() {
  dirMode = true;
  map.getContainer().style.cursor = "crosshair";
  toast("🖱️ Klik lokasi awal di peta");
}

// ── Layer toggle ──────────────────────────────────────────────
function toggleLayer(type) {
  if (type === "hotels") {
    const el = document.getElementById("toggle-hotels");
    if (clusterGroup && map.hasLayer(clusterGroup)) {
      map.removeLayer(clusterGroup);
      el && el.classList.add("off");
      toast("🙈 Hotel disembunyikan");
    } else if (clusterGroup) {
      clusterGroup.addTo(map);
      el && el.classList.remove("off");
      toast("👁️ Hotel ditampilkan");
    }
  } else if (type === "admin") {
    const el = document.getElementById("toggle-admin");
    if (!adminLayerGroup) {
      toast("⏳ Memuat batas wilayah...");
      loadYogyaBoundary().then(() => {
        el && el.classList.remove("off");
      });
      return;
    }
    if (map.hasLayer(adminLayerGroup)) {
      map.removeLayer(adminLayerGroup);
      el && el.classList.add("off");
      toast("🙈 Batas administrasi disembunyikan");
    } else {
      adminLayerGroup.addTo(map);
      el && el.classList.remove("off");
      toast("👁️ Batas administrasi ditampilkan");
    }
  }
}

// ─────────────────────────────────────────────────────────────
// DETAIL PANEL
// ─────────────────────────────────────────────────────────────
function openDetail(id) {
  const h = HOTELS.find((x) => x.id === id);
  if (!h) return;

  document.getElementById("d-breadcrumb").innerHTML =
    `DATABASE <span class="bc-sep" style="color:rgba(255,255,255,.3)">›</span>
     ACCOMMODATION <span class="bc-sep" style="color:rgba(255,255,255,.3)">›</span>
     <span>${id}</span>`;

  document.getElementById("d-hotel-name").textContent = h.name;

  document.getElementById("d-badges").innerHTML =
    `<span class="d-badge d-badge-active">● ACTIVE MARKER</span>
     <span class="d-badge d-badge-id">ID: ${h.id}</span>
     <span class="d-badge d-badge-id">${h.category}</span>`;

  document.getElementById("d-lat").textContent = h.lat.toFixed(6);
  document.getElementById("d-lng").textContent = h.lng.toFixed(6);

  document.getElementById("d-landuse").innerHTML = h.landuse
    .map(
      (l, i) =>
        `<span class="lu-tag ${i ? "lu-tag-b" : "lu-tag-a"}">${l.toUpperCase()}</span>`,
    )
    .join("");

  document.getElementById("d-meta").textContent = h.notes;

  // Proximity to landmarks
  const landmarks = [
    { name: "TO TUGU", dist: distKm(h.lat, h.lng, -7.7829, 110.3667) },
    { name: "TO MALIOBORO", dist: distKm(h.lat, h.lng, -7.7928, 110.365) },
    { name: "TO KRATON", dist: distKm(h.lat, h.lng, -7.8053, 110.3643) },
  ];
  document.getElementById("d-prox").innerHTML = landmarks
    .map(
      (l) => `
    <div class="prox-lm-item">
      <div class="prox-lm-name">${l.name}</div>
      <div class="prox-lm-val">${l.dist}</div>
      <div class="prox-lm-unit">km</div>
    </div>`,
    )
    .join("");

  showScreen("s-detail");

  setTimeout(() => {
    if (!detailMapInited) {
      detailMap = L.map("detail-map", {
        center: [h.lat, h.lng],
        zoom: 15,
        zoomControl: true,
        attributionControl: false,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(detailMap);
      detailMapInited = true;
    } else {
      detailMap.setView([h.lat, h.lng], 15);
    }
    detailMap.eachLayer((l) => {
      if (l instanceof L.Marker || l instanceof L.Circle)
        detailMap.removeLayer(l);
    });

    L.circle([h.lat, h.lng], {
      radius: 500,
      color: "#0B9F97",
      fillColor: "#0B9F97",
      fillOpacity: 0.08,
      weight: 1.5,
      dashArray: "6,4",
    }).addTo(detailMap);

    L.marker([h.lat, h.lng], {
      icon: L.divIcon({
        html: `<div style="width:14px;height:14px;border-radius:50%;background:#0B9F97;
               border:3px solid white;box-shadow:0 0 12px rgba(11,159,151,.7)"></div>`,
        className: "",
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    })
      .addTo(detailMap)
      .bindPopup(h.name)
      .openPopup();
  }, 120);
}

function distKm(lat1, lng1, lat2, lng2) {
  if (!map) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
  }
  return (map.distance([lat1, lng1], [lat2, lng2]) / 1000).toFixed(1);
}

function copyCoords() {
  const lat = document.getElementById("d-lat").textContent;
  const lng = document.getElementById("d-lng").textContent;
  navigator.clipboard
    .writeText(`${lat}, ${lng}`)
    .then(() => toast("📋 Koordinat disalin!"));
}

function backFromDetail() {
  showScreen("s-map");
}

// ─────────────────────────────────────────────────────────────
// ANALYSIS
// ─────────────────────────────────────────────────────────────
function openAnalysis() {
  showScreen("s-analysis");
  setTimeout(() => {
    drawHeatmap();
    animateMetrics();
    buildProxTable();
    buildDensityChart();
  }, 100);
}

function drawHeatmap() {
  const canvas = document.getElementById("heatmap-canvas");
  if (!canvas) return;
  const W = (canvas.width = canvas.offsetWidth * window.devicePixelRatio);
  const H = (canvas.height = canvas.offsetHeight * window.devicePixelRatio);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  const ctx = canvas.getContext("2d");

  /* Latar */
  ctx.fillStyle = "#0C1929";
  ctx.fillRect(0, 0, W, H);

  /* Grid tipis */
  ctx.strokeStyle = "rgba(255,255,255,.04)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  /* Transformasi koordinat → pixel */
  const LN = -7.85,
    LX = -7.74,
    LgN = 110.33,
    LgX = 110.42;
  const tx = (lat, lng) => [
    ((lng - LgN) / (LgX - LgN)) * W,
    ((lat - LX) / (LN - LX)) * H,
  ];

  /* ── KDE — Kernel Density Estimation ──────────────────────
     Setiap hotel punya bobot SAMA (tidak pakai capacity/wsm).
     Hanya menunjukkan distribusi spasial koordinat hotel.
     Sumber data: koordinat GPS dari OpenStreetMap.
     Warna terang = banyak hotel berkumpul di satu area.
  ─────────────────────────────────────────────────────────── */
  const KERNEL_R = (W / 700) * 44;
  ctx.globalCompositeOperation = "screen";

  HOTELS.forEach((h) => {
    const [x, y] = tx(h.lat, h.lng);
    const g = ctx.createRadialGradient(x, y, 0, x, y, KERNEL_R);
    g.addColorStop(0.0, "rgba(255,160, 40,0.55)");
    g.addColorStop(0.35, "rgba(255,100, 10,0.28)");
    g.addColorStop(0.7, "rgba( 30,100,220,0.13)");
    g.addColorStop(1.0, "rgba(  0,  0,  0,0.00)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

  ctx.globalCompositeOperation = "source-over";

  /* Batas kota */
  const border = [
    [-7.75, 110.34],
    [-7.75, 110.41],
    [-7.77, 110.42],
    [-7.8, 110.42],
    [-7.83, 110.41],
    [-7.85, 110.39],
    [-7.85, 110.36],
    [-7.83, 110.34],
    [-7.8, 110.33],
    [-7.77, 110.33],
    [-7.75, 110.34],
  ];
  ctx.beginPath();
  border.forEach(([lt, lg], i) => {
    const [x, y] = tx(lt, lg);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = "rgba(11,207,197,.6)";
  ctx.lineWidth = 2;
  ctx.stroke();

  /* Titik hotel — warna sesuai kategori bintang */
  HOTELS.forEach((h) => {
    const [x, y] = tx(h.lat, h.lng);
    const meta = CAT_META[h.category] || {};
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = meta.color || "#fff";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  });
}

function animateMetrics() {
  document.querySelectorAll(".mfill[data-t]").forEach((b) => {
    setTimeout(() => {
      b.style.width = b.dataset.t + "%";
    }, 250);
  });
}

function buildProxTable() {
  const tbody = document.getElementById("prox-tbody");
  if (!tbody) return;
  const rows = KECAMATAN_STATS.slice(0, 8).map((k) => {
    const hotels = HOTELS.filter((h) => h.kecamatan === k.name);
    const avgDist =
      hotels.reduce(
        (s, h) => s + distKm(h.lat, h.lng, -7.7928, 110.365) * 1,
        0,
      ) / hotels.length;
    const walkIdx = Math.max(1, Math.round(10 - avgDist * 1.5));
    const score = hotels.reduce((s, h) => s + h.geodesign, 0) / hotels.length;
    const status =
      avgDist < 0.8
        ? "OPTIMAL"
        : avgDist < 2
          ? "MODERATE"
          : avgDist < 4
            ? "ACTIONING"
            : "CRITICAL";
    const cls = {
      OPTIMAL: "tag-optimal",
      MODERATE: "tag-moderate",
      ACTIONING: "tag-actioning",
      CRITICAL: "tag-critical",
    }[status];
    const trend =
      status === "OPTIMAL" ? "↑" : status === "MODERATE" ? "→" : "↓";
    return `<tr>
      <td>${k.name}</td>
      <td class="mono">${k.count}</td>
      <td class="mono">${(avgDist * 1000).toFixed(0)}</td>
      <td class="mono">${walkIdx}</td>
      <td class="${cls}">${trend} ${status}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join("");
}

function buildDensityChart() {
  const canvas = document.getElementById("density-chart");
  if (!canvas) return;
  const W = (canvas.width = canvas.offsetWidth * window.devicePixelRatio);
  const H = (canvas.height = canvas.offsetHeight * window.devicePixelRatio);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // Bars: count by category
  const cats = Object.keys(CAT_META);
  const counts = cats.map((c) => HOTELS.filter((h) => h.category === c).length);
  const maxC = Math.max(...counts);
  const bw = (W - 60) / cats.length;
  const colors = cats.map((c) => CAT_META[c].color);

  ctx.fillStyle = "#F4F6FA";
  ctx.fillRect(0, 0, W, H);

  cats.forEach((cat, i) => {
    const bh = (counts[i] / maxC) * (H - 40);
    const x = 30 + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const y = H - 20 - bh;
    ctx.fillStyle = colors[i] + "CC";
    ctx.fillRect(x, y, w, bh);
    ctx.fillStyle = colors[i];
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = "#64748B";
    ctx.font = `${10 * window.devicePixelRatio}px monospace`;
    ctx.textAlign = "center";
    ctx.fillText(counts[i], x + w / 2, y - 6);
    ctx.fillStyle = "#94A3B8";
    ctx.font = `${8 * window.devicePixelRatio}px monospace`;
    ctx.fillText(
      ["B5", "B4", "B3", "B2", "BTK"][i] || cat.slice(0, 3),
      x + w / 2,
      H - 4,
    );
  });
}

// ── Downloads ─────────────────────────────────────────────────
function downloadJSON() {
  const blob = new Blob([JSON.stringify(HOTELS, null, 2)], {
    type: "application/json",
  });
  dlFile(blob, "hotel-yogyakarta.json");
}
function downloadCSV() {
  const hdr =
    "ID,Nama,Kategori,Bintang,Lat,Lng,Alamat,Kecamatan,Kamar,Kapasitas%,Geodesign";
  const rows = HOTELS.map(
    (h) =>
      `${h.id},"${h.name}","${h.category}",${h.stars},${h.lat},${h.lng},"${h.address}","${h.kecamatan}",${h.rooms},${h.capacity},${h.geodesign}`,
  );
  dlFile(
    new Blob([[hdr, ...rows].join("\n")], { type: "text/csv" }),
    "hotel-yogyakarta.csv",
  );
}
function dlFile(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  toast("💾 " + name + " diunduh");
}

// ── Init ──────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  showScreen("s-landing");
  buildKecTable();
  buildLpFooter();
});

function buildKecTable() {
  const tb = document.getElementById("kec-table-body");
  if (!tb) return;
  tb.innerHTML = KECAMATAN_STATS.map((k) => {
    const meta =
      CAT_META[HOTELS.find((h) => h.kecamatan === k.name)?.category] || {};
    const status =
      k.count >= 4 ? "DENSE" : k.count >= 2 ? "MODERATE" : "SPARSE";
    const cls = {
      DENSE: "tag-critical",
      MODERATE: "tag-moderate",
      SPARSE: "tag-optimal",
    }[status];
    return `<tr>
      <td style="display:flex;align-items:center;gap:.35rem">
        <div style="width:6px;height:6px;border-radius:50%;background:${meta.color || "#888"}"></div>
        ${k.name}
      </td>
      <td class="mono">${k.count}</td>
      <td class="${cls}" style="font-family:var(--mono);font-size:.68rem">${status}</td>
    </tr>`;
  }).join("");
}

function buildLpFooter() {
  const canvas = document.getElementById("lp-footer-canvas");
  if (!canvas) return;
  const W = (canvas.width = canvas.offsetWidth || 1200);
  const H = (canvas.height = canvas.offsetHeight || 140);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0C1929";
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "screen";
  HOTELS.forEach((h) => {
    const x = ((h.lng - 110.33) / (110.43 - 110.33)) * W;
    const y = ((h.lat - -7.74) / (-7.86 - -7.74)) * H;
    const r = W / 28;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0.0, "rgba(255,160,40,0.55)");
    g.addColorStop(0.5, "rgba(255,100,10,0.25)");
    g.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });
  ctx.globalCompositeOperation = "source-over";
}


/* ================= FINAL MOBILE UX v2 — SMOOTH SHEET, COMPACT POPUP, DRAG PANELS ================= */
(function () {
  const mq = window.matchMedia("(max-width: 768px)");
  let sheetReady = false;
  let lastSheetPx = 64;

  function isMobile() {
    return mq.matches;
  }

  function viewportH() {
    return (window.visualViewport && window.visualViewport.height) || window.innerHeight || 720;
  }

  function sidebar() {
    return document.querySelector(".app-sidebar");
  }

  function setVar(px) {
    document.documentElement.style.setProperty("--mobile-sheet-px", `${Math.round(px)}px`);
  }

  function setSheet(px, opts = {}) {
    const sb = sidebar();
    if (!sb || !isMobile()) return;
    const h = viewportH();
    const min = 48;
    const max = Math.round(h * 0.82);
    const val = Math.max(min, Math.min(max, px));
    lastSheetPx = val;
    sb.style.height = `${val}px`;
    setVar(val);
    sb.classList.toggle("sheet-dragging", !!opts.dragging);
    window.clearTimeout(sb._resizeT);
    sb._resizeT = window.setTimeout(() => {
      try { if (map) map.invalidateSize(); } catch {}
      updateMobileState();
      placeFloatingPanels();
    }, opts.fast ? 16 : 180);
  }

  function snap(px) {
    const h = viewportH();
    const points = [50, Math.round(h * 0.25), Math.round(h * 0.52), Math.round(h * 0.82)];
    let best = points[0];
    for (const p of points) if (Math.abs(px - p) < Math.abs(px - best)) best = p;
    setSheet(best);
  }

  function ensureHandle() {
    const sb = sidebar();
    if (!sb || sb.querySelector(".mobile-sheet-handle")) return;
    const handle = document.createElement("div");
    handle.className = "mobile-sheet-handle";
    handle.innerHTML = `<span aria-hidden="true"></span>`;
    sb.insertBefore(handle, sb.firstChild);

    let startY = 0, startH = 0, moved = false, active = false;
    const begin = (y) => {
      if (!isMobile()) return;
      active = true;
      moved = false;
      startY = y;
      startH = sb.getBoundingClientRect().height || lastSheetPx || 50;
      sb.classList.add("sheet-dragging");
    };
    const move = (y, ev) => {
      if (!active) return;
      const diff = startY - y;
      if (Math.abs(diff) > 3) moved = true;
      setSheet(startH + diff, { dragging: true, fast: true });
      if (ev && ev.cancelable) ev.preventDefault();
    };
    const end = () => {
      if (!active) return;
      active = false;
      sb.classList.remove("sheet-dragging");
      const cur = sb.getBoundingClientRect().height || lastSheetPx;
      if (!moved) {
        const h = viewportH();
        if (cur < h * 0.18) setSheet(Math.round(h * 0.52));
        else if (cur < h * 0.64) setSheet(Math.round(h * 0.82));
        else setSheet(50);
      } else snap(cur);
    };

    handle.addEventListener("touchstart", (e) => begin(e.touches[0].clientY), { passive: false });
    handle.addEventListener("touchmove", (e) => move(e.touches[0].clientY, e), { passive: false });
    handle.addEventListener("touchend", end, { passive: true });
    handle.addEventListener("touchcancel", end, { passive: true });
    handle.addEventListener("pointerdown", (e) => {
      begin(e.clientY);
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener("pointermove", (e) => move(e.clientY, e));
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function updateMobileState() {
    const mobile = isMobile();
    document.body.classList.toggle("mobile-map", mobile);
    const z = (typeof map !== "undefined" && map) ? map.getZoom() : 13;
    document.body.classList.toggle("mobile-zoom-out", mobile && z <= 13);
    document.body.classList.toggle("mobile-zoom-mid", mobile && z > 13 && z < 16);
    document.body.classList.toggle("mobile-zoom-in", mobile && z >= 16);
  }

  function panPopupAboveSheet() {
    if (!isMobile() || typeof map === "undefined" || !map) return;
    setTimeout(() => {
      try {
        const popupEl = document.querySelector(".leaflet-popup");
        if (!popupEl) return;
        const r = popupEl.getBoundingClientRect();
        const safeBottom = viewportH() - (lastSheetPx + 18);
        if (r.bottom > safeBottom) map.panBy([0, r.bottom - safeBottom + 16], { animate: true, duration: 0.25 });
      } catch {}
    }, 80);
  }

  function placeFloatingPanels() {
    if (!isMobile()) return;
    const panels = [document.getElementById("surr-panel"), document.getElementById("dir-panel")].filter(Boolean);
    const top = 76;
    const bottomLimit = viewportH() - lastSheetPx - 14;
    panels.forEach((p) => {
      if (!p.classList.contains("open")) return;
      if (!p.dataset.userMoved) {
        p.style.left = "12px";
        p.style.right = "12px";
        p.style.top = `${top}px`;
        p.style.bottom = "auto";
        p.style.maxHeight = `${Math.max(120, bottomLimit - top)}px`;
      }
    });
  }

  function makePanelDraggable(panel, headerSelector) {
    if (!panel || panel.dataset.dragReady === "1") return;
    panel.dataset.dragReady = "1";
    const header = panel.querySelector(headerSelector) || panel.firstElementChild || panel;
    header.classList.add("mobile-floating-drag-handle");
    let startX=0, startY=0, startLeft=0, startTop=0, active=false;
    const begin = (x,y) => {
      if (!isMobile()) return;
      const r = panel.getBoundingClientRect();
      startX=x; startY=y; startLeft=r.left; startTop=r.top; active=true;
      panel.dataset.userMoved = "1";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.width = `${Math.min(r.width, window.innerWidth - 24)}px`;
      panel.classList.add("floating-dragging");
    };
    const move = (x,y,ev) => {
      if(!active) return;
      const vw=window.innerWidth, vh=viewportH();
      const w=panel.getBoundingClientRect().width, h=panel.getBoundingClientRect().height;
      let left=startLeft + (x-startX);
      let top=startTop + (y-startY);
      left=Math.max(8, Math.min(vw-w-8, left));
      top=Math.max(70, Math.min(vh-lastSheetPx-h-10, top));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      if (ev && ev.cancelable) ev.preventDefault();
    };
    const end = () => { active=false; panel.classList.remove("floating-dragging"); };
    header.addEventListener("touchstart", e => begin(e.touches[0].clientX, e.touches[0].clientY), {passive:false});
    header.addEventListener("touchmove", e => move(e.touches[0].clientX, e.touches[0].clientY, e), {passive:false});
    header.addEventListener("touchend", end, {passive:true});
    header.addEventListener("pointerdown", e => { begin(e.clientX,e.clientY); try{header.setPointerCapture(e.pointerId)}catch{}; });
    header.addEventListener("pointermove", e => move(e.clientX,e.clientY,e));
    header.addEventListener("pointerup", end);
    header.addEventListener("pointercancel", end);
  }

  function setupFloatingPanels() {
    makePanelDraggable(document.getElementById("surr-panel"), ".surr-header");
    makePanelDraggable(document.getElementById("dir-panel"), ".dir-panel-header");
    placeFloatingPanels();
  }

  function init() {
    if (!isMobile()) return;
    ensureHandle();
    if (!sheetReady) {
      sheetReady = true;
      setSheet(50);
    }
    updateMobileState();
    setupFloatingPanels();
    if (typeof map !== "undefined" && map && !map._mobileUxV2) {
      map._mobileUxV2 = true;
      map.on("zoomend", () => { updateMobileState(); panPopupAboveSheet(); });
      map.on("popupopen", () => { updateMobileState(); panPopupAboveSheet(); });
    }
  }

  window.addEventListener("load", init);
  window.addEventListener("resize", () => { sheetReady = false; setTimeout(init, 80); });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", () => { setTimeout(() => { updateMobileState(); placeFloatingPanels(); panPopupAboveSheet(); }, 80); });

  const wrap = (name) => {
    const old = window[name];
    if (typeof old !== "function" || old._mobileWrapped) return;
    const fn = function(...args) {
      const ret = old.apply(this, args);
      setTimeout(() => { init(); setupFloatingPanels(); panPopupAboveSheet(); }, 120);
      return ret;
    };
    fn._mobileWrapped = true;
    window[name] = fn;
  };
  setTimeout(() => {
    ["showSurroundings", "openDirPanel", "startDirectionTo"].forEach(wrap);
  }, 0);
})();
