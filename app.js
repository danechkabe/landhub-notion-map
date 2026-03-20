const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([50.32, 30.42], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const summaryNode = document.getElementById("summary");

function heartIcon() {
  return L.divIcon({
    className: "parcel-heart-icon",
    html: '<div class="emoji-pin" aria-hidden="true">💛</div>',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -12],
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function popupMarkup(parcel) {
  return `
    <article class="parcel-popup">
      <h3>${escapeHtml(parcel.name)}</h3>
      <div class="popup-meta">
        <div>
          <span class="popup-label">Name</span>
          <strong>${escapeHtml(parcel.name)}</strong>
        </div>
        <div>
          <span class="popup-label">Площа</span>
          <strong>${escapeHtml(parcel.area || "—")}</strong>
        </div>
        <div>
          <span class="popup-label">Наша ціна</span>
          <strong>${escapeHtml(parcel.price || "—")}</strong>
        </div>
      </div>
      <a
        class="maps-link"
        href="${escapeHtml(parcel.google_maps_url)}"
        target="_blank"
        rel="noopener noreferrer"
      >
        Google Maps
      </a>
    </article>
  `;
}

function updateSummary(count) {
  summaryNode.textContent =
    count > 0
      ? `На карті зараз ${count} активних ділянок із бази LandMatch Parcels.`
      : "Активні ділянки не знайдені.";
}

async function loadParcels() {
  const response = await fetch("./data/parcels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load parcels.json: ${response.status}`);
  }
  return response.json();
}

async function bootstrap() {
  try {
    const payload = await loadParcels();
    const parcels = Array.isArray(payload.parcels) ? payload.parcels : [];
    updateSummary(parcels.length);

    if (parcels.length === 0) {
      L.popup()
        .setLatLng(map.getCenter())
        .setContent('<div class="empty-state">Поки що немає активних ділянок.</div>')
        .openOn(map);
      return;
    }

    const bounds = [];
    parcels.forEach((parcel) => {
      const lat = Number(parcel.latitude);
      const lng = Number(parcel.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }

      const marker = L.marker([lat, lng], { icon: heartIcon(), riseOnHover: true });
      marker.bindPopup(popupMarkup(parcel), {
        autoPanPaddingTopLeft: [24, 24],
        autoPanPaddingBottomRight: [24, 24],
      });
      marker.addTo(map);
      bounds.push([lat, lng]);
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [52, 52], maxZoom: 12 });
    }
  } catch (error) {
    console.error(error);
    summaryNode.textContent = "Не вдалося завантажити дані карти.";
    L.popup()
      .setLatLng(map.getCenter())
      .setContent(
        '<div class="empty-state">Помилка завантаження даних. Спробуй оновити сторінку пізніше.</div>',
      )
      .openOn(map);
  }
}

void bootstrap();
