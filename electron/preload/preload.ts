import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pixelAgentsApi', {
	postMessage(msg: unknown): void {
		ipcRenderer.send('webview-message', msg);
	},
	onMessage(callback: (msg: unknown) => void): () => void {
		const handler = (_event: Electron.IpcRendererEvent, msg: unknown) => {
			callback(msg);
		};
		ipcRenderer.on('main-message', handler);
		return () => {
			ipcRenderer.removeListener('main-message', handler);
		};
	},
	minimizeWindow(): void {
		ipcRenderer.send('window-minimize');
	},
	closeWindow(): void {
		ipcRenderer.send('window-close');
	},
});
