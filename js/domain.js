import { state, hooks } from './state.js';
import {
  HEX_SIZE, MIN_ZOOM, MAX_ZOOM, DEFAULT_MAX_UNDO, LEGACY_TERRAIN_IDS,
  ROUTE_DEFS, ROUTE_BY_ID, FACTION_TYPE_LABELS, FACTION_CODE_LEN,
  HEATMAP_STOPS, AUTOSAVE_KEY, DEFAULT_BUILDING_TYPES
} from './constants.js';
import {
  axialToPixel, pixelToAxial, axialRound, offsetToAxial, axialToOffset, hexRange,
  NEIGHBOR_DIRS, clamp, axialDistance, hexLine, expandWaypoints
} from './hexMath.js';
import {
  computeOwnerColor, computeCultureColor, grayLoyaltyColor, shiftHexHue
} from './color.js';
import { canvas, screenToWorld } from './canvas.js';

export function loyaltyFillColor(hex){
  const id = hex.loyaltyFactionId;
  if (!id) return null;
  const rec = getFaction(id);
  // A landless faction has no territory to take a color from, so it stays gray.
  if (!rec || factionHexCount(id) === 0) return grayLoyaltyColor(id);
  if (hex.ownerFactionId === id) return rec.color;
  return shiftHexHue(rec.color, 48, 0.82, 0.78);
}

export function controllerFillColor(hex){
  const id = hex.controllerFactionId;
  if (!id || hex.ownerFactionId === id) return null;
  const rec = getFaction(id);
  if (!rec || factionHexCount(id) === 0) return grayLoyaltyColor(id);
  if (hex.ownerFactionId === id) return rec.color;
  return shiftHexHue(rec.color, -32, 1.05, 0.72);
}

export function normalizeFactionType(type){
  if (FACTION_TYPE_LABELS[type]) return type;
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'state';
  for (const def of Object.entries(FACTION_TYPE_LABELS)){
    if (def[1].toLowerCase() === t) return def[0];
  }
  if (t === 'non-state' || t === 'nonstate actor' || t === 'non-state actor') return 'nonstate';
  if (t === 'corporate entity' || t === 'corp') return 'corporate';
  if (t === 'rebel / insurgent' || t === 'rebel' || t === 'insurgent') return 'rebel';
  if (t === 'religious order' || t === 'religious') return 'religious';
  if (t.includes('non') || t.includes('rebel') || t.includes('corp') || t.includes('relig')) return 'nonstate';
  return 'state';
}

export function normalizeFactionCode(raw){
  if (typeof raw !== 'string') return '';
  let code = raw.trim().toUpperCase();
  if (code.startsWith('F-')) code = code.slice(2);
  return code.replace(/[^A-Z0-9]/g, '').slice(0, FACTION_CODE_LEN);
}

export function formatFactionCode(raw){
  const stem = normalizeFactionCode(raw);
  return stem ? `F-${stem}` : '';
}

export function looksLikeFactionId(raw){
  return typeof raw === 'string' && /^F-[A-Z0-9]{4}$/i.test(raw.trim());
}

export function normalizeFactionId(raw){
  if (looksLikeFactionId(raw)) return formatFactionCode(raw);
  return typeof raw === 'string' ? raw.trim() : '';
}

export function takenFactionIds(exceptId){
  const taken = new Set(state.factions.keys());
  if (exceptId) taken.delete(exceptId);
  return taken;
}

export function allocateFactionId(name, taken){
  const used = taken || takenFactionIds();
  let stem = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, FACTION_CODE_LEN);
  while (stem.length < FACTION_CODE_LEN) stem += '0';
  let id = formatFactionCode(stem);
  if (id && !used.has(id)) return id;
  for (let n = 1; n < 10000; n++){
    const tail = String(n);
    const candidate = stem.slice(0, FACTION_CODE_LEN - tail.length) + tail;
    id = formatFactionCode(candidate);
    if (!used.has(id)) return id;
  }
  do {
    const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, 'X') + '0000';
    id = formatFactionCode(rand.slice(0, FACTION_CODE_LEN));
  } while (used.has(id));
  return id;
}

export function makeFactionId(name, exceptId){
  return allocateFactionId(name, takenFactionIds(exceptId));
}

export function getFaction(id){
  const fid = normalizeFactionId(id);
  return fid ? (state.factions.get(fid) || null) : null;
}

export function knownFactionId(id){
  const rec = getFaction(id);
  return rec ? rec.id : null;
}

export function factionName(id){
  const rec = getFaction(id);
  return rec ? rec.name : '';
}

export function isFactionCodeFree(code, exceptId){
  const id = formatFactionCode(code);
  if (!id) return false;
  for (const rec of state.factions.values()){
    if (rec.id !== exceptId && rec.id === id) return false;
  }
  return true;
}

export function isFactionNameFree(name, exceptId){
  for (const rec of state.factions.values()){
    if (rec.id !== exceptId && rec.name === name) return false;
  }
  return true;
}

/* Squeezes a name down to four characters, then walks a numeric tail until the
   F-XXXX identity is unused. */
export function suggestFactionCode(name, exceptId){
  let stem = (name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, FACTION_CODE_LEN);
  while (stem.length < FACTION_CODE_LEN) stem += '0';
  if (isFactionCodeFree(stem, exceptId)) return stem;
  for (let n = 1; n < 10000; n++){
    const tail = String(n);
    const candidate = stem.slice(0, FACTION_CODE_LEN - tail.length) + tail;
    if (isFactionCodeFree(candidate, exceptId)) return candidate;
  }
  return stem;
}

export function cloneCapital(cap){
  if (typeof cap === 'string' && cap.trim()) return { name: cap.trim() };
  if (!cap || typeof cap !== 'object') return null;
  const q = Number(cap.q);
  const r = Number(cap.r);
  const hex = Number.isFinite(q) && Number.isFinite(r) ? { q, r } : null;
  const name = typeof cap.name === 'string' ? cap.name.trim() : '';
  if (!hex && !name) return null;
  return { ...(hex || {}), ...(name ? { name } : {}) };
}

export function cloneFaction(rec){
  return {
    id: rec.id,
    name: rec.name,
    color: rec.color,
    code: rec.id,
    type: rec.type,
    ideology: rec.ideology,
    description: rec.description,
    flag: rec.flag,
    capital: cloneCapital(rec.capital)
  };
}

function buildFactionRecord(raw, id){
  const src = raw && typeof raw === 'object' ? raw : {};
  const name = typeof src.name === 'string' && src.name.trim() ? src.name.trim() : 'New Faction';
  return {
    id,
    name,
    color: typeof src.color === 'string' && src.color ? src.color : computeOwnerColor(name),
    code: id,
    type: normalizeFactionType(src.type),
    ideology: typeof src.ideology === 'string' ? src.ideology : '',
    description: typeof src.description === 'string' ? src.description : '',
    flag: typeof src.flag === 'string' && src.flag ? src.flag : null,
    capital: cloneCapital(src.capital)
  };
}

/* Basic faction record shared with Lorekeeper:
   { id: "F-XXXX", name, code: "F-XXXX", type, ideology, description, color, flag, capital } */
export function basicFactionEntry(rec){
  return {
    id: rec.id,
    name: rec.name,
    code: rec.id,
    type: rec.type,
    ideology: rec.ideology,
    description: rec.description,
    color: rec.color,
    flag: rec.flag || null,
    capital: cloneCapital(rec.capital)
  };
}

