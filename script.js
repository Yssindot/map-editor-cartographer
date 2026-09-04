'use strict';
/* ============================================================================
   CARTOGRAPHER — HEX GRAND-STRATEGY MAP EDITORs
   ============================================================================ */

/* ----------------------------------------------------------------------------
   1. CONSTANTS & TERRAIN DEFINITIONS
   ---------------------------------------------------------------------------- */
const HEX_SIZE = 22;     
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 5;
const DEFAULT_MAX_UNDO = 30;
let MAX_UNDO = DEFAULT_MAX_UNDO;

const DEFAULT_MAP_COLS = 40;
const DEFAULT_MAP_ROWS = 30;
const DEFAULT_TILE_OPACITY = 1;
const DEFAULT_TERRAIN_DEFS = [
  { id:'ocean',     label:'Ocean',     color:'#1c4a63' },
  { id:'grassland', label:'Grassland', color:'#9dbb61' },
  { id:'forest',    label:'Forest',    color:'#2f5b34' },
  { id:'steppe',    label:'Steppe',    color:'#b5a672' },
  { id:'desert',    label:'Desert',    color:'#e0be75' },
  { id:'extreme_desert', label:'Extreme Desert', color:'#8c6a47' },
  { id:'urban',     label:'Urban',     color:'#3a3a42' }
];
// Terrain ids from older exports that no longer exist, mapped to their replacements.
const LEGACY_TERRAIN_IDS = { plains: 'grassland', river: 'grassland' };
let TERRAIN_DEFS = DEFAULT_TERRAIN_DEFS.map(t => ({ ...t }));
const TERRAIN_COLORS = {};
TERRAIN_DEFS.forEach(t => TERRAIN_COLORS[t.id] = t.color);
const APP_VERSION = '0.7.0';

const ELEVATION_DEFS = [
  { id:'flat',      label:'Flat' },
  { id:'hills',     label:'Hills' },
  { id:'mountains', label:'Mountains' }
];
const ELEVATION_LABELS = Object.fromEntries(ELEVATION_DEFS.map(e => [e.id, e.label]));

const ROUTE_DEFS = [
  { id:'river1',  kind:'river', type:1, label:'Shallow River', color:'#8fd4ff', outline:'#3a8ec4', width: HEX_SIZE * 0.14 },
  { id:'river2',  kind:'river', type:2, label:'Deep River',    color:'#2f7eb8', outline:'#163e63', width: HEX_SIZE * 0.36 },
  { id:'dirt',    kind:'road',  type:1, label:'Dirt Road',      color:'#d2a66a', outline:'#7a5c32', width: HEX_SIZE * 0.22 },
  { id:'asphalt', kind:'road',  type:2, label:'Asphalt Road',   color:'#8a9098', outline:'#3d4148', width: HEX_SIZE * 0.22 }
];
const ROUTE_BY_ID = Object.fromEntries(ROUTE_DEFS.map(d => [d.id, d]));
const ROUTE_DRAW_ORDER = { river1: 0, river2: 1, dirt: 2, asphalt: 3 };
const PATH_INVALID_COLOR = '#ff5a5a';

/* ----------------------------------------------------------------------------
   2. HEX MATH
   ---------------------------------------------------------------------------- */
function axialToPixel(q, r, size){
  return {
    x: size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r),
    y: size * (1.5 * r)
  };
}

function pixelToAxial(x, y, size){
  return {
    q: (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size,
    r: (2 / 3 * y) / size
  };
}

function axialRound(q, r){
  let x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

function offsetToAxial(col, row){
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return { q, r };
}

function hexRange(centerQ, centerR, radius){
  const results = [];
  for (let dx = -radius; dx <= radius; dx++){
    const dyMin = Math.max(-radius, -dx - radius);
    const dyMax = Math.min(radius, -dx + radius);
    for (let dy = dyMin; dy <= dyMax; dy++){
      const dz = -dx - dy;
      results.push({ q: centerQ + dx, r: centerR + dz });
    }
  }
  return results;
}

const NEIGHBOR_DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }
];

function edgeSegment(centerA, centerB, size){
  const mx = (centerA.x + centerB.x) / 2, my = (centerA.y + centerB.y) / 2;
  let dx = centerB.x - centerA.x, dy = centerB.y - centerA.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const px = -dy, py = dx;
  const half = size / 2;
  return {
    x1: mx + px * half, y1: my + py * half,
    x2: mx - px * half, y2: my - py * half
  };
}

function clamp(v, min, max){ return Math.min(max, Math.max(min, v)); }

