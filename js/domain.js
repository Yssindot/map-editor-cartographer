import { state, hooks } from './state.js';
import {
  HEX_SIZE, MIN_ZOOM, MAX_ZOOM, DEFAULT_MAX_UNDO, LEGACY_TERRAIN_IDS,
  ROUTE_DEFS, ROUTE_BY_ID, FACTION_TYPE_LABELS, FACTION_CODE_LEN,
  HEATMAP_STOPS, AUTOSAVE_KEY
} from './constants.js';
import {
  axialToPixel, pixelToAxial, axialRound, offsetToAxial, hexRange,
  NEIGHBOR_DIRS, clamp, axialDistance, hexLine, expandWaypoints
} from './hexMath.js';
import {
  computeOwnerColor, computeCultureColor, grayLoyaltyColor, shiftHexHue
} from './color.js';
import { canvas, screenToWorld } from './canvas.js';

export function loyaltyFillColor(hex){
  const name = hex.loyalty;
  if (!name) return null;
  const rec = state.factions.get(name);
  // A landless faction has no territory to take a color from, so it stays gray.
  if (!rec || factionHexCount(name) === 0) return grayLoyaltyColor(name);
  if (hex.owner === name) return rec.color;
  return shiftHexHue(rec.color, 48, 0.82, 0.78);
}

export function controllerFillColor(hex){
  const name = hex.controller;
  if (!name || hex.owner === name) return null;
  const rec = state.factions.get(name);
  if (!rec || factionHexCount(name) === 0) return grayLoyaltyColor(name);
  if (hex.owner === name) return rec.color;
  return shiftHexHue(rec.color, -32, 1.05, 0.72);
}

export function normalizeFactionType(type){
  if (FACTION_TYPE_LABELS[type]) return type;
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'state';
  if (t === 'state') return 'state';
  if (
    t === 'nonstate' || t === 'non-state' || t === 'non-state actor' || t === 'nonstate actor' ||
    t === 'corporate entity' || t === 'rebel / insurgent' || t === 'religious order' || t === 'other'
  ) return 'nonstate';
  if (t.includes('non') || t.includes('rebel') || t.includes('corp') || t.includes('relig')) return 'nonstate';
  return 'state';
}


export function normalizeFactionCode(raw){
  if (typeof raw !== 'string') return '';
  let code = raw.trim().toUpperCase();
  if (code.startsWith('F-')) code = code.slice(2);
  return code.replace(/[^A-Z0-9]/g, '').slice(0, FACTION_CODE_LEN);
}

export function formatFactionCode(code){
  return code ? `F-${code}` : '';
}

export function isFactionCodeFree(code, exceptName){
  for (const [name, rec] of state.factions){
    if (name !== exceptName && rec.code === code) return false;
  }
  return true;
}

/* Squeezes a name down to four characters, then walks a numeric tail until the
   code is unused, so every faction can get one without the user inventing it. */
export function suggestFactionCode(name, exceptName){
  let stem = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, FACTION_CODE_LEN);
  while (stem.length < FACTION_CODE_LEN) stem += '0';
  if (isFactionCodeFree(stem, exceptName)) return stem;
  for (let n = 1; n < 10000; n++){
    const tail = String(n);
    const candidate = stem.slice(0, FACTION_CODE_LEN - tail.length) + tail;
    if (isFactionCodeFree(candidate, exceptName)) return candidate;
  }
  return stem;
}

/* Maps made before codes existed, or files that arrive with clashing ones, get
   filled in here rather than at record level so undo snapshots stay stable. */
export function ensureFactionCodes(){
  for (const [name, rec] of state.factions){
    if (rec.code.length !== FACTION_CODE_LEN || !isFactionCodeFree(rec.code, name)){
      rec.code = suggestFactionCode(name, name);
    }
  }
}

export function cloneCapital(cap){
  if (!cap || typeof cap !== 'object') return null;
  const q = Number(cap.q);
  const r = Number(cap.r);
  return Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
}

export function cloneFaction(rec){
  return {
    color: rec.color,
    code: rec.code,
    type: rec.type,
    ideology: rec.ideology,
    description: rec.description,
    flag: rec.flag,
    capital: cloneCapital(rec.capital)
  };
}

export function makeFaction(name, raw = {}){
  return {
    color: typeof raw.color === 'string' && raw.color ? raw.color : computeOwnerColor(name),
    code: normalizeFactionCode(raw.code),
    type: normalizeFactionType(raw.type),
    ideology: typeof raw.ideology === 'string' ? raw.ideology : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    flag: typeof raw.flag === 'string' && raw.flag ? raw.flag : null,
    capital: cloneCapital(raw.capital)
  };
}

export function snapshotFactions(){
  return Array.from(state.factions.entries()).map(([name, rec]) => [name, cloneFaction(rec)]);
}

/* Goes through makeFaction rather than cloneFaction so an autosave written by
   an older build, which only stored color and capital, still normalizes. */
export function restoreFactions(snap){
  state.factions.clear();
  if (snap){
    for (const [name, rec] of snap) state.factions.set(name, makeFaction(name, rec));
  }
  invalidateFactionCache();
}

export function ensureFaction(name, raw){
  if (!name) return null;
  if (!state.factions.has(name)){
    state.factions.set(name, makeFaction(name, raw));
    invalidateFactionCache();
  } else if (raw && typeof raw.color === 'string' && raw.color){
    state.factions.get(name).color = raw.color;
  }
  return state.factions.get(name);
}

export function factionColor(name){
  const rec = state.factions.get(name);
  return rec ? rec.color : computeOwnerColor(name);
}

export function sortedFactionNames(){
  return Array.from(state.factions.keys()).sort((a, b) => a.localeCompare(b));
}

