/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * StaticCircularBuffer
 */
export class StaticCircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.array = new Array(capacity);
        this.index = 0;
        this.length = 0;
        // FIX: Add a persistent array for sorting to prevent GC churn
        this.tempArray = new Array(capacity);
    }

    is_empty() {
        return this.length === 0;
    }

    back() {
        if (this.length === 0) {
            return undefined;
        }
        return this.array[(this.index - 1 + this.capacity) % this.capacity];
    }

    front() {
        if (this.length === 0) {
            return undefined;
        }
        return this.array[(this.index - this.length + this.capacity) % this.capacity];
    }

    get(offset) {
        if (offset >= this.length) {
            return undefined;
        }
        return this.array[(this.index - this.length + offset + this.capacity) % this.capacity];
    }

    pop_back() {
        if (this.length === 0) {
            return undefined;
        }
        this.length--;
        return this.array[(this.index - 1 + this.capacity) % this.capacity];
    }

    pop_front() {
        if (this.length === 0) {
            return undefined;
        }
        const item = this.array[(this.index - this.length + this.capacity) % this.capacity];
        this.length--;
        return item;
    }

    push(item) {
        this.array[this.index] = item;
        this.index = (this.index + 1) % this.capacity;
        if (this.length < this.capacity) {
            this.length++;
        }
    }

    clear() {
        this.index = 0;
        this.length = 0;
    }

    /*
     * Sorts the contents of the buffer.
     * Takes a comparator function.
     */
    sort(comparator) {
        if (this.length === 0) {
            return;
        }

        // FIX: Reuse the persistent array and set its length
        const temp = this.tempArray;
        temp.length = this.length;

        for (let i = 0; i < this.length; i++) {
            const index = (this.index - this.length + i + this.capacity) % this.capacity;
            // FIX: Use direct assignment instead of push()
            temp[i] = this.array[index];
        }

        temp.sort(comparator);

        // Copy back to the circular buffer.
        let new_index = this.index - this.length;
        if (new_index < 0) {
            new_index += this.capacity;
        }

        for (let i = 0; i < this.length; i++) {
            this.array[(new_index + i) % this.capacity] = temp[i];
        }

        // Reset the index to be contiguous after sort
        this.index = new_index + this.length;
        if (this.index > this.capacity) {
            this.index -= this.capacity;
        }
    }

    /*
     * Iterates over the array contents from oldest to newest.
     * Takes a callback function (item, index, array).
     */
    forEach(callback) {
        for (let i = 0; i < this.length; i++) {
            const index = (this.index - this.length + i + this.capacity) % this.capacity;
            callback(this.array[index], i, this.array);
        }
    }

    map(callback) {
        const result = [];
        for (let i = 0; i < this.length; i++) {
            const index = (this.index - this.length + i + this.capacity) % this.capacity;
            result.push(callback(this.array[index], i, this.array));
        }
        return result;
    }

    filter(callback) {
        const result = [];
        for (let i = 0; i < this.length; i++) {
            const index = (this.index - this.length + i + this.capacity) % this.capacity;
            const item = this.array[index];
            if (callback(item, i, this.array)) {
                result.push(item);
            }
        }
        return result;
    }

    pop_filter(callback) {
        let new_length = 0;
        const temp = this.map((item, i, arr) => {
            if (callback(item, i, arr)) {
                return item;
            } else {
                new_length++;
                return undefined;
            }
        });
        const popped = [];
        // Copy back to the circular buffer, skipping undefined (popped) items
        let new_index = this.index - this.length;
        if (new_index < 0) {
            new_index += this.capacity;
        }

        let temp_index = 0;
        for (let i = 0; i < this.length; i++) {
            if (temp[i] !== undefined) {
                this.array[(new_index + temp_index) % this.capacity] = temp[i];
                temp_index++;
            } else {
                popped.push(this.array[(new_index + i) % this.capacity]);
            }
        }

        this.length = new_length;
        this.index = new_index + this.length;
        if (this.index > this.capacity) {
            this.index -= this.capacity;
        }
        return popped;
    }

    remove_at(offset) {
        if (offset >= this.length) {
            return undefined;
        }
        const remove_index = (this.index - this.length + offset + this.capacity) % this.capacity;
        const item = this.array[remove_index];

        // Shift elements down to fill the gap.
        // If we remove an element, the tail needs to shift up.
        // We move elements from index `offset + 1` to `length - 1` one step back.
        for (let i = offset; i < this.length - 1; i++) {
            const src_index = (this.index - this.length + i + 1 + this.capacity) % this.capacity;
            const dest_index = (this.index - this.length + i + this.capacity) % this.capacity;
            this.array[dest_index] = this.array[src_index];
        }

        this.length--;
        // The index remains the same since we shifted elements back.
        // The last element (at the old 'back' index) is now garbage and will be overwritten on the next push.
        return item;
    }

    get_array() {
        const temp = [];
        for (let i = 0; i < this.length; i++) {
            const index = (this.index - this.length + i + this.capacity) % this.capacity;
            temp.push(this.array[index]);
        }
        return temp;
    }
}