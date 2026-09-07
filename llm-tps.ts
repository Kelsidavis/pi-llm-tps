/**
 * pi-llm-tps - live llama.cpp decode rate in the pi status bar.
 *
 * llama-server logs a rolling rate roughly every 3s while generating:
 *   slot print_timing: ... n_gen = 953, tg = 12.20 t/s, tg_3s = 11.98 t/s
 *     tg    - average across the whole response
 *     tg_3s - rolling 3-second window (the live number)
 *
 * Nothing needs enabling server-side - no --metrics, no server patch. This
 * follows journald and mirrors the rate into the footer. Costs one long-lived
 * `journalctl -f` per session.
 *
 * Config (environment):
 *   LLM_TPS_UNIT    systemd unit running llama-server
 *                   (default: llama-server.service)
 *   LLM_TPS_SCOPE   "user" or "system" (default: user)
 *
 * Commands:
 *   /tps            report follower state, for when the footer looks stuck
 */

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UNIT = process.env.LLM_TPS_UNIT || "llama-server.service";
const SCOPE = process.env.LLM_TPS_SCOPE === "system" ? "--system" : "--user";
const LINE = /n_gen = +(\d+), tg = +([\d.]+) t\/s, tg_3s = +([\d.]+) t\/s/;
const IDLE_MS = 8000;

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | null = null;
	let idle: NodeJS.Timeout | null = null;
	let lastRate = "";
	let lines = 0;
	let started = false;

	const stop = () => {
		if (idle) { clearTimeout(idle); idle = null; }
		if (child) { child.kill(); child = null; }
		started = false;
	};

	pi.registerCommand("tps", {
		description: "Show llm-tps follower state",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(
				`llm-tps: follower=${child ? "running" : "STOPPED"} ` +
				`lines=${lines} last=${lastRate || "none yet"} ` +
				`unit=${UNIT} scope=${SCOPE}`,
				child ? "info" : "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return; // print/JSON mode has no footer
		stop();

		// Show something immediately, so a loaded-but-idle extension is
		// distinguishable from one that never loaded at all.
		ctx.ui.setStatus("tps", "⚡ --");

		try {
			// stdbuf: journalctl block-buffers when stdout is a pipe, which
			// batches the live rate instead of streaming it.
			child = spawn("stdbuf",
				["-oL", "journalctl", SCOPE, "-u", UNIT, "-f", "-n", "0", "-o", "cat"],
				{ stdio: ["ignore", "pipe", "ignore"] });
			started = true;
		} catch {
			ctx.ui.setStatus("tps", "⚡ spawn failed");
			return;
		}

		child.on("error", () => {
			child = null;
			ctx.ui.setStatus("tps", "⚡ journal err");
		});
		child.on("exit", () => {
			if (started) ctx.ui.setStatus("tps", "⚡ follower died");
			child = null;
		});

		if (!child.stdout) return;
		readline.createInterface({ input: child.stdout }).on("line", (line: string) => {
			const m = LINE.exec(line);
			if (!m) return;
			lines++;

			const [, gen, avg, now] = m;
			lastRate = `${now} t/s`;
			ctx.ui.setStatus("tps", `⚡ ${now} t/s  (avg ${avg}, ${gen} tok)`);

			// Server stops logging when generation ends. Keep the last rate
			// visible rather than blanking, but mark it stale.
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => ctx.ui.setStatus("tps", `⚡ ${now} idle`), IDLE_MS);
		});
	});

	pi.on("session_shutdown", async () => stop());
}
