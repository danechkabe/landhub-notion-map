const TELEGRAM_URL = "https://t.me/landhub_daniil";
const PHONE_URL = "tel:+380687155996";

const FILTERS = {
  area: { min: 1, max: 100, step: 1 },
  price: { min: 1000, max: 100000, step: 1000 },
};

const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([50.28, 30.44], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const layoutNode = document.getElementById("map-layout");
const panelNode = document.getElementById("parcel-panel");
const panelContentNode = document.getElementById("panel-content");
const panelCloseNode = document.getElementById("panel-close");
const areaMinInput = document.getElementById("area-min");
const areaMaxInput = document.getElementById("area-max");
const areaMinLabel = document.getElementById("area-min-label");
const areaMaxLabel = document.getElementById("area-max-label");
const areaRangeFill = document.getElementById("area-range-fill");
const priceMinInput = document.getElementById("price-min");
const priceMaxInput = document.getElementById("price-max");
const priceMinLabel = document.getElementById("price-min-label");
const priceMaxLabel = document.getElementById("price-max-label");
const priceRangeFill = document.getElementById("price-range-fill");
const verifiedToggleNode = document.getElementById("verified-toggle");
const mapCountsNode = document.getElementById("map-counts");
const lightboxNode = document.getElementById("photo-lightbox");
const lightboxImageNode = document.getElementById("lightbox-image");
const lightboxCloseNode = document.getElementById("lightbox-close");
const lightboxZoomInNode = document.getElementById("lightbox-zoom-in");
const lightboxZoomOutNode = document.getElementById("lightbox-zoom-out");
const lightboxZoomResetNode = document.getElementById("lightbox-zoom-reset");
const lightboxStageNode = document.getElementById("lightbox-stage");
const lightboxPrevNode = document.getElementById("lightbox-prev");
const lightboxNextNode = document.getElementById("lightbox-next");

let dataset = { categories: { landmatch: [] } };
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
let selectedMarkerLayer = L.layerGroup().addTo(map);
let markerRefs = new Map();
let selectedId = "";
let lightboxScale = 1;
let lightboxOffset = { x: 0, y: 0 };
let lightboxDrag = null;
let lightboxSwipe = null;
let lightboxPhotos = [];
let lightboxIndex = 0;

const state = {
  areaMin: FILTERS.area.min,
  areaMax: FILTERS.area.max,
  priceMin: FILTERS.price.min,
  priceMax: FILTERS.price.max,
  verifiedOnly: false,
};

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

function formatArea(value) {
  return `${Math.round(value)} ${Math.round(value) === 1 ? "сотка" : "соток"}`;
}

function formatPrice(value) {
  return `${Math.round(value).toLocaleString("uk-UA")}$`;
}

function formatDistanceForSite(value) {
  const raw = String(value ?? "").replace(",", ".");
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return String(value || "—");
  const distance = Math.max(0, Number(match[0]) - 15);
  return `${Math.floor(distance / 5) * 5} км`;
}

function formatParcelCount(count) {
  const value = Math.abs(Number(count) || 0);
  const lastTwo = value % 100;
  const last = value % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} ділянок`;
  if (last === 1) return `${count} ділянка`;
  if (last >= 2 && last <= 4) return `${count} ділянки`;
  return `${count} ділянок`;
}

function trackEvent(name, params = {}) {
  if (typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}

function parcelAnalyticsParams(item, extra = {}) {
  return {
    parcel_id: String(item.id || ""),
    cadastral: String(item.cadastral || ""),
    parcel_name: String(item.name || ""),
    parcel_source: String(item.source || ""),
    area_sotky: getItemArea(item),
    price_usd: getItemPrice(item),
    has_verified_photos: Boolean(item.has_verified_photos),
    photo_count: getPhotoUrls(item).length,
    ...extra,
  };
}

function trackParcelOpen(item, openSource) {
  trackEvent("parcel_open", parcelAnalyticsParams(item, { open_source: openSource }));
}

function updateMapCounts() {
  if (!mapCountsNode) return;
  const total = getLandmatchItems().length;
  const filtered = getFilteredItems().length;
  mapCountsNode.textContent = `Доступно ${formatParcelCount(total)}. За фільтром ${formatParcelCount(filtered)}`;
}

function markerIcon(item, isSelected = false) {
  const color = isSelected ? "#247eaf" : item.has_verified_photos ? "#2aa84a" : escapeHtml(item.marker_color || "#e0b21b");
  const symbol = isSelected ? "💙" : item.has_verified_photos ? "💚" : escapeHtml(item.marker_symbol || "💛");
  return L.divIcon({
    className: "parcel-marker",
    html: `<div class="emoji-pin" style="--marker-accent:${color}">${symbol}</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "—")}</strong>
    </div>
  `;
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
      <img src="/assets/${escapeHtml(icon)}" alt="" />
      <span>${escapeHtml(label)}</span>
    </a>
  `;
}

