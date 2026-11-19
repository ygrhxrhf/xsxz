# Atlas base map assets

`relief/{z}/{x}/{y}.webp` contains the 85 global zoom 0–3 relief tiles reused from
the user's `book-space-time` project, inspected at commit
`db9266411f4930ce02b6ac46a6f08ba9787a68e8` (2026-10-24).
The source project's Asia-only higher zoom tiles are not included.

Sources: Mapzen terrain / Tilezen elevation data and the Natural Earth land mask.
The UI preserves attribution; Natural Earth data are public domain.

- https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- https://registry.opendata.aws/terrain-tiles/
- https://www.naturalearthdata.com/about/terms-of-use/

Higher zoom elevation is requested directly from the public Mapzen Terrarium
tiles. It is a physical-geography reference, not a reconstruction of historical
political boundaries. If detailed tiles fail, the bundled global base remains.

3D terrain uses the same Terrarium provider with DEM levels through 14 for both
surface geometry and shading/color. The map allows zoom 12; entering 3D uses a
65-degree, zoom-10.5 local view with 1.25x elevation. Overview entry samples loaded
DEMs inside the book map's bounds, then refines the mountain location after
regional tiles load. A selected place or existing close view keeps its location.
Natural Earth coastlines remain regional cartography, not survey-level outlines.

`water.json` is an independent ocean/lake mask from Natural Earth 1:10m physical
vectors at revision `ca96624a56bd078437bca8184e78163e5039ad19`. It keeps sea-level DEM
noise from coloring water as land and preserves land below sea level. Land relief
and shading render underneath this mask. The mask is requested only when opening
the atlas; its 8.22 MB JSON transfers at approximately 2.77 MB with gzip.

Rebuild from the pinned public sources with `uv run scripts/build-atlas-water.py`
in `web/`. Geometry is simplified with topology preservation at 0.003 degrees,
then snapped to 0.00001 degrees; islands and lake holes are retained.
Large polygons are then partitioned into cells no wider/taller than 10 degrees
and emitted as separate polygon features (2,373 total). This prevents clipped
continental holes from producing spurious cross-land triangles during tile
triangulation. It is geometric partitioning, not a change to the water outline.
`src/atlas/waterMesh.test.ts` exercises the renderer's tiler and triangulator at
multiple zoom levels, including the former India artifact near 23.05 degrees N.

- Ocean SHA-256: `f9696a1337c746a0f6c8c13bc60d0f230d2ef8d105198d5657726c8f8e763fc2`
- Lakes SHA-256: `2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9`
- https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/
- https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-lakes/

The reviewed city coordinates in `src/atlas/catalog.ts` come from Natural Earth's
`ne_110m_populated_places.geojson`, retrieved 2026-10-24:
https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_populated_places.geojson

Book images are not bundled here. Original maps are read locally from the
reader's EPUB, identified by SHA-256, and displayed through temporary object URLs.
