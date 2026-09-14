import { state } from './state.js';
import {
  HEX_SIZE, MIN_ZOOM, MAX_ZOOM, DEFAULT_MAX_UNDO, DEFAULT_MAP_COLS, DEFAULT_MAP_ROWS,
  DEFAULT_TILE_OPACITY, DEFAULT_TERRAIN_DEFS, DEFAULT_AUTOSAVE_MS, LEGACY_TERRAIN_IDS,
  APP_VERSION, ELEVATION_LABELS, ROUTE_DEFS, ROUTE_BY_ID, ROUTE_DRAW_ORDER,
  FACTION_TYPES, FACTION_TYPE_LABELS, FACTION_CODE_LEN, FLAG_MAX_EDGE,
  AUTOSAVE_KEY, SETTINGS_KEY
} from './constants.js';
import { clamp, axialToPixel, expandWaypoints } from './hexMath.js';
import { computeCultureColor, grayLoyaltyColor } from './color.js';
import { canvas } from './canvas.js';
import { render, updateInspector } from './render.js';
import {
  TOOL_DEFS, TOOL_BY_ID, getToolDef, isPaintTool,
  generateMap, centerCamera, undo, redo, beginAction, commitAction,
  executeAtomicDelta, markHexForUndo, pushFullStateUndo, applyFullState,
  persistAutosave, setAutosaveInterval, prefBool, applyPrefsFromObject,
  invalidateFactionCache, invalidatePopulationStats, syncFactionCapitals,
  ensureFactionCodes, pruneUnusedCultures, restoreRoutes, cloneWaypoints,
  routeMouths, makeFaction,
  ensureFaction, ensureCulture, cultureColor, peekCultureColor, factionColor,
  factionHexCount, getFactionCounts, sortedFactionNames,
  uniqueFactionName, suggestFactionCode, normalizeFactionCode, formatFactionCode,
  isFactionCodeFree, cloneCapital, findFactionNameByCode, retargetFactionName,
  getFactionCapitalHex, factionsWithCapitalAt, setFactionCapital,
  getRegion, hexRegion, createRegion, deleteRegionById, regionsForFaction, getRegionCounts, restoreRegions,
  routesOnHex, routeCells,
  getSelectedRoute, cancelPathDraft, selectRoute, deleteRouteById, renameRoute,
  applyBrush, paintAtScreen, getHexAtScreen, applyZoom, handlePathClick,
  finishRouteDrag
} from './domain.js';

