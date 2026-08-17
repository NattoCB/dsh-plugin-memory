// @ts-check
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve the DeepSeek Harness home directory.
 *
 * Honors `DSH_HOME` (the same override DSH itself reads) and otherwise falls
 * back to `~/.dsh`. DSH serves exactly one user per installation, so there is
 * no per-account layer: the global memory lives directly under this home.
 *
 * @returns {string} absolute harness home path.
 */
export function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
	return join(homedir(), ".dsh");
}

/**
 * Absolute path of the global memory directory (`<dshHome>/memory`).
 *
 * @param {string} dshHome - resolved harness home.
 * @returns {string} global memory directory path.
 */
export function globalMemoryDir(dshHome) {
	return join(dshHome, "memory");
}

/**
 * Absolute path of the per-project memory directory (`<cwd>/.dsh/memory`).
 *
 * DSH keeps a single working directory per session; project memory is keyed by
 * that directory rather than a compressed hash, which keeps paths human-readable
 * and lets the agent open them directly.
 *
 * @param {string} cwd - session working directory.
 * @returns {string} project memory directory path.
 */
export function projectMemoryDir(cwd) {
	return join(cwd, ".dsh", "memory");
}
