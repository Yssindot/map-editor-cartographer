import { clamp } from './hexMath.js';

export function hslToHex(h, s, l){
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export function parseHexColor(hex){
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return { r: 138, g: 144, b: 152 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

export function rgbToHsl(r, g, b){
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

export function shiftHexHue(hex, dHue, sMul = 1, lMul = 1){
  const { r, g, b } = parseHexColor(hex);
  const hsl = rgbToHsl(r, g, b);
  return hslToHex((hsl.h + dHue + 360) % 360, clamp(hsl.s * sMul, 0, 100), clamp(hsl.l * lMul, 5, 92));
}

export function nameHash(name){
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return hash;
}

export function computeOwnerColor(name){
  return hslToHex(Math.abs(nameHash(name)) % 360, 65, 55);
}

export function computeCultureColor(name){
  return hslToHex(Math.abs(nameHash(name + '\u0001culture')) % 360, 58, 52);
}

export function grayLoyaltyColor(name){
  const hash = nameHash(name);
  return hslToHex(Math.abs(hash) % 360, 8 + Math.abs(hash >> 8) % 8, 46 + Math.abs(hash >> 4) % 14);
}

