
import transform from "dat-gui";

// Helper to manage URL state
const getUrlParams = () => new URLSearchParams(window.location.search);
const setUrlParam = (key, value) => {
    const params = getUrlParams();
    if (value === null || value === undefined) {
        params.delete(key);
    } else {
        // Round numbers to save space and avoid float jitter
        if (typeof value === 'number') {
            value = parseFloat(value.toFixed(4));
        }
        params.set(key, value);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
};

class DeepLinkGUI {
    constructor(options) {
        // Handle wrapping existing instance or creating new one
        if (options && options.domElement && options.addFolder) {
            this.gui = options;
        } else {
            this.gui = new transform.GUI(options);
        }
        this.parent = null;
        this.folderName = null;
    }

    get domElement() { return this.gui.domElement; }
    get width() { return this.gui.width; }

    _getKey(prop) {
        let keys = [prop];
        let curr = this;
        while (curr.parent) {
            if (curr.folderName) keys.unshift(curr.folderName);
            curr = curr.parent;
        }
        return keys.join('.');
    }

    _getDescriptor(object, prop) {
        let curr = object;
        while (curr) {
            const desc = Object.getOwnPropertyDescriptor(curr, prop);
            if (desc) return desc;
            curr = Object.getPrototypeOf(curr);
        }
        return undefined;
    }

    add(object, prop, ...args) {
        const key = this._getKey(prop);

        // Check for existing descriptor to respect getters/setters
        const descriptor = this._getDescriptor(object, prop);
        let getter, setter;

        if (descriptor && (descriptor.get || descriptor.set)) {
            // Wrap existing accessors
            getter = () => descriptor.get ? descriptor.get.call(object) : undefined;
            setter = (v) => {
                if (descriptor.set) descriptor.set.call(object, v);
            };
        } else {
            // Simple property - use closure logic
            let value = object[prop];
            getter = () => value;
            setter = (v) => { value = v; };
        }

        // 1. Proxy the property to trigger URL updates on set
        try {
            Object.defineProperty(object, prop, {
                get: getter,
                set: (v) => {
                    setter(v);
                    setUrlParam(key, v);
                },
                enumerable: true,
                configurable: true
            });
        } catch (e) {
            console.warn(`DeepLinkGUI: Failed to proxy property '${prop}'. Deep linking updates may not work for this control.`, e);
        }


        // 2. Load initial value from URL
        const params = getUrlParams();
        if (params.has(key)) {
            let val = params.get(key);
            const currentVal = object[prop];
            if (typeof currentVal === 'number') {
                val = parseFloat(val);
            } else if (typeof currentVal === 'boolean') {
                val = (val === 'true');
            }
            object[prop] = val;
        }

        // 3. Create Controller
        const controller = this.gui.add(object, prop, ...args);

        // 4. Update Display
        if (params.has(key)) {
            try { controller.updateDisplay(); } catch (e) { }
        }

        return controller;
    }

    addColor(object, prop) {
        const key = this._getKey(prop);
        let value = object[prop];

        // 1. Proxy the property
        try {
            Object.defineProperty(object, prop, {
                get: () => value,
                set: (v) => {
                    value = v;
                    // Handle Color Serialization
                    let strVal = v;
                    if (typeof v === 'object' && v.getHexString) {
                        strVal = '#' + v.getHexString();
                    } else if (Array.isArray(v)) {
                        strVal = `rgb(${v[0]},${v[1]},${v[2]})`;
                    }
                    setUrlParam(key, strVal);
                },
                enumerable: true,
                configurable: true
            });
        } catch (e) {
            console.warn(`DeepLinkGUI: Failed to proxy color property '${prop}'.`, e);
        }

        // 2. Load from URL
        const params = getUrlParams();
        if (params.has(key)) {
            object[prop] = params.get(key);
        }

        // 3. Create Controller
        const controller = this.gui.addColor(object, prop);

        // 4. Update Display
        if (params.has(key)) {
            try { controller.updateDisplay(); } catch (e) { }
        }

        return controller;
    }

    addFolder(name) {
        const folder = this.gui.addFolder(name);
        const wrapped = new DeepLinkGUI(folder);
        wrapped.parent = this;
        wrapped.folderName = name;
        return wrapped;
    }

    static reset(excludedKeys = []) {
        resetGUI(excludedKeys);
    }

    open() { this.gui.open(); }
    close() { this.gui.close(); }
    destroy() { if (this.gui.destroy) this.gui.destroy(); }
    remove(c) { this.gui.remove(c); }
}

export const resetGUI = (excludedKeys = []) => {
    const params = getUrlParams();
    const keys = Array.from(params.keys());
    for (const key of keys) {
        if (!excludedKeys.includes(key)) {
            params.delete(key);
        }
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
};

// compatibility with import * as gui from 'gui'
export const gui = { GUI: DeepLinkGUI };
export { DeepLinkGUI as GUI };
export default { GUI: DeepLinkGUI };
