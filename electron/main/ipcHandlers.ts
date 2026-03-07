import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { IpcMain } from 'electron';
import { dialog } from 'electron';

import type { AgentState, MessageSender } from './types.js';
import { SessionScanner } from './sessionScanner.js';
import { launchTerminal, focusTerminal } from './terminalLauncher.js';
import { readState, updateState } from './statePersistence.js';
import {
	loadFurnitureAssets, sendAssetsToWebview,
	loadFloorTiles, sendFloorTilesToWebview,
	loadWallTiles, sendWallTilesToWebview,
	loadCharacterSprites, sendCharacterSpritesToWebview,
	loadDefaultLayout,
} from './assetLoader.js';
import {
	readLayoutFromFile, writeLayoutToFile, loadLayout,
	watchLayoutFile,
} from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { startFileWatching } from './fileWatcher.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { JSONL_POLL_INTERVAL_MS } from './constants.js';
import { getMainWindow } from './windowManager.js';

// ── Shared state ──────────────────────────────────────────────
const agents = new Map<number, AgentState>();
const nextAgentId = { current: 1 };
const fileWatchers = new Map<number, fs.FSWatcher>();
const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
const jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

let layoutWatcher: LayoutWatcher | null = null;
let defaultLayout: Record<string, unknown> | null = null;
let scanner: SessionScanner | null = null;

function persistAgents(): void {
	const persisted = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			projectName: agent.projectName,
		});
	}
	updateState({ agents: persisted });
}

function getAssetsRoot(): string {
	const { app } = require('electron');
	const isDev = !app.isPackaged;
	if (isDev) {
		// __dirname = electron/dist/ in dev
		const projectRoot = path.resolve(__dirname, '..', '..');
		const publicAssets = path.join(projectRoot, 'webview-ui', 'public');
		if (fs.existsSync(path.join(publicAssets, 'assets'))) {
			return publicAssets;
		}
		// Fallback: try electron/dist/assets (copied by esbuild script)
		if (fs.existsSync(path.join(__dirname, 'assets'))) {
			return __dirname;
		}
		return publicAssets;
	}
	// Production: assets are in the same directory as main.js
	return __dirname;
}