function getMousePos(e){
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  const pos = getMousePos(e);

  if (state.capitalPickMode){
    if (e.button === 0){
      finishCapitalPick(getHexAtScreen(pos.x, pos.y));
      render();
      return;
    }
  }

  if (state.backgroundEditMode){
    if (e.button === 0){
      state.isDraggingBg = true;
      state.lastPanX = e.clientX; state.lastPanY = e.clientY;
      canvas.style.cursor = 'grabbing';
    }
    return;
  }

  if (e.button === 0){
    // Select Override via Shift+Click (disabled while drawing a path)
    if (e.shiftKey && getToolDef().kind !== 'path') {
      state.selectedHex = getHexAtScreen(pos.x, pos.y);
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
      state.isPainting = true;
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
    state.isPanning = true;
    state.lastPanX = e.clientX; state.lastPanY = e.clientY;
    canvas.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', e => {
  if (state.backgroundEditMode){
    if (state.isDraggingBg){
      const dx = e.clientX - state.lastPanX, dy = e.clientY - state.lastPanY;
      state.bgImage.offsetX += dx / state.camera.zoom;
      state.bgImage.offsetY += dy / state.camera.zoom;
      state.lastPanX = e.clientX; state.lastPanY = e.clientY;
      syncBgInputs();
      render();
    }
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  const inside = pos.x >= 0 && pos.y >= 0 && pos.x <= rect.width && pos.y <= rect.height;

  if (state.isPanning){
    const dx = e.clientX - state.lastPanX, dy = e.clientY - state.lastPanY;
    state.camera.x -= dx / state.camera.zoom;
    state.camera.y -= dy / state.camera.zoom;
    state.lastPanX = e.clientX; state.lastPanY = e.clientY;
  }
  if (state.isPainting && inside && isPaintTool()){
    paintAtScreen(pos.x, pos.y);
  }
  
  if (inside){
    const prevHover = state.hoveredHex;
    state.hoveredHex = getHexAtScreen(pos.x, pos.y);
    if (state.hoveredHex !== prevHover) {
      if (state.routeDrag && state.hoveredHex){
        state.routeDrag.waypoints[state.routeDrag.index] = { q: state.hoveredHex.q, r: state.hoveredHex.r };
      }
      updateInspector(state.hoveredHex);
      render(); // Trigger re-render to update brush preview and outlines
    }
  } else if (!state.isPanning && state.hoveredHex){
    state.hoveredHex = null;
    render();
  }
  
  if (state.isPanning) render();
});

window.addEventListener('mouseup', () => {
  if (state.isPainting) {
    state.isPainting = false;
    commitAction();
  }
  if (state.routeDrag) finishRouteDrag();
  state.isDraggingBg = false;
  if (state.isPanning) state.isPanning = false;
  refreshInteractionUI();
});

canvas.addEventListener('mouseleave', () => {
  if (state.isPainting) {
    state.isPainting = false;
    commitAction();
  }
  if (!state.isPanning && !state.backgroundEditMode){ state.hoveredHex = null; render(); }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const pos = getMousePos(e);

  if (state.backgroundEditMode){
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    state.bgImage.scale = clamp(state.bgImage.scale * factor, 0.01, 50);
    syncBgInputs();
    render();
    return;
  }
  applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, pos.x, pos.y);
}, { passive: false });

window.addEventListener('keydown', e => {
  // The capital picker owns the canvas until it resolves, so swallow the rest.
  if (state.capitalPickMode){
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
    if (state.pathDraft || state.routeDrag){
      e.preventDefault();
      cancelPathDraft();
      render();
    } else if (state.selectedRouteId !== null){
      e.preventDefault();
      selectRoute(null);
      render();
    }
  } else if ((key === 'delete' || key === 'backspace') && getToolDef().kind === 'path' && !state.pathDraft && !state.routeDrag){
    const selected = getSelectedRoute();
    const wpIndex = waypointIndexAtHex(selected, state.hoveredHex);
    if (selected && wpIndex >= 0){
      e.preventDefault();
      removeWaypoint(selected.id, wpIndex);
      render();
      return;
    }
    const hit = findRouteAtHex(state.hoveredHex);
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
  if (state.backgroundEditMode){ canvas.style.cursor = 'move'; return; }
  canvas.style.cursor = 'crosshair';
}

function updateControlsHint(){
  const el = document.getElementById('controlsHint');
  if (state.capitalPickMode){
    el.innerHTML = `<div><b>Left</b> click — set this hex as the capital</div><div><b>Esc</b> — keep the current capital</div><div><b>Right/Middle</b> drag — pan</div>`;
    return;
  }
  if (state.backgroundEditMode){
    el.innerHTML = `<div><b>Left</b> drag — move image</div><div><b>Scroll</b> — resize image</div>`;
    return;
  }
  const tool = getToolDef();
  let toolHint = tool.hint || '';
  if (tool.kind === 'path'){
    if (state.brush.pathMode === 'erase'){
      toolHint = '<div><b>Click</b> — erase path under cursor</div><div><b>Delete</b> — erase hovered path</div>';
    } else if (state.brush.pathMode === 'edit'){
      toolHint = state.routeDrag
        ? '<div><b>Release</b> — drop handle on this hex</div><div><b>Red</b> — overlaps another path</div>'
        : (getSelectedRoute()
          ? '<div><b>Drag</b> handle — move waypoint</div><div><b>Shift+Click</b> — insert waypoint</div><div><b>Alt+Click</b> handle — remove waypoint</div><div><b>Esc</b> — deselect</div>'
          : '<div><b>Click</b> a path — select it for editing</div>');
    } else if (state.pathDraft){
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

export function refreshInteractionUI(){
  updateCursor();
  updateControlsHint();
}

export function setActiveTool(id){
  if (!TOOL_BY_ID[id]) return;
  if (state.activeTool !== id) cancelPathDraft();
  state.activeTool = id;
  if (id === 'region'){
    const faction = regionFactionFilter();
    const current = getRegion(state.brush.regionId);
    if (!current || current.faction !== faction){
      const first = regionsForFaction(faction)[0];
      state.brush.regionId = first ? first.id : null;
    }
    syncRegionBrushInputs();
  }
  state.isPainting = false;
  const radio = document.querySelector(`input[name=tool][value="${id}"]`);
  if (radio) radio.checked = true;
  updateToolVisibility();
  refreshInteractionUI();
  render();
}

export function updateToolVisibility(){
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

export function rebuildTerrainColors(){
  for (const key of Object.keys(state.TERRAIN_COLORS)) delete state.TERRAIN_COLORS[key];
  state.TERRAIN_DEFS.forEach(t => state.TERRAIN_COLORS[t.id] = t.color);
}

export function rebuildTerrainSwatches(){
  terrainSwatchesEl.innerHTML = '';
  if (!state.TERRAIN_DEFS.some(t => t.id === state.brush.terrain)){
    state.brush.terrain = state.TERRAIN_DEFS[0] ? state.TERRAIN_DEFS[0].id : 'ocean';
  }
  state.TERRAIN_DEFS.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch-btn' + (t.id === state.brush.terrain ? ' active' : '');
    btn.innerHTML = `<span class="swatch-color" style="background:${t.color}"></span><span>${t.label}</span>`;
    btn.addEventListener('click', () => {
      state.brush.terrain = t.id;
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
  btn.className = 'swatch-btn' + (def.id === state.brush.routeStyle ? ' active' : '');
  btn.innerHTML = `<span class="swatch-color" style="background:${def.color}"></span><span>${def.label}</span>`;
  btn.addEventListener('click', () => {
    state.brush.routeStyle = def.id;
    syncRouteSwatches();
    // Only restyle a draft that is creating a new path, never one extending an existing one.
    if (state.pathDraft && !state.pathDraft.routeId) state.pathDraft.style = def.id;
    render();
  });
  routeSwatchesEl.appendChild(btn);
});

export function syncRouteSwatches(){
  routeSwatchesEl.querySelectorAll('.swatch-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.routeStyle === state.brush.routeStyle);
  });
}

function setPathMode(mode){
  state.brush.pathMode = mode;
  const radio = document.querySelector(`input[name=pathMode][value="${mode}"]`);
  if (radio) radio.checked = true;
  cancelPathDraft();
}

document.querySelectorAll('input[name=pathMode]').forEach(r => {
  r.addEventListener('change', e => {
    state.brush.pathMode = e.target.value;
    cancelPathDraft();
    if (state.brush.pathMode !== 'edit') selectRoute(null);
    refreshInteractionUI();
    render();
  });
});

document.getElementById('cancelPathBtn').addEventListener('click', () => {
  cancelPathDraft();
  render();
});

document.getElementById('layerTerrain').addEventListener('change', e => { state.viewLayers.terrain = e.target.checked; render(); });
document.getElementById('layerElevation').addEventListener('change', e => { state.viewLayers.elevation = e.target.checked; render(); });
document.getElementById('layerOwnership').addEventListener('change', e => { state.viewLayers.ownership = e.target.checked; render(); });
document.getElementById('layerRegions').addEventListener('change', e => { state.viewLayers.regions = e.target.checked; render(); });
document.getElementById('layerLoyalty').addEventListener('change', e => { state.viewLayers.loyalty = e.target.checked; render(); });
document.getElementById('layerController').addEventListener('change', e => { state.viewLayers.controller = e.target.checked; render(); });
document.getElementById('layerCulture').addEventListener('change', e => { state.viewLayers.culture = e.target.checked; render(); });
document.getElementById('layerRoutes').addEventListener('change', e => { state.viewLayers.routes = e.target.checked; render(); });
document.getElementById('layerPopulation').addEventListener('change', e => { state.viewLayers.population = e.target.checked; render(); });
document.getElementById('showFullGrid').addEventListener('change', e => { state.showFullGrid = e.target.checked; render(); });
document.querySelectorAll('input[name=heatmapScale]').forEach(r => {
  r.addEventListener('change', e => { state.heatmapScale = e.target.value; render(); });
});

document.getElementById('tileOpacitySlider').addEventListener('input', e => {
  state.tileOpacity = e.target.value / 100; render();
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
  if (tool.id === state.activeTool) radio.checked = true;
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
  r.addEventListener('change', e => { state.brush.elevation = e.target.value; });
});

document.querySelectorAll('input[name=populationMode]').forEach(r => {
  r.addEventListener('change', e => { state.brush.populationMode = e.target.value; });
});
const populationAmountSliderEl = document.getElementById('populationAmountSlider');
const populationAmountLabelEl = document.getElementById('populationAmountLabel');

function setPopulationAmount(value, fromSlider = false){
  const amount = clamp(Math.round(Number(value)) || 0, 0, 10000000);
  state.brush.populationAmount = amount;
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
  const step = populationNudgeStep(state.brush.populationAmount);
  setPopulationAmount(state.brush.populationAmount - step);
});
document.getElementById('popAddBtn').addEventListener('click', () => {
  const step = populationNudgeStep(state.brush.populationAmount);
  setPopulationAmount(state.brush.populationAmount + step);
});

const ownerSelectEl = document.getElementById('ownerFactionSelect');
const ownerSwatchEl = document.getElementById('ownerFactionSwatch');
const loyaltySelectEl = document.getElementById('loyaltyFactionSelect');
const loyaltySwatchEl = document.getElementById('loyaltyFactionSwatch');
const controllerSelectEl = document.getElementById('controllerFactionSelect');
const controllerSwatchEl = document.getElementById('controllerFactionSwatch');
const editOwnerFactionBtn = document.getElementById('editOwnerFactionBtn');
const editLoyaltyFactionBtn = document.getElementById('editLoyaltyFactionBtn');
const editControllerFactionBtn = document.getElementById('editControllerFactionBtn');

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
    opt.textContent = `${name} — ${FACTION_TYPE_LABELS[state.factions.get(name).type]}`;
    selectEl.appendChild(opt);
  }
  selectEl.value = state.factions.has(selected) ? selected : '';
}

function setBrushSwatch(el, name, gray){
  if (!el) return;
  if (!name || !state.factions.has(name)){
    el.style.background = 'transparent';
    el.style.borderStyle = 'dashed';
    return;
  }
  el.style.borderStyle = 'solid';
  el.style.background = gray && factionHexCount(name) === 0 ? grayLoyaltyColor(name) : factionColor(name);
}

export function syncFactionBrushInputs(){
  if (!state.factions.has(state.brush.owner)) state.brush.owner = '';
  if (!state.factions.has(state.brush.loyalty)) state.brush.loyalty = '';
  if (!state.factions.has(state.brush.controller)) state.brush.controller = '';
  fillFactionSelect(ownerSelectEl, state.brush.owner, '— No faction (erase) —');
  fillFactionSelect(loyaltySelectEl, state.brush.loyalty, '— No loyalty (erase) —');
  fillFactionSelect(controllerSelectEl, state.brush.controller, '— No control (erase) —');
  setBrushSwatch(ownerSwatchEl, state.brush.owner, false);
  setBrushSwatch(loyaltySwatchEl, state.brush.loyalty, true);
  setBrushSwatch(controllerSwatchEl, state.brush.controller, true);
  editOwnerFactionBtn.disabled = !state.brush.owner;
  editLoyaltyFactionBtn.disabled = !state.brush.loyalty;
  editControllerFactionBtn.disabled = !state.brush.controller;
}

ownerSelectEl.addEventListener('change', () => {
  state.brush.owner = ownerSelectEl.value;
  syncFactionBrushInputs();
});

loyaltySelectEl.addEventListener('change', () => {
  state.brush.loyalty = loyaltySelectEl.value;
  syncFactionBrushInputs();
});

controllerSelectEl.addEventListener('change', () => {
  state.brush.controller = controllerSelectEl.value;
  syncFactionBrushInputs();
});

const regionFactionSelectEl = document.getElementById('regionFactionSelect');
const regionSelectEl = document.getElementById('regionSelect');
const regionNameInputEl = document.getElementById('regionNameInput');
const regionTypeInputEl = document.getElementById('regionTypeInput');
const regionGovernorInputEl = document.getElementById('regionGovernorInput');
const newRegionBtn = document.getElementById('newRegionBtn');
const deleteRegionBtn = document.getElementById('deleteRegionBtn');
let regionFieldsLocked = false;
let regionSelectSilent = false;

function regionFactionFilter(){
  const selected = regionFactionSelectEl ? regionFactionSelectEl.value : '';
  if (state.factions.has(selected)) return selected;
  const rec = getRegion(state.brush.regionId);
  if (rec && state.factions.has(rec.faction)) return rec.faction;
  const names = sortedFactionNames();
  return names[0] || '';
}

function fillSelectOptions(selectEl, options, value){
  if (!selectEl) return;
  const next = options.map(o => `${o.value}\0${o.label}`).join('\n');
  regionSelectSilent = true;
  try {
    if (selectEl.dataset.optionKey !== next){
      selectEl.innerHTML = '';
      for (const o of options){
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        selectEl.appendChild(opt);
      }
      selectEl.dataset.optionKey = next;
    }
    selectEl.value = value;
  } finally {
    regionSelectSilent = false;
  }
}

function regionFieldIsFocused(){
  const el = document.activeElement;
  return el === regionNameInputEl || el === regionTypeInputEl || el === regionGovernorInputEl || el === regionSelectEl;
}

function shouldSyncRegionForm(){
  return !state.isPainting && !regionFieldIsFocused();
}

export function syncRegionBrushInputs(){
  if (state.brush.regionId != null && !state.regions.has(state.brush.regionId)) state.brush.regionId = null;
  const faction = regionFactionFilter();
  if (state.factions.size === 0){
    fillSelectOptions(regionFactionSelectEl, [{ value: '', label: '— Create a faction first —' }], '');
  } else {
    fillSelectOptions(
      regionFactionSelectEl,
      sortedFactionNames().map(name => ({ value: name, label: name })),
      faction
    );
  }
  const listed = regionsForFaction(faction);
  const current = getRegion(state.brush.regionId);
  if (current && current.faction !== faction){
    state.brush.regionId = null;
  }
  const selected = getRegion(state.brush.regionId);
  fillSelectOptions(
    regionSelectEl,
    [{ value: '', label: '— No region (erase) —' }].concat(listed.map(rec => ({ value: String(rec.id), label: `${rec.name} (${rec.type})` }))),
    selected ? String(selected.id) : ''
  );
  const rec = getRegion(state.brush.regionId);
  const fieldsDisabled = !faction;
  const skipValues = regionFieldIsFocused();
  regionFieldsLocked = true;
  if (regionNameInputEl){
    regionNameInputEl.disabled = fieldsDisabled;
    if (!skipValues) regionNameInputEl.value = rec ? rec.name : (regionNameInputEl.value || '');
  }
  if (regionTypeInputEl){
    regionTypeInputEl.disabled = fieldsDisabled;
    if (!skipValues) regionTypeInputEl.value = rec ? rec.type : (regionTypeInputEl.value || 'Province');
  }
  if (regionGovernorInputEl){
    regionGovernorInputEl.disabled = fieldsDisabled;
    if (!skipValues) regionGovernorInputEl.value = rec ? rec.governor : (regionGovernorInputEl.value || '');
  }
  regionFieldsLocked = false;
  if (newRegionBtn) newRegionBtn.disabled = !faction;
  if (deleteRegionBtn) deleteRegionBtn.disabled = !rec;
}

regionFactionSelectEl.addEventListener('change', () => {
  if (regionSelectSilent) return;
  const rec = getRegion(state.brush.regionId);
  if (!rec || rec.faction !== regionFactionSelectEl.value){
    const first = regionsForFaction(regionFactionSelectEl.value)[0];
    state.brush.regionId = first ? first.id : null;
  }
  syncRegionBrushInputs();
});

regionSelectEl.addEventListener('change', () => {
  if (regionSelectSilent) return;
  const id = parseInt(regionSelectEl.value, 10);
  state.brush.regionId = Number.isFinite(id) ? id : null;
  syncRegionBrushInputs();
});

function commitRegionField(patch){
  const rec = getRegion(state.brush.regionId);
  if (!rec || regionFieldsLocked) return;
  beginAction();
  Object.assign(rec, patch);
  commitAction();
  refreshRegionList();
  refreshSelectedHexPanel();
  render();
}

regionNameInputEl.addEventListener('change', () => {
  const name = regionNameInputEl.value.trim();
  if (!name){
    syncRegionBrushInputs();
    return;
  }
  commitRegionField({ name });
});
regionTypeInputEl.addEventListener('change', () => {
  const type = regionTypeInputEl.value.trim();
  if (!type){
    syncRegionBrushInputs();
    return;
  }
  commitRegionField({ type });
});
regionGovernorInputEl.addEventListener('change', () => {
  commitRegionField({ governor: regionGovernorInputEl.value.trim() });
});

newRegionBtn.addEventListener('click', () => {
  const faction = regionFactionFilter();
  if (!faction){
    alert('Create a faction before adding an administrative region.');
    return;
  }
  beginAction();
  const rec = createRegion(faction, {
    name: (regionNameInputEl && regionNameInputEl.value.trim()) || 'New Region',
    type: (regionTypeInputEl && regionTypeInputEl.value.trim()) || 'Province',
    governor: regionGovernorInputEl ? regionGovernorInputEl.value.trim() : ''
  });
  commitAction();
  if (rec) state.brush.regionId = rec.id;
  setActiveTool('region');
  refreshRegionList();
  render();
});

deleteRegionBtn.addEventListener('click', () => {
  const rec = getRegion(state.brush.regionId);
  if (!rec) return;
  if (state.prefConfirmDeletes && !confirm(`Delete region "${rec.name}"? Hexes keep their faction but lose this region.`)) return;
  beginAction();
  deleteRegionById(rec.id);
  commitAction();
  refreshRegionList();
  refreshSelectedHexPanel();
  render();
});

const cultureInputEl = document.getElementById('cultureInput');
const cultureColorInputEl = document.getElementById('cultureColorInput');

export function syncCultureColorInput(){
  const name = cultureInputEl.value.trim();
  cultureColorInputEl.value = name ? peekCultureColor(name) : '#9c6eb9';
}

cultureInputEl.addEventListener('input', syncCultureColorInput);
cultureInputEl.addEventListener('change', () => { state.brush.culture = cultureInputEl.value.trim(); });
cultureInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') cultureInputEl.blur(); });

cultureColorInputEl.addEventListener('input', e => {
  const name = cultureInputEl.value.trim();
  if (!name) return;
  ensureCulture(name).color = e.target.value;
  refreshCultureList();
  render();
});

function factionBadge(name){
  const rec = state.factions.get(name);
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

export function refreshFactionList(){
  const listEl = document.getElementById('factionList');
  listEl.innerHTML = '';
  if (state.factions.size === 0){
    listEl.innerHTML = '<div class="hint">No factions yet. Create one to start painting territory.</div>';
    syncFactionBrushInputs();
    syncRegionBrushInputs();
    return;
  }

  const counts = getFactionCounts();
  const sorted = sortedFactionNames().sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
  for (const name of sorted){
    const rec = state.factions.get(name);
    const count = counts.get(name) || 0;
    const row = document.createElement('div');
    row.className = 'country-row';

    row.appendChild(factionBadge(name));

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = rec.capital ? `${name} 👑` : name;
    nameEl.title = `${FACTION_TYPE_LABELS[rec.type]}${rec.ideology ? ' · ' + rec.ideology : ''} — click to paint with this faction`;
    nameEl.addEventListener('click', () => {
      state.brush.owner = name;
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
  if (shouldSyncRegionForm()) syncRegionBrushInputs();
}

export function refreshRegionList(){
  const listEl = document.getElementById('regionList');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (state.regions.size === 0){
    listEl.innerHTML = '<div class="hint">No regions yet. Create one to start painting provinces.</div>';
    if (shouldSyncRegionForm()) syncRegionBrushInputs();
    return;
  }
  const counts = getRegionCounts();
  const sorted = Array.from(state.regions.values()).sort((a, b) => {
    const fa = a.faction.localeCompare(b.faction);
    if (fa) return fa;
    return a.name.localeCompare(b.name);
  });
  for (const rec of sorted){
    const row = document.createElement('div');
    row.className = 'country-row' + (rec.id === state.brush.regionId ? ' selected' : '');

    const swatch = document.createElement('span');
    swatch.className = 'swatch-color';
    swatch.style.background = state.factions.has(rec.faction) ? factionColor(rec.faction) : '#888';
    swatch.title = rec.faction || 'No faction';

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = `${rec.name} · ${rec.type}`;
    nameEl.title = `${rec.type}${rec.governor ? ' · ' + rec.governor : ''} — ${rec.faction || 'unassigned'} — click to paint`;
    nameEl.addEventListener('click', () => {
      state.brush.regionId = rec.id;
      syncRegionBrushInputs();
      setActiveTool('region');
      refreshRegionList();
    });

    const metaEl = document.createElement('span');
    metaEl.className = 'country-count';
    metaEl.textContent = counts.get(rec.id) || 0;
    metaEl.title = `${rec.type} of ${rec.faction || '—'}`;

    const actionsEl = document.createElement('div');
    actionsEl.className = 'country-actions';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete region';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (state.prefConfirmDeletes && !confirm(`Delete region "${rec.name}"? Hexes keep their faction but lose this region.`)) return;
      beginAction();
      deleteRegionById(rec.id);
      commitAction();
      refreshRegionList();
      refreshSelectedHexPanel();
      render();
    });

    actionsEl.appendChild(deleteBtn);
    row.appendChild(swatch);
    row.appendChild(nameEl);
    row.appendChild(metaEl);
    row.appendChild(actionsEl);
    listEl.appendChild(row);
  }
  if (shouldSyncRegionForm()) syncRegionBrushInputs();
}

export function refreshLoyaltyList(){
  const counts = new Map();
  for (const hex of state.hexes.values()){
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
      state.brush.loyalty = name;
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
    editBtn.disabled = !state.factions.has(name);
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
      if (!state.prefConfirmDeletes || confirm(`Clear loyalty "${name}" from all hexes? The faction itself is kept.`)) {
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

export function refreshControllerList(){
  const counts = new Map();
  for (const hex of state.hexes.values()){
    if (hex.controller) counts.set(hex.controller, (counts.get(hex.controller) || 0) + 1);
  }
  const listEl = document.getElementById('controllerList');
  listEl.innerHTML = '';
  if (counts.size === 0){
    listEl.innerHTML = '<div class="hint">No de facto control painted yet.</div>';
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
      ? 'Landless faction — de facto control by it is shown in gray hatch'
      : 'Hexes it also owns use its color, occupied hexes are shifted';

    const nameEl = document.createElement('span');
    nameEl.className = 'country-name';
    nameEl.textContent = name;
    nameEl.title = 'Click to set as the active de facto brush';
    nameEl.addEventListener('click', () => {
      state.brush.controller = name;
      syncFactionBrushInputs();
      setActiveTool('controller');
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
    editBtn.disabled = !state.factions.has(name);
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openFactionEditor(name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-icon-sm danger';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Clear this de facto control';
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!state.prefConfirmDeletes || confirm(`Clear de facto control "${name}" from all hexes? The faction itself is kept.`)) {
        clearController(name);
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

export function refreshCultureList(){
  const counts = new Map();
  for (const hex of state.hexes.values()){
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
      state.brush.culture = name;
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
      if (!state.prefConfirmDeletes || confirm(`Delete culture "${name}"? This will unassign it from all hexes.`)) {
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

export function refreshRouteList(){
  const listEl = document.getElementById('routeList');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (state.routes.length === 0){
    listEl.innerHTML = '<div class="hint">No roads or rivers drawn yet.</div>';
    return;
  }
  const ordered = state.routes.slice().sort((a, b) => {
    const oa = ROUTE_DRAW_ORDER[a.style] ?? 0;
    const ob = ROUTE_DRAW_ORDER[b.style] ?? 0;
    if (oa !== ob) return oa - ob;
    return a.id - b.id;
  });

  for (const route of ordered){
    const def = ROUTE_BY_ID[route.style] || {};
    const row = document.createElement('div');
    row.className = 'route-row' + (route.id === state.selectedRouteId ? ' selected' : '');

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
      if (!state.prefConfirmDeletes || confirm(`Delete "${route.name}"?`)){
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
  refreshControllerList();
  refreshRegionList();
  refreshSelectedHexPanel();
  render();
}

/* Writes the editor draft back into the map. Renaming carries owner, loyalty
   and de facto controller references across with it, so hexes never point at a faction that is gone. */
function saveFaction(originalName, draft){
  const name = draft.name;
  beginAction();

  if (originalName && originalName !== name){
    for (const hex of state.hexes.values()){
      if (hex.owner !== originalName && hex.loyalty !== originalName && hex.controller !== originalName) continue;
      markHexForUndo(hex);
      if (hex.owner === originalName) hex.owner = name;
      if (hex.loyalty === originalName) hex.loyalty = name;
      if (hex.controller === originalName) hex.controller = name;
    }
    for (const rec of state.regions.values()){
      if (rec.faction === originalName) rec.faction = name;
    }
    state.factions.delete(originalName);
    if (state.brush.owner === originalName) state.brush.owner = name;
    if (state.brush.loyalty === originalName) state.brush.loyalty = name;
    if (state.brush.controller === originalName) state.brush.controller = name;
  }

  state.factions.set(name, makeFaction(name, draft));
  invalidateFactionCache();
  commitAction();

  if (!originalName) state.brush.owner = name;
  refreshFactionUi();
}

function deleteFaction(name){
  beginAction();
  for (const hex of state.hexes.values()){
    if (hex.owner !== name && hex.loyalty !== name && hex.controller !== name) continue;
    markHexForUndo(hex);
    if (hex.owner === name) hex.owner = null;
    if (hex.loyalty === name) hex.loyalty = null;
    if (hex.controller === name) hex.controller = null;
  }
  for (const rec of Array.from(state.regions.values())){
    if (rec.faction === name) deleteRegionById(rec.id);
  }
  state.factions.delete(name);
  invalidateFactionCache();
  if (state.brush.owner === name) state.brush.owner = '';
  if (state.brush.loyalty === name) state.brush.loyalty = '';
  if (state.brush.controller === name) state.brush.controller = '';
  commitAction();
  refreshFactionUi();
}

function confirmDeleteFaction(name){
  const owned = factionHexCount(name);
  const territory = owned > 0 ? ` It owns ${owned} hex${owned === 1 ? '' : 'es'}, which become unowned.` : '';
  if (state.prefConfirmDeletes && !confirm(`Delete faction "${name}"?${territory} Loyalty, de facto control, and administrative regions of it are cleared too.`)) return false;
  deleteFaction(name);
  return true;
}

function clearLoyalty(name){
  beginAction();
  for (const hex of state.hexes.values()){
    if (hex.loyalty === name){
      markHexForUndo(hex);
      hex.loyalty = null;
    }
  }
  if (state.brush.loyalty === name) state.brush.loyalty = '';
  commitAction();
  refreshLoyaltyList();
  syncFactionBrushInputs();
  refreshSelectedHexPanel();
  render();
}

function clearController(name){
  beginAction();
  for (const hex of state.hexes.values()){
    if (hex.controller === name){
      markHexForUndo(hex);
      hex.controller = null;
    }
  }
  if (state.brush.controller === name) state.brush.controller = '';
  commitAction();
  refreshControllerList();
  syncFactionBrushInputs();
  refreshSelectedHexPanel();
  render();
}

/* ----------------------------------------------------------------------------
   9b. FACTION EDITOR
   ---------------------------------------------------------------------------- */

/* The whole form lives in this draft until Save, so Cancel and the capital
   picker round-trip cannot leave a half-edited faction behind. */
const factionModalEl = document.getElementById('factionModal');
const factionNameInputEl = document.getElementById('factionNameInput');
const factionCodeInputEl = document.getElementById('factionCodeInput');
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
const factionExportBtn = document.getElementById('factionExportBtn');
const factionImportBtn = document.getElementById('factionImportBtn');
const factionImportFileEl = document.getElementById('factionImportFileInput');
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
  const flag = state.factionDraft && state.factionDraft.flag;
  factionFlagPreviewEl.classList.toggle('empty', !flag);
  factionFlagPreviewEl.style.backgroundImage = flag ? `url("${flag}")` : '';
  factionFlagClearBtn.hidden = !flag;
}

function syncFactionCapitalLabel(){
  const cap = state.factionDraft ? state.factionDraft.capital : null;
  factionCapitalLabelEl.textContent = cap ? `Capital at ${cap.q}, ${cap.r}` : 'No capital set';
  factionCapitalLabelEl.classList.toggle('is-empty', !cap);
  factionCapitalClearBtn.disabled = !cap;
}

function syncFactionEditorFields(){
  if (!state.factionDraft) return;
  factionNameInputEl.value = state.factionDraft.name;
  factionCodeInputEl.value = state.factionDraft.code;
  factionTypeSelectEl.value = state.factionDraft.type;
  factionIdeologyInputEl.value = state.factionDraft.ideology;
  factionColorInputEl.value = state.factionDraft.color;
  factionDescInputEl.value = state.factionDraft.description;
  syncFactionFlagPreview();
  syncFactionCapitalLabel();
}

function openFactionEditor(name){
  const rec = name ? state.factions.get(name) : null;
  state.factionDraftOriginalName = rec ? name : null;
  const draftName = rec ? name : uniqueFactionName('New Faction');
  const base = rec || makeFaction(draftName);
  /* A code the user has not typed yet keeps following the name field. */
  state.factionCodeDirty = !!(rec && rec.code);
  state.factionDraft = {
    name: draftName,
    code: base.code || suggestFactionCode(draftName, state.factionDraftOriginalName),
    color: base.color,
    type: base.type,
    ideology: base.ideology,
    description: base.description,
    flag: base.flag,
    capital: cloneCapital(base.capital)
  };
  factionEditorTitleEl.textContent = rec ? 'Faction Editor' : 'New Faction';
  factionDeleteBtn.hidden = !rec;
  factionExportBtn.hidden = !rec;
  factionImportBtn.hidden = !!rec;
  syncFactionEditorFields();
  openModal('factionModal');
  factionNameInputEl.focus();
  factionNameInputEl.select();
}

export function closeFactionEditor(){
  state.factionDraft = null;
  state.factionDraftOriginalName = null;
  state.factionCodeDirty = false;
  factionFlagFileEl.value = '';
  closeModal('factionModal');
}

function setCapitalPickMode(active){
  state.capitalPickMode = active && !!state.factionDraft;
  factionModalEl.hidden = state.capitalPickMode || !state.factionDraft;
  document.getElementById('capitalPickBanner').style.display = state.capitalPickMode ? 'block' : 'none';
  refreshInteractionUI();
}

function finishCapitalPick(hex){
  if (state.factionDraft) state.factionDraft.capital = hex ? { q: hex.q, r: hex.r } : state.factionDraft.capital;
  setCapitalPickMode(false);
  syncFactionCapitalLabel();
}

/* Pulls the form into the draft, or explains why it cannot. Shared by Save and
   Export so an exported file is always as valid as a saved faction. */
function applyFactionForm(){
  const name = factionNameInputEl.value.trim();
  if (!name){
    alert('A faction needs a name.');
    factionNameInputEl.focus();
    return false;
  }
  if (name !== state.factionDraftOriginalName && state.factions.has(name)){
    alert(`A faction called "${name}" already exists.`);
    factionNameInputEl.focus();
    return false;
  }
  const code = normalizeFactionCode(factionCodeInputEl.value);
  if (code.length !== FACTION_CODE_LEN){
    alert('A faction code is exactly 4 letters or numbers.');
    factionCodeInputEl.focus();
    return false;
  }
  if (!isFactionCodeFree(code, state.factionDraftOriginalName)){
    alert(`The code ${formatFactionCode(code)} already belongs to another faction.`);
    factionCodeInputEl.focus();
    return false;
  }
  state.factionDraft.name = name;
  state.factionDraft.code = code;
  state.factionDraft.type = factionTypeSelectEl.value;
  state.factionDraft.ideology = factionIdeologyInputEl.value.trim();
  state.factionDraft.color = factionColorInputEl.value;
  state.factionDraft.description = factionDescInputEl.value;
  return true;
}

function commitFactionEditor(){
  if (!state.factionDraft || !applyFactionForm()) return;

  const original = state.factionDraftOriginalName;
  const draft = state.factionDraft;
  closeFactionEditor();
  saveFaction(original, draft);
}

[factionNameInputEl, factionCodeInputEl].forEach(el => {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter'){
      e.preventDefault();
      commitFactionEditor();
    }
  });
});

factionNameInputEl.addEventListener('input', e => {
  if (!state.factionDraft || state.factionCodeDirty) return;
  factionCodeInputEl.value = suggestFactionCode(e.target.value, state.factionDraftOriginalName);
});

factionCodeInputEl.addEventListener('input', e => {
  state.factionCodeDirty = true;
  e.target.value = normalizeFactionCode(e.target.value);
});

factionColorInputEl.addEventListener('input', e => {
  if (state.factionDraft) state.factionDraft.color = e.target.value;
});

factionFlagFileEl.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file || !state.factionDraft) return;
  const reader = new FileReader();
  reader.onload = ev => {
    downscaleFlag(ev.target.result)
      .then(flag => {
        if (!state.factionDraft) return;
        state.factionDraft.flag = flag;
        syncFactionFlagPreview();
      })
      .catch(() => alert('That file could not be read as an image.'));
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

factionFlagClearBtn.addEventListener('click', () => {
  if (!state.factionDraft) return;
  state.factionDraft.flag = null;
  syncFactionFlagPreview();
});

factionCapitalPickBtn.addEventListener('click', () => setCapitalPickMode(true));

factionCapitalClearBtn.addEventListener('click', () => {
  if (!state.factionDraft) return;
  state.factionDraft.capital = null;
  syncFactionCapitalLabel();
});

factionDeleteBtn.addEventListener('click', () => {
  const name = state.factionDraftOriginalName;
  if (!name) return;
  if (confirmDeleteFaction(name)) closeFactionEditor();
});

/* Factions travel between tools on their own, without the rest of the map. The
   file shape matches the `factions` array of a map export, so a map.json or a
   Lorekeeper scenario (which also has `factions`) can be fed into the importer. */
function factionFileEntry(name, rec){
  return {
    name,
    code: formatFactionCode(rec.code),
    type: rec.type,
    ideology: rec.ideology,
    description: rec.description,
    color: rec.color,
    flag: rec.flag,
    capital: cloneCapital(rec.capital)
  };
}

function downloadJson(data, filename){
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function factionEntriesFrom(data){
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object'){
    if (Array.isArray(data.factions)) return data.factions;
    if (data.faction) return [data.faction];
    if (typeof data.name === 'string') return [data];
  }
  return [];
}

function mergeImportedFaction(raw){
  if (!raw || typeof raw !== 'object') return null;
  const wanted = typeof raw.name === 'string' ? raw.name.trim() : '';
  const code = normalizeFactionCode(raw.code);
  const byCode = (code.length === FACTION_CODE_LEN) ? findFactionNameByCode(code) : null;

  if (byCode){
    const existing = state.factions.get(byCode);
    let destName = byCode;
    if (wanted && wanted !== byCode){
      destName = (state.factions.has(wanted) && wanted !== byCode) ? byCode : wanted;
    }
    if (destName !== byCode) retargetFactionName(byCode, destName);
    const rec = makeFaction(destName, { ...raw, code });
    rec.code = code;
    if (!rec.capital && existing && existing.capital) rec.capital = cloneCapital(existing.capital);
    if (!rec.flag && existing && existing.flag) rec.flag = existing.flag;
    state.factions.set(destName, rec);
    return { kind: 'updated', name: destName };
  }

  if (!wanted) return null;
  const name = uniqueFactionName(wanted);
  const rec = makeFaction(name, raw);
  if (rec.code.length !== FACTION_CODE_LEN || !isFactionCodeFree(rec.code)) rec.code = suggestFactionCode(name);
  state.factions.set(name, rec);
  return { kind: 'added', name };
}

function importFactionsFile(file){
  const reader = new FileReader();
  reader.onload = e => {
    let entries;
    try {
      entries = factionEntriesFrom(JSON.parse(e.target.result));
    } catch (err){
      alert('Failed to import factions: ' + err.message);
      return;
    }
    if (!entries.length){
      alert('That file has no factions in it.');
      return;
    }

    closeFactionEditor();
    beginAction();
    const added = [];
    const updated = [];
    for (const raw of entries){
      const result = mergeImportedFaction(raw);
      if (!result) continue;
      if (result.kind === 'updated') updated.push(result.name);
      else added.push(result.name);
    }
    invalidateFactionCache();
    syncFactionCapitals();
    commitAction();
    refreshFactionUi();
    syncFactionBrushInputs();

    if (!added.length && !updated.length) alert('That file has no factions in it.');
    else {
      const parts = [];
      if (updated.length) parts.push(`updated ${updated.length}`);
      if (added.length) parts.push(`added ${added.length}`);
      alert(`Imported factions (${parts.join(', ')}).`);
    }
  };
  reader.readAsText(file);
}

factionExportBtn.addEventListener('click', () => {
  if (!state.factionDraft || !applyFactionForm()) return;
  downloadJson({
    format: 'cartographer-factions',
    version: 1,
    exportedAt: new Date().toISOString(),
    factions: [factionFileEntry(state.factionDraft.name, state.factionDraft)]
  }, `${formatFactionCode(state.factionDraft.code)}.json`);
});

factionImportBtn.addEventListener('click', () => factionImportFileEl.click());

factionImportFileEl.addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importFactionsFile(file);
});

document.getElementById('factionSaveBtn').addEventListener('click', commitFactionEditor);
document.getElementById('factionCancelBtn').addEventListener('click', closeFactionEditor);
document.getElementById('newFactionBtn').addEventListener('click', () => openFactionEditor(null));
editOwnerFactionBtn.addEventListener('click', () => {
  if (state.brush.owner) openFactionEditor(state.brush.owner);
});
editLoyaltyFactionBtn.addEventListener('click', () => {
  if (state.brush.loyalty) openFactionEditor(state.brush.loyalty);
});
editControllerFactionBtn.addEventListener('click', () => {
  if (state.brush.controller) openFactionEditor(state.brush.controller);
});

function renameCulture(oldName, newName){
  beginAction();
  const oldRec = state.cultures.has(oldName)
    ? cloneCultureRecord(state.cultures.get(oldName))
    : { color: computeCultureColor(oldName) };
  const destExisted = state.cultures.has(newName);

  for (const hex of state.hexes.values()){
    if (hex.culture === oldName){
      markHexForUndo(hex);
      hex.culture = newName;
    }
  }

  const dest = ensureCulture(newName, destExisted ? undefined : oldRec.color);
  if (!destExisted) dest.color = oldRec.color;
  state.cultures.delete(oldName);

  if (state.brush.culture === oldName){
    state.brush.culture = newName;
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
  for (const hex of state.hexes.values()){
    if (hex.culture === name){
      markHexForUndo(hex);
      hex.culture = null;
    }
  }
  state.cultures.delete(name);
  if (state.brush.culture === name){
    state.brush.culture = '';
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
  state.brush.size = parseInt(e.target.value);
  brushSizeLabel.textContent = state.brush.size;
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
  if (!state.selectedHex){
    infoEl.textContent = 'Shift+Click a hex to select it.';
    metaEl.hidden = true;
    metaEl.innerHTML = '';
    return;
  }
  infoEl.innerHTML = `Editing hex <b>${state.selectedHex.q}, ${state.selectedHex.r}</b>`;
  metaEl.hidden = false;
  const terrainLabel = (state.TERRAIN_DEFS.find(t => t.id === state.selectedHex.terrain) || {}).label || state.selectedHex.terrain;
  const capitalOf = factionsWithCapitalAt(state.selectedHex);
  const capitalLine = capitalOf.length
    ? `<div><b>Capital of</b> ${capitalOf.join(', ')}</div>`
    : (state.selectedHex.owner ? '<div>Not a capital.</div>' : '<div>Paint a faction before setting a capital.</div>');
  const onRoutes = routesOnHex(state.selectedHex).map(r => r.name);
  const routesLine = onRoutes.length ? `<div><b>Routes</b> ${onRoutes.join(', ')}</div>` : '';
  const regionRec = hexRegion(state.selectedHex);
  const regionLine = regionRec
    ? `<div><b>Region</b> ${regionRec.name} (${regionRec.type})</div>${regionRec.governor ? `<div><b>Governor</b> ${regionRec.governor}</div>` : ''}`
    : '';
  metaEl.innerHTML = `
    <div><b>Terrain</b> ${terrainLabel}</div>
    <div><b>Elevation</b> ${ELEVATION_LABELS[state.selectedHex.elevation] || state.selectedHex.elevation || 'Flat'}</div>
    <div><b>Population</b> ${state.selectedHex.population}</div>
    <div><b>Faction</b> ${state.selectedHex.owner || '—'}</div>
    ${regionLine}
    ${state.selectedHex.controller && state.selectedHex.controller !== state.selectedHex.owner
      ? `<div><b>De facto</b> ${state.selectedHex.controller}</div>`
      : ''}
    <div><b>Loyalty</b> ${state.selectedHex.loyalty || '—'}</div>
    <div><b>Culture</b> ${state.selectedHex.culture || '—'}</div>
    <div><b>City</b> ${state.selectedHex.cityName || '—'}</div>
    ${routesLine}
    ${capitalLine}
  `;
}

function setCustomField(oldKey, nextKey, value){
  if (!state.selectedHex || !nextKey) return;
  executeAtomicDelta([state.selectedHex], () => {
    if (!state.selectedHex.customData) state.selectedHex.customData = {};
    if (oldKey && oldKey !== nextKey) delete state.selectedHex.customData[oldKey];
    state.selectedHex.customData[nextKey] = value;
  });
  refreshSelectedHexPanel();
  render();
}

function renderCustomDataRows(){
  const wrap = document.getElementById('customDataRows');
  wrap.innerHTML = '';
  if (!state.selectedHex) return;
  const entries = Object.entries(state.selectedHex.customData || {});
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
      if (nextKey !== key && state.selectedHex.customData && Object.prototype.hasOwnProperty.call(state.selectedHex.customData, nextKey)){
        alert('A field with that name already exists.');
        keyInput.value = key;
        return;
      }
      setCustomField(key, nextKey, state.selectedHex.customData[key]);
    });

    const typeEl = document.createElement('span');
    typeEl.className = 'custom-data-type';
    typeEl.textContent = type;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon-sm danger';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove field';
    removeBtn.addEventListener('click', () => {
      executeAtomicDelta([state.selectedHex], () => delete state.selectedHex.customData[key]);
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

export function refreshSelectedHexPanel(){
  updateSelectedHexInfo();
  const locked = document.getElementById('customDataLocked');
  const editor = document.getElementById('customDataEditor');
  const hasHex = !!state.selectedHex;
  locked.hidden = hasHex;
  editor.hidden = !hasHex;
  document.getElementById('clearSelectionBtn').disabled = !hasHex;
  document.getElementById('setCapitalBtn').disabled = !hasHex || !state.factions.has(state.selectedHex.owner);
  document.getElementById('clearCapitalBtn').disabled = !hasHex || !state.factions.has(state.selectedHex.owner) || getFactionCapitalHex(state.selectedHex.owner) !== state.selectedHex;
  if (hasHex) renderCustomDataRows();
  else document.getElementById('customDataRows').innerHTML = '';
}

document.getElementById('setCapitalBtn').addEventListener('click', () => {
  if (!state.selectedHex || !state.factions.has(state.selectedHex.owner)) return;
  beginAction();
  setFactionCapital(state.selectedHex.owner, state.selectedHex);
  commitAction();
  refreshFactionList();
  refreshSelectedHexPanel();
  render();
  updateInspector(state.selectedHex);
});

document.getElementById('clearCapitalBtn').addEventListener('click', () => {
  if (!state.selectedHex || !state.factions.has(state.selectedHex.owner)) return;
  beginAction();
  setFactionCapital(state.selectedHex.owner, null);
  commitAction();
  refreshFactionList();
  refreshSelectedHexPanel();
  render();
  updateInspector(state.selectedHex);
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
  if (!state.selectedHex) return;
  const key = document.getElementById('customDataKeyInput').value.trim();
  if (!key){ alert('Enter a field name.'); return; }
  if (state.selectedHex.customData && Object.prototype.hasOwnProperty.call(state.selectedHex.customData, key)){
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
  state.selectedHex = null;
  refreshSelectedHexPanel();
  render();
});

document.getElementById('newMapBtn').addEventListener('click', () => {
  const cols = clamp(parseInt(document.getElementById('mapCols').value) || 40, 2, 300);
  const rows = clamp(parseInt(document.getElementById('mapRows').value) || 30, 2, 300);
  if (state.hexes.size > 0 && state.prefConfirmDeletes && !confirm('This replaces the current map. You can undo with Ctrl+Z afterward if needed. Continue?')) return;
  
  pushFullStateUndo();
  generateMap(cols, rows);
  state.selectedHex = null;
  state.hoveredHex = null;
  centerCamera();
  render();
  refreshFactionList();
  refreshLoyaltyList();
  refreshControllerList();
  refreshCultureList();
  refreshRegionList();
  refreshSelectedHexPanel();
});

document.getElementById('centerViewBtn').addEventListener('click', () => {
  centerCamera();
  render();
});

document.getElementById('cleanOceanBtn').addEventListener('click', () => {
  if (state.prefConfirmCleanOcean && !confirm('Remove loyalty, de facto control, culture, and population from all ocean tiles? Faction ownership is kept.')) return;

  beginAction();
  for (const hex of state.hexes.values()){
    if (hex.terrain !== 'ocean') continue;
    if (!hex.population && !hex.loyalty && !hex.controller && !hex.culture) continue;
    markHexForUndo(hex);
    hex.population = 0;
    hex.loyalty = null;
    hex.controller = null;
    hex.culture = null;
  }
  commitAction();

  invalidatePopulationStats();
  refreshFactionList();
  refreshLoyaltyList();
  refreshControllerList();
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
    img.onload = () => { state.bgImage.img = img; render(); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('bgVisibleToggle').addEventListener('change', e => { state.bgImage.visible = e.target.checked; render(); });
document.getElementById('bgOpacitySlider').addEventListener('input', e => { state.bgImage.opacity = e.target.value / 100; render(); });
document.getElementById('bgScaleInput').addEventListener('input', e => { state.bgImage.scale = parseFloat(e.target.value) || 1; render(); });
document.getElementById('bgOffsetX').addEventListener('input', e => { state.bgImage.offsetX = parseFloat(e.target.value) || 0; render(); });
document.getElementById('bgOffsetY').addEventListener('input', e => { state.bgImage.offsetY = parseFloat(e.target.value) || 0; render(); });

export function syncBgInputs(){
  document.getElementById('bgScaleInput').value = Math.round(state.bgImage.scale * 1000) / 1000;
  document.getElementById('bgOffsetX').value = Math.round(state.bgImage.offsetX);
  document.getElementById('bgOffsetY').value = Math.round(state.bgImage.offsetY);
}

function setBackgroundEditMode(active){
  state.backgroundEditMode = active;
  const btn = document.getElementById('bgEditModeToggle');
  btn.textContent = state.backgroundEditMode ? 'Exit Background Edit Mode' : 'Enable Background Edit Mode';
  btn.classList.toggle('btn-primary', state.backgroundEditMode);
  document.getElementById('bgEditBanner').style.display = state.backgroundEditMode ? 'block' : 'none';
  if (state.backgroundEditMode){ state.hoveredHex = null; }
  refreshInteractionUI();
  render();
}

document.getElementById('bgEditModeToggle').addEventListener('click', () => {
  if (!state.backgroundEditMode && !state.bgImage.img){
    alert('Load a background image first.');
    return;
  }
  setBackgroundEditMode(!state.backgroundEditMode);
});

document.getElementById('bgClearBtn').addEventListener('click', () => {
  state.bgImage.img = null;
  document.getElementById('bgFileInput').value = '';
  if (state.backgroundEditMode) setBackgroundEditMode(false);
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
  for (const hex of state.hexes.values()) if (hex.culture) named.add(hex.culture);
  for (const name of named){
    out[name] = { color: ensureCulture(name).color };
  }
  return out;
}

function exportFactions(){
  syncFactionCapitals();
  ensureFactionCodes();
  return sortedFactionNames().map(name => {
    const rec = state.factions.get(name);
    return { ...factionFileEntry(name, rec), hexCount: factionHexCount(name) };
  });
}

/* Kept alongside `factions` so consumers written against the old export keep
   reading colors and capitals without changes. */
function exportOwners(){
  const out = {};
  for (const [name, rec] of state.factions){
    out[name] = { color: rec.color, capital: cloneCapital(rec.capital) };
  }
  return out;
}

function exportMap(){
  const exportHexes = Array.from(state.hexes.values()).map(h => {
    const cloned = { ...h };
    delete cloned.x;
    delete cloned.y;
    delete cloned.isCapital;
    delete cloned.victoryPoint;
    return cloned;
  });

  const data = {
    meta: { version: 9, cols: state.mapCols, rows: state.mapRows, hexSize: HEX_SIZE, exportedAt: new Date().toISOString() },
    factions: exportFactions(),
    owners: exportOwners(),
    cultures: exportCultures(),
    regions: Array.from(state.regions.values()).map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      governor: r.governor,
      faction: r.faction
    })),
    routes: state.routes.map(r => {
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
  downloadJson(data, 'hex-map.json');
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

      state.hexes.clear();
      state.factions.clear();
      invalidateFactionCache();
      state.cultures.clear();
      restoreRegions({ nextId: 1, list: [] });
      state.pathDraft = null;

      // Factions must exist before hexes reference them by name.
      if (Array.isArray(data.factions)){
        data.factions.forEach(raw => {
          const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
          if (name) state.factions.set(name, parseFactionEntry(name, raw));
        });
      } else if (data.owners){
        Object.entries(data.owners).forEach(([name, raw]) => {
          if (name) state.factions.set(name, parseFactionEntry(name, raw));
        });
      }

      restoreRegions(data.regions || { nextId: 1, list: [] });

      data.hexes.forEach(h => {
        if (typeof h.q !== 'number' || typeof h.r !== 'number') return;
        const coords = axialToPixel(h.q, h.r, HEX_SIZE);
        const owner = h.owner || null;
        const loyalty = h.loyalty || null;
        const controller = h.controller || null;
        const culture = h.culture || null;
        const regionId = Number(h.region);
        const regionRec = Number.isFinite(regionId) ? getRegion(regionId) : null;
        const region = (regionRec && owner === regionRec.faction) ? regionRec.id : null;
        const legacyTerrain = LEGACY_TERRAIN_IDS[h.terrain] || h.terrain;
        const terrain = state.TERRAIN_COLORS[legacyTerrain] ? legacyTerrain : 'ocean';
        const elevation = (h.elevation === 'hills' || h.elevation === 'mountains') ? h.elevation : 'flat';
        state.hexes.set(`${h.q},${h.r}`, {
          q: h.q,
          r: h.r,
          x: coords.x,
          y: coords.y,
          terrain,
          elevation,
          population: Number(h.population) || 0,
          owner,
          loyalty,
          controller,
          region,
          culture,
          cityName: h.cityName || null,
          customData: sanitizeCustomData(h.customData)
        });
        if (owner) ensureFaction(owner);
        if (loyalty) ensureFaction(loyalty, { type: 'nonstate' });
        if (controller) ensureFaction(controller, { type: 'nonstate' });
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
      ensureFactionCodes();
      pruneUnusedCultures();
      restoreRoutes(Array.isArray(data.routes) ? data.routes : []);
      refreshPathUi();
      refreshRouteList();
      invalidatePopulationStats();

      if (data.meta){
        state.mapCols = data.meta.cols || state.mapCols;
        state.mapRows = data.meta.rows || state.mapRows;
        document.getElementById('mapCols').value = state.mapCols;
        document.getElementById('mapRows').value = state.mapRows;
      }

      state.selectedHex = null;
      state.hoveredHex = null;
      centerCamera();
      render();
      refreshFactionList();
      refreshLoyaltyList();
      refreshControllerList();
      refreshCultureList();
      refreshRegionList();
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
  state.TERRAIN_DEFS = defs.map(t => {
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
    if (!state.TERRAIN_DEFS.some(t => t.id === def.id)) state.TERRAIN_DEFS.push({ ...def });
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
    state.mapCols = clamp(parseInt(cfg.mapCols, 10) || DEFAULT_MAP_COLS, 2, 300);
    document.getElementById('mapCols').value = state.mapCols;
  }
  if (cfg.mapRows != null){
    state.mapRows = clamp(parseInt(cfg.mapRows, 10) || DEFAULT_MAP_ROWS, 2, 300);
    document.getElementById('mapRows').value = state.mapRows;
  }
  const opacity = parseConfigOpacity(cfg.tileOpacity);
  if (opacity != null){
    state.tileOpacity = opacity;
    document.getElementById('tileOpacitySlider').value = Math.round(state.tileOpacity * 100);
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
    mapCols: state.mapCols,
    mapRows: state.mapRows,
    tileOpacity: state.tileOpacity,
    TERRAIN_DEFS: state.TERRAIN_DEFS.map(t => ({ id: t.id, label: t.label, color: t.color })),
    autosaveMs: state.autosaveIntervalMs,
    maxUndo: state.MAX_UNDO,
    prefConfirmDeletes: state.prefConfirmDeletes,
    prefConfirmCleanOcean: state.prefConfirmCleanOcean,
    prefWarnUnload: state.prefWarnUnload,
    prefPromptRestore: state.prefPromptRestore,
    prefAllowOceanElevPop: state.prefAllowOceanElevPop
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

export function loadSettings(){
  const stored = readStoredSettings();
  applyLoadedSettings(stored || builtInDefaultSettings());
  refreshSettingsStatus(stored
    ? 'Settings are saved in this browser.'
    : 'Using built-in defaults until you click Apply.');
}

export function openModal(id){
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

export function closeModal(id){
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

export function closeOpenModal(){
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
  document.getElementById('settingsPrefConfirmDeletes').checked = state.prefConfirmDeletes;
  document.getElementById('settingsPrefConfirmCleanOcean').checked = state.prefConfirmCleanOcean;
  document.getElementById('settingsPrefWarnUnload').checked = state.prefWarnUnload;
  document.getElementById('settingsPrefPromptRestore').checked = state.prefPromptRestore;
  document.getElementById('settingsPrefOceanElevPop').checked = state.prefAllowOceanElevPop;
  document.getElementById('settingsAutosave').value = String(state.autosaveIntervalMs || 0);
  document.getElementById('settingsMaxUndo').value = state.MAX_UNDO;
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
  state.mapCols = cols;
  state.mapRows = rows;

  state.MAX_UNDO = Math.max(1, parseInt(document.getElementById('settingsMaxUndo').value, 10) || DEFAULT_MAX_UNDO);
  while (state.undoStack.length > state.MAX_UNDO) state.undoStack.shift();
  const autosaveMs = parseInt(document.getElementById('settingsAutosave').value, 10) || 0;
  state.prefConfirmDeletes = document.getElementById('settingsPrefConfirmDeletes').checked;
  state.prefConfirmCleanOcean = document.getElementById('settingsPrefConfirmCleanOcean').checked;
  state.prefWarnUnload = document.getElementById('settingsPrefWarnUnload').checked;
  state.prefPromptRestore = document.getElementById('settingsPrefPromptRestore').checked;
  state.prefAllowOceanElevPop = document.getElementById('settingsPrefOceanElevPop').checked;
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