function panelMarkup(item) {
  const photoGroups = getPhotoGroups(item);
  let photoIndex = 0;
  const photoButton = (url, modifier = "") => {
    const index = photoIndex;
    photoIndex += 1;
    return `
      <button class="parcel-photo${modifier ? ` ${modifier}` : ""}" type="button" data-photo-index="${index}" data-photo-title="${escapeHtml(item.name)}">
        <img src="${escapeHtml(url)}" alt="${escapeHtml(item.name)}" loading="lazy" />
      </button>
    `;
  };
  const photoMarkup = photoGroups.main || photoGroups.gallery.length || photoGroups.plan
    ? `
      <div class="photo-stack">
        ${photoGroups.main ? `<div class="photo-main">${photoButton(photoGroups.main)}</div>` : ""}
        ${photoGroups.gallery.length ? `<div class="photo-gallery">${photoGroups.gallery.map((url, index, urls) => photoButton(url, `parcel-photo--gallery${urls.length % 2 === 1 && index === urls.length - 1 ? " parcel-photo--gallery-last" : ""}`)).join("")}</div>` : ""}
        ${photoGroups.plan ? `<div class="photo-plan">${photoButton(photoGroups.plan, "parcel-photo--plan")}</div>` : ""}
      </div>
    `
    : "";
  const parcelShapeMarkup = hasParcelShapeDetails(item)
    ? `
      <div class="parcel-shape-details">
        ${item.perimeter && item.perimeter !== "—" ? detailRow("Периметр", item.perimeter) : ""}
        ${item.sides && item.sides !== "—" ? detailRow("Сторони", item.sides) : ""}
      </div>
    `
    : "";
  const filterWarning = passesFilters(item)
    ? '<div class="filter-warning filter-warning--empty">&nbsp;</div>'
    : '<div class="filter-warning">ця ділянка не підходить під новий фільтр</div>';

  return `
    <article class="parcel-details">
      <h2>${escapeHtml(item.name || "Без назви")}</h2>
      ${filterWarning}
      <div class="details-list">
        ${detailRow("Кадастровий номер", item.cadastral)}
        ${detailRow("Площа", item.area)}
        ${detailRow("До Києва", formatDistanceForSite(item.distance_to_kyiv))}
      </div>
      ${photoMarkup}
      ${parcelShapeMarkup}
      <div class="price-card">
        <span>Ціна</span>
        <strong>${escapeHtml(item.price || "—")}</strong>
      </div>
      <div class="panel-actions">
        ${actionButton({
          href: item.google_maps_url,
          icon: "IMG_5575.PNG",
          label: "Google Maps",
          modifier: "maps",
        })}
        ${actionButton({
          href: TELEGRAM_URL,
          icon: "telegram.png",
          label: "Telegram",
          modifier: "telegram",
        })}
        ${item.has_verified_photos ? actionButton({
          href: PHONE_URL,
          icon: "phone.png",
          label: "+380 68 715 59 96",
          modifier: "phone",
        }) : ""}
      </div>
    </article>
  `;
}

