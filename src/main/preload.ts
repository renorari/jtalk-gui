// The only bridge between the renderer and Node. The renderer runs with
// contextIsolation on and no direct Node access; everything goes through here.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { EngineConfig, MenuAction, NjdNode, SynthParams } from '../shared/types';

type Filter = { name: string; extensions: string[] };

const api = {
  /** Lets the renderer apply platform-specific chrome (traffic-light inset, etc.). */
  platform: process.platform,

  detect: () => ipcRenderer.invoke('engine:detect'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),

  analyze: (text: string, cfg: Partial<EngineConfig>) => ipcRenderer.invoke('engine:analyze', text, cfg),
  rebuild: (njd: NjdNode[]) => ipcRenderer.invoke('engine:rebuild', njd),
  synthesize: (features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    ipcRenderer.invoke('engine:synthesize', features, cfg, params),
  durations: (features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    ipcRenderer.invoke('engine:durations', features, cfg, params),

  saveWav: (data: ArrayBuffer, defaultName: string) => ipcRenderer.invoke('file:saveWav', data, defaultName),
  saveWavBatch: (items: { name: string; data: ArrayBuffer }[]) => ipcRenderer.invoke('file:saveWavBatch', items),
  saveText: (text: string, defaultName: string, filters: Filter[]) =>
    ipcRenderer.invoke('file:saveText', text, defaultName, filters),
  writeText: (filePath: string, text: string) => ipcRenderer.invoke('file:writeText', filePath, text),
  openText: (filters: Filter[]) => ipcRenderer.invoke('file:openText', filters),
  readText: (filePath: string) => ipcRenderer.invoke('file:readText', filePath),
  pickPath: (kind: 'file' | 'directory') => ipcRenderer.invoke('file:pickPath', kind),
  confirm: (message: string, detail: string) => ipcRenderer.invoke('dialog:confirm', message, detail),

  /** Tell the main process whether there are unsaved edits, so close can warn. */
  setDirty: (dirty: boolean) => ipcRenderer.send('doc:dirty', dirty),

  /** Electron 32 removed File.path; dropped files are resolved through webUtils. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  onMenuAction: (cb: (action: MenuAction) => void): void => {
    ipcRenderer.on('menu:action', (_e, action: MenuAction) => cb(action));
  },

  onAccentColor: (cb: (color: string | null) => void): void => {
    ipcRenderer.on('theme:accent', (_e, color: string | null) => cb(color));
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
