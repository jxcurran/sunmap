// Generic bounded LRU, backing the trajectory/tz/geocode caches (NFR-1.5, Technical
// Architecture §6.2-§6.4). Map preserves insertion order, so a delete+re-set on hit
// is enough to implement recency — no need for a linked-list implementation.
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