function axialDistance(q1, r1, q2, r2){
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

function hexLine(q1, r1, q2, r2){
  const n = axialDistance(q1, r1, q2, r2);
  const results = [];
  const q2n = q2 + 1e-6, r2n = r2 + 2e-6;
  for (let i = 0; i <= n; i++){
    const t = n === 0 ? 0 : i / n;
    results.push(axialRound(q1 + (q2n - q1) * t, r1 + (r2n - r1) * t));
  }
  return results;
}

function expandWaypoints(waypoints){
  if (!waypoints || waypoints.length === 0) return [];
  const out = [{ q: waypoints[0].q, r: waypoints[0].r }];
  for (let i = 1; i < waypoints.length; i++){
    const seg = hexLine(waypoints[i - 1].q, waypoints[i - 1].r, waypoints[i].q, waypoints[i].r);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  }
  return out;
}

/* ----------------------------------------------------------------------------
   3. COLOR HELPERS
   ---------------------------------------------------------------------------- */
function hslToHex(h, s, l){
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function parseHexColor(hex){
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return { r: 138, g: 144, b: 152 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max){
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function shiftHexHue(hex, dHue, sMul = 1, lMul = 1){
  const { r, g, b } = parseHexColor(hex);
  const hsl = rgbToHsl(r, g, b);
  return hslToHex((hsl.h + dHue + 360) % 360, clamp(hsl.s * sMul, 0, 100), clamp(hsl.l * lMul, 5, 92));
}

function nameHash(name){
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return hash;
}

function computeOwnerColor(name){
  return hslToHex(Math.abs(nameHash(name)) % 360, 65, 55);
}

function computeCultureColor(name){
  return hslToHex(Math.abs(nameHash(name + '\u0001culture')) % 360, 58, 52);
}

function grayLoyaltyColor(name){
  const hash = nameHash(name);
  return hslToHex(Math.abs(hash) % 360, 8 + Math.abs(hash >> 8) % 8, 46 + Math.abs(hash >> 4) % 14);
}

function loyaltyFillColor(hex){
  const name = hex.loyalty;
  if (!name) return null;
  const rec = factions.get(name);
  // A landless faction has no territory to take a color from, so it stays gray.
  if (!rec || factionHexCount(name) === 0) return grayLoyaltyColor(name);
  if (hex.owner === name) return rec.color;
  return shiftHexHue(rec.color, 48, 0.82, 0.78);
}

/* Factions are authored in the Faction Editor, keyed by their unique name.
   Unlike the old country map nothing prunes them, so a faction may hold no
   territory at all and still be paintable as a loyalty. */
const factions = new Map();

const FACTION_TYPES = [
  { id: 'state',    label: 'State' },
  { id: 'nonstate', label: 'Non-State' }
];
const FACTION_TYPE_LABELS = Object.fromEntries(FACTION_TYPES.map(t => [t.id, t.label]));

function normalizeFactionType(type){
  return FACTION_TYPE_LABELS[type] ? type : 'state';
}

function cloneCapital(cap){
  return cap && typeof cap.q === 'number' && typeof cap.r === 'number' ? { q: cap.q, r: cap.r } : null;
}

function cloneFaction(rec){
  return {
    color: rec.color,
    type: rec.type,
    ideology: rec.ideology,
    description: rec.description,
    flag: rec.flag,
    capital: cloneCapital(rec.capital)
  };
}

function makeFaction(name, raw = {}){
  return {
    color: typeof raw.color === 'string' && raw.color ? raw.color : computeOwnerColor(name),
    type: normalizeFactionType(raw.type),
    ideology: typeof raw.ideology === 'string' ? raw.ideology : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    flag: typeof raw.flag === 'string' && raw.flag ? raw.flag : null,
    capital: cloneCapital(raw.capital)
  };
}

function snapshotFactions(){
  return Array.from(factions.entries()).map(([name, rec]) => [name, cloneFaction(rec)]);
}

/* Goes through makeFaction rather than cloneFaction so an autosave written by
   an older build, which only stored color and capital, still normalizes. */
function restoreFactions(snap){
  factions.clear();
  if (snap){
    for (const [name, rec] of snap) factions.set(name, makeFaction(name, rec));
  }
  invalidateFactionCache();
}

function ensureFaction(name, raw){
  if (!name) return null;
  if (!factions.has(name)){
    factions.set(name, makeFaction(name, raw));
    invalidateFactionCache();
  } else if (raw && typeof raw.color === 'string' && raw.color){
    factions.get(name).color = raw.color;
  }
  return factions.get(name);
}

function factionColor(name){
  const rec = factions.get(name);
  return rec ? rec.color : computeOwnerColor(name);
}

function sortedFactionNames(){
  return Array.from(factions.keys()).sort((a, b) => a.localeCompare(b));
}

/* Owned-hex tallies drive the landless gray rule and the sidebar counts, and
   the capital index is read once per hex while labels are drawn. Both are
   rebuilt lazily like the population stats. */
let factionCounts = null;
let capitalIndex = null;

function invalidateFactionCache(){
  factionCounts = null;
  capitalIndex = null;
}

function getFactionCounts(){
  if (factionCounts) return factionCounts;
  factionCounts = new Map();
  for (const hex of hexes.values()){
    if (hex.owner) factionCounts.set(hex.owner, (factionCounts.get(hex.owner) || 0) + 1);
  }
  return factionCounts;
}

function getCapitalIndex(){
  if (capitalIndex) return capitalIndex;
  capitalIndex = new Map();
  for (const [name, rec] of factions){
    if (!rec.capital) continue;
    const key = `${rec.capital.q},${rec.capital.r}`;
    const at = capitalIndex.get(key);
    if (at) at.push(name);
    else capitalIndex.set(key, [name]);
  }
  return capitalIndex;
}

function factionHexCount(name){
  return getFactionCounts().get(name) || 0;
}

function uniqueFactionName(base){
  const stem = (base || 'New Faction').trim() || 'New Faction';
  if (!factions.has(stem)) return stem;
  let n = 2;
  while (factions.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

const cultures = new Map();

function cloneCultureRecord(rec){
  return { color: rec.color };
}

function snapshotCultures(){
  return Array.from(cultures.entries()).map(([name, rec]) => [name, cloneCultureRecord(rec)]);
}

function restoreCultures(snap){
  cultures.clear();
  if (!snap) return;
  for (const [name, rec] of snap){
    cultures.set(name, cloneCultureRecord(rec));
  }
}

function ensureCulture(name, preferredColor){
  if (!name) return null;
  if (!cultures.has(name)){
    cultures.set(name, { color: preferredColor || computeCultureColor(name) });
  } else if (preferredColor){
    cultures.get(name).color = preferredColor;
  }
  return cultures.get(name);
}

function cultureColor(name){
  return ensureCulture(name).color;
}

function peekCultureColor(name){
  return cultures.has(name) ? cultures.get(name).color : computeCultureColor(name);
}

function pruneUnusedCultures(){
  const active = new Set();
  for (const hex of hexes.values()) if (hex.culture) active.add(hex.culture);
  for (const name of Array.from(cultures.keys())){
    if (!active.has(name) && name !== brush.culture) cultures.delete(name);
  }
}

/* A capital is optional and independent of ownership: a landless faction may
   still point at the hex it claims as its seat. */
function getFactionCapitalHex(name){
  const rec = factions.get(name);
  if (!rec || !rec.capital) return null;
  return hexes.get(`${rec.capital.q},${rec.capital.r}`) || null;
}

function factionsWithCapitalAt(hex){
  if (!hex) return [];
  return getCapitalIndex().get(`${hex.q},${hex.r}`) || [];
}

function hexIsCapital(hex){
  return factionsWithCapitalAt(hex).length > 0;
}

function setFactionCapital(name, hex){
  const rec = factions.get(name);
  if (!rec) return;
  rec.capital = hex ? { q: hex.q, r: hex.r } : null;
  invalidateFactionCache();
}

function syncFactionCapitals(){
  for (const rec of factions.values()){
    if (!rec.capital) continue;
    if (!hexes.has(`${rec.capital.q},${rec.capital.r}`)) rec.capital = null;
  }
  invalidateFactionCache();
}

/* ----------------------------------------------------------------------------
   4. APPLICATION STATE
   ---------------------------------------------------------------------------- */
let mapCols = DEFAULT_MAP_COLS, mapRows = DEFAULT_MAP_ROWS;
const hexes = new Map();
const camera = { x: 0, y: 0, zoom: 1 };

const viewLayers = { terrain: true, elevation: true, ownership: true, loyalty: false, culture: false, population: false, routes: true };
let showFullGrid = false;
let tileOpacity = DEFAULT_TILE_OPACITY;
let prefConfirmDeletes = true;
let prefConfirmCleanOcean = true;
let prefWarnUnload = true;
let prefPromptRestore = true;
let prefAllowOceanElevPop = true;
let heatmapScale = 'log';
let popStats = { max: 0, dirty: true };
let activeTool = 'terrain';       
let backgroundEditMode = false;
let capitalPickMode = false;      // Faction Editor is waiting for a hex click

const brush = {
  terrain: 'ocean',
  elevation: 'hills',
  populationMode: 'set', 
  populationAmount: 0,
  owner: '',
  loyalty: '',
  culture: '',
  size: 1,
  routeStyle: 'river1',
  pathMode: 'draw'
};

const routes = [];
let nextRouteId = 1;
let pathDraft = null;
let selectedRouteId = null;
let routeDrag = null;

/* Exclusive layer tools. Add a new paint/stamp layer by appending one entry
   and a matching sidebar panel (data-tool="<id>" or data-tool-kind="paint"). */
const TOOL_DEFS = [
  {
    id: 'terrain',
    label: 'Terrain',
    kind: 'paint',
    shortcut: '1',
    hint: '<div><b>Left</b> drag — paint terrain</div>',
    previewFill: 'rgba(157, 187, 97, 0.28)',
    apply(hex){
      hex.terrain = brush.terrain;
    }
  },
  {
    id: 'owner',
    label: 'Faction',
    kind: 'paint',
    shortcut: '2',
    hint: '<div><b>Left</b> drag — paint faction territory</div>',
    previewFill: 'rgba(201, 162, 77, 0.28)',
    apply(hex){
      const nextOwner = factions.has(brush.owner) ? brush.owner : null;
      if (hex.owner !== nextOwner) invalidateFactionCache();
      hex.owner = nextOwner;
      if (prefAllowOceanElevPop || !isWaterHex(hex)) hex.loyalty = nextOwner;
    },
    afterStroke(){
      refreshFactionList();
      refreshLoyaltyList();
    }
  },
  {
    id: 'loyalty',
    label: 'Loyalty',
    kind: 'paint',
    shortcut: '3',
    hint: '<div><b>Left</b> drag — paint loyalty</div>',
    previewFill: 'rgba(138, 144, 152, 0.28)',
    apply(hex){
      hex.loyalty = factions.has(brush.loyalty) ? brush.loyalty : null;
    },
    afterStroke(){
      refreshLoyaltyList();
    }
  },
  {
    id: 'culture',
    label: 'Culture',
    kind: 'paint',
    shortcut: '4',
    hint: '<div><b>Left</b> drag — paint culture</div>',
    previewFill: 'rgba(156, 110, 185, 0.28)',
    apply(hex){
      const next = brush.culture.trim() === '' ? null : brush.culture.trim();
      hex.culture = next;
      if (next) ensureCulture(next);
    },
    afterStroke(){
      refreshCultureList();
    }
  },
  {
    id: 'population',
    label: 'Population',
    kind: 'paint',
    shortcut: '5',
    hint: '<div><b>Left</b> drag — paint population</div>',
    previewFill: 'rgba(79, 195, 255, 0.28)',
    apply(hex, paintCtx = {}){
      const dist = paintCtx.axialDistance || 0;
      const falloff = Math.pow(0.5, dist);
      const jitter = 0.85 + Math.random() * 0.3;
      const amount = brush.populationAmount * falloff * jitter;
      const prevPop = hex.population;
      if (brush.populationMode === 'set'){
        hex.population = Math.max(0, Math.round(amount));
      } else {
        hex.population = Math.max(0, hex.population + Math.round(amount));
      }
      if (hex.population !== prevPop) invalidatePopulationStats();
    }
  },
  {
    id: 'label',
    label: 'City / Region Label',
    kind: 'stamp',
    shortcut: '6',
    hint: '<div><b>Left</b> click — apply label</div>',
    apply(hex){
      applyCityLabelToHex(hex);
    }
  },
  {
    id: 'path',
    label: 'Road / River',
    kind: 'path',
    shortcut: '7',
    hint: '<div><b>Click</b> — start or finish path</div><div><b>Shift+Click</b> — add waypoint</div><div><b>Click end</b> — extend path</div><div><b>Esc</b> — cancel</div>'
  },
  {
    id: 'elevation',
    label: 'Elevation',
    kind: 'paint',
    shortcut: '8',
    hint: '<div><b>Left</b> drag — paint elevation</div>',
    previewFill: 'rgba(40, 40, 40, 0.28)',
    apply(hex){
      hex.elevation = brush.elevation;
    }
  }
];
const TOOL_BY_ID = Object.fromEntries(TOOL_DEFS.map(t => [t.id, t]));

function getToolDef(id = activeTool){
  return TOOL_BY_ID[id] || TOOL_DEFS[0];
}

function isPaintTool(id = activeTool){
  return getToolDef(id).kind === 'paint';
}

function skipOceanForTool(tool = getToolDef()){
  return !prefAllowOceanElevPop && (tool.id === 'population' || tool.id === 'elevation' || tool.id === 'culture' || tool.id === 'loyalty');
}

const bgImage = { img: null, opacity: 0.5, scale: 1, offsetX: 0, offsetY: 0, visible: true };

let isPainting = false;
let isPanning = false;
let isDraggingBg = false;
let lastPanX = 0, lastPanY = 0;
let hoveredHex = null;
let selectedHex = null;   

/* ----------------------------------------------------------------------------
   5. UNDO / REDO HISTORY (Delta Based)
   ---------------------------------------------------------------------------- */
const undoStack = [];
const redoStack = [];

let isActionActive = false;
let activeUndoDelta = new Map();
let activeFactionsBefore = null;
let activeCulturesBefore = null;

function cloneHex(h){ return { ...h, elevation: h.elevation || 'flat', customData: { ...h.customData } }; }

function cloneWaypoints(waypoints){
  return (waypoints || []).map(w => ({ q: w.q, r: w.r }));
}

function cloneRoutes(list = routes){
  return list.map(r => ({
    id: r.id,
    style: r.style,
    name: r.name,
    waypoints: cloneWaypoints(r.waypoints)
  }));
}

function routeNameTaken(name, exceptId){
  const needle = name.trim().toLowerCase();
  return routes.some(r => r.id !== exceptId && r.name.toLowerCase() === needle);
}

function defaultRouteName(style){
  const base = (ROUTE_BY_ID[style] || {}).label || 'Route';
  let n = 1;
  while (routeNameTaken(`${base} #${n}`, null)) n++;
  return `${base} #${n}`;
}

function makeRoute(id, style, waypoints, name){
  invalidateRouteIndex();
  return {
    id,
    style,
    name: name || defaultRouteName(style),
    waypoints: cloneWaypoints(waypoints),
    hexes: expandWaypoints(waypoints)
  };
}

function restoreRoutes(snap){
  routes.length = 0;
  invalidateRouteIndex();
  let maxId = 0;
  if (snap){
    for (const r of snap){
      const parsed = parseRouteRecord(r, false);
      if (!parsed) continue;
      routes.push(parsed);
      if (parsed.id > maxId) maxId = parsed.id;
    }
  }
  nextRouteId = maxId + 1;
  invalidateRouteIndex();
  routeDrag = null;
  if (!routes.some(r => r.id === selectedRouteId)) selectedRouteId = null;
}

/* Hex key -> route ids. Rebuilt lazily; every route mutation invalidates it. */
let routeCellIndex = null;

function invalidateRouteIndex(){
  routeCellIndex = null;
}

function routeCells(route){
  if (!route.hexes) route.hexes = expandWaypoints(route.waypoints);
  return route.hexes;
}

function getRouteIndex(){
  if (routeCellIndex) return routeCellIndex;
  routeCellIndex = new Map();
  for (const route of routes){
    for (const cell of routeCells(route)){
      const key = `${cell.q},${cell.r}`;
      const ids = routeCellIndex.get(key);
      if (ids) ids.push(route.id);
      else routeCellIndex.set(key, [route.id]);
    }
  }
  return routeCellIndex;
}

function routeIdsAtKey(key){
  return getRouteIndex().get(key) || [];
}

/* A path may never cover a hex twice, and may touch another path only at single
   hexes — junctions, branch origins and crossings. Sharing two hexes in a row
   means the two paths would run along each other, which is rejected. */
function validatePath(waypoints, excludeRouteId){
  const cells = expandWaypoints(waypoints);
  const blocked = new Set();
  if (cells.length < 2) return { ok: true, cells, blocked };

  const seen = new Set();
  for (const cell of cells){
    const key = `${cell.q},${cell.r}`;
    if (seen.has(key)) blocked.add(key);
    seen.add(key);
  }

  const idsPerCell = cells.map(c => routeIdsAtKey(`${c.q},${c.r}`).filter(id => id !== excludeRouteId));
  for (let i = 0; i < cells.length - 1; i++){
    const overlapsSameRoute = idsPerCell[i].some(id => idsPerCell[i + 1].includes(id));
    if (overlapsSameRoute){
      blocked.add(`${cells[i].q},${cells[i].r}`);
      blocked.add(`${cells[i + 1].q},${cells[i + 1].r}`);
    }
  }

  return { ok: blocked.size === 0, cells, blocked };
}

function snapshotState(){
  return { hexes: Array.from(hexes.values()).map(cloneHex), mapCols, mapRows, factions: snapshotFactions(), cultures: snapshotCultures(), routes: cloneRoutes() };
}

function applyFullState(state){
  hexes.clear();
  state.hexes.forEach(h => hexes.set(`${h.q},${h.r}`, cloneHex(h)));
  mapCols = state.mapCols; mapRows = state.mapRows;
  document.getElementById('mapCols').value = mapCols;
  document.getElementById('mapRows').value = mapRows;
  restoreFactions(state.factions || state.countries);
  restoreCultures(state.cultures);
  restoreRoutes(state.routes);
  invalidateFactionCache();
}

function pushFullStateUndo() {
  undoStack.push({ type: 'full', state: snapshotState() });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function beginAction() {
  isActionActive = true;
  activeUndoDelta.clear();
  activeFactionsBefore = snapshotFactions();
  activeCulturesBefore = snapshotCultures();
}

function markHexForUndo(hex) {
  if (!isActionActive) return;
  const key = `${hex.q},${hex.r}`;
  if (!activeUndoDelta.has(key)) {
    activeUndoDelta.set(key, cloneHex(hex));
  }
}

const AUTOSAVE_KEY = 'cartographer_autosave';
const SETTINGS_KEY = 'cartographer_settings';
const DEFAULT_AUTOSAVE_MS = 2 * 60 * 1000;
let autosaveTimerId = null;
let autosaveIntervalMs = DEFAULT_AUTOSAVE_MS;
let lastAutosaveAt = 0;

function persistAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshotState()));
    lastAutosaveAt = Date.now();
  } catch (_) { /* quota / private mode */ }
}

function throttledAutosave() {
  if (autosaveIntervalMs <= 0) return;
  if (Date.now() - lastAutosaveAt < autosaveIntervalMs) return;
  persistAutosave();
}

window.addEventListener('beforeunload', e => {
  if (prefWarnUnload !== true) return;
  e.preventDefault();
  e.returnValue = '';
});

function setAutosaveInterval(ms){
  const interval = Number(ms) || 0;
  autosaveIntervalMs = interval > 0 ? interval : 0;
  clearInterval(autosaveTimerId);
  autosaveTimerId = null;
  if (autosaveIntervalMs > 0){
    autosaveTimerId = setInterval(persistAutosave, autosaveIntervalMs);
  }
}

function prefBool(value, fallback = true){
  return typeof value === 'boolean' ? value : fallback;
}

function applyPrefsFromObject(prefs){
  if (!prefs || typeof prefs !== 'object') return;
  if (prefs.maxUndo != null){
    MAX_UNDO = Math.max(1, parseInt(prefs.maxUndo, 10) || DEFAULT_MAX_UNDO);
    while (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  if (prefs.autosaveMs != null) setAutosaveInterval(prefs.autosaveMs);
  if (prefs.prefConfirmDeletes != null) prefConfirmDeletes = prefBool(prefs.prefConfirmDeletes, true);
  if (prefs.prefConfirmCleanOcean != null) prefConfirmCleanOcean = prefBool(prefs.prefConfirmCleanOcean, true);
  if (prefs.prefWarnUnload != null) prefWarnUnload = prefBool(prefs.prefWarnUnload, true);
  if (prefs.prefPromptRestore != null) prefPromptRestore = prefBool(prefs.prefPromptRestore, true);
  if (prefs.prefAllowOceanElevPop != null) prefAllowOceanElevPop = prefBool(prefs.prefAllowOceanElevPop, true);
  const autosaveEl = document.getElementById('settingsAutosave');
  const maxUndoEl = document.getElementById('settingsMaxUndo');
  if (autosaveEl){
    const value = String(Number(autosaveIntervalMs) || 0);
    autosaveEl.value = [...autosaveEl.options].some(o => o.value === value) ? value : '0';
  }
  if (maxUndoEl) maxUndoEl.value = MAX_UNDO;
  const confirmEl = document.getElementById('settingsPrefConfirmDeletes');
  const cleanOceanEl = document.getElementById('settingsPrefConfirmCleanOcean');
  const warnEl = document.getElementById('settingsPrefWarnUnload');
  const restoreEl = document.getElementById('settingsPrefPromptRestore');
  const oceanEl = document.getElementById('settingsPrefOceanElevPop');
  if (confirmEl) confirmEl.checked = prefConfirmDeletes;
  if (cleanOceanEl) cleanOceanEl.checked = prefConfirmCleanOcean;
  if (warnEl) warnEl.checked = prefWarnUnload;
  if (restoreEl) restoreEl.checked = prefPromptRestore;
  if (oceanEl) oceanEl.checked = prefAllowOceanElevPop;
}

function commitAction() {
  if (!isActionActive) return;
  invalidateFactionCache();
  syncFactionCapitals();
  pruneUnusedCultures();
  const factionsAfter = snapshotFactions();
  const culturesAfter = snapshotCultures();
  const factionsChanged = JSON.stringify(activeFactionsBefore) !== JSON.stringify(factionsAfter);
  const culturesChanged = JSON.stringify(activeCulturesBefore) !== JSON.stringify(culturesAfter);
  if (activeUndoDelta.size > 0 || factionsChanged || culturesChanged) {
    undoStack.push({
      type: 'delta',
      changes: activeUndoDelta,
      factionsBefore: activeFactionsBefore,
      factionsAfter,
      culturesBefore: activeCulturesBefore,
      culturesAfter
    });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
    throttledAutosave();
  }
  isActionActive = false;
  activeUndoDelta = new Map();
  activeFactionsBefore = null;
  activeCulturesBefore = null;
  refreshSelectedHexPanel();
}

function executeAtomicDelta(hexesToMark, fn) {
  beginAction();
  hexesToMark.forEach(h => markHexForUndo(h));
  fn();
  commitAction();
}

function undo(){
  if (undoStack.length === 0) return;
  cancelPathDraft();
  const action = undoStack.pop();
  
  if (action.type === 'full') {
    redoStack.push({ type: 'full', state: snapshotState() });
    applyFullState(action.state);
  } else if (action.type === 'delta') {
    const redoDelta = new Map();
    for (const [key, oldHex] of action.changes.entries()) {
      redoDelta.set(key, cloneHex(hexes.get(key)));
      hexes.set(key, cloneHex(oldHex));
    }
    redoStack.push({
      type: 'delta',
      changes: redoDelta,
      factionsBefore: action.factionsBefore,
      factionsAfter: action.factionsAfter,
      culturesBefore: action.culturesBefore,
      culturesAfter: action.culturesAfter
    });
    restoreFactions(action.factionsBefore);
    restoreCultures(action.culturesBefore);
  } else if (action.type === 'routes') {
    redoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.before);
  }

  reresolveSelection();
  invalidatePopulationStats();
  render();
  refreshFactionList();
  refreshLoyaltyList();
  refreshCultureList();
  refreshRouteList();
  refreshSelectedHexPanel();
  updateHistoryButtons();
}

function redo(){
  if (redoStack.length === 0) return;
  cancelPathDraft();
  const action = redoStack.pop();
  
  if (action.type === 'full') {
    undoStack.push({ type: 'full', state: snapshotState() });
    applyFullState(action.state);
  } else if (action.type === 'delta') {
    const undoDelta = new Map();
    for (const [key, newHex] of action.changes.entries()) {
      undoDelta.set(key, cloneHex(hexes.get(key)));
      hexes.set(key, cloneHex(newHex));
    }
    undoStack.push({
      type: 'delta',
      changes: undoDelta,
      factionsBefore: action.factionsBefore,
      factionsAfter: action.factionsAfter,
      culturesBefore: action.culturesBefore,
      culturesAfter: action.culturesAfter
    });
    restoreFactions(action.factionsAfter);
    restoreCultures(action.culturesAfter);
  } else if (action.type === 'routes') {
    undoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.after);
  }

  reresolveSelection();
  invalidatePopulationStats();
  render();
  refreshFactionList();
  refreshLoyaltyList();
  refreshCultureList();
  refreshRouteList();
  refreshSelectedHexPanel();
  updateHistoryButtons();
}

function reresolveSelection(){
  hoveredHex = null;
  if (selectedHex) selectedHex = hexes.get(`${selectedHex.q},${selectedHex.r}`) || null;
  refreshSelectedHexPanel();
}

function updateHistoryButtons(){
  document.getElementById('undoBtn').disabled = undoStack.length === 0;
  document.getElementById('redoBtn').disabled = redoStack.length === 0;
}

function pushRoutesUndo(before){
  const after = cloneRoutes();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  undoStack.push({ type: 'routes', before, after });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function parseRouteRecord(raw, assignId){
  if (!raw || !Array.isArray(raw.waypoints)) return null;
  let style = raw.style;
  if (!ROUTE_BY_ID[style] && raw.kind != null && raw.type != null){
    const match = ROUTE_DEFS.find(d => d.kind === raw.kind && d.type === Number(raw.type));
    style = match ? match.id : null;
  }
  if (!ROUTE_BY_ID[style]) return null;
  const waypoints = raw.waypoints
    .filter(w => w && typeof w.q === 'number' && typeof w.r === 'number')
    .map(w => ({ q: w.q, r: w.r }));
  if (waypoints.length < 2) return null;
  const id = (typeof raw.id === 'number' && !assignId) ? raw.id : nextRouteId++;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  return makeRoute(id, style, waypoints, name);
}

/* ----------------------------------------------------------------------------
   6. MAP GENERATION
   ---------------------------------------------------------------------------- */
function generateMap(cols, rows){
  hexes.clear();
  factions.clear();
  invalidateFactionCache();
  cultures.clear();
  routes.length = 0;
  nextRouteId = 1;
  pathDraft = null;
  routeDrag = null;
  selectedRouteId = null;
  invalidateRouteIndex();
  invalidatePopulationStats();
  for (let row = 0; row < rows; row++){
    for (let col = 0; col < cols; col++){
      const { q, r } = offsetToAxial(col, row);
      const coords = axialToPixel(q, r, HEX_SIZE);
      hexes.set(`${q},${r}`, {
        q, r, x: coords.x, y: coords.y, terrain: 'ocean', elevation: 'flat', population: 0, owner: null,
        loyalty: null, culture: null, cityName: null, customData: {}
      });
    }
  }
  mapCols = cols;
  mapRows = rows;
  refreshPathUi();
  refreshRouteList();
}

function centerCamera(){
  if (hexes.size === 0){ camera.x = 0; camera.y = 0; return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const hex of hexes.values()){
    if (hex.x < minX) minX = hex.x; if (hex.x > maxX) maxX = hex.x;
    if (hex.y < minY) minY = hex.y; if (hex.y > maxY) maxY = hex.y;
  }
  camera.x = (minX + maxX) / 2;
  camera.y = (minY + maxY) / 2;
  const w = (maxX - minX) + HEX_SIZE * 4;
  const h = (maxY - minY) + HEX_SIZE * 4;
  const fitZoom = Math.min(canvas.width / w, canvas.height / h);
  camera.zoom = clamp(isFinite(fitZoom) ? fitZoom : 1, MIN_ZOOM, MAX_ZOOM);
}

/* ----------------------------------------------------------------------------
   7. RENDERING (Optimized Batch System)
   ---------------------------------------------------------------------------- */
const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.getElementById('canvasWrap');
const hudStatsEl = document.getElementById('hud-stats');
const inspectorHudEl = document.getElementById('inspector-hud');

function screenToWorld(mx, my){
  return {
    x: (mx - canvas.width / 2) / camera.zoom + camera.x,
    y: (my - canvas.height / 2) / camera.zoom + camera.y
  };
}

function drawBackgroundImage(){
  if (!bgImage.img || !bgImage.visible) return;
  ctx.save();
  ctx.globalAlpha = bgImage.opacity;
  const w = bgImage.img.width * bgImage.scale;
  const h = bgImage.img.height * bgImage.scale;
  ctx.drawImage(bgImage.img, bgImage.offsetX - w / 2, bgImage.offsetY - h / 2, w, h);
  ctx.restore();
}

function getFillColor(hex){
  const baseColor = viewLayers.terrain ? (TERRAIN_COLORS[hex.terrain] || TERRAIN_COLORS.ocean) : '#161b20';
  if (viewLayers.elevation){
    if (hex.elevation === 'hills') return shiftHexHue(baseColor, 0, 1, 0.82);
    if (hex.elevation === 'mountains') return shiftHexHue(baseColor, 0, 0.85, 0.60);
  }
  return baseColor;
}

function lerp(a, b, t){ return a + (b - a) * t; }

function lerpColor(c1, c2, t){
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t))
  ];
}

const HEATMAP_STOPS = [
  { t: 0,    c: [12, 44, 84] },
  { t: 0.25, c: [29, 145, 192] },
  { t: 0.5,  c: [255, 237, 160] },
  { t: 0.75, c: [252, 141, 89] },
  { t: 1,    c: [215, 48, 39] }
];

function heatmapColorAt(t){
  const x = clamp(t, 0, 1);
  let a = HEATMAP_STOPS[0], b = HEATMAP_STOPS[HEATMAP_STOPS.length - 1];
  for (let i = 0; i < HEATMAP_STOPS.length - 1; i++){
    if (x >= HEATMAP_STOPS[i].t && x <= HEATMAP_STOPS[i + 1].t){
      a = HEATMAP_STOPS[i];
      b = HEATMAP_STOPS[i + 1];
      break;
    }
  }
  const span = (b.t - a.t) || 1;
  const [r, g, bl] = lerpColor(a.c, b.c, (x - a.t) / span);
  return `rgb(${r},${g},${bl})`;
}

function invalidatePopulationStats(){
  popStats.dirty = true;
}

function getPopulationStats(){
  if (!popStats.dirty) return popStats;
  let max = 0;
  for (const hex of hexes.values()){
    if (hex.population > max) max = hex.population;
  }
  popStats.max = max;
  popStats.dirty = false;
  return popStats;
}

function populationHeatT(pop, maxPop){
  if (pop <= 0 || maxPop <= 0) return 0;
  if (heatmapScale === 'log') return Math.log1p(pop) / Math.log1p(maxPop);
  return pop / maxPop;
}

function getHeatmapColor(pop, maxPop) {
  if (pop <= 0) return 'rgba(0,0,0,0)';
    const t = Math.max(0.04, populationHeatT(pop, maxPop));
    return heatmapColorAt(Math.round(t * 32) / 32);
}

function formatPop(n){
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

function updateHeatmapLegend(){
  const wrap = document.getElementById('heatmapControls');
  const maxEl = document.getElementById('heatmapLegendMax');
  const midEl = document.getElementById('heatmapLegendMid');
  if (!wrap) return;
  wrap.hidden = !viewLayers.population;
  if (!viewLayers.population) return;
  const max = getPopulationStats().max;
  maxEl.textContent = max > 0 ? formatPop(max) : '0';
  if (max <= 0){
    midEl.textContent = '—';
    return;
  }
  if (heatmapScale === 'log'){
    const mid = Math.expm1(Math.log1p(max) * 0.5);
    midEl.textContent = formatPop(Math.round(mid));
  } else {
    midEl.textContent = formatPop(Math.round(max / 2));
  }
}

function addHexToPath(ctx, cx, cy, size){
  for (let i = 0; i < 6; i++){
    const angleRad = Math.PI / 180 * (60 * i - 30);
    const px = cx + size * Math.cos(angleRad);
    const py = cy + size * Math.sin(angleRad);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawHexes(){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 2;
  
  const batches = new Map();
  const visibleHexes = [];

  for (const hex of hexes.values()){
    if (hex.x < tl.x - margin || hex.x > br.x + margin || hex.y < tl.y - margin || hex.y > br.y + margin) continue;
    visibleHexes.push(hex);
    
    const color = getFillColor(hex);
    if (!batches.has(color)) batches.set(color, []);
    batches.get(color).push(hex);
  }

  // 1. Draw Base Fills
  ctx.save();
  ctx.globalAlpha = tileOpacity;
  for (const [color, batch] of batches.entries()){
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const hex of batch) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    ctx.fill();
  }
  ctx.restore();

  const overlayAlpha = overlayFillAlpha();

  // 2. Draw Ownership Tints
  if (viewLayers.ownership){
    drawTintBatches(visibleHexes, hex => hex.owner ? factionColor(hex.owner) : null, overlayAlpha);
  }

  // 3. Draw Loyalty Tints
  if (viewLayers.loyalty){
    drawTintBatches(visibleHexes, loyaltyFillColor, overlayAlpha);
  }

  // 4. Draw Culture Tints
  if (viewLayers.culture){
    drawTintBatches(visibleHexes, hex => hex.culture ? cultureColor(hex.culture) : null, overlayAlpha);
  }

  // 5. Draw Population Heatmap
  if (viewLayers.population) {
    const maxPop = getPopulationStats().max || 1;
    ctx.save();
    ctx.globalAlpha = 0.78 * tileOpacity;
    const heatBatches = new Map();
    for (const hex of visibleHexes) {
      if (hex.population <= 0) continue;
      const color = getHeatmapColor(hex.population, maxPop);
      if (!heatBatches.has(color)) heatBatches.set(color, []);
      heatBatches.get(color).push(hex);
    }
    for (const [color, batch] of heatBatches.entries()){
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const hex of batch) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
      ctx.fill();
    }
    ctx.restore();
  }

  // 6. Draw grid edges (full honeycomb, or merge matching terrain/elevation)
  ctx.beginPath();
  ctx.lineWidth = 1 / camera.zoom;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  if (showFullGrid){
    for (const hex of visibleHexes) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
  } else {
    for (const hex of visibleHexes){
      for (const dir of NEIGHBOR_DIRS){
        const neighbor = hexes.get(`${hex.q + dir.q},${hex.r + dir.r}`);
        if (neighbor && neighbor.terrain === hex.terrain && neighbor.elevation === hex.elevation) continue;
        const nCenter = neighbor
          ? { x: neighbor.x, y: neighbor.y }
          : axialToPixel(hex.q + dir.q, hex.r + dir.r, HEX_SIZE);
        const seg = edgeSegment({ x: hex.x, y: hex.y }, nCenter, HEX_SIZE);
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
      }
    }
  }
  ctx.stroke();

  return visibleHexes;
}

function overlayFillAlpha(){
  const overlays = [viewLayers.ownership, viewLayers.loyalty, viewLayers.culture].filter(Boolean).length;
  const base = viewLayers.terrain ? 0.3 : (overlays > 1 ? 0.5 : 1.0);
  return base * tileOpacity;
}

function drawTintBatches(visibleHexes, getColor, alpha){
  const batches = new Map();
  for (const hex of visibleHexes){
    const color = getColor(hex);
    if (!color) continue;
    if (!batches.has(color)) batches.set(color, []);
    batches.get(color).push(hex);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const [color, batch] of batches.entries()){
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const hex of batch) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    ctx.fill();
  }
  ctx.restore();
}

function drawFieldBorders(getValue, getColor, { dash = [], width = 3 } = {}){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 2;
  ctx.lineWidth = width / camera.zoom;
  ctx.lineCap = 'round';
  ctx.setLineDash(dash.map(d => d / camera.zoom));

  for (const hex of hexes.values()){
    const value = getValue(hex);
    if (!value) continue;
    if (hex.x < tl.x - margin || hex.x > br.x + margin || hex.y < tl.y - margin || hex.y > br.y + margin) continue;

    ctx.strokeStyle = getColor(hex, value);
    for (const dir of NEIGHBOR_DIRS){
      const neighbor = hexes.get(`${hex.q + dir.q},${hex.r + dir.r}`);
      if (neighbor && getValue(neighbor) === value) continue;

      const nCenter = neighbor ? { x: neighbor.x, y: neighbor.y } : axialToPixel(hex.q + dir.q, hex.r + dir.r, HEX_SIZE);
      const seg = edgeSegment({ x: hex.x, y: hex.y }, nCenter, HEX_SIZE);
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

function drawOwnershipBorders(){
  if (!viewLayers.ownership) return;
  drawFieldBorders(hex => hex.owner, (hex, name) => factionColor(name), { width: 3 });
}

function drawLoyaltyBorders(){
  if (!viewLayers.loyalty) return;
  drawFieldBorders(hex => hex.loyalty, hex => loyaltyFillColor(hex), { width: 2.4, dash: [7, 5] });
}

function drawCultureBorders(){
  if (!viewLayers.culture) return;
  drawFieldBorders(hex => hex.culture, (hex, name) => cultureColor(name), { width: 2.2, dash: [2, 4] });
}

function starPath(cx, cy, outerR, innerR, points){
  const p = new Path2D();
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++){
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + i * step;
    const px = cx + r * Math.cos(angle), py = cy + r * Math.sin(angle);
    if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
  }
  p.closePath();
  return p;
}

function drawCityLabels(){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 3;
  const fontSize = Math.max(10, HEX_SIZE * 0.42);
  
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = fontSize * 0.22;

  for (const hex of hexes.values()){
    if (hex.x < tl.x - margin || hex.x > br.x + margin || hex.y < tl.y - margin || hex.y > br.y + margin) continue;
    if (!hex.cityName && !hexIsCapital(hex)) continue;
    
    if (hex.cityName) {
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#ffffff';
      ctx.strokeText(hex.cityName, hex.x, hex.y);
      ctx.fillText(hex.cityName, hex.x, hex.y);
    }

    if (hexIsCapital(hex)) {
      const outerR = HEX_SIZE * 0.3, innerR = outerR * 0.5;
      const offsetY = hex.cityName ? -fontSize * 1.55 : 0;
      const path = starPath(hex.x, hex.y + offsetY, outerR, innerR, 8);
      ctx.fillStyle = '#ff4a4a';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, HEX_SIZE * 0.06);
      ctx.fill(path);
      ctx.stroke(path);
    }
  }
}

function isWaterHex(hex){
  return !!hex && hex.terrain === 'ocean';
}

/* Paths stop at hex centres, which leaves a river hanging inland when the coast
   is the next hex over. For rivers only, the terminal drains into the ocean hex
   that best continues its flow. Both the renderer and the exporter use this. */
function riverMouthNeighbor(cell, inwardCell){
  const hex = cell ? hexes.get(`${cell.q},${cell.r}`) : null;
  if (!hex || isWaterHex(hex)) return null;

  const inward = inwardCell ? hexes.get(`${inwardCell.q},${inwardCell.r}`) : null;
  let flowX = 0, flowY = 0;
  if (inward){
    flowX = hex.x - inward.x;
    flowY = hex.y - inward.y;
    const len = Math.hypot(flowX, flowY) || 1;
    flowX /= len; flowY /= len;
  }

  let best = null, bestDot = -Infinity;
  for (const dir of NEIGHBOR_DIRS){
    const neighbor = hexes.get(`${cell.q + dir.q},${cell.r + dir.r}`);
    if (!isWaterHex(neighbor)) continue;
    let vx = neighbor.x - hex.x, vy = neighbor.y - hex.y;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    const dot = inward ? vx * flowX + vy * flowY : 1;
    if (dot > bestDot){ bestDot = dot; best = neighbor; }
  }
  // Ignore water that sits beside or behind the mouth; the river isn't heading there.
  if (!best || (inward && bestDot <= 0)) return null;
  return best;
}

/* Where the drawn river stops: the shared edge between the land hex and the sea. */
function riverMouthPoint(cell, inwardCell){
  const hex = cell ? hexes.get(`${cell.q},${cell.r}`) : null;
  const water = riverMouthNeighbor(cell, inwardCell);
  if (!hex || !water) return null;
  return { x: (hex.x + water.x) / 2, y: (hex.y + water.y) / 2 };
}

/* Terminals of a river that reach open water, as plain hex coordinates. */
function routeMouths(route){
  const def = ROUTE_BY_ID[route.style];
  if (!def || def.kind !== 'river') return [];
  const cells = routeCells(route);
  if (cells.length < 2) return [];

  const last = cells.length - 1;
  const found = [];
  const ends = [
    { end: 'start', from: cells[0], inward: cells[1] },
    { end: 'end',   from: cells[last], inward: cells[last - 1] }
  ];
  for (const { end, from, inward } of ends){
    const water = riverMouthNeighbor(from, inward);
    if (!water) continue;
    found.push({
      end,
      from: { q: from.q, r: from.r },
      into: { q: water.q, r: water.r }
    });
  }
  return found;
}

function routeWorldPolylines(waypoints, styleId){
  const expanded = expandWaypoints(waypoints);
  const runs = [];
  let current = null;

  for (let i = 0; i < expanded.length; i++){
    const hex = hexes.get(`${expanded[i].q},${expanded[i].r}`);
    if (!hex){
      current = null;
      continue;
    }
    if (!current){
      current = { pts: [], from: i, to: i };
      runs.push(current);
    }
    current.pts.push({ x: hex.x, y: hex.y });
    current.to = i;
  }

  const def = ROUTE_BY_ID[styleId];
  if (def && def.kind === 'river' && expanded.length >= 2 && runs.length > 0){
    const head = runs[0];
    if (head.from === 0){
      const mouth = riverMouthPoint(expanded[0], expanded[1]);
      if (mouth) head.pts.unshift(mouth);
    }
    const tail = runs[runs.length - 1];
    const last = expanded.length - 1;
    if (tail.to === last){
      const mouth = riverMouthPoint(expanded[last], expanded[last - 1]);
      if (mouth) tail.pts.push(mouth);
    }
  }

  return runs.map(run => run.pts);
}

function strokePolylines(lines, width, color, outline){
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pts of lines){
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (outline){
      ctx.lineWidth = width + HEX_SIZE * 0.07;
      ctx.strokeStyle = outline;
      ctx.stroke();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

function drawRouteStyle(waypoints, styleId, alpha){
  const def = ROUTE_BY_ID[styleId];
  if (!def) return;
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  strokePolylines(routeWorldPolylines(waypoints, styleId), def.width, def.color, def.outline);
  ctx.restore();
}

function isRouteBusy(id){
  return (pathDraft && pathDraft.routeId === id) || (routeDrag && routeDrag.routeId === id);
}

function findRouteAtHex(hex){
  if (!hex) return null;
  const ids = routeIdsAtKey(`${hex.q},${hex.r}`);
  for (let i = routes.length - 1; i >= 0; i--){
    const r = routes[i];
    if (isRouteBusy(r.id)) continue;
    if (ids.includes(r.id)) return r;
  }
  return null;
}

function findExtendableRoute(hex){
  if (!hex) return null;
  for (let i = routes.length - 1; i >= 0; i--){
    const r = routes[i];
    if (r.style !== brush.routeStyle) continue;
    const start = r.waypoints[0];
    const end = r.waypoints[r.waypoints.length - 1];
    if (end && end.q === hex.q && end.r === hex.r) return { route: r, reverse: false };
    if (start && start.q === hex.q && start.r === hex.r) return { route: r, reverse: true };
  }
  return null;
}

function routesOnHex(hex){
  if (!hex) return [];
  const ids = routeIdsAtKey(`${hex.q},${hex.r}`);
  if (ids.length === 0) return [];
  return routes.filter(r => ids.includes(r.id));
}

function getSelectedRoute(){
  return routes.find(r => r.id === selectedRouteId) || null;
}

function waypointIndexAtHex(route, hex){
  if (!route || !hex) return -1;
  return route.waypoints.findIndex(w => w.q === hex.q && w.r === hex.r);
}

/* Which segment of a route a hex falls on, so Shift+Click can insert there. */
function segmentIndexForHex(route, hex){
  if (!route || !hex) return -1;
  for (let i = 1; i < route.waypoints.length; i++){
    const a = route.waypoints[i - 1], b = route.waypoints[i];
    const seg = hexLine(a.q, a.r, b.q, b.r);
    for (let j = 1; j < seg.length - 1; j++){
      if (seg[j].q === hex.q && seg[j].r === hex.r) return i;
    }
  }
  return -1;
}

function drawEndpointMarker(hex, color){
  if (!hex) return;
  ctx.beginPath();
  ctx.arc(hex.x, hex.y, HEX_SIZE * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = HEX_SIZE * 0.045;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
}

function drawRoutes(){
  if (!viewLayers.routes) return;
  const ordered = routes.slice().sort((a, b) => {
    const oa = ROUTE_DRAW_ORDER[a.style] ?? 0;
    const ob = ROUTE_DRAW_ORDER[b.style] ?? 0;
    if (oa !== ob) return oa - ob;
    return a.id - b.id;
  });
  const isPathTool = getToolDef().kind === 'path';
  const highlight = isPathTool
    ? (getSelectedRoute() || (hoveredHex ? findRouteAtHex(hoveredHex) : null))
    : null;

  for (const r of ordered){
    if (isRouteBusy(r.id)) continue;
    drawRouteStyle(r.waypoints, r.style, 1);
  }

  if (highlight && !isRouteBusy(highlight.id)){
    const def = ROUTE_BY_ID[highlight.style];
    ctx.save();
    ctx.globalAlpha = highlight.id === selectedRouteId ? 0.6 : 0.45;
    strokePolylines(
      routeWorldPolylines(highlight.waypoints, highlight.style),
      (def ? def.width : HEX_SIZE * 0.2) + HEX_SIZE * 0.12,
      '#ffffff',
      null
    );
    ctx.restore();
  }
}

function draftWaypointsWithHover(){
  if (!pathDraft) return [];
  const pts = cloneWaypoints(pathDraft.waypoints);
  if (hoveredHex){
    const last = pts[pts.length - 1];
    if (!last || last.q !== hoveredHex.q || last.r !== hoveredHex.r){
      pts.push({ q: hoveredHex.q, r: hoveredHex.r });
    }
  }
  return pts;
}

function drawPathPreview(waypoints, styleId, check){
  const def = ROUTE_BY_ID[styleId] || {};
  const cells = check.cells;
  if (cells.length >= 2){
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = def.color || '#8fd4ff';
    ctx.beginPath();
    for (const cell of cells){
      if (check.blocked.has(`${cell.q},${cell.r}`)) continue;
      const hex = hexes.get(`${cell.q},${cell.r}`);
      if (hex) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    }
    ctx.fill();

    if (check.blocked.size > 0){
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = PATH_INVALID_COLOR;
      ctx.beginPath();
      for (const key of check.blocked){
        const hex = hexes.get(key);
        if (hex) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = 0.95;
  strokePolylines(
    routeWorldPolylines(waypoints, styleId),
    def.width || HEX_SIZE * 0.2,
    check.ok ? def.color : PATH_INVALID_COLOR,
    check.ok ? def.outline : null
  );
  ctx.restore();
}

function drawWaypointHandles(waypoints, color, activeIndex){
  waypoints.forEach((w, i) => {
    const hex = hexes.get(`${w.q},${w.r}`);
    if (!hex) return;
    drawEndpointMarker(hex, i === activeIndex ? '#ffffff' : color);
  });
}

function drawPathOverlay(){
  if (getToolDef().kind !== 'path' || backgroundEditMode) return;

  if (routeDrag){
    const route = routes.find(r => r.id === routeDrag.routeId);
    if (route){
      const check = validatePath(routeDrag.waypoints, routeDrag.routeId);
      drawPathPreview(routeDrag.waypoints, route.style, check);
      drawWaypointHandles(routeDrag.waypoints, (ROUTE_BY_ID[route.style] || {}).color, routeDrag.index);
    }
    return;
  }

  if (brush.pathMode === 'edit'){
    const route = getSelectedRoute();
    if (route) drawWaypointHandles(route.waypoints, (ROUTE_BY_ID[route.style] || {}).color, -1);
    return;
  }

  if (brush.pathMode === 'draw' && viewLayers.routes){
    for (const r of routes){
      if (r.style !== brush.routeStyle) continue;
      if (isRouteBusy(r.id)) continue;
      const start = r.waypoints[0];
      const end = r.waypoints[r.waypoints.length - 1];
      const startHex = start ? hexes.get(`${start.q},${start.r}`) : null;
      const endHex = end ? hexes.get(`${end.q},${end.r}`) : null;
      const def = ROUTE_BY_ID[r.style];
      if (startHex) drawEndpointMarker(startHex, def.color);
      if (endHex && endHex !== startHex) drawEndpointMarker(endHex, def.color);
    }
  }

  if (!pathDraft) return;

  const previewPts = draftWaypointsWithHover();
  drawPathPreview(previewPts, pathDraft.style, validatePath(previewPts, pathDraft.routeId));
  drawWaypointHandles(pathDraft.waypoints, (ROUTE_BY_ID[pathDraft.style] || {}).color || '#fff', -1);
}

function cancelPathDraft(){
  pathDraft = null;
  routeDrag = null;
  refreshPathUi();
  refreshInteractionUI();
}

function replaceRoute(index, waypoints){
  const route = routes[index];
  routes[index] = makeRoute(route.id, route.style, waypoints, route.name);
  invalidateRouteIndex();
}

function commitPathDraft(){
  if (!pathDraft || pathDraft.waypoints.length < 2){
    cancelPathDraft();
    render();
    return;
  }
  const before = cloneRoutes();
  const style = pathDraft.style;
  const existing = pathDraft.routeId ? routes.findIndex(r => r.id === pathDraft.routeId) : -1;
  if (existing >= 0){
    replaceRoute(existing, pathDraft.waypoints);
  } else {
    routes.push(makeRoute(nextRouteId++, style, pathDraft.waypoints));
    invalidateRouteIndex();
  }
  pathDraft = null;
  pushRoutesUndo(before);
  refreshPathUi();
  refreshRouteList();
  refreshInteractionUI();
  render();
}

function deleteRouteById(id){
  const idx = routes.findIndex(r => r.id === id);
  if (idx < 0) return;
  const before = cloneRoutes();
  routes.splice(idx, 1);
  invalidateRouteIndex();
  if (selectedRouteId === id) selectedRouteId = null;
  pushRoutesUndo(before);
  refreshRouteList();
}

function renameRoute(id, nextName){
  const route = routes.find(r => r.id === id);
  const name = (nextName || '').trim();
  if (!route || !name || route.name === name) return;
  if (routeNameTaken(name, id)){
    alert(`Another road or river is already called "${name}".`);
    return;
  }
  const before = cloneRoutes();
  route.name = name;
  pushRoutesUndo(before);
  refreshRouteList();
  refreshSelectedHexPanel();
}

function moveWaypoint(routeId, index, hex){
  const idx = routes.findIndex(r => r.id === routeId);
  if (idx < 0) return false;
  const next = cloneWaypoints(routes[idx].waypoints);
  if (!next[index] || sameHex(next[index], hex)) return false;
  next[index] = { q: hex.q, r: hex.r };
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  refreshRouteList();
  return true;
}

function insertWaypoint(routeId, at, hex){
  const idx = routes.findIndex(r => r.id === routeId);
  if (idx < 0 || at < 1) return false;
  const next = cloneWaypoints(routes[idx].waypoints);
  next.splice(at, 0, { q: hex.q, r: hex.r });
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  refreshRouteList();
  return true;
}

function removeWaypoint(routeId, index){
  const idx = routes.findIndex(r => r.id === routeId);
  if (idx < 0) return false;
  if (routes[idx].waypoints.length <= 2) return false;
  const next = cloneWaypoints(routes[idx].waypoints).filter((_, i) => i !== index);
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  refreshRouteList();
  return true;
}

function selectRoute(id){
  selectedRouteId = id;
  const route = getSelectedRoute();
  if (route && route.style !== brush.routeStyle){
    brush.routeStyle = route.style;
    syncRouteSwatches();
  }
  refreshRouteList();
  refreshInteractionUI();
}

function sameHex(a, hex){
  return a && hex && a.q === hex.q && a.r === hex.r;
}

function handlePathEditDown(hex, e){
  const selected = getSelectedRoute();
  if (selected && hex){
    const wpIndex = waypointIndexAtHex(selected, hex);
    if (wpIndex >= 0){
      if (e.altKey){
        removeWaypoint(selected.id, wpIndex);
        render();
        return;
      }
      routeDrag = { routeId: selected.id, index: wpIndex, waypoints: cloneWaypoints(selected.waypoints) };
      refreshInteractionUI();
      render();
      return;
    }
    if (e.shiftKey){
      const at = segmentIndexForHex(selected, hex);
      if (at > 0){
        insertWaypoint(selected.id, at, hex);
        render();
        return;
      }
    }
  }

  const hit = findRouteAtHex(hex);
  selectRoute(hit ? hit.id : null);
  render();
}

function finishRouteDrag(){
  if (!routeDrag) return;
  const drag = routeDrag;
  routeDrag = null;
  moveWaypoint(drag.routeId, drag.index, drag.waypoints[drag.index]);
  refreshInteractionUI();
  render();
}

function handlePathClick(hex, e){
  if (!hex) return;

  if (brush.pathMode === 'erase'){
    const hit = findRouteAtHex(hex);
    if (hit){
      deleteRouteById(hit.id);
      render();
    }
    return;
  }

  if (brush.pathMode === 'edit'){
    handlePathEditDown(hex, e);
    return;
  }

  if (!pathDraft){
    // Alt forces a fresh path so you can branch off an endpoint instead of extending it.
    const extend = e.altKey ? null : findExtendableRoute(hex);
    if (extend){
      pathDraft = {
        routeId: extend.route.id,
        style: extend.route.style,
        waypoints: cloneWaypoints(extend.reverse ? extend.route.waypoints.slice().reverse() : extend.route.waypoints)
      };
    } else {
      pathDraft = {
        routeId: null,
        style: brush.routeStyle,
        waypoints: [{ q: hex.q, r: hex.r }]
      };
    }
    refreshPathUi();
    refreshInteractionUI();
    render();
    return;
  }

  const last = pathDraft.waypoints[pathDraft.waypoints.length - 1];
  if (sameHex(last, hex)) return;

  const candidate = pathDraft.waypoints.concat([{ q: hex.q, r: hex.r }]);
  if (!validatePath(candidate, pathDraft.routeId).ok) return;

  pathDraft.waypoints = candidate;
  if (e.shiftKey){
    refreshPathUi();
    refreshInteractionUI();
    render();
    return;
  }
  commitPathDraft();
}

function refreshPathUi(){
  const btn = document.getElementById('cancelPathBtn');
  if (btn) btn.disabled = !pathDraft;
}

function drawBrushPreview() {
  const tool = getToolDef();
  if (!hoveredHex || backgroundEditMode || capitalPickMode || tool.kind !== 'paint') return;
  const targets = hexRange(hoveredHex.q, hoveredHex.r, brush.size - 1);
  ctx.beginPath();
  for (const t of targets) {
    const h = hexes.get(`${t.q},${t.r}`);
    if (h && !(skipOceanForTool(tool) && isWaterHex(h))) addHexToPath(ctx, h.x, h.y, HEX_SIZE);
  }
  ctx.fillStyle = tool.previewFill || 'rgba(255, 255, 255, 0.15)';
  ctx.fill();
}

function drawHexOutline(hex, color, dash){
  ctx.beginPath();
  addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
  ctx.lineWidth = 2.5 / camera.zoom;
  ctx.strokeStyle = color;
  if (dash) {
    ctx.save();
    ctx.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.stroke();
  }
}

function render(){
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  drawBackgroundImage();
  drawHexes();
  drawOwnershipBorders();
  drawLoyaltyBorders();
  drawCultureBorders();
  drawRoutes();
  drawPathOverlay();
  drawCityLabels();
  
  drawBrushPreview();
  if (selectedHex) drawHexOutline(selectedHex, '#4fc3ff', true);
  if (hoveredHex && !backgroundEditMode) drawHexOutline(hoveredHex, '#ffffff', false);

  ctx.restore();
  updateHeatmapLegend();
  updateHud();
}

function updateHud(){
  const stats = getPopulationStats();
  const heat = viewLayers.population ? ` &nbsp; Pop max: <b>${formatPop(stats.max)}</b>` : '';
  const tool = getToolDef();
  hudStatsEl.innerHTML = `Tool: <b>${tool.label}</b> &nbsp; Zoom: <b>${Math.round(camera.zoom * 100)}%</b> &nbsp; Hex: <b>${hoveredHex ? hoveredHex.q + ', ' + hoveredHex.r : '—'}</b> &nbsp; Tiles: <b>${hexes.size}</b>${heat}`;
}

function updateInspector(hex){
  if (!hex){ inspectorHudEl.innerHTML = ''; return; }
  const terrainLabel = (TERRAIN_DEFS.find(t => t.id === hex.terrain) || {}).label || hex.terrain;
  const customEntries = Object.entries(hex.customData || {});
  const customHtml = customEntries.length
    ? `<div class="inspector-custom">${customEntries.map(([k, v]) => `<div><b>${k}</b> ${JSON.stringify(v)}</div>`).join('')}</div>`
    : '';
  const capitalOf = factionsWithCapitalAt(hex);
  const capitalHtml = capitalOf.length
    ? `<div class="inspector-row"><b>Capital of</b> ${capitalOf.join(', ')}</div>`
    : '';
  const onRoutes = routesOnHex(hex).map(r => r.name);
  const routesHtml = onRoutes.length
    ? `<div class="inspector-row"><b>Routes</b> ${onRoutes.join(', ')}</div>`
    : '';
  inspectorHudEl.innerHTML = `
    <div class="inspector-row"><b>Coord</b> ${hex.q}, ${hex.r}</div>
    <div class="inspector-row"><b>Terrain</b> ${terrainLabel}</div>
    <div class="inspector-row"><b>Elevation</b> ${ELEVATION_LABELS[hex.elevation] || hex.elevation || 'Flat'}</div>
    <div class="inspector-row"><b>Population</b> ${hex.population}</div>
    <div class="inspector-row"><b>Faction</b> ${hex.owner || '—'}</div>
    ${capitalHtml}
    <div class="inspector-row"><b>Loyalty</b> ${hex.loyalty || '—'}</div>
    <div class="inspector-row"><b>Culture</b> ${hex.culture || '—'}</div>
    <div class="inspector-row"><b>City</b> ${hex.cityName || '—'}</div>
    ${routesHtml}
    ${customHtml}
  `;
}

function resizeCanvas(){
  const rect = canvasWrap.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  render();
}
window.addEventListener('resize', resizeCanvas);

/* ----------------------------------------------------------------------------
   8. CAMERA / INPUT HANDLING
   ---------------------------------------------------------------------------- */
function getHexAtScreen(mx, my){
  const w = screenToWorld(mx, my);
  const frac = pixelToAxial(w.x, w.y, HEX_SIZE);
  const rounded = axialRound(frac.q, frac.r);
  return hexes.get(`${rounded.q},${rounded.r}`) || null;
}

function applyBrush(hex, paintCtx){
  const tool = getToolDef();
  if (!tool.apply) return;
  if (skipOceanForTool(tool) && isWaterHex(hex)) return;
  markHexForUndo(hex);
  tool.apply(hex, paintCtx);
}

function paintAtScreen(mx, my){
  const tool = getToolDef();
  if (tool.kind !== 'paint') return;
  const w = screenToWorld(mx, my);
  const frac = pixelToAxial(w.x, w.y, HEX_SIZE);
  const center = axialRound(frac.q, frac.r);
  const targets = hexRange(center.q, center.r, brush.size - 1);
  let changed = false;
  for (const t of targets){
    const hex = hexes.get(`${t.q},${t.r}`);
    if (!hex) continue;
    const dist = axialDistance(center.q, center.r, t.q, t.r);
    applyBrush(hex, { axialDistance: dist });
    changed = true;
  }
  if (changed){
    render();
    if (tool.afterStroke) tool.afterStroke();
    if (hoveredHex) updateInspector(hoveredHex);
  }
}

function applyCityLabelToHex(hex){
  const name = cityNameInputEl.value.trim();
  hex.cityName = name === '' ? null : name;
}

function getMousePos(e){
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  const pos = getMousePos(e);

  if (capitalPickMode){
    if (e.button === 0){
      finishCapitalPick(getHexAtScreen(pos.x, pos.y));
      render();
      return;
    }
  }

  if (backgroundEditMode){
    if (e.button === 0){
      isDraggingBg = true;
      lastPanX = e.clientX; lastPanY = e.clientY;
      canvas.style.cursor = 'grabbing';
    }
    return;
  }

  if (e.button === 0){
    // Select Override via Shift+Click (disabled while drawing a path)
    if (e.shiftKey && getToolDef().kind !== 'path') {
      selectedHex = getHexAtScreen(pos.x, pos.y);
      refreshSelectedHexPanel();
      render();
      return;
    }

    if (getToolDef().kind === 'path'){
      handlePathClick(getHexAtScreen(pos.x, pos.y), e);
      return;
    }

    if (isPaintTool()){
      beginAction();
      isPainting = true;
      paintAtScreen(pos.x, pos.y);
    } else {
      const tool = getToolDef();
      const hex = getHexAtScreen(pos.x, pos.y);
      if (hex && tool.apply){
        beginAction();
        applyBrush(hex);
        if (tool.afterStroke) tool.afterStroke();
        commitAction();
        render();
      }
    }
  } else if (e.button === 1 || e.button === 2){
    e.preventDefault();
    isPanning = true;
    lastPanX = e.clientX; lastPanY = e.clientY;
    canvas.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', e => {
  if (backgroundEditMode){
    if (isDraggingBg){
      const dx = e.clientX - lastPanX, dy = e.clientY - lastPanY;
      bgImage.offsetX += dx / camera.zoom;
      bgImage.offsetY += dy / camera.zoom;
      lastPanX = e.clientX; lastPanY = e.clientY;
      syncBgInputs();
      render();
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const inside = pos.x >= 0 && pos.y >= 0 && pos.x <= rect.width && pos.y <= rect.height;

  if (isPanning){
    const dx = e.clientX - lastPanX, dy = e.clientY - lastPanY;
    camera.x -= dx / camera.zoom;
    camera.y -= dy / camera.zoom;
    lastPanX = e.clientX; lastPanY = e.clientY;
  }
  if (isPainting && inside && isPaintTool()){
    paintAtScreen(pos.x, pos.y);
  }
  
  if (inside){
    const prevHover = hoveredHex;
    hoveredHex = getHexAtScreen(pos.x, pos.y);
    if (hoveredHex !== prevHover) {
      if (routeDrag && hoveredHex){
        routeDrag.waypoints[routeDrag.index] = { q: hoveredHex.q, r: hoveredHex.r };
      }
      updateInspector(hoveredHex);
      render(); // Trigger re-render to update brush preview and outlines
    }
  } else if (!isPanning && hoveredHex){
    hoveredHex = null;
    render();
  }
  
  if (isPanning) render();
});

window.addEventListener('mouseup', () => {
  if (isPainting) {
    isPainting = false;
    commitAction();
  }
  if (routeDrag) finishRouteDrag();
  isDraggingBg = false;
  if (isPanning) isPanning = false;
  refreshInteractionUI();
});

canvas.addEventListener('mouseleave', () => {
  if (isPainting) {
    isPainting = false;
    commitAction();
  }
  if (!isPanning && !backgroundEditMode){ hoveredHex = null; render(); }
});

function applyZoom(factor, mx, my) {
  const before = screenToWorld(mx, my);
  camera.zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  camera.x = before.x - (mx - canvas.width / 2) / camera.zoom;
  camera.y = before.y - (my - canvas.height / 2) / camera.zoom;
  render();
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const pos = getMousePos(e);

  if (backgroundEditMode){
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    bgImage.scale = clamp(bgImage.scale * factor, 0.01, 50);
    syncBgInputs();
    render();
    return;
  }
  applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, pos.x, pos.y);
}, { passive: false });

window.addEventListener('keydown', e => {
  // The capital picker owns the canvas until it resolves, so swallow the rest.
  if (capitalPickMode){
    if (e.key === 'Escape'){
      e.preventDefault();
      setCapitalPickMode(false);
      render();
    }
    return;
  }
  if (e.key === 'Escape' && closeOpenModal()){
    e.preventDefault();
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  const isFormField = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (isFormField) return;

  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z'){
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (e.shiftKey && key === 'z'))){
    e.preventDefault();
    redo();
  } else if (key === 'escape'){
    if (pathDraft || routeDrag){
      e.preventDefault();
      cancelPathDraft();
      render();
    } else if (selectedRouteId !== null){
      e.preventDefault();
      selectRoute(null);
      render();
    }
  } else if ((key === 'delete' || key === 'backspace') && getToolDef().kind === 'path' && !pathDraft && !routeDrag){
    const selected = getSelectedRoute();
    const wpIndex = waypointIndexAtHex(selected, hoveredHex);
    if (selected && wpIndex >= 0){
      e.preventDefault();
      removeWaypoint(selected.id, wpIndex);
      render();
      return;
    }
    const hit = findRouteAtHex(hoveredHex);
    if (hit){
      e.preventDefault();
      deleteRouteById(hit.id);
      render();
    }
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey){
    const byShortcut = TOOL_DEFS.find(t => t.shortcut && t.shortcut.toLowerCase() === key);
    if (byShortcut){
      e.preventDefault();
      setActiveTool(byShortcut.id);
    }
  }
});

// UI Zoom Buttons
document.getElementById('zoomInBtn').addEventListener('click', () => applyZoom(1.12, canvas.width/2, canvas.height/2));
document.getElementById('zoomOutBtn').addEventListener('click', () => applyZoom(1 / 1.12, canvas.width/2, canvas.height/2));

/* ----------------------------------------------------------------------------
   9. UI WIRING
   ---------------------------------------------------------------------------- */
function updateCursor(){
  if (backgroundEditMode){ canvas.style.cursor = 'move'; return; }
  canvas.style.cursor = 'crosshair';
}

function updateControlsHint(){
  const el = document.getElementById('controlsHint');
  if (capitalPickMode){
    el.innerHTML = `<div><b>Left</b> click — set this hex as the capital</div><div><b>Esc</b> — keep the current capital</div><div><b>Right/Middle</b> drag — pan</div>`;
    return;
  }
  if (backgroundEditMode){
    el.innerHTML = `<div><b>Left</b> drag — move image</div><div><b>Scroll</b> — resize image</div>`;
    return;
  }
  const tool = getToolDef();
  let toolHint = tool.hint || '';
  if (tool.kind === 'path'){
    if (brush.pathMode === 'erase'){
      toolHint = '<div><b>Click</b> — erase path under cursor</div><div><b>Delete</b> — erase hovered path</div>';
    } else if (brush.pathMode === 'edit'){
      toolHint = routeDrag
        ? '<div><b>Release</b> — drop handle on this hex</div><div><b>Red</b> — overlaps another path</div>'
        : (getSelectedRoute()
          ? '<div><b>Drag</b> handle — move waypoint</div><div><b>Shift+Click</b> — insert waypoint</div><div><b>Alt+Click</b> handle — remove waypoint</div><div><b>Esc</b> — deselect</div>'
          : '<div><b>Click</b> a path — select it for editing</div>');
    } else if (pathDraft){
      toolHint = '<div><b>Click</b> — finish path at this hex</div><div><b>Shift+Click</b> — add waypoint</div><div><b>Esc</b> — cancel</div>';
    } else {
      toolHint = '<div><b>Click</b> — start path</div><div><b>Click an end</b> — extend that path</div><div><b>Alt+Click</b> — branch off instead</div>';
    }
  }
  const selectHint = tool.kind === 'path'
    ? ''
    : `<div><b>Shift+Click</b> — select hex for data</div>`;
  el.innerHTML = `${toolHint}${selectHint}<div><b>Right/Middle</b> drag — pan</div><div><b>Scroll</b> — zoom</div>`;
}

function refreshInteractionUI(){
  updateCursor();
  updateControlsHint();
}

function setActiveTool(id){
  if (!TOOL_BY_ID[id]) return;
  if (activeTool !== id) cancelPathDraft();
  activeTool = id;
  isPainting = false;
  const radio = document.querySelector(`input[name=tool][value="${id}"]`);
  if (radio) radio.checked = true;
  updateToolVisibility();
  refreshInteractionUI();
  render();
}

function updateToolVisibility(){
  const tool = getToolDef();
  document.querySelectorAll('[data-tool]').forEach(el => {
    const ids = el.dataset.tool.split(/[\s,]+/).filter(Boolean);
    el.style.display = ids.includes(tool.id) ? '' : 'none';
  });
  document.querySelectorAll('[data-tool-kind]').forEach(el => {
    el.style.display = (el.dataset.toolKind === tool.kind) ? '' : 'none';
  });
}

const terrainSwatchesEl = document.getElementById('terrainSwatches');

function rebuildTerrainColors(){
  for (const key of Object.keys(TERRAIN_COLORS)) delete TERRAIN_COLORS[key];
  TERRAIN_DEFS.forEach(t => TERRAIN_COLORS[t.id] = t.color);
}

function rebuildTerrainSwatches(){
  terrainSwatchesEl.innerHTML = '';
  if (!TERRAIN_DEFS.some(t => t.id === brush.terrain)){
    brush.terrain = TERRAIN_DEFS[0] ? TERRAIN_DEFS[0].id : 'ocean';
  }
  TERRAIN_DEFS.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch-btn' + (t.id === brush.terrain ? ' active' : '');
    btn.innerHTML = `<span class="swatch-color" style="background:${t.color}"></span><span>${t.label}</span>`;
    btn.addEventListener('click', () => {
      brush.terrain = t.id;
      terrainSwatchesEl.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    terrainSwatchesEl.appendChild(btn);
  });
}
rebuildTerrainSwatches();

const routeSwatchesEl = document.getElementById('routeSwatches');
ROUTE_DEFS.forEach(def => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.routeStyle = def.id;
  btn.className = 'swatch-btn' + (def.id === brush.routeStyle ? ' active' : '');
  btn.innerHTML = `<span class="swatch-color" style="background:${def.color}"></span><span>${def.label}</span>`;
  btn.addEventListener('click', () => {
    brush.routeStyle = def.id;
    syncRouteSwatches();
    // Only restyle a draft that is creating a new path, never one extending an existing one.
    if (pathDraft && !pathDraft.routeId) pathDraft.style = def.id;
    render();
  });
  routeSwatchesEl.appendChild(btn);
});

function syncRouteSwatches(){
  routeSwatchesEl.querySelectorAll('.swatch-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.routeStyle === brush.routeStyle);
  });
}

function setPathMode(mode){
  brush.pathMode = mode;
  const radio = document.querySelector(`input[name=pathMode][value="${mode}"]`);
  if (radio) radio.checked = true;
  cancelPathDraft();
}

document.querySelectorAll('input[name=pathMode]').forEach(r => {
  r.addEventListener('change', e => {
    brush.pathMode = e.target.value;
    cancelPathDraft();
    if (brush.pathMode !== 'edit') selectRoute(null);
    refreshInteractionUI();
    render();
  });
});

document.getElementById('cancelPathBtn').addEventListener('click', () => {
  cancelPathDraft();
  render();
});

document.getElementById('layerTerrain').addEventListener('change', e => { viewLayers.terrain = e.target.checked; render(); });
document.getElementById('layerElevation').addEventListener('change', e => { viewLayers.elevation = e.target.checked; render(); });
document.getElementById('layerOwnership').addEventListener('change', e => { viewLayers.ownership = e.target.checked; render(); });
document.getElementById('layerLoyalty').addEventListener('change', e => { viewLayers.loyalty = e.target.checked; render(); });
document.getElementById('layerCulture').addEventListener('change', e => { viewLayers.culture = e.target.checked; render(); });
document.getElementById('layerRoutes').addEventListener('change', e => { viewLayers.routes = e.target.checked; render(); });
document.getElementById('layerPopulation').addEventListener('change', e => { viewLayers.population = e.target.checked; render(); });
document.getElementById('showFullGrid').addEventListener('change', e => { showFullGrid = e.target.checked; render(); });
document.querySelectorAll('input[name=heatmapScale]').forEach(r => {
  r.addEventListener('change', e => { heatmapScale = e.target.value; render(); });
});

document.getElementById('tileOpacitySlider').addEventListener('input', e => {
  tileOpacity = e.target.value / 100; render();
});

document.querySelectorAll('.float-tab-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.closest('.float-tab');
    const minimized = tab.classList.toggle('minimized');
    btn.setAttribute('aria-expanded', minimized ? 'false' : 'true');
  });
});

const toolRadiosEl = document.getElementById('toolRadios');
TOOL_DEFS.forEach(tool => {
  const lab = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'tool';
  radio.value = tool.id;
  if (tool.id === activeTool) radio.checked = true;
  const shortcut = tool.shortcut ? ` (${tool.shortcut})` : '';
  lab.appendChild(radio);
  lab.appendChild(document.createTextNode(` ${tool.label}${shortcut}`));
  toolRadiosEl.appendChild(lab);
});

toolRadiosEl.addEventListener('change', e => {
  if (e.target.name !== 'tool') return;
  setActiveTool(e.target.value);
});

document.querySelectorAll('input[name=elevationMode]').forEach(r => {
  r.addEventListener('change', e => { brush.elevation = e.target.value; });
});

document.querySelectorAll('input[name=populationMode]').forEach(r => {
  r.addEventListener('change', e => { brush.populationMode = e.target.value; });
});
const populationAmountSliderEl = document.getElementById('populationAmountSlider');
const populationAmountLabelEl = document.getElementById('populationAmountLabel');

function setPopulationAmount(value, fromSlider = false){
  const amount = clamp(Math.round(Number(value)) || 0, 0, 10000000);
  brush.populationAmount = amount;
  if (populationAmountSliderEl && !fromSlider) populationAmountSliderEl.value = String(amount);
  if (populationAmountLabelEl) populationAmountLabelEl.textContent = formatPop(amount);
}

document.querySelectorAll('[data-tool="population"] .swatch-grid .btn[data-pop]').forEach(btn => {
  btn.addEventListener('click', () => setPopulationAmount(btn.dataset.pop));
});
populationAmountSliderEl.addEventListener('input', e => {
  setPopulationAmount(e.target.value, true);
});

function populationNudgeStep(amount){
  if (amount < 1000) return 100;
  if (amount < 50000) return 1000;
  return 10000;
}

document.getElementById('popSubBtn').addEventListener('click', () => {
  const step = populationNudgeStep(brush.populationAmount);
  setPopulationAmount(brush.populationAmount - step);
});
document.getElementById('popAddBtn').addEventListener('click', () => {
  const step = populationNudgeStep(brush.populationAmount);
  setPopulationAmount(brush.populationAmount + step);
});

const ownerSelectEl = document.getElementById('ownerFactionSelect');
const ownerSwatchEl = document.getElementById('ownerFactionSwatch');
const loyaltySelectEl = document.getElementById('loyaltyFactionSelect');
const loyaltySwatchEl = document.getElementById('loyaltyFactionSwatch');
const editOwnerFactionBtn = document.getElementById('editOwnerFactionBtn');
const editLoyaltyFactionBtn = document.getElementById('editLoyaltyFactionBtn');

/* Both brushes may only reference existing factions; the blank option erases. */
function fillFactionSelect(selectEl, selected, blankLabel){
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = blankLabel;
  selectEl.appendChild(blank);
  for (const name of sortedFactionNames()){
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} — ${FACTION_TYPE_LABELS[factions.get(name).type]}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = factions.has(selected) ? selected : '';
}

function setBrushSwatch(el, name, gray){
  if (!el) return;
  if (!name || !factions.has(name)){
    el.style.background = 'transparent';
    el.style.borderStyle = 'dashed';
    return;
  }
  el.style.borderStyle = 'solid';
  el.style.background = gray && factionHexCount(name) === 0 ? grayLoyaltyColor(name) : factionColor(name);
}

function syncFactionBrushInputs(){
  if (!factions.has(brush.owner)) brush.owner = '';
  if (!factions.has(brush.loyalty)) brush.loyalty = '';
  fillFactionSelect(ownerSelectEl, brush.owner, '— No faction (erase) —');
  fillFactionSelect(loyaltySelectEl, brush.loyalty, '— No loyalty (erase) —');
  setBrushSwatch(ownerSwatchEl, brush.owner, false);
  setBrushSwatch(loyaltySwatchEl, brush.loyalty, true);
  editOwnerFactionBtn.disabled = !brush.owner;
  editLoyaltyFactionBtn.disabled = !brush.loyalty;
}

ownerSelectEl.addEventListener('change', () => {
  brush.owner = ownerSelectEl.value;
  syncFactionBrushInputs();
});

loyaltySelectEl.addEventListener('change', () => {
  brush.loyalty = loyaltySelectEl.value;
  syncFactionBrushInputs();
});

const cultureInputEl = document.getElementById('cultureInput');
const cultureColorInputEl = document.getElementById('cultureColorInput');

function syncCultureColorInput(){
  const name = cultureInputEl.value.trim();
  cultureColorInputEl.value = name ? peekCultureColor(name) : '#9c6eb9';
}

cultureInputEl.addEventListener('input', syncCultureColorInput);
cultureInputEl.addEventListener('change', () => { brush.culture = cultureInputEl.value.trim(); });
cultureInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') cultureInputEl.blur(); });

cultureColorInputEl.addEventListener('input', e => {
  const name = cultureInputEl.value.trim();
  if (!name) return;
  ensureCulture(name).color = e.target.value;
  refreshCultureList();
  render();
});

function factionBadge(name){
  const rec = factions.get(name);
  const el = document.createElement('span');
  el.className = 'faction-badge';
  if (rec && rec.flag){
    el.classList.add('has-flag');
    el.style.backgroundImage = `url("${rec.flag}")`;
  } else {
    el.style.background = rec ? rec.color : grayLoyaltyColor(name);
  }
  return el;
}

function refreshFactionList(){
  const listEl = document.getElementById('factionList');
  listEl.innerHTML = '';
  if (factions.size === 0){
    listEl.innerHTML = '<div class="hint">No factions yet. Create one to start painting territory.</div>';
    syncFactionBrushInputs();
    return;
  }

  const counts = getFactionCounts();
  const sorted = sortedFactionNames().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
  for (const name of sorted){
    const rec = factions.get(name);
    const count = counts.get(name) || 0;
    const row = document.createElement('div');
    row.className = 'country-row';

    row.appendChild(factionBadge(name));

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = rec.capital ? `${name} 👑` : name;
    nameEl.title = `${FACTION_TYPE_LABELS[rec.type]}${rec.ideology ? ' · ' + rec.ideology : ''} — click to paint with this faction`;
    nameEl.addEventListener('click', () => {
      brush.owner = name;
      syncFactionBrushInputs();
      setActiveTool('owner');
    });

    const countEl = document.createElement('span');
    countEl.className = 'country-count';
    countEl.textContent = count;
    countEl.title = count === 0 ? 'Landless faction' : `${count} hexes`;
    if (count === 0) countEl.classList.add('landless');

    const actionsEl = document.createElement('div');
    actionsEl.className = 'country-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon-sm';
    editBtn.innerHTML = '✎';
    editBtn.title = 'Open in the Faction Editor';
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openFactionEditor(name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete faction';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      confirmDeleteFaction(name);
    });

    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(deleteBtn);

    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(actionsEl);
    listEl.appendChild(row);
  }
  syncFactionBrushInputs();
}

function refreshLoyaltyList(){
  const counts = new Map();
  for (const hex of hexes.values()){
    if (hex.loyalty) counts.set(hex.loyalty, (counts.get(hex.loyalty) || 0) + 1);
  }
  const listEl = document.getElementById('loyaltyList');
  listEl.innerHTML = '';
  if (counts.size === 0){
    listEl.innerHTML = '<div class="hint">No loyalties painted yet.</div>';
    return;
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted){
    const landless = factionHexCount(name) === 0;
    const row = document.createElement('div');
    row.className = 'country-row';

    const swatch = document.createElement('span');
    swatch.className = 'swatch-color';
    swatch.style.background = landless ? grayLoyaltyColor(name) : factionColor(name);
    swatch.title = landless
      ? 'Landless faction — loyalty to it is shown in gray'
      : 'Hexes it also owns use its color, hexes owned by someone else are shifted';

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = name;
    nameEl.title = 'Click to set as the active loyalty brush';
    nameEl.addEventListener('click', () => {
      brush.loyalty = name;
      syncFactionBrushInputs();
      setActiveTool('loyalty');
    });

    const countEl = document.createElement('span');
    countEl.className = 'country-count';
    countEl.textContent = count;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'country-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon-sm';
    editBtn.innerHTML = '✎';
    editBtn.title = 'Open this faction in the Faction Editor';
    editBtn.disabled = !factions.has(name);
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openFactionEditor(name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Clear this loyalty';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!prefConfirmDeletes || confirm(`Clear loyalty "${name}" from all hexes? The faction itself is kept.`)) {
        clearLoyalty(name);
      }
    });

    actionsEl.appendChild(editBtn);
    actionsEl.appendChild(deleteBtn);

    row.appendChild(swatch);
    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(actionsEl);
    listEl.appendChild(row);
  }
}

