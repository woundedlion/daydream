/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * The File System Access save picker. lib.dom declares the handle and stream
 * types it hands back but not the entry point, so recorder.js — which feature
 * -detects it and streams a recording straight to the chosen file — has nothing
 * to check its call against without this.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

declare function showSaveFilePicker(
  options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
