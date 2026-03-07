import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentState, MessageSender } from './types.js';
import { startFileWatching } from './fileWatcher.js';
import { SESSION_SCAN_INTERVAL_MS, SESSION_ACTIVE_THRESHOLD_MS } from './constants.js';

export class SessionScanner {
	private scanTimer: ReturnType<typeof setInterval> | null = null;
	private nextAgentId: { current: number };
	private agents: Map<number, AgentState>;
	private fileWatchers: Map<number, fs.FSWatcher>;
	private pollingTimers: Map<number, ReturnType<typeof setInterval>>;
	private waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
	private permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
	private webview: MessageSender | undefined;
	private persistAgents: () => void;
	private removeAgentCallback: (agentId: number) => void;

	constructor(
		nextAgentId: { current: number },
		agents: Map<number, AgentState>,
		fileWatchers: Map<number, fs.FSWatcher>,
		pollingTimers: Map<number, ReturnType<typeof setInterval>>,
		waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
		permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
		webview: MessageSender | undefined,
		persistAgents: () => void,
		removeAgentCallback: (agentId: number) => void,
	) {
		this.nextAgentId = nextAgentId;
		this.agents = agents;
		this.fileWatchers = fileWatchers;
		this.pollingTimers = pollingTimers;
		this.waitingTimers = waitingTimers;
		this.permissionTimers = permissionTimers;
		this.webview = webview;
		this.persistAgents = persistAgents;
		this.removeAgentCallback = removeAgentCallback;
	}

	setWebview(webview: MessageSender): void {
		this.webview = webview;
	}

	start(): void {
		if (this.scanTimer) return;
		this.scan();
		this.scanTimer = setInterval(() => this.scan(), SESSION_SCAN_INTERVAL_MS);
	}

	stop(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
	}

	private isFileTrackedByAgent(filePath: string): boolean {
		for (const agent of this.agents.values()) {
			if (agent.jsonlFile === filePath) return true;
		}
		return false;
	}

	private scan(): void {
		const projectsDir = path.join(os.homedir(), '.claude', 'projects');
		if (!fs.existsSync(projectsDir)) return;

		const now = Date.now();
		const activeFiles = new Set<string>();

		try {
			const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
			for (const entry of projectDirs) {
				if (!entry.isDirectory()) continue;
				const projectDir = path.join(projectsDir, entry.name);
				const projectName = deriveProjectName(entry.name);

				try {
					const files = fs.readdirSync(projectDir);
					for (const file of files) {
						if (!file.endsWith('.jsonl')) continue;
						const filePath = path.join(projectDir, file);

						try {
							const stat = fs.statSync(filePath);
							const age = now - stat.mtimeMs;
							if (age > SESSION_ACTIVE_THRESHOLD_MS) continue;

							activeFiles.add(filePath);

							// Only create if no agent (from scanner OR openClaude) already tracks this file
							if (!this.isFileTrackedByAgent(filePath)) {
								this.addSession(filePath, projectDir, projectName);
							}
						} catch { /* skip inaccessible files */ }
					}
				} catch { /* skip inaccessible dirs */ }
			}
		} catch { /* projects dir inaccessible */ }

		// Remove ALL agents whose JSONL files have gone stale
		// Collect IDs first to avoid mutating the map during iteration
		const staleIds: number[] = [];
		for (const [agentId, agent] of this.agents) {
			if (!activeFiles.has(agent.jsonlFile)) {
				staleIds.push(agentId);
			}
		}
		for (const agentId of staleIds) {
			this.removeAgentCallback(agentId);
			this.webview?.postMessage({ type: 'agentClosed', id: agentId });
		}
	}

