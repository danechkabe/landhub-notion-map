const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([50.28, 30.44], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const categoryTabs = Array.from(document.querySelectorAll(".category-tab"));
const processingFiltersNode = document.getElementById("processing-filters");
const statusChips = Array.from(document.querySelectorAll(".status-chip"));

const state = {
  category: "landmatch",
  processingStatuses: new Set(statusChips.map((button) => button.dataset.statusKey)),
};

let dataset = { categories: {} };
let markerLayer = L.layerGroup().addTo(map);

function normalizeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  return raw.includes("://") ? raw : `https://${raw.replace(/^\/+/, "")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markerIcon(item) {
  const color = escapeHtml(item.marker_color || "#e0b21b");
  const symbol = escapeHtml(item.marker_symbol || "📍");
  return L.divIcon({
    className: "parcel-marker",
    html: `<div class="emoji-pin" style="--marker-accent:${color}">${symbol}</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -14],
  });
}

function actionButton({ href, icon, label, modifier }) {
  const normalizedHref = normalizeUrl(href);
  if (!normalizedHref) return "";
  return `
    <a
      class="action-link action-link--${modifier}"
      href="${escapeHtml(normalizedHref)}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      <img src="./assets/${escapeHtml(icon)}" alt="" />
    </a>
  `;
}

function popupMarkup(item) {
  return `
    <article class="parcel-popup">
      <h3>${escapeHtml(item.name)}</h3>
      <div class="popup-meta">
        <div>
          <span class="popup-label">Площа</span>
          <strong>${escapeHtml(item.area || "—")}</strong>
        </div>
        <div>
          <span class="popup-label">Наша ціна</span>
          <strong>${escapeHtml(item.price || "—")}</strong>
        </div>
        <div>
          <span class="popup-label">до Києва</span>
          <strong>${escapeHtml(item.distance_to_kyiv || "—")}</strong>
        </div>
      </div>
      <div class="popup-actions">
        ${actionButton({
          href: item.google_maps_url,
          icon: "icon-maps.svg",
          label: "Google Maps",
          modifier: "maps",
        })}
        ${actionButton({
          href: item.notion_url,
          icon: "icon-notion.svg",
          label: "Notion",
          modifier: "notion",
        })}
        ${actionButton({
          href: item.olx_url,
          icon: "icon-olx.svg",
          label: "OLX",
          modifier: "olx",
        })}
      </div>
    </article>
  `;
}

function getVisibleItems() {
  const items = Array.isArray(dataset.categories?.[state.category])
    ? dataset.categories[state.category]
    : [];

  if (state.category !== "processing") {
    return items;
  }

  return items.filter((item) => state.processingStatuses.has(item.status_key));
}

function renderMarkers() {
  markerLayer.clearLayers();
  const items = getVisibleItems();

  if (items.length === 0) {
    L.popup()
      .setLatLng(map.getCenter())
      .setContent(
        '<div class="empty-state">Немає ділянок для поточного фільтра.</div>',
      )
      .openOn(map);
    return;
  }

  const bounds = [];
  items.forEach((item) => {
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const marker = L.marker([lat, lng], {
      icon: markerIcon(item),
      riseOnHover: true,
    });
    marker.bindPopup(popupMarkup(item), {
      autoPanPaddingTopLeft: [24, 24],
      autoPanPaddingBottomRight: [24, 24],
      closeButton: false,
    });
    marker.addTo(markerLayer);
    bounds.push([lat, lng]);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 12 });
  }
}

function syncControls() {
  categoryTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.category === state.category);
  });

  const processingVisible = state.category === "processing";
  processingFiltersNode.classList.toggle("is-hidden", !processingVisible);

  statusChips.forEach((button) => {
    button.classList.toggle("is-active", state.processingStatuses.has(button.dataset.statusKey));
  });
}

async function loadData() {
  const response = await fetch("./data/parcels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load parcels.json: ${response.status}`);
  }
  return response.json();
}

function registerEvents() {
  categoryTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.category = button.dataset.category;
      syncControls();
      renderMarkers();
    });
  });

  statusChips.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.statusKey;
      if (state.processingStatuses.has(key)) {
        state.processingStatuses.delete(key);
      } else {
        state.processingStatuses.add(key);
      }
      syncControls();
      renderMarkers();
    });
  });
}

async function bootstrap() {
  registerEvents();
  syncControls();

  try {
    dataset = await loadData();
    renderMarkers();
  } catch (error) {
    console.error(error);
    L.popup()
      .setLatLng(map.getCenter())
      .setContent(
        '<div class="empty-state">Не вдалося завантажити дані карти.</div>',
      )
      .openOn(map);
  }
}

void bootstrap();
