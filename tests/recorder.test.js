import {after} from "node:test";
import assert from "node:assert/strict";
import "./helpers/fake_console.js";
import "./helpers/fake_dom.js";
import "../src/recording/recorder.js";
import "../src/renderer/frame_constants.js";

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
