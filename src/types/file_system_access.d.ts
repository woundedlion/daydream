/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * The File System Access save picker. lib.dom declares the handle and stream
 * types it hands back but not the entry point. recorder.js feature-detects it
 * and streams a recording straight to the chosen file.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

declare function showSaveFilePicker(
  options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
