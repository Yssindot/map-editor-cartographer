# Cartographer

**Cartographer** (v0.6.1) is a browser-based hex map editor for grand-strategy style worlds. You paint terrain, elevation, countries, loyalty, culture, and population onto an axial hex grid, draw roads and rivers, stamp city labels, and export the map as JSON or PNG.

The app is a single-page editor: a sidebar of tools and a full-viewport HTML Canvas. There is no backend.

## Tech stack

| Layer | Choice |
| --- | --- |
| Language | Vanilla JavaScript (`script.js`, `'use strict'`) |
| Markup | Single `index.html` shell |
| Styling | `style.css` with `:root` design tokens |
| Rendering | HTML Canvas 2D (`#mapCanvas`) |
| Icons | [Lucide](https://lucide.dev/) from CDN (`unpkg.com/lucide@latest`) |
| Persistence | `localStorage` (settings + optional autosave) |

No bundler, no frameworks, no npm. The only external dependency is Lucide for sidebar icons.

## Project layout

```
map-editor-c/
├── index.html    # UI shell, sidebar panels, canvas, settings/about modals
├── script.js     # Hex math, map state, tools, undo, rendering, I/O
├── style.css     # Layout and tokens
└── README.md
```

Hexes live in a `Map` keyed by `"q,r"`. Each cell stores terrain, elevation, population, owner, loyalty, culture, optional `cityName`, and a `customData` object. Pixel positions (`x`, `y`) are derived from axial coordinates and `HEX_SIZE` (22) and are stripped on JSON export.

## Core mechanics

### Axial hex math

The grid is **pointy-top hexes** in **axial coordinates** `(q, r)`, with cube constraint `q + r + s = 0` (`s = -q - r`).

- **odd-r offset → axial** when generating a rectangular map (`offsetToAxial`): even rows stay aligned; odd rows shift `q`.
- **axial → pixel** (`axialToPixel`):  
  `x = size * (√3·q + √3/2·r)`, `y = size * (1.5·r)`.
- **pixel → axial** (`pixelToAxial` + `axialRound`): fractional cube rounding so pointer hits resolve to the nearest hex.
- **neighbors** use the six axial directions `{±1,0}`, `{1,-1}`, `{0,±1}`, `{-1,1}`.
- **distance** is cube distance: `(|Δq| + |Δq+Δr| + |Δr|) / 2`.
- **brush radius** is a hex disk (`hexRange`). **Roads/rivers** interpolate waypoints with `hexLine`.

All new hex geometry should reuse these helpers rather than inventing offset-only or cube-only math.

### Batched rendering

`render()` clears the canvas, applies camera transform (translate to center, scale zoom, translate by camera), then draws:

1. Optional reference image  
2. Hex fills and overlays (`drawHexes`)  
3. Ownership / loyalty / culture borders  
4. Routes and path preview  
5. City labels, brush preview, selection/hover outlines  

Fills are **batched by color**. Visible hexes (viewport cull with a `HEX_SIZE` margin) are grouped into `Map<color, hex[]>`. For each color the code `beginPath()`, appends every hex outline (`addHexToPath`), then a single `fill()`. Ownership, loyalty, culture tints and the population heatmap use the same pattern (`drawTintBatches`).

Grid lines are either a full honeycomb or **merged edges**: an edge is drawn only when the neighbor differs in terrain or elevation. Overlay alpha scales with how many tint layers are on so stacked views stay readable.

Camera: pan with middle/right mouse (or background-edit drag), zoom with wheel toward the cursor (`MIN_ZOOM` 0.12–`MAX_ZOOM` 5).

### Delta-based undo

History is **not** a full map snapshot on every brush stroke.

- **`beginAction()`** starts a stroke and snapshots country/culture registries.  
- **`markHexForUndo(hex)`** stores the **first** clone of each touched hex in `activeUndoDelta`.  
- **`commitAction()`** pushes a `{ type: 'delta', changes, countriesBefore/After, culturesBefore/After }` entry if anything changed. Stack size is capped (`MAX_UNDO`, default 30).

Undo restores those hex clones and the “before” registries; redo applies the inverse hex map plus “after” registries.

Other action types:

- **`full`** — whole-state snapshot (map generate, JSON import).  
- **`routes`** — before/after route lists (draw, edit, erase paths).

Redo is a parallel stack; a new committed action clears it.

### Layer-based painting

**View layers** (checkboxes) only change what is drawn: terrain base, elevation shading, ownership tints/borders, loyalty, culture, routes, population heatmap, full grid.

**Edit tools** are exclusive and listed in `TOOL_DEFS`. Each tool writes **its own hex fields** (country paint is the exception: it also sets matching loyalty). Number keys `1`–`8` switch tools. Paint tools use a hex-radius brush; stamp (`label`) clicks one hex; `path` is a waypoint editor.

| Shortcut | Tool | Writes |
| --- | --- | --- |
| 1 | Terrain | `terrain` |
| 2 | Owner / country | `owner` + `loyalty` |
| 3 | Loyalty | `loyalty` |
| 4 | Culture | `culture` |
| 5 | Population | `population` (set or add/subtract, falloff + jitter) |
| 6 | City / region label | `cityName` |
| 7 | Road / river | `routes[]` waypoints |
| 8 | Elevation | `elevation` |

Sidebar panels use `data-tool="<id>"` (or `data-tool-kind="paint"` for brush size). To add a layer: append a `TOOL_DEFS` entry and a matching panel.

Paths may join or cross at a **single** hex but must not run along each other (two consecutive shared hexes) or self-overlap. Invalid cells preview in red.

## Features (editor)

- Generate maps from 2×2 to 300×300 hexes (defaults 40×30).  
- Shift+click select a hex; set country capital; per-hex custom fields (string / number / boolean).  
- Background reference image: opacity, scale, offset, freeze-map edit mode.  
- Export JSON (`hex-map.json`, meta version 7) and PNG of the current canvas.  
- Import JSON; settings and optional timed autosave in this browser.

## Controls

- **Left drag** — paint (or path click, depending on tool)  
- **Shift+click** — select hex (or path waypoint while drawing)  
- **Middle / right drag** — pan  
- **Scroll** — zoom  
- **Ctrl+Z** / **Ctrl+Y** (or **Ctrl+Shift+Z**) — undo / redo  
- **Esc** — cancel path draft or close modal  
- **1–8** — tools (ignored while focus is in an input)

Custom keybinds call `e.preventDefault()` so the browser does not steal them.

## How to run

Cartographer is static files. Lucide icons load from the network.

**Option A — open the file**

1. Open `index.html` in a modern desktop browser (Chrome, Firefox, Edge).  
2. If the file URL blocks the CDN, use Option B.

**Option B — local static server**

From this directory:

```bash
# Python 3
python -m http.server 8080
```

Then visit `http://localhost:8080`.

No install, build, or environment variables are required. Settings and autosave stay in that origin’s `localStorage`.

## JSON export shape (summary)

```json
{
  "meta": { "version": 7, "cols": 40, "rows": 30, "hexSize": 22, "exportedAt": "…" },
  "owners": { "CountryName": { "color": "#c9a24d", "capital": { "q": 0, "r": 0 } } },
  "cultures": { "CultureName": { "color": "#9c6eb9" } },
  "routes": [{ "id": 1, "name": "…", "style": "dirt", "waypoints": [{ "q": 0, "r": 0 }] }],
  "hexes": [{ "q": 0, "r": 0, "terrain": "grassland", "elevation": "flat", "population": 0 }]
}
```

Pixel `x`/`y` are recomputed on import via `axialToPixel`.
