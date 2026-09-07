/**
 * omp-processes — a live view of the background processes agents start.
 *
 * `Ctrl+P` or `/processes` opens a fullscreen overlay listing every process
 * supervised by this project's daemon broker (everything an agent launched with
 * the `hub` tool's `op: "start"`, plus omp's own service daemons), streams the
 * selected process's merged stdout+stderr, and writes to its stdin.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { type PsData, loadPsData } from "../src/host.ts";
import { ProcessStore } from "../src/store.ts";
import { ProcessViewer } from "../src/view.ts";

/**
 * Ctrl+P is claimed by the built-in `app.model.cycleForward` binding, and the
 * editor resolves its own action keys before extension shortcuts. A raw input
 * listener sees the chord first, so the viewer opens instead of the model
 * cycling. `registerShortcut` is kept for `/hotkeys` discoverability.
 */
const OPEN_CHORD = "ctrl+p";

export default function processesExtension(pi: ExtensionAPI): void {
	pi.setLabel("Processes");

	let open = false;
	let releaseInput: (() => void) | undefined;

	async function openViewer(ctx: ExtensionContext): Promise<void> {
		if (open) return;
		if (!ctx.hasUI) {
			ctx.ui.notify("The process viewer needs the interactive TUI", "warning");
			return;
		}
		let ps: PsData;
		try {
			ps = await loadPsData();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}

		open = true;
		const store = new ProcessStore(ctx.cwd);
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ProcessViewer({ tui, theme, store, uptime: ps.uptimeCell, done: () => done(undefined) }),
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
						fullscreen: true,
						mouseTracking: false,
					},
				},
			);
		} finally {
			// `custom` disposes the component, which disposes the store; this
			// covers the mount-failure path too.
			store.dispose();
			open = false;
		}
	}

	pi.registerCommand("processes", {
		description: "Watch background processes: live output, stdin, stop/restart",
		handler: async (_args, ctx) => {
			await openViewer(ctx);
		},
	});

	pi.registerShortcut(OPEN_CHORD, {
		description: "Open the process viewer",
		handler: (ctx) => {
			void openViewer(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || releaseInput) return;
		releaseInput = ctx.ui.onTerminalInput((data) => {
			// The viewer owns the keyboard while it is mounted.
			if (open || !matchesKey(data, OPEN_CHORD)) return undefined;
			void openViewer(ctx);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		releaseInput?.();
		releaseInput = undefined;
	});
}
