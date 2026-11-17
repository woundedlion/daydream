import { ENGINE_CATALOG } from "../helpers/shader_document_harness.js";

export { STUDY_CHAIN } from '../helpers/chain_study.js';

/** @param {string} operator @param {string} param @param {string} option @returns {number} */
export const optionIndex = (operator, param, option) => JSON.parse(ENGINE_CATALOG).operators
  .find((entry) => entry.id === operator).params.find((entry) => entry.id === param)
  .values.indexOf(option);