export function setupIpcHandlers(
	ipcMain: IpcMain,
	sendToWebview: (msg: unknown) => void,
): void {
	const webview: MessageSender = { postMessage: sendToWebview };

	scanner = new SessionScanner(
		nextAgentId, agents,
		fileWatchers, pollingTimers, waitingTimers, permissionTimers,
		webview, persistAgents, removeAgent,
	);

	ipcMain.on('webview-message', async (_event, message: Record<string, unknown>) => {
		const type = message.type as string;

		if (type === 'webviewReady') {
			// Load and send assets
			const assetsRoot = getAssetsRoot();

			const state = readState();
			sendToWebview({ type: 'settingsLoaded', soundEnabled: state.soundEnabled ?? true });

			(async () => {
				try {
					defaultLayout = loadDefaultLayout(assetsRoot);

					const charSprites = await loadCharacterSprites(assetsRoot);
					if (charSprites) sendCharacterSpritesToWebview(webview, charSprites);

					const floorTiles = await loadFloorTiles(assetsRoot);
					if (floorTiles) sendFloorTilesToWebview(webview, floorTiles);

					const wallTiles = await loadWallTiles(assetsRoot);
					if (wallTiles) sendWallTilesToWebview(webview, wallTiles);

					const assets = await loadFurnitureAssets(assetsRoot);
					if (assets) sendAssetsToWebview(webview, assets);
				} catch (err) {
					console.error('[Electron] Error loading assets:', err);
				}

				// Send layout
				console.log('[Electron] Loading layout...');
				const layout = loadLayout(defaultLayout);
				const fCount = layout && Array.isArray(layout.furniture) ? layout.furniture.length : 'null';
				console.log(`[Electron] Sending layout: ${layout ? `${layout.cols}x${layout.rows}, ${fCount} items` : 'null (using default)'}`);
				sendToWebview({ type: 'layoutLoaded', layout });
				startLayoutWatcher(sendToWebview);
			})();

			// Send existing agents
			const agentSeats = state.agentSeats || {};
			scanner?.sendExistingAgents(agentSeats);

			// Start scanning for sessions
			scanner?.start();

		} else if (type === 'openClaude') {
			// Launch new Claude session in Terminal.app
			const cwd = (message.folderPath as string) || os.homedir();
			const sessionId = crypto.randomUUID();

			// Derive project dir path
			const dirName = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
			const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);

			// Create agent immediately
			const id = nextAgentId.current++;
			const projectName = path.basename(cwd);
			const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);

			const agent: AgentState = {
				id,
				projectDir,
				jsonlFile: expectedFile,
				fileOffset: 0,
				lineBuffer: '',
				activeToolIds: new Set(),
				activeToolStatuses: new Map(),
				activeToolNames: new Map(),
				activeSubagentToolIds: new Map(),
				activeSubagentToolNames: new Map(),
				isWaiting: false,
				permissionSent: false,
				hadToolsInTurn: false,
				projectName,
				sessionId,
			};

			agents.set(id, agent);
			persistAgents();
			sendToWebview({ type: 'agentCreated', id, folderName: projectName });

			// Launch Terminal.app
			launchTerminal(cwd, sessionId);

			// Poll for JSONL file to appear
			const pollTimer = setInterval(() => {
				try {
					if (fs.existsSync(agent.jsonlFile)) {
						clearInterval(pollTimer);
						jsonlPollTimers.delete(id);
						startFileWatching(
							id, agent.jsonlFile, agents,
							fileWatchers, pollingTimers, waitingTimers, permissionTimers,
							webview,
						);
					}
				} catch { /* file may not exist yet */ }
			}, JSONL_POLL_INTERVAL_MS);
			jsonlPollTimers.set(id, pollTimer);

		} else if (type === 'focusAgent') {
			// In Electron mode, we focus Terminal.app (can't target specific windows easily)
			focusTerminal();

		} else if (type === 'closeAgent') {
			const id = message.id as number;
			removeAgent(id);
			sendToWebview({ type: 'agentClosed', id });

		} else if (type === 'saveAgentSeats') {
			const seats = message.seats as Record<number, { palette: number; hueShift: number; seatId: string | null }>;
			updateState({ agentSeats: seats });

		} else if (type === 'saveLayout') {
			layoutWatcher?.markOwnWrite();
			writeLayoutToFile(message.layout as Record<string, unknown>);

		} else if (type === 'setSoundEnabled') {
			updateState({ soundEnabled: message.enabled as boolean });

		} else if (type === 'exportLayout') {
			const layout = readLayoutFromFile();
			if (!layout) return;
			const win = getMainWindow();
			if (!win) return;
			const result = await dialog.showSaveDialog(win, {
				filters: [{ name: 'JSON Files', extensions: ['json'] }],
				defaultPath: path.join(os.homedir(), 'pixel-agents-layout.json'),
			});
			if (!result.canceled && result.filePath) {
				fs.writeFileSync(result.filePath, JSON.stringify(layout, null, 2), 'utf-8');
			}

		} else if (type === 'importLayout') {
			const win = getMainWindow();
			if (!win) return;
			const result = await dialog.showOpenDialog(win, {
				filters: [{ name: 'JSON Files', extensions: ['json'] }],
				properties: ['openFile'],
			});
			if (result.canceled || result.filePaths.length === 0) return;
			try {
				const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
				const imported = JSON.parse(raw) as Record<string, unknown>;
				if (imported.version !== 1 || !Array.isArray(imported.tiles)) return;
				layoutWatcher?.markOwnWrite();
				writeLayoutToFile(imported);
				sendToWebview({ type: 'layoutLoaded', layout: imported });
			} catch { /* ignore bad files */ }
		}
	});
}

function removeAgent(agentId: number): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) clearInterval(jpTimer);
	jsonlPollTimers.delete(agentId);

	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) clearInterval(pt);
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	agents.delete(agentId);
	persistAgents();
}

function startLayoutWatcher(sendToWebview: (msg: unknown) => void): void {
	if (layoutWatcher) return;
	layoutWatcher = watchLayoutFile((layout) => {
		sendToWebview({ type: 'layoutLoaded', layout });
	});
}
