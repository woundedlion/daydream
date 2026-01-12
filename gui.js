
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

        // 1. Load initial value from URL
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

        // 2. Create Controller
        const controller = this.gui.add(object, prop, ...args);

        // 3. Attach URL/State Listener (Only triggers on UI change)
        controller.onChange((v) => {
            setUrlParam(key, v);
        });

        // 4. Update Display
        if (params.has(key)) {
            try { controller.updateDisplay(); } catch (e) { }
        }

        return controller;
    }

    addColor(object, prop) {
        const key = this._getKey(prop);
        // 1. Load from URL
        const params = getUrlParams();
        if (params.has(key)) {
            object[prop] = params.get(key);
        }

        // 2. Create Controller
        const controller = this.gui.addColor(object, prop);

        // 3. Attach URL/State Listener
        controller.onChange((v) => {
            // Handle Color Serialization
            let strVal = v;
            if (typeof v === 'object' && v.getHexString) {
                strVal = '#' + v.getHexString();
            } else if (Array.isArray(v)) {
                strVal = `rgb(${v[0]},${v[1]},${v[2]})`;
            }
            setUrlParam(key, strVal);
        });

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
