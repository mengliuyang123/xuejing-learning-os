const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("learnosDesktop", {
  isDesktop: true,
  appName: "学径",
  platform: process.platform,
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-dir"),
  getAppInfo: () => ipcRenderer.invoke("desktop:get-info"),
  setTheme: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  secrets: {
    isAvailable: () => ipcRenderer.invoke("desktop:secret-available"),
    get: (key) => ipcRenderer.invoke("desktop:secret-get", key),
    set: (key, value) => ipcRenderer.invoke("desktop:secret-set", key, value),
    delete: (key) => ipcRenderer.invoke("desktop:secret-delete", key),
  },
});
