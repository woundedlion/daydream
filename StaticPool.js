/**
 * A generic, fixed-size object pool that mimics C++ static allocation.
 * Optimized for "per-frame" scratch objects that are discarded together.
 * * Equivalent to: std::vector<T> with distinct capacity N, but we never free memory.
 */
export class StaticPool {
  /**
   * @param {class} Type - The class constructor (e.g., THREE.Vector3)
   * @param {number} capacity - The maximum number of objects (e.g., 10000)
   */
  constructor(Type, capacity) {
    this.store = new Array(capacity);
    this.cursor = 0;
    this.capacity = capacity;

    for (let i = 0; i < capacity; i++) {
      this.store[i] = new Type();
    }
  }

  /**
   * Returns an instance from the pool.
   * * @returns {Object} An instance of Type
   */
  acquire() {
    if (this.cursor >= this.capacity) {
      console.warn("Pool exhausted! Increase capacity.");
      return this.store[this.capacity - 1];
    }
    return this.store[this.cursor++];
  }

  /**
   * Resets the allocator for the next frame.
   * Does NOT delete objects, just rewinds the cursor.
   */
  reset() {
    this.cursor = 0;
  }
}