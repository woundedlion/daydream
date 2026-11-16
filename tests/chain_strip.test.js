import "node:test";
import "node:assert/strict";
import "node:fs";
import "../src/workbench/shader/chain_document_store.js";
import "../src/workbench/shader/chain_strip.js";
import "../src/workbench/shader/chain_presentation.js";
import "./helpers/fake_dom.js";
import "./helpers/chain_strip_harness.js";
import "./helpers/chain_study.js";
import "../generated/shader/shader_workbench.mjs";

import './chain_strip/layout_cases.js';
import './chain_strip/viewport_palette_cases.js';
import './chain_strip/reorder_history_cases.js';
import './chain_strip/parameter_controls_cases.js';
import './chain_strip/color_modulation_cases.js';
import './chain_strip/admission_history_cases.js';