function refreshCultureList(){
  const counts = new Map();
  for (const hex of hexes.values()){
    if (hex.culture) counts.set(hex.culture, (counts.get(hex.culture) || 0) + 1);
  }
  const listEl = document.getElementById('cultureList');
  listEl.innerHTML = '';
  if (counts.size === 0){
    listEl.innerHTML = '<div class="hint">No cultures painted yet.</div>';
    return;
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted){
    const row = document.createElement('div');
    row.className = 'country-row';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'color-sm';
    colorInput.value = cultureColor(name);
    colorInput.addEventListener('input', e => {
      ensureCulture(name).color = e.target.value;
      if (cultureInputEl.value.trim() === name) cultureColorInputEl.value = e.target.value;
      render();
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = name;
    nameEl.title = 'Click to set as the active culture brush';
    nameEl.addEventListener('click', () => {
      cultureInputEl.value = name;
      brush.culture = name;
      syncCultureColorInput();
      setActiveTool('culture');
    });

    const countEl = document.createElement('span');
    countEl.className = 'country-count';
    countEl.textContent = count;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'country-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-icon-sm';
    renameBtn.innerHTML = '✎';
    renameBtn.title = 'Rename Culture';
    renameBtn.addEventListener('click', e => {
      e.stopPropagation();
      const newName = prompt(`Rename culture "${name}" to:`, name);
      if (newName && newName.trim() !== '' && newName !== name) {
        renameCulture(name, newName.trim());
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete Culture';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!prefConfirmDeletes || confirm(`Delete culture "${name}"? This will unassign it from all hexes.`)) {
        deleteCulture(name);
      }
    });

    actionsEl.appendChild(renameBtn);
    actionsEl.appendChild(deleteBtn);

    row.appendChild(colorInput);
    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(actionsEl);
    listEl.appendChild(row);
  }
}

function refreshRouteList(){
  const listEl = document.getElementById('routeList');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (routes.length === 0){
    listEl.innerHTML = '<div class="hint">No roads or rivers drawn yet.</div>';
    return;
  }
  const ordered = routes.slice().sort((a, b) => {
    const oa = ROUTE_DRAW_ORDER[a.style] ?? 0;
    const ob = ROUTE_DRAW_ORDER[b.style] ?? 0;
    if (oa !== ob) return oa - ob;
    return a.id - b.id;
  });

  for (const route of ordered){
    const def = ROUTE_BY_ID[route.style] || {};
    const row = document.createElement('div');
    row.className = 'route-row' + (route.id === selectedRouteId ? ' selected' : '');

    const swatch = document.createElement('span');
    swatch.className = 'swatch-color';
    swatch.style.background = def.color || '#888';

    const nameEl = document.createElement('span');
    nameEl.className = 'route-name';
    nameEl.textContent = route.name;
    nameEl.title = `${def.label || route.style} — click to select and edit`;
    nameEl.addEventListener('click', () => {
      setPathMode('edit');
      selectRoute(route.id);
      setActiveTool('path');
      render();
    });

    const lenEl = document.createElement('span');
    lenEl.className = 'route-count';
    lenEl.textContent = routeCells(route).length;
    lenEl.title = 'Hexes covered';

    const actionsEl = document.createElement('div');
    actionsEl.className = 'route-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-icon-sm';
    renameBtn.innerHTML = '✎';
    renameBtn.title = 'Rename';
    renameBtn.addEventListener('click', e => {
      e.stopPropagation();
      const next = prompt(`Rename "${route.name}" to:`, route.name);
      if (next !== null) renameRoute(route.id, next);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!prefConfirmDeletes || confirm(`Delete "${route.name}"?`)){
        deleteRouteById(route.id);
        render();
      }
    });

    actionsEl.appendChild(renameBtn);
    actionsEl.appendChild(deleteBtn);

    row.appendChild(swatch);
    row.appendChild(nameEl);
    row.appendChild(lenEl);
    row.appendChild(actionsEl);
    listEl.appendChild(row);
  }
}

function refreshFactionUi(){
  refreshFactionList();
  refreshLoyaltyList();
  refreshSelectedHexPanel();
  render();
}

/* Writes the editor draft back into the map. Renaming carries owner and loyalty
   references across with it, so hexes never point at a faction that is gone. */
function saveFaction(originalName, draft){
  const name = draft.name;
  beginAction();

  if (originalName && originalName !== name){
    for (const hex of hexes.values()){
      if (hex.owner !== originalName && hex.loyalty !== originalName) continue;
      markHexForUndo(hex);
      if (hex.owner === originalName) hex.owner = name;
      if (hex.loyalty === originalName) hex.loyalty = name;
    }
    factions.delete(originalName);
    if (brush.owner === originalName) brush.owner = name;
    if (brush.loyalty === originalName) brush.loyalty = name;
  }

  factions.set(name, makeFaction(name, draft));
  invalidateFactionCache();
  commitAction();

  if (!originalName) brush.owner = name;
  refreshFactionUi();
}

function deleteFaction(name){
  beginAction();
  for (const hex of hexes.values()){
    if (hex.owner !== name && hex.loyalty !== name) continue;
    markHexForUndo(hex);
    if (hex.owner === name) hex.owner = null;
    if (hex.loyalty === name) hex.loyalty = null;
  }
  factions.delete(name);
  invalidateFactionCache();
  if (brush.owner === name) brush.owner = '';
  if (brush.loyalty === name) brush.loyalty = '';
  commitAction();
  refreshFactionUi();
}

function confirmDeleteFaction(name){
  const owned = factionHexCount(name);
  const territory = owned > 0 ? ` It owns ${owned} hex${owned === 1 ? '' : 'es'}, which become unowned.` : '';
  if (prefConfirmDeletes && !confirm(`Delete faction "${name}"?${territory} Loyalty to it is cleared too.`)) return false;
  deleteFaction(name);
  return true;
}

function clearLoyalty(name){
  beginAction();
  for (const hex of hexes.values()){
    if (hex.loyalty === name){
      markHexForUndo(hex);
      hex.loyalty = null;
    }
  }
  if (brush.loyalty === name) brush.loyalty = '';
  commitAction();
  refreshLoyaltyList();
  syncFactionBrushInputs();
  refreshSelectedHexPanel();
  render();
}

/* ----------------------------------------------------------------------------
   9b. FACTION EDITOR
   ---------------------------------------------------------------------------- */
const FLAG_MAX_EDGE = 256;

/* The whole form lives in this draft until Save, so Cancel and the capital
   picker round-trip cannot leave a half-edited faction behind. */
let factionDraft = null;
let factionDraftOriginalName = null;

const factionModalEl = document.getElementById('factionModal');
const factionNameInputEl = document.getElementById('factionNameInput');
const factionTypeSelectEl = document.getElementById('factionTypeSelect');
const factionIdeologyInputEl = document.getElementById('factionIdeologyInput');
const factionColorInputEl = document.getElementById('factionColorInput');
const factionDescInputEl = document.getElementById('factionDescInput');
const factionFlagFileEl = document.getElementById('factionFlagFile');
const factionFlagPreviewEl = document.getElementById('factionFlagPreview');
const factionFlagClearBtn = document.getElementById('factionFlagClearBtn');
const factionCapitalLabelEl = document.getElementById('factionCapitalLabel');
const factionCapitalPickBtn = document.getElementById('factionCapitalPickBtn');
const factionCapitalClearBtn = document.getElementById('factionCapitalClearBtn');
const factionDeleteBtn = document.getElementById('factionDeleteBtn');
const factionEditorTitleEl = document.getElementById('factionModalTitle');

FACTION_TYPES.forEach(t => {
  const opt = document.createElement('option');
  opt.value = t.id;
  opt.textContent = t.label;
  factionTypeSelectEl.appendChild(opt);
});

/* Flags are stored inline in the map JSON and in every undo snapshot, so they
   are re-encoded down to a thumbnail rather than kept at upload resolution. */
function downscaleFlag(dataUrl){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, FLAG_MAX_EDGE / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      off.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(off.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('not a readable image'));
    img.src = dataUrl;
  });
}

