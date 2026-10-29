/** Routing: the cheapest chain of edges between two kinds (Dijkstra; graphs here are tiny). */
import type { Kind, Step } from './types.js';

/** Cheapest path from `from` to `to`; `[]` when they are equal, `undefined` when unreachable. */
export function cheapestRoute(edges: readonly Step[], from: Kind, to: Kind): Step[] | undefined {
  if (from === to) return [];
  const best = new Map<Kind, { cost: number; via?: Step }>([[from, { cost: 0 }]]);
  const done = new Set<Kind>();
  for (;;) {
    let node: Kind | undefined;
    let cost = Infinity;
    for (const [k, v] of best) if (!done.has(k) && v.cost < cost) [node, cost] = [k, v.cost];
    if (node === undefined) return undefined;
    if (node === to) break;
    done.add(node);
    for (const e of edges) {
      if (e.from !== node || done.has(e.to)) continue;
      const c = cost + e.cost;
      if (c < (best.get(e.to)?.cost ?? Infinity)) best.set(e.to, { cost: c, via: e });
    }
  }
  const path: Step[] = [];
  for (let k = to; k !== from; ) {
    const via = best.get(k)!.via!;
    path.unshift(via);
    k = via.from;
  }
  return path;
}
