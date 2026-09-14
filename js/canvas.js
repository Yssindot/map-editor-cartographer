import { state } from './state.js';

export const canvas = document.getElementById('mapCanvas');
export const ctx = canvas.getContext('2d');
export const canvasWrap = document.getElementById('canvasWrap');
export const hudStatsEl = document.getElementById('hud-stats');
export const inspectorHudEl = document.getElementById('inspector-hud');

export function screenToWorld(mx, my){
  return {
    x: (mx - canvas.width / 2) / state.camera.zoom + state.camera.x,
    y: (my - canvas.height / 2) / state.camera.zoom + state.camera.y
  };
}
