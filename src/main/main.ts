import { app, BrowserWindow, ipcMain, dialog, shell, Menu, systemPreferences, nativeTheme } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { detect } from './engine/paths';
import { analyze, synthesize, durations } from './engine/synth';
import { buildLabel } from './engine/label';
import type { EngineConfig, MenuAction, NjdNode, SynthParams, EnginePaths } from '../shared/types';

interface WindowBounds { x?: number; y?: number; width: number; height: number }

interface Settings {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voice: string | null;
  extraVoiceDirs: string[];
  bounds?: WindowBounds;
}

let settingsPath = '';
let mainWindow: BrowserWindow | null = null;
/** Mirrors the renderer's unsaved-changes state so close can be intercepted. */
let documentDirty = false;
/** Set once the user confirms discarding changes, so the re-issued close goes through. */
let forceClose = false;

const DEFAULT_BOUNDS: WindowBounds = { width: 1360, height: 900 };

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
  return {
    openJtalk: settings.openJtalk ?? found.openJtalk,
    htsEngine: settings.htsEngine ?? found.htsEngine,
    dictionary: settings.dictionary ?? found.dictionary,
    voices: found.voices,
    settings,
  };
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

// ---------- window ----------

function persistBounds(win: BrowserWindow): void {
  if (win.isMinimized() || win.isFullScreen()) return;
  const s = loadSettings();
  saveSettings({ ...s, bounds: win.getNormalBounds() });
}

function createWindow(): void {
  const { bounds } = loadSettings();
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    title: 'JTalk GUI',
    // HIG: a unified toolbar under an inset title bar, with a vibrant sidebar.
    ...(isMac ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 13, y: 15 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
      backgroundColor: '#00000000',
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistBounds(win), 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);

  // Ask before discarding unsaved edits.
  win.on('close', (event) => {
    if (forceClose || !documentDirty) return;
    event.preventDefault();
    void dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['保存せずに閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '保存していない変更があります',
      detail: '閉じると編集内容は失われます。',
    }).then(({ response }) => {
      if (response === 0) {
        forceClose = true;
        win.close();
      }
    });
  });

  win.on('closed', () => { mainWindow = null; });

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  attachDevHooks(win);
}

/**
 * Development affordances, both driven from the command line:
 *   --capture <png>  render the window to an image and exit
 *   --eval <js file> run a script inside the renderer and print its result as JSON
 * Neither is reachable during normal use.
 */
function attachDevHooks(win: BrowserWindow): void {
  const arg = (name: string): string | null => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1] ?? null;
  };
  const capture = arg('--capture');
  const evaluate = arg('--eval');
  if (!capture && !evaluate) return;

  win.webContents.on('console-message', (_e, _level, message) => {
    console.log(`[renderer] ${message}`);
  });

  win.webContents.once('did-finish-load', () => {
    // Give the renderer time for its first paint and the engine probe.
    setTimeout(async () => {
      try {
        // Evaluate first, so a script can set up the state that gets captured.
        if (evaluate) {
          const source = fs.readFileSync(evaluate, 'utf8');
          const result = await win.webContents.executeJavaScript(source, true);
          console.log(JSON.stringify(result, null, 2));
        }
        if (capture) {
          // Park the pointer over empty space first: whatever it last hovered
          // keeps its :hover styling and shows up in the image.
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 900, y: 950 });
          await new Promise((r) => setTimeout(r, 150));
          const image = await win.webContents.capturePage();
          fs.writeFileSync(capture, image.toPNG());
          console.log(`captured ${capture}`);
        }
      } catch (e) {
        console.error('dev hook failed:', e);
        process.exitCode = 1;
      } finally {
        forceClose = true;
        app.quit();
      }
    }, 2500);
  });
}

// ---------- system appearance ----------

/**
 * The user's accent colour from System Settings, as #rrggbb.
 *
 * The CSS `AccentColor` system keyword does not resolve in Electron's Chromium, so
 * the colour is read natively and injected as a custom property instead.
 */
function accentColor(): string | null {
  try {
    const raw = systemPreferences.getAccentColor(); // RRGGBBAA
    if (!raw) return null;
    return `#${raw.slice(0, 6).toLowerCase()}`;
  } catch {
    return null; // unsupported platform
  }
}

function watchAppearance(): void {
  const push = (): void => {
    mainWindow?.webContents.send('theme:accent', accentColor());
  };
  nativeTheme.on('updated', push);
  if (process.platform === 'darwin') {
    try {
      // macOS posts this when the accent or highlight colour changes.
      systemPreferences.subscribeNotification?.('AppleColorPreferencesChangedNotification', push);
    } catch { /* older macOS */ }
  } else if (process.platform === 'win32') {
    try {
      systemPreferences.on('accent-color-changed', push);
    } catch { /* not supported */ }
  }
}

// ---------- menu ----------

