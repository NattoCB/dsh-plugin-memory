// @ts-check
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolveDshHome } from "./paths.js";
import { makeGlobalStore, makeProjectStore, DailyMemory, ProfileMemory } from "./store.js";
import { buildEntryInstruction, buildRelevanceReminder, keywordScore, fitIndexLines } from "./inject.js";
import { callLlm, CallConfigSchema } from "./llm.js";

//#region message construction (mirrors dsh-time-context invariants)
/** Brand a message identifier. */
function MessageId(id) {
	return id;
}
/** Deep-freeze a value in place, skipping AbortSignal. */
function deepFreeze(value) {
	const seen = new WeakSet();
	const pending = [{ kind: "visit", node: value }];
	while (pending.length > 0) {
		const task = pending.pop();
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({ kind: "visit", node: task.source[task.key] });
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let i = keys.length - 1; i >= 0; i--) {
			const key = keys[i];
			if (key === void 0) continue;
			pending.push({ kind: "property", source: node, key });
		}
	}
	return value;
}
/** Create one identified, frozen user message. */
function createUserMessage(input) {
	return deepFreeze(Object.freeze({
		...input,
		id: MessageId(crypto.randomUUID()),
		role: "user",
	}));
}
//#endregion

/** Plugin name used by loader diagnostics and message sources. */
const name = "memory";

/** The agent registry (pre-step, status) and the tool registry. */
const inject = ["agents", "tools"];

/** Schemastery validation for {@link Config}. */
const Config = z.object({
	enableEntryInjection: z.boolean().default(true),
	enableRelevance: z.boolean().default(true),
	enableExtraction: z.boolean().default(true),
	maxRelevant: z.number().step(1).min(1).max(20).default(5),
	relevanceTopK: z.number().step(1).min(1).max(40).default(8),
	relevanceBudgetChars: z.number().step(1).min(200).default(2000),
	extractionDebounceMs: z.number().step(1).min(0).default(60000),
	extractionLookback: z.number().step(1).min(5).max(200).default(40),
	llm: CallConfigSchema.default({ provider: "", model: "", maxTokens: 1024 }),
});

/** Escape a `</system-reminder>` sequence so the wrapped body cannot close the frame. */
function escapeBody(body) {
	return body.replaceAll("</system-reminder>", "<\\/system-reminder>");
}

