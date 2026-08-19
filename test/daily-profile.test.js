// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGlobalStore, ProfileMemory } from "../src/store.js";

/** Create a global store rooted at a fresh temp directory. */
async function tmpGlobalStore() {
	return makeGlobalStore(await fs.mkdtemp(join(tmpdir(), "profile-")));
}

test("render emits the four fixed sections in order", () => {
	const profile = new ProfileMemory(makeGlobalStore("/x"));
	const md = profile.render(2, { 工作背景: ["示例行业"], 当前关注: ["示例关注"] });
	const order = ProfileMemory.SECTIONS.map((n) => md.indexOf(n));
	assert.ok(order.every((i) => i >= 0));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.match(md, /> Version: 2/);
	assert.match(md, /- 示例行业/);
	assert.match(md, /\(empty\)/);
});

test("write rotates the previous profile to .bak", async () => {
	const store = await tmpGlobalStore();
	const profile = new ProfileMemory(store);
	await profile.write(1, { 工作背景: ["v1"] });
	await profile.write(2, { 工作背景: ["v2"] });
	const current = await store.read("profile.md");
	const bak = await store.read("profile.md.bak");
	assert.match(current, /- v2/);
	assert.match(bak, /- v1/);
});

test("read parses version and section bullets back", async () => {
	const store = await tmpGlobalStore();
	const profile = new ProfileMemory(store);
	await profile.write(3, { 工作背景: ["a"], 近期动态: ["b"] });
	const parsed = await profile.read();
	assert.equal(parsed.version, 3);
	assert.deepEqual(parsed.sections["工作背景"], ["a"]);
	assert.deepEqual(parsed.sections["近期动态"], ["b"]);
	assert.deepEqual(parsed.sections["个人背景"], []);
});

test("read returns undefined when no profile exists", async () => {
	const store = await tmpGlobalStore();
	const profile = new ProfileMemory(store);
	assert.equal(await profile.read(), undefined);
});
