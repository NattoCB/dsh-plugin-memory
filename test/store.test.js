// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeProjectStore,
	truncateIndex,
	ENTRY_INDEX_MAX_LINES,
	ENTRY_INDEX_MAX_CHARS,
	DailyMemory,
} from "../src/store.js";

/** Create a project store rooted at a fresh temp directory. */
async function tmpStore() {
	return makeProjectStore(await fs.mkdtemp(join(tmpdir(), "memory-store-")));
}

test("ensure is idempotent and write/read round-trips", async () => {
	const store = await tmpStore();
	await store.ensure();
	await store.ensure();
	assert.equal(await store.exists("topic.md"), false);
	await store.write("topic.md", "hello");
	assert.equal(await store.exists("topic.md"), true);
	assert.equal(await store.read("topic.md"), "hello");
});

test("read and readInfo return undefined for missing files", async () => {
	const store = await tmpStore();
	assert.equal(await store.read("missing.md"), undefined);
	assert.equal(await store.readInfo("missing.md"), undefined);
});

test("write creates parent directories", async () => {
	const store = await tmpStore();
	await store.write("sub/dir/file.md", "x");
	assert.equal(await store.read("sub/dir/file.md"), "x");
});

test("listTopics returns md topics and excludes MEMORY.md", async () => {
	const store = await tmpStore();
	await store.write("a.md", "a");
	await store.write("b.txt", "b");
	await store.write("MEMORY.md", "index");
	await store.write("c.md", "c");
	assert.deepEqual((await store.listTopics()).sort(), ["a", "c"]);
});

test("resolvePath refuses to escape the store root", () => {
	const store = makeProjectStore("/cwd");
	assert.throws(() => store.resolvePath("../outside.md"), /escapes store root/);
});

test("truncateIndex keeps a small index untouched", () => {
	const text = "# index\n- [a](a.md)\n";
	assert.equal(truncateIndex(text), text);
});

test("truncateIndex clamps the line budget and adds a notice", () => {
	const text = Array.from({ length: ENTRY_INDEX_MAX_LINES + 5 }, (_, i) => `- [x${i}](x${i}.md)`).join("\n");
	const out = truncateIndex(text);
	assert.equal(out.split("\n").length, ENTRY_INDEX_MAX_LINES + 1);
	assert.match(out, /index truncated: 5 more lines omitted/);
});

test("truncateIndex clamps the char budget and adds a notice", () => {
	const text = "x".repeat(ENTRY_INDEX_MAX_CHARS + 100);
	const out = truncateIndex(text);
	assert.ok(out.length <= ENTRY_INDEX_MAX_CHARS + 80);
	assert.match(out, /index truncated to char budget/);
});

test("DailyMemory.append writes a header once then appends bullets", async () => {
	const cwd = await fs.mkdtemp(join(tmpdir(), "daily-"));
	const daily = new DailyMemory(cwd);
	await daily.append("2026-08-19", "first fact");
	await daily.append("2026-08-19", "second fact");
	const text = await fs.readFile(join(cwd, ".dsh", "memory", "2026-08-19.md"), "utf8");
	assert.equal(text, "# 2026-08-19\n\n- first fact\n- second fact\n");
});

test("DailyMemory keeps days in separate files", async () => {
	const cwd = await fs.mkdtemp(join(tmpdir(), "daily-"));
	const daily = new DailyMemory(cwd);
	await daily.append("2026-08-19", "a");
	await daily.append("2026-08-20", "b");
	assert.equal(await fs.readFile(join(cwd, ".dsh", "memory", "2026-08-19.md"), "utf8"), "# 2026-08-19\n\n- a\n");
	assert.equal(await fs.readFile(join(cwd, ".dsh", "memory", "2026-08-20.md"), "utf8"), "# 2026-08-20\n\n- b\n");
});