export function ingestFactions(list){
  const items = Array.isArray(list) ? list.filter(x => x && typeof x === 'object') : [];
  const taken = new Set();
  const assigned = new Array(items.length).fill(null);
  const remap = new Map();

  const claim = (index, id) => {
    assigned[index] = id;
    taken.add(id);
    const item = items[index];
    const rawId = typeof item.id === 'string' ? item.id.trim() : '';
    if (rawId && rawId !== id && !looksLikeFactionId(rawId)) remap.set(rawId, id);
  };

  items.forEach((item, i) => {
    if (!looksLikeFactionId(item.id)) return;
    const id = formatFactionCode(item.id);
    if (!taken.has(id)) claim(i, id);
  });

  items.forEach((item, i) => {
    if (assigned[i]) return;
    const stem = normalizeFactionCode(item.code);
    if (stem.length !== FACTION_CODE_LEN) return;
    const id = formatFactionCode(stem);
    if (taken.has(id)){
      assigned[i] = id;
      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      if (rawId && rawId !== id && !looksLikeFactionId(rawId)) remap.set(rawId, id);
      return;
    }
    claim(i, id);
  });

  items.forEach((item, i) => {
    if (assigned[i]) return;
    claim(i, allocateFactionId(item.name, taken));
  });

  const recs = [];
  const seen = new Set();
  items.forEach((item, i) => {
    const id = assigned[i];
    if (seen.has(id)) return;
    seen.add(id);
    recs.push(buildFactionRecord(item, id));
  });
  return { recs, remap };
}

export function makeFaction(raw = {}, exceptId){
  const src = raw && typeof raw === 'object' ? raw : {};
  const taken = takenFactionIds(exceptId);
  let id = '';
  if (looksLikeFactionId(src.id)){
    const requested = formatFactionCode(src.id);
    if (!taken.has(requested)) id = requested;
  }
  if (!id){
    const stem = normalizeFactionCode(src.code);
    if (stem.length === FACTION_CODE_LEN){
      const fromCode = formatFactionCode(stem);
      if (!taken.has(fromCode)) id = fromCode;
    }
  }
  if (!id) id = allocateFactionId(src.name, taken);
  return buildFactionRecord(src, id);
}

export function snapshotFactions(){
  return Array.from(state.factions.values()).map(cloneFaction);
}

export function restoreFactions(snap){
  const { recs, remap } = ingestFactions(Array.isArray(snap) ? snap : []);
  state.factions.clear();
  for (const rec of recs) state.factions.set(rec.id, rec);
  invalidateFactionCache();
  return remap;
}

export function ensureFactionCodes(){
  const remap = restoreFactions(snapshotFactions());
  applyFactionIdRemap(remap);
}

export function ensureFaction(id, raw){
  const rec = makeFaction({ ...(raw || {}), id });
  if (!state.factions.has(rec.id)){
    state.factions.set(rec.id, rec);
    invalidateFactionCache();
  } else if (raw && typeof raw.color === 'string' && raw.color){
    state.factions.get(rec.id).color = raw.color;
  }
  return state.factions.get(rec.id);
}

export function factionColor(id){
  const rec = getFaction(id);
  return rec ? rec.color : computeOwnerColor(id || '');
}

export function sortedFactions(){
  return Array.from(state.factions.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function sortedFactionNames(){
  return sortedFactions().map(rec => rec.name);
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
    if (hex.ownerFactionId) state.factionCounts.set(hex.ownerFactionId, (state.factionCounts.get(hex.ownerFactionId) || 0) + 1);
  }
  return state.factionCounts;
}

export function getCapitalIndex(){
  if (state.capitalIndex) return state.capitalIndex;
  state.capitalIndex = new Map();
  for (const rec of state.factions.values()){
    if (!rec.capital) continue;
    if (!Number.isFinite(Number(rec.capital.q)) || !Number.isFinite(Number(rec.capital.r))) continue;
    const key = `${rec.capital.q},${rec.capital.r}`;
    const at = state.capitalIndex.get(key);
    if (at) at.push(rec.id);
    else state.capitalIndex.set(key, [rec.id]);
  }
  return state.capitalIndex;
}

export function factionHexCount(id){
  return getFactionCounts().get(id) || 0;
}

export function uniqueFactionName(base, exceptId){
  const stem = (base || 'New Faction').trim() || 'New Faction';
  if (isFactionNameFree(stem, exceptId)) return stem;
  let n = 2;
  while (!isFactionNameFree(`${stem} ${n}`, exceptId)) n++;
  return `${stem} ${n}`;
}

export function findFactionByCode(code){
  const id = formatFactionCode(code);
  return id ? getFaction(id) : null;
}

export function findFactionNameByCode(code){
  const rec = findFactionByCode(code);
  return rec ? rec.name : null;
}

export function retargetFactionName(id, newName){
  const rec = getFaction(id);
  if (!rec || !newName || rec.name === newName) return;
  rec.name = newName;
}

export function applyFactionIdRemap(remap){
  if (!remap || remap.size === 0) return;
  const mapId = id => {
    if (!id) return id;
    return remap.has(id) ? remap.get(id) : id;
  };
  for (const hex of state.hexes.values()){
    hex.ownerFactionId = mapId(hex.ownerFactionId);
    hex.loyaltyFactionId = mapId(hex.loyaltyFactionId);
    hex.controllerFactionId = mapId(hex.controllerFactionId);
    for (const b of hex.buildings || []) b.ownerFactionId = mapId(b.ownerFactionId);
    for (const u of hex.units || []) u.ownerFactionId = mapId(u.ownerFactionId);
  }
  for (const rec of state.regions.values()){
    rec.factionId = mapId(rec.factionId);
  }
  const brush = state.brush;
  brush.ownerFactionId = mapId(brush.ownerFactionId) || '';
  brush.loyaltyFactionId = mapId(brush.loyaltyFactionId) || '';
  brush.controllerFactionId = mapId(brush.controllerFactionId) || '';
  brush.buildingOwnerFactionId = mapId(brush.buildingOwnerFactionId) || '';
  brush.unitOwnerFactionId = mapId(brush.unitOwnerFactionId) || '';
}

export function pruneUnknownFactionRefs(){
  for (const hex of state.hexes.values()){
    hex.ownerFactionId = knownFactionId(hex.ownerFactionId) || null;
    hex.loyaltyFactionId = knownFactionId(hex.loyaltyFactionId) || null;
    hex.controllerFactionId = knownFactionId(hex.controllerFactionId) || null;
    for (const b of hex.buildings || []) b.ownerFactionId = knownFactionId(b.ownerFactionId) || '';
    for (const u of hex.units || []) u.ownerFactionId = knownFactionId(u.ownerFactionId) || '';
  }
  for (const rec of state.regions.values()){
    rec.factionId = knownFactionId(rec.factionId) || '';
  }
  const brush = state.brush;
  if (!knownFactionId(brush.ownerFactionId)) brush.ownerFactionId = '';
  if (!knownFactionId(brush.loyaltyFactionId)) brush.loyaltyFactionId = '';
  if (!knownFactionId(brush.controllerFactionId)) brush.controllerFactionId = '';
  if (!knownFactionId(brush.buildingOwnerFactionId)) brush.buildingOwnerFactionId = '';
  if (!knownFactionId(brush.unitOwnerFactionId)) brush.unitOwnerFactionId = '';
}

export function retargetFactionId(oldId, newId){
  if (!oldId || !newId || oldId === newId) return true;
  if (state.factions.has(newId)) return false;
  const rec = state.factions.get(oldId);
  if (!rec) return false;
  state.factions.delete(oldId);
  rec.id = newId;
  rec.code = newId;
  state.factions.set(newId, rec);
  applyFactionIdRemap(new Map([[oldId, newId]]));
  invalidateFactionCache();
  return true;
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
    factionId: rec.factionId
  };
}

export function makeRegion(raw = {}){
  const id = Number(raw.id);
  return {
    id: Number.isFinite(id) && id > 0 ? id : state.nextRegionId++,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'New Region',
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'Province',
    governor: typeof raw.governor === 'string' ? raw.governor.trim() : '',
    factionId: typeof raw.factionId === 'string' ? raw.factionId.trim() : ''
  };
}

export function snapshotRegions(){
  return {
    nextId: state.nextRegionId,
    list: Array.from(state.regions.values()).map(cloneRegion)
  };
}

