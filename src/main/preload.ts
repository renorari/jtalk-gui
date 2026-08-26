// The only bridge between the renderer and Node. The renderer runs with
// contextIsolation on and no direct Node access; everything goes through here.

import { contextBridge, ipcRenderer } from 'electron';
import type { EngineConfig, NjdNode, SynthParams } from '../shared/types';

const api = {
  detect: () => ipcRenderer.invoke('engine:detect'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),

  analyze: (text: string, cfg: Partial<EngineConfig>) => ipcRenderer.invoke('engine:analyze', text, cfg),
  rebuild: (njd: NjdNode[]) => ipcRenderer.invoke('engine:rebuild', njd),
  synthesize: (features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    ipcRenderer.invoke('engine:synthesize', features, cfg, params),
  durations: (features: string[], cfg: Partial<EngineConfig>, params: SynthParams) =>
    ipcRenderer.invoke('engine:durations', features, cfg, params),

  saveWav: (data: ArrayBuffer, defaultName: string) => ipcRenderer.invoke('file:saveWav', data, defaultName),
  saveText: (text: string, defaultName: string, filters: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('file:saveText', text, defaultName, filters),
  openText: (filters: { name: string; extensions: string[] }[]) => ipcRenderer.invoke('file:openText', filters),
  pickPath: (kind: 'file' | 'directory') => ipcRenderer.invoke('file:pickPath', kind),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
