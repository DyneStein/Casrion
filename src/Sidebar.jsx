import { useState } from 'react';
import { FolderOpen, FileText, X, Plus, Trash2 } from 'lucide-react';

function Sidebar({ workspace = [], activeFilePath, onAddFolder, onRemoveFolder, onDeleteFolder, onDeleteFile, onCreateFile, onSelectFile }) {
  const [creatingInFolder, setCreatingInFolder] = useState(null);
  const [newFileName, setNewFileName] = useState('');

  const handleCreate = (targetFolder) => {
    if (newFileName.trim()) {
      onCreateFile(newFileName.trim(), targetFolder);
      setNewFileName('');
      setCreatingInFolder(null);
    }
  };

  const handleKeyDown = (e, targetFolder) => {
    if (e.key === 'Enter') handleCreate(targetFolder);
    if (e.key === 'Escape') { setCreatingInFolder(null); setNewFileName(''); }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2 className="sidebar-title">Workspace</h2>
      </div>

      <div className="workspace-container" style={{ flex: 1, overflowY: 'auto' }}>
        {workspace.length === 0 ? (
          <div className="file-list-empty" style={{ marginTop: '2rem' }}>
            <p>Your workspace is empty</p>
            <p className="file-list-hint">Add a folder to get started</p>
          </div>
        ) : (
          workspace.map((folderGroup) => (
            <div key={folderGroup.folderPath} className="workspace-folder-group" style={{ marginBottom: '1rem' }}>
              
              {/* Folder Header */}
              <div className="folder-section" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.6rem' }}>
                <button className="folder-display" style={{ flex: 1, marginBottom: 0, paddingRight: '0.4rem' }} title={`Workspace folder: ${folderGroup.folderPath}`}>
                  <FolderOpen size={15} strokeWidth={1.5} />
                  <span className="folder-name" style={{ fontWeight: 600 }}>{folderGroup.folderName}</span>
                </button>
                <button className="icon-btn" onClick={() => setCreatingInFolder(folderGroup.folderPath)} title="Create a new note inside this folder" style={{ padding: '0.3rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', opacity: 0.7 }}>
                  <Plus size={14} strokeWidth={1.5} />
                </button>
                <button className="icon-btn" onClick={() => onRemoveFolder(folderGroup.folderPath)} title="Remove this folder from the workspace. Your files stay on disk" style={{ padding: '0.3rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', opacity: 0.7 }}>
                  <X size={14} strokeWidth={1.5} />
                </button>
                <button className="icon-btn danger-btn" onClick={() => onDeleteFolder(folderGroup.folderPath)} title="Delete this folder and every note inside it. It all moves to the Recycle Bin" style={{ padding: '0.3rem', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', opacity: 0.7 }}>
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>

              {/* Create Input for this folder */}
              {creatingInFolder === folderGroup.folderPath && (
                <div className="create-input-wrapper" style={{ padding: '0.4rem 0.6rem' }}>
                  <input
                    type="text"
                    className="create-input"
                    placeholder="Note name..."
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, folderGroup.folderPath)}
                    autoFocus
                  />
                  <button className="create-confirm-btn" onClick={() => handleCreate(folderGroup.folderPath)}>Create</button>
                </div>
              )}

              {/* Files in this folder */}
              <div className="file-list" style={{ paddingLeft: '1rem', paddingTop: '0.3rem' }}>
                {folderGroup.files.length === 0 ? (
                  <div className="file-list-hint" style={{ padding: '0.2rem 0.4rem' }}>Empty folder</div>
                ) : (
                  folderGroup.files.map((file) => (
                    <div
                      key={file.path}
                      className={`file-item ${file.path === activeFilePath ? 'file-item-active' : ''}`}
                      onClick={() => onSelectFile(file.path)}
                      title={`Open ${file.filename}. New captures go into the selected note`}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectFile(file.path); } }}
                    >
                      <FileText size={14} strokeWidth={1.5} className="file-icon" />
                      <span className="file-name">{file.name}</span>
                      <button
                        className="file-delete-btn"
                        onClick={(e) => { e.stopPropagation(); onDeleteFile(file.path); }}
                        title="Delete this note. It moves to the Recycle Bin"
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Global Add Folder Button */}
      <div className="sidebar-footer">
        <button className="create-file-btn" onClick={onAddFolder}>
          <FolderOpen size={16} strokeWidth={1.5} />
          <span>Add Folder</span>
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
