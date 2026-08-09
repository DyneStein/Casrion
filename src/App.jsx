import { useEffect, useState, useRef } from 'react';
import { Edit3, Eye, Download, Moon, Sun, Paperclip, HelpCircle } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import Viewer from './Viewer.jsx';
import Editor from './Editor.jsx';
import HelpPanel from './HelpPanel.jsx';
import './index.css';

function App() {
  const [workspace, setWorkspace] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [content, setContent] = useState('');
  const [insertionLine, setInsertionLine] = useState(-1);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [stampSource, setStampSource] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('casrion_dark_mode');
    return saved ? JSON.parse(saved) : false;
  });

  useEffect(() => {
    localStorage.setItem('casrion_dark_mode', JSON.stringify(isDarkMode));
    window.electronAPI?.setTitleBarTheme?.(isDarkMode);
  }, [isDarkMode]);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  // Set when a stop arrives before the microphone finished opening
  const stopRequestedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const pendingSaveRef = useRef(null);

  // A debounced save must land in the file it was typed into — flush it
  // before anything that changes the active file in the main process.
  const flushPendingSave = async () => {
    clearTimeout(saveTimerRef.current);
    if (pendingSaveRef.current !== null && window.electronAPI) {
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      await window.electronAPI.saveFileContent(pending);
    }
  };

  // Every main-process response carries the same full payload; apply it in
  // one place so no handler can forget a field (that's how stale/blank
  // content and un-hydrated images slipped in before).
  const applyState = (state) => {
    if (!state) return;
    setWorkspace(state.workspace || []);
    setActiveFilePath(state.activeFilePath ?? null);
    setContent(state.content ?? '');
    setInsertionLine(state.insertionLine ?? -1);
    if (state.stampSource !== undefined) setStampSource(!!state.stampSource);
  };

  useEffect(() => {
    if (!window.electronAPI) {
      // Browser fallback for UI dev
      setContent('# Welcome\n\nThis is a preview. Run in Electron for full features.\n\n## Getting Started\n\nSelect a folder and create notes.\n');
      setIsLoaded(true);
      return;
    }

    window.electronAPI.getInitialState().then((state) => {
      applyState(state);
      setIsLoaded(true);
    });

    // Listen for live updates from background captures
    const unsubFileUpdated = window.electronAPI.onFileUpdated((data) => {
      // The disk just changed under us (capture/undo). A pending debounced
      // editor save holds pre-capture content — firing it now would silently
      // erase the capture, so drop it in favor of the fresher disk state.
      clearTimeout(saveTimerRef.current);
      pendingSaveRef.current = null;

      setContent(data.content);
      if (data.workspace) setWorkspace(data.workspace);
      if (data.filePath) setActiveFilePath(data.filePath);
      if (data.insertionLine !== undefined) setInsertionLine(data.insertionLine);
      if (data.stampSource !== undefined) setStampSource(!!data.stampSource);
    });

    // Voice Memo Handlers
    const unsubStartRecording = window.electronAPI.onStartRecording(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Not every machine can encode audio/webm — pick the first format
        // this system actually supports instead of hardcoding one.
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c));
        const mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        // A live-muxed recording carries no length of its own, so time it here
        // and hand that to the main process, which writes it into the file.
        // Without it the player has to guess the duration by seeking past the
        // end, which is what used to leave voice memos looking broken.
        let startedAt = 0;

        mediaRecorder.onstop = async () => {
          const durationMs = startedAt ? Date.now() - startedAt : 0;
          const chunks = audioChunksRef.current;
          // Stop all tracks to release microphone
          stream.getTracks().forEach((track) => track.stop());
          mediaRecorderRef.current = null;
          audioChunksRef.current = [];

          if (chunks.length === 0) {
            window.electronAPI.recordingFailed('No audio was captured');
            return;
          }
          const recordedType = mediaRecorder.mimeType || 'audio/webm';
          const audioBlob = new Blob(chunks, { type: recordedType });
          const arrayBuffer = await audioBlob.arrayBuffer();
          window.electronAPI.saveAudio(arrayBuffer, recordedType, durationMs);
        };

        // Emit data every 500ms instead of one blob at the end — a renderer
        // hiccup mid-recording then loses at most half a second, not everything.
        mediaRecorder.start(500);
        startedAt = Date.now();
        // Tell the main process the microphone is genuinely open, so its
        // "Recording..." toast is not left standing on a promise.
        window.electronAPI.recordingStarted();

        // Opening the microphone can take a moment (a cold device, a
        // permission prompt). If the user hit the shortcut again in that gap,
        // honor it now instead of recording on regardless.
        if (stopRequestedRef.current) {
          stopRequestedRef.current = false;
          mediaRecorder.stop();
        }
      } catch (err) {
        console.error('[Casrion] Failed to start recording:', err);
        stopRequestedRef.current = false;
        window.electronAPI.recordingFailed('Microphone blocked or unavailable');
      }
    });

    const unsubStopRecording = window.electronAPI.onStopRecording(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        stopRequestedRef.current = false;
        mediaRecorderRef.current.stop();
      } else {
        // No recorder yet: the start is still in flight, so leave a note for it
        stopRequestedRef.current = true;
      }
    });

    // Build integrity check (internal)
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && e.code === 'KeyD') {
        window.electronAPI.appMark?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    // Closing or reloading the window inside the 350ms save debounce would
    // drop the last keystrokes — hand any pending content to the main
    // process on the way out (it outlives this window and finishes the write).
    const onBeforeUnload = () => {
      if (pendingSaveRef.current !== null) {
        window.electronAPI.saveFileContent(pendingSaveRef.current);
        pendingSaveRef.current = null;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Losing focus is the last safe moment to write. A capture from another
    // app can only happen after this window has lost focus, and the
    // file-updated handler above has to throw pending edits away when it
    // lands, otherwise the debounced save would overwrite the capture with
    // pre-capture content. Flushing here means there is nothing left to throw
    // away: type a paragraph, alt-tab to Chrome, capture, and the paragraph is
    // already on disk instead of being replaced by the version without it.
    const onBlur = () => {
      if (pendingSaveRef.current === null || !window.electronAPI) return;
      clearTimeout(saveTimerRef.current);
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      window.electronAPI.saveFileContent(pending);
    };
    window.addEventListener('blur', onBlur);

    return () => {
      unsubFileUpdated();
      unsubStartRecording();
      unsubStopRecording();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Saving over an existing board leaves the note's text untouched, so the
  // image has to be told to re-fetch itself.
  useEffect(() => {
    const unsub = window.electronAPI?.onBoardSaved?.((data) => {
      window.dispatchEvent(new CustomEvent('casrion-board-saved', { detail: data }));
    });
    return () => unsub?.();
  }, []);

  const handleAddFolder = async () => {
    if (!window.electronAPI) return;
    await flushPendingSave();
    const result = await window.electronAPI.selectFolder();
    if (result) applyState(result);
  };

  const handleRemoveFolder = async (folderPath) => {
    if (!window.electronAPI) return;
    // Notes on disk are untouched, but removing a workspace by mis-click is
    // still disorienting — ask first.
    const name = folderPath.split(/[/\\]/).pop();
    if (!window.confirm(`Remove "${name}" from your workspace?\n\nYour notes stay safely on disk. The folder just stops being shown here.`)) return;
    await flushPendingSave();
    const result = await window.electronAPI.removeFolder(folderPath);
    if (result) applyState(result);
  };

  const handleDeleteFile = async (filePath) => {
    if (!window.electronAPI?.deleteFile) return;
    const name = filePath.split(/[/\\]/).pop();
    if (!window.confirm(`Delete "${name}"?\n\nThe note moves to the Recycle Bin, so you can restore it from there if you change your mind.`)) return;
    await flushPendingSave();
    const result = await window.electronAPI.deleteFile(filePath);
    if (result?.error) {
      alert(result.error);
    } else if (result) {
      applyState(result);
    }
  };

  const handleDeleteFolder = async (folderPath) => {
    if (!window.electronAPI?.deleteFolder) return;
    const name = folderPath.split(/[/\\]/).pop();
    if (!window.confirm(`Delete the folder "${name}" and every note inside it?\n\nThe whole folder moves to the Recycle Bin, so you can restore it from there if you change your mind.`)) return;
    await flushPendingSave();
    const result = await window.electronAPI.deleteFolder(folderPath);
    if (result?.error) {
      alert(result.error);
    } else if (result) {
      applyState(result);
    }
  };

  const handleCreateFile = async (fileName, targetFolder) => {
    if (!window.electronAPI) return;
    await flushPendingSave();
    const result = await window.electronAPI.createFile({ fileName, targetFolder });
    if (result && !result.error) {
      applyState(result);
    } else if (result?.error) {
      alert(result.error);
    }
  };

  const handleSelectFile = async (filePath) => {
    if (!window.electronAPI) return;
    await flushPendingSave();
    const result = await window.electronAPI.setActiveFile(filePath);
    if (result && !result.error) applyState(result);
  };

  const handleSetInsertionLine = async (line) => {
    setInsertionLine(line);
    if (window.electronAPI) {
      await window.electronAPI.setInsertionLine(line);
    }
  };

  const handleToggleEditMode = async () => {
    if (isEditMode) await flushPendingSave();
    setIsEditMode(!isEditMode);
  };

  const handleExport = async () => {
    if (!window.electronAPI) return;
    await flushPendingSave();
    const result = await window.electronAPI.exportDocument({ isDarkMode });
    if (result && result.error) {
      alert('Export failed: ' + result.error);
    } else if (result && result.success) {
      alert('Document exported successfully to ' + result.filePath);
    }
  };

  // Debounce disk writes — the editor fires on every keystroke and each
  // save is a full IPC round-trip plus a file write.
  const handleContentChange = (newContent) => {
    setContent(newContent);
    if (!window.electronAPI) return;
    pendingSaveRef.current = newContent;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      pendingSaveRef.current = null;
      window.electronAPI.saveFileContent(newContent);
    }, 350);
  };

  return (
    <div className={`app-container ${isDarkMode ? 'dark-mode' : ''}`}>
      <header className="header">
        <div className="header-left">
          <span className={`capture-dot ${activeFilePath ? 'on' : ''}`}></span>
          {activeFilePath ? (
            <span className="capture-status">Capturing to <strong>{activeFilePath.split(/[/\\]/).pop()}</strong></span>
          ) : (
            <span className="capture-status">No note selected</span>
          )}
        </div>
        <div className="header-right">
          <button
            className={`header-btn ${stampSource ? 'active' : ''}`}
            onClick={async () => {
              if (!window.electronAPI?.setStampSource) return;
              const result = await window.electronAPI.setStampSource(!stampSource);
              if (result) setStampSource(!!result.stampSource);
            }}
            title={stampSource ? 'Source tracking: ON. Each capture records which window and website it came from' : 'Source tracking: OFF. Click to start recording where each capture comes from'}
          >
            <Paperclip size={16} strokeWidth={1.5} />
          </button>

          <button className={`header-btn ${isDarkMode ? 'active' : ''}`} onClick={() => setIsDarkMode(!isDarkMode)} title={isDarkMode ? 'Dark mode: ON. Click for the light theme' : 'Dark mode: OFF. Click for the dark theme'}>
            {isDarkMode ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
          </button>

          <button className={`header-btn ${isEditMode ? 'active' : ''}`} onClick={handleToggleEditMode} title={isEditMode ? 'Edit mode: ON. Click to return to the reading view' : 'Edit mode: OFF. Click to rewrite the note with a formatting toolbar'}>
            {isEditMode ? <Eye size={16} strokeWidth={1.5} /> : <Edit3 size={16} strokeWidth={1.5} />}
          </button>

          <button className="header-btn" onClick={handleExport} title="Export. Saves this note as a single HTML file with images and audio built in">
            <Download size={16} strokeWidth={1.5} />
          </button>

          <button className={`header-btn ${showHelp ? 'active' : ''}`} onClick={() => setShowHelp(!showHelp)} title="Help. Opens the full guide to every feature and shortcut">
            <HelpCircle size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="main-layout">
          <Sidebar
            workspace={workspace}
            activeFilePath={activeFilePath}
            onAddFolder={handleAddFolder}
            onRemoveFolder={handleRemoveFolder}
            onDeleteFolder={handleDeleteFolder}
            onDeleteFile={handleDeleteFile}
            onCreateFile={handleCreateFile}
            onSelectFile={handleSelectFile}
          />
        {!isLoaded ? (
          <div className="viewer" />
        ) : isEditMode ? (
          <Editor
            content={content}
            onContentChange={handleContentChange}
          />
        ) : (
          <Viewer
            content={content}
            insertionLine={insertionLine}
            onSetInsertionLine={handleSetInsertionLine}
          />
        )}
      </div>

      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}

export default App;
