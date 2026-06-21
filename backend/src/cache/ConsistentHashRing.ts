/**
 * ConsistentHashRing — our own consistent-hashing implementation.
 *
 * WHY this module exists (and why we do NOT use Redis Cluster):
 * The assignment requires the cache layer to be *distributed using consistent
 * hashing*, and the student must be able to explain every line in a viva. Redis
 * Cluster would hide the routing inside a black box. By owning the ring we can
 * point at exact code for "which node owns this prefix" and the `/cache/debug`
 * endpoint can show the chosen node + ring position. This whole file is the
 * answer to "explain your consistent hashing".
 *
 * THE CORE PROBLEM consistent hashing solves:
 * The naive way to spread keys over N cache nodes is `hash(key) % N`. That is
 * cheap, but the moment N changes (a node is added or dies), the modulus changes
 * for *almost every key*, so ~all keys move to a different node and the cache is
 * effectively wiped. Consistent hashing instead maps both keys and nodes onto one
 * fixed circular keyspace; a key is owned by the next node clockwise. Adding or
 * removing a node only re-homes the keys in the arc that node covers — about K/N
 * of the keys — leaving the rest where they were. That is the headline property
 * we demonstrate in ring.test.ts.
 *
 * WHY virtual nodes:
 * With only 3 physical nodes placed once each, the three arcs between them are
 * random and usually very uneven — one node could own 60% of the keyspace. To fix
 * this we place each physical node at MANY positions on the ring ("virtual nodes").
 * Many small arcs per node average out, giving an even load, and when a node leaves
 * its load is spread across all the others rather than dumped on one neighbour.
 * The count comes from config.ringVirtualNodes (default 150) — see config.ts for
 * the rationale of that specific number.
 *
 * This is a PURE module: no Redis, no Express, no I/O. It only decides ownership,
 * so it is fully unit-testable on its own (see backend/test/ring.test.ts).
 */

import { createHash } from "node:crypto";

/** One point on the ring: a hash position mapped to the physical node that owns it. */
interface RingPoint {
  /** Position on the 32-bit ring (0 .. 2^32-1). */
  hash: number;
  /** The physical node id this virtual point belongs to (e.g. "redis-0"). */
  node: string;
}

/** Diagnostic detail for one lookup, surfaced by the /cache/debug endpoint. */
export interface NodePosition {
  /** The (normalized) key that was looked up. */
  key: string;
  /** Where the key hashed to on the ring. */
  keyHash: number;
  /** The ring position we landed on (first point clockwise >= keyHash, with wrap). */
  ringPosition: number;
  /** The physical node that owns that position. */
  node: string;
}

export class ConsistentHashRing {
  /**
   * The ring, kept as an array of points SORTED ascending by hash. We sort once
   * on every rebuild so that getNode can binary-search it in O(log V) instead of
   * scanning all V points — important because there are nodes * virtualNodes points
   * (e.g. 3 * 150 = 450) and getNode is on the hot read path for every keystroke.
   */
  private ring: RingPoint[] = [];

  /** The set of physical nodes currently on the ring (insertion order preserved). */
  private nodes: string[];

  /** How many virtual points to place per physical node. */
  private readonly virtualNodes: number;

  /**
   * @param nodes        physical node ids, e.g. ["redis-0","redis-1","redis-2"]
   * @param virtualNodes virtual points per physical node (from config.ringVirtualNodes)
   */
  constructor(nodes: string[], virtualNodes: number) {
    if (nodes.length === 0) {
      // A ring with no nodes can never answer getNode; fail loudly at construction
      // rather than returning undefined later on the read path.
      throw new Error("ConsistentHashRing requires at least one node");
    }
    if (virtualNodes < 1) {
      throw new Error("virtualNodes must be >= 1");
    }
    // Copy the array so external mutation of the caller's list can't corrupt the ring.
    this.nodes = [...nodes];
    this.virtualNodes = virtualNodes;
    this.rebuild();
  }

  /**
   * Stable hash → an unsigned 32-bit integer position on the ring.
   *
   * WHY md5 (and not Math.random or JS string hashing):
   *  - It MUST be deterministic and stable across process restarts: the same key
   *    must always land on the same node, otherwise a "hit" written before a
   *    restart becomes a "miss" after, and node ownership would shuffle on every
   *    boot. Math.random is therefore disqualified outright.
   *  - md5 is in Node's stdlib (no dependency), is well-distributed (its avalanche
   *    property spreads even near-identical keys like "ip" and "iph" far apart on
   *    the ring), and we only need its bits for placement — we are NOT using it for
   *    security, so md5 being cryptographically retired does not matter here.
   *  - We take the first 8 hex chars = 32 bits and read them as an unsigned int,
   *    giving a ring of size 2^32. 32 bits is plenty of spread for a few hundred
   *    points; using the whole 128-bit digest would need BigInt for no real benefit.
   *
   * (FNV-1a would also satisfy "stable + no deps"; we picked md5 because Node ships
   * it and the >>> 0 / parseInt steps are easy to point at and explain in a viva.)
   */
  private hash(input: string): number {
    const digest = createHash("md5").update(input).digest("hex");
    // parseInt of 8 hex chars yields 0 .. 2^32-1; >>> 0 forces unsigned 32-bit.
    return parseInt(digest.slice(0, 8), 16) >>> 0;
  }

