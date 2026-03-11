/** Shared style constants for modal dialogs (SettingsModal, ProjectPickerModal, etc.) */

export const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  background: 'rgba(0, 0, 0, 0.5)',
  zIndex: 'var(--pixel-modal-backdrop-z)',
}

export const modalContainerStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  zIndex: 'var(--pixel-modal-z)',
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px',
  boxShadow: 'var(--pixel-shadow)',
}

export const modalHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 10px',
  borderBottom: '1px solid var(--pixel-border)',
  marginBottom: '4px',
}

export const modalTitleStyle: React.CSSProperties = {
  fontSize: '24px',
  color: 'rgba(255, 255, 255, 0.9)',
}

export const modalCloseButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  color: 'rgba(255, 255, 255, 0.6)',
  fontSize: '24px',
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
}

export const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontSize: '24px',
  color: 'rgba(255, 255, 255, 0.8)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

export const HOVER_BG = 'rgba(255, 255, 255, 0.08)'