/** Render one age label from a modification timestamp. */
function ageLabel(mtimeMs) {
	const days = Math.floor((Date.now() - mtimeMs) / 86400000);
	if (days <= 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

/** Extract the last human (non-plugin) user-role query text from a message batch. */
function extractLastUserQuery(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (m.source && m.source.kind === "plugin") continue;
		const text = (m.content ?? [])
			.filter((b) => b && b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/** Build a plugin-owned message source for a memory sub-channel. */
function pluginSource(channel, text) {
	return {
		kind: "plugin",
		plugin: name,
		form: "snapshot",
		sections: [{ name: `memory-${channel}`, text }],
	};
}

/**
 * Register the plugin: memory tools, the per-step injection listener, and the
 * idle-time auto-extraction scheduler.
 *
 * @param {any} ctx - cordis plugin context.
 * @param {z.infer<typeof Config>} config - resolved configuration.
 */
function apply(ctx, config) {
	const dshHome = resolveDshHome();
	const globalStore = makeGlobalStore(dshHome);
	const projectStoreCache = new Map();
	const dailyStoreCache = new Map();

	/** Get (and cache) the project store for one working directory. */
	function projectStoreFor(cwd) {
		let s = projectStoreCache.get(cwd);
		if (!s) {
			s = makeProjectStore(cwd);
			projectStoreCache.set(cwd, s);
		}
		return s;
	}
	/** Get (and cache) the daily store for one working directory. */
	function dailyStoreFor(cwd) {
		let s = dailyStoreCache.get(cwd);
		if (!s) {
			s = new DailyMemory(cwd);
			dailyStoreCache.set(cwd, s);
		}
		return s;
	}

	const booted = new WeakSet();
	const surfaced = new Map();
	/** Session id -> { timer, lastSeq, inFlight }. */
	const extractionState = new Map();

	function surfacedFor(sessionId) {
		let set = surfaced.get(sessionId);
		if (!set) {
			set = new Set();
			surfaced.set(sessionId, set);
		}
		return set;
	}

	// ---- per-step injection -------------------------------------------------
	if (config.enableEntryInjection || config.enableRelevance) {
		ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			const sessionId = agent.session.id;
			const cwd = agent.session.header.cwd;
			const messages = [...decision.messages];

			if (config.enableEntryInjection && !booted.has(agent.session)) {
				booted.add(agent.session);
				await globalStore.ensure();
				const globalIndex = (await globalStore.read("MEMORY.md")) ?? "";
				const hasProfile = await globalStore.exists("profile.md");
				let projectIndex;
				if (cwd) {
					const ps = projectStoreFor(cwd);
					await ps.ensure();
					projectIndex = (await ps.read("MEMORY.md")) ?? "";
				}
				const entryText = buildEntryInstruction({
					globalIndex,
					projectIndex,
					hasProfile,
				});
				messages.push(createUserMessage({
					content: [{ type: "text", text: entryText }],
					source: pluginSource("entry", entryText),
				}));
			}

			if (config.enableRelevance) {
				const query = extractLastUserQuery(decision.messages);
				if (query && cwd) {
					const hits = await selectRelevant(ctx, config, globalStore, projectStoreFor(cwd), query, signal);
					const surf = surfacedFor(sessionId);
					const fresh = hits.filter((h) => !surf.has(h.key));
					if (fresh.length > 0) {
						fresh.forEach((h) => surf.add(h.key));
						const reminder = buildRelevanceReminder(fresh, escapeBody);
						messages.push(createUserMessage({
							content: [{ type: "text", text: reminder }],
							source: pluginSource("relevance", reminder),
						}));
					}
				}
			}

			return { kind: "enter", messages };
		}, { prepend: true });
	}

	// ---- idle-time auto-extraction -----------------------------------------
	if (config.enableExtraction && config.llm.provider && config.llm.model) {
		ctx.on("agent/status", ({ agent, status }) => {
			if (status !== "idle") return;
			const cwd = agent.session.header.cwd;
			if (!cwd) return;
			scheduleExtraction(ctx, config, agent, cwd, globalStore, projectStoreFor(cwd), extractionState);
		});
	}

	// ---- tools --------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "memory_write",
		description: "Save or update a semantic memory. Write detailed notes to a topic file and (optionally) register a one-line pointer in MEMORY.md. Use for stable patterns, decisions, paths, user preferences, and recurring solutions — not session-specific state.",
		parameters: {
			scope: {
				type: "string", required: true,
				description: "Where to store: 'global' (cross-project, under ~/.dsh/memory) or 'project' (this working directory, under <cwd>/.dsh/memory).",
				enum: ["global", "project"],
			},
			topic: {
				type: "string", required: true,
				description: "Topic file name without extension, e.g. 'debugging' or 'caching'. Lowercase, hyphens for spaces.",
			},
			content: {
				type: "string", required: true,
				description: "The full markdown content of the topic file. Organize by heading; keep it specific (file names, interfaces, parameters).",
			},
			indexLine: {
				type: "string",
				description: "Optional one-line pointer (<=150 chars) added to MEMORY.md, e.g. '- [Caching](caching.md) — LRU eviction design'.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					updatedIndex: { type: "boolean", required: true },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: `Saved memory to ${value.path}${value.updatedIndex ? " and updated MEMORY.md index" : ""}.`,
			}],
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd;
			const store = args.scope === "project" && cwd ? projectStoreFor(cwd) : globalStore;
			await store.ensure();
			const file = `${args.topic.replace(/\.md$/, "")}.md`;
			await store.write(file, args.content);
			let updatedIndex = false;
			if (args.indexLine && args.indexLine.trim().length > 0) {
				updatedIndex = await appendIndexLine(store, args.indexLine.trim());
			}
			return Promise.resolve({ path: store.resolvePath(file), updatedIndex });
		},
		presentCall: (args) => ({
			card: "generic", title: "Save memory", kind: "other",
			rawInput: { scope: args.scope, topic: args.topic },
		}),
	}));

	ctx.tools.register(defineTool({
		name: "memory_read",
		description: "Read a memory topic file (or the MEMORY.md index) by name. Use to recall a previously saved pattern, decision, or preference.",
		parameters: {
			scope: { type: "string", required: true, enum: ["global", "project"] },
			topic: {
				type: "string", required: true,
				description: "Topic file name without extension, or 'MEMORY' to read the index.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: { type: "boolean", required: true },
					content: { type: "string", required: true },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: value.found ? `Memory:\n${value.content}` : "No such memory found.",
			}],
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd;
			const store = args.scope === "project" && cwd ? projectStoreFor(cwd) : globalStore;
			const rel = args.topic === "MEMORY" ? "MEMORY.md" : `${args.topic.replace(/\.md$/, "")}.md`;
			const content = await store.read(rel);
			return Promise.resolve({ found: content !== undefined, content: content ?? "" });
		},
		presentCall: (args) => ({
			card: "generic", title: "Read memory", kind: "other",
			rawInput: { scope: args.scope, topic: args.topic },
		}),
	}));

	ctx.tools.register(defineTool({
		name: "memory_search",
		description: "Keyword-search memory topic files across global and project stores. Use narrow terms (error messages, file paths, function names).",
		parameters: {
			query: { type: "string", required: true, description: "Search terms." },
			scope: { type: "string", enum: ["global", "project", "both"], description: "Which store to search (default 'both')." },
			limit: { type: "integer", description: "Max results (default 10)." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					results: {
						type: "array", required: true,
						items: {
							type: "object", additionalProperties: false,
							properties: {
								scope: { type: "string", required: true },
								topic: { type: "string", required: true },
								excerpt: { type: "string", required: true },
							},
						},
					},
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: value.results.length > 0
					? value.results.map((r) => `[${r.scope}] ${r.topic}: ${r.excerpt}`).join("\n")
					: "No matching memory found.",
			}],
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd;
			const scope = args.scope ?? "both";
			const results = [];
			const limit = args.limit ?? 10;
			const stores = [];
			if (scope === "global" || scope === "both") stores.push(["global", globalStore]);
			if ((scope === "project" || scope === "both") && cwd) stores.push(["project", projectStoreFor(cwd)]);
			for (const [s, store] of stores) {
				const topics = await store.listTopics();
				for (const t of topics) {
					const content = await store.read(`${t}.md`);
					if (!content) continue;
					if (keywordScore(args.query, `${t}\n${content}`) > 0) {
						const idx = content.toLowerCase().indexOf(args.query.toLowerCase());
						const start = idx > 0 ? Math.max(0, idx - 40) : 0;
						results.push({ scope: s, topic: t, excerpt: content.slice(start, start + 160).replace(/\n+/g, " ") });
					}
					if (results.length >= limit) break;
				}
			}
			return Promise.resolve({ results: results.slice(0, limit) });
		},
		presentCall: (args) => ({
			card: "generic", title: "Search memory", kind: "other",
			rawInput: { query: args.query, scope: args.scope },
		}),
	}));

	ctx.tools.register(defineTool({
		name: "memory_daily",
		description: "Append a one-line dated note to the working directory's daily memory (<cwd>/.dsh/memory/YYYY-MM-DD.md). For today's concrete facts and conclusions.",
		parameters: {
			line: { type: "string", required: true, description: "One fact/conclusion line (without leading '- ')." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { path: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: `Appended to daily memory: ${value.path}` }],
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd;
			if (!cwd) throw new Error("memory_daily requires a session working directory");
			const daily = dailyStoreFor(cwd);
			const date = new Date().toISOString().slice(0, 10);
			await daily.append(date, args.line);
			return Promise.resolve({ path: daily.dir });
		},
		presentCall: (args) => ({
			card: "generic", title: "Daily memory", kind: "other", rawInput: { line: args.line },
		}),
	}));

	ctx.tools.register(defineTool({
		name: "memory_forget",
		description: "Remove a memory topic file (and its pointer in MEMORY.md), or rewrite the user profile. Use when the user asks to forget something or corrects a memory.",
		parameters: {
			scope: { type: "string", required: true, enum: ["global", "project"] },
			topic: { type: "string", required: true, description: "Topic file name without extension to delete." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					removed: { type: "boolean", required: true },
					path: { type: "string", required: true },
				},
			},
			render: (_args, value) => [{ type: "text", text: value.removed ? `Removed ${value.path}` : "No such memory to remove." }],
		},
		async execute(args, exec) {
			const cwd = exec?.agent?.session?.header?.cwd;
			const store = args.scope === "project" && cwd ? projectStoreFor(cwd) : globalStore;
			const file = `${args.topic.replace(/\.md$/, "")}.md`;
			const full = store.resolvePath(file);
			let removed = false;
			try {
				await (await import("node:fs/promises")).unlink(full);
				removed = true;
			} catch {
				removed = false;
			}
			if (removed) await removeIndexLine(store, args.topic.replace(/\.md$/, ""));
			return Promise.resolve({ removed, path: full });
		},
		presentCall: (args) => ({
			card: "generic", title: "Forget memory", kind: "other",
			rawInput: { scope: args.scope, topic: args.topic },
		}),
	}));

	ctx.tools.register(defineTool({
		name: "memory_profile",
		description: "Read or update the single-user profile (L1, ~/.dsh/memory/profile.md). The profile holds four fixed sections: 工作背景 / 个人背景 / 当前关注 / 近期动态. Use to recall or refine durable user facts.",
		parameters: {
			action: { type: "string", required: true, enum: ["read", "update"], description: "Read the profile, or merge new facts and rotate the version." },
			section: { type: "string", enum: ["工作背景", "个人背景", "当前关注", "近期动态"], description: "Target section for 'update'." },
			lines: { type: "array", items: { type: "string" }, description: "Bullet lines to merge into the section (for 'update')." },
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					version: { type: "integer", required: true },
					sections: {
						type: "array", required: true,
						items: {
							type: "object", additionalProperties: false,
							properties: {
								section: { type: "string", required: true },
								lines: { type: "array", required: true, items: { type: "string" } },
							},
						},
					},
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: `Profile v${value.version}:\n` + value.sections
					.map((s) => `**${s.section}**\n${s.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n"),
			}],
		},
		async execute(args) {
			const profile = new ProfileMemory(globalStore);
			if (args.action === "read") {
				const cur = await profile.read();
				if (!cur) return Promise.resolve({ version: 0, sections: [] });
				return Promise.resolve({
					version: cur.version,
					sections: ProfileMemory.SECTIONS.map((s) => ({ section: s, lines: cur.sections[s] ?? [] })),
				});
			}
			const cur = (await profile.read()) ?? { version: 0, sections: Object.fromEntries(ProfileMemory.SECTIONS.map((s) => [s, []])) };
			const sec = args.section ?? "近期动态";
			const merged = new Set(cur.sections[sec] ?? []);
			for (const l of args.lines ?? []) merged.add(l);
			cur.sections[sec] = [...merged];
			await profile.write(cur.version + 1, cur.sections);
			return Promise.resolve({
				version: cur.version + 1,
				sections: ProfileMemory.SECTIONS.map((s) => ({ section: s, lines: cur.sections[s] ?? [] })),
			});
		},
		presentCall: (args) => ({
			card: "generic", title: "User profile", kind: "other", rawInput: { action: args.action },
		}),
	}));
}

/**
 * Select relevant memories for a query: LLM ranking when configured, otherwise
 * deterministic keyword scoring. Returns at most `maxRelevant` fresh hits.
 *
 * @returns {Promise<{ key: string, path: string, content: string, ageLabel: string }[]>}
 */
async function selectRelevant(ctx, config, globalStore, projectStore, query, signal) {
	const candidates = [];
	for (const [scope, store] of [["global", globalStore], ["project", projectStore]]) {
		const topics = await store.listTopics();
		for (const t of topics) {
			const info = await store.readInfo(`${t}.md`);
			if (!info) continue;
			const body = info.content.length > config.relevanceBudgetChars
				? info.content.slice(0, config.relevanceBudgetChars)
				: info.content;
			candidates.push({
				key: `${scope}:${t}`,
				path: `${scope}:${t}.md`,
				search: `${t}\n${body}`,
				content: body,
				mtimeMs: info.mtimeMs,
			});
		}
	}
	if (candidates.length === 0) return [];

	let ranked = candidates;
	if (config.llm.provider && config.llm.model) {
		const picked = await llmSelect(ctx, config, query, candidates.map((c) => c.path));
		if (picked) {
			const byPath = new Map(candidates.map((c) => [c.path, c]));
			ranked = picked.map((p) => byPath.get(p)).filter(Boolean);
		}
	}
	if (ranked === candidates) {
		ranked = [...candidates].sort((a, b) => keywordScore(query, b.search) - keywordScore(query, a.search));
	}
	return ranked
		.slice(0, config.maxRelevant)
		.map((c) => ({ key: c.key, path: c.path, content: c.content, ageLabel: ageLabel(c.mtimeMs) }));
}

/** Ask the LLM to pick the most relevant memory paths for a query. */
async function llmSelect(ctx, config, query, paths) {
	const prompt = `Given the user request below, pick the most relevant memory files (at most ${config.relevanceTopK}).\n\nUser request:\n${query}\n\nCandidate files:\n${paths.map((p) => `- ${p}`).join("\n")}\n\nReply ONLY with a JSON array of selected file paths, e.g. ["global:debugging.md"]. If none are relevant, reply with [].`;
	const text = await callLlm(ctx, {
		system: "You are a memory relevance selector. Reply only with valid JSON.",
		prompt,
		call: config.llm,
	});
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
		if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === "string");
	} catch {
		// fall through to keyword scoring
	}
	return undefined;
}

/**
 * Schedule a debounced auto-extraction for a session that just went idle.
 * Best-effort and non-blocking; never throws into the status listener.
 */
function scheduleExtraction(ctx, config, agent, cwd, globalStore, projectStore, state) {
	const sessionId = agent.session.id;
	const seq = agent.session.events.length;
	const st = state.get(sessionId) ?? { timer: undefined, lastSeq: 0, inFlight: false };
	if (st.inFlight) return;
	if (seq <= st.lastSeq) return;
	if (st.timer) clearTimeout(st.timer);
	st.timer = setTimeout(() => {
		state.delete(sessionId);
		void runExtraction(ctx, config, agent, cwd, globalStore, projectStore, state, seq).catch(() => {});
	}, config.extractionDebounceMs);
	state.set(sessionId, st);
}

/** Run one extraction pass: read recent events, ask the LLM, apply writes. */
async function runExtraction(ctx, config, agent, cwd, globalStore, projectStore, state, seq) {
	const sessionId = agent.session.id;
	const st = state.get(sessionId);
	if (st) st.inFlight = true;
	try {
		const events = agent.session.events.slice(-config.extractionLookback);
		const transcript = events
			.map((e) => {
				if (e.type === "user/message" && e.data.source?.kind !== "plugin") return `USER: ${blockText(e.data.content)}`;
				if (e.type === "assistant/message") return `ASSISTANT: ${blockText(e.data.content)}`;
				if (e.type === "tool/result") return `TOOL(${e.data.name ?? "?"}): ${blockText(e.data.content)}`;
				return undefined;
			})
			.filter(Boolean)
			.join("\n");
		if (transcript.trim().length === 0) return;

		const globalIndex = (await globalStore.read("MEMORY.md")) ?? "(empty)";
		const projIndex = (await projectStore.read("MEMORY.md")) ?? "(empty)";
		const prompt = `Extract durable memories from this finished agent turn.\n\nRecent conversation:\n${transcript}\n\nGlobal MEMORY.md index:\n${globalIndex}\n\nProject MEMORY.md index (${cwd}):\n${projIndex}\n\nReturn ONLY JSON: {"needed":boolean,"topics":[{"scope":"global"|"project","name":"topic-file-without-ext","content":"full markdown"}],"indexLines":[{"scope":"global"|"project","line":"- [Title](name.md) — one-line hook"}]}. If nothing durable is worth saving, set needed:false. Do NOT overwrite existing topic files; only create new ones.`;
		const text = await callLlm(ctx, {
			system: "You extract durable, cross-session memories from agent transcripts. Reply only with valid JSON.",
			prompt,
			call: config.llm,
		});
		if (!text) return;
		let parsed;
		try {
			parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
		} catch {
			return;
		}
		if (!parsed || parsed.needed === false) return;
		for (const t of parsed.topics ?? []) {
			const store = t.scope === "project" ? projectStore : globalStore;
			await store.ensure();
			const file = `${String(t.name).replace(/\.md$/, "")}.md`;
			if (await store.exists(file)) continue; // never clobber existing memories
			await store.write(file, String(t.content ?? ""));
		}
		for (const il of parsed.indexLines ?? []) {
			const store = il.scope === "project" ? projectStore : globalStore;
			await appendIndexLine(store, String(il.line ?? "").trim());
		}
	} finally {
		const final = state.get(sessionId);
		if (final) {
			final.inFlight = false;
			final.lastSeq = seq;
		}
	}
}

/** Concatenate text blocks of a content array. */
function blockText(content) {
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
}

/** Append a one-line pointer to MEMORY.md, creating it if needed. */
async function appendIndexLine(store, line) {
	const fitted = fitIndexLines(line).split("\n")[0];
	const existing = (await store.read("MEMORY.md")) ?? "# Memory Index\n\n";
	if (existing.split("\n").some((l) => l.trim() === fitted.trim())) return false;
	await store.write("MEMORY.md", `${existing.replace(/\s*$/, "")}\n${fitted}\n`);
	return true;
}

/** Remove a topic's pointer lines from MEMORY.md. */
async function removeIndexLine(store, topic) {
	const existing = await store.read("MEMORY.md");
	if (!existing) return;
	const kept = existing.split("\n").filter((l) => !l.includes(`(${topic}.md`) && !l.includes(`${topic}.md`));
	await store.write("MEMORY.md", kept.join("\n"));
}

export { Config, apply, inject, name };
