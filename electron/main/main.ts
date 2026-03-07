import * as path from 'path';
import { app, ipcMain } from 'electron';
import { createWindow, getMainWindow, sendToWebview } from './windowManager.js';
import { setupIpcHandlers } from './ipcHandlers.js';

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

app.on('second-instance', () => {
	const win = getMainWindow();
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
	}
});

app.whenReady().then(() => {
	const win = createWindow();

	// Load webview content
	const isDev = !app.isPackaged;
	// __dirname = electron/dist/ in dev, resources/app/dist/ in prod
	const projectRoot = path.resolve(__dirname, '..', '..');
	if (isDev) {
		// Dev mode: try Vite dev server, fall back to built files
		const devUrl = 'http://localhost:5173';
		const fallbackPath = path.join(projectRoot, 'dist', 'webview', 'index.html');

		// Quick-check if Vite is running before trying to load
		import('http').then(({ default: http }) => {
			const req = http.get(devUrl, (res) => {
				res.resume();
				if (res.statusCode === 200) {
					win.loadURL(devUrl);
				} else {
					console.log('[Electron] Vite not responding, loading built files');
					win.loadFile(fallbackPath);
				}
			});
			req.on('error', () => {
				console.log('[Electron] Vite not running, loading built files from:', fallbackPath);
				win.loadFile(fallbackPath);
			});
			req.setTimeout(1000, () => {
				req.destroy();
				console.log('[Electron] Vite connection timeout, loading built files');
				win.loadFile(fallbackPath);
			});
		});
	} else {
		const indexPath = path.join(__dirname, 'webview', 'index.html');
		win.loadFile(indexPath);
	}

	setupIpcHandlers(ipcMain, sendToWebview);
});

app.on('window-all-closed', () => {
	app.quit();
});
