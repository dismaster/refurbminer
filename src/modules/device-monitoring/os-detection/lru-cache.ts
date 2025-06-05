/**
 * Simple LRU Cache implementation to prevent memory leaks
 */
export class LRUCache<K, V> {
  private readonly max: number;
  private readonly cache: Map<K, V>;
  
  constructor(max: number = 100) {
    this.max = max;
    this.cache = new Map();
  }
  
  get(key: K): V | undefined {
    const item = this.cache.get(key);
    
    // Move to end (most recently used)
    if (item) {
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    
    return item;
  }
  
  set(key: K, value: V): void {
    // If key exists, delete it to update its position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // If cache is full, evict oldest item (first item)
    else if (this.cache.size >= this.max) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    // Add to end (most recently used)
    this.cache.set(key, value);
  }
  
  clear(): void {
    this.cache.clear();
  }
}
