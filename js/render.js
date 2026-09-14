import { state } from './state.js';
import {
  HEX_SIZE, ELEVATION_LABELS, ROUTE_BY_ID, ROUTE_DRAW_ORDER, PATH_INVALID_COLOR
} from './constants.js';
import { NEIGHBOR_DIRS, axialToPixel, hexRange, edgeSegment } from './hexMath.js';
import { shiftHexHue } from './color.js';
import { canvas, ctx, canvasWrap, hudStatsEl, inspectorHudEl, screenToWorld } from './canvas.js';
import {
  factionColor, loyaltyFillColor, controllerFillColor, cultureColor, factionsWithCapitalAt, hexIsCapital,
  getPopulationStats, getHeatmapColor, formatPop, updateHeatmapLegend,
  getToolDef, skipOceanForTool, isWaterHex, routeWorldPolylines,
  validatePath, cloneWaypoints, getSelectedRoute, findRouteAtHex, isRouteBusy,
  routesOnHex, hexRegion, getRegion
} from './domain.js';

export function drawBackgroundImage(){
  if (!state.bgImage.img || !state.bgImage.visible) return;
  ctx.save();
  ctx.globalAlpha = state.bgImage.opacity;
  const w = state.bgImage.img.width * state.bgImage.scale;
  const h = state.bgImage.img.height * state.bgImage.scale;
  ctx.drawImage(state.bgImage.img, state.bgImage.offsetX - w / 2, state.bgImage.offsetY - h / 2, w, h);
  ctx.restore();
}

export function getFillColor(hex){
  const baseColor = state.viewLayers.terrain ? (state.TERRAIN_COLORS[hex.terrain] || state.TERRAIN_COLORS.ocean) : '#161b20';
  if (state.viewLayers.elevation){
    if (hex.elevation === 'hills') return shiftHexHue(baseColor, 0, 1, 0.82);
    if (hex.elevation === 'mountains') return shiftHexHue(baseColor, 0, 0.85, 0.60);
  }
  return baseColor;
}

