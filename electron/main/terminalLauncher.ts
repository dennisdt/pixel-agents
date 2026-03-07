import { execFile } from 'child_process';

/**
 * Launch a new Claude Code session in Terminal.app
 */
export function launchTerminal(cwd: string, sessionId: string): void {
	const escapedCwd = cwd.replace(/'/g, "'\\''");
	const script = `tell application "Terminal"
	activate
	do script "cd '${escapedCwd}' && claude --session-id ${sessionId}"
end tell`;

	execFile('osascript', ['-e', script], (err) => {
		if (err) {
			console.error('[Pixel Agents] Failed to launch Terminal.app:', err);
		}
	});
}

/**
 * Focus Terminal.app (bring to front)
 */
export function focusTerminal(): void {
	const script = `tell application "Terminal" to activate`;
	execFile('osascript', ['-e', script], (err) => {
		if (err) {
			console.error('[Pixel Agents] Failed to focus Terminal.app:', err);
		}
	});
}
