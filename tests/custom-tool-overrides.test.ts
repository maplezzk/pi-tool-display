import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface NormalizedCustomToolOverride {
	enabled: boolean;
	kind: "generic" | "mcp";
	outputMode: "hidden" | "summary" | "preview";
}

interface ToolDisplayConfigWithCustomOverrides extends ToolDisplayConfig {
	customToolOverrides: Record<string, NormalizedCustomToolOverride>;
}

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RuntimeTool extends Record<string, unknown> {
	name: string;
	description?: string;
	parameters?: unknown;
	renderCall?: (...args: unknown[]) => RenderComponentLike;
	renderResult?: (...args: unknown[]) => RenderComponentLike;
	execute?: (...args: unknown[]) => unknown;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfigWithCustomOverrides(
	customToolOverrides: Record<string, unknown>,
	overrides: Partial<ToolDisplayConfig> = {},
): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
		customToolOverrides,
	} as ToolDisplayConfig;
}

function createExtensionApiStub(allTools: RuntimeTool[] = []): {
	api: ExtensionAPI;
	registeredTools: RuntimeTool[];
	runtimeTools: RuntimeTool[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RuntimeTool[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RuntimeTool): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): RuntimeTool[] {
			const names = new Set(allTools.map((tool) => tool.name));
			const defaultBuiltIns: RuntimeTool[] = ["read", "edit"]
				.filter((name) => !names.has(name))
				.map((name) => ({
					name,
					description: `Built-in ${name} tool`,
					sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
				}));
			return [...defaultBuiltIns, ...allTools];
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, runtimeTools: allTools, eventHandlers };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function renderToText(component: unknown): string {
	const render = component && typeof component === "object"
		? (component as { render?: unknown }).render
		: undefined;
	assert.equal(typeof render, "function", "expected a renderable component");
	return (component as RenderComponentLike)
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(tool: RuntimeTool, text: string, options: Record<string, unknown> = {}): string {
	return renderToolRawResult(
		tool,
		{ content: [{ type: "text", text }], details: {} },
		options,
	);
}

function renderToolRawResult(
	tool: RuntimeTool,
	result: Record<string, unknown>,
	options: Record<string, unknown> = {},
): string {
	assert.equal(typeof tool.renderResult, "function", `expected ${tool.name} to have renderResult`);
	return renderToText(
		tool.renderResult(
			result,
			{ expanded: false, isPartial: false, ...options },
			createTheme(),
		),
	);
}

test("bash summary renders prompt and summary from details", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		bashOutputMode: "summary",
	}));

	const bash = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bash);

	const callRendered = renderToText(bash.renderCall?.(
		{ command: "printf deploy", outputPrompt: "提取错误和最终状态" },
		createTheme(),
		{ executionStarted: false, isPartial: false },
	));
	assert.match(callRendered, /📝 总结要求： 提取错误和最终状态/);
	assert.doesNotMatch(callRendered, /总结要求：\n/);

	const resultRendered = renderToolRawResult(bash, {
		content: [{ type: "text", text: "表格共包含 3 个 Sheet。" }],
		details: {
			summaryText: "表格共包含 3 个 Sheet。\n\n- **肇庆仓包含调拨**\n- `sheet_id` 可见",
			toolExecutionMs: 32,
			summaryDurationMs: 7,
			originalOutputChars: 1000,
			summaryChars: 100,
			compressionRatio: 10,
			compressionSavedPercent: 90,
			summaryTriggerMinChars: 200,
			summaryTriggerMaxChars: null,
			summaryResultMaxChars: 1000,
			outputSummaryStatus: "summarized",
		},
	});
	assert.match(resultRendered, /✦ 输出摘要/);
	assert.match(resultRendered, /✦ 输出审计 · 已压缩 · 字符 1000→100 · 10\.00x · 省 90\.0% · 阈值≥200 · 工具 0\.0s · 压缩 0\.0s/);
	assert.match(resultRendered, /表格共包含 3 个 Sheet。/);
	assert.match(resultRendered, /• 肇庆仓包含调拨/);
	assert.match(resultRendered, /sheet_id/);
	assert.doesNotMatch(resultRendered, /\*\*/);
	assert.doesNotMatch(resultRendered, /提取错误和最终状态/);
});