function getLandmatchItems() {
  return Array.isArray(dataset.categories?.landmatch)
    ? dataset.categories.landmatch
    : [];
}

function getFilteredItems() {
  return getLandmatchItems().filter(passesFilters);
}

function getPhotoUrls(item) {
  const groups = getPhotoGroups(item);
  return [groups.main, ...groups.gallery, groups.plan].filter(Boolean);
}

function getPhotoGroups(item) {
  const processed = Array.isArray(item.photo_urls)
    ? item.photo_urls.map(normalizeUrl).filter(Boolean)
    : [];
  const main = processed[0] || normalizeUrl(item.photo_url);
  const gallery = processed.slice(1);
  const plan = normalizeUrl(item.plan_photo_url);
  return {
    main,
    gallery: gallery.filter((url) => url !== plan),
    plan,
  };
}

function hasParcelShapeDetails(item) {
  return Boolean(
    (item.perimeter && item.perimeter !== "—") ||
    (item.sides && item.sides !== "—")
  );
}

function getItemArea(item) {
  const value = Number(item.area_sotky);
  if (Number.isFinite(value)) return value;
  const raw = String(item.area || "").replace(",", ".");
  const match = raw.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return /га|гект/i.test(raw) ? parsed * 100 : parsed;
}

function getItemPrice(item) {
  const value = Number(item.price_usd);
  if (Number.isFinite(value)) return value;
  const digits = String(item.price || "").match(/\d[\d\s.,]*/)?.[0]?.replace(/[^\d]/g, "") || "";
  return digits ? Number(digits) : null;
}

function passesFilters(item) {
  const area = getItemArea(item);
  const price = getItemPrice(item);
  if (area === null || price === null) return false;
  if (state.verifiedOnly && !item.has_verified_photos) return false;
  return (
    area >= state.areaMin &&
    area <= state.areaMax &&
    price >= state.priceMin &&
    price <= state.priceMax
  );
}

function findItemByCadastral(cadastral) {
  const normalized = String(cadastral || "").trim();
  if (!normalized) return null;
  return getLandmatchItems().find((item) => String(item.cadastral || "").trim() === normalized) || null;
}

function findItemByParcelId(parcelId) {
  const normalized = String(parcelId || "").trim().toLowerCase();
  if (!normalized) return null;
  return getLandmatchItems().find((item) => String(item.parcel_id || "").trim().toLowerCase() === normalized) || null;
}

function findSelectedItem() {
  return getLandmatchItems().find((item) => item.id === selectedId) || null;
}

function setSelectedMarker(nextId) {
  selectedId = nextId || "";
  renderMarkers({ fit: false });
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

function parcelPreviewVersion(item) {
  const price = Number.isFinite(Number(item?.price_usd)) ? String(Math.round(Number(item.price_usd))) : "";
  const area = Number.isFinite(Number(item?.area_sotky)) ? String(Math.round(Number(item.area_sotky) * 100)) : "";
  return [price, area].filter(Boolean).join("-");
}

function openPanel(item, { updateUrl = true, replaceUrl = false, openSource = "marker" } = {}) {
  panelContentNode.innerHTML = panelMarkup(item);
  panelNode.setAttribute("aria-hidden", "false");
  layoutNode.classList.add("panel-open");
  setSelectedMarker(item.id);
  if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) {
    map.flyTo([Number(item.latitude), Number(item.longitude)], Math.max(map.getZoom(), 14), {
      animate: true,
      duration: 0.7,
    });
  }
  if (updateUrl) updateUrlForItem(item, replaceUrl);
  trackParcelOpen(item, openSource);
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function closePanel({ updateUrl = true } = {}) {
  panelNode.setAttribute("aria-hidden", "true");
  layoutNode.classList.remove("panel-open");
  setSelectedMarker("");
  if (updateUrl) updateUrlForItem(null);
  const zoomOutLevel = Math.max(map.getMinZoom(), map.getZoom() - 3);
  map.flyTo(map.getCenter(), zoomOutLevel, {
    animate: true,
    duration: 0.7,
  });
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function renderMarkers({ fit = true } = {}) {
  markerLayer.clearLayers();
  selectedMarkerLayer.clearLayers();
  markerRefs = new Map();
  const items = getFilteredItems();
  const selectedItem = findSelectedItem();
  if (selectedItem && !items.some((item) => item.id === selectedItem.id)) {
    items.unshift(selectedItem);
  }

  if (items.length === 0) {
    return;
  }

  const bounds = [];
  items.forEach((item) => {
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const marker = L.marker([lat, lng], {
      icon: markerIcon(item, item.id === selectedId),
      zIndexOffset: item.id === selectedId ? 10000 : item.has_verified_photos ? 2000 : 0,
      riseOnHover: true,
    });
    marker.on("click", () => openPanel(item));
    if (item.id === selectedId) {
      selectedMarkerLayer.addLayer(marker);
    } else {
      markerLayer.addLayer(marker);
    }
    markerRefs.set(item.id, { marker, item });
    bounds.push([lat, lng]);
  });

  if (fit && bounds.length > 0) {
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 12 });
  }
}