function syncFactionFlagPreview(){
  const flag = factionDraft && factionDraft.flag;
  factionFlagPreviewEl.classList.toggle('empty', !flag);
  factionFlagPreviewEl.style.backgroundImage = flag ? `url("${flag}")` : '';
  factionFlagClearBtn.hidden = !flag;
}

function syncFactionCapitalLabel(){
  const cap = factionDraft ? factionDraft.capital : null;
  factionCapitalLabelEl.textContent = cap ? `Capital at ${cap.q}, ${cap.r}` : 'No capital set';
  factionCapitalLabelEl.classList.toggle('is-empty', !cap);
  factionCapitalClearBtn.disabled = !cap;
}

function syncFactionEditorFields(){
  if (!factionDraft) return;
  factionNameInputEl.value = factionDraft.name;
  factionTypeSelectEl.value = factionDraft.type;
  factionIdeologyInputEl.value = factionDraft.ideology;
  factionColorInputEl.value = factionDraft.color;
  factionDescInputEl.value = factionDraft.description;
  syncFactionFlagPreview();
  syncFactionCapitalLabel();
}

function openFactionEditor(name){
  const rec = name ? factions.get(name) : null;
  factionDraftOriginalName = rec ? name : null;
  const base = rec || makeFaction(uniqueFactionName('New Faction'));
  factionDraft = {
    name: rec ? name : uniqueFactionName('New Faction'),
    color: base.color,
    type: base.type,
    ideology: base.ideology,
    description: base.description,
    flag: base.flag,
    capital: cloneCapital(base.capital)
  };
  factionEditorTitleEl.textContent = rec ? 'Faction Editor' : 'New Faction';
  factionDeleteBtn.hidden = !rec;
  syncFactionEditorFields();
  openModal('factionModal');
  factionNameInputEl.focus();
  factionNameInputEl.select();
}

