// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDshHome, globalMemoryDir, projectMemoryDir } from "../src/paths.js";

/**
 * Run a function with patched environment variables, restoring every touched
 * key afterwards so parallel test files never leak state into each other.
 * @param {Record<string, string | undefined>} patch
 * @param {() => unknown} fn
 */
function withEnv(patch, fn) {
	const saved = new Map();
	for (const [k, v] of Object.entries(patch)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("resolveDshHome honors a non-empty DSH_HOME override", () => {
	withEnv({ DSH_HOME: "/tmp/custom-dsh " }, () => {
		assert.equal(resolveDshHome(), resolve("/tmp/custom-dsh"));
	});
});

test("resolveDshHome falls back to ~/.dsh when DSH_HOME is unset or blank", () => {
	withEnv({ DSH_HOME: undefined }, () => {
		assert.equal(resolveDshHome(), join(homedir(), ".dsh"));
	});
	withEnv({ DSH_HOME: "   " }, () => {
		assert.equal(resolveDshHome(), join(homedir(), ".dsh"));
	});
});

test("globalMemoryDir joins the harness home with memory", () => {
	assert.equal(globalMemoryDir("/dsh"), join("/dsh", "memory"));
});

test("projectMemoryDir keys project memory by the working directory", () => {
	assert.equal(projectMemoryDir("/work/proj"), join("/work/proj", ".dsh", "memory"));
});