function refreshSelectedPanel() {
  const item = findSelectedItem();
  if (!item || panelNode.getAttribute("aria-hidden") === "true") return;
  panelContentNode.innerHTML = panelMarkup(item);
  setSelectedMarker(item.id);
}

function clampRange(kind, changed) {
  const minInput = kind === "area" ? areaMinInput : priceMinInput;
  const maxInput = kind === "area" ? areaMaxInput : priceMaxInput;
  const step = FILTERS[kind].step;
  let minValue = Number(minInput.value);
  let maxValue = Number(maxInput.value);

  if (changed === "min" && minValue >= maxValue) {
    minValue = maxValue - step;
    minInput.value = String(minValue);
  }
  if (changed === "max" && maxValue <= minValue) {
    maxValue = minValue + step;
    maxInput.value = String(maxValue);
  }

  if (kind === "area") {
    state.areaMin = minValue;
    state.areaMax = maxValue;
  } else {
    state.priceMin = minValue;
    state.priceMax = maxValue;
  }
}

function updateRangeUi(kind) {
  const config = FILTERS[kind];
  const minValue = kind === "area" ? state.areaMin : state.priceMin;
  const maxValue = kind === "area" ? state.areaMax : state.priceMax;
  const minLabel = kind === "area" ? areaMinLabel : priceMinLabel;
  const maxLabel = kind === "area" ? areaMaxLabel : priceMaxLabel;
  const fill = kind === "area" ? areaRangeFill : priceRangeFill;
  const formatter = kind === "area" ? formatArea : formatPrice;
  const left = ((minValue - config.min) / (config.max - config.min)) * 100;
  const right = 100 - ((maxValue - config.min) / (config.max - config.min)) * 100;

  minLabel.textContent = formatter(minValue);
  maxLabel.textContent = formatter(maxValue);
  fill.style.left = `${left}%`;
  fill.style.right = `${right}%`;
}

function handleFilterInput(kind, changed) {
  clampRange(kind, changed);
  updateRangeUi(kind);
  updateMapCounts();
  renderMarkers({ fit: true });
  refreshSelectedPanel();
  trackEvent("filter_change", {
    filter_kind: kind,
    changed_handle: changed,
    area_min: state.areaMin,
    area_max: state.areaMax,
    price_min: state.priceMin,
    price_max: state.priceMax,
    verified_only: state.verifiedOnly,
    filtered_count: getFilteredItems().length,
  });
}

async function loadData() {
  const response = await fetch("./data/parcels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load parcels.json: ${response.status}`);
  }
  return response.json();
}

function openLightbox(urls, index, title) {
  lightboxPhotos = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!lightboxPhotos.length) return;
  lightboxImageNode.alt = title || "";
  showLightboxPhoto(index || 0);
  lightboxNode.setAttribute("aria-hidden", "false");
}

