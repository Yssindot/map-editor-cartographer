export const HEX_SIZE = 22;
export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 5;
export const DEFAULT_MAX_UNDO = 30;

export const DEFAULT_MAP_COLS = 40;
export const DEFAULT_MAP_ROWS = 30;
export const DEFAULT_TILE_OPACITY = 1;
export const DEFAULT_TERRAIN_DEFS = [
  { id:'ocean',     label:'Ocean',     color:'#1c4a63' },
  { id:'grassland', label:'Grassland', color:'#9dbb61' },
  { id:'forest',    label:'Forest',    color:'#2f5b34' },
  { id:'steppe',    label:'Steppe',    color:'#b5a672' },
  { id:'desert',    label:'Desert',    color:'#e0be75' },
  { id:'extreme_desert', label:'Extreme Desert', color:'#8c6a47' },
  { id:'urban',     label:'Urban',     color:'#3a3a42' },
  { id:'urban_ruins', label:'Urban Ruins', color:'#5a5248' }
];
export const LEGACY_TERRAIN_IDS = { plains: 'grassland', river: 'grassland' };
export const APP_VERSION = '0.9.2';
export const MAP_META_VERSION = 12;

export const ELEVATION_DEFS = [
  { id:'flat',      label:'Flat' },
  { id:'hills',     label:'Hills' },
  { id:'mountains', label:'Mountains' }
];
export const ELEVATION_LABELS = Object.fromEntries(ELEVATION_DEFS.map(e => [e.id, e.label]));

export const ROUTE_DEFS = [
  { id:'river1',  kind:'river',   type:1, label:'Shallow River', color:'#8fd4ff', outline:'#3a8ec4', width: HEX_SIZE * 0.14 },
  { id:'river2',  kind:'river',   type:2, label:'Deep River',    color:'#2f7eb8', outline:'#163e63', width: HEX_SIZE * 0.36 },
  { id:'channel', kind:'channel', type:1, label:'Channel',       color:'#3ec8b8', outline:'#15665c', width: HEX_SIZE * 0.20 },
  { id:'dirt',    kind:'road',    type:1, label:'Dirt Road',      color:'#d2a66a', outline:'#7a5c32', width: HEX_SIZE * 0.22 },
  { id:'asphalt', kind:'road',    type:2, label:'Asphalt Road',   color:'#8a9098', outline:'#3d4148', width: HEX_SIZE * 0.22 }
];
export const ROUTE_BY_ID = Object.fromEntries(ROUTE_DEFS.map(d => [d.id, d]));
export const ROUTE_DRAW_ORDER = { river1: 0, river2: 1, channel: 2, dirt: 3, asphalt: 4 };
export const PATH_INVALID_COLOR = '#ff5a5a';

export const DEFAULT_BUILDING_TYPES = [
  { building_id: 'outpost', name: 'Outpost', icon: 'shield' },
  { building_id: 'embassy', name: 'Embassy', icon: 'landmark' },
  { building_id: 'covert_camp', name: 'Covert Camp', icon: 'tent' },
  { building_id: 'facility', name: 'Industrial Facility', icon: 'factory' },
  { building_id: 'depot', name: 'Supply Depot', icon: 'box' }
];

export const FACTION_TYPES = [
  { id: 'state',     label: 'State' },
  { id: 'nonstate',  label: 'Non-State Actor' },
  { id: 'corporate', label: 'Corporate Entity' },
  { id: 'rebel',     label: 'Rebel / Insurgent' },
  { id: 'religious', label: 'Religious Order' },
  { id: 'other',     label: 'Other' }
];
export const FACTION_TYPE_LABELS = Object.fromEntries(FACTION_TYPES.map(t => [t.id, t.label]));
export const FACTION_CODE_LEN = 4;
export const FLAG_MAX_EDGE = 256;

export const HEATMAP_STOPS = [
  { t: 0,    c: [12, 44, 84] },
  { t: 0.25, c: [29, 145, 192] },
  { t: 0.5,  c: [255, 237, 160] },
  { t: 0.75, c: [252, 141, 89] },
  { t: 1,    c: [215, 48, 39] }
];

export const AUTOSAVE_KEY = 'cartographer_autosave';
export const SETTINGS_KEY = 'cartographer_settings';
export const DEFAULT_AUTOSAVE_MS = 2 * 60 * 1000;
