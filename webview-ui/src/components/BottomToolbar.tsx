import { useEffect, useRef, useState } from 'react';

import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';
import { ProjectPickerModal } from './ProjectPickerModal.js';
import { Button } from './ui/Button.js';
import { Dropdown, DropdownItem } from './ui/Dropdown.js';

interface BottomToolbarProps {
  isEditMode: boolean;
  onOpenClaude: () => void;
  onToggleEditMode: () => void;
  isSettingsOpen: boolean;
  onToggleSettings: () => void;
  workspaceFolders: WorkspaceFolder[];
}

export function BottomToolbar({
  isEditMode,
  onOpenClaude,
  onToggleEditMode,
  isSettingsOpen,
  onToggleSettings,
  workspaceFolders,
}: BottomToolbarProps) {
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);
  const [isBypassMenuOpen, setIsBypassMenuOpen] = useState(false);
  const [isProjectPickerOpen, setIsProjectPickerOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  const pendingBypassRef = useRef(false);

  // Close folder picker / bypass menu on outside click
  useEffect(() => {
    if (!isFolderPickerOpen && !isBypassMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(e.target as Node)) {
        setIsFolderPickerOpen(false);
        setIsBypassMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isFolderPickerOpen, isBypassMenuOpen]);

  const hasMultipleFolders = workspaceFolders.length > 1;

  const launch = (folderPath?: string) => {
    const bypassPermissions = pendingBypassRef.current;
    pendingBypassRef.current = false;
    transport.send({
      type: 'launchAgent',
      ...(folderPath ? { folderPath } : {}),
      bypassPermissions,
    });
  };

  // Open whichever picker fits the host, remembering the bypass flag. Returns
  // true if a picker opened; false means the caller should launch directly.
  // Web app → recent-projects picker (server-served). VS Code → workspace folders.
  const openPicker = (bypass: boolean): boolean => {
    pendingBypassRef.current = bypass;
    if (isBrowserRuntime) {
      setIsProjectPickerOpen(true);
      return true;
    }
    if (hasMultipleFolders) {
      setIsFolderPickerOpen(true);
      return true;
    }
    return false;
  };

  const handleAgentClick = () => {
    setIsBypassMenuOpen(false);
    if (!openPicker(false)) onOpenClaude();
  };

  const handleProjectSelect = (folderPath: string) => {
    setIsProjectPickerOpen(false);
    launch(folderPath);
  };

  const closeProjectPicker = () => {
    pendingBypassRef.current = false;
    setIsProjectPickerOpen(false);
  };

  const handleAgentHover = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(true);
    }
  };

  const handleAgentLeave = () => {
    if (!isFolderPickerOpen) {
      setIsBypassMenuOpen(false);
    }
  };

  const handleFolderSelect = (folder: WorkspaceFolder) => {
    setIsFolderPickerOpen(false);
    launch(folder.path);
  };

  const handleBypassSelect = (bypassPermissions: boolean) => {
    setIsBypassMenuOpen(false);
    if (!openPicker(bypassPermissions)) launch();
  };

  return (
    <div
      className="absolute bottom-10 left-10 z-20 flex items-center gap-4 pixel-panel p-4"
      style={{
        marginBottom: 'env(safe-area-inset-bottom)',
        marginLeft: 'env(safe-area-inset-left)',
      }}
    >
      <div
        ref={folderPickerRef}
        className="relative"
        onMouseEnter={handleAgentHover}
        onMouseLeave={handleAgentLeave}
      >
        <Button
          variant="accent"
          onClick={handleAgentClick}
          className={
            isFolderPickerOpen || isBypassMenuOpen
              ? 'bg-accent-bright'
              : 'bg-accent hover:bg-accent-bright'
          }
        >
          + Agent
        </Button>
        <Dropdown isOpen={isBypassMenuOpen}>
          <DropdownItem onClick={() => handleBypassSelect(true)}>
            Skip permissions mode <span className="text-2xs text-warning">⚠</span>
          </DropdownItem>
        </Dropdown>
        <Dropdown isOpen={isFolderPickerOpen} className="min-w-128">
          {workspaceFolders.map((folder) => (
            <DropdownItem
              key={folder.path}
              onClick={() => handleFolderSelect(folder)}
              className="text-base"
            >
              {folder.name}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
      <Button
        variant={isEditMode ? 'active' : 'default'}
        onClick={onToggleEditMode}
        title="Edit office layout"
      >
        Layout
      </Button>
      <Button
        variant={isSettingsOpen ? 'active' : 'default'}
        onClick={onToggleSettings}
        title="Settings"
      >
        Settings
      </Button>
      <ProjectPickerModal
        isOpen={isProjectPickerOpen}
        onClose={closeProjectPicker}
        onSelect={handleProjectSelect}
      />
    </div>
  );
}
