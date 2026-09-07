/**
 * Fullscreen process viewer: roster on top, live output below, stdin at the
 * bottom. Mounted as a fullscreen overlay by the `/processes` command and the
 * Ctrl+P chord.
 */

import type { SymbolKey, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { DaemonSnapshot, DaemonState } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { CURSOR_MARKER, ScrollView, extractPrintableText, matchesKey, replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { OutputFrame, ProcessAction, ProcessRow, ProcessStore } from "./store.ts";

/** Roster refresh cadence, matching the `omp ps` monitor. */
const ROSTER_INTERVAL_MS = 2000;
/** How long an action result stays on the mode line. */
const STATUS_TTL_MS = 5000;
/** Cap on log lines requested per output sample (broker caps at 1000). */
const MAX_OUTPUT_LINES = 500;
/** Poll cadence for a process whose log is frozen (exited or failed). */
const IDLE_POLL_MS = 2000;

const STATE_COLOR: Record<DaemonState, ThemeColor> = {
	starting: "warning",
	running: "success",
	ready: "success",
	restarting: "warning",
	stopping: "warning",
	exited: "dim",
	failed: "error",
};

const STATE_SYMBOL: Record<DaemonState, SymbolKey> = {
	starting: "status.pending",
	running: "status.running",
	ready: "status.success",
	restarting: "status.pending",
	stopping: "status.pending",
	exited: "status.disabled",
	failed: "status.error",
};

const TERMINAL_STATE: Partial<Record<DaemonState, true>> = { exited: true, failed: true };

const HINTS = [
	"↑↓ select",
	"pgup/pgdn scroll",
	"f follow",
	"v screen/log",
	"i stdin",
	"^C sigint",
	"s stop",
	"x kill",
	"r restart",
	"a all scopes",
	"q close",
].join("  ·  ");

interface Column {
	readonly header: string;
	readonly color: ThemeColor;
	readonly cell: (row: ProcessRow) => string;
}

export class ProcessViewer implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #store: ProcessStore;
	readonly #done: () => void;
	readonly #uptime: (snapshot: DaemonSnapshot) => string;
	readonly #output = new ScrollView([], { height: 1 });

	#rows: readonly ProcessRow[] = [];
	#index = 0;
	#selected: string | undefined;
	#rosterOffset = 0;
	#allScopes = false;
	#screenMode = true;
	#follow = true;
	#frame: OutputFrame | undefined;
	#outputError: string | undefined;
	#pty: boolean | undefined;
	#target = "";
	#pump: AbortController | undefined;
	#refreshedAt = 0;
	#status = "";
	#statusAt = 0;
	#input: string | undefined;
	#confirm: ProcessAction | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#disposed = false;
	#lines: readonly string[] = [];
	#signature = "";

	constructor(options: {
		tui: TUI;
		theme: Theme;
		store: ProcessStore;
		uptime: (snapshot: DaemonSnapshot) => string;
		done: () => void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#store = options.store;
		this.#uptime = options.uptime;
		this.#done = options.done;
		this.#timer = setInterval(() => void this.#refresh(), ROSTER_INTERVAL_MS);
		void this.#refresh();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#pump?.abort();
		this.#pump = undefined;
		this.#store.dispose();
	}

	handleInput(data: string): void {
		if (this.#confirm !== undefined) {
			const action = this.#confirm;
			this.#confirm = undefined;
			if (data === "y" || data === "Y") void this.#control(action);
			else this.#note("cancelled", "dim");
			this.#tui.requestRender();
			return;
		}

		if (this.#input !== undefined) {
			this.#handleStdinKey(data);
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			void this.#interrupt();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.#done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.#move(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.#move(1);
			return;
		}
		if (this.#handleScrollKey(data)) return;

		if (data === "f") {
			this.#follow = !this.#follow;
			if (this.#follow) this.#output.scrollToBottom();
			this.#note(this.#follow ? "following output" : "output paused", "dim");
		} else if (data === "v") {
			this.#screenMode = !this.#screenMode;
			this.#note(this.#screenMode ? "screen replay" : "log tail", "dim");
			this.#syncTarget();
		} else if (data === "a") {
			this.#allScopes = !this.#allScopes;
			this.#note(this.#allScopes ? "all scopes" : "this project", "dim");
			void this.#refresh();
		} else if (data === "i" || matchesKey(data, "enter")) {
			if (this.#current) {
				this.#input = "";
				this.#note("stdin: enter sends, esc leaves", "dim");
			}
		} else if (data === "s" || data === "x" || data === "r") {
			if (this.#current) this.#confirm = data === "s" ? "stop" : data === "x" ? "kill" : "restart";
		} else {
			return;
		}
		this.#tui.requestRender();
	}

	render(width: number): readonly string[] {
		const height = Math.max(10, this.#tui.terminal.rows);
		const rosterBody = Math.max(1, Math.min(this.#rows.length || 1, Math.max(3, Math.floor((height - 8) / 2))));
		const outputHeight = Math.max(1, height - rosterBody - 7);
		const row = this.#current;

		const lines = [
			this.#header(width),
			...this.#roster(width, rosterBody),
			this.#divider(width),
			this.#outputHeader(width, row),
			...this.#outputBody(width, outputHeight),
			this.#divider(width),
			this.#modeLine(width),
			truncateToWidth(this.#theme.fg("dim", ` ${HINTS}`), width),
		];

		// Same reference while content is unchanged: the renderer treats
		// reference equality as proof the rows are byte-identical.
		const signature = `${width}\u0000${lines.join("\n")}`;
		if (signature === this.#signature) return this.#lines;
		this.#signature = signature;
		this.#lines = lines;
		return lines;
	}

	get #current(): ProcessRow | undefined {
		return this.#rows[this.#index];
	}

	// ---------------------------------------------------------------- roster

	async #refresh(): Promise<void> {
		if (this.#disposed) return;
		try {
			const rows = await this.#store.list(this.#allScopes);
			if (this.#disposed) return;
			this.#rows = rows;
			this.#refreshedAt = Date.now();
			const found = this.#selected === undefined ? -1 : rows.findIndex((row) => row.key === this.#selected);
			this.#index = found >= 0 ? found : Math.max(0, Math.min(this.#index, rows.length - 1));
			this.#selected = this.#current?.key;
			this.#syncTarget();
		} catch (error) {
			this.#note(error instanceof Error ? error.message : String(error), "error");
		}
		this.#tui.requestRender();
	}

	#move(delta: number): void {
		if (this.#rows.length === 0) return;
		this.#index = Math.max(0, Math.min(this.#rows.length - 1, this.#index + delta));
		this.#selected = this.#current?.key;
		this.#follow = true;
		this.#syncTarget();
		this.#tui.requestRender();
	}

	// ---------------------------------------------------------------- output

	/** Re-arm the output pump whenever the selected generation or view changes. */
	#syncTarget(): void {
		const row = this.#current;
		const target =
			row === undefined
				? ""
				: [
						row.key,
						row.snapshot.id,
						// A restart reopens the log: the byte cursor and the pane both reset.
						row.snapshot.startedAt,
						row.snapshot.restartCount,
						row.supervised ? "live" : "disk",
						this.#screenMode ? "screen" : "log",
					].join("\u0000");
		if (target === this.#target) return;
		this.#target = target;
		this.#pump?.abort();
		this.#pump = undefined;
		this.#frame = undefined;
		this.#outputError = undefined;
		this.#pty = undefined;
		this.#output.setLines([]);
		if (row === undefined) return;
		void this.#store.usesPty(row).then((pty) => {
			if (this.#current?.key === row.key) this.#pty = pty;
		});
		const controller = new AbortController();
		this.#pump = controller;
		void this.#stream(row, target, controller.signal);
	}

	/**
	 * Follow one process's output until the selection or view changes.
	 *
	 * A live process long-polls, so new bytes appear as they are written. An
	 * exited one has a frozen log, so it drops to a slow poll instead of
	 * spinning — that poll is also what notices a later restart before the
	 * roster does, and what recovers the cursor after the log is reopened.
	 */
	async #stream(row: ProcessRow, target: string, signal: AbortSignal): Promise<void> {
		let cursor: number | undefined;
		while (!this.#disposed && !signal.aborted && this.#target === target) {
			try {
				const frame = await this.#store.output({
					row,
					lines: Math.min(MAX_OUTPUT_LINES, Math.max(60, this.#tui.terminal.rows * 3)),
					screen: this.#screenMode,
					cursor,
					follow: cursor !== undefined,
					signal,
				});
				if (signal.aborted || this.#target !== target) return;
				cursor = frame.cursor;
				this.#frame = frame;
				this.#outputError = undefined;
				this.#output.setLines(frame.lines);
				if (this.#follow) this.#output.scrollToBottom();
				this.#tui.requestRender();
				// Without a broker the persisted tail cannot change under us.
				if (frame.fromDisk) return;
				if (TERMINAL_STATE[frame.state]) {
					cursor = undefined;
					await Bun.sleep(IDLE_POLL_MS);
				}
			} catch (error) {
				if (signal.aborted) return;
				this.#outputError = error instanceof Error ? error.message : String(error);
				this.#tui.requestRender();
				return;
			}
		}
	}

	#handleScrollKey(data: string): boolean {
		const scrolled =
			matchesKey(data, "pageUp") ||
			matchesKey(data, "pageDown") ||
			matchesKey(data, "home") ||
			matchesKey(data, "end") ||
			matchesKey(data, "shift+up") ||
			matchesKey(data, "shift+down");
		if (!scrolled || !this.#output.handleScrollKey(data)) return false;
		this.#follow = this.#output.getScrollOffset() >= this.#output.getMaxScrollOffset();
		this.#tui.requestRender();
		return true;
	}

	// ----------------------------------------------------------------- stdin

	#handleStdinKey(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			void this.#interrupt();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#input = undefined;
			this.#note("stdin closed", "dim");
		} else if (matchesKey(data, "enter")) {
			const text = this.#input ?? "";
			this.#input = "";
			void this.#write(text);
		} else if (matchesKey(data, "backspace")) {
			this.#input = (this.#input ?? "").slice(0, -1);
		} else {
			const printable = extractPrintableText(data);
			if (printable === undefined) return;
			this.#input = `${this.#input ?? ""}${printable}`;
		}
		this.#tui.requestRender();
	}

	async #write(text: string): Promise<void> {
		const row = this.#current;
		if (!row) return;
		// A PTY expects the carriage return a terminal would send; a pipe wants \n.
		const newline = this.#pty === false ? "\n" : "\r";
		try {
			await this.#store.send(row, { data: `${text}${newline}` });
			this.#note(`sent to ${row.snapshot.name}: ${text || "<newline>"}`, "success");
		} catch (error) {
			this.#note(error instanceof Error ? error.message : String(error), "error");
		}
		this.#tui.requestRender();
	}

	async #interrupt(): Promise<void> {
		const row = this.#current;
		if (!row) return;
		try {
			await this.#store.send(row, { signal: "SIGINT" });
			this.#note(`SIGINT → ${row.snapshot.name}`, "warning");
		} catch (error) {
			this.#note(error instanceof Error ? error.message : String(error), "error");
		}
		this.#tui.requestRender();
	}

	async #control(action: ProcessAction): Promise<void> {
		const row = this.#current;
		if (!row) return;
		this.#note(`${action} ${row.snapshot.name}…`, "warning");
		this.#tui.requestRender();
		try {
			const daemon = await this.#store.control(row, action);
			this.#note(`${action} ${daemon.name}: now ${daemon.state}`, "success");
			await this.#refresh();
		} catch (error) {
			this.#note(error instanceof Error ? error.message : String(error), "error");
			this.#tui.requestRender();
		}
	}

	// ---------------------------------------------------------------- render

	#note(message: string, color: ThemeColor): void {
		this.#status = this.#theme.fg(color, message);
		this.#statusAt = Date.now();
	}

	#divider(width: number): string {
		return this.#theme.fg("borderMuted", this.#theme.symbol("boxRound.horizontal").repeat(Math.max(0, width)));
	}

	#header(width: number): string {
		const live = this.#rows.filter((row) => !TERMINAL_STATE[row.snapshot.state]).length;
		const scope = this.#allScopes ? "all scopes" : (this.#rows[0]?.scopeLabel ?? "this project");
		const left = ` ${this.#theme.fg("accent", this.#theme.bold("PROCESSES"))} ${this.#theme.fg("dim", "·")} ${scope}`;
		const age = this.#refreshedAt === 0 ? "loading…" : `updated ${Math.round((Date.now() - this.#refreshedAt) / 1000)}s ago`;
		const right = this.#theme.fg("dim", `${live} live · ${this.#rows.length} tracked · ${age} `);
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
	}

	#columns(): Column[] {
		const columns: Column[] = [
			{ header: "NAME", color: "text", cell: (row) => row.snapshot.name },
			{
				header: "STATE",
				color: "text",
				cell: (row) =>
					TERMINAL_STATE[row.snapshot.state] && row.snapshot.exitCode !== undefined
						? `${row.snapshot.state}(${row.snapshot.exitCode})`
						: row.snapshot.state,
			},
			{
				header: "PID",
				color: "dim",
				cell: (row) => (row.snapshot.pid !== undefined && !TERMINAL_STATE[row.snapshot.state] ? String(row.snapshot.pid) : "-"),
			},
			{ header: "UPTIME", color: "dim", cell: (row) => this.#uptime(row.snapshot) },
			{ header: "↻", color: "dim", cell: (row) => String(row.snapshot.restartCount) },
		];
		if (this.#allScopes) columns.push({ header: "SCOPE", color: "muted", cell: (row) => row.scopeLabel });
		columns.push({ header: "COMMAND", color: "muted", cell: (row) => row.command });
		return columns;
	}

	#roster(width: number, height: number): string[] {
		if (this.#rows.length === 0) {
			const empty = this.#refreshedAt === 0 ? " loading…" : " No processes. Agents start them with the hub tool (op: start).";
			return [this.#theme.fg("dim", " NAME"), ...pad([truncateToWidth(this.#theme.fg("muted", empty), width)], height)];
		}

		const columns = this.#columns();
		const cells = this.#rows.map((row) => columns.map((column) => column.cell(row)));
		const widths = columns.map((column, index) =>
			Math.max(visibleWidth(column.header), ...cells.map((cell) => visibleWidth(cell[index] ?? ""))),
		);
		// The command column absorbs the remaining width instead of overflowing.
		const fixed = widths.slice(0, -1).reduce((total, value) => total + value + 2, 0);
		widths[widths.length - 1] = Math.max(8, width - fixed - 4);

		if (this.#index < this.#rosterOffset) this.#rosterOffset = this.#index;
		if (this.#index >= this.#rosterOffset + height) this.#rosterOffset = this.#index - height + 1;
		this.#rosterOffset = Math.max(0, Math.min(this.#rosterOffset, Math.max(0, this.#rows.length - height)));

		const header = this.#theme.fg(
			"dim",
			`   ${columns.map((column, index) => column.header.padEnd(widths[index] ?? 0)).join("  ")}`,
		);
		const body: string[] = [];
		for (let offset = 0; offset < height; offset++) {
			const index = this.#rosterOffset + offset;
			const row = this.#rows[index];
			if (!row) {
				body.push("");
				continue;
			}
			const plain = (cells[index] ?? []).map((cell, column) => truncateToWidth(cell, widths[column] ?? 0, "", true));
			const terminal = TERMINAL_STATE[row.snapshot.state] === true;
			if (index === this.#index) {
				const marker = this.#theme.symbol("nav.cursor");
				const line = ` ${marker} ${plain.join("  ")}`;
				body.push(this.#theme.bgFill("selectedBg", truncateToWidth(line, width, "", true)));
				continue;
			}
			const glyph = this.#theme.fg(STATE_COLOR[row.snapshot.state], this.#theme.symbol(STATE_SYMBOL[row.snapshot.state]));
			const painted = plain.map((cell, column) => {
				const color = column === 1 ? STATE_COLOR[row.snapshot.state] : terminal ? "dim" : (columns[column]?.color ?? "text");
				return this.#theme.fg(color, cell);
			});
			body.push(truncateToWidth(`   ${painted.join("  ")}`.replace(/^ {2}/u, ` ${glyph}`), width));
		}
		return [truncateToWidth(header, width), ...body];
	}

	#outputHeader(width: number, row: ProcessRow | undefined): string {
		if (!row) return truncateToWidth(this.#theme.fg("dim", " no process selected"), width);
		const parts = [
			this.#theme.fg("toolTitle", this.#theme.bold(row.snapshot.name)),
			this.#theme.fg(STATE_COLOR[row.snapshot.state], row.snapshot.state),
			this.#frame?.screen === true ? "screen" : "log tail",
			this.#pty === false ? "pipe" : "pty",
			this.#follow ? this.#theme.fg("success", "following") : this.#theme.fg("warning", "paused"),
		];
		const left = ` ${parts.join(this.#theme.fg("dim", " · "))}`;
		const detail = this.#frame?.fromDisk === true ? "persisted log · no broker" : `${this.#frame?.lines.length ?? 0} rows`;
		const right = this.#theme.fg("dim", `stdout+stderr · ${detail} `);
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
	}

	#outputBody(width: number, height: number): string[] {
		this.#output.setHeight(height);
		if (this.#outputError !== undefined) {
			return pad([truncateToWidth(this.#theme.fg("error", ` ${this.#outputError}`), width)], height);
		}
		if (this.#frame === undefined) {
			return pad([truncateToWidth(this.#theme.fg("dim", " waiting for output…"), width)], height);
		}
		if (this.#frame.lines.length === 0) {
			return pad([truncateToWidth(this.#theme.fg("dim", " no output yet"), width)], height);
		}
		return this.#output.render(width).map((line) => truncateToWidth(replaceTabs(line), width));
	}

	#modeLine(width: number): string {
		const status = this.#status !== "" && Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
		if (this.#confirm !== undefined) {
			const name = this.#current?.snapshot.name ?? "?";
			return truncateToWidth(`${this.#theme.fg("warning", ` ${this.#confirm} ${name}?`)} ${this.#theme.fg("dim", "y / n")}`, width);
		}
		if (this.#input !== undefined) {
			// Keep the caret on the prompt; a send result is reported to its right.
			const prompt = `${this.#theme.fg("accent", " stdin ")}${this.#input}`;
			const room = Math.max(1, width - 1 - visibleWidth(prompt));
			const note = status === "" || room < 12 ? "" : truncateToWidth(status, room);
			const gap = note === "" ? "" : " ".repeat(Math.max(1, room - visibleWidth(note)));
			return `${truncateToWidth(prompt, Math.max(1, width - 1))}${CURSOR_MARKER}${gap}${note}`;
		}
		return status === "" ? "" : truncateToWidth(` ${status}`, width);
	}
}

function pad(lines: string[], height: number): string[] {
	while (lines.length < height) lines.push("");
	return lines.slice(0, height);
}
