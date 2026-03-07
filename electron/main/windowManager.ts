import * as path from 'path';
import { BrowserWindow, ipcMain } from 'electron';

let mainWindow: BrowserWindow | null = null;

export function createWindow(): BrowserWindow {
	const preloadPath = path.join(__dirname, 'preload.js');

	mainWindow = new BrowserWindow({
		frame: false,
		alwaysOnTop: true,
		resizable: true,
		minimizable: true,
		maximizable: false,
		backgroundColor: '#1e1e2e',
		width: 480,
		height: 360,
		minWidth: 320,
		minHeight: 240,
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Window control IPC handlers
	ipcMain.on('window-minimize', () => {
		mainWindow?.minimize();
	});

	ipcMain.on('window-close', () => {
		mainWindow?.close();
	});

	return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
	return mainWindow;
}

export function sendToWebview(msg: unknown): void {
	mainWindow?.webContents.send('main-message', msg);
}
