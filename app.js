const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([50.28, 30.44], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const categoryTabs = Array.from(document.querySelectorAll(".category-tab"));
const ageChips = Array.from(document.querySelectorAll(".age-chip"));

const state = {
  activeCategories: new Set(categoryTabs.map((button) => button.dataset.category)),
  activeAgeDays: new Set(),
};

let dataset = { categories: {} };
let markerLayer = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 48,
  zoomToBoundsOnClick: true,
  spiderfyOnMaxZoom: true,
  animate: true,
  iconCreateFunction(cluster) {
    const count = cluster.getChildCount();
    const size = count >= 50 ? "large" : count >= 10 ? "medium" : "small";
    const dimension = count >= 50 ? 48 : count >= 10 ? 42 : 36;
    return L.divIcon({
      html: `<div class="marker-cluster marker-cluster--${size}">${count}</div>`,
      className: "marker-cluster-wrapper",
      iconSize: [dimension, dimension],
    });
  },
}).addTo(map);
let markerRefs = new Map();

function normalizeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("./")) return `/${raw.slice(2)}`;
  if (
    raw.startsWith("../") ||
    raw.startsWith("/") ||
    raw.startsWith("#") ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:") ||
    raw.startsWith("tel:") ||
    raw.startsWith("mailto:")
  ) {
    return raw;
  }
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

function popupMetaRow(label, value) {
  return `
    <div>
      <span class="popup-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "—")}</strong>
    </div>
  `;
}

function formatDistanceForSite(value) {
  const raw = String(value ?? "").replace(",", ".");
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return String(value || "—");
  const distance = Math.max(0, Number(match[0]) - 15);
  return `${Math.floor(distance / 5) * 5} км`;
}

function popupMarkup(item) {
  return `
    <article class="parcel-popup">
      <h3>${escapeHtml(item.name || "Без назви")}</h3>
      <div class="popup-meta">
        ${popupMetaRow("Площа", item.area)}
        ${popupMetaRow("До Києва", formatDistanceForSite(item.distance_to_kyiv))}
        ${popupMetaRow("Кадастровий номер", item.cadastral)}
        ${popupMetaRow("Ціна", item.price)}
      </div>
      <div class="popup-actions">
        ${actionButton({
          href: item.google_maps_url,
          icon: "IMG_5575.PNG",
          label: "Google Maps",
          modifier: "maps",
        })}
        ${actionButton({
          href: item.notion_url,
          icon: "IMG_5573.PNG",
          label: "Notion",
          modifier: "notion",
        })}
        ${actionButton({
          href: item.olx_url,
          icon: "IMG_5574.PNG",
          label: "OLX",
          modifier: "olx",
        })}
      </div>
    </article>
  `;
}

function parcelPreviewVersion(item) {
  const price = Number.isFinite(Number(item?.price_usd)) ? String(Math.round(Number(item.price_usd))) : "";
  const area = Number.isFinite(Number(item?.area_sotky)) ? String(Math.round(Number(item.area_sotky) * 100)) : "";
  return [price, area].filter(Boolean).join("-");
}

function updateUrlForItem(item, replace = false) {
  const url = new URL(window.location.href);
  if (item?.parcel_id) {
    const safeParcelId = String(item.parcel_id).trim().replace(/[^A-Za-z0-9_-]/g, "");
    url.pathname = `/property/${safeParcelId}/`;
    const version = parcelPreviewVersion(item);
    if (version) url.searchParams.set("v", version);
    url.searchParams.delete("parcel");
    url.searchParams.delete("cad");
  } else if (item?.cadastral) {
    url.pathname = "/";
    url.searchParams.set("cad", item.cadastral);
    url.searchParams.delete("v");
    url.searchParams.delete("parcel");
  } else {
    url.pathname = "/";
    url.searchParams.delete("v");
    url.searchParams.delete("parcel");
    url.searchParams.delete("cad");
  }
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", url);
}

function getCategoryItems(category) {
  return Array.isArray(dataset.categories?.[category])
    ? dataset.categories[category]
    : [];
}

function createdAtMs(item) {
  const value = Date.parse(String(item.created_time || item.created_at || ""));
  return Number.isFinite(value) ? value : null;
}

function passesAgeFilters(item) {
  if (state.activeAgeDays.size === 0) return true;
  const created = createdAtMs(item);
  if (created === null) return false;
  const ageMs = Date.now() - created;
  return Array.from(state.activeAgeDays).some((days) => (
    ageMs >= 0 && ageMs <= Number(days) * 24 * 60 * 60 * 1000
  ));
}

function getVisibleItems() {
  const items = [];
  state.activeCategories.forEach((category) => {
    items.push(...getCategoryItems(category).filter(passesAgeFilters));
  });

  return items;
}

function allItems() {
  return Object.values(dataset.categories || {})
    .filter(Array.isArray)
    .flat();
}

function findItemByParcelId(parcelId) {
  const normalized = String(parcelId || "").trim().toLowerCase();
  if (!normalized) return null;
  return allItems().find((item) => String(item.parcel_id || "").trim().toLowerCase() === normalized) || null;
}

function findItemByCadastral(cadastral) {
  const normalized = String(cadastral || "").trim();
  if (!normalized) return null;
  return allItems().find((item) => String(item.cadastral || "").trim() === normalized) || null;
}

function renderMarkers() {
  markerLayer.clearLayers();
  markerRefs = new Map();
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
      closeButton: true,
    });
    marker.on("popupopen", () => updateUrlForItem(item));
    marker.addTo(markerLayer);
    markerRefs.set(item.id, { marker, item });
    bounds.push([lat, lng]);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 12 });
  }
}

function openItem(item, { replaceUrl = false } = {}) {
  if (!item) return;
  const ref = markerRefs.get(item.id);
  if (ref) {
    ref.marker.openPopup();
    updateUrlForItem(item, replaceUrl);
    if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) {
      map.setView([Number(item.latitude), Number(item.longitude)], Math.max(map.getZoom(), 14));
    }
  }
}

function openInitialDeepLink() {
  const url = new URL(window.location.href);
  const pathParcel = url.pathname.match(/\/property\/([^/]+)\/?$/)?.[1] || "";
  const item =
    findItemByParcelId(pathParcel) ||
    findItemByParcelId(url.searchParams.get("parcel")) ||
    findItemByCadastral(url.searchParams.get("cad"));
  if (item) openItem(item, { replaceUrl: true });
}

function syncControls() {
  categoryTabs.forEach((button) => {
    button.classList.toggle("is-active", state.activeCategories.has(button.dataset.category));
  });

  ageChips.forEach((button) => {
    const key = Number(button.dataset.ageDays || 0);
    const active = state.activeAgeDays.has(key);
    button.classList.toggle("is-active", active);
    const check = button.querySelector(".chip-check");
    if (check) check.textContent = active ? "✅" : "▢";
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
      const category = button.dataset.category;
      if (state.activeCategories.has(category)) {
        state.activeCategories.delete(category);
      } else {
        state.activeCategories.add(category);
      }
      syncControls();
      renderMarkers();
    });
  });

  ageChips.forEach((button) => {
    button.addEventListener("click", () => {
      const key = Number(button.dataset.ageDays || 0);
      if (!key) return;
      if (state.activeAgeDays.has(key)) {
        state.activeAgeDays.delete(key);
      } else {
        state.activeAgeDays.add(key);
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
    openInitialDeepLink();
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