function closeFactionEditor(){
  factionDraft = null;
  factionDraftOriginalName = null;
  factionFlagFileEl.value = '';
  closeModal('factionModal');
}

function setCapitalPickMode(active){
  capitalPickMode = active && !!factionDraft;
  factionModalEl.hidden = capitalPickMode || !factionDraft;
  document.getElementById('capitalPickBanner').style.display = capitalPickMode ? 'block' : 'none';
  refreshInteractionUI();
}

function finishCapitalPick(hex){
  if (factionDraft) factionDraft.capital = hex ? { q: hex.q, r: hex.r } : factionDraft.capital;
  setCapitalPickMode(false);
  syncFactionCapitalLabel();
}

function commitFactionEditor(){
  if (!factionDraft) return;
  const name = factionNameInputEl.value.trim();
  if (!name){
    alert('A faction needs a name.');
    factionNameInputEl.focus();
    return;
  }
  if (name !== factionDraftOriginalName && factions.has(name)){
    alert(`A faction called "${name}" already exists.`);
    factionNameInputEl.focus();
    return;
  }
  factionDraft.name = name;
  factionDraft.type = factionTypeSelectEl.value;
  factionDraft.ideology = factionIdeologyInputEl.value.trim();
  factionDraft.color = factionColorInputEl.value;
  factionDraft.description = factionDescInputEl.value;

  const original = factionDraftOriginalName;
  const draft = factionDraft;
  closeFactionEditor();
  saveFaction(original, draft);
}

factionNameInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter'){
    e.preventDefault();
    commitFactionEditor();
  }
});

factionColorInputEl.addEventListener('input', e => {
  if (factionDraft) factionDraft.color = e.target.value;
});

factionFlagFileEl.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file || !factionDraft) return;
  const reader = new FileReader();
  reader.onload = ev => {
    downscaleFlag(ev.target.result)
      .then(flag => {
        if (!factionDraft) return;
        factionDraft.flag = flag;
        syncFactionFlagPreview();
      })
      .catch(() => alert('That file could not be read as an image.'));
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

factionFlagClearBtn.addEventListener('click', () => {
  if (!factionDraft) return;
  factionDraft.flag = null;
  syncFactionFlagPreview();
});

factionCapitalPickBtn.addEventListener('click', () => setCapitalPickMode(true));

factionCapitalClearBtn.addEventListener('click', () => {
  if (!factionDraft) return;
  factionDraft.capital = null;
  syncFactionCapitalLabel();
});

factionDeleteBtn.addEventListener('click', () => {
  const name = factionDraftOriginalName;
  if (!name) return;
  if (confirmDeleteFaction(name)) closeFactionEditor();
});

document.getElementById('factionSaveBtn').addEventListener('click', commitFactionEditor);
document.getElementById('factionCancelBtn').addEventListener('click', closeFactionEditor);
document.getElementById('newFactionBtn').addEventListener('click', () => openFactionEditor(null));
editOwnerFactionBtn.addEventListener('click', () => {
  if (brush.owner) openFactionEditor(brush.owner);
});
editLoyaltyFactionBtn.addEventListener('click', () => {
  if (brush.loyalty) openFactionEditor(brush.loyalty);
});

function renameCulture(oldName, newName){
  beginAction();
  const oldRec = cultures.has(oldName)
    ? cloneCultureRecord(cultures.get(oldName))
    : { color: computeCultureColor(oldName) };
  const destExisted = cultures.has(newName);

  for (const hex of hexes.values()){
    if (hex.culture === oldName){
      markHexForUndo(hex);
      hex.culture = newName;
    }
  }

  const dest = ensureCulture(newName, destExisted ? undefined : oldRec.color);
  if (!destExisted) dest.color = oldRec.color;
  cultures.delete(oldName);

  if (brush.culture === oldName){
    brush.culture = newName;
    cultureInputEl.value = newName;
    syncCultureColorInput();
  }

  commitAction();
  refreshCultureList();
  refreshSelectedHexPanel();
  render();
}

function deleteCulture(name){
  beginAction();
  for (const hex of hexes.values()){
    if (hex.culture === name){
      markHexForUndo(hex);
      hex.culture = null;
    }
  }
  cultures.delete(name);
  if (brush.culture === name){
    brush.culture = '';
    cultureInputEl.value = '';
    syncCultureColorInput();
  }
  commitAction();
  refreshCultureList();
  refreshSelectedHexPanel();
  render();
}

const brushSizeSlider = document.getElementById('brushSizeSlider');
const brushSizeLabel = document.getElementById('brushSizeLabel');
brushSizeSlider.addEventListener('input', e => {
  brush.size = parseInt(e.target.value);
  brushSizeLabel.textContent = brush.size;
  render();
});

const cityNameInputEl = document.getElementById('cityNameInput');

function sanitizeCustomData(raw){
  const out = {};
  if (raw && typeof raw === 'object'){
    for (const [k, v] of Object.entries(raw)){
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

function customFieldType(val){
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'number') return 'number';
  return 'string';
}

function updateSelectedHexInfo(){
  const infoEl = document.getElementById('selectedHexInfo');
  const metaEl = document.getElementById('selectedHexMeta');
  if (!selectedHex){
    infoEl.textContent = 'Shift+Click a hex to select it.';
    metaEl.hidden = true;
    metaEl.innerHTML = '';
    return;
  }
  infoEl.innerHTML = `Editing hex <b>${selectedHex.q}, ${selectedHex.r}</b>`;
  metaEl.hidden = false;
  const terrainLabel = (TERRAIN_DEFS.find(t => t.id === selectedHex.terrain) || {}).label || selectedHex.terrain;
  const capitalOf = factionsWithCapitalAt(selectedHex);
  const capitalLine = capitalOf.length
    ? `<div><b>Capital of</b> ${capitalOf.join(', ')}</div>`
    : (selectedHex.owner ? '<div>Not a capital.</div>' : '<div>Paint a faction before setting a capital.</div>');
  const onRoutes = routesOnHex(selectedHex).map(r => r.name);
  const routesLine = onRoutes.length ? `<div><b>Routes</b> ${onRoutes.join(', ')}</div>` : '';
  metaEl.innerHTML = `
    <div><b>Terrain</b> ${terrainLabel}</div>
    <div><b>Elevation</b> ${ELEVATION_LABELS[selectedHex.elevation] || selectedHex.elevation || 'Flat'}</div>
    <div><b>Population</b> ${selectedHex.population}</div>
    <div><b>Faction</b> ${selectedHex.owner || '—'}</div>
    <div><b>Loyalty</b> ${selectedHex.loyalty || '—'}</div>
    <div><b>Culture</b> ${selectedHex.culture || '—'}</div>
    <div><b>City</b> ${selectedHex.cityName || '—'}</div>
    ${routesLine}
    ${capitalLine}
  `;
}

function setCustomField(oldKey, nextKey, value){
  if (!selectedHex || !nextKey) return;
  executeAtomicDelta([selectedHex], () => {
    if (!selectedHex.customData) selectedHex.customData = {};
    if (oldKey && oldKey !== nextKey) delete selectedHex.customData[oldKey];
    selectedHex.customData[nextKey] = value;
  });
  refreshSelectedHexPanel();
  render();
}

function renderCustomDataRows(){
  const wrap = document.getElementById('customDataRows');
  wrap.innerHTML = '';
  if (!selectedHex) return;
  const entries = Object.entries(selectedHex.customData || {});
  if (entries.length === 0){
    wrap.innerHTML = '<div class="hint">No fields yet. Add one below — they save on this hex.</div>';
    return;
  }
  entries.forEach(([key, val]) => {
    const type = customFieldType(val);
    const row = document.createElement('div');
    row.className = 'custom-data-row';

    const head = document.createElement('div');
    head.className = 'custom-data-row-head';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'custom-data-key';
    keyInput.value = key;
    keyInput.title = 'Field name';
    keyInput.addEventListener('change', () => {
      const nextKey = keyInput.value.trim();
      if (!nextKey){
        keyInput.value = key;
        return;
      }
      if (nextKey !== key && selectedHex.customData && Object.prototype.hasOwnProperty.call(selectedHex.customData, nextKey)){
        alert('A field with that name already exists.');
        keyInput.value = key;
        return;
      }
      setCustomField(key, nextKey, selectedHex.customData[key]);
    });

    const typeEl = document.createElement('span');
    typeEl.className = 'custom-data-type';
    typeEl.textContent = type;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon-sm danger';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove field';
    removeBtn.addEventListener('click', () => {
      executeAtomicDelta([selectedHex], () => delete selectedHex.customData[key]);
      refreshSelectedHexPanel();
      render();
    });

    head.appendChild(keyInput);
    head.appendChild(typeEl);
    head.appendChild(removeBtn);
    row.appendChild(head);

    if (type === 'boolean'){
      const boolRow = document.createElement('div');
      boolRow.className = 'radio-row inline custom-data-bool';
      ['true', 'false'].forEach(flag => {
        const lab = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `custom-bool-${key}`;
        radio.value = flag;
        radio.checked = String(val) === flag;
        radio.addEventListener('change', () => setCustomField(key, key, flag === 'true'));
        lab.appendChild(radio);
        lab.appendChild(document.createTextNode(flag === 'true' ? ' True' : ' False'));
        boolRow.appendChild(lab);
      });
      row.appendChild(boolRow);
    } else {
      const valueInput = document.createElement('input');
      valueInput.type = type === 'number' ? 'number' : 'text';
      valueInput.value = val;
      valueInput.addEventListener('change', () => {
        if (type === 'number'){
          const n = parseFloat(valueInput.value);
          if (isNaN(n)){
            valueInput.value = val;
            return;
          }
          setCustomField(key, key, n);
        } else {
          setCustomField(key, key, valueInput.value);
        }
      });
      row.appendChild(valueInput);
    }

    wrap.appendChild(row);
  });
}

function refreshSelectedHexPanel(){
  updateSelectedHexInfo();
  const locked = document.getElementById('customDataLocked');
  const editor = document.getElementById('customDataEditor');
  const hasHex = !!selectedHex;
  locked.hidden = hasHex;
  editor.hidden = !hasHex;
  document.getElementById('clearSelectionBtn').disabled = !hasHex;
  document.getElementById('setCapitalBtn').disabled = !hasHex || !factions.has(selectedHex.owner);
  document.getElementById('clearCapitalBtn').disabled = !hasHex || !factions.has(selectedHex.owner) || getFactionCapitalHex(selectedHex.owner) !== selectedHex;
  if (hasHex) renderCustomDataRows();
  else document.getElementById('customDataRows').innerHTML = '';
}

document.getElementById('setCapitalBtn').addEventListener('click', () => {
  if (!selectedHex || !factions.has(selectedHex.owner)) return;
  beginAction();
  setFactionCapital(selectedHex.owner, selectedHex);
  commitAction();
  refreshFactionList();
  refreshSelectedHexPanel();
  render();
  updateInspector(selectedHex);
});

document.getElementById('clearCapitalBtn').addEventListener('click', () => {
  if (!selectedHex || !factions.has(selectedHex.owner)) return;
  beginAction();
  setFactionCapital(selectedHex.owner, null);
  commitAction();
  refreshFactionList();
  refreshSelectedHexPanel();
  render();
  updateInspector(selectedHex);
});

document.querySelectorAll('input[name=customDataType]').forEach(r => {
  r.addEventListener('change', e => {
    const type = e.target.value;
    const isBool = type === 'boolean';
    document.getElementById('customDataValueTextWrap').style.display = isBool ? 'none' : 'block';
    document.getElementById('customDataValueBoolWrap').style.display = isBool ? 'block' : 'none';
    const valInput = document.getElementById('customDataValueInput');
    valInput.type = type === 'number' ? 'number' : 'text';
    valInput.placeholder = type === 'number' ? 'e.g. 2500' : 'e.g. Iron';
  });
});

document.getElementById('addCustomDataBtn').addEventListener('click', () => {
  if (!selectedHex) return;
  const key = document.getElementById('customDataKeyInput').value.trim();
  if (!key){ alert('Enter a field name.'); return; }
  if (selectedHex.customData && Object.prototype.hasOwnProperty.call(selectedHex.customData, key)){
    if (!confirm(`Replace existing field "${key}"?`)) return;
  }
  const type = document.querySelector('input[name=customDataType]:checked').value;
  let value;
  if (type === 'number'){
    value = parseFloat(document.getElementById('customDataValueInput').value);
    if (isNaN(value)){ alert('Enter a valid number.'); return; }
  } else if (type === 'boolean'){
    value = document.querySelector('input[name=customDataBoolValue]:checked').value === 'true';
  } else {
    value = document.getElementById('customDataValueInput').value;
  }

  setCustomField(key, key, value);
  document.getElementById('customDataKeyInput').value = '';
  document.getElementById('customDataValueInput').value = '';
});

document.getElementById('customDataKeyInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addCustomDataBtn').click();
});

document.getElementById('clearSelectionBtn').addEventListener('click', () => {
  selectedHex = null;
  refreshSelectedHexPanel();
  render();
});

document.getElementById('newMapBtn').addEventListener('click', () => {
  const cols = clamp(parseInt(document.getElementById('mapCols').value) || 40, 2, 300);
  const rows = clamp(parseInt(document.getElementById('mapRows').value) || 30, 2, 300);
  if (hexes.size > 0 && prefConfirmDeletes && !confirm('This replaces the current map. You can undo with Ctrl+Z afterward if needed. Continue?')) return;
  
  pushFullStateUndo();
  generateMap(cols, rows);
  selectedHex = null;
  hoveredHex = null;
  centerCamera();
  render();
  refreshFactionList();
  refreshLoyaltyList();
  refreshCultureList();
  refreshSelectedHexPanel();
});

document.getElementById('centerViewBtn').addEventListener('click', () => {
  centerCamera();
  render();
});

document.getElementById('cleanOceanBtn').addEventListener('click', () => {
  if (prefConfirmCleanOcean && !confirm('Remove loyalty, culture, and population from all ocean tiles? Faction ownership is kept.')) return;

  beginAction();
  for (const hex of hexes.values()){
    if (hex.terrain !== 'ocean') continue;
    if (!hex.population && !hex.loyalty && !hex.culture) continue;
    markHexForUndo(hex);
    hex.population = 0;
    hex.loyalty = null;
    hex.culture = null;
  }
  commitAction();

  invalidatePopulationStats();
  refreshFactionList();
  refreshLoyaltyList();
  refreshCultureList();
  refreshSelectedHexPanel();
  render();
});

document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);