test("bash raw diagnostics render original character count and decision", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		bashOutputMode: "summary",
	}));

	const bash = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bash);
	const rendered = renderToolRawResult(bash, {
		content: [{ type: "text", text: "原始输出" }],
		details: {
			toolExecutionMs: 12,
			originalOutputChars: 2000,
			summaryTriggerMinChars: 200,
			summaryTriggerMaxChars: null,
			summaryResultMaxChars: 100000,
			missedCompressionRatio: 2,
			outputSummaryStatus: "full-output",
			outputSummaryAdvice: "本次输出显式使用 RAW，按要求保留原文。",
		},
	});

	assert.match(rendered, /✦ 输出审计 · 原文·RAW · 字符 2000 · 阈值≥200 · 长输出≥2\.0x · 工具 0\.0s/);
	assert.match(rendered, /⚠ 输出处理提醒：本次输出显式使用 RAW/);
	assert.match(rendered, /✦ 输出审计/);
});

test("summary failure renders the raw error only in TUI diagnostics", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		bashOutputMode: "summary",
	}));

	const bash = registeredTools.find((tool) => tool.name === "bash");
	assert.ok(bash);
	const rendered = renderToolRawResult(bash, {
		content: [{ type: "text", text: "原始输出" }],
		details: {
			outputSummaryStatus: "summary-failed",
			outputSummaryAnomalies: ["summary-failed"],
			outputSummaryAdvice: "总结失败，已保留原文；请检查总结模型配置或鉴权。",
			outputSummaryError: "401 Unauthorized: invalid API key",
		},
	});

	assert.match(rendered, /⛔ 输出处理异常：总结失败，已保留原文/);
	assert.match(rendered, /↳ 原始错误：401 Unauthorized: invalid API key/);
});

test("edit and write results render file review status and per-reviewer summaries", () => {
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => ({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
	}));

	const edit = registeredTools.find((tool) => tool.name === "edit");
	assert.ok(edit);
	const rendered = renderToolRawResult(edit, {
		content: [{ type: "text", text: "Successfully replaced text." }],
		details: {
			diff: "--- a/src/app.ts\\n+++ b/src/app.ts\\n@@\\n-const lang = 'en';\\n+const lang = 'zh';",
			fileEditReview: {
				status: "rejected",
				filePath: "src/app.ts",
				toolName: "edit",
				durationMs: 1250,
				reviewers: [
					{ name: "coding-taste", rulesFile: "rules.md", status: "rejected", durationMs: 800, summary: "语言不符合规则" },
					{ name: "security", rulesFile: "security.md", status: "passed", durationMs: 450, summary: "通过" },
				],
				warnings: [],
			},
		},
	});

	assert.match(rendered, /✦ 编辑审查 · 未通过 · 2 个审查 prompt · 工具 1\.3s/);
	assert.match(rendered, /coding-taste · ✗ 不通过 0\.8s · 语言不符合规则/);
	assert.match(rendered, /security · ✓ 通过 0\.5s · 通过/);
});

test("normalizeToolDisplayConfig defaults customToolOverrides to an empty opt-in map", () => {
	const config = normalizeToolDisplayConfig({}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {});
});

test("normalizeToolDisplayConfig normalizes custom tool override shorthand, defaults, and invalid entries", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			ide_find_symbol: true,
			" agent_gateway ": { outputMode: "preview" },
			mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
			disabled_tool: false,
			invalid_kind: { enabled: true, kind: "terminal", outputMode: "verbose" },
			read: { enabled: true, kind: "mcp", outputMode: "summary" },
			"": { enabled: true },
			"   ": true,
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		ide_find_symbol: { enabled: true, kind: "generic", outputMode: "summary" },
		agent_gateway: { enabled: true, kind: "generic", outputMode: "preview" },
		mcp_gateway: { enabled: true, kind: "mcp", outputMode: "hidden" },
		disabled_tool: { enabled: false, kind: "generic", outputMode: "summary" },
		invalid_kind: { enabled: true, kind: "generic", outputMode: "summary" },
	});
});

