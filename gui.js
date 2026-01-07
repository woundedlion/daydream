
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

    add(object, prop, ...args) {
        const key = this._getKey(prop);

        // 1. Load from URL
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

        const controller = this.gui.add(object, prop, ...args);

        // Update UI if we changed the value
        if (params.has(key)) {
            try { controller.updateDisplay(); } catch (e) { }
        }

        // 2. Wrap controller for syncing
        const keyRef = key;
        const userOnChangeRef = { current: null };

        // Define our internal handler that updates URL and calls user cb
        const myHandler = (value) => {
            setUrlParam(keyRef, value);
            if (userOnChangeRef.current) {
                userOnChangeRef.current(value);
            }
        };

        // Register our handler with the real controller logic
        // We use the prototype method to bypass our own shadowing below
        // Note: controller.constructor is Controller (or NumberController etc)
        // Its prototype has onChange.
        controller.constructor.prototype.onChange.call(controller, myHandler);

        // Shadow onChange to capture user callback
        controller.onChange = function (f) {
            userOnChangeRef.current = f;
            return this;
        };

        return controller;
    }

    addColor(object, prop) {
        const key = this._getKey(prop);
        const params = getUrlParams();
        if (params.has(key)) {
            // Color might be hex string in URL
            object[prop] = params.get(key);
        }
        const controller = this.gui.addColor(object, prop);
        if (params.has(key)) {
            try { controller.updateDisplay(); } catch (e) { }
        }

        const keyRef = key;
        const userOnChangeRef = { current: null };

        const myHandler = (value) => {
            let strVal = value;
            if (typeof value === 'object' && value.getHexString) {
                strVal = '#' + value.getHexString();
            } else if (Array.isArray(value)) {
                strVal = `rgb(${value[0]},${value[1]},${value[2]})`;
            }
            setUrlParam(keyRef, strVal);
            if (userOnChangeRef.current) userOnChangeRef.current(value);
        }

        controller.constructor.prototype.onChange.call(controller, myHandler);

        controller.onChange = function (f) {
            userOnChangeRef.current = f;
            return this;
        };

        return controller;
    }

    addFolder(name) {
        const folder = this.gui.addFolder(name);
        const wrapped = new DeepLinkGUI(folder);
        wrapped.parent = this;
        wrapped.folderName = name;
        return wrapped;
    }

    open() { this.gui.open(); }
    close() { this.gui.close(); }
    destroy() { if (this.gui.destroy) this.gui.destroy(); }
    remove(c) { this.gui.remove(c); }

    static reset(excludedKeys = []) {
        const params = getUrlParams();
        const keys = Array.from(params.keys());
        for (const key of keys) {
            if (!excludedKeys.includes(key)) {
                params.delete(key);
            }
        }
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, '', newUrl);
    }
}

// compatibility with import * as gui from 'gui'
export const gui = { GUI: DeepLinkGUI };
export { DeepLinkGUI as GUI };
export default { GUI: DeepLinkGUI };