/* Owned-hex tallies drive the landless gray rule and the sidebar counts, and
   the capital index is read once per hex while labels are drawn. Both are
   rebuilt lazily like the population stats. */
export function invalidateFactionCache(){
  state.factionCounts = null;
  state.capitalIndex = null;
}

export function getFactionCounts(){
  if (state.factionCounts) return state.factionCounts;
  state.factionCounts = new Map();
  for (const hex of state.hexes.values()){
    if (hex.owner) state.factionCounts.set(hex.owner, (state.factionCounts.get(hex.owner) || 0) + 1);
  }
  return state.factionCounts;
}

export function getCapitalIndex(){
  if (state.capitalIndex) return state.capitalIndex;
  state.capitalIndex = new Map();
  for (const [name, rec] of state.factions){
    if (!rec.capital) continue;
    const key = `${rec.capital.q},${rec.capital.r}`;
    const at = state.capitalIndex.get(key);
    if (at) at.push(name);
    else state.capitalIndex.set(key, [name]);
  }
  return state.capitalIndex;
}

export function factionHexCount(name){
  return getFactionCounts().get(name) || 0;
}

export function uniqueFactionName(base){
  const stem = (base || 'New Faction').trim() || 'New Faction';
  if (!state.factions.has(stem)) return stem;
  let n = 2;
  while (state.factions.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export function findFactionNameByCode(code){
  if (!code) return null;
  for (const [name, rec] of state.factions){
    if (rec.code === code) return name;
  }
  return null;
}

/* Rewrites owner/loyalty hexes when a passport import renames a faction. Caller
   must already be inside beginAction/commitAction. */
export function retargetFactionName(oldName, newName){
  if (!oldName || !newName || oldName === newName) return;
  for (const hex of state.hexes.values()){
    if (hex.owner !== oldName && hex.loyalty !== oldName && hex.controller !== oldName) continue;
    markHexForUndo(hex);
    if (hex.owner === oldName) hex.owner = newName;
    if (hex.loyalty === oldName) hex.loyalty = newName;
    if (hex.controller === oldName) hex.controller = newName;
  }
  const rec = state.factions.get(oldName);
  state.factions.delete(oldName);
  if (rec) state.factions.set(newName, rec);
  if (state.brush.owner === oldName) state.brush.owner = newName;
  if (state.brush.loyalty === oldName) state.brush.loyalty = newName;
  if (state.brush.controller === oldName) state.brush.controller = newName;
  for (const rec of state.regions.values()){
    if (rec.faction === oldName) rec.faction = newName;
  }
}


export function cloneCultureRecord(rec){
  return { color: rec.color };
}

export function snapshotCultures(){
  return Array.from(state.cultures.entries()).map(([name, rec]) => [name, cloneCultureRecord(rec)]);
}

export function restoreCultures(snap){
  state.cultures.clear();
  if (!snap) return;
  for (const [name, rec] of snap){
    state.cultures.set(name, cloneCultureRecord(rec));
  }
}

export function ensureCulture(name, preferredColor){
  if (!name) return null;
  if (!state.cultures.has(name)){
    state.cultures.set(name, { color: preferredColor || computeCultureColor(name) });
  } else if (preferredColor){
    state.cultures.get(name).color = preferredColor;
  }
  return state.cultures.get(name);
}

export function cultureColor(name){
  return ensureCulture(name).color;
}

export function peekCultureColor(name){
  return state.cultures.has(name) ? state.cultures.get(name).color : computeCultureColor(name);
}

export function pruneUnusedCultures(){
  const active = new Set();
  for (const hex of state.hexes.values()) if (hex.culture) active.add(hex.culture);
  for (const name of Array.from(state.cultures.keys())){
    if (!active.has(name) && name !== state.brush.culture) state.cultures.delete(name);
  }
}

export function cloneRegion(rec){
  return {
    id: rec.id,
    name: rec.name,
    type: rec.type,
    governor: rec.governor,
    faction: rec.faction
  };
}

export function makeRegion(raw = {}){
  const id = Number(raw.id);
  return {
    id: Number.isFinite(id) && id > 0 ? id : state.nextRegionId++,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'New Region',
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'Province',
    governor: typeof raw.governor === 'string' ? raw.governor.trim() : '',
    faction: typeof raw.faction === 'string' ? raw.faction.trim() : ''
  };
}

export function snapshotRegions(){
  return {
    nextId: state.nextRegionId,
    list: Array.from(state.regions.values()).map(cloneRegion)
  };
}

export function restoreRegions(snap){
  if (snap == null) return;
  state.regions.clear();
  const list = Array.isArray(snap) ? snap : (snap.list || []);
  let maxId = 0;
  for (const raw of list){
    const rec = makeRegion(raw);
    if (state.regions.has(rec.id)) continue;
    state.regions.set(rec.id, rec);
    if (rec.id > maxId) maxId = rec.id;
  }
  const nextId = Array.isArray(snap) ? maxId + 1 : (Number(snap.nextId) || maxId + 1);
  state.nextRegionId = Math.max(nextId, maxId + 1);
  if (state.brush.regionId != null && !state.regions.has(state.brush.regionId)) state.brush.regionId = null;
}

export function getRegion(id){
  return id == null ? null : (state.regions.get(id) || null);
}

export function hexRegion(hex){
  return hex ? getRegion(hex.region) : null;
}

export function uniqueRegionName(base, faction){
  const stem = (base || 'New Region').trim() || 'New Region';
  const taken = name => {
    const needle = name.toLowerCase();
    for (const rec of state.regions.values()){
      if (rec.faction === faction && rec.name.toLowerCase() === needle) return true;
    }
    return false;
  };
  if (!taken(stem)) return stem;
  let n = 2;
  while (taken(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export function createRegion(faction, raw = {}){
  if (!faction || !state.factions.has(faction)) return null;
  const rec = makeRegion({
    ...raw,
    id: state.nextRegionId++,
    faction,
    name: uniqueRegionName(raw.name || 'New Region', faction)
  });
  state.regions.set(rec.id, rec);
  return rec;
}

export function deleteRegionById(id){
  if (!state.regions.has(id)) return;
  for (const hex of state.hexes.values()){
    if (hex.region === id){
      markHexForUndo(hex);
      hex.region = null;
    }
  }
  state.regions.delete(id);
  if (state.brush.regionId === id) state.brush.regionId = null;
}

export function regionsForFaction(faction){
  const out = [];
  for (const rec of state.regions.values()){
    if (rec.faction === faction) out.push(rec);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getRegionCounts(){
  const counts = new Map();
  for (const hex of state.hexes.values()){
    if (hex.region == null) continue;
    counts.set(hex.region, (counts.get(hex.region) || 0) + 1);
  }
  return counts;
}

export function stripRegionsOfFaction(faction){
  const ids = [];
  for (const rec of state.regions.values()){
    if (rec.faction === faction) ids.push(rec.id);
  }
  for (const id of ids) deleteRegionById(id);
}

export function renameRegionsFaction(oldName, newName){
  if (!oldName || !newName || oldName === newName) return;
  for (const rec of state.regions.values()){
    if (rec.faction === oldName) rec.faction = newName;
  }
}

/* A capital is optional and independent of ownership: a landless faction may
   still point at the hex it claims as its seat. */
export function getFactionCapitalHex(name){
  const rec = state.factions.get(name);
  if (!rec || !rec.capital) return null;
  return state.hexes.get(`${rec.capital.q},${rec.capital.r}`) || null;
}

export function factionsWithCapitalAt(hex){
  if (!hex) return [];
  return getCapitalIndex().get(`${hex.q},${hex.r}`) || [];
}

export function hexIsCapital(hex){
  return factionsWithCapitalAt(hex).length > 0;
}

export function setFactionCapital(name, hex){
  const rec = state.factions.get(name);
  if (!rec) return;
  rec.capital = hex ? { q: hex.q, r: hex.r } : null;
  invalidateFactionCache();
}

export function syncFactionCapitals(){
  for (const rec of state.factions.values()){
    if (!rec.capital) continue;
    if (!state.hexes.has(`${rec.capital.q},${rec.capital.r}`)) rec.capital = null;
  }
  invalidateFactionCache();
}

export const TOOL_DEFS = [
  {
    id: 'terrain',
    label: 'Terrain',
    kind: 'paint',
    shortcut: '1',
    hint: '<div><b>Left</b> drag — paint terrain</div>',
    previewFill: 'rgba(157, 187, 97, 0.28)',
    apply(hex){
      hex.terrain = state.brush.terrain;
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
      const nextOwner = state.factions.has(state.brush.owner) ? state.brush.owner : null;
      if (hex.owner !== nextOwner){
        invalidateFactionCache();
        hex.region = null;
      }
      hex.owner = nextOwner;
      if (state.prefAllowOceanElevPop || !isWaterHex(hex)){
        hex.loyalty = nextOwner;
        hex.controller = nextOwner;
      }
    },
    afterStroke(){
      hooks.refreshFactionList();
      hooks.refreshLoyaltyList();
      hooks.refreshControllerList();
      hooks.refreshRegionList();
    }
  },
  {
    id: 'region',
    label: 'Region',
    kind: 'paint',
    shortcut: '0',
    hint: '<div><b>Left</b> drag — paint administrative region</div>',
    previewFill: 'rgba(232, 214, 160, 0.28)',
    apply(hex){
      const rec = getRegion(state.brush.regionId);
      if (!rec){
        hex.region = null;
        return;
      }
      if (hex.owner !== rec.faction) return;
      hex.region = rec.id;
    },
    afterStroke(){
      hooks.refreshRegionList();
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
      hex.loyalty = state.factions.has(state.brush.loyalty) ? state.brush.loyalty : null;
    },
    afterStroke(){
      hooks.refreshLoyaltyList();
    }
  },
  {
    id: 'controller',
    label: 'De Facto',
    kind: 'paint',
    shortcut: '9',
    hint: '<div><b>Left</b> drag — paint de facto control</div>',
    previewFill: 'rgba(196, 92, 54, 0.28)',
    apply(hex){
      hex.controller = state.factions.has(state.brush.controller) ? state.brush.controller : null;
    },
    afterStroke(){
      hooks.refreshControllerList();
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
      const next = state.brush.culture.trim() === '' ? null : state.brush.culture.trim();
      hex.culture = next;
      if (next) ensureCulture(next);
    },
    afterStroke(){
      hooks.refreshCultureList();
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
      const amount = state.brush.populationAmount * falloff * jitter;
      const prevPop = hex.population;
      if (state.brush.populationMode === 'set'){
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
      hex.elevation = state.brush.elevation;
    }
  }
];
export const TOOL_BY_ID = Object.fromEntries(TOOL_DEFS.map(t => [t.id, t]));

export function getToolDef(id = state.activeTool){
  return TOOL_BY_ID[id] || TOOL_DEFS[0];
}

export function isPaintTool(id = state.activeTool){
  return getToolDef(id).kind === 'paint';
}

export function skipOceanForTool(tool = getToolDef()){
  return !state.prefAllowOceanElevPop && (tool.id === 'population' || tool.id === 'elevation' || tool.id === 'culture' || tool.id === 'loyalty' || tool.id === 'controller');
}

export function cloneHex(h){ return { ...h, elevation: h.elevation || 'flat', controller: h.controller || null, region: h.region || null, customData: { ...h.customData } }; }

export function cloneWaypoints(waypoints){
  return (waypoints || []).map(w => ({ q: w.q, r: w.r }));
}

export function cloneRoutes(list = state.routes){
  return list.map(r => ({
    id: r.id,
    style: r.style,
    name: r.name,
    waypoints: cloneWaypoints(r.waypoints)
  }));
}

export function routeNameTaken(name, exceptId){
  const needle = name.trim().toLowerCase();
  return state.routes.some(r => r.id !== exceptId && r.name.toLowerCase() === needle);
}

export function defaultRouteName(style){
  const base = (ROUTE_BY_ID[style] || {}).label || 'Route';
  let n = 1;
  while (routeNameTaken(`${base} #${n}`, null)) n++;
  return `${base} #${n}`;
}

export function makeRoute(id, style, waypoints, name){
  invalidateRouteIndex();
  return {
    id,
    style,
    name: name || defaultRouteName(style),
    waypoints: cloneWaypoints(waypoints),
    hexes: expandWaypoints(waypoints)
  };
}

export function restoreRoutes(snap){
  state.routes.length = 0;
  invalidateRouteIndex();
  let maxId = 0;
  if (snap){
    for (const r of snap){
      const parsed = parseRouteRecord(r, false);
      if (!parsed) continue;
      state.routes.push(parsed);
      if (parsed.id > maxId) maxId = parsed.id;
    }
  }
  state.nextRouteId = maxId + 1;
  invalidateRouteIndex();
  state.routeDrag = null;
  if (!state.routes.some(r => r.id === state.selectedRouteId)) state.selectedRouteId = null;
}

/* Hex key -> route ids. Rebuilt lazily; every route mutation invalidates it. */
export function invalidateRouteIndex(){
  state.routeCellIndex = null;
}

export function routeCells(route){
  if (!route.hexes) route.hexes = expandWaypoints(route.waypoints);
  return route.hexes;
}

export function getRouteIndex(){
  if (state.routeCellIndex) return state.routeCellIndex;
  state.routeCellIndex = new Map();
  for (const route of state.routes){
    for (const cell of routeCells(route)){
      const key = `${cell.q},${cell.r}`;
      const ids = state.routeCellIndex.get(key);
      if (ids) ids.push(route.id);
      else state.routeCellIndex.set(key, [route.id]);
    }
  }
  return state.routeCellIndex;
}

export function routeIdsAtKey(key){
  return getRouteIndex().get(key) || [];
}

/* A path may never cover a hex twice, and may touch another path only at single
   hexes — junctions, branch origins and crossings. Sharing two hexes in a row
   means the two paths would run along each other, which is rejected. */
export function validatePath(waypoints, excludeRouteId){
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

export function snapshotState(){
  return { hexes: Array.from(state.hexes.values()).map(cloneHex), mapCols: state.mapCols, mapRows: state.mapRows, factions: snapshotFactions(), cultures: snapshotCultures(), regions: snapshotRegions(), routes: cloneRoutes() };
}

export function applyFullState(full){
  state.hexes.clear();
  full.hexes.forEach(h => state.hexes.set(`${h.q},${h.r}`, cloneHex(h)));
  state.mapCols = full.mapCols; state.mapRows = full.mapRows;
  document.getElementById('mapCols').value = state.mapCols;
  document.getElementById('mapRows').value = state.mapRows;
  restoreFactions(full.factions || full.countries);
  restoreCultures(full.cultures);
  restoreRegions(full.regions || { nextId: 1, list: [] });
  restoreRoutes(full.routes);
  invalidateFactionCache();
}

export function pushFullStateUndo() {
  state.undoStack.push({ type: 'full', state: snapshotState() });
  if (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  updateHistoryButtons();
}

export function beginAction() {
  state.isActionActive = true;
  state.activeUndoDelta.clear();
  state.activeFactionsBefore = snapshotFactions();
  state.activeCulturesBefore = snapshotCultures();
  state.activeRegionsBefore = snapshotRegions();
}

export function markHexForUndo(hex) {
  if (!state.isActionActive) return;
  const key = `${hex.q},${hex.r}`;
  if (!state.activeUndoDelta.has(key)) {
    state.activeUndoDelta.set(key, cloneHex(hex));
  }
}

export function persistAutosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshotState()));
    state.lastAutosaveAt = Date.now();
  } catch (_) { /* quota / private mode */ }
}

export function throttledAutosave() {
  if (state.autosaveIntervalMs <= 0) return;
  if (Date.now() - state.lastAutosaveAt < state.autosaveIntervalMs) return;
  persistAutosave();
}

window.addEventListener('beforeunload', e => {
  if (state.prefWarnUnload !== true) return;
  e.preventDefault();
  e.returnValue = '';
});

export function setAutosaveInterval(ms){
  const interval = Number(ms) || 0;
  state.autosaveIntervalMs = interval > 0 ? interval : 0;
  clearInterval(state.autosaveTimerId);
  state.autosaveTimerId = null;
  if (state.autosaveIntervalMs > 0){
    state.autosaveTimerId = setInterval(persistAutosave, state.autosaveIntervalMs);
  }
}

export function prefBool(value, fallback = true){
  return typeof value === 'boolean' ? value : fallback;
}

export function applyPrefsFromObject(prefs){
  if (!prefs || typeof prefs !== 'object') return;
  if (prefs.maxUndo != null){
    state.MAX_UNDO = Math.max(1, parseInt(prefs.maxUndo, 10) || DEFAULT_MAX_UNDO);
    while (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
  }
  if (prefs.autosaveMs != null) setAutosaveInterval(prefs.autosaveMs);
  if (prefs.prefConfirmDeletes != null) state.prefConfirmDeletes = prefBool(prefs.prefConfirmDeletes, true);
  if (prefs.prefConfirmCleanOcean != null) state.prefConfirmCleanOcean = prefBool(prefs.prefConfirmCleanOcean, true);
  if (prefs.prefWarnUnload != null) state.prefWarnUnload = prefBool(prefs.prefWarnUnload, true);
  if (prefs.prefPromptRestore != null) state.prefPromptRestore = prefBool(prefs.prefPromptRestore, true);
  if (prefs.prefAllowOceanElevPop != null) state.prefAllowOceanElevPop = prefBool(prefs.prefAllowOceanElevPop, true);
  const autosaveEl = document.getElementById('settingsAutosave');
  const maxUndoEl = document.getElementById('settingsMaxUndo');
  if (autosaveEl){
    const value = String(Number(state.autosaveIntervalMs) || 0);
    autosaveEl.value = [...autosaveEl.options].some(o => o.value === value) ? value : '0';
  }
  if (maxUndoEl) maxUndoEl.value = state.MAX_UNDO;
  const confirmEl = document.getElementById('settingsPrefConfirmDeletes');
  const cleanOceanEl = document.getElementById('settingsPrefConfirmCleanOcean');
  const warnEl = document.getElementById('settingsPrefWarnUnload');
  const restoreEl = document.getElementById('settingsPrefPromptRestore');
  const oceanEl = document.getElementById('settingsPrefOceanElevPop');
  if (confirmEl) confirmEl.checked = state.prefConfirmDeletes;
  if (cleanOceanEl) cleanOceanEl.checked = state.prefConfirmCleanOcean;
  if (warnEl) warnEl.checked = state.prefWarnUnload;
  if (restoreEl) restoreEl.checked = state.prefPromptRestore;
  if (oceanEl) oceanEl.checked = state.prefAllowOceanElevPop;
}

export function commitAction() {
  if (!state.isActionActive) return;
  invalidateFactionCache();
  syncFactionCapitals();
  pruneUnusedCultures();
  const factionsAfter = snapshotFactions();
  const culturesAfter = snapshotCultures();
  const regionsAfter = snapshotRegions();
  const factionsChanged = JSON.stringify(state.activeFactionsBefore) !== JSON.stringify(factionsAfter);
  const culturesChanged = JSON.stringify(state.activeCulturesBefore) !== JSON.stringify(culturesAfter);
  const regionsChanged = JSON.stringify(state.activeRegionsBefore) !== JSON.stringify(regionsAfter);
  if (state.activeUndoDelta.size > 0 || factionsChanged || culturesChanged || regionsChanged) {
    state.undoStack.push({
      type: 'delta',
      changes: state.activeUndoDelta,
      factionsBefore: state.activeFactionsBefore,
      factionsAfter,
      culturesBefore: state.activeCulturesBefore,
      culturesAfter,
      regionsBefore: state.activeRegionsBefore,
      regionsAfter
    });
    if (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
    state.redoStack.length = 0;
    updateHistoryButtons();
    throttledAutosave();
  }
  state.isActionActive = false;
  state.activeUndoDelta = new Map();
  state.activeFactionsBefore = null;
  state.activeCulturesBefore = null;
  state.activeRegionsBefore = null;
  hooks.refreshSelectedHexPanel();
}

export function executeAtomicDelta(hexesToMark, fn) {
  beginAction();
  hexesToMark.forEach(h => markHexForUndo(h));
  fn();
  commitAction();
}

export function undo(){
  if (state.undoStack.length === 0) return;
  cancelPathDraft();
  const action = state.undoStack.pop();
  
  if (action.type === 'full') {
    state.redoStack.push({ type: 'full', state: snapshotState() });
    applyFullState(action.state);
  } else if (action.type === 'delta') {
    const redoDelta = new Map();
    for (const [key, oldHex] of action.changes.entries()) {
      redoDelta.set(key, cloneHex(state.hexes.get(key)));
      state.hexes.set(key, cloneHex(oldHex));
    }
    state.redoStack.push({
      type: 'delta',
      changes: redoDelta,
      factionsBefore: action.factionsBefore,
      factionsAfter: action.factionsAfter,
      culturesBefore: action.culturesBefore,
      culturesAfter: action.culturesAfter,
      regionsBefore: action.regionsBefore,
      regionsAfter: action.regionsAfter
    });
    restoreFactions(action.factionsBefore);
    restoreCultures(action.culturesBefore);
    restoreRegions(action.regionsBefore);
  } else if (action.type === 'routes') {
    state.redoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.before);
  }

  reresolveSelection();
  invalidatePopulationStats();
  hooks.render();
  hooks.refreshFactionList();
  hooks.refreshLoyaltyList();
  hooks.refreshControllerList();
  hooks.refreshCultureList();
  hooks.refreshRegionList();
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
  updateHistoryButtons();
}

export function redo(){
  if (state.redoStack.length === 0) return;
  cancelPathDraft();
  const action = state.redoStack.pop();
  
  if (action.type === 'full') {
    state.undoStack.push({ type: 'full', state: snapshotState() });
    applyFullState(action.state);
  } else if (action.type === 'delta') {
    const undoDelta = new Map();
    for (const [key, newHex] of action.changes.entries()) {
      undoDelta.set(key, cloneHex(state.hexes.get(key)));
      state.hexes.set(key, cloneHex(newHex));
    }
    state.undoStack.push({
      type: 'delta',
      changes: undoDelta,
      factionsBefore: action.factionsBefore,
      factionsAfter: action.factionsAfter,
      culturesBefore: action.culturesBefore,
      culturesAfter: action.culturesAfter,
      regionsBefore: action.regionsBefore,
      regionsAfter: action.regionsAfter
    });
    restoreFactions(action.factionsAfter);
    restoreCultures(action.culturesAfter);
    restoreRegions(action.regionsAfter);
  } else if (action.type === 'routes') {
    state.undoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.after);
  }

  reresolveSelection();
  invalidatePopulationStats();
  hooks.render();
  hooks.refreshFactionList();
  hooks.refreshLoyaltyList();
  hooks.refreshControllerList();
  hooks.refreshCultureList();
  hooks.refreshRegionList();
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
  updateHistoryButtons();
}

export function reresolveSelection(){
  state.hoveredHex = null;
  if (state.selectedHex) state.selectedHex = state.hexes.get(`${state.selectedHex.q},${state.selectedHex.r}`) || null;
  hooks.refreshSelectedHexPanel();
}

export function updateHistoryButtons(){
  document.getElementById('undoBtn').disabled = state.undoStack.length === 0;
  document.getElementById('redoBtn').disabled = state.redoStack.length === 0;
}

export function pushRoutesUndo(before){
  const after = cloneRoutes();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  state.undoStack.push({ type: 'routes', before, after });
  if (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
  state.redoStack.length = 0;
  updateHistoryButtons();
}

export function parseRouteRecord(raw, assignId){
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
  const id = (typeof raw.id === 'number' && !assignId) ? raw.id : state.nextRouteId++;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  return makeRoute(id, style, waypoints, name);
}

/* ----------------------------------------------------------------------------
   6. MAP GENERATION
   ---------------------------------------------------------------------------- */
export function generateMap(cols, rows){
  state.hexes.clear();
  state.factions.clear();
  invalidateFactionCache();
  state.cultures.clear();
  state.regions.clear();
  state.nextRegionId = 1;
  state.brush.regionId = null;
  state.routes.length = 0;
  state.nextRouteId = 1;
  state.pathDraft = null;
  state.routeDrag = null;
  state.selectedRouteId = null;
  invalidateRouteIndex();
  invalidatePopulationStats();
  for (let row = 0; row < rows; row++){
    for (let col = 0; col < cols; col++){
      const { q, r } = offsetToAxial(col, row);
      const coords = axialToPixel(q, r, HEX_SIZE);
      state.hexes.set(`${q},${r}`, {
        q, r, x: coords.x, y: coords.y, terrain: 'ocean', elevation: 'flat', population: 0, owner: null,
        loyalty: null, controller: null, region: null, culture: null, cityName: null, customData: {}
      });
    }
  }
  state.mapCols = cols;
  state.mapRows = rows;
  hooks.refreshPathUi();
  hooks.refreshRouteList();
  hooks.refreshRegionList();
}

export function centerCamera(){
  if (state.hexes.size === 0){ state.camera.x = 0; state.camera.y = 0; return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const hex of state.hexes.values()){
    if (hex.x < minX) minX = hex.x; if (hex.x > maxX) maxX = hex.x;
    if (hex.y < minY) minY = hex.y; if (hex.y > maxY) maxY = hex.y;
  }
  state.camera.x = (minX + maxX) / 2;
  state.camera.y = (minY + maxY) / 2;
  const w = (maxX - minX) + HEX_SIZE * 4;
  const h = (maxY - minY) + HEX_SIZE * 4;
  const fitZoom = Math.min(canvas.width / w, canvas.height / h);
  state.camera.zoom = clamp(isFinite(fitZoom) ? fitZoom : 1, MIN_ZOOM, MAX_ZOOM);
}

export function lerp(a, b, t){ return a + (b - a) * t; }

export function lerpColor(c1, c2, t){
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t))
  ];
}


export function heatmapColorAt(t){
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

export function invalidatePopulationStats(){
  state.popStats.dirty = true;
}

export function getPopulationStats(){
  if (!state.popStats.dirty) return state.popStats;
  let max = 0;
  for (const hex of state.hexes.values()){
    if (hex.population > max) max = hex.population;
  }
  state.popStats.max = max;
  state.popStats.dirty = false;
  return state.popStats;
}

export function populationHeatT(pop, maxPop){
  if (pop <= 0 || maxPop <= 0) return 0;
  if (state.heatmapScale === 'log') return Math.log1p(pop) / Math.log1p(maxPop);
  return pop / maxPop;
}

export function getHeatmapColor(pop, maxPop) {
  if (pop <= 0) return 'rgba(0,0,0,0)';
    const t = Math.max(0.04, populationHeatT(pop, maxPop));
    return heatmapColorAt(Math.round(t * 32) / 32);
}

export function formatPop(n){
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

export function updateHeatmapLegend(){
  const wrap = document.getElementById('heatmapControls');
  const maxEl = document.getElementById('heatmapLegendMax');
  const midEl = document.getElementById('heatmapLegendMid');
  if (!wrap) return;
  wrap.hidden = !state.viewLayers.population;
  if (!state.viewLayers.population) return;
  const max = getPopulationStats().max;
  maxEl.textContent = max > 0 ? formatPop(max) : '0';
  if (max <= 0){
    midEl.textContent = '—';
    return;
  }
  if (state.heatmapScale === 'log'){
    const mid = Math.expm1(Math.log1p(max) * 0.5);
    midEl.textContent = formatPop(Math.round(mid));
  } else {
    midEl.textContent = formatPop(Math.round(max / 2));
  }
}

export function isWaterHex(hex){
  return !!hex && hex.terrain === 'ocean';
}

/* Paths stop at hex centres, which leaves a river hanging inland when the coast
   is the next hex over. For rivers only, the terminal drains into the ocean hex
   that best continues its flow. Both the renderer and the exporter use this. */
export function riverMouthNeighbor(cell, inwardCell){
  const hex = cell ? state.hexes.get(`${cell.q},${cell.r}`) : null;
  if (!hex || isWaterHex(hex)) return null;

  const inward = inwardCell ? state.hexes.get(`${inwardCell.q},${inwardCell.r}`) : null;
  let flowX = 0, flowY = 0;
  if (inward){
    flowX = hex.x - inward.x;
    flowY = hex.y - inward.y;
    const len = Math.hypot(flowX, flowY) || 1;
    flowX /= len; flowY /= len;
  }

  let best = null, bestDot = -Infinity;
  for (const dir of NEIGHBOR_DIRS){
    const neighbor = state.hexes.get(`${cell.q + dir.q},${cell.r + dir.r}`);
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
export function riverMouthPoint(cell, inwardCell){
  const hex = cell ? state.hexes.get(`${cell.q},${cell.r}`) : null;
  const water = riverMouthNeighbor(cell, inwardCell);
  if (!hex || !water) return null;
  return { x: (hex.x + water.x) / 2, y: (hex.y + water.y) / 2 };
}

/* Terminals of a river that reach open water, as plain hex coordinates. */
export function routeMouths(route){
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

export function routeWorldPolylines(waypoints, styleId){
  const expanded = expandWaypoints(waypoints);
  const runs = [];
  let current = null;

  for (let i = 0; i < expanded.length; i++){
    const hex = state.hexes.get(`${expanded[i].q},${expanded[i].r}`);
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

export function isRouteBusy(id){
  return (state.pathDraft && state.pathDraft.routeId === id) || (state.routeDrag && state.routeDrag.routeId === id);
}

export function findRouteAtHex(hex){
  if (!hex) return null;
  const ids = routeIdsAtKey(`${hex.q},${hex.r}`);
  for (let i = state.routes.length - 1; i >= 0; i--){
    const r = state.routes[i];
    if (isRouteBusy(r.id)) continue;
    if (ids.includes(r.id)) return r;
  }
  return null;
}

export function findExtendableRoute(hex){
  if (!hex) return null;
  for (let i = state.routes.length - 1; i >= 0; i--){
    const r = state.routes[i];
    if (r.style !== state.brush.routeStyle) continue;
    const start = r.waypoints[0];
    const end = r.waypoints[r.waypoints.length - 1];
    if (end && end.q === hex.q && end.r === hex.r) return { route: r, reverse: false };
    if (start && start.q === hex.q && start.r === hex.r) return { route: r, reverse: true };
  }
  return null;
}

export function routesOnHex(hex){
  if (!hex) return [];
  const ids = routeIdsAtKey(`${hex.q},${hex.r}`);
  if (ids.length === 0) return [];
  return state.routes.filter(r => ids.includes(r.id));
}

export function getSelectedRoute(){
  return state.routes.find(r => r.id === state.selectedRouteId) || null;
}

export function waypointIndexAtHex(route, hex){
  if (!route || !hex) return -1;
  return route.waypoints.findIndex(w => w.q === hex.q && w.r === hex.r);
}

/* Which segment of a route a hex falls on, so Shift+Click can insert there. */
export function segmentIndexForHex(route, hex){
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

export function cancelPathDraft(){
  state.pathDraft = null;
  state.routeDrag = null;
  hooks.refreshPathUi();
  hooks.refreshInteractionUI();
}

export function replaceRoute(index, waypoints){
  const route = state.routes[index];
  state.routes[index] = makeRoute(route.id, route.style, waypoints, route.name);
  invalidateRouteIndex();
}

export function commitPathDraft(){
  if (!state.pathDraft || state.pathDraft.waypoints.length < 2){
    cancelPathDraft();
    hooks.render();
    return;
  }
  const before = cloneRoutes();
  const style = state.pathDraft.style;
  const existing = state.pathDraft.routeId ? state.routes.findIndex(r => r.id === state.pathDraft.routeId) : -1;
  if (existing >= 0){
    replaceRoute(existing, state.pathDraft.waypoints);
  } else {
    state.routes.push(makeRoute(state.nextRouteId++, style, state.pathDraft.waypoints));
    invalidateRouteIndex();
  }
  state.pathDraft = null;
  pushRoutesUndo(before);
  hooks.refreshPathUi();
  hooks.refreshRouteList();
  hooks.refreshInteractionUI();
  hooks.render();
}

export function deleteRouteById(id){
  const idx = state.routes.findIndex(r => r.id === id);
  if (idx < 0) return;
  const before = cloneRoutes();
  state.routes.splice(idx, 1);
  invalidateRouteIndex();
  if (state.selectedRouteId === id) state.selectedRouteId = null;
  pushRoutesUndo(before);
  hooks.refreshRouteList();
}

export function renameRoute(id, nextName){
  const route = state.routes.find(r => r.id === id);
  const name = (nextName || '').trim();
  if (!route || !name || route.name === name) return;
  if (routeNameTaken(name, id)){
    alert(`Another road or river is already called "${name}".`);
    return;
  }
  const before = cloneRoutes();
  route.name = name;
  pushRoutesUndo(before);
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
}

export function moveWaypoint(routeId, index, hex){
  const idx = state.routes.findIndex(r => r.id === routeId);
  if (idx < 0) return false;
  const next = cloneWaypoints(state.routes[idx].waypoints);
  if (!next[index] || sameHex(next[index], hex)) return false;
  next[index] = { q: hex.q, r: hex.r };
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  hooks.refreshRouteList();
  return true;
}

export function insertWaypoint(routeId, at, hex){
  const idx = state.routes.findIndex(r => r.id === routeId);
  if (idx < 0 || at < 1) return false;
  const next = cloneWaypoints(state.routes[idx].waypoints);
  next.splice(at, 0, { q: hex.q, r: hex.r });
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  hooks.refreshRouteList();
  return true;
}

export function removeWaypoint(routeId, index){
  const idx = state.routes.findIndex(r => r.id === routeId);
  if (idx < 0) return false;
  if (state.routes[idx].waypoints.length <= 2) return false;
  const next = cloneWaypoints(state.routes[idx].waypoints).filter((_, i) => i !== index);
  if (!validatePath(next, routeId).ok) return false;
  const before = cloneRoutes();
  replaceRoute(idx, next);
  pushRoutesUndo(before);
  hooks.refreshRouteList();
  return true;
}

export function selectRoute(id){
  state.selectedRouteId = id;
  const route = getSelectedRoute();
  if (route && route.style !== state.brush.routeStyle){
    state.brush.routeStyle = route.style;
    hooks.syncRouteSwatches();
  }
  hooks.refreshRouteList();
  hooks.refreshInteractionUI();
}

export function sameHex(a, hex){
  return a && hex && a.q === hex.q && a.r === hex.r;
}

export function handlePathEditDown(hex, e){
  const selected = getSelectedRoute();
  if (selected && hex){
    const wpIndex = waypointIndexAtHex(selected, hex);
    if (wpIndex >= 0){
      if (e.altKey){
        removeWaypoint(selected.id, wpIndex);
        hooks.render();
        return;
      }
      state.routeDrag = { routeId: selected.id, index: wpIndex, waypoints: cloneWaypoints(selected.waypoints) };
      hooks.refreshInteractionUI();
      hooks.render();
      return;
    }
    if (e.shiftKey){
      const at = segmentIndexForHex(selected, hex);
      if (at > 0){
        insertWaypoint(selected.id, at, hex);
        hooks.render();
        return;
      }
    }
  }

  const hit = findRouteAtHex(hex);
  selectRoute(hit ? hit.id : null);
  hooks.render();
}

export function finishRouteDrag(){
  if (!state.routeDrag) return;
  const drag = state.routeDrag;
  state.routeDrag = null;
  moveWaypoint(drag.routeId, drag.index, drag.waypoints[drag.index]);
  hooks.refreshInteractionUI();
  hooks.render();
}

export function handlePathClick(hex, e){
  if (!hex) return;

  if (state.brush.pathMode === 'erase'){
    const hit = findRouteAtHex(hex);
    if (hit){
      deleteRouteById(hit.id);
      hooks.render();
    }
    return;
  }

  if (state.brush.pathMode === 'edit'){
    handlePathEditDown(hex, e);
    return;
  }

  if (!state.pathDraft){
    // Alt forces a fresh path so you can branch off an endpoint instead of extending it.
    const extend = e.altKey ? null : findExtendableRoute(hex);
    if (extend){
      state.pathDraft = {
        routeId: extend.route.id,
        style: extend.route.style,
        waypoints: cloneWaypoints(extend.reverse ? extend.route.waypoints.slice().reverse() : extend.route.waypoints)
      };
    } else {
      state.pathDraft = {
        routeId: null,
        style: state.brush.routeStyle,
        waypoints: [{ q: hex.q, r: hex.r }]
      };
    }
    hooks.refreshPathUi();
    hooks.refreshInteractionUI();
    hooks.render();
    return;
  }

  const last = state.pathDraft.waypoints[state.pathDraft.waypoints.length - 1];
  if (sameHex(last, hex)) return;

  const candidate = state.pathDraft.waypoints.concat([{ q: hex.q, r: hex.r }]);
  if (!validatePath(candidate, state.pathDraft.routeId).ok) return;

  state.pathDraft.waypoints = candidate;
  if (e.shiftKey){
    hooks.refreshPathUi();
    hooks.refreshInteractionUI();
    hooks.render();
    return;
  }
  commitPathDraft();
}

export function refreshPathUi(){
  const btn = document.getElementById('cancelPathBtn');
  if (btn) btn.disabled = !state.pathDraft;
}

/* ----------------------------------------------------------------------------
   8. CAMERA / INPUT HANDLING
   ---------------------------------------------------------------------------- */
export function getHexAtScreen(mx, my){
  const w = screenToWorld(mx, my);
  const frac = pixelToAxial(w.x, w.y, HEX_SIZE);
  const rounded = axialRound(frac.q, frac.r);
  return state.hexes.get(`${rounded.q},${rounded.r}`) || null;
}

export function applyBrush(hex, paintCtx){
  const tool = getToolDef();
  if (!tool.apply) return;
  if (skipOceanForTool(tool) && isWaterHex(hex)) return;
  markHexForUndo(hex);
  tool.apply(hex, paintCtx);
}

export function paintAtScreen(mx, my){
  const tool = getToolDef();
  if (tool.kind !== 'paint') return;
  const w = screenToWorld(mx, my);
  const frac = pixelToAxial(w.x, w.y, HEX_SIZE);
  const center = axialRound(frac.q, frac.r);
  const targets = hexRange(center.q, center.r, state.brush.size - 1);
  let changed = false;
  for (const t of targets){
    const hex = state.hexes.get(`${t.q},${t.r}`);
    if (!hex) continue;
    const dist = axialDistance(center.q, center.r, t.q, t.r);
    applyBrush(hex, { axialDistance: dist });
    changed = true;
  }
  if (changed){
    hooks.render();
    if (tool.afterStroke) tool.afterStroke();
    if (state.hoveredHex) hooks.updateInspector(state.hoveredHex);
  }
}

export function applyCityLabelToHex(hex){
  const name = document.getElementById('cityNameInput').value.trim();
  hex.cityName = name === '' ? null : name;
}

export function applyZoom(factor, mx, my) {
  const before = screenToWorld(mx, my);
  state.camera.zoom = clamp(state.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  state.camera.x = before.x - (mx - canvas.width / 2) / state.camera.zoom;
  state.camera.y = before.y - (my - canvas.height / 2) / state.camera.zoom;
  hooks.render();
}
