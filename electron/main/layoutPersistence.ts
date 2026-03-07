import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LAYOUT_FILE_DIR, LAYOUT_FILE_NAME, LAYOUT_FILE_POLL_INTERVAL_MS } from './constants.js';

export interface LayoutWatcher {
	markOwnWrite(): void;
	dispose(): void;
}

function getLayoutFilePath(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, LAYOUT_FILE_NAME);
}

export function readLayoutFromFile(): Record<string, unknown> | null {
	const filePath = getLayoutFilePath();
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function writeLayoutToFile(layout: Record<string, unknown>): void {
	const filePath = getLayoutFilePath();
	const dir = path.dirname(filePath);
	try {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const json = JSON.stringify(layout, null, 2);
		const tmpPath = filePath + '.tmp';
		fs.writeFileSync(tmpPath, json, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		console.error('[Pixel Agents] Failed to write layout file:', err);
	}
}

/**
 * Load layout from file, or write default if none exists.
 */
export function loadLayout(
	defaultLayout?: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const fromFile = readLayoutFromFile();
	if (fromFile) return fromFile;

	if (defaultLayout) {
		writeLayoutToFile(defaultLayout);
		return defaultLayout;
	}

	return null;
}

export function watchLayoutFile(
	onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
	const filePath = getLayoutFilePath();
	let skipNextChange = false;
	let lastMtime = 0;
	let fsWatcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let disposed = false;

	try {
		if (fs.existsSync(filePath)) {
			lastMtime = fs.statSync(filePath).mtimeMs;
		}
	} catch { /* ignore */ }

	function checkForChange(): void {
		if (disposed) return;
		try {
			if (!fs.existsSync(filePath)) return;
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs <= lastMtime) return;
			lastMtime = stat.mtimeMs;

			if (skipNextChange) {
				skipNextChange = false;
				return;
			}

			const raw = fs.readFileSync(filePath, 'utf-8');
			const layout = JSON.parse(raw) as Record<string, unknown>;
			onExternalChange(layout);
		} catch (err) {
			console.error('[Pixel Agents] Error checking layout file:', err);
		}
	}

	function startFsWatch(): void {
		if (disposed || fsWatcher) return;
		try {
			if (!fs.existsSync(filePath)) return;
			fsWatcher = fs.watch(filePath, () => {
				checkForChange();
			});
			fsWatcher.on('error', () => {
				fsWatcher?.close();
				fsWatcher = null;
			});
		} catch { /* ignore */ }
	}

	startFsWatch();
	pollTimer = setInterval(() => {
		checkForChange();
		if (!fsWatcher) startFsWatch();
	}, LAYOUT_FILE_POLL_INTERVAL_MS);

	return {
		markOwnWrite(): void {
			skipNextChange = true;
			try {
				if (fs.existsSync(filePath)) {
					lastMtime = fs.statSync(filePath).mtimeMs;
				}
			} catch { /* ignore */ }
		},
		dispose(): void {
			disposed = true;
			fsWatcher?.close();
			fsWatcher = null;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = null;
		},
	};
}
