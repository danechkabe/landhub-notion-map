#!/usr/bin/env python3
"""Fetch active LandMatch Parcels from Notion for LandHub map."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse

import requests

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - GitHub Actions installs Pillow.
    Image = None
    ImageOps = None

NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2026-03-11"
NOTION_RETRYABLE_STATUS_CODES = {429, 502, 503, 504}
NOTION_MAX_ATTEMPTS = 5
NOTION_BASE_BACKOFF_SECONDS = 1.5
DECIMAL_COORD_RE = re.compile(r"(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)")
LANDMATCH_URL = (
    "https://www.notion.so/30649a17ea97804c8acac49da41511e5"
    "?v=30649a17ea9780058dd9000c82bc6059&source=copy_link"
)
OLX_URL = (
    "https://www.notion.so/2ef49a17ea97803e8b20edf5611b033f"
    "?v=2ef49a17ea9780448e2f000ca8f156c1&source=copy_link"
)
LANDHUB_URL = (
    "https://www.notion.so/2ef49a17ea97807b9204d95797898034"
    "?v=2ef49a17ea978095af81000cdf80f39a&source=copy_link"
)
OLX_STATUS_NAMES = (
    "Дає на реалізацію",
    "На сайт ок. Але з олх не прибере",
    "Передзвонити",
    "Не опрацьована",
)
CADASTRAL_META = {"symbol": "📚", "color": "#e98272"}
LANDMATCH_META = {"symbol": "💛", "color": "#e0b21b"}
REALIZATION_META = {"symbol": "📍", "color": "#111111"}
PHOTO_MAX_SIDE = 1600
PHOTO_JPEG_QUALITY = 82
LANDHUB_MAP_BASE_URL = "https://mymap.landhub.com.ua/"


@dataclass(frozen=True)
class NotionSource:
    key: str
    label: str
    database_url: str
    filter_payload: dict[str, Any] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", required=True, help="Notion API token")
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parents[1] / "data" / "parcels.json"),
        help="Output JSON path",
    )
    parser.add_argument(
        "--photo-dir",
        default=str(Path(__file__).resolve().parents[1] / "assets" / "generated-photos"),
        help="Directory for optimized watermarked site photos.",
    )
    parser.add_argument(
        "--photo-manifest",
        default=str(Path(__file__).resolve().parents[1] / "data" / "photo_manifest.json"),
        help="Manifest mapping Notion file URLs to generated local photos.",
    )
    parser.add_argument(
        "--watermark",
        default=str(Path(__file__).resolve().parents[1] / "assets" / "watermark_overlay.png"),
        help="Watermark image path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = requests.Session()
    headers = {
        "Authorization": f"Bearer {args.token.strip()}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    photo_processor = PhotoProcessor(
        photo_dir=Path(args.photo_dir),
        manifest_path=Path(args.photo_manifest),
        watermark_path=Path(args.watermark),
        session=session,
    )

    sources = [
        NotionSource(
            key="cadastral",
            label="Кадастровий",
            database_url=OLX_URL,
            filter_payload={
                "or": [
                    {"property": "Status Даня", "status": {"equals": status}}
                    for status in OLX_STATUS_NAMES
                ]
            },
        ),
        NotionSource(
            key="realization",
            label="Ділянки на реалізацію",
            database_url=LANDHUB_URL,
        ),
        NotionSource(
            key="landmatch",
            label="LandMatch Parcel",
            database_url=LANDMATCH_URL,
            filter_payload={
                "or": [
                    {"property": "Status", "select": {"equals": "active"}},
                    {"property": "Status", "select": {"equals": "exclusive"}},
                ]
            },
        ),
    ]
    categories: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    for source in sources:
        items = [
            item
            for page in fetch_database_pages(source, headers=headers, session=session)
            if (item := normalize_page(source.key, page, session=session, photo_processor=photo_processor)) is not None
        ]
        items.sort(key=lambda item: (str(item.get("name") or "").lower(), str(item.get("id") or "")))
        categories[source.key] = items
        counts[source.key] = len(items)
    all_items = [item for items in categories.values() for item in items]

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "Кадастровий + LandMatch Parcel + Ділянки на реалізацію",
        "filter": {
            "folders": ["Кадастровий", "LandMatch Parcel", "Ділянки на реалізацію"],
            "age_field": "created_time",
        },
        "counts": counts,
        "categories": categories,
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    photo_processor.save()
    write_share_pages(all_items, output_path.parent.parent)
    print(f"Wrote {sum(counts.values())} markers to {output_path}")
    return 0


def dedupe_by_cadastral(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    best_by_cadastral: dict[str, dict[str, Any]] = {}
    source_rank = {"realization": 0, "candidates": 1, "landmatch": 2}
    for item in items:
        cadastral = str(item.get("cadastral") or "").strip()
        if not cadastral:
            result.append(item)
            continue
        current = best_by_cadastral.get(cadastral)
        if current is None or dedupe_rank(item, source_rank) < dedupe_rank(current, source_rank):
            best_by_cadastral[cadastral] = item

    seen: set[str] = set()
    for item in items:
        cadastral = str(item.get("cadastral") or "").strip()
        if not cadastral:
            continue
        if cadastral in seen:
            continue
        seen.add(cadastral)
        result.append(best_by_cadastral[cadastral])
    return result


def dedupe_rank(item: dict[str, Any], source_rank: dict[str, int]) -> tuple[int, int]:
    has_extra_photos = bool(item.get("has_verified_photos"))
    return (
        0 if has_extra_photos else 1,
        source_rank.get(str(item.get("source") or ""), 99),
    )


def fetch_database_pages(
    source: NotionSource,
    *,
    headers: dict[str, str],
    session: requests.Session,
) -> list[dict[str, Any]]:
    database_id = extract_notion_database_id(source.database_url)
    response = notion_request(
        session,
        "GET",
        f"{NOTION_API_BASE}/databases/{database_id}",
        headers=headers,
        timeout=30,
    )
    database = response.json()
    data_source_id = database["data_sources"][0]["id"]

    results: list[dict[str, Any]] = []
    next_cursor: str | None = None
    while True:
        payload: dict[str, Any] = {"page_size": 100}
        if source.filter_payload is not None:
            payload["filter"] = source.filter_payload
        if next_cursor:
            payload["start_cursor"] = next_cursor

        page = notion_request(
            session,
            "POST",
            f"{NOTION_API_BASE}/data_sources/{data_source_id}/query",
            headers=headers,
            json=payload,
            timeout=60,
        ).json()
        results.extend(page.get("results", []))
        if not page.get("has_more"):
            break
        next_cursor = page.get("next_cursor")
    return results


def notion_request(
    session: requests.Session,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    timeout: int,
    json: dict[str, Any] | None = None,
) -> requests.Response:
    last_error: Exception | None = None
    response: requests.Response | None = None
    for attempt in range(1, NOTION_MAX_ATTEMPTS + 1):
        try:
            response = session.request(
                method,
                url,
                headers=headers,
                json=json,
                timeout=timeout,
            )
            if response.status_code not in NOTION_RETRYABLE_STATUS_CODES:
                response.raise_for_status()
                return response
            last_error = requests.HTTPError(
                f"Notion API returned retryable status {response.status_code} for {url}",
                response=response,
            )
        except requests.RequestException as exc:
            response = getattr(exc, "response", None)
            status_code = response.status_code if response is not None else None
            if status_code not in NOTION_RETRYABLE_STATUS_CODES and status_code is not None:
                raise
            if status_code is None and attempt == NOTION_MAX_ATTEMPTS:
                raise
            last_error = exc

        if attempt == NOTION_MAX_ATTEMPTS:
            break

        retry_after = _parse_retry_after_seconds(
            response.headers.get("Retry-After") if response is not None else None
        )
        delay_seconds = retry_after if retry_after is not None else NOTION_BASE_BACKOFF_SECONDS * attempt
        print(
            f"Notion request failed on attempt {attempt}/{NOTION_MAX_ATTEMPTS} "
            f"for {method} {url}; retrying in {delay_seconds:.1f}s",
            flush=True,
        )
        time.sleep(delay_seconds)

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Notion request failed without an error object for {method} {url}")


def _parse_retry_after_seconds(raw_value: str | None) -> float | None:
    if raw_value is None:
        return None
    try:
        value = float(raw_value.strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def normalize_page(
    source_key: str,
    page: dict[str, Any],
    *,
    session: requests.Session,
    photo_processor: "PhotoProcessor",
) -> dict[str, Any] | None:
    properties = page.get("properties") or {}
    map_url = extract_url(properties.get("Мапа"))
    if not map_url:
        return None

    resolved_map_url = resolve_maps_url(map_url, session=session)
    try:
        latitude, longitude = extract_coordinates_from_maps_url(resolved_map_url)
    except ValueError:
        return None

    marker = {
        "cadastral": CADASTRAL_META,
        "landmatch": LANDMATCH_META,
        "realization": REALIZATION_META,
    }.get(source_key, LANDMATCH_META)
    main_photo_url = extract_file_url(properties.get("Photo"))
    extra_photo_urls = extract_file_urls(properties.get("Фотографії"))
    source_photo_urls = ([main_photo_url] if main_photo_url else []) + [
        url for url in extra_photo_urls if url and url != main_photo_url
    ]
    photo_urls = [
        photo_processor.process(url, page_id=str(page.get("id") or ""), index=index)
        for index, url in enumerate(source_photo_urls)
    ]
    photo_urls = [url for url in photo_urls if url]
    plan_photo_url = photo_processor.process(
        extract_file_url(properties.get("План ділянки")),
        page_id=str(page.get("id") or ""),
        index=1000,
        watermark=False,
    )
    name = extract_title(properties.get("Name"))
    if not name:
        name = extract_title(properties.get("Назва села/ділянки"))
    price_text = extract_rich_text(properties.get("Наша ціна")) or extract_rich_text(properties.get("Ціна"))
    area_text = extract_rich_text(properties.get("Площа"))
    area_sotky = extract_number_value(properties.get("Area Sotky"))
    if area_sotky is None:
        area_sotky = parse_area_sotky(area_text)
    parcel_id = extract_property_text(properties.get("Parcel ID"))
    cadastral = extract_rich_text(properties.get("Кадастровий номер")).strip()

    return {
        "id": str(page.get("id") or ""),
        "source": source_key,
        "created_time": str(page.get("created_time") or "").strip(),
        "name": (name or "Без назви").strip(),
        "parcel_id": parcel_id,
        "cadastral": cadastral,
        "area": (area_text or "—").strip(),
        "area_sotky": area_sotky,
        "purpose": (extract_rich_text(properties.get("Цільове призначення")) or "—").strip(),
        "distance_to_kyiv": (extract_rich_text(properties.get("до Києва")) or "—").strip(),
        "photo_url": main_photo_url,
        "extra_photo_urls": extra_photo_urls,
        "photo_urls": photo_urls,
        "plan_photo_url": plan_photo_url,
        "perimeter": (extract_rich_text(properties.get("Периметр")) or "—").strip(),
        "sides": (extract_rich_text(properties.get("Сторони")) or "—").strip(),
        "has_verified_photos": bool(extra_photo_urls),
        "price": (price_text or "—").strip(),
        "price_usd": parse_price_usd(price_text),
        "google_maps_url": resolved_map_url,
        "landhub_map_url": build_landhub_map_url(parcel_id, cadastral) or extract_url(properties.get("map.landhub")),
        "notion_url": str(page.get("url") or "").strip(),
        "olx_url": extract_url(properties.get("Посилання на OLX")),
        "latitude": latitude,
        "longitude": longitude,
        "marker_symbol": marker["symbol"],
        "marker_color": marker["color"],
    }


def parse_area_sotky(value: str) -> float | None:
    number = parse_float(value)
    if number is None:
        return None
    text = str(value or "").lower()
    if "га" in text or "гект" in text:
        return number * 100
    return number


class PhotoProcessor:
    def __init__(
        self,
        *,
        photo_dir: Path,
        manifest_path: Path,
        watermark_path: Path,
        session: requests.Session,
    ) -> None:
        self.photo_dir = photo_dir
        self.manifest_path = manifest_path
        self.watermark_path = watermark_path
        self.session = session
        self.manifest = self._load_manifest()

    def process(self, url: str, *, page_id: str, index: int, watermark: bool = True) -> str:
        normalized = str(url or "").strip()
        if not normalized:
            return ""
        if Image is None or ImageOps is None:
            return normalized

        stable_source = self._stable_source_url(normalized)
        cache_source = (
            f"{page_id}:{index}:{stable_source}"
            if watermark
            else f"{page_id}:{index}:no-watermark:{stable_source}"
        )
        key = sha256(cache_source.encode("utf-8")).hexdigest()[:24]
        cached = self.manifest.get(key)
        if isinstance(cached, dict):
            local_path = str(cached.get("local_path") or "")
            if local_path and (self.photo_dir.parent.parent / local_path).is_file():
                return f"./{local_path}"

        safe_page = re.sub(r"[^0-9a-zA-Z-]+", "", page_id.replace("-", ""))[:16] or "parcel"
        filename = f"{safe_page}-{index}-{key}.jpg"
        output_path = self.photo_dir / filename
        local_path = str(output_path.relative_to(self.photo_dir.parent.parent))

        try:
            self.photo_dir.mkdir(parents=True, exist_ok=True)
            response = self.session.get(normalized, timeout=45)
            response.raise_for_status()
            self._write_optimized(response.content, output_path, watermark=watermark)
        except Exception as exc:  # noqa: BLE001
            print(f"Could not prepare photo for {page_id}: {exc}", flush=True)
            return normalized

        self.manifest[key] = {
            "cache_key": key,
            "source_url_stable": stable_source,
            "local_path": local_path,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        return f"./{local_path}"

    def save(self) -> None:
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(
            json.dumps(self.manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def _load_manifest(self) -> dict[str, Any]:
        if not self.manifest_path.is_file():
            return {}
        try:
            value = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _write_optimized(self, content: bytes, output_path: Path, *, watermark: bool = True) -> None:
        from io import BytesIO

        with Image.open(BytesIO(content)) as image:
            base = ImageOps.exif_transpose(image).convert("RGBA")
            base.thumbnail((PHOTO_MAX_SIDE, PHOTO_MAX_SIDE), Image.Resampling.LANCZOS)
            if watermark and self.watermark_path.is_file():
                with Image.open(self.watermark_path) as watermark_image:
                    watermark = watermark_image.convert("RGBA")
                    target_width = max(1, int(base.width * 0.16))
                    scale = target_width / max(1, watermark.width)
                    watermark = watermark.resize(
                        (target_width, max(1, int(watermark.height * scale))),
                        Image.Resampling.LANCZOS,
                    )
                    margin = max(8, int(base.width * 0.035))
                    base.alpha_composite(
                        watermark,
                        dest=(
                            max(0, base.width - watermark.width - margin),
                            max(0, base.height - watermark.height - margin),
                        ),
                    )
            if not watermark:
                background = Image.new("RGBA", base.size, "#f4f0e6")
                background.alpha_composite(base)
                base = background
            output_path.parent.mkdir(parents=True, exist_ok=True)
            base.convert("RGB").save(output_path, "JPEG", quality=PHOTO_JPEG_QUALITY, optimize=True)

    def _stable_source_url(self, url: str) -> str:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return url
        return urlunparse(parsed._replace(query="", fragment=""))


def extract_notion_database_id(value: str) -> str:
    parsed = urlparse((value or "").strip())
    candidate = parsed.path.rsplit("/", 1)[-1] if parsed.scheme and parsed.netloc else value
    cleaned = re.sub(r"[^0-9a-fA-F]", "", candidate or "")
    if len(cleaned) != 32:
        raise RuntimeError(f"Invalid Notion database id: {value}")
    return (
        f"{cleaned[:8]}-{cleaned[8:12]}-{cleaned[12:16]}-"
        f"{cleaned[16:20]}-{cleaned[20:]}"
    ).lower()


def extract_title(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return "".join(item.get("plain_text", "") for item in property_value.get("title", []))


def extract_rich_text(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return "".join(item.get("plain_text", "") for item in property_value.get("rich_text", []))


def extract_property_text(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    kind = property_value.get("type")
    if kind == "title":
        return extract_title(property_value)
    if kind == "rich_text":
        return extract_rich_text(property_value)
    if kind in {"select", "status"}:
        value = property_value.get(kind) or {}
        return str(value.get("name") or "").strip()
    if kind == "formula":
        value = property_value.get("formula") or {}
        if value.get("type") == "string":
            return str(value.get("string") or "").strip()
        if value.get("type") == "number":
            number = value.get("number")
            return str(number) if isinstance(number, (int, float)) else ""
        return ""
    if kind == "rollup":
        value = property_value.get("rollup") or {}
        if value.get("type") == "array":
            return "".join(str(item.get("plain_text") or "") for item in value.get("array") or []).strip()
        if value.get("type") == "number":
            number = value.get("number")
            return str(number) if isinstance(number, (int, float)) else ""
    return ""


def extract_url(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return str(property_value.get("url") or "").strip()


def extract_number_value(property_value: dict[str, Any] | None) -> float | None:
    if not property_value:
        return None
    if property_value.get("type") == "number":
        value = property_value.get("number")
        return float(value) if isinstance(value, (int, float)) else None
    if property_value.get("type") == "formula":
        formula = property_value.get("formula") or {}
        if formula.get("type") == "number":
            value = formula.get("number")
            return float(value) if isinstance(value, (int, float)) else None
        if formula.get("type") == "string":
            return parse_float(formula.get("string"))
    if property_value.get("type") == "rollup":
        rollup = property_value.get("rollup") or {}
        if rollup.get("type") == "number":
            value = rollup.get("number")
            return float(value) if isinstance(value, (int, float)) else None
    text = extract_rich_text(property_value)
    return parse_float(text)


def parse_float(value: Any) -> float | None:
    raw = str(value or "").strip().replace(",", ".")
    match = re.search(r"\d+(?:\.\d+)?", raw)
    return float(match.group(0)) if match else None


def parse_price_usd(value: str) -> int | None:
    raw = str(value or "")
    match = re.search(r"\d[\d\s\u00a0.,]*", raw)
    if not match:
        return None
    digits = re.sub(r"[^\d]", "", match.group(0))
    return int(digits) if digits else None


def build_landhub_map_url(parcel_id: str, cadastral: str = "") -> str:
    normalized_id = re.sub(r"[^A-Za-z0-9_-]", "", str(parcel_id or "").strip())
    if normalized_id:
        return f"{LANDHUB_MAP_BASE_URL.rstrip('/')}/property/{normalized_id}/"
    value = str(cadastral or "").strip()
    if not value:
        return ""
    return f"{LANDHUB_MAP_BASE_URL}?{urlencode({'cad': value})}"


def site_asset_url(value: str) -> str:
    raw = str(value or "").strip()
    return f"/{raw[2:]}" if raw.startswith("./") else raw


def write_share_pages(items: list[dict[str, Any]], site_root: Path) -> None:
    pages_root = site_root / "property"
    pages_root.mkdir(parents=True, exist_ok=True)
    current_ids: set[str] = set()

    for item in items:
        parcel_id = re.sub(r"[^A-Za-z0-9_-]", "", str(item.get("parcel_id") or "").strip())
        if not parcel_id:
            continue
        current_ids.add(parcel_id)
        page_dir = pages_root / parcel_id
        page_dir.mkdir(parents=True, exist_ok=True)
        page_url = f"{LANDHUB_MAP_BASE_URL.rstrip('/')}/property/{parcel_id}/"
        redirect_url = f"../../?parcel={urlencode({'value': parcel_id})[6:]}"
        name = str(item.get("name") or "").strip()
        area = str(item.get("area") or "").strip()
        price = str(item.get("price") or "").strip()
        title_parts = [f"Ділянка в {name}" if name and name != "Без назви" else "Ділянка"]
        title_parts.extend(value for value in (area, price) if value and value != "—")
        title = " · ".join(title_parts)
        description = " · ".join(value for value in (area, price) if value and value != "—")
        image_path = str((item.get("photo_urls") or [""])[0] or "").strip()
        if image_path.startswith("./"):
            image_url = f"{LANDHUB_MAP_BASE_URL.rstrip('/')}/{image_path[2:]}"
        elif image_path.startswith("/"):
            image_url = f"{LANDHUB_MAP_BASE_URL.rstrip('/')}{image_path}"
        elif image_path.startswith("http"):
            image_url = image_path
        else:
            image_url = f"{LANDHUB_MAP_BASE_URL.rstrip('/')}/assets/landhub-hearts.png"

        html = f'''<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <title>{escape(title)}</title>
  <meta name="description" content="{escape(description, quote=True)}">
  <link rel="canonical" href="{escape(page_url, quote=True)}">
  <meta property="og:title" content="{escape(title, quote=True)}">
  <meta property="og:description" content="{escape(description, quote=True)}">
  <meta property="og:image" content="{escape(image_url, quote=True)}">
  <meta property="og:url" content="{escape(page_url, quote=True)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{escape(title, quote=True)}">
  <meta name="twitter:image" content="{escape(image_url, quote=True)}">
  <meta http-equiv="refresh" content="0;url={escape(redirect_url, quote=True)}">
  <script>location.replace({json.dumps(redirect_url)});</script>
</head>
<body><a href="{escape(redirect_url, quote=True)}">Відкрити ділянку</a></body>
</html>
'''
        (page_dir / "index.html").write_text(html, encoding="utf-8")

    manifest_path = pages_root / ".generated-pages.json"
    previous_ids: list[str] = []
    if manifest_path.exists():
        try:
            previous_ids = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            previous_ids = []
    for stale_id in previous_ids:
        if stale_id not in current_ids:
            stale_dir = pages_root / str(stale_id)
            if stale_dir.is_dir():
                for child in stale_dir.iterdir():
                    child.unlink()
                stale_dir.rmdir()
    manifest_path.write_text(json.dumps(sorted(current_ids), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_file_url(property_value: dict[str, Any] | None) -> str:
    urls = extract_file_urls(property_value)
    return urls[0] if urls else ""


def extract_file_urls(property_value: dict[str, Any] | None) -> list[str]:
    if not property_value:
        return []
    files = property_value.get("files") or []
    urls: list[str] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "external":
            url = (item.get("external") or {}).get("url")
        elif item.get("type") == "file":
            url = (item.get("file") or {}).get("url")
        else:
            url = ""
        if url:
            urls.append(str(url).strip())
    return urls


def resolve_maps_url(url: str, *, session: requests.Session) -> str:
    normalized = url.strip()
    if not normalized:
        return ""
    if "://" not in normalized:
        normalized = f"https://{normalized.lstrip('/')}"
    parsed = urlparse(normalized)
    if parsed.netloc != "maps.app.goo.gl":
        return normalized

    try:
        response = session.get(normalized, timeout=30, allow_redirects=True)
        response.raise_for_status()
        return response.url or normalized
    except requests.RequestException:
        return normalized


def extract_coordinates_from_maps_url(url: str) -> tuple[float, float]:
    normalized = url.strip()
    if not normalized:
        raise ValueError("missing maps url")
    if "://" not in normalized:
        normalized = f"https://{normalized.lstrip('/')}"

    parsed = urlparse(normalized)
    query = parse_qs(parsed.query)
    for key in ("query", "ll", "q"):
        for candidate in query.get(key, []):
            match = DECIMAL_COORD_RE.search(unquote(candidate))
            if match:
                return float(match.group(1)), float(match.group(2))

    for candidate in (parsed.path, unquote(parsed.path), normalized):
        match = re.search(r"@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)", candidate)
        if match:
            return float(match.group(1)), float(match.group(2))

    match = DECIMAL_COORD_RE.search(unquote(normalized))
    if match:
        return float(match.group(1)), float(match.group(2))

    raise ValueError(f"cannot parse coordinates from {url}")


if __name__ == "__main__":
    raise SystemExit(main())