test("enabled generic custom tool override replaces existing extension renderers and leaves other tools alone", async () => {
	const enabledTool: RuntimeTool = {
		name: "ide_find_symbol",
		description: "Find symbols through an IDE index.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW ENABLED CALL"] }),
		renderResult: () => ({ render: () => ["RAW ENABLED RESULT"] }),
	};
	const disabledTool: RuntimeTool = {
		name: "disabled_noisy_tool",
		description: "Noisy extension tool that should keep its own renderer while disabled.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW DISABLED CALL"] }),
		renderResult: () => ({ render: () => ["RAW DISABLED RESULT"] }),
	};
	const unlistedTool: RuntimeTool = {
		name: "unlisted_noisy_tool",
		description: "Noisy extension tool that was not explicitly opted in.",
		parameters: {},
		execute: () => {},
		renderCall: () => ({ render: () => ["RAW UNLISTED CALL"] }),
		renderResult: () => ({ render: () => ["RAW UNLISTED RESULT"] }),
	};
	const config = buildConfigWithCustomOverrides({
		ide_find_symbol: { enabled: true, outputMode: "summary" },
		disabled_noisy_tool: { enabled: false, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([enabledTool, disabledTool, unlistedTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(renderToText(enabledTool.renderCall?.({ query: "Widget", limit: 5 }, createTheme())), "ide_find_symbol (2 args)");
	assert.equal(renderToolResult(enabledTool, "alpha\nbeta\ngamma\n"), "↳ 3 lines returned • Ctrl+O to expand");
	assert.equal(renderToText(disabledTool.renderCall?.({}, createTheme())), "RAW DISABLED CALL");
	assert.equal(renderToolResult(disabledTool, "ignored"), "RAW DISABLED RESULT");
	assert.equal(renderToText(unlistedTool.renderCall?.({}, createTheme())), "RAW UNLISTED CALL");
	assert.equal(renderToolResult(unlistedTool, "ignored"), "RAW UNLISTED RESULT");
});

test("custom tool override defaults kind to generic unless the user chooses mcp", async () => {
	const genericTool: RuntimeTool = {
		name: "remote_gateway",
		description: "Calls a remote integration with plain generic rendering.",
		parameters: {},
		execute: () => {},
	};
	const mcpTool: RuntimeTool = {
		name: "remote_gateway_structured",
		description: "Calls a remote integration with user-selected structured rendering.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		remote_gateway: { enabled: true },
		remote_gateway_structured: { enabled: true, kind: "mcp" },
	});
	const { api, eventHandlers } = createExtensionApiStub([genericTool, mcpTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(renderToText(genericTool.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "remote_gateway (2 args)");
	assert.equal(renderToText(mcpTool.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom generic tool override honors per-tool hidden output mode", async () => {
	const quietTool: RuntimeTool = {
		name: "large_payload_tool",
		description: "Produces huge payloads that the user wants hidden.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		large_payload_tool: { enabled: true, outputMode: "hidden" },
	});
	const { api, eventHandlers } = createExtensionApiStub([quietTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(renderToolResult(quietTool, "secret\nnoisy\noutput\n"), "");
});

test("custom tool overrides ignore missing tools instead of registering phantom tools", async () => {
	const config = buildConfigWithCustomOverrides({
		missing_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(runtimeTools.some((tool) => tool.name === "missing_tool"), false);
	assert.equal(registeredTools.some((tool) => tool.name === "missing_tool"), false);
});

test("normalizeToolDisplayConfig treats malformed customToolOverrides containers as empty", () => {
	for (const rawCustomOverrides of [null, true, "ide_find_symbol", [], 42]) {
		const config = normalizeToolDisplayConfig({
			customToolOverrides: rawCustomOverrides,
		}) as ToolDisplayConfigWithCustomOverrides;

		assert.deepEqual(config.customToolOverrides, {});
	}
});

test("normalizeToolDisplayConfig preserves supported custom output modes and drops unknown entry fields", () => {
	const config = normalizeToolDisplayConfig({
		customToolOverrides: {
			hidden_tool: { enabled: true, outputMode: "hidden", label: "Ignored Label" },
			summary_tool: { enabled: true, outputMode: "summary", pathFields: ["file_path"] },
			preview_tool: { enabled: true, outputMode: "preview", renderShell: "self" },
		},
	}) as ToolDisplayConfigWithCustomOverrides;

	assert.deepEqual(config.customToolOverrides, {
		hidden_tool: { enabled: true, kind: "generic", outputMode: "hidden" },
		summary_tool: { enabled: true, kind: "generic", outputMode: "summary" },
		preview_tool: { enabled: true, kind: "generic", outputMode: "preview" },
	});
});

test("generic custom tool renderCall handles absent, non-object, and nested arguments safely", async () => {
	const argumentProbe: RuntimeTool = {
		name: "argument_probe",
		description: "Noisy extension tool with unpredictable arguments.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		argument_probe: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([argumentProbe]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(renderToText(argumentProbe.renderCall?.(undefined, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(argumentProbe.renderCall?.(null, createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(argumentProbe.renderCall?.("raw string args", createTheme())), "argument_probe (no args)");
	assert.equal(renderToText(argumentProbe.renderCall?.(["array", "args"], createTheme())), "argument_probe (no args)");
	assert.equal(
		renderToText(argumentProbe.renderCall?.({ path: "src/index.ts", options: { recursive: true }, tags: ["a", "b"] }, createTheme())),
		"argument_probe (3 args)",
	);
});

test("generic custom tool preview mode supports collapsed previews, expanded previews, partial state, and empty text", async () => {
	const previewTool: RuntimeTool = {
		name: "preview_payload_tool",
		description: "Produces output that should be previewed instead of summarized.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides(
		{ preview_payload_tool: { enabled: true, outputMode: "preview" } },
		{ previewLines: 2 },
	);
	const { api, eventHandlers } = createExtensionApiStub([previewTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(
		renderToolResult(previewTool, "alpha\nbeta\ngamma\ndelta\n"),
		"alpha\nbeta\n... (2 more lines • Ctrl+O to expand)",
	);
	assert.equal(
		renderToolResult(previewTool, "alpha\nbeta\ngamma\ndelta\n", { expanded: true }),
		"alpha\nbeta\ngamma\ndelta",
	);
	assert.equal(renderToolResult(previewTool, "still running", { isPartial: true }), "running...");
	assert.equal(
		renderToolRawResult(previewTool, { content: [{ type: "image", data: "ignored" }], details: {} }),
		"↳ (no output)",
	);
	assert.equal(renderToolRawResult(previewTool, { details: {} }), "↳ (no output)");
});

test("explicit mcp custom tool override interprets MCP proxy argument variants", async () => {
	const customMcpProxy: RuntimeTool = {
		name: "custom_gateway",
		description: "Custom gateway that should render as MCP because the user opted in.",
		parameters: {},
		execute: () => {},
	};
	const config = buildConfigWithCustomOverrides({
		custom_gateway: { enabled: true, kind: "mcp", outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([customMcpProxy]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(renderToText(customMcpProxy.renderCall?.({}, createTheme())), "MCP status (no args)");
	assert.equal(renderToText(customMcpProxy.renderCall?.({ connect: "filesystem" }, createTheme())), "MCP connect filesystem (1 arg)");
	assert.equal(renderToText(customMcpProxy.renderCall?.({ describe: "read_file", server: "filesystem" }, createTheme())), "MCP describe read_file @filesystem (2 args)");
	assert.equal(renderToText(customMcpProxy.renderCall?.({ search: "browser", server: "exa" }, createTheme())), "MCP search \"browser\" @exa (2 args)");
	assert.equal(renderToText(customMcpProxy.renderCall?.({ server: "filesystem" }, createTheme())), "MCP tools filesystem (1 arg)");
	assert.equal(renderToText(customMcpProxy.renderCall?.({ tool: "read_file", server: "filesystem" }, createTheme())), "MCP call filesystem:read_file (2 args)");
});

test("custom tool override preserves execution contract, parameters, and prepareArguments", async () => {
	const execute = (): string => "executed";
	const prepareArguments = (args: unknown): unknown => args;
	const parameters = { type: "object", properties: { query: { type: "string" } } };
	const contractTool: RuntimeTool = {
		name: "contract_tool",
		description: "Tool with runtime behavior that must survive decoration.",
		parameters,
		execute,
		prepareArguments,
	};
	const config = buildConfigWithCustomOverrides({
		contract_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([contractTool]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	assert.equal(contractTool.execute, execute);
	assert.equal(contractTool.prepareArguments, prepareArguments);
	assert.equal(contractTool.parameters, parameters);
	assert.equal(typeof contractTool.renderCall, "function");
	assert.equal(typeof contractTool.renderResult, "function");
});

test("custom tool registered after lifecycle is decorated when it is explicitly opted in", async () => {
	const config = buildConfigWithCustomOverrides({
		late_custom_tool: { enabled: true, outputMode: "summary" },
	});
	const { api, eventHandlers } = createExtensionApiStub([]);

	registerToolDisplayOverrides(api, () => config);
	await runLifecycle(eventHandlers);

	const lateTool: RuntimeTool = {
		name: "late_custom_tool",
		description: "Tool registered after lifecycle by another extension.",
		parameters: {},
		execute: () => {},
	};
	(api as unknown as { registerTool(tool: RuntimeTool): void }).registerTool(lateTool);

	assert.equal(typeof lateTool.renderCall, "function");
	assert.equal(typeof lateTool.renderResult, "function");
	assert.equal(renderToText(lateTool.renderCall?.({ query: "late" }, createTheme())), "late_custom_tool (1 arg)");
});