document.getElementById('bgFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => { bgImage.img = img; render(); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('bgVisibleToggle').addEventListener('change', e => { bgImage.visible = e.target.checked; render(); });
document.getElementById('bgOpacitySlider').addEventListener('input', e => { bgImage.opacity = e.target.value / 100; render(); });
document.getElementById('bgScaleInput').addEventListener('input', e => { bgImage.scale = parseFloat(e.target.value) || 1; render(); });
document.getElementById('bgOffsetX').addEventListener('input', e => { bgImage.offsetX = parseFloat(e.target.value) || 0; render(); });
document.getElementById('bgOffsetY').addEventListener('input', e => { bgImage.offsetY = parseFloat(e.target.value) || 0; render(); });

function syncBgInputs(){
  document.getElementById('bgScaleInput').value = Math.round(bgImage.scale * 1000) / 1000;
  document.getElementById('bgOffsetX').value = Math.round(bgImage.offsetX);
  document.getElementById('bgOffsetY').value = Math.round(bgImage.offsetY);
}

function setBackgroundEditMode(active){
  backgroundEditMode = active;
  const btn = document.getElementById('bgEditModeToggle');
  btn.textContent = backgroundEditMode ? 'Exit Background Edit Mode' : 'Enable Background Edit Mode';
  btn.classList.toggle('btn-primary', backgroundEditMode);
  document.getElementById('bgEditBanner').style.display = backgroundEditMode ? 'block' : 'none';
  if (backgroundEditMode){ hoveredHex = null; }
  refreshInteractionUI();
  render();
}

document.getElementById('bgEditModeToggle').addEventListener('click', () => {
  if (!backgroundEditMode && !bgImage.img){
    alert('Load a background image first.');
    return;
  }
  setBackgroundEditMode(!backgroundEditMode);
});

document.getElementById('bgClearBtn').addEventListener('click', () => {
  bgImage.img = null;
  document.getElementById('bgFileInput').value = '';
  if (backgroundEditMode) setBackgroundEditMode(false);
  render();
});

/* ----------------------------------------------------------------------------
   10. EXPORT / IMPORT
   ---------------------------------------------------------------------------- */
/* Accepts both the current faction record and the old `owners` map, whose
   entries were either a bare color string or `{ color, capital }`. */
function parseFactionEntry(name, raw){
  if (typeof raw === 'string') return makeFaction(name, { color: raw });
  if (raw && typeof raw === 'object') return makeFaction(name, raw);
  return makeFaction(name);
}

function exportCultures(){
  pruneUnusedCultures();
  const out = {};
  const named = new Set();
  for (const hex of hexes.values()) if (hex.culture) named.add(hex.culture);
  for (const name of named){
    out[name] = { color: ensureCulture(name).color };
  }
  return out;
}

function exportFactions(){
  syncFactionCapitals();
  return sortedFactionNames().map(name => {
    const rec = factions.get(name);
    return {
      name,
      type: rec.type,
      ideology: rec.ideology,
      description: rec.description,
      color: rec.color,
      flag: rec.flag,
      capital: cloneCapital(rec.capital),
      hexCount: factionHexCount(name)
    };
  });
}

/* Kept alongside `factions` so consumers written against the old export keep
   reading colors and capitals without changes. */
function exportOwners(){
  const out = {};
  for (const [name, rec] of factions){
    out[name] = { color: rec.color, capital: cloneCapital(rec.capital) };
  }
  return out;
}

function exportMap(){
  const exportHexes = Array.from(hexes.values()).map(h => {
    const cloned = { ...h };
    delete cloned.x;
    delete cloned.y;
    delete cloned.isCapital;
    delete cloned.victoryPoint;
    return cloned;
  });

  const data = {
    meta: { version: 8, cols: mapCols, rows: mapRows, hexSize: HEX_SIZE, exportedAt: new Date().toISOString() },
    factions: exportFactions(),
    owners: exportOwners(),
    cultures: exportCultures(),
    routes: routes.map(r => {
      const def = ROUTE_BY_ID[r.style];
      return {
        id: r.id,
        name: r.name,
        kind: def ? def.kind : r.style,
        type: def ? def.type : 1,
        style: r.style,
        waypoints: cloneWaypoints(r.waypoints),
        hexes: expandWaypoints(r.waypoints),
        mouths: routeMouths(r)
      };
    }),
    hexes: exportHexes
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hex-map.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('exportPngBtn').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'hex-map.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

function importMap(file){
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const data = JSON.parse(e.target.result);
      if (!data.hexes || !Array.isArray(data.hexes)) throw new Error('missing "hexes" array');

      pushFullStateUndo(); 

      hexes.clear();
      factions.clear();
      invalidateFactionCache();
      cultures.clear();
      pathDraft = null;

      // Factions must exist before hexes reference them by name.
      if (Array.isArray(data.factions)){
        data.factions.forEach(raw => {
          const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
          if (name) factions.set(name, parseFactionEntry(name, raw));
        });
      } else if (data.owners){
        Object.entries(data.owners).forEach(([name, raw]) => {
          if (name) factions.set(name, parseFactionEntry(name, raw));
        });
      }

      data.hexes.forEach(h => {
        if (typeof h.q !== 'number' || typeof h.r !== 'number') return;
        const coords = axialToPixel(h.q, h.r, HEX_SIZE);
        const owner = h.owner || null;
        const loyalty = h.loyalty !== undefined ? (h.loyalty || null) : owner;
        const culture = h.culture || null;
        const legacyTerrain = LEGACY_TERRAIN_IDS[h.terrain] || h.terrain;
        const terrain = TERRAIN_COLORS[legacyTerrain] ? legacyTerrain : 'ocean';
        const elevation = (h.elevation === 'hills' || h.elevation === 'mountains') ? h.elevation : 'flat';
        hexes.set(`${h.q},${h.r}`, {
          q: h.q,
          r: h.r,
          x: coords.x,
          y: coords.y,
          terrain,
          elevation,
          population: Number(h.population) || 0,
          owner,
          loyalty,
          culture,
          cityName: h.cityName || null,
          customData: sanitizeCustomData(h.customData)
        });
        // Older maps stored free-text owners and loyalties, so back-fill any
        // name the faction list does not cover yet.
        if (owner) ensureFaction(owner);
        if (loyalty) ensureFaction(loyalty, { type: 'nonstate' });
        if (culture) ensureCulture(culture);
      });

      if (data.cultures){
        Object.entries(data.cultures).forEach(([name, raw]) => {
          const color = raw && typeof raw === 'object' && typeof raw.color === 'string'
            ? raw.color
            : (typeof raw === 'string' ? raw : computeCultureColor(name));
          ensureCulture(name, color).color = color;
        });
      }
      invalidateFactionCache();
      syncFactionCapitals();
      pruneUnusedCultures();
      restoreRoutes(Array.isArray(data.routes) ? data.routes : []);
      refreshPathUi();
      refreshRouteList();
      invalidatePopulationStats();

      if (data.meta){
        mapCols = data.meta.cols || mapCols;
        mapRows = data.meta.rows || mapRows;
        document.getElementById('mapCols').value = mapCols;
        document.getElementById('mapRows').value = mapRows;
      }

      selectedHex = null;
      hoveredHex = null;
      centerCamera();
      render();
      refreshFactionList();
      refreshLoyaltyList();
      refreshCultureList();
      refreshSelectedHexPanel();
    } catch (err){
      alert('Failed to import map: ' + err.message);
    }
  };
  reader.readAsText(file);
}

document.getElementById('exportBtn').addEventListener('click', exportMap);
document.getElementById('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  importMap(file);
  e.target.value = '';
});

