const { contextBridge, ipcRenderer } = require('electron');

// Helper that registers a listener and returns an unsubscribe function so the
// renderer can clean up (React StrictMode mounts effects twice — without
// cleanup, handlers stack up and e.g. two voice recorders get started).
function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Initial state
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),

  // Folder management
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  removeFolder: (folderPath) => ipcRenderer.invoke('remove-folder', folderPath),

  // File management
  createFile: (payload) => ipcRenderer.invoke('create-file', payload),
  setActiveFile: (filePath) => ipcRenderer.invoke('set-active-file', filePath),

  // Deletion (both go to the Recycle Bin, never permanent)
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  deleteFolder: (folderPath) => ipcRenderer.invoke('delete-folder', folderPath),

  // Insertion point
  setInsertionLine: (line) => ipcRenderer.invoke('set-insertion-line', line),

  // Legacy
  getNoteContent: () => ipcRenderer.invoke('get-note-content'),

  // Real-time updates from main process (each returns an unsubscribe fn)
  onFileUpdated: (callback) => subscribe('file-updated', callback),

  // Voice Memos
  onStartRecording: (callback) => subscribe('start-recording', callback),
  onStopRecording: (callback) => subscribe('stop-recording', callback),
  recordingStarted: () => ipcRenderer.invoke('recording-started'),
  saveAudio: (buffer, mimeType, durationMs) => ipcRenderer.invoke('save-audio', buffer, mimeType, durationMs),
  recordingFailed: (message) => ipcRenderer.invoke('recording-failed', message),

  // Editor & Export
  saveFileContent: (content) => ipcRenderer.invoke('save-file-content', { content }),
  exportDocument: (options) => ipcRenderer.invoke('export-document', options),

  // Source stamping (capture citations)
  setStampSource: (enabled) => ipcRenderer.invoke('set-stamp-source', enabled),

  // Keep the native window buttons matching the renderer theme
  setTitleBarTheme: (dark) => ipcRenderer.invoke('set-titlebar-theme', dark),

  // Build integrity tag
  appMark: () => ipcRenderer.invoke('app-mark'),

  // Quit
  quitApp: () => ipcRenderer.invoke('quit-app')
});