function send(action: MenuAction): void {
  mainWindow?.webContents.send('menu:action', action);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions[] = isMac ? [{
    label: app.name,
    submenu: [
      { role: 'about', label: 'JTalk GUI について' },
      { type: 'separator' },
      { label: '設定…', accelerator: 'Cmd+,', click: () => send('settings') },
      { type: 'separator' },
      { role: 'hide', label: 'JTalk GUI を隠す' },
      { role: 'hideOthers', label: 'ほかを隠す' },
      { role: 'unhide', label: 'すべてを表示' },
      { type: 'separator' },
      { role: 'quit', label: 'JTalk GUI を終了' },
    ],
  }] : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'ファイル',
      submenu: [
        { label: '新しい行', accelerator: 'CmdOrCtrl+N', click: () => send('new-line') },
        { type: 'separator' },
        { label: '開く…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '別名で保存…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'WAV を書き出す…', accelerator: 'CmdOrCtrl+E', click: () => send('export-wav') },
        { label: 'すべての行を WAV に書き出す…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('export-wav-all') },
        { label: 'ラベルを書き出す…', click: () => send('export-labels') },
        ...(isMac ? [] : [
          { type: 'separator' } as MenuItemConstructorOptions,
          { label: '設定…', accelerator: 'Ctrl+,', click: () => send('settings') } as MenuItemConstructorOptions,
          { role: 'quit', label: '終了' } as MenuItemConstructorOptions,
        ]),
      ],
    },
    {
      label: '編集',
      submenu: [
        // Routed to the renderer so they undo accent edits, not just text fields.
        { label: '取り消す', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'やり直す', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべてを選択' },
        { type: 'separator' },
        { label: '行を複製', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate-line') },
        // Backspace is the macOS convention; Delete is the one elsewhere.
        { label: '行を削除', accelerator: isMac ? 'Cmd+Backspace' : 'Ctrl+Delete', click: () => send('delete-line') },
        { label: '行を上へ', accelerator: 'CmdOrCtrl+Alt+Up', click: () => send('move-line-up') },
        { label: '行を下へ', accelerator: 'CmdOrCtrl+Alt+Down', click: () => send('move-line-down') },
      ],
    },
    {
      label: '音声',
      submenu: [
        { label: '解析', accelerator: 'CmdOrCtrl+R', click: () => send('analyze') },
        { type: 'separator' },
        { label: '再生 / 停止', accelerator: 'CmdOrCtrl+Return', click: () => send('play') },
        { label: 'すべて再生', accelerator: 'CmdOrCtrl+Shift+Return', click: () => send('play-all') },
        // No accelerator: Escape belongs to whatever dialog is open. The renderer
        // stops playback on Escape when nothing else claims the key.
        { label: '停止', click: () => send('stop') },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'フルスクリーン' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  registerIpc();
  buildMenu();
  createWindow();
  watchAppearance();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- ipc ----------

// Attaching a parent makes these appear as document-modal sheets on macOS, which
// is what the HIG asks for; without one they float as separate windows.
const showOpen = (opts: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> =>
  (mainWindow ? dialog.showOpenDialog(mainWindow, opts) : dialog.showOpenDialog(opts));

const showSave = (opts: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> =>
  (mainWindow ? dialog.showSaveDialog(mainWindow, opts) : dialog.showSaveDialog(opts));

function registerIpc(): void {
  ipcMain.handle('engine:detect', () => {
    const r = resolvePaths();
    return {
      openJtalk: r.openJtalk,
      htsEngine: r.htsEngine,
      dictionary: r.dictionary,
      voices: r.voices,
      settings: r.settings,
      accentColor: accentColor(),
    };
  });

  ipcMain.handle('settings:save', (_e, s: Partial<Settings>) => {
    // Preserve window bounds, which the renderer knows nothing about.
    const prev = loadSettings();
    saveSettings({ ...prev, ...s });
    return resolvePaths();
  });

  ipcMain.on('doc:dirty', (_e, dirty: boolean) => {
    documentDirty = dirty;
    mainWindow?.setDocumentEdited?.(dirty);
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
    return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
  });

  ipcMain.handle('engine:durations', async (_e, features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    durations(features, toConfig(cfg), params));

  ipcMain.handle('file:saveWav', async (_e, data: ArrayBuffer, defaultName: string) => {
    const { canceled, filePath } = await showSave({
      title: 'WAV を書き出す',
      defaultPath: defaultName,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, Buffer.from(data));
    return filePath;
  });

  /** Batch export: one wav per line into a chosen directory. */
  ipcMain.handle('file:saveWavBatch', async (_e, items: { name: string; data: ArrayBuffer }[]) => {
    const { canceled, filePaths } = await showOpen({
      title: '書き出し先のフォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;
    const dir = filePaths[0];
    for (const item of items) {
      fs.writeFileSync(path.join(dir, item.name), Buffer.from(item.data));
    }
    return { dir, count: items.length };
  });

  ipcMain.handle('file:saveText', async (_e, text: string, defaultName: string, filters: Electron.FileFilter[]) => {
    const { canceled, filePath } = await showSave({ defaultPath: defaultName, filters });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
  });

  /** Write to a known path without prompting; used by plain Save. */
  ipcMain.handle('file:writeText', (_e, filePath: string, text: string) => {
    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
  });

  ipcMain.handle('file:openText', async (_e, filters: Electron.FileFilter[]) => {
    const { canceled, filePaths } = await showOpen({ properties: ['openFile'], filters });
    if (canceled || filePaths.length === 0) return null;
    return { path: filePaths[0], text: fs.readFileSync(filePaths[0], 'utf8') };
  });

  ipcMain.handle('file:readText', (_e, filePath: string) => {
    try {
      return { path: filePath, text: fs.readFileSync(filePath, 'utf8') };
    } catch {
      return null;
    }
  });

  ipcMain.handle('file:pickPath', async (_e, kind: 'file' | 'directory') => {
    const { canceled, filePaths } = await showOpen({
      properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  ipcMain.handle('dialog:confirm', async (_e, message: string, detail: string) => {
    const { response } = mainWindow
      ? await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['続行', 'キャンセル'], defaultId: 1, cancelId: 1, message, detail,
      })
      : await dialog.showMessageBox({
        type: 'warning', buttons: ['続行', 'キャンセル'], defaultId: 1, cancelId: 1, message, detail,
      });
    return response === 0;
  });

}
