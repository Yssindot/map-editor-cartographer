export function axialToPixel(q, r, size){
  return {
    x: size * (Math.sqrt(3) * q + Math.sqrt(3) / 2 * r),
    y: size * (1.5 * r)
  };
}

export function pixelToAxial(x, y, size){
  return {
    q: (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size,
    r: (2 / 3 * y) / size
  };
}

export function axialRound(q, r){
  let x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

export function offsetToAxial(col, row){
  const q = col - (row - (row & 1)) / 2;
  const r = row;
  return { q, r };
}

export function hexRange(centerQ, centerR, radius){
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

export const NEIGHBOR_DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }
];

export function edgeSegment(centerA, centerB, size){
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

export function clamp(v, min, max){ return Math.min(max, Math.max(min, v)); }

export function axialDistance(q1, r1, q2, r2){
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

export function hexLine(q1, r1, q2, r2){
  const n = axialDistance(q1, r1, q2, r2);
  const results = [];
  const q2n = q2 + 1e-6, r2n = r2 + 2e-6;
  for (let i = 0; i <= n; i++){
    const t = n === 0 ? 0 : i / n;
    results.push(axialRound(q1 + (q2n - q1) * t, r1 + (r2n - r1) * t));
  }
  return results;
}

export function expandWaypoints(waypoints){
  if (!waypoints || waypoints.length === 0) return [];
  const out = [{ q: waypoints[0].q, r: waypoints[0].r }];
  for (let i = 1; i < waypoints.length; i++){
    const seg = hexLine(waypoints[i - 1].q, waypoints[i - 1].r, waypoints[i].q, waypoints[i].r);
    for (let j = 1; j < seg.length; j++) out.push(seg[j]);
  }
  return out;
}
