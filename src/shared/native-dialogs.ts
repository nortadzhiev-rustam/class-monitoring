// Native open/save dialogs. Automated test runs preset the answers with
// CM_TEST_OPEN (paths separated by the platform's path delimiter) and
// CM_TEST_SAVE, since nobody is there to click.

import { dialog, type BrowserWindow, type FileFilter } from 'electron';
import path from 'node:path';

export async function pickFiles(parent: BrowserWindow | null, title: string): Promise<string[]> {
  const preset = process.env.CM_TEST_OPEN;
  if (preset) return preset.split(path.delimiter).filter(Boolean);
  const options = { title, properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

export async function pickSavePath(parent: BrowserWindow | null, defaultPath: string, filters: FileFilter[]): Promise<string | null> {
  const preset = process.env.CM_TEST_SAVE;
  if (preset) return preset;
  const options = { defaultPath, filters };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}
