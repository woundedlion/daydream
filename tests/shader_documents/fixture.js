import { ENGINE_CATALOG, CHAIN_STUDY } from ".././helpers/shader_document_harness.js";

export const STUDY_CHAIN = JSON.parse(CHAIN_STUDY).descriptor.chain;

/** @param {string} operator @param {string} param @param {string} option @returns {number} */
export const optionIndex = (operator, param, option) => JSON.parse(ENGINE_CATALOG).operators
  .find((entry) => entry.id === operator).params.find((entry) => entry.id === param)
  .values.indexOf(option);