export function addHexToPath(ctx, cx, cy, size){
  for (let i = 0; i < 6; i++){
    const angleRad = Math.PI / 180 * (60 * i - 30);
    const px = cx + size * Math.cos(angleRad);
    const py = cy + size * Math.sin(angleRad);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function drawHexes(){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 2;
  
  const batches = new Map();
  const visibleHexes = [];

  for (const hex of state.hexes.values()){
    if (hex.x < tl.x - margin || hex.x > br.x + margin || hex.y < tl.y - margin || hex.y > br.y + margin) continue;
    visibleHexes.push(hex);
    
    const color = getFillColor(hex);
    if (!batches.has(color)) batches.set(color, []);
    batches.get(color).push(hex);
  }

  // 1. Draw Base Fills
  ctx.save();
  ctx.globalAlpha = state.tileOpacity;
  for (const [color, batch] of batches.entries()){
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const hex of batch) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    ctx.fill();
  }
  ctx.restore();

  const overlayAlpha = overlayFillAlpha();

  // 2. Draw Ownership Tints
  if (state.viewLayers.ownership){
    drawTintBatches(visibleHexes, hex => hex.owner ? factionColor(hex.owner) : null, overlayAlpha);
  }

  // 3. Draw Loyalty Tints
  if (state.viewLayers.loyalty){
    drawTintBatches(visibleHexes, loyaltyFillColor, overlayAlpha);
  }

  // 4. Draw De Facto Control Hatch
  if (state.viewLayers.controller){
    drawHatchBatches(visibleHexes, controllerFillColor, overlayAlpha);
  }

  // 5. Draw Culture Tints
  if (state.viewLayers.culture){
    drawTintBatches(visibleHexes, hex => hex.culture ? cultureColor(hex.culture) : null, overlayAlpha);
  }

  // 6. Draw Population Heatmap
  if (state.viewLayers.population) {
    const maxPop = getPopulationStats().max || 1;
    ctx.save();
    ctx.globalAlpha = 0.78 * state.tileOpacity;
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

  // 7. Draw grid edges (full honeycomb, or merge matching terrain/elevation)
  ctx.beginPath();
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  if (state.showFullGrid){
    for (const hex of visibleHexes) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
  } else {
    for (const hex of visibleHexes){
      for (const dir of NEIGHBOR_DIRS){
        const neighbor = state.hexes.get(`${hex.q + dir.q},${hex.r + dir.r}`);
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

export function overlayFillAlpha(){
  const overlays = [state.viewLayers.ownership, state.viewLayers.loyalty, state.viewLayers.controller, state.viewLayers.culture].filter(Boolean).length;
  const base = state.viewLayers.terrain ? 0.3 : (overlays > 1 ? 0.5 : 1.0);
  return base * state.tileOpacity;
}

export function drawTintBatches(visibleHexes, getColor, alpha){
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

const hatchPatternCache = new Map();

function hatchPatternFor(color){
  let pattern = hatchPatternCache.get(color);
  if (pattern) return pattern;
  const size = 10;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const g = tile.getContext('2d');
  g.strokeStyle = color;
  g.lineWidth = 2.2;
  g.lineCap = 'square';
  g.beginPath();
  g.moveTo(-2, size - 2);
  g.lineTo(size - 2, -2);
  g.moveTo(2, size + 2);
  g.lineTo(size + 2, 2);
  g.stroke();
  pattern = ctx.createPattern(tile, 'repeat');
  hatchPatternCache.set(color, pattern);
  return pattern;
}

/* Diagonal stripes instead of a flat tint, so de facto control stays readable
   on top of ownership and loyalty color fills. */
export function drawHatchBatches(visibleHexes, getColor, alpha){
  const batches = new Map();
  for (const hex of visibleHexes){
    const color = getColor(hex);
    if (!color) continue;
    if (!batches.has(color)) batches.set(color, []);
    batches.get(color).push(hex);
  }
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha + 0.22);
  for (const [color, batch] of batches.entries()){
    const pattern = hatchPatternFor(color);
    if (!pattern) continue;
    ctx.fillStyle = pattern;
    ctx.beginPath();
    for (const hex of batch) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    ctx.fill();
  }
  ctx.restore();
}

export function drawFieldBorders(getValue, getColor, { dash = [], width = 3, shouldStroke } = {}){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 2;
  ctx.lineWidth = width / state.camera.zoom;
  ctx.lineCap = 'round';
  ctx.setLineDash(dash.map(d => d / state.camera.zoom));

  for (const hex of state.hexes.values()){
    const value = getValue(hex);
    if (!value) continue;
    if (hex.x < tl.x - margin || hex.x > br.x + margin || hex.y < tl.y - margin || hex.y > br.y + margin) continue;

    ctx.strokeStyle = getColor(hex, value);
    for (const dir of NEIGHBOR_DIRS){
      const neighbor = state.hexes.get(`${hex.q + dir.q},${hex.r + dir.r}`);
      if (shouldStroke && !shouldStroke(hex, neighbor, dir)) continue;
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

export function drawOwnershipBorders(){
  if (!state.viewLayers.ownership) return;
  drawFieldBorders(hex => hex.owner, (hex, name) => factionColor(name), { width: 3 });
}

export function drawRegionBorders(){
  if (!state.viewLayers.regions) return;
  drawFieldBorders(
    hex => (hex.region && getRegion(hex.region) && hex.owner) ? hex.region : null,
    hex => {
      const rec = getRegion(hex.region);
      const base = rec ? factionColor(rec.faction) : '#e8d6a0';
      return shiftHexHue(base, 22, 0.7, 1.28);
    },
    {
      width: 1.7,
      dash: [5, 3, 1.4, 3],
      shouldStroke(hex, neighbor){
        if (!neighbor || !neighbor.owner || neighbor.owner !== hex.owner) return false;
        return true;
      }
    }
  );
}

export function drawLoyaltyBorders(){
  if (!state.viewLayers.loyalty) return;
  drawFieldBorders(hex => hex.loyalty, hex => loyaltyFillColor(hex), { width: 2.4, dash: [7, 5] });
}

export function drawControllerBorders(){
  if (!state.viewLayers.controller) return;
  drawFieldBorders(
    hex => (hex.controller && hex.controller !== hex.owner) ? hex.controller : null,
    hex => controllerFillColor(hex),
    { width: 2.6, dash: [3, 3, 10, 3] }
  );
}

export function drawCultureBorders(){
  if (!state.viewLayers.culture) return;
  drawFieldBorders(hex => hex.culture, (hex, name) => cultureColor(name), { width: 2.2, dash: [2, 4] });
}

export function starPath(cx, cy, outerR, innerR, points){
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

export function drawCityLabels(){
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(canvas.width, canvas.height);
  const margin = HEX_SIZE * 3;
  const fontSize = Math.max(10, HEX_SIZE * 0.42);
  
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = fontSize * 0.22;

  for (const hex of state.hexes.values()){
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

export function strokePolylines(lines, width, color, outline){
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

export function drawRouteStyle(waypoints, styleId, alpha){
  const def = ROUTE_BY_ID[styleId];
  if (!def) return;
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  strokePolylines(routeWorldPolylines(waypoints, styleId), def.width, def.color, def.outline);
  ctx.restore();
}

export function drawEndpointMarker(hex, color){
  if (!hex) return;
  ctx.beginPath();
  ctx.arc(hex.x, hex.y, HEX_SIZE * 0.16, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = HEX_SIZE * 0.045;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
}

export function drawRoutes(){
  if (!state.viewLayers.routes) return;
  const ordered = state.routes.slice().sort((a, b) => {
    const oa = ROUTE_DRAW_ORDER[a.style] ?? 0;
    const ob = ROUTE_DRAW_ORDER[b.style] ?? 0;
    if (oa !== ob) return oa - ob;
    return a.id - b.id;
  });
  const isPathTool = getToolDef().kind === 'path';
  const highlight = isPathTool
    ? (getSelectedRoute() || (state.hoveredHex ? findRouteAtHex(state.hoveredHex) : null))
    : null;

  for (const r of ordered){
    if (isRouteBusy(r.id)) continue;
    drawRouteStyle(r.waypoints, r.style, 1);
  }

  if (highlight && !isRouteBusy(highlight.id)){
    const def = ROUTE_BY_ID[highlight.style];
    ctx.save();
    ctx.globalAlpha = highlight.id === state.selectedRouteId ? 0.6 : 0.45;
    strokePolylines(
      routeWorldPolylines(highlight.waypoints, highlight.style),
      (def ? def.width : HEX_SIZE * 0.2) + HEX_SIZE * 0.12,
      '#ffffff',
      null
    );
    ctx.restore();
  }
}

export function draftWaypointsWithHover(){
  if (!state.pathDraft) return [];
  const pts = cloneWaypoints(state.pathDraft.waypoints);
  if (state.hoveredHex){
    const last = pts[pts.length - 1];
    if (!last || last.q !== state.hoveredHex.q || last.r !== state.hoveredHex.r){
      pts.push({ q: state.hoveredHex.q, r: state.hoveredHex.r });
    }
  }
  return pts;
}

export function drawPathPreview(waypoints, styleId, check){
  const def = ROUTE_BY_ID[styleId] || {};
  const cells = check.cells;
  if (cells.length >= 2){
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = def.color || '#8fd4ff';
    ctx.beginPath();
    for (const cell of cells){
      if (check.blocked.has(`${cell.q},${cell.r}`)) continue;
      const hex = state.hexes.get(`${cell.q},${cell.r}`);
      if (hex) addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
    }
    ctx.fill();

    if (check.blocked.size > 0){
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = PATH_INVALID_COLOR;
      ctx.beginPath();
      for (const key of check.blocked){
        const hex = state.hexes.get(key);
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

export function drawWaypointHandles(waypoints, color, activeIndex){
  waypoints.forEach((w, i) => {
    const hex = state.hexes.get(`${w.q},${w.r}`);
    if (!hex) return;
    drawEndpointMarker(hex, i === activeIndex ? '#ffffff' : color);
  });
}

export function drawPathOverlay(){
  if (getToolDef().kind !== 'path' || state.backgroundEditMode) return;

  if (state.routeDrag){
    const route = state.routes.find(r => r.id === state.routeDrag.routeId);
    if (route){
      const check = validatePath(state.routeDrag.waypoints, state.routeDrag.routeId);
      drawPathPreview(state.routeDrag.waypoints, route.style, check);
      drawWaypointHandles(state.routeDrag.waypoints, (ROUTE_BY_ID[route.style] || {}).color, state.routeDrag.index);
    }
    return;
  }

  if (state.brush.pathMode === 'edit'){
    const route = getSelectedRoute();
    if (route) drawWaypointHandles(route.waypoints, (ROUTE_BY_ID[route.style] || {}).color, -1);
    return;
  }

  if (state.brush.pathMode === 'draw' && state.viewLayers.routes){
    for (const r of state.routes){
      if (r.style !== state.brush.routeStyle) continue;
      if (isRouteBusy(r.id)) continue;
      const start = r.waypoints[0];
      const end = r.waypoints[r.waypoints.length - 1];
      const startHex = start ? state.hexes.get(`${start.q},${start.r}`) : null;
      const endHex = end ? state.hexes.get(`${end.q},${end.r}`) : null;
      const def = ROUTE_BY_ID[r.style];
      if (startHex) drawEndpointMarker(startHex, def.color);
      if (endHex && endHex !== startHex) drawEndpointMarker(endHex, def.color);
    }
  }

  if (!state.pathDraft) return;

  const previewPts = draftWaypointsWithHover();
  drawPathPreview(previewPts, state.pathDraft.style, validatePath(previewPts, state.pathDraft.routeId));
  drawWaypointHandles(state.pathDraft.waypoints, (ROUTE_BY_ID[state.pathDraft.style] || {}).color || '#fff', -1);
}

export function drawBrushPreview() {
  const tool = getToolDef();
  if (!state.hoveredHex || state.backgroundEditMode || state.capitalPickMode || tool.kind !== 'paint') return;
  const targets = hexRange(state.hoveredHex.q, state.hoveredHex.r, state.brush.size - 1);
  ctx.beginPath();
  for (const t of targets) {
    const h = state.hexes.get(`${t.q},${t.r}`);
    if (h && !(skipOceanForTool(tool) && isWaterHex(h))) addHexToPath(ctx, h.x, h.y, HEX_SIZE);
  }
  ctx.fillStyle = tool.previewFill || 'rgba(255, 255, 255, 0.15)';
  ctx.fill();
}

export function drawHexOutline(hex, color, dash){
  ctx.beginPath();
  addHexToPath(ctx, hex.x, hex.y, HEX_SIZE);
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.strokeStyle = color;
  if (dash) {
    ctx.save();
    ctx.setLineDash([6 / state.camera.zoom, 4 / state.camera.zoom]);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.stroke();
  }
}

export function render(){
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(state.camera.zoom, state.camera.zoom);
  ctx.translate(-state.camera.x, -state.camera.y);

  drawBackgroundImage();
  drawHexes();
  drawOwnershipBorders();
  drawRegionBorders();
  drawLoyaltyBorders();
  drawControllerBorders();
  drawCultureBorders();
  drawRoutes();
  drawPathOverlay();
  drawCityLabels();
  
  drawBrushPreview();
  if (state.selectedHex) drawHexOutline(state.selectedHex, '#4fc3ff', true);
  if (state.hoveredHex && !state.backgroundEditMode) drawHexOutline(state.hoveredHex, '#ffffff', false);

  ctx.restore();
  updateHeatmapLegend();
  updateHud();
}

export function updateHud(){
  const stats = getPopulationStats();
  const heat = state.viewLayers.population ? ` &nbsp; Pop max: <b>${formatPop(stats.max)}</b>` : '';
  const tool = getToolDef();
  hudStatsEl.innerHTML = `Tool: <b>${tool.label}</b> &nbsp; Zoom: <b>${Math.round(state.camera.zoom * 100)}%</b> &nbsp; Hex: <b>${state.hoveredHex ? state.hoveredHex.q + ', ' + state.hoveredHex.r : '—'}</b> &nbsp; Tiles: <b>${state.hexes.size}</b>${heat}`;
}

export function updateInspector(hex){
  if (!hex){ inspectorHudEl.innerHTML = ''; return; }
  const terrainLabel = (state.TERRAIN_DEFS.find(t => t.id === hex.terrain) || {}).label || hex.terrain;
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
  const regionRec = hexRegion(hex);
  const regionHtml = regionRec
    ? `<div class="inspector-row"><b>Region</b> ${regionRec.name} (${regionRec.type})${regionRec.governor ? ' · ' + regionRec.governor : ''}</div>`
    : '';
  inspectorHudEl.innerHTML = `
    <div class="inspector-row"><b>Coord</b> ${hex.q}, ${hex.r}</div>
    <div class="inspector-row"><b>Terrain</b> ${terrainLabel}</div>
    <div class="inspector-row"><b>Elevation</b> ${ELEVATION_LABELS[hex.elevation] || hex.elevation || 'Flat'}</div>
    <div class="inspector-row"><b>Population</b> ${hex.population}</div>
    <div class="inspector-row"><b>Faction</b> ${hex.owner || '—'}</div>
    ${regionHtml}
    ${capitalHtml}
    ${hex.controller && hex.controller !== hex.owner ? `<div class="inspector-row"><b>De facto</b> ${hex.controller}</div>` : ''}
    <div class="inspector-row"><b>Loyalty</b> ${hex.loyalty || '—'}</div>
    <div class="inspector-row"><b>Culture</b> ${hex.culture || '—'}</div>
    <div class="inspector-row"><b>City</b> ${hex.cityName || '—'}</div>
    ${routesHtml}
    ${customHtml}
  `;
}

export function resizeCanvas(){
  hatchPatternCache.clear();
  const rect = canvasWrap.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  render();
}
window.addEventListener('resize', resizeCanvas);
