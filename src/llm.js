// @ts-check
import z from "@deepseek-ai/schemastery";

/**
 * Minimal one-shot model call built directly on the harness `llm` service.
 *
 * Both auto-extraction and LLM-backed relevance selection need a single
 * prompt/completion without tools. We resolve the runtime via `ctx.get("llm")`
 * (falling back to `ctx.llm`) and stream the response, concatenating text
 * deltas. A failure resolves to `undefined` so every caller can gracefully
 * degrade to its keyword fallback.
 *
 * @param {any} ctx - plugin context carrying the `llm` service.
 * @param {object} args
 * @param {string} args.system - system prompt.
 * @param {string} args.prompt - user prompt.
 * @param {{ provider?: string, model?: string, maxTokens?: number }} [args.call]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<string | undefined>} the completion text, or `undefined` on failure.
 */
export async function callLlm(ctx, { system, prompt, call, signal }) {
	let llm;
	try {
		llm = ctx.get("llm");
	} catch {
		llm = ctx.llm;
	}
	if (!llm || typeof llm.stream !== "function") return undefined;
	const provider = call?.provider;
	const model = call?.model;
	if (!provider || !model) return undefined;
	try {
		const options = {
			provider,
			model,
			system,
			messages: [{ role: "user", content: prompt }],
			maxTokens: call?.maxTokens ?? 1024,
			signal,
		};
		const chunks = llm.stream(options);
		let text = "";
		for await (const chunk of chunks) {
			if (chunk && chunk.type === "text-delta") text += chunk.text;
		}
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Schemastery schema for the extraction/selection call config.
 * `provider`/`model` are optional so the plugin is usable with keyword-only
 * selection when no model route is configured.
 */
export const CallConfigSchema = z.object({
	provider: z.string().default(""),
	model: z.string().default(""),
	maxTokens: z.number().default(1024),
});