/* ----------------------------------------------------------------------------
   11. INIT, CONFIG & MODALS
   ---------------------------------------------------------------------------- */
function applyTerrainDefs(defs){
  if (!Array.isArray(defs) || !defs.length) return;
  TERRAIN_DEFS = defs.map(t => {
    const id = LEGACY_TERRAIN_IDS[String(t.id)] || String(t.id);
    const fallback = DEFAULT_TERRAIN_DEFS.find(d => d.id === id);
    return {
      id,
      label: t.label && !LEGACY_TERRAIN_IDS[String(t.id)] ? t.label : (fallback ? fallback.label : String(t.id)),
      color: t.color || (fallback ? fallback.color : '#888888')
    };
  });
  // Surface terrains added after a settings blob was saved.
  DEFAULT_TERRAIN_DEFS.forEach(def => {
    if (!TERRAIN_DEFS.some(t => t.id === def.id)) TERRAIN_DEFS.push({ ...def });
  });
  rebuildTerrainColors();
  rebuildTerrainSwatches();
}

function parseConfigOpacity(value){
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

function applyAppConfig(cfg){
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.mapCols != null){
    mapCols = clamp(parseInt(cfg.mapCols, 10) || DEFAULT_MAP_COLS, 2, 300);
    document.getElementById('mapCols').value = mapCols;
  }
  if (cfg.mapRows != null){
    mapRows = clamp(parseInt(cfg.mapRows, 10) || DEFAULT_MAP_ROWS, 2, 300);
    document.getElementById('mapRows').value = mapRows;
  }
  const opacity = parseConfigOpacity(cfg.tileOpacity);
  if (opacity != null){
    tileOpacity = opacity;
    document.getElementById('tileOpacitySlider').value = Math.round(tileOpacity * 100);
  }
  const defs = cfg.TERRAIN_DEFS || cfg.terrainDefs;
  if (defs) applyTerrainDefs(defs);
}

function builtInDefaultSettings(){
  return {
    mapCols: DEFAULT_MAP_COLS,
    mapRows: DEFAULT_MAP_ROWS,
    tileOpacity: DEFAULT_TILE_OPACITY,
    TERRAIN_DEFS: DEFAULT_TERRAIN_DEFS.map(t => ({ id: t.id, label: t.label, color: t.color })),
    autosaveMs: DEFAULT_AUTOSAVE_MS,
    maxUndo: DEFAULT_MAX_UNDO,
    prefConfirmDeletes: true,
    prefConfirmCleanOcean: true,
    prefWarnUnload: true,
    prefPromptRestore: true,
    prefAllowOceanElevPop: true
  };
}

function buildAppSettings(){
  return {
    mapCols,
    mapRows,
    tileOpacity,
    TERRAIN_DEFS: TERRAIN_DEFS.map(t => ({ id: t.id, label: t.label, color: t.color })),
    autosaveMs: autosaveIntervalMs,
    maxUndo: MAX_UNDO,
    prefConfirmDeletes,
    prefConfirmCleanOcean,
    prefWarnUnload,
    prefPromptRestore,
    prefAllowOceanElevPop
  };
}

function applyLoadedSettings(cfg){
  if (!cfg || typeof cfg !== 'object') return;
  applyPrefsFromObject(cfg);
  applyAppConfig(cfg);
}

function persistSettings(cfg){
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg));
    return true;
  } catch (_) {
    return false;
  }
}

function readStoredSettings(){
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw){
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) { /* ignore corrupt store */ }

  let merged = null;
  for (const key of ['cartographer_prefs', 'cartographer_config']){
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object'){
        merged = merged ? { ...merged, ...parsed } : parsed;
      }
    } catch (_) { /* ignore corrupt store */ }
  }
  return merged;
}

function refreshSettingsStatus(extra){
  const el = document.getElementById('settingsConfigStatus');
  if (!el) return;
  el.textContent = extra || 'Settings are saved in this browser.';
}

function loadSettings(){
  const stored = readStoredSettings();
  applyLoadedSettings(stored || builtInDefaultSettings());
  refreshSettingsStatus(stored
    ? 'Settings are saved in this browser.'
    : 'Using built-in defaults until you click Apply.');
}

function openModal(id){
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

function closeModal(id){
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function closeOpenModal(){
  let closed = false;
  document.querySelectorAll('.modal-overlay').forEach(el => {
    if (el.hidden) return;
    if (el.id === 'factionModal') closeFactionEditor();
    else el.hidden = true;
    closed = true;
  });
  return closed;
}

function populateAboutModal(){
  const toolShortcuts = TOOL_DEFS
    .filter(t => t.shortcut)
    .map(t => `<li><b>${t.shortcut}</b> — ${t.label}</li>`)
    .join('');
  document.getElementById('aboutBody').innerHTML = `
    <p class="about-version">Version <b>${APP_VERSION}</b></p>
    <div class="about-block">
      <h3>Keyboard shortcuts</h3>
      <ul>
        <li><b>Ctrl+Z</b> — Undo</li>
        <li><b>Ctrl+Y</b> / <b>Ctrl+Shift+Z</b> — Redo</li>
        ${toolShortcuts}
        <li><b>Esc</b> — Cancel path, deselect, or close a dialog</li>
        <li><b>Right / Middle drag</b> — Pan</li>
        <li><b>Scroll</b> — Zoom</li>
        <li><b>Shift+Click</b> — Select a hex</li>
      </ul>
    </div>
    <div class="about-block">
      <h3>Credits</h3>
      <ul>
        <li>Magnesian - Creator</li>
        <li>Icons by Lucide</li>
      </ul>
    </div>
  `;
}

function syncSettingsFields(){
  document.getElementById('settingsMapCols').value = document.getElementById('mapCols').value;
  document.getElementById('settingsMapRows').value = document.getElementById('mapRows').value;
  document.getElementById('settingsPrefConfirmDeletes').checked = prefConfirmDeletes;
  document.getElementById('settingsPrefConfirmCleanOcean').checked = prefConfirmCleanOcean;
  document.getElementById('settingsPrefWarnUnload').checked = prefWarnUnload;
  document.getElementById('settingsPrefPromptRestore').checked = prefPromptRestore;
  document.getElementById('settingsPrefOceanElevPop').checked = prefAllowOceanElevPop;
  document.getElementById('settingsAutosave').value = String(autosaveIntervalMs || 0);
  document.getElementById('settingsMaxUndo').value = MAX_UNDO;
  refreshSettingsStatus();
}

function fillSettingsFieldsFromSettings(cfg){
  document.getElementById('settingsMapCols').value = cfg.mapCols;
  document.getElementById('settingsMapRows').value = cfg.mapRows;
  document.getElementById('settingsPrefConfirmDeletes').checked = prefBool(cfg.prefConfirmDeletes, true);
  document.getElementById('settingsPrefConfirmCleanOcean').checked = prefBool(cfg.prefConfirmCleanOcean, true);
  document.getElementById('settingsPrefWarnUnload').checked = prefBool(cfg.prefWarnUnload, true);
  document.getElementById('settingsPrefPromptRestore').checked = prefBool(cfg.prefPromptRestore, true);
  document.getElementById('settingsPrefOceanElevPop').checked = prefBool(cfg.prefAllowOceanElevPop, true);
  const autosaveEl = document.getElementById('settingsAutosave');
  const autosaveValue = String(Number(cfg.autosaveMs) || 0);
  autosaveEl.value = [...autosaveEl.options].some(o => o.value === autosaveValue) ? autosaveValue : '0';
  document.getElementById('settingsMaxUndo').value = Math.max(1, parseInt(cfg.maxUndo, 10) || DEFAULT_MAX_UNDO);
}

function applySettingsFromModal(){
  const cols = clamp(parseInt(document.getElementById('settingsMapCols').value, 10) || DEFAULT_MAP_COLS, 2, 300);
  const rows = clamp(parseInt(document.getElementById('settingsMapRows').value, 10) || DEFAULT_MAP_ROWS, 2, 300);
  document.getElementById('mapCols').value = cols;
  document.getElementById('mapRows').value = rows;
  mapCols = cols;
  mapRows = rows;

  MAX_UNDO = Math.max(1, parseInt(document.getElementById('settingsMaxUndo').value, 10) || DEFAULT_MAX_UNDO);
  while (undoStack.length > MAX_UNDO) undoStack.shift();
  const autosaveMs = parseInt(document.getElementById('settingsAutosave').value, 10) || 0;
  prefConfirmDeletes = document.getElementById('settingsPrefConfirmDeletes').checked;
  prefConfirmCleanOcean = document.getElementById('settingsPrefConfirmCleanOcean').checked;
  prefWarnUnload = document.getElementById('settingsPrefWarnUnload').checked;
  prefPromptRestore = document.getElementById('settingsPrefPromptRestore').checked;
  prefAllowOceanElevPop = document.getElementById('settingsPrefOceanElevPop').checked;
  setAutosaveInterval(autosaveMs);

  const saved = persistSettings(buildAppSettings());
  refreshSettingsStatus(saved
    ? 'Settings saved in this browser.'
    : 'Could not save settings in this browser (storage may be blocked).');

  render();
}

function revertSettingsToDefaults(){
  const cfg = builtInDefaultSettings();
  applyLoadedSettings(cfg);
  fillSettingsFieldsFromSettings(buildAppSettings());
  const saved = persistSettings(buildAppSettings());
  refreshSettingsStatus(saved
    ? 'Reverted to defaults and saved in this browser.'
    : 'Restored defaults in this session, but could not save them in this browser.');
  render();
}

document.getElementById('settingsBtn').addEventListener('click', () => {
  syncSettingsFields();
  openModal('settingsModal');
});
document.getElementById('aboutBtn').addEventListener('click', () => {
  populateAboutModal();
  openModal('aboutModal');
});
document.getElementById('settingsCloseBtn').addEventListener('click', () => closeModal('settingsModal'));
document.getElementById('settingsApplyBtn').addEventListener('click', () => {
  applySettingsFromModal();
  closeModal('settingsModal');
});
document.getElementById('settingsRevertBtn').addEventListener('click', () => {
  revertSettingsToDefaults();
});
document.getElementById('aboutCloseBtn').addEventListener('click', () => closeModal('aboutModal'));
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target !== overlay) return;
    if (overlay.id === 'factionModal') closeFactionEditor();
    else overlay.hidden = true;
  });
});

function init(){
  resizeCanvas();
  loadSettings();
  generateMap(mapCols, mapRows);

  const autosaveRaw = localStorage.getItem(AUTOSAVE_KEY);
  if (autosaveRaw) {
    const restore = prefPromptRestore ? confirm('Restore your previous session?') : true;
    if (restore) {
      try {
        applyFullState(JSON.parse(autosaveRaw));
      } catch (_) {
        alert('Failed to restore the previous session.');
      }
    }
  }

  centerCamera();
  syncFactionBrushInputs();
  syncCultureColorInput();
  refreshFactionList();
  refreshLoyaltyList();
  refreshCultureList();
  refreshRouteList();
  updateToolVisibility();
  refreshInteractionUI();
  updateHistoryButtons();
  refreshSelectedHexPanel();
  render();
  lucide.createIcons();
}
init();
