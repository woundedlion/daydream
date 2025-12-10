/**
 * A fixed-size circular buffer optimized for stability and sorting.
 * Mimics the C++ StaticCircularBuffer logic found in the firmware.
 * * @template T
 */
export class StaticCircularBuffer {
    /**
     * Creates a new circular buffer with the specified capacity.
     * @param {number} capacity - The maximum number of items the buffer can hold.
     */
    constructor(capacity) {
        /** * The internal storage array.
         * @type {Array<T>} 
         */
        this.buffer = new Array(capacity);

        /** * The hard limit of items. 
         * @type {number} 
         */
        this.capacity = capacity;

        /** * Index of the oldest element. 
         * @type {number} 
         */
        this.head = 0;

        /** * Index where the next element will be written. 
         * @type {number} 
         */
        this.tail = 0;

        /** * Current number of elements in the buffer. 
         * @type {number} 
         */
        this.count = 0;
    }

    /**
     * Adds an item to the back of the buffer. 
     * If the buffer is full, it overwrites the oldest item (head) effectively dropping it.
     * * @param {T} item - The item to add.
     */
    push(item) {
        if (this.count === this.capacity) {
            // Buffer full: Overwrite head (oldest)
            this.head = (this.head + 1) % this.capacity;
        } else {
            this.count++;
        }
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.capacity;
    }

    /**
     * Removes and returns the item from the front (oldest) of the buffer.
     * * @returns {T|undefined} The removed item, or undefined if the buffer is empty.
     */
    pop() {
        if (this.count === 0) return undefined;

        const item = this.buffer[this.head];
        this.buffer[this.head] = undefined; // Help Garbage Collection
        this.head = (this.head + 1) % this.capacity;
        this.count--;
        return item;
    }

    /**
     * Returns the item at the front (oldest) of the buffer without removing it.
     * * @returns {T|undefined} The item at the front, or undefined if empty.
     */
    front() {
        if (this.count === 0) return undefined;
        return this.buffer[this.head];
    }

    /**
     * Accesses an item by its logical index (0 being oldest, count-1 being newest).
     * * @param {number} i - The logical index.
     * @returns {T|undefined} The item at the specified index, or undefined if out of bounds.
     */
    get(i) {
        if (i < 0 || i >= this.count) return undefined;
        return this.buffer[(this.head + i) % this.capacity];
    }

    /**
     * The current number of items in the buffer.
     * @type {number}
     */
    get size() {
        return this.count;
    }

    /**
     * Sorts the buffer in-place.
     * NOTE: This operation linearizes the circular buffer (unwraps it) starting at index 0.
     * This allows the use of the native V8/SpiderMonkey array sort which is highly optimized.
     * * @param {function(T, T): number} compareFn - Specifies a function that defines the sort order.
     */
    sort(compareFn) {
        if (this.count < 2) return;

        // 1. Linearize the circular data into a temporary array
        const temp = [];
        for (let i = 0; i < this.count; i++) {
            temp.push(this.buffer[(this.head + i) % this.capacity]);
        }

        // 2. Sort the linear data
        temp.sort(compareFn);

        // 3. Refill the buffer linearly starting from 0
        for (let i = 0; i < this.count; i++) {
            this.buffer[i] = temp[i];
        }

        // 4. Reset indices to a simple linear state
        this.head = 0;
        this.tail = this.count % this.capacity;
    }
}