import { useEffect, useState } from 'react';

import { transport } from '../transport/index.js';
import {
  HOVER_BG,
  menuItemBase,
  modalBackdropStyle,
  modalCloseButtonStyle,
  modalContainerStyle,
  modalHeaderStyle,
  modalStatusStyle,
  modalTitleStyle,
  mutedTimestampStyle,
} from './modalStyles.js';

interface RecentProject {
  hash: string;
  displayName: string;
  fullPath: string | null;
  lastUsed: number;
}

interface ProjectPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (folderPath: string) => void;
}

function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

export function ProjectPickerModal({ isOpen, onClose, onSelect }: ProjectPickerModalProps) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');

  // Request recent projects from the server when opened, listening on the transport.
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    const unsubscribe = transport.onMessage((msg) => {
      if (msg.type === 'recentProjects') {
        setProjects(msg.projects as RecentProject[]);
        setLoading(false);
      }
    });
    transport.send({ type: 'requestRecentProjects' });
    return unsubscribe;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const submitManual = () => {
    const p = manualPath.trim();
    if (p) {
      setManualPath('');
      onSelect(p);
    }
  };

  return (
    <>
      <div onClick={onClose} style={modalBackdropStyle} />
      <div style={{ ...modalContainerStyle, minWidth: 280, maxWidth: 400 }}>
        <div style={modalHeaderStyle}>
          <span style={modalTitleStyle}>Launch Agent</span>
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...modalCloseButtonStyle,
              background: hovered === 'close' ? HOVER_BG : 'transparent',
            }}
          >
            X
          </button>
        </div>

        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {loading && <div style={modalStatusStyle}>Loading...</div>}
          {!loading && projects.length === 0 && (
            <div style={modalStatusStyle}>No recent projects</div>
          )}
          {!loading &&
            projects.map((project) => {
              const disabled = !project.fullPath;
              return (
                <button
                  key={project.hash}
                  onClick={() => {
                    if (project.fullPath) onSelect(project.fullPath);
                  }}
                  onMouseEnter={() => !disabled && setHovered(project.hash)}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    ...menuItemBase,
                    cursor: disabled ? 'default' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                    background: hovered === project.hash ? HOVER_BG : 'transparent',
                  }}
                  title={project.fullPath ?? 'Path not found'}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginRight: 8,
                    }}
                  >
                    {project.displayName}
                  </span>
                  <span style={mutedTimestampStyle}>{formatRelativeTime(project.lastUsed)}</span>
                </button>
              );
            })}
        </div>

        <div
          style={{
            borderTop: '1px solid var(--pixel-border)',
            marginTop: '4px',
            paddingTop: '8px',
            display: 'flex',
            gap: '4px',
            padding: '8px',
          }}
        >
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitManual();
            }}
            placeholder="/absolute/path/to/project"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '6px 8px',
              fontSize: '20px',
              background: 'var(--pixel-bg)',
              color: 'inherit',
              border: '1px solid var(--pixel-border)',
              borderRadius: 0,
            }}
          />
          <button
            onClick={submitManual}
            onMouseEnter={() => setHovered('open')}
            onMouseLeave={() => setHovered(null)}
            style={{
              ...menuItemBase,
              width: 'auto',
              padding: '6px 12px',
              justifyContent: 'center',
              background: hovered === 'open' ? HOVER_BG : 'transparent',
            }}
          >
            Open
          </button>
        </div>
      </div>
    </>
  );
}
