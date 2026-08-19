// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildEntryInstruction,
	buildRelevanceReminder,
	keywordScore,
	fitIndexLines,
} from "../src/inject.js";
import { ENTRY_INDEX_MAX_LINE_CHARS } from "../src/store.js";

test("buildEntryInstruction renders the empty-index placeholders", () => {
	const md = buildEntryInstruction({ globalIndex: "", projectIndex: "", hasProfile: false });
	assert.match(md, /# auto memory/);
	assert.match(md, /empty — no global memory index yet/);
	assert.match(md, /empty — no project memory index yet/);
	assert.doesNotMatch(md, /A merged user-profile/);
});

test("buildEntryInstruction omits the project block when projectIndex is undefined", () => {
	const md = buildEntryInstruction({ globalIndex: "- [a](a.md)", hasProfile: true });
	assert.doesNotMatch(md, /Project index/);
	assert.match(md, /A merged user-profile \(L1\)/);
});

test("buildRelevanceReminder frames hits and escapes the body", () => {
	const md = buildRelevanceReminder(
		[{ path: "example-topic.md", content: "buffer <design>", ageLabel: "1d" }],
		(s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
	);
	assert.match(md, /<system-reminder data-role="memory">/);
	assert.match(md, /example-topic\.md \(age: 1d\)/);
	assert.match(md, /buffer &lt;design&gt;/);
});

test("keywordScore counts case-insensitive term overlaps", () => {
	assert.equal(keywordScore("Grid Strategy", "grid trading strategy grid"), 3);
});

test("keywordScore ignores terms shorter than three characters", () => {
	assert.equal(keywordScore("ab cd ef", "abcdef"), 0);
});

test("keywordScore returns zero for an empty query", () => {
	assert.equal(keywordScore("", "anything"), 0);
});

test("fitIndexLines trims lines over the one-line budget", () => {
	const long = "x".repeat(ENTRY_INDEX_MAX_LINE_CHARS + 40);
	const out = fitIndexLines(`ok\n${long}`);
	const [first, second] = out.split("\n");
	assert.equal(first, "ok");
	assert.ok(second.length <= ENTRY_INDEX_MAX_LINE_CHARS);
	assert.ok(second.endsWith("…"));
});
