/**
 * Unit tests for the ConsistentHashRing.
 *
 * These tests are the *provable evidence* behind the viva claims about the ring:
 *   1. lookups are deterministic & stable (so a cached key stays on the same node),
 *   2. virtual nodes make the load even across the 3 physical nodes,
 *   3. adding a node moves only a small fraction of keys (the consistent-hashing win),
 *   4. removing a node only re-homes that node's keys.
 *
 * Pure-logic test: it constructs the ring directly with no Redis/Postgres/Express,
 * which is exactly why we kept ConsistentHashRing free of I/O.
 */

import { describe, it, expect } from "vitest";
import { ConsistentHashRing } from "../src/cache/ConsistentHashRing.js";
import { config } from "../src/config.js";

// Use the real configured node ids and virtual-node count so the tests exercise
// the same ring the running system uses (RING_VIRTUAL_NODES, default 150).
const NODES = ["redis-0", "redis-1", "redis-2"];
const VNODES = config.ringVirtualNodes;

/** Build a deterministic set of sample keys that look like real prefix queries. */
function sampleKeys(n: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    // Deterministic, varied strings (no Math.random) so the suite is reproducible.
    keys.push(`prefix-${i}-q${(i * 7) % 1000}`);
  }
  return keys;
}

describe("ConsistentHashRing", () => {
  it("getNode is deterministic and stable for the same key", () => {
    const ring = new ConsistentHashRing(NODES, VNODES);

    // Same key, many lookups → always the same node.
    const first = ring.getNode("iphone");
    for (let i = 0; i < 100; i++) {
      expect(ring.getNode("iphone")).toBe(first);
    }

    // A freshly built ring with the same inputs must agree — proves stability across
    // "restarts" (which is why we hash with md5, not Math.random).
    const ringRebuilt = new ConsistentHashRing(NODES, VNODES);
    for (const key of ["iphone", "java tutorial", "shoes", "a", "", "MixedCaseKey"]) {
      expect(ringRebuilt.getNode(key)).toBe(ring.getNode(key));
    }

    // The owner must always be one of the real physical nodes.
    expect(NODES).toContain(first);
  });

  it("distributes ~10k keys roughly evenly across 3 nodes (thanks to virtual nodes)", () => {
    const ring = new ConsistentHashRing(NODES, VNODES);
    const keys = sampleKeys(10_000);

    const counts = ring.stats(keys);

    // Every node owns some keys; ideal share is 1/3 (~3333 of 10k).
    const ideal = keys.length / NODES.length;
    for (const node of NODES) {
      // Allow generous +/-30% slack: virtual nodes smooth the load but cannot make it
      // perfectly equal. Without virtual nodes (each node placed once) a single node
      // can easily own >60% of keys — that contrast is the reason virtual nodes exist.
      expect(counts[node]).toBeGreaterThan(ideal * 0.7);
      expect(counts[node]).toBeLessThan(ideal * 1.3);
    }

    // Sanity: the counts must sum to every key (no key is dropped or double-owned).
    const total = NODES.reduce((sum, n) => sum + counts[n], 0);
    expect(total).toBe(keys.length);
  });

  it("KEY-MOVEMENT PROPERTY: adding a 4th node moves only a small fraction of keys", () => {
    // This is the central proof of consistent hashing.
    // Contrast with naive hash(key) % N: going from N=3 to N=4 changes the modulus
    // for almost every key, so ~75%+ of keys would move and the cache would be wiped.
    // With the ring, only keys that fall into the NEW node's arcs move (~1/4 of them).
    const ring = new ConsistentHashRing(NODES, VNODES);
    const keys = sampleKeys(10_000);

    // Record the owner of every key BEFORE the topology change.
    const before = new Map<string, string>();
    for (const key of keys) before.set(key, ring.getNode(key));

    // Add a 4th node and re-check ownership.
    ring.addNode("redis-3");

    let moved = 0;
    for (const key of keys) {
      if (ring.getNode(key) !== before.get(key)) moved++;
    }
    const movedFraction = moved / keys.length;

    // Theory: 3 → 4 nodes should move ~1/4 (25%) of keys. We assert a comfortable
    // ceiling of 35% to absorb hashing variance, while still being WELL under the
    // ~75% a hash%N scheme would suffer — that gap is the whole point of the exercise.
    expect(movedFraction).toBeLessThan(0.35);

    // And the move must be non-trivial: some keys really did migrate to the new node
    // (otherwise the new node would be useless / never receive traffic).
    expect(moved).toBeGreaterThan(0);
    expect(ring.getNodes()).toContain("redis-3");

    // Every key that DID move must now be owned by the newly added node — adding a
    // node can only pull keys onto itself, never reshuffle keys between old nodes.
    for (const key of keys) {
      const now = ring.getNode(key);
      if (now !== before.get(key)) {
        expect(now).toBe("redis-3");
      }
    }
  });

  it("removeNode reassigns ONLY the removed node's keys", () => {
    const ring = new ConsistentHashRing(NODES, VNODES);
    const keys = sampleKeys(10_000);

    const before = new Map<string, string>();
    for (const key of keys) before.set(key, ring.getNode(key));

    // Remove one node; its keys must be re-homed to surviving nodes, and crucially
    // every key NOT previously owned by redis-1 must keep its original owner.
    ring.removeNode("redis-1");

    for (const key of keys) {
      const previousOwner = before.get(key);
      const newOwner = ring.getNode(key);

      if (previousOwner === "redis-1") {
        // Orphaned keys move to one of the survivors (never back to the dead node).
        expect(newOwner).not.toBe("redis-1");
        expect(["redis-0", "redis-2"]).toContain(newOwner);
      } else {
        // Keys on surviving nodes are completely undisturbed — the stability guarantee.
        expect(newOwner).toBe(previousOwner);
      }
    }

    expect(ring.getNodes()).not.toContain("redis-1");
  });

  it("refuses to remove the last node and ignores duplicate/absent operations", () => {
    const ring = new ConsistentHashRing(["only-node"], VNODES);

    // Cannot empty the ring: getNode would have nothing to return.
    expect(() => ring.removeNode("only-node")).toThrow();

    // Re-adding an existing node is idempotent (no duplicate placement / no error).
    const multi = new ConsistentHashRing(NODES, VNODES);
    const ownerBefore = multi.getNode("iphone");
    multi.addNode("redis-0"); // already present
    expect(multi.getNodes()).toEqual(NODES); // unchanged
    expect(multi.getNode("iphone")).toBe(ownerBefore);

    // Removing an absent node is a harmless no-op.
    multi.removeNode("does-not-exist");
    expect(multi.getNodes()).toEqual(NODES);
  });

  it("getNodePosition exposes hash, ring position and node for /cache/debug", () => {
    const ring = new ConsistentHashRing(NODES, VNODES);
    const pos = ring.getNodePosition("iphone");

    expect(pos.key).toBe("iphone");
    expect(NODES).toContain(pos.node);
    // The owning point's hash must be a valid unsigned 32-bit ring position.
    expect(pos.ringPosition).toBeGreaterThanOrEqual(0);
    expect(pos.ringPosition).toBeLessThanOrEqual(0xffffffff);
    // The node reported here must match what getNode returns (same lookup path).
    expect(pos.node).toBe(ring.getNode("iphone"));
  });
});
