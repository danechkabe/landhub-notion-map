# LandHub Notion Map

Static GitHub Pages site that renders active parcels from `LandMatch Parcels`.

## Files

- `index.html`: page shell
- `styles.css`: visual styling
- `app.js`: Leaflet map logic
- `data/parcels.json`: exported Notion data

## Refresh data

From the project root:

```bash
python3 scripts/export_landmatch_map.py
```

That rewrites `github_pages_landhub_map/data/parcels.json`.