function showLightboxPhoto(index) {
  if (!lightboxPhotos.length) return;
  lightboxIndex = (index + lightboxPhotos.length) % lightboxPhotos.length;
  lightboxImageNode.src = lightboxPhotos[lightboxIndex];
  lightboxPrevNode.hidden = lightboxPhotos.length < 2;
  lightboxNextNode.hidden = lightboxPhotos.length < 2;
  resetLightboxZoom();
}

function closeLightbox() {
  lightboxNode.setAttribute("aria-hidden", "true");
  lightboxImageNode.removeAttribute("src");
  lightboxPhotos = [];
  lightboxIndex = 0;
}

function applyLightboxTransform() {
  lightboxImageNode.style.transform = `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxScale})`;
  lightboxZoomResetNode.textContent = `${Math.round(lightboxScale * 100)}%`;
}

function zoomLightbox(delta) {
  lightboxScale = Math.min(5, Math.max(1, lightboxScale + delta));
  if (lightboxScale === 1) {
    lightboxOffset = { x: 0, y: 0 };
  }
  applyLightboxTransform();
}

function resetLightboxZoom() {
  lightboxScale = 1;
  lightboxOffset = { x: 0, y: 0 };
  applyLightboxTransform();
}

function registerEvents() {
  panelCloseNode.addEventListener("click", () => closePanel());
  areaMinInput.addEventListener("input", () => handleFilterInput("area", "min"));
  areaMaxInput.addEventListener("input", () => handleFilterInput("area", "max"));
  priceMinInput.addEventListener("input", () => handleFilterInput("price", "min"));
  priceMaxInput.addEventListener("input", () => handleFilterInput("price", "max"));
  verifiedToggleNode.addEventListener("click", () => {
    state.verifiedOnly = !state.verifiedOnly;
    verifiedToggleNode.classList.toggle("is-active", state.verifiedOnly);
    verifiedToggleNode.setAttribute("aria-pressed", state.verifiedOnly ? "true" : "false");
    verifiedToggleNode.innerHTML = state.verifiedOnly
      ? '<span class="verified-toggle-text"><span>Тільки перевірені</span><span>ділянки з фото</span></span><span class="verified-toggle-mark">✅</span>'
      : '<span class="verified-toggle-text"><span>Тільки перевірені</span><span>ділянки з фото</span></span><span class="verified-toggle-mark">▢</span>';
    updateMapCounts();
    renderMarkers({ fit: true });
    refreshSelectedPanel();
    trackEvent("filter_change", {
      filter_kind: "verified_only",
      changed_handle: "toggle",
      area_min: state.areaMin,
      area_max: state.areaMax,
      price_min: state.priceMin,
      price_max: state.priceMax,
      verified_only: state.verifiedOnly,
      filtered_count: getFilteredItems().length,
    });
  });

  panelContentNode.addEventListener("click", (event) => {
    const actionLink = event.target.closest(".action-link");
    if (actionLink) {
      const item = findSelectedItem();
      if (item) {
        trackEvent("contact_click", parcelAnalyticsParams(item, {
          contact_type: actionLink.classList.contains("action-link--maps")
            ? "google_maps"
            : actionLink.classList.contains("action-link--telegram")
              ? "telegram"
              : actionLink.classList.contains("action-link--phone")
                ? "phone"
                : "unknown",
        }));
      }
      return;
    }

    const button = event.target.closest(".parcel-photo");
    if (!button) return;
    const item = findSelectedItem();
    if (!item) return;
    trackEvent("photo_open", parcelAnalyticsParams(item, {
      photo_index: Number(button.dataset.photoIndex || 0),
    }));
    openLightbox(getPhotoUrls(item), Number(button.dataset.photoIndex || 0), button.dataset.photoTitle);
  });

  lightboxCloseNode.addEventListener("click", closeLightbox);
  lightboxZoomInNode.addEventListener("click", () => zoomLightbox(0.25));
  lightboxZoomOutNode.addEventListener("click", () => zoomLightbox(-0.25));
  lightboxZoomResetNode.addEventListener("click", resetLightboxZoom);
  lightboxPrevNode.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showLightboxPhoto(lightboxIndex - 1);
  });
  lightboxNextNode.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showLightboxPhoto(lightboxIndex + 1);
  });
  lightboxNode.addEventListener("click", (event) => {
    if (event.target === lightboxNode) closeLightbox();
  });
  lightboxStageNode.addEventListener("click", (event) => {
    if (event.target === lightboxStageNode) closeLightbox();
  });
  lightboxStageNode.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomLightbox(event.deltaY < 0 ? 0.15 : -0.15);
  }, { passive: false });
  lightboxStageNode.addEventListener("pointerdown", (event) => {
    const point = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (lightboxScale <= 1) {
      lightboxSwipe = point;
      lightboxStageNode.setPointerCapture(event.pointerId);
      return;
    }
    lightboxDrag = {
      ...point,
      offsetX: lightboxOffset.x,
      offsetY: lightboxOffset.y,
    };
    lightboxStageNode.setPointerCapture(event.pointerId);
  });
  lightboxStageNode.addEventListener("pointermove", (event) => {
    if (!lightboxDrag || event.pointerId !== lightboxDrag.pointerId) return;
    lightboxOffset = {
      x: lightboxDrag.offsetX + event.clientX - lightboxDrag.startX,
      y: lightboxDrag.offsetY + event.clientY - lightboxDrag.startY,
    };
    applyLightboxTransform();
  });
  lightboxStageNode.addEventListener("pointerup", (event) => {
    if (lightboxSwipe && event.pointerId === lightboxSwipe.pointerId) {
      const deltaX = event.clientX - lightboxSwipe.startX;
      const deltaY = event.clientY - lightboxSwipe.startY;
      if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        showLightboxPhoto(lightboxIndex + (deltaX < 0 ? 1 : -1));
      }
    }
    lightboxDrag = null;
    lightboxSwipe = null;
  });
  lightboxStageNode.addEventListener("pointercancel", () => {
    lightboxDrag = null;
    lightboxSwipe = null;
  });

  window.addEventListener("popstate", () => {
    const url = new URL(window.location.href);
    const pathParcel = url.pathname.match(/\/property\/([^/]+)\/?$/)?.[1] || "";
    const item =
      findItemByParcelId(pathParcel) ||
      findItemByParcelId(url.searchParams.get("parcel")) ||
      findItemByCadastral(url.searchParams.get("cad"));
    if (item) {
      openPanel(item, { updateUrl: false, openSource: "browser_history" });
    } else {
      closePanel({ updateUrl: false });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (lightboxNode.getAttribute("aria-hidden") === "false") {
      if (event.key === "Escape") {
        closeLightbox();
      } else if (event.key === "ArrowLeft") {
        showLightboxPhoto(lightboxIndex - 1);
      } else if (event.key === "ArrowRight") {
        showLightboxPhoto(lightboxIndex + 1);
      }
      return;
    }
    if (event.key !== "Escape") return;
    closePanel();
  });
}

function openInitialDeepLink() {
  const url = new URL(window.location.href);
  const pathParcel = url.pathname.match(/\/property\/([^/]+)\/?$/)?.[1] || "";
  const item =
    findItemByParcelId(pathParcel) ||
    findItemByParcelId(url.searchParams.get("parcel")) ||
    findItemByCadastral(url.searchParams.get("cad"));
  if (!item) return;
  openPanel(item, { updateUrl: true, replaceUrl: true, openSource: "deeplink" });
  if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) {
    map.setView([Number(item.latitude), Number(item.longitude)], 14);
  }
}

async function bootstrap() {
  registerEvents();
  updateRangeUi("area");
  updateRangeUi("price");

  try {
    dataset = await loadData();
    updateMapCounts();
    renderMarkers();
    openInitialDeepLink();
  } catch (error) {
    console.error(error);
    panelContentNode.innerHTML = '<div class="panel-empty">Не вдалося завантажити дані карти.</div>';
  }
}

void bootstrap();