	private addSession(jsonlFile: string, projectDir: string, projectName: string): void {
		const id = this.nextAgentId.current++;
		const sessionId = path.basename(jsonlFile, '.jsonl');

		const agent: AgentState = {
			id,
			projectDir,
			jsonlFile,
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

		this.agents.set(id, agent);
		this.persistAgents();

		console.log(`[SessionScanner] New session detected: ${projectName} (agent ${id})`);
		this.webview?.postMessage({ type: 'agentCreated', id, folderName: projectName });

		// Start watching from current position (don't replay history)
		try {
			const stat = fs.statSync(jsonlFile);
			agent.fileOffset = stat.size;
		} catch { /* ignore */ }

		startFileWatching(
			id, jsonlFile, this.agents,
			this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
			this.webview,
		);
	}

	/** Send existing tracked agents to webview */
	sendExistingAgents(agentSeats: Record<number, { palette?: number; hueShift?: number; seatId?: string | null }>): void {
		if (!this.webview) return;
		const agentIds: number[] = [];
		const folderNames: Record<number, string> = {};
		for (const [id, agent] of this.agents) {
			agentIds.push(id);
			if (agent.projectName) {
				folderNames[id] = agent.projectName;
			}
		}
		agentIds.sort((a, b) => a - b);

		this.webview.postMessage({
			type: 'existingAgents',
			agents: agentIds,
			agentMeta: agentSeats,
			folderNames,
		});

		// Re-send current statuses
		for (const [agentId, agent] of this.agents) {
			for (const [toolId, status] of agent.activeToolStatuses) {
				this.webview.postMessage({
					type: 'agentToolStart',
					id: agentId,
					toolId,
					status,
				});
			}
			if (agent.isWaiting) {
				this.webview.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
		}
	}
}

/**
 * Derive a human-readable project name from a Claude project hash directory name.
 * The hash replaces all non-alphanumeric/hyphen chars with -, so:
 *   /Volumes/SSD_990/Home/projects/telvana/telvana-pipecat
 *   -> -Volumes-SSD-990-Home-projects-telvana-telvana-pipecat
 *
 * Since underscores, slashes, colons all become hyphens, we can't reverse it.
 * Instead, scan the user's home directory for project folders that hash to this name.
 */
function deriveProjectName(dirName: string): string {
	// Strategy: hash known project directories and find a match
	const homeDir = os.homedir();
	const commonRoots = [
		homeDir,
		path.join(homeDir, 'projects'),
		path.join(homeDir, 'Projects'),
		path.join(homeDir, 'Developer'),
		path.join(homeDir, 'dev'),
		path.join(homeDir, 'code'),
		path.join(homeDir, 'src'),
		path.join(homeDir, 'work'),
		path.join(homeDir, 'Documents'),
	];

	// Also check /Volumes/*/... paths
	try {
		const volumesDir = '/Volumes';
		if (fs.existsSync(volumesDir)) {
			const volumes = fs.readdirSync(volumesDir, { withFileTypes: true });
			for (const v of volumes) {
				if (v.isDirectory() || v.isSymbolicLink()) {
					const volBase = path.join(volumesDir, v.name);
					commonRoots.push(volBase);
					// Check for common project dirs inside the volume
					for (const sub of ['Home/projects', 'projects', 'Users']) {
						const volSub = path.join(volBase, sub);
						if (fs.existsSync(volSub)) {
							commonRoots.push(volSub);
						}
					}
				}
			}
		}
	} catch { /* ignore */ }

	function hashPath(p: string): string {
		return p.replace(/[^a-zA-Z0-9-]/g, '-');
	}

	// Search 2 levels deep from each common root
	for (const root of commonRoots) {
		try {
			if (!fs.existsSync(root)) continue;
			const entries = fs.readdirSync(root, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const fullPath = path.join(root, entry.name);
				if (hashPath(fullPath) === dirName) {
					return entry.name;
				}
				// Check one level deeper
				try {
					const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
					for (const sub of subEntries) {
						if (!sub.isDirectory()) continue;
						const subPath = path.join(fullPath, sub.name);
						if (hashPath(subPath) === dirName) {
							return sub.name;
						}
					}
				} catch { /* skip unreadable dirs */ }
			}
		} catch { /* skip unreadable dirs */ }
	}

	// Fallback: take text after last "projects-" pattern
	const projectsMatch = dirName.match(/projects-(.+)$/);
	if (projectsMatch) {
		return projectsMatch[1];
	}

	// Last resort
	const parts = dirName.split('-').filter(Boolean);
	return parts[parts.length - 1] || dirName;
}
