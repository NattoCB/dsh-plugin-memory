// @ts-check
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { globalMemoryDir, projectMemoryDir } from "./paths.js";

/**
 * Hard truncation budget for the MEMORY.md entry index, mirrored from the
 * reference 5-layer memory design so the booted context stays cheap.
 */
export const ENTRY_INDEX_MAX_LINES = 200;
export const ENTRY_INDEX_MAX_CHARS = 40000;
/** Each index line stays a short one-line pointer. */
export const ENTRY_INDEX_MAX_LINE_CHARS = 150;

/**
 * Low-level file helpers that always operate under the memory root. Memory is
 * an "intended persistence" target, so writes are unconditional and local; the
 * agent sandbox never gates them. All paths are joined inside `root` to keep a
 * write from escaping the memory directory.
 */
class MemoryStore {
	/**
	 * @param {string} root - absolute memory root directory.
	 * @param {boolean} global - whether this is the global store (L0/L1) vs project (L2).
	 */
	constructor(root, global) {
		this.root = root;
		this.global = global;
	}

	/** Ensure the store directory tree exists. Idempotent. */
	async ensure() {
		await fs.mkdir(this.root, { recursive: true });
	}

	/**
	 * Resolve a path inside the store, refusing to escape the root.
	 * @param {string} rel - relative path inside the memory root.
	 * @returns {string} absolute path.
	 */
	_resolve(rel) {
		const full = join(this.root, rel);
		if (!full.startsWith(this.root)) {
			throw new Error(`memory path escapes store root: ${rel}`);
		}
		return full;
	}

	/** Whether a file exists. */
	async exists(rel) {
		try {
			const st = await fs.stat(this._resolve(rel));
			return st.isFile();
		} catch {
			return false;
		}
	}

	/** Read a file as UTF-8 text, or `undefined` when absent. */
	async read(rel) {
		try {
			return await fs.readFile(this._resolve(rel), "utf8");
		} catch {
			return undefined;
		}
	}

	/**
	 * Read a file together with its modification time, for freshness labels.
	 * @param {string} rel - relative path inside the memory root.
	 * @returns {Promise<{ content: string, mtimeMs: number } | undefined>}
	 */
	async readInfo(rel) {
		try {
			const full = this._resolve(rel);
			const st = await fs.stat(full);
			const content = await fs.readFile(full, "utf8");
			return { content, mtimeMs: st.mtimeMs };
		} catch {
			return undefined;
		}
	}

	/** Absolute path of a relative file (used for freshness stat outside the store). */
	resolvePath(rel) {
		return this._resolve(rel);
	}

	/** Write a file, creating parent directories as needed. */
	async write(rel, content) {
		const full = this._resolve(rel);
		await fs.mkdir(join(full, ".."), { recursive: true });
		await fs.writeFile(full, content, "utf8");
	}

