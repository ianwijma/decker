import { contextBridge, ipcRenderer } from "electron";
import type { DeckerAPI, Snapshot } from "../shared/schema";
const api: DeckerAPI = {
  snapshot: () => ipcRenderer.invoke("decker:snapshot"),
  request: (request) => ipcRenderer.invoke("decker:request", request),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) =>
      listener(snapshot);
    ipcRenderer.on("decker:snapshot", handler);
    return () => ipcRenderer.removeListener("decker:snapshot", handler);
  },
};
contextBridge.exposeInMainWorld("decker", api);