  /**
   * Rebuild the entire ring from the current node set. Called by the constructor
   * and by addNode/removeNode. With only ~450 points a full rebuild is trivially
   * fast and far simpler to reason about (and to defend in a viva) than trying to
   * splice points in and out in place — clarity over cleverness, by design.
   */
  private rebuild(): void {
    const points: RingPoint[] = [];
    for (const node of this.nodes) {
      for (let i = 0; i < this.virtualNodes; i++) {
        // Each virtual point gets a distinct, deterministic label "node#i" so the
        // same node always lands on the same set of positions. The "#i" suffix is
        // what scatters one physical node across the whole ring.
        points.push({ hash: this.hash(`${node}#${i}`), node });
      }
    }
    // Sort ascending by hash so getNode can binary-search for the owning point.
    points.sort((a, b) => a.hash - b.hash);
    this.ring = points;
  }

  /**
   * getNode — return the physical node id that owns `key`.
   *
   * Algorithm: hash the key to a ring position, then walk CLOCKWISE to the first
   * virtual point whose hash is >= the key's hash; that point's physical node owns
   * the key. If the key's hash is past the last point, we WRAP around to the first
   * point (the ring is circular). The clockwise walk is done with a binary search.
   */
  getNode(key: string): string {
    return this.getNodePosition(key).node;
  }

  /**
   * getNodePosition — same lookup as getNode but returns the full diagnostic record
   * (key hash, the ring position we landed on, owning node). The /cache/debug
   * endpoint uses this to *show* the routing, which is how we prove the ring works.
   */
  getNodePosition(key: string): NodePosition {
    const keyHash = this.hash(key);
    const idx = this.firstPointAtOrAfter(keyHash);
    // Wrap: if no point is >= keyHash, the owner is the first point on the ring.
    const point = idx === this.ring.length ? this.ring[0] : this.ring[idx];
    return {
      key,
      keyHash,
      ringPosition: point.hash,
      node: point.node,
    };
  }

  /**
   * Binary search for the index of the first ring point with hash >= target.
   * Returns ring.length if every point is < target (caller then wraps to index 0).
   *
   * WHY binary search: the ring is sorted, and this runs for every prefix lookup,
   * so O(log V) beats an O(V) linear scan. This is a textbook lower-bound search.
   */
  private firstPointAtOrAfter(target: number): number {
    let lo = 0;
    let hi = this.ring.length; // exclusive upper bound
    while (lo < hi) {
      const mid = (lo + hi) >>> 1; // unsigned shift = floor((lo+hi)/2), avoids overflow
      if (this.ring[mid].hash < target) {
        lo = mid + 1; // mid is too small; the answer is to its right
      } else {
        hi = mid; // mid qualifies; look left for an even earlier qualifying point
      }
    }
    return lo;
  }

  /**
   * addNode — put a new physical node on the ring.
   *
   * Demonstrates the consistent-hashing win: only keys that now fall into the new
   * node's arcs move to it; every other key keeps its previous owner. We rebuild
   * the whole ring for simplicity, but the *ownership outcome* is the same as an
   * in-place insert, which is what ring.test.ts asserts (< ~35% of keys move).
   */
  addNode(id: string): void {
    if (this.nodes.includes(id)) return; // idempotent: re-adding is a no-op, not a doubling
    this.nodes.push(id);
    this.rebuild();
  }

  /**
   * removeNode — take a physical node off the ring (e.g. it died).
   *
   * Only the keys that were owned by the removed node get reassigned — to whichever
   * node is now next clockwise from each of the removed virtual points. Keys owned
   * by surviving nodes are untouched. ring.test.ts verifies exactly this.
   */
  removeNode(id: string): void {
    if (!this.nodes.includes(id)) return; // removing an absent node is a harmless no-op
    if (this.nodes.length === 1) {
      // Refuse to empty the ring: getNode would have no node to return.
      throw new Error(`Cannot remove the last node "${id}" from the ring`);
    }
    this.nodes = this.nodes.filter((n) => n !== id);
    this.rebuild();
  }

  /** The physical nodes currently on the ring (copy, so callers can't mutate state). */
  getNodes(): string[] {
    return [...this.nodes];
  }

  /**
   * stats — count how many of the given sample keys land on each node.
   *
   * This is the evidence for the "virtual nodes give an even distribution" claim:
   * feed it a large sample of real prefix keys and the per-node counts should be
   * roughly balanced (within a tolerance). Used by ring.test.ts and can back a
   * line in the performance report. If no sample is supplied we report zeros per
   * node, since distribution is only meaningful relative to a key population.
   */
  stats(sampleKeys: string[] = []): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const node of this.nodes) counts[node] = 0; // ensure every node appears, even with 0 keys
    for (const key of sampleKeys) {
      counts[this.getNode(key)]++;
    }
    return counts;
  }
}
