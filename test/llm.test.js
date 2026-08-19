// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { callLlm, CallConfigSchema } from "../src/llm.js";

/**
 * A fake llm service streaming the given text-delta chunks.
 * @param {string[]} parts
 */
function fakeLlm(parts) {
	return {
		stream: async function* () {
			for (const t of parts) yield { type: "text-delta", text: t };
		},
	};
}

test("callLlm returns undefined when no llm service is available", async () => {
	const ctx = { get: () => { throw new Error("missing"); }, llm: undefined };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p", model: "m" } }), undefined);
});

test("callLlm returns undefined when provider or model is missing", async () => {
	const ctx = { get: () => fakeLlm(["hi"]) };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p" } }), undefined);
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { model: "m" } }), undefined);
});

test("callLlm concatenates text-delta chunks", async () => {
	const ctx = { get: () => fakeLlm(["hel", "lo"]) };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p", model: "m" } }), "hello");
});

test("callLlm prefers ctx.get and falls back to ctx.llm", async () => {
	const ctx = { get: () => { throw new Error("nope"); }, llm: fakeLlm(["fb"]) };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p", model: "m" } }), "fb");
});

test("callLlm degrades to undefined when the stream throws", async () => {
	const ctx = { get: () => ({ stream: () => { throw new Error("boom"); } }) };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p", model: "m" } }), undefined);
});

test("callLlm degrades to undefined when the stream yields no text", async () => {
	const ctx = { get: () => fakeLlm([]) };
	assert.equal(await callLlm(ctx, { system: "s", prompt: "p", call: { provider: "p", model: "m" } }), undefined);
});

test("CallConfigSchema defaults to empty provider and model", () => {
	const parsed = CallConfigSchema({});
	assert.equal(parsed.provider, "");
	assert.equal(parsed.model, "");
	assert.equal(parsed.maxTokens, 1024);
});
