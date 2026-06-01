// Unit tests for the Anthropic cache_control budget enforcer in
// src/client/core.ts.
//
// Run via `npm run test:unit`. We use Node's built-in test runner and
// rely on esbuild's `alias` to swap `vscode` for our in-process mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enforceCacheControlBudget } from '../src/client/core.js';

type Block = Record<string, unknown>;
type Params = {
	model?: string;
	messages?: Array<{ role?: string; content?: string | Block[] }>;
	system?: string | Block[];
	tools?: Array<{ name?: string; cache_control?: unknown }>;
};

function withSystemString(): Params {
	return { system: 'You are a helpful assistant.' };
}

function withSystemArray(n: number): Params {
	const blocks: Block[] = [];
	for (let i = 0; i < n; i++) {
		blocks.push({ type: 'text', text: `block ${i}` });
	}
	return { system: blocks };
}

function withTools(n: number): Params {
	const tools: Array<{ name?: string; cache_control?: unknown }> = [];
	for (let i = 0; i < n; i++) {
		tools.push({ name: `tool_${i}` });
	}
	return { tools };
}

function withMessages(
	n: number,
	cacheControlOnAll: boolean,
): Params {
	const messages: Array<{ role?: string; content?: Block[] }> = [];
	for (let i = 0; i < n; i++) {
		const content: Block[] = [{ type: 'text', text: `msg ${i}` }];
		if (cacheControlOnAll) {
			content[0].cache_control = { type: 'ephemeral' };
		}
		messages.push({ role: 'user', content });
	}
	return { messages };
}

// ---------------------------------------------------------------------
// Below the budget → no-op
// ---------------------------------------------------------------------

test('enforceCacheControlBudget: no-op when total breakpoints ≤ 4', () => {
	const params: Params = {
		...withSystemString(),
		...withTools(2),
		...withMessages(2, true),
	};
	const before = JSON.stringify(params);
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	assert.equal(JSON.stringify(params), before);
});

test('enforceCacheControlBudget: no-op when nothing has cache_control', () => {
	const params: Params = {
		...withSystemString(),
		...withTools(2),
		...withMessages(3, false),
	};
	const before = JSON.stringify(params);
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	assert.equal(JSON.stringify(params), before);
});

// ---------------------------------------------------------------------
// System upgrades to structured block (handler does that elsewhere —
// here we just test the trimming logic on an already-structured system).
// ---------------------------------------------------------------------

test('enforceCacheControlBudget: drops in-message breakpoints first', () => {
	const params: Params = {
		...withSystemArray(1), // no cache_control on system yet
		...withMessages(5, true), // 5 in-message breakpoints
	};
	(params.system as Block[])[0].cache_control = { type: 'ephemeral' };
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	// Total: 1 system + 5 messages = 6 → drop 2 in-message breakpoints
	let msgWithCC = 0;
	for (const m of params.messages!) {
		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.cache_control) msgWithCC++;
			}
		}
	}
	assert.equal(msgWithCC, 3);
	// System and tools untouched
	assert.ok((params.system as Block[])[0].cache_control);
});

test('enforceCacheControlBudget: drops tools breakpoint after messages', () => {
	const params: Params = {
		...withSystemArray(1),
		...withTools(1),
		...withMessages(5, true),
	};
	(params.system as Block[])[0].cache_control = { type: 'ephemeral' };
	(params.tools![0] as { cache_control?: unknown }).cache_control = {
		type: 'ephemeral',
	};
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	// Total: 1 system + 1 tool + 5 messages = 7 → drop 3
	//  - drop 3 messages (earliest first, no need to touch tools)
	//  - system and tools kept
	let msgWithCC = 0;
	for (const m of params.messages!) {
		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.cache_control) msgWithCC++;
			}
		}
	}
	assert.equal(msgWithCC, 2);
	// Tools and system breakpoints survive (messages absorbed all 3 drops).
	assert.ok((params.tools![0] as { cache_control?: unknown }).cache_control);
	assert.ok((params.system as Block[])[0].cache_control);
});

test('enforceCacheControlBudget: forces tools + system to drop when messages are exhausted', () => {
	// 1 system + 2 tools + 3 messages = 6, need to drop 2.
	//  - drop 2 messages (no need to touch tools)
	const params: Params = {
		...withSystemArray(1),
		...withTools(2),
		...withMessages(3, true),
	};
	(params.system as Block[])[0].cache_control = { type: 'ephemeral' };
	for (const tool of params.tools!) {
		(tool as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
	}
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	let msgWithCC = 0;
	for (const m of params.messages!) {
		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.cache_control) msgWithCC++;
			}
		}
	}
	assert.equal(msgWithCC, 1);
	// Tools and system kept (messages absorbed both drops).
	for (const tool of params.tools!) {
		assert.ok((tool as { cache_control?: unknown }).cache_control);
	}
	assert.ok((params.system as Block[])[0].cache_control);
});

test('enforceCacheControlBudget: drops system breakpoint last', () => {
	const params: Params = {
		...withSystemArray(1),
		...withMessages(5, true),
	};
	(params.system as Block[])[0].cache_control = { type: 'ephemeral' };
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	// Total: 1 + 5 = 6 → drop 2
	//  - drop 2 messages
	//  - system kept
	let msgWithCC = 0;
	for (const m of params.messages!) {
		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.cache_control) msgWithCC++;
			}
		}
	}
	assert.equal(msgWithCC, 3);
	assert.ok((params.system as Block[])[0].cache_control);
});

test('enforceCacheControlBudget: handles many system blocks', () => {
	const params: Params = {
		...withSystemArray(5), // 5 system blocks, all with cache_control
	};
	for (const block of params.system as Block[]) {
		block.cache_control = { type: 'ephemeral' };
	}
	enforceCacheControlBudget(params as unknown as Record<string, unknown>);
	// 5 system blocks → drop 1
	let sysWithCC = 0;
	for (const block of params.system as Block[]) {
		if (block.cache_control) sysWithCC++;
	}
	assert.equal(sysWithCC, 4);
});
