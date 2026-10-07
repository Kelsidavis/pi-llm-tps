/** Live model throughput in pi's status bar, from Strata metrics or llama.cpp journal lines. */

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const UNIT = process.env.LLM_TPS_UNIT || "llama-server.service";
const SCOPE = process.env.LLM_TPS_SCOPE === "system" ? "--system" : "--user";
const LINE = /n_gen = +(\d+), tg = +([\d.]+) t\/s, tg_3s = +([\d.]+) t\/s/;
const IDLE_MS = 8000;
const POLL_MS = 1000;
const RECENT_REQUESTS = 12;

type StrataMetrics = {
	engine?: { model?: string };
	live?: {
		state?: string;
		generated?: number | null;
		elapsed_s?: number | null;
		tok_s?: number | null;
	};
	requests?: { output_tokens?: number | null; duration_s?: number | null }[];
};

/** Output per second spent inside recent server requests, including prompt reading and decode stalls. */
function wallRate(metrics: StrataMetrics): number | null {
	const live = metrics.live;
	const active = live?.state === "reading" || live?.state === "generating";
	let tokens = 0;
	let seconds = 0;
	for (const request of (metrics.requests ?? []).slice(0, active ? RECENT_REQUESTS - 1 : RECENT_REQUESTS)) {
		const n = request.output_tokens;
		const s = request.duration_s;
		if (typeof n === "number" && Number.isFinite(n) && n >= 0 &&
			typeof s === "number" && Number.isFinite(s) && s > 0) {
			tokens += n;
			seconds += s;
		}
	}
	if (active) {
		const elapsed = live?.elapsed_s;
		if (typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed > 0) {
			seconds += elapsed;
			const generated = live?.generated;
			if (typeof generated === "number" && Number.isFinite(generated) && generated > 0)
				tokens += generated;
		}
	}
	return seconds > 0 ? tokens / seconds : null;
}

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | null = null;
	let idle: NodeJS.Timeout | null = null;
	let pollTimer: NodeJS.Timeout | null = null;
	let pollAbort: AbortController | null = null;
	let generation = 0;
	let mode: "strata" | "journal" | null = null;
	let lastRate = "";
	let samples = 0;

	const stop = () => {
		generation++;
		mode = null;
		if (idle) { clearTimeout(idle); idle = null; }
		if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
		if (pollAbort) { pollAbort.abort(); pollAbort = null; }
		if (child) { child.kill(); child = null; }
	};

	const pollStrata = async (ctx: ExtensionContext, url: string, modelId: string | null, run: number) => {
		if (mode !== "strata" || run !== generation) return;
		const controller = new AbortController();
		pollAbort = controller;
		const timeout = setTimeout(() => controller.abort(), 1500);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const metrics = await response.json() as StrataMetrics;
			if (mode !== "strata" || run !== generation) return;
			if (modelId && metrics.engine?.model !== modelId) throw new Error("wrong model on port");
			samples++;
			const live = metrics.live;
			const rate = wallRate(metrics);
			lastRate = rate === null ? "" : `avg ${rate.toFixed(1)} t/s wall`;
			if (live?.state === "generating") {
				const decode = typeof live.tok_s === "number" && Number.isFinite(live.tok_s)
					? ` (now ${live.tok_s.toFixed(1)} decode)` : "";
				ctx.ui.setStatus("tps", `⚡ ${lastRate || "-- wall"}${decode} [server]`);
			} else if (live?.state === "reading") {
				ctx.ui.setStatus("tps", `⚡ ${lastRate || "-- wall"} (reading...) [server]`);
			} else {
				ctx.ui.setStatus("tps", lastRate ? `⚡ ${lastRate} (idle) [server]` : "⚡ --");
			}
		} catch (error) {
			if (mode === "strata" && run === generation && !controller.signal.aborted) {
				ctx.ui.setStatus("tps", `⚡ Strata unavailable (${error instanceof Error ? error.message : "error"})`);
			}
		} finally {
			clearTimeout(timeout);
			if (pollAbort === controller) pollAbort = null;
			if (mode === "strata" && run === generation)
				pollTimer = setTimeout(() => void pollStrata(ctx, url, modelId, run), POLL_MS);
		}
	};

	const startJournal = (ctx: ExtensionContext) => {
		mode = "journal";
		ctx.ui.setStatus("tps", "⚡ --");
		try {
			child = spawn("stdbuf", ["-oL", "journalctl", SCOPE, "-u", UNIT, "-f", "-n", "0", "-o", "cat"],
				{ stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			ctx.ui.setStatus("tps", "⚡ journal spawn failed");
			return;
		}
		child.on("error", () => {
			child = null;
			if (mode === "journal") ctx.ui.setStatus("tps", "⚡ journal error");
		});
		child.on("exit", () => {
			child = null;
			if (mode === "journal") ctx.ui.setStatus("tps", "⚡ journal stopped");
		});
		if (!child.stdout) return;
		readline.createInterface({ input: child.stdout }).on("line", (line: string) => {
			if (mode !== "journal") return;
			const match = LINE.exec(line);
			if (!match) return;
			samples++;
			const [, gen, avg, now] = match;
			lastRate = `${now} t/s`;
			ctx.ui.setStatus("tps", `⚡ ${now} t/s (avg ${avg}, ${gen} tok)`);
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => ctx.ui.setStatus("tps", `⚡ ${now} idle`), IDLE_MS);
		});
	};

	const start = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		stop();
		lastRate = "";
		samples = 0;
		const localStrata = ctx.model?.provider === "local" &&
			new URL(ctx.model.baseUrl).port === "8080";
		if (ctx.model?.provider === "strata" || localStrata) {
			mode = "strata";
			ctx.ui.setStatus("tps", "⚡ connecting...");
			const url = new URL("/metrics", ctx.model.baseUrl).toString();
			void pollStrata(ctx, url, localStrata ? null : ctx.model.id, generation);
		} else if (ctx.model?.provider === "local") {
			startJournal(ctx);
		} else {
			ctx.ui.setStatus("tps", undefined);
		}
	};

	pi.registerCommand("tps", {
		description: "Show the server's recent request-wall throughput (prompt reading included)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`llm-tps: source=${mode ?? "none"} samples=${samples} last=${lastRate || "none yet"}; ` +
				`wall average covers up to ${RECENT_REQUESTS} server requests (including the active one), not tool time`,
				mode ? "info" : "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("model_select", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", async () => stop());
}
