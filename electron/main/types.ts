export interface MessageSender {
	postMessage(message: unknown): void;
}

export interface AgentState {
	id: number;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>;
	activeSubagentToolNames: Map<string, Map<string, string>>;
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Display name derived from project directory */
	projectName?: string;
	/** Session ID (UUID) extracted from JSONL filename */
	sessionId?: string;
}

export interface PersistedAgent {
	id: number;
	jsonlFile: string;
	projectDir: string;
	projectName?: string;
	palette?: number;
	hueShift?: number;
	seatId?: string | null;
}