	/** List all `.md` topic files (excluding the index) in a directory. */
	async listTopics(relDir = ".") {
		const full = this._resolve(relDir);
		let entries;
		try {
			entries = await fs.readdir(full, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")
			.map((e) => e.name.replace(/\.md$/, ""));
	}
}

/** Build a global store rooted at `<dshHome>/memory`. */
export function makeGlobalStore(dshHome) {
	return new MemoryStore(globalMemoryDir(dshHome), true);
}

/** Build a project store rooted at `<cwd>/.dsh/memory`. */
export function makeProjectStore(cwd) {
	return new MemoryStore(projectMemoryDir(cwd), false);
}

/**
 * Truncate an entry index string to the hard budget (lines then chars),
 * appending a notice when content was dropped.
 * @param {string} text - raw index text.
 * @returns {string} truncated text.
 */
export function truncateIndex(text) {
	const lines = text.split("\n");
	let truncated = lines;
	if (lines.length > ENTRY_INDEX_MAX_LINES) {
		truncated = lines.slice(0, ENTRY_INDEX_MAX_LINES);
		truncated.push(`<!-- index truncated: ${lines.length - ENTRY_INDEX_MAX_LINES} more lines omitted -->`);
	}
	let joined = truncated.join("\n");
	if (joined.length > ENTRY_INDEX_MAX_CHARS) {
		joined = joined.slice(0, ENTRY_INDEX_MAX_CHARS) + "\n<!-- index truncated to char budget -->";
	}
	return joined;
}

/**
 * Daily memory (L3). One file per calendar day, appended line-by-line and never
 * merged, so it stays readable indefinitely.
 */
export class DailyMemory {
	/**
	 * @param {string} cwd - session working directory.
	 */
	constructor(cwd) {
		this.dir = join(cwd, ".dsh", "memory");
	}

	async ensure() {
		await fs.mkdir(this.dir, { recursive: true });
	}

	/**
	 * Append one dated line to `<cwd>/.dsh/memory/YYYY-MM-DD.md`.
	 * @param {string} date - `YYYY-MM-DD` stamp.
	 * @param {string} line - single fact line (without leading `- `).
	 */
	async append(date, line) {
		await this.ensure();
		const file = join(this.dir, `${date}.md`);
		let header = "";
		try {
			await fs.access(file);
		} catch {
			header = `# ${date}\n\n`;
		}
		const entry = header + `- ${line}\n`;
		await fs.appendFile(file, entry, "utf8");
	}
}

/**
 * L1 global profile with four stable sections and Version-N rotation. Because
 * DSH has a single user, the profile is `profile.md` (no uid layer). The
 * rotation merges new facts into the fixed structure and keeps the previous
 * version in `profile.md.bak`.
 */
export class ProfileMemory {
	/**
	 * @param {MemoryStore} store - global store.
	 */
	constructor(store) {
		this.store = store;
		this.file = "profile.md";
	}

	/** The four fixed sections, in display order. */
	static SECTIONS = ["工作背景", "个人背景", "当前关注", "近期动态"];

	/**
	 * Read the current profile, returning a structured view or `undefined`.
	 * @returns {Promise<{ version: number, sections: Record<string, string[]> } | undefined>}
	 */
	async read() {
		const text = await this.store.read(this.file);
		if (text === undefined) return undefined;
		const versionMatch = text.match(/^>\s*Version:\s*(\d+)/m);
		const version = versionMatch ? Number(versionMatch[1]) : 0;
		const sections = {};
		for (const name of ProfileMemory.SECTIONS) sections[name] = [];
		const sectionRe = new RegExp(`^##\\s*${ProfileMemory.SECTIONS.map(escapeRe).join("|")}`, "m");
		const lines = text.split("\n");
		let current = undefined;
		for (const line of lines) {
			const m = line.match(/^##\s*(.+?)\s*$/);
			if (m && ProfileMemory.SECTIONS.includes(m[1].trim())) {
				current = m[1].trim();
				continue;
			}
			if (current && line.trim().startsWith("- ")) {
				sections[current].push(line.trim().slice(2).trim());
			}
		}
		void sectionRe;
		return { version, sections };
	}

	/**
	 * Render the profile to its canonical markdown form.
	 * @param {number} version - profile version.
	 * @param {Record<string, string[]>} sections - section -> bullet lines.
	 * @returns {string} canonical markdown.
	 */
	render(version, sections) {
		const stamp = new Date().toISOString();
		const head = `# User Memory Profile\n> Last updated: ${stamp}\n> Version: ${version}\n\n## Memory Block\n`;
		const body = ProfileMemory.SECTIONS.map((name) => {
			const items = (sections[name] ?? []).map((l) => `- ${l}`).join("\n");
			return `**${name}**\n${items || "(empty)"}`;
		}).join("\n\n");
		return head + body + "\n";
	}

	/**
	 * Persist a merged profile, rotating the previous copy to `.bak`.
	 * @param {number} version - new version (caller increments).
	 * @param {Record<string, string[]>} sections - merged sections.
	 */
	async write(version, sections) {
		const next = this.render(version, sections);
		const full = this.store._resolve(this.file);
		try {
			const prev = await fs.readFile(full, "utf8");
			await fs.writeFile(full + ".bak", prev, "utf8");
		} catch {
			// no previous version yet
		}
		await this.store.write(this.file, next);
	}
}

/** Escape a string for safe use inside a regex alternation. */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
