import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { detect } from './engine/paths';
import { analyze, synthesize, durations } from './engine/synth';
import { buildLabel } from './engine/label';
import type { EngineConfig, NjdNode, SynthParams, EnginePaths } from '../shared/types';

interface Settings {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voice: string | null;
  extraVoiceDirs: string[];
}

let settingsPath = '';

function loadSettings(): Settings {
  const fallback: Settings = {
    openJtalk: null, htsEngine: null, dictionary: null, voice: null, extraVoiceDirs: [],
  };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<Settings>;
    return { ...fallback, ...raw, extraVoiceDirs: raw.extraVoiceDirs ?? [] };
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    console.error('設定を保存できませんでした', e);
  }
}

/** Merge saved overrides over what we can auto-detect. */
function resolvePaths(): EnginePaths & { settings: Settings } {
  const settings = loadSettings();
  const found = detect(settings.extraVoiceDirs);
  const merged: EnginePaths = {
    openJtalk: settings.openJtalk ?? found.openJtalk,
    htsEngine: settings.htsEngine ?? found.htsEngine,
    dictionary: settings.dictionary ?? found.dictionary,
    voices: found.voices,
  };
  return { ...merged, settings };
}

function toConfig(cfg: Partial<EngineConfig>): EngineConfig {
  const r = resolvePaths();
  return {
    openJtalk: cfg.openJtalk ?? r.openJtalk,
    htsEngine: cfg.htsEngine ?? r.htsEngine,
    dictionary: cfg.dictionary ?? r.dictionary,
    voice: cfg.voice ?? r.settings.voice ?? r.voices[0]?.path ?? null,
  };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'JTalk GUI',
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // `--capture <file>` renders the window to a PNG and exits; used to eyeball the
  // UI from a terminal during development.
  const captureIndex = process.argv.indexOf('--capture');
  if (captureIndex !== -1) {
    const target = process.argv[captureIndex + 1];
    win.webContents.on('console-message', (_e, _level, message) => {
      console.log(`[renderer] ${message}`);
    });
    win.webContents.once('did-finish-load', () => {
      // Give the renderer a moment to finish its first paint and engine probe.
      setTimeout(() => {
        void win.webContents.capturePage().then((image) => {
          fs.writeFileSync(target, image.toPNG());
          console.log(`captured ${target}`);
          app.quit();
        });
      }, 2500);
    });
  }

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerIpc(): void {
  ipcMain.handle('engine:detect', () => {
    const r = resolvePaths();
    return {
      openJtalk: r.openJtalk,
      htsEngine: r.htsEngine,
      dictionary: r.dictionary,
      voices: r.voices,
      settings: r.settings,
    };
  });

  ipcMain.handle('settings:save', (_e, s: Settings) => {
    saveSettings(s);
    return resolvePaths();
  });

  // Text -> morphemes -> accent phrases + labels.
  ipcMain.handle('engine:analyze', async (_e, text: string, cfg: Partial<EngineConfig>) => {
    const { njd } = await analyze(text, toConfig(cfg));
    const { features, accentPhrases } = buildLabel(njd);
    return { njd, phrases: accentPhrases, features };
  });

  // Pure rebuild after an edit: no subprocess, so this is fast enough to run on
  // every keystroke or drag.
  ipcMain.handle('engine:rebuild', (_e, njd: NjdNode[]) => {
    const { features, accentPhrases } = buildLabel(njd);
    return { phrases: accentPhrases, features };
  });

  ipcMain.handle('engine:synthesize', async (_e, features: string[], cfg: Partial<EngineConfig>, params: SynthParams) => {
    const wav = await synthesize(features, toConfig(cfg), params);
    // Buffer survives structured clone as a Uint8Array.
    return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  });

  ipcMain.handle('engine:durations', async (_e, features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    durations(features, toConfig(cfg), params));

  ipcMain.handle('file:saveWav', async (_e, data: ArrayBuffer, defaultName: string) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'WAV を書き出す',
      defaultPath: defaultName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, Buffer.from(data));
    return filePath;
  });

  ipcMain.handle('file:saveText', async (_e, text: string, defaultName: string, filters: Electron.FileFilter[]) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters,
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
  });

  ipcMain.handle('file:openText', async (_e, filters: Electron.FileFilter[]) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'], filters });
    if (canceled || filePaths.length === 0) return null;
    return { path: filePaths[0], text: fs.readFileSync(filePaths[0], 'utf8') };
  });

  ipcMain.handle('file:pickPath', async (_e, kind: 'file' | 'directory') => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });
}
