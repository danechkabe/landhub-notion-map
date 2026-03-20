 #!/usr/bin/env python3
  """Fetch map data from Notion and write a unified JSON payload for the site."""

  from __future__ import annotations

  import argparse
  from dataclasses import dataclass
  import json
  import re
  from pathlib import Path
  from typing import Any
  from urllib.parse import parse_qs, unquote, urlparse

  import requests

  NOTION_API_BASE = "https://api.notion.com/v1"
  NOTION_VERSION = "2026-03-11"
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
  OLX_STATUS_META = {
      "Дає на реалізацію": {"symbol": "📗", "color": "#54b66d", "key": "gives_to_sell"},
      "На сайт ок. Але з олх не прибере": {
          "symbol": "📙",
          "color": "#e49a42",
          "key": "site_ok_olx_keeps",
      },
      "Передзвонити": {"symbol": "📘", "color": "#5a8dee", "key": "callback"},
      "Не опрацьована": {"symbol": "📓", "color": "#7c6ee6", "key": "unprocessed"},
  }
  LANDMATCH_META = {"symbol": "💛", "color": "#e0b21b"}
  LANDHUB_META = {"symbol": "📍", "color": "#111111"}


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
      return parser.parse_args()


  def main() -> int:
      args = parse_args()
      session = requests.Session()
      headers = {
          "Authorization": f"Bearer {args.token.strip()}",
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
      }

      sources = [
          NotionSource(
              key="landmatch",
              label="LandMatch",
              database_url=LANDMATCH_URL,
              filter_payload={"property": "Status", "select": {"equals": "active"}},
          ),
          NotionSource(
              key="processing",
              label="В обробці",
              database_url=OLX_URL,
              filter_payload={
                  "or": [
                      {"property": "Status Даня", "status": {"equals": status}}
                      for status in OLX_STATUS_META
                  ]
              },
          ),
          NotionSource(
              key="landhub",
              label="LandHub",
              database_url=LANDHUB_URL,
          ),
      ]

      categories: dict[str, list[dict[str, Any]]] = {}
      counts: dict[str, int] = {}
      for source in sources:
          pages = fetch_database_pages(source, headers=headers, session=session)
          items = []
          for page in pages:
              item = normalize_page(source.key, page, session=session)
              if item is not None:
                  items.append(item)
          categories[source.key] = items
          counts[source.key] = len(items)

      payload = {
          "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
          "counts": counts,
          "categories": categories,
      }

      output_path = Path(args.output)
      output_path.parent.mkdir(parents=True, exist_ok=True)
      output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
      print(f"Wrote {sum(counts.values())} markers to {output_path}")
      return 0


  def fetch_database_pages(
      source: NotionSource,
      *,
      headers: dict[str, str],
      session: requests.Session,
  ) -> list[dict[str, Any]]:
      database_id = extract_notion_database_id(source.database_url)
      response = session.get(
          f"{NOTION_API_BASE}/databases/{database_id}",
          headers=headers,
          timeout=30,
      )
      response.raise_for_status()
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

          page = session.post(
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


  def normalize_page(
      source_key: str,
      page: dict[str, Any],
      *,
      session: requests.Session,
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

      if source_key == "landmatch":
          name = extract_title(properties.get("Name"))
          status_value = extract_select_name(properties.get("Status"))
          marker = LANDMATCH_META
      else:
          name = extract_title(properties.get("Назва села/ділянки"))
          status_value = extract_status_name(properties.get("Status Даня"))
          marker = OLX_STATUS_META.get(status_value, LANDHUB_META)
          if source_key == "landhub":
              marker = LANDHUB_META

      area = extract_rich_text(properties.get("Площа")) or "—"
      price = extract_rich_text(properties.get("Наша ціна")) or "—"
      distance = extract_rich_text(properties.get("до Києва")) or "—"
      notion_url = str(page.get("url") or "").strip()
      olx_url = extract_url(properties.get("Посилання на OLX"))

      payload = {
          "id": str(page.get("id") or ""),
          "source": source_key,
          "name": (name or "Без назви").strip(),
          "area": area.strip(),
          "price": price.strip(),
          "distance_to_kyiv": distance.strip(),
          "google_maps_url": resolved_map_url,
          "notion_url": notion_url,
          "olx_url": olx_url,
          "latitude": latitude,
          "longitude": longitude,
          "marker_symbol": marker["symbol"],
          "marker_color": marker["color"],
          "status_label": status_value or "",
          "status_key": marker.get("key", ""),
      }
      return payload


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


  def extract_url(property_value: dict[str, Any] | None) -> str:
      if not property_value:
          return ""
      return str(property_value.get("url") or "").strip()




  def extract_select_name(property_value: dict[str, Any] | None) -> str:
      if not property_value:
          return ""
      select = property_value.get("select") or {}
      return str(select.get("name") or "").strip()


  def extract_status_name(property_value: dict[str, Any] | None) -> str:
      if not property_value:
          return ""
      status = property_value.get("status") or {}
      return str(status.get("name") or "").strip()


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
