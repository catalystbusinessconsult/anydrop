const { contextBridge, ipcRenderer } = require("electron");

// The renderer runs with contextIsolation/no nodeIntegration (standard
// Electron hardening), so it can't reach ipcRenderer directly — this is
// the narrow, explicit bridge for the one thing it needs from the main
// process: triggering/observing electron-updater, which only runs there.
contextBridge.exposeInMainWorld("anydropDesktop", {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  restartToUpdate: () => ipcRenderer.invoke("restart-to-update"),
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },
});
