import {after} from "node:test";
import assert from "node:assert/strict";

import './recorder/formats_canvas_cases.js';
import './recorder/lifecycle_cases.js';
import './recorder/encoder_events_cases.js';
import './recorder/streaming_cases.js';
import './recorder/capture_frames_cases.js';
import './recorder/saving_cases.js';
import './recorder/failures_cases.js';


const originalDocument = globalThis.document;
after(() => assert.equal(globalThis.document, originalDocument,
  'recorder tests must restore the original document'));
