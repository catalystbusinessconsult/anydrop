const { contextBridge, ipcRenderer } = require("electron");

// The renderer runs with contextIsolation/no nodeIntegration (standard
// Electron hardening), so it can't reach ipcRenderer directly — this is
// the narrow, explicit bridge for the two things it needs from the main
// process, both of which only run there: triggering/observing
// electron-updater, and being told when the coordinator this window
// should talk to changes after the window's already open (see
// onHostChange in coordinator/src/election.ts for why that can happen).
contextBridge.exposeInMainWorld("anydropDesktop", {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  restartToUpdate: () => ipcRenderer.invoke("restart-to-update"),
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },
  onCoordinatorHostChanged: (callback) => {
    const handler = (_event, host) => callback(host);
    ipcRenderer.on("coordinator-host-changed", handler);
    return () => ipcRenderer.removeListener("coordinator-host-changed", handler);
  },
});
