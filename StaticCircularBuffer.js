
/**
 * A fixed-size circular buffer optimized for stability.
 * Mimics the C++ implementation.
 */
export class StaticCircularBuffer {
    /**
     * @param {number} capacity - The maximum size of the buffer (N).
     */
    constructor(capacity) {
        this.buffer = new Array(capacity);
        this.head = 0;
        this.tail = 0;
        this.count = 0;
        this.capacity = capacity;
    }

    /**
     * Adds an item to the front of the buffer.
     * If full, the tail (oldest in this context) is dropped.
     * @param {*} item 
     */
    push_front(item) {
        if (this.is_full()) {
            this.pop_back_internal();
        }
        this.head = (this.head - 1 + this.capacity) % this.capacity;
        this.buffer[this.head] = item;
        this.count++;
    }

    /**
     * Adds an item to the back of the buffer.
     * If full, the head (oldest in this context) is dropped.
     * @param {*} item 
     */
    push_back(item) {
        if (this.is_full()) {
            this.pop_front_internal();
        }
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
        this.count++;
    }

    /**
     * Removes the last item.
     */
    pop_back() {
        if (this.is_empty()) return;
        this.pop_back_internal();
    }

    /**
     * Removes the first item.
     */
    pop() {
        if (this.is_empty()) return;
        this.pop_front_internal();
    }

    /**
     * Clears the buffer.
     */
    clear() {
        while (!this.is_empty()) {
            this.pop_front_internal();
        }
    }

    /**
     * Returns the first item.
     * @returns {*}
     */
    front() {
        if (this.is_empty()) return undefined;
        return this.buffer[this.head];
    }

    /**
     * Returns the last item.
     * @returns {*}
     */
    back() {
        if (this.is_empty()) return undefined;
        return this.buffer[(this.head + this.count - 1) % this.capacity];
    }

    /**
     * Access item by index (0 to count-1).
     * @param {number} index 
     * @returns {*}
     */
    get(index) {
        if (index >= this.count) {
            return undefined;
        }
        return this.buffer[(this.head + index) % this.capacity];
    }

    is_empty() { return this.count === 0; }
    is_full() { return this.count === this.capacity; }
    size() { return this.count; }

    // Iterable implementation
    *[Symbol.iterator]() {
        for (let i = 0; i < this.count; i++) {
            yield this.buffer[(this.head + i) % this.capacity];
        }
    }

    // Internal helpers
    pop_back_internal() {
        this.tail = (this.tail - 1 + this.capacity) % this.capacity;
        this.buffer[this.tail] = undefined;
        this.count--;
    }

    pop_front_internal() {
        this.buffer[this.head] = undefined;
        this.head = (this.head + 1) % this.capacity;
        this.count--;
    }
}
