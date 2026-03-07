import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LAYOUT_FILE_DIR, STATE_FILE_NAME } from './constants.js';

export interface PersistedState {
	agents?: Array<{
		id: number;
		jsonlFile: string;
		projectDir: string;
		projectName?: string;
	}>;
	agentSeats?: Record<number, { palette: number; hueShift: number; seatId: string | null }>;
	soundEnabled?: boolean;
}

function getStateFilePath(): string {
	return path.join(os.homedir(), LAYOUT_FILE_DIR, STATE_FILE_NAME);
}

export function readState(): PersistedState {
	const filePath = getStateFilePath();
	try {
		if (!fs.existsSync(filePath)) return {};
		const raw = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(raw) as PersistedState;
	} catch {
		return {};
	}
}

export function writeState(state: PersistedState): void {
	const filePath = getStateFilePath();
	const dir = path.dirname(filePath);
	try {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const json = JSON.stringify(state, null, 2);
		const tmpPath = filePath + '.tmp';
		fs.writeFileSync(tmpPath, json, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		console.error('[Pixel Agents] Failed to write state file:', err);
	}
}

export function updateState(partial: Partial<PersistedState>): void {
	const current = readState();
	writeState({ ...current, ...partial });
}
