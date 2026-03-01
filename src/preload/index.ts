import { contextBridge, ipcRenderer } from 'electron'

// Custom APIs for renderer
const api = {
  getMacAddress: () => ipcRenderer.invoke('get-mac-address')
}

// Minimal stub for electron API if needed later, but we rely on api.getMacAddress
const electronStub = {
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any[]) => void) => ipcRenderer.on(channel, listener),
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronStub)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronStub
  // @ts-ignore (define in dts)
  window.api = api
}