export function restoreRegions(snap, remap){
  if (snap == null) return;
  state.regions.clear();
  const list = Array.isArray(snap) ? snap : (snap.list || []);
  let maxId = 0;
  for (const raw of list){
    const rec = makeRegion(raw);
    if (remap && rec.factionId && remap.has(rec.factionId)) rec.factionId = remap.get(rec.factionId);
    rec.factionId = knownFactionId(rec.factionId) || '';
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

export function uniqueRegionName(base, factionId){
  const stem = (base || 'New Region').trim() || 'New Region';
  const taken = name => {
    const needle = name.toLowerCase();
    for (const rec of state.regions.values()){
      if (rec.factionId === factionId && rec.name.toLowerCase() === needle) return true;
    }
    return false;
  };
  if (!taken(stem)) return stem;
  let n = 2;
  while (taken(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export function createRegion(factionId, raw = {}){
  if (!knownFactionId(factionId)) return null;
  const rec = makeRegion({
    ...raw,
    id: state.nextRegionId++,
    factionId,
    name: uniqueRegionName(raw.name || 'New Region', factionId)
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

export function regionsForFaction(factionId){
  const out = [];
  for (const rec of state.regions.values()){
    if (rec.factionId === factionId) out.push(rec);
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

export function stripRegionsOfFaction(factionId){
  const ids = [];
  for (const rec of state.regions.values()){
    if (rec.factionId === factionId) ids.push(rec.id);
  }
  for (const id of ids) deleteRegionById(id);
}

export function stripFactionEntityRefs(factionId){
  if (!factionId) return;
  for (const hex of state.hexes.values()){
    const hit =
      hex.ownerFactionId === factionId ||
      hex.loyaltyFactionId === factionId ||
      hex.controllerFactionId === factionId ||
      (hex.buildings || []).some(b => b.ownerFactionId === factionId) ||
      (hex.units || []).some(u => u.ownerFactionId === factionId);
    if (!hit) continue;
    markHexForUndo(hex);
    if (hex.ownerFactionId === factionId){
      hex.ownerFactionId = null;
      hex.region = null;
    }
    if (hex.loyaltyFactionId === factionId) hex.loyaltyFactionId = null;
    if (hex.controllerFactionId === factionId) hex.controllerFactionId = null;
    for (const b of hex.buildings || []){
      if (b.ownerFactionId === factionId) b.ownerFactionId = '';
    }
    for (const u of hex.units || []){
      if (u.ownerFactionId === factionId) u.ownerFactionId = '';
    }
  }
  if (state.brush.ownerFactionId === factionId) state.brush.ownerFactionId = '';
  if (state.brush.loyaltyFactionId === factionId) state.brush.loyaltyFactionId = '';
  if (state.brush.controllerFactionId === factionId) state.brush.controllerFactionId = '';
  if (state.brush.buildingOwnerFactionId === factionId) state.brush.buildingOwnerFactionId = '';
  if (state.brush.unitOwnerFactionId === factionId) state.brush.unitOwnerFactionId = '';
}

/* A capital is optional and independent of ownership: a landless faction may
   still point at the hex it claims as its seat. */
export function getFactionCapitalHex(id){
  const rec = getFaction(id);
  if (!rec || !rec.capital) return null;
  if (!Number.isFinite(Number(rec.capital.q)) || !Number.isFinite(Number(rec.capital.r))) return null;
  return state.hexes.get(`${rec.capital.q},${rec.capital.r}`) || null;
}

export function factionsWithCapitalAt(hex){
  if (!hex) return [];
  const ids = getCapitalIndex().get(`${hex.q},${hex.r}`) || [];
  return ids.map(id => factionName(id)).filter(Boolean);
}

export function hexIsCapital(hex){
  return factionsWithCapitalAt(hex).length > 0;
}

export function setFactionCapital(id, hex){
  const rec = getFaction(id);
  if (!rec) return;
  rec.capital = hex
    ? { q: hex.q, r: hex.r, ...(rec.capital && rec.capital.name ? { name: rec.capital.name } : {}) }
    : (rec.capital && rec.capital.name ? { name: rec.capital.name } : null);
  invalidateFactionCache();
}

export function syncFactionCapitals(){
  for (const rec of state.factions.values()){
    if (!rec.capital) continue;
    if (!Number.isFinite(Number(rec.capital.q)) || !Number.isFinite(Number(rec.capital.r))) continue;
    if (!state.hexes.has(`${rec.capital.q},${rec.capital.r}`)){
      rec.capital = rec.capital.name ? { name: rec.capital.name } : null;
    }
  }
  invalidateFactionCache();
}

export const TOOL_DEFS = [
  {
    id: 'terrain',
    label: 'Terrain',
    kind: 'paint',
    number: '1',
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
    number: '2',
    shortcut: '2',
    hint: '<div><b>Left</b> drag — paint faction territory</div>',
    previewFill: 'rgba(201, 162, 77, 0.28)',
    apply(hex){
      const nextOwner = knownFactionId(state.brush.ownerFactionId);
      if (hex.ownerFactionId !== nextOwner){
        invalidateFactionCache();
        hex.region = null;
      }
      hex.ownerFactionId = nextOwner;
      if (state.prefAllowOceanElevPop || !isWaterHex(hex)){
        hex.loyaltyFactionId = nextOwner;
        hex.controllerFactionId = nextOwner;
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
    id: 'population',
    label: 'Population',
    kind: 'paint',
    number: '3',
    shortcut: '3',
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
    id: 'building',
    label: 'Buildings',
    kind: 'stamp',
    number: '4',
    shortcut: '4',
    hint: '<div><b>Left</b> click — stamp a building instance</div><div>Owner is independent of tile faction and de facto control</div>',
    apply(hex){
      stampBuildingOnHex(hex);
    }
  },
  {
    id: 'unit',
    label: 'Units',
    kind: 'stamp',
    number: '5',
    shortcut: '5',
    hint: '<div><b>Left</b> click — stamp a unit onto the hex</div><div>Owner is independent of tile faction, de facto control, and buildings</div>',
    apply(hex){
      stampUnitOnHex(hex);
    }
  },
  {
    id: 'label',
    label: 'City / Region Label',
    kind: 'stamp',
    number: '6',
    shortcut: '6',
    hint: '<div><b>Left</b> click — apply label</div>',
    apply(hex){
      applyCityLabelToHex(hex);
    }
  },
  {
    id: 'path',
    label: 'Routes',
    kind: 'path',
    number: '7',
    shortcut: '7',
    hint: '<div><b>Click</b> — start or finish path</div><div><b>Shift+Click</b> — add waypoint</div><div><b>Click end</b> — extend path</div><div><b>Esc</b> — cancel</div>'
  },
  {
    id: 'elevation',
    label: 'Elevation',
    kind: 'paint',
    number: '8',
    shortcut: '8',
    hint: '<div><b>Left</b> drag — paint elevation</div>',
    previewFill: 'rgba(40, 40, 40, 0.28)',
    apply(hex){
      hex.elevation = state.brush.elevation;
    }
  },
  {
    id: 'culture',
    label: 'Culture',
    kind: 'paint',
    number: '9',
    shortcut: '9',
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
    id: 'loyalty',
    label: 'Loyalty',
    kind: 'paint',
    number: '0',
    shortcut: '0',
    hint: '<div><b>Left</b> drag — paint loyalty</div>',
    previewFill: 'rgba(138, 144, 152, 0.28)',
    apply(hex){
      hex.loyaltyFactionId = knownFactionId(state.brush.loyaltyFactionId);
    },
    afterStroke(){
      hooks.refreshLoyaltyList();
    }
  },
  {
    id: 'controller',
    label: 'De Facto',
    kind: 'paint',
    number: 'D',
    shortcut: 'd',
    hint: '<div><b>Left</b> drag — paint de facto control</div>',
    previewFill: 'rgba(196, 92, 54, 0.28)',
    apply(hex){
      hex.controllerFactionId = knownFactionId(state.brush.controllerFactionId);
    },
    afterStroke(){
      hooks.refreshControllerList();
    }
  },
  {
    id: 'region',
    label: 'Region',
    kind: 'paint',
    number: 'R',
    shortcut: 'r',
    hint: '<div><b>Left</b> drag — paint administrative region</div>',
    previewFill: 'rgba(232, 214, 160, 0.28)',
    apply(hex){
      const rec = getRegion(state.brush.regionId);
      if (!rec){
        hex.region = null;
        return;
      }
      if (hex.ownerFactionId !== rec.factionId) return;
      hex.region = rec.id;
    },
    afterStroke(){
      hooks.refreshRegionList();
    }
  },
  {
    id: 'area',
    label: 'Area',
    kind: 'area',
    number: 'A',
    shortcut: 'a',
    hint: '<div><b>Drag</b> — select a rectangle of hexes</div><div><b>Drag inside</b> — move the selection</div><div><b>Ctrl+C / X / V</b> — copy, cut, paste</div><div><b>Delete</b> — clear the selection</div>'
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

export function slugifyBuildingId(raw){
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

export function cloneBuildingTypes(list = state.buildingTypes){
  return (list || []).map(t => ({
    building_id: t.building_id,
    name: t.name,
    icon: t.icon || 'building-2'
  }));
}

export function parseBuildingTypes(raw){
  if (!Array.isArray(raw)) return cloneBuildingTypes(DEFAULT_BUILDING_TYPES);
  const out = [];
  const seen = new Set();
  for (const t of raw){
    if (!t || typeof t !== 'object') continue;
    const building_id = slugifyBuildingId(t.building_id);
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!building_id || !name || seen.has(building_id)) continue;
    seen.add(building_id);
    out.push({
      building_id,
      name,
      icon: typeof t.icon === 'string' && t.icon ? t.icon : 'building-2'
    });
  }
  return out.length ? out : cloneBuildingTypes(DEFAULT_BUILDING_TYPES);
}

export function cloneBuildings(list){
  return (list || []).map(b => ({
    id: b.id,
    building_id: b.building_id,
    name: b.name,
    ownerFactionId: b.ownerFactionId || '',
    operational: b.operational !== false,
    customData: { ...(b.customData || {}) }
  }));
}

export function parseBuildings(raw){
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw){
    if (!b || typeof b !== 'object') continue;
    const building_id = slugifyBuildingId(b.building_id);
    if (!building_id) continue;
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : building_id;
    out.push({
      id: typeof b.id === 'string' && b.id ? b.id : `bld_${Date.now()}_${++state.nextBuildingSeq}`,
      building_id,
      name,
      ownerFactionId: typeof b.ownerFactionId === 'string' ? b.ownerFactionId.trim() : '',
      operational: b.operational !== false,
      customData: (b.customData && typeof b.customData === 'object') ? { ...b.customData } : {}
    });
  }
  return out;
}

export function hexBuildings(hex){
  if (!hex.buildings) hex.buildings = [];
  return hex.buildings;
}

export function getBuildingType(id){
  return state.buildingTypes.find(t => t.building_id === id) || null;
}

export function upsertBuildingType(building_id, name, icon){
  const id = slugifyBuildingId(building_id);
  const label = (name || '').trim();
  if (!id || !label) return null;
  const existing = getBuildingType(id);
  if (existing){
    existing.name = label;
    if (icon) existing.icon = icon;
    return existing;
  }
  const rec = { building_id: id, name: label, icon: icon || 'building-2' };
  state.buildingTypes.push(rec);
  return rec;
}

export function stampBuildingOnHex(hex){
  const type = getBuildingType(state.brush.buildingTypeId);
  if (!hex || !type) return;
  const customName = (state.brush.buildingName || '').trim();
  hexBuildings(hex).push({
    id: `bld_${Date.now()}_${++state.nextBuildingSeq}`,
    building_id: type.building_id,
    name: customName || type.name,
    ownerFactionId: knownFactionId(state.brush.buildingOwnerFactionId) || '',
    operational: true,
    customData: {}
  });
}

export function renameBuildingOnHex(hex, buildingId, nextName){
  const name = (nextName || '').trim();
  if (!hex || !name) return false;
  const rec = hexBuildings(hex).find(b => b.id === buildingId);
  if (!rec || rec.name === name) return false;
  beginAction();
  markHexForUndo(hex);
  rec.name = name;
  commitAction();
  return true;
}

export function deleteBuildingOnHex(hex, buildingId){
  if (!hex) return false;
  const buildings = hexBuildings(hex);
  const idx = buildings.findIndex(b => b.id === buildingId);
  if (idx < 0) return false;
  beginAction();
  markHexForUndo(hex);
  buildings.splice(idx, 1);
  commitAction();
  return true;
}

export function toggleBuildingOperational(hex, buildingId){
  if (!hex) return false;
  const rec = hexBuildings(hex).find(b => b.id === buildingId);
  if (!rec) return false;
  beginAction();
  markHexForUndo(hex);
  rec.operational = rec.operational === false;
  commitAction();
  return true;
}

export function buildingOwnerColor(factionId){
  const rec = getFaction(factionId);
  return rec ? rec.color : '#8a9098';
}

export function formatBuildingHoverLine(b){
  const type = getBuildingType(b.building_id);
  const typeName = type ? type.name : b.building_id;
  const rec = getFaction(b.ownerFactionId);
  const code = rec ? rec.id : '—';
  return `[${code}] ${b.name} (${typeName})`;
}

export function makeUnitId(){
  return 'unit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
}

export function cloneUnits(list){
  return (list || []).map(u => ({
    id: u.id,
    name: u.name,
    ownerFactionId: u.ownerFactionId || '',
    personnel: u.personnel,
    notes: u.notes || '',
    customData: { ...(u.customData || {}) }
  }));
}

export function parseUnits(raw){
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const u of raw){
    if (!u || typeof u !== 'object') continue;
    const name = typeof u.name === 'string' && u.name.trim() ? u.name.trim() : 'Unit';
    const personnel = Math.max(1, Math.round(Number(u.personnel)) || 1000);
    out.push({
      id: typeof u.id === 'string' && u.id ? u.id : makeUnitId(),
      name,
      ownerFactionId: typeof u.ownerFactionId === 'string' ? u.ownerFactionId.trim() : '',
      personnel,
      notes: typeof u.notes === 'string' ? u.notes : '',
      customData: (u.customData && typeof u.customData === 'object') ? { ...u.customData } : {}
    });
  }
  return out;
}

export function hexUnits(hex){
  if (!hex.units) hex.units = [];
  return hex.units;
}

export function stampUnitOnHex(hex){
  if (!hex) return;
  const customName = (state.brush.unitName || '').trim();
  const personnel = Math.max(1, Math.round(Number(state.brush.unitPersonnel)) || 1000);
  hexUnits(hex).push({
    id: makeUnitId(),
    name: customName || '1st Division',
    ownerFactionId: knownFactionId(state.brush.unitOwnerFactionId) || '',
    personnel,
    notes: (state.brush.unitNotes || '').trim(),
    customData: {}
  });
}

export function renameUnitOnHex(hex, unitId, nextName){
  const name = (nextName || '').trim();
  if (!hex || !name) return false;
  const rec = hexUnits(hex).find(u => u.id === unitId);
  if (!rec || rec.name === name) return false;
  beginAction();
  markHexForUndo(hex);
  rec.name = name;
  commitAction();
  return true;
}

export function setUnitPersonnelOnHex(hex, unitId, nextPersonnel){
  const personnel = Math.max(1, Math.round(Number(nextPersonnel)) || 0);
  if (!hex || !Number.isFinite(personnel)) return false;
  const rec = hexUnits(hex).find(u => u.id === unitId);
  if (!rec || rec.personnel === personnel) return false;
  beginAction();
  markHexForUndo(hex);
  rec.personnel = personnel;
  commitAction();
  return true;
}

export function deleteUnitOnHex(hex, unitId){
  if (!hex) return false;
  const units = hexUnits(hex);
  const idx = units.findIndex(u => u.id === unitId);
  if (idx < 0) return false;
  beginAction();
  markHexForUndo(hex);
  units.splice(idx, 1);
  commitAction();
  return true;
}

export function formatPersonnel(n){
  return Number(n).toLocaleString('en-US');
}

export function formatUnitHoverLine(u){
  const rec = getFaction(u.ownerFactionId);
  const code = rec ? rec.id : '—';
  return `[${code}] ${u.name} (${formatPersonnel(u.personnel)} men)`;
}

export function cloneHex(h){
  return {
    q: h.q,
    r: h.r,
    x: h.x,
    y: h.y,
    terrain: h.terrain,
    elevation: h.elevation || 'flat',
    population: h.population,
    ownerFactionId: h.ownerFactionId || null,
    loyaltyFactionId: h.loyaltyFactionId || null,
    controllerFactionId: h.controllerFactionId || null,
    region: h.region || null,
    culture: h.culture || null,
    cityName: h.cityName || null,
    customData: { ...(h.customData || {}) },
    buildings: cloneBuildings(h.buildings),
    units: cloneUnits(h.units)
  };
}

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

export function routeKindOf(style){
  return (ROUTE_BY_ID[style] || {}).kind || null;
}

export function routeUsesMouths(style){
  const kind = routeKindOf(style);
  return kind === 'river' || kind === 'channel';
}

/* A path may never cover a hex twice. Paths of the same kind may touch only at
   single hexes — junctions and crossings. Sharing two hexes in a row with another
   path of the same kind is rejected. Different kinds (road, river, channel) may
   share any number of tiles. */
export function validatePath(waypoints, excludeRouteId, styleId){
  const cells = expandWaypoints(waypoints);
  const blocked = new Set();
  if (cells.length < 2) return { ok: true, cells, blocked };

  const seen = new Set();
  for (const cell of cells){
    const key = `${cell.q},${cell.r}`;
    if (seen.has(key)) blocked.add(key);
    seen.add(key);
  }

  const style = styleId
    || (excludeRouteId != null ? (state.routes.find(r => r.id === excludeRouteId) || {}).style : null)
    || state.brush.routeStyle;
  const kind = routeKindOf(style);
  const idsPerCell = cells.map(c => routeIdsAtKey(`${c.q},${c.r}`).filter(id => {
    if (id === excludeRouteId) return false;
    const other = state.routes.find(r => r.id === id);
    return other && routeKindOf(other.style) === kind;
  }));
  for (let i = 0; i < cells.length - 1; i++){
    const overlapsSameKind = idsPerCell[i].some(id => idsPerCell[i + 1].includes(id));
    if (overlapsSameKind){
      blocked.add(`${cells[i].q},${cells[i].r}`);
      blocked.add(`${cells[i + 1].q},${cells[i + 1].r}`);
    }
  }

  return { ok: blocked.size === 0, cells, blocked };
}

export function snapshotState(){
  return {
    hexes: Array.from(state.hexes.values()).map(cloneHex),
    mapCols: state.mapCols,
    mapRows: state.mapRows,
    factions: snapshotFactions(),
    cultures: snapshotCultures(),
    regions: snapshotRegions(),
    routes: cloneRoutes(),
    buildingTypes: cloneBuildingTypes(),
    nextBuildingSeq: state.nextBuildingSeq
  };
}

export function applyFullState(full){
  state.hexes.clear();
  full.hexes.forEach(h => state.hexes.set(`${h.q},${h.r}`, cloneHex(h)));
  state.mapCols = full.mapCols; state.mapRows = full.mapRows;
  document.getElementById('mapCols').value = state.mapCols;
  document.getElementById('mapRows').value = state.mapRows;
  const remap = restoreFactions(full.factions);
  restoreCultures(full.cultures);
  restoreRegions(full.regions || { nextId: 1, list: [] }, remap);
  applyFactionIdRemap(remap);
  pruneUnknownFactionRefs();
  restoreRoutes(full.routes);
  resetAreaInteraction(true);
  state.buildingTypes = parseBuildingTypes(full.buildingTypes);
  if (Number.isFinite(full.nextBuildingSeq)) state.nextBuildingSeq = full.nextBuildingSeq;
  if (!state.buildingTypes.some(t => t.building_id === state.brush.buildingTypeId)){
    state.brush.buildingTypeId = state.buildingTypes[0] ? state.buildingTypes[0].building_id : '';
  }
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
  hooks.refreshStatistics();
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
    const remap = restoreFactions(action.factionsBefore);
    restoreCultures(action.culturesBefore);
    restoreRegions(action.regionsBefore, remap);
    applyFactionIdRemap(remap);
    pruneUnknownFactionRefs();
  } else if (action.type === 'routes') {
    state.redoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.before);
  }

  reresolveSelection();
  invalidatePopulationStats();
  hooks.render();
  hooks.updateInspector(state.hoveredHex);
  hooks.refreshFactionList();
  hooks.refreshLoyaltyList();
  hooks.refreshControllerList();
  hooks.refreshCultureList();
  hooks.refreshRegionList();
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
  updateHistoryButtons();
  hooks.refreshBuildingUi();
  hooks.refreshStatistics();
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
    const remap = restoreFactions(action.factionsAfter);
    restoreCultures(action.culturesAfter);
    restoreRegions(action.regionsAfter, remap);
    applyFactionIdRemap(remap);
    pruneUnknownFactionRefs();
  } else if (action.type === 'routes') {
    state.undoStack.push({ type: 'routes', before: cloneRoutes(action.before), after: cloneRoutes(action.after) });
    restoreRoutes(action.after);
  }

  reresolveSelection();
  invalidatePopulationStats();
  hooks.render();
  hooks.updateInspector(state.hoveredHex);
  hooks.refreshFactionList();
  hooks.refreshLoyaltyList();
  hooks.refreshControllerList();
  hooks.refreshCultureList();
  hooks.refreshRegionList();
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
  updateHistoryButtons();
  hooks.refreshBuildingUi();
  hooks.refreshStatistics();
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
  resetAreaInteraction(true);
  invalidateRouteIndex();
  invalidatePopulationStats();
  for (let row = 0; row < rows; row++){
    for (let col = 0; col < cols; col++){
      const { q, r } = offsetToAxial(col, row);
      const coords = axialToPixel(q, r, HEX_SIZE);
      state.hexes.set(`${q},${r}`, {
        q, r, x: coords.x, y: coords.y, terrain: 'ocean', elevation: 'flat', population: 0,
        ownerFactionId: null, loyaltyFactionId: null, controllerFactionId: null, region: null,
        culture: null, cityName: null, customData: {}, buildings: [], units: []
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

function hexPop(hex){
  return Math.max(0, Number(hex && hex.population) || 0);
}

function emptyStatBucket(){
  return {
    hexes: 0,
    population: 0,
    landHexes: 0,
    inhabitedHexes: 0,
    buildings: 0,
    units: 0,
    ownControlHexes: 0,
    occupiedHexes: 0,
    occupiedPop: 0,
    foreignControlHexes: 0,
    foreignControlPop: 0,
    loyalOwnPop: 0,
    loyalOtherPop: 0,
    loyalNonePop: 0,
    cultures: new Map(),
    unpaintedCulturePop: 0,
    regions: new Map()
  };
}

function addCulturePop(map, name, pop){
  if (!name) return;
  map.set(name, (map.get(name) || 0) + Math.max(0, pop));
}

function sortedShareList(map, total){
  return Array.from(map.entries())
    .filter(([, pop]) => pop > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, pop]) => ({
      key,
      pop,
      share: total > 0 ? pop / total : 0
    }));
}

function cultureDiversityLabel(entries, culturedPop){
  if (!entries.length || culturedPop <= 0) return '';
  if (entries.length === 1) return 'Homogeneous';
  let hhi = 0;
  for (const row of entries){
    const p = row.pop / culturedPop;
    hhi += p * p;
  }
  const diversity = 1 - hhi;
  if (diversity < 0.15) return 'Very low diversity';
  if (diversity < 0.35) return 'Low diversity';
  if (diversity < 0.55) return 'Moderate diversity';
  if (diversity < 0.75) return 'High diversity';
  return 'Very high diversity';
}

function cultureSummary(bucket, scopePop){
  const list = sortedShareList(bucket.cultures, scopePop);
  const culturedPop = list.reduce((sum, row) => sum + row.pop, 0);
  const largest = list[0] || null;
  return {
    list,
    culturedPop,
    unpaintedPop: bucket.unpaintedCulturePop,
    present: bucket.cultures.size,
    largest: largest ? { name: largest.key, pop: largest.pop, share: largest.share } : null,
    diversity: cultureDiversityLabel(list, culturedPop)
  };
}

function finishFactionStats(id, bucket, worldPop){
  const rec = getFaction(id);
  const population = bucket.population;
  const territory = bucket.hexes;
  return {
    id,
    name: rec ? rec.name : '',
    color: rec ? rec.color : '',
    flag: rec ? rec.flag : null,
    population,
    worldShare: worldPop > 0 ? population / worldPop : 0,
    territoryHexes: territory,
    controlledTerritoryHexes: bucket.ownControlHexes,
    ownControlShare: territory > 0 ? bucket.ownControlHexes / territory : 0,
    occupiedHexes: bucket.occupiedHexes,
    occupiedPop: bucket.occupiedPop,
    foreignControlHexes: bucket.foreignControlHexes,
    foreignControlPop: bucket.foreignControlPop,
    administrativeRegions: bucket.regions.size,
    popPerHex: territory > 0 ? population / territory : 0,
    buildings: bucket.buildings,
    units: bucket.units,
    cultures: cultureSummary(bucket, population),
    cohesion: {
      loyalOwn: bucket.loyalOwnPop,
      loyalOwnShare: population > 0 ? bucket.loyalOwnPop / population : 0,
      loyalOther: bucket.loyalOtherPop,
      loyalOtherShare: population > 0 ? bucket.loyalOtherPop / population : 0,
      none: bucket.loyalNonePop,
      noneShare: population > 0 ? bucket.loyalNonePop / population : 0
    },
    regions: sortedShareList(bucket.regions, population).map(row => {
      const region = getRegion(row.key);
      return {
        id: row.key,
        name: region ? region.name : '',
        pop: row.pop,
        share: row.share
      };
    }).filter(row => row.name)
  };
}

/* Live totals from current hexes. Nothing here is written back into the map file. */
export function computeMapStatistics(){
  const world = emptyStatBucket();
  const factionPops = new Map();
  const buckets = new Map();
  for (const rec of state.factions.values()){
    buckets.set(rec.id, emptyStatBucket());
    factionPops.set(rec.id, 0);
  }

  for (const hex of state.hexes.values()){
    const buildings = hex.buildings || [];
    const units = hex.units || [];
    const owner = hex.ownerFactionId || null;
    const controller = hex.controllerFactionId || null;
    const loyalty = hex.loyaltyFactionId || null;

    world.buildings += buildings.length;
    world.units += units.length;
    for (const b of buildings){
      const fid = knownFactionId(b.ownerFactionId);
      const owned = fid ? buckets.get(fid) : null;
      if (owned) owned.buildings += 1;
    }
    for (const u of units){
      const fid = knownFactionId(u.ownerFactionId);
      const owned = fid ? buckets.get(fid) : null;
      if (owned) owned.units += 1;
    }

    if (isWaterHex(hex)) continue;

    const pop = hexPop(hex);

    world.hexes += 1;
    world.population += pop;
    world.landHexes += 1;
    if (pop > 0) world.inhabitedHexes += 1;
    if (hex.culture) addCulturePop(world.cultures, hex.culture, pop);
    else world.unpaintedCulturePop += pop;
    if (owner && factionPops.has(owner)) factionPops.set(owner, factionPops.get(owner) + pop);

    const bucket = owner ? buckets.get(owner) : null;
    if (bucket){
      bucket.hexes += 1;
      bucket.population += pop;
      bucket.landHexes += 1;
      if (pop > 0) bucket.inhabitedHexes += 1;
      if (controller === owner) bucket.ownControlHexes += 1;
      else if (controller){
        bucket.occupiedHexes += 1;
        bucket.occupiedPop += pop;
      }
      if (loyalty === owner) bucket.loyalOwnPop += pop;
      else if (loyalty) bucket.loyalOtherPop += pop;
      else bucket.loyalNonePop += pop;
      if (hex.culture) addCulturePop(bucket.cultures, hex.culture, pop);
      else bucket.unpaintedCulturePop += pop;
      const region = hexRegion(hex);
      if (region) bucket.regions.set(region.id, (bucket.regions.get(region.id) || 0) + pop);
    }

    if (controller && controller !== owner){
      const foreign = buckets.get(controller);
      if (foreign){
        foreign.foreignControlHexes += 1;
        foreign.foreignControlPop += pop;
      }
    }
  }

  const worldPop = world.population;
  const factionList = Array.from(state.factions.values()).map(rec => {
    const pop = factionPops.get(rec.id) || 0;
    return {
      id: rec.id,
      name: rec.name,
      pop,
      share: worldPop > 0 ? pop / worldPop : 0
    };
  }).sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name));

  const factions = {};
  for (const rec of state.factions.values()){
    factions[rec.id] = finishFactionStats(rec.id, buckets.get(rec.id), worldPop);
  }

  return {
    world: {
      population: worldPop,
      hexes: world.hexes,
      landHexes: world.landHexes,
      inhabitedHexes: world.inhabitedHexes,
      buildings: world.buildings,
      units: world.units,
      cultures: cultureSummary(world, worldPop),
      factions: factionList
    },
    factions
  };
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
  if (!def || !routeUsesMouths(route.style)) return [];
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
  if (def && routeUsesMouths(styleId) && expanded.length >= 2 && runs.length > 0){
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
    alert(`Another route is already called "${name}".`);
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
  if (!validatePath(next, routeId, state.routes[idx].style).ok) return false;
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
  if (!validatePath(next, routeId, state.routes[idx].style).ok) return false;
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
  if (!validatePath(next, routeId, state.routes[idx].style).ok) return false;
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
  if (!validatePath(candidate, state.pathDraft.routeId, state.pathDraft.style).ok) return;

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
   7b. AREA SELECTION
   ---------------------------------------------------------------------------- */
export function resetAreaInteraction(keepClipboard){
  state.areaRect = null;
  state.areaDrag = null;
  state.areaMode = 'idle';
  if (!keepClipboard) state.areaClipboard = null;
  hooks.refreshAreaUi();
}

export function cancelAreaTool(){
  state.areaDrag = null;
  state.areaRect = null;
  state.areaMode = 'idle';
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
}

export function areaRectSize(rect){
  if (!rect) return { cols: 0, rows: 0 };
  return {
    cols: rect.maxCol - rect.minCol + 1,
    rows: rect.maxRow - rect.minRow + 1
  };
}

export function areaRectFromCorners(c1, r1, c2, r2){
  const minCol = Math.max(0, Math.min(c1, c2));
  const maxCol = Math.min(state.mapCols - 1, Math.max(c1, c2));
  const minRow = Math.max(0, Math.min(r1, r2));
  const maxRow = Math.min(state.mapRows - 1, Math.max(r1, r2));
  if (minCol > maxCol || minRow > maxRow) return null;
  return { minCol, maxCol, minRow, maxRow };
}

export function hexInAreaRect(hex, rect){
  if (!hex || !rect) return false;
  const off = axialToOffset(hex.q, hex.r);
  return off.col >= rect.minCol && off.col <= rect.maxCol && off.row >= rect.minRow && off.row <= rect.maxRow;
}

export function getLiveAreaRect(){
  if (state.areaDrag && state.areaDrag.kind === 'select'){
    return areaRectFromCorners(state.areaDrag.startCol, state.areaDrag.startRow, state.areaDrag.endCol, state.areaDrag.endRow);
  }
  return state.areaRect;
}

export function getAreaPreviewRect(){
  if (state.areaDrag && state.areaDrag.kind === 'move' && state.areaRect){
    const dCol = state.areaDrag.destCol - state.areaDrag.originCol;
    const dRow = state.areaDrag.destRow - state.areaDrag.originRow;
    const size = areaRectSize(state.areaRect);
    return areaRectFromCorners(
      state.areaRect.minCol + dCol,
      state.areaRect.minRow + dRow,
      state.areaRect.minCol + dCol + size.cols - 1,
      state.areaRect.minRow + dRow + size.rows - 1
    );
  }
  if ((state.areaMode === 'paste' || state.areaMode === 'move') && state.hoveredHex){
    const off = axialToOffset(state.hoveredHex.q, state.hoveredHex.r);
    let cols = 0, rows = 0;
    if (state.areaMode === 'paste' && state.areaClipboard){
      cols = state.areaClipboard.cols;
      rows = state.areaClipboard.rows;
    } else if (state.areaMode === 'move' && state.areaRect){
      const size = areaRectSize(state.areaRect);
      cols = size.cols;
      rows = size.rows;
    }
    if (cols < 1 || rows < 1) return null;
    return areaRectFromCorners(off.col, off.row, off.col + cols - 1, off.row + rows - 1);
  }
  return null;
}

function forEachHexInRect(rect, fn){
  if (!rect) return;
  for (let row = rect.minRow; row <= rect.maxRow; row++){
    for (let col = rect.minCol; col <= rect.maxCol; col++){
      const { q, r } = offsetToAxial(col, row);
      const hex = state.hexes.get(`${q},${r}`);
      if (hex) fn(hex, col, row);
    }
  }
}

function resetHexToEmpty(hex){
  hex.terrain = 'ocean';
  hex.elevation = 'flat';
  hex.population = 0;
  hex.ownerFactionId = null;
  hex.loyaltyFactionId = null;
  hex.controllerFactionId = null;
  hex.region = null;
  hex.culture = null;
  hex.cityName = null;
  hex.customData = {};
  hex.buildings = [];
  hex.units = [];
}

function hexPayload(hex){
  const cloned = cloneHex(hex);
  delete cloned.q;
  delete cloned.r;
  delete cloned.x;
  delete cloned.y;
  return cloned;
}

function applyHexPayload(dest, src){
  dest.terrain = src.terrain;
  dest.elevation = src.elevation || 'flat';
  dest.population = Number(src.population) || 0;
  dest.ownerFactionId = src.ownerFactionId || null;
  dest.loyaltyFactionId = src.loyaltyFactionId || null;
  dest.controllerFactionId = src.controllerFactionId || null;
  dest.region = src.region || null;
  dest.culture = src.culture || null;
  dest.cityName = src.cityName || null;
  dest.customData = { ...(src.customData || {}) };
  dest.buildings = cloneBuildings(src.buildings);
  dest.units = cloneUnits(src.units);
  for (const b of dest.buildings) b.id = `bld_${Date.now()}_${++state.nextBuildingSeq}`;
  for (const u of dest.units) u.id = makeUnitId();
  const regionRec = dest.region ? getRegion(dest.region) : null;
  if (!regionRec || !dest.ownerFactionId || dest.ownerFactionId !== regionRec.factionId) dest.region = null;
}

function clipRouteByCellPredicate(route, keepFn){
  const cells = routeCells(route);
  const runs = [];
  let run = [];
  for (const cell of cells){
    if (keepFn(cell)){
      run.push({ q: cell.q, r: cell.r });
    } else if (run.length){
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function replaceRoutes(next){
  state.routes.length = 0;
  for (const r of next) state.routes.push(r);
  invalidateRouteIndex();
}

function rewriteRoutesKeepOutside(rect){
  const next = [];
  for (const route of state.routes){
    const runs = clipRouteByCellPredicate(route, cell => !hexInAreaRect(cell, rect));
    if (!runs.length) continue;
    next.push(makeRoute(route.id, route.style, runs[0], route.name));
    for (let i = 1; i < runs.length; i++){
      next.push(makeRoute(state.nextRouteId++, route.style, runs[i]));
    }
  }
  replaceRoutes(next);
}

function stripCapitalsInRect(rect){
  for (const rec of state.factions.values()){
    if (!rec.capital || !Number.isFinite(Number(rec.capital.q))) continue;
    if (hexInAreaRect(rec.capital, rect)) setFactionCapital(rec.id, null);
  }
}

function captureAreaClipboard(rect, { includeCapitals }){
  const size = areaRectSize(rect);
  const hexes = [];
  forEachHexInRect(rect, (hex, col, row) => {
    hexes.push({
      col: col - rect.minCol,
      row: row - rect.minRow,
      data: hexPayload(hex)
    });
  });
  const routes = [];
  for (const route of state.routes){
    const runs = clipRouteByCellPredicate(route, cell => hexInAreaRect(cell, rect));
    for (const run of runs){
      routes.push({
        style: route.style,
        name: route.name,
        waypoints: run.map(cell => {
          const off = axialToOffset(cell.q, cell.r);
          return { col: off.col - rect.minCol, row: off.row - rect.minRow };
        })
      });
    }
  }
  const capitals = [];
  if (includeCapitals){
    for (const rec of state.factions.values()){
      if (!rec.capital || !Number.isFinite(Number(rec.capital.q))) continue;
      if (!hexInAreaRect(rec.capital, rect)) continue;
      const off = axialToOffset(rec.capital.q, rec.capital.r);
      capitals.push({
        id: rec.id,
        col: off.col - rect.minCol,
        row: off.row - rect.minRow
      });
    }
  }
  return { cols: size.cols, rows: size.rows, hexes, routes, capitals };
}

function applyClipboard(clip, destCol, destRow, { moveCapitals }){
  if (!clip) return;
  for (const cell of clip.hexes){
    const { q, r } = offsetToAxial(destCol + cell.col, destRow + cell.row);
    const hex = state.hexes.get(`${q},${r}`);
    if (hex) applyHexPayload(hex, cell.data);
  }
  for (const route of clip.routes){
    const runs = [];
    let run = [];
    for (const w of route.waypoints){
      const { q, r } = offsetToAxial(destCol + w.col, destRow + w.row);
      if (state.hexes.has(`${q},${r}`)){
        run.push({ q, r });
      } else if (run.length){
        if (run.length >= 2) runs.push(run);
        run = [];
      }
    }
    if (run.length >= 2) runs.push(run);
    for (const wps of runs){
      state.routes.push(makeRoute(state.nextRouteId++, route.style, wps));
    }
  }
  invalidateRouteIndex();
  if (moveCapitals){
    for (const cap of clip.capitals || []){
      const { q, r } = offsetToAxial(destCol + cap.col, destRow + cap.row);
      const hex = state.hexes.get(`${q},${r}`);
      if (hex) setFactionCapital(cap.id, hex);
    }
  }
}

function afterAreaMutation(){
  invalidateFactionCache();
  invalidatePopulationStats();
  invalidateRouteIndex();
  syncFactionCapitals();
  pruneUnusedCultures();
  pruneUnknownFactionRefs();
  reresolveSelection();
  updateHistoryButtons();
  throttledAutosave();
  hooks.refreshFactionList();
  hooks.refreshLoyaltyList();
  hooks.refreshControllerList();
  hooks.refreshCultureList();
  hooks.refreshRegionList();
  hooks.refreshRouteList();
  hooks.refreshSelectedHexPanel();
  hooks.refreshBuildingUi();
  hooks.refreshStatistics();
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
  hooks.refreshPathUi();
  hooks.render();
}

export function copyAreaSelection(){
  if (!state.areaRect) return;
  state.areaClipboard = captureAreaClipboard(state.areaRect, { includeCapitals: false });
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
}

export function deleteAreaSelection(opts = {}){
  if (!state.areaRect) return;
  if (!opts.silent && state.prefConfirmDeletes && !confirm('Clear every hex, route, building and unit inside the selection?')) return;
  pushFullStateUndo();
  forEachHexInRect(state.areaRect, hex => resetHexToEmpty(hex));
  rewriteRoutesKeepOutside(state.areaRect);
  stripCapitalsInRect(state.areaRect);
  afterAreaMutation();
}

export function cutAreaSelection(){
  if (!state.areaRect) return;
  if (state.prefConfirmDeletes && !confirm('Cut every hex, route, building and unit inside the selection?')) return;
  state.areaClipboard = captureAreaClipboard(state.areaRect, { includeCapitals: true });
  deleteAreaSelection({ silent: true });
}

export function beginAreaPaste(){
  if (!state.areaClipboard) return;
  state.areaMode = 'paste';
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
  hooks.render();
}

export function beginAreaMove(){
  if (!state.areaRect) return;
  state.areaMode = 'move';
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
  hooks.render();
}

function pasteAt(destCol, destRow, clip, { moveCapitals }){
  if (!clip) return;
  pushFullStateUndo();
  applyClipboard(clip, destCol, destRow, { moveCapitals });
  state.areaRect = areaRectFromCorners(destCol, destRow, destCol + clip.cols - 1, destRow + clip.rows - 1);
  state.areaMode = 'idle';
  afterAreaMutation();
}

export function pasteAreaClipboard(destCol, destRow){
  if (!state.areaClipboard) return;
  pasteAt(destCol, destRow, state.areaClipboard, { moveCapitals: (state.areaClipboard.capitals || []).length > 0 });
}

export function moveAreaByDelta(dCol, dRow){
  if (!state.areaRect || (dCol === 0 && dRow === 0)) return;
  const clip = captureAreaClipboard(state.areaRect, { includeCapitals: true });
  pushFullStateUndo();
  forEachHexInRect(state.areaRect, hex => resetHexToEmpty(hex));
  rewriteRoutesKeepOutside(state.areaRect);
  stripCapitalsInRect(state.areaRect);
  applyClipboard(clip, state.areaRect.minCol + dCol, state.areaRect.minRow + dRow, { moveCapitals: true });
  const size = areaRectSize(state.areaRect);
  state.areaRect = areaRectFromCorners(
    state.areaRect.minCol + dCol,
    state.areaRect.minRow + dRow,
    state.areaRect.minCol + dCol + size.cols - 1,
    state.areaRect.minRow + dRow + size.rows - 1
  );
  state.areaMode = 'idle';
  afterAreaMutation();
}

export function cropMapToArea(){
  const rect = state.areaRect;
  if (!rect) return;
  const size = areaRectSize(rect);
  if (size.cols < 2 || size.rows < 2){
    alert('Cropped map must be at least 2×2 hexes.');
    return;
  }
  if (state.prefConfirmDeletes && !confirm(`Crop the map to the selected ${size.cols}×${size.rows} area? Hexes outside will be removed.`)) return;

  pushFullStateUndo();
  const oldHexes = state.hexes;
  const next = new Map();
  for (let row = 0; row < size.rows; row++){
    for (let col = 0; col < size.cols; col++){
      const { q, r } = offsetToAxial(col, row);
      const old = offsetToAxial(col + rect.minCol, row + rect.minRow);
      const src = oldHexes.get(`${old.q},${old.r}`);
      const coords = axialToPixel(q, r, HEX_SIZE);
      if (src){
        const cloned = cloneHex(src);
        cloned.q = q;
        cloned.r = r;
        cloned.x = coords.x;
        cloned.y = coords.y;
        next.set(`${q},${r}`, cloned);
      } else {
        next.set(`${q},${r}`, {
          q, r, x: coords.x, y: coords.y, terrain: 'ocean', elevation: 'flat', population: 0,
          ownerFactionId: null, loyaltyFactionId: null, controllerFactionId: null, region: null,
          culture: null, cityName: null, customData: {}, buildings: [], units: []
        });
      }
    }
  }
  state.hexes.clear();
  for (const [key, hex] of next) state.hexes.set(key, hex);
  state.mapCols = size.cols;
  state.mapRows = size.rows;
  const colsEl = document.getElementById('mapCols');
  const rowsEl = document.getElementById('mapRows');
  if (colsEl) colsEl.value = size.cols;
  if (rowsEl) rowsEl.value = size.rows;

  const remapped = [];
  for (const route of state.routes){
    const runs = clipRouteByCellPredicate(route, cell => hexInAreaRect(cell, rect));
    for (let i = 0; i < runs.length; i++){
      const wps = runs[i].map(cell => {
        const off = axialToOffset(cell.q, cell.r);
        return offsetToAxial(off.col - rect.minCol, off.row - rect.minRow);
      });
      if (wps.length < 2) continue;
      const name = i === 0 ? route.name : null;
      remapped.push(makeRoute(i === 0 ? route.id : state.nextRouteId++, route.style, wps, name));
    }
  }
  replaceRoutes(remapped);

  for (const rec of state.factions.values()){
    if (!rec.capital || !Number.isFinite(Number(rec.capital.q))) continue;
    if (!hexInAreaRect(rec.capital, rect)){
      setFactionCapital(rec.id, null);
      continue;
    }
    const off = axialToOffset(rec.capital.q, rec.capital.r);
    const mapped = offsetToAxial(off.col - rect.minCol, off.row - rect.minRow);
    const hex = state.hexes.get(`${mapped.q},${mapped.r}`);
    if (hex) setFactionCapital(rec.id, hex);
    else setFactionCapital(rec.id, null);
  }

  state.areaRect = null;
  state.areaDrag = null;
  state.areaMode = 'idle';
  centerCamera();
  afterAreaMutation();
}

export function handleAreaPointerDown(hex){
  if (!hex) return;
  const off = axialToOffset(hex.q, hex.r);
  if (state.areaMode === 'paste'){
    pasteAreaClipboard(off.col, off.row);
    return;
  }
  if (state.areaMode === 'move' && state.areaRect){
    moveAreaByDelta(off.col - state.areaRect.minCol, off.row - state.areaRect.minRow);
    return;
  }
  if (state.areaRect && hexInAreaRect(hex, state.areaRect)){
    state.areaDrag = { kind: 'move', originCol: off.col, originRow: off.row, destCol: off.col, destRow: off.row };
    hooks.refreshInteractionUI();
    return;
  }
  state.areaMode = 'idle';
  state.areaDrag = { kind: 'select', startCol: off.col, startRow: off.row, endCol: off.col, endRow: off.row };
  hooks.refreshAreaUi();
  hooks.refreshInteractionUI();
}

export function handleAreaPointerMove(hex){
  if (!state.areaDrag || !hex) return false;
  const off = axialToOffset(hex.q, hex.r);
  if (state.areaDrag.kind === 'select'){
    if (off.col === state.areaDrag.endCol && off.row === state.areaDrag.endRow) return false;
    state.areaDrag.endCol = off.col;
    state.areaDrag.endRow = off.row;
    return true;
  }
  if (state.areaDrag.kind === 'move'){
    if (off.col === state.areaDrag.destCol && off.row === state.areaDrag.destRow) return false;
    state.areaDrag.destCol = off.col;
    state.areaDrag.destRow = off.row;
    return true;
  }
  return false;
}

export function finishAreaPointer(){
  const drag = state.areaDrag;
  if (!drag) return;
  state.areaDrag = null;
  if (drag.kind === 'select'){
    state.areaRect = areaRectFromCorners(drag.startCol, drag.startRow, drag.endCol, drag.endRow);
    hooks.refreshAreaUi();
    hooks.refreshInteractionUI();
    hooks.render();
    return;
  }
  if (drag.kind === 'move'){
    moveAreaByDelta(drag.destCol - drag.originCol, drag.destRow - drag.originRow);
  }
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
    hooks.refreshStatistics();
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
