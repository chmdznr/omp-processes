/**
 * Roster + output access for daemon-broker processes.
 *
 * Every process an agent starts through the `hub` tool (`op: "start"`) is
 * supervised by a per-project (or machine-global) broker. Live brokers are
 * authoritative: the roster, the merged stdout+stderr stream, stdin writes,
 * signals, and stop/kill/restart all go over the broker socket. A scope whose
 * broker is gone still has its persisted `meta.json` and `output.log` on disk,
 * so exited processes remain inspectable — read-only.
 */

import * as path from "node:path";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSignal, DaemonSnapshot, DaemonSpec, DaemonState } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { PsScope } from "@oh-my-pi/pi-coding-agent/cli/ps-data";
import { loadPsData } from "./host.ts";

/** Bytes of persisted log tail read when no broker is alive to serve `logs`. */
const DISK_TAIL_BYTES = 256 * 1024;
/** Broker-side wait for the long-poll `logs` follow; new bytes return earlier. */
const FOLLOW_TIMEOUT_MS = 1000;
/** Graceful stop window, mirroring `omp ps stop`. */
const STOP_GRACE_MS = 5000;
/** C0 controls that would move the terminal cursor, minus TAB, LF, and ESC. */
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu;

export type ProcessAction = "stop" | "kill" | "restart";

/** One supervised process plus the scope it belongs to. */
export interface ProcessRow {
	/** Stable identity across refreshes: scope runtime dir + daemon name. */
	readonly key: string;
	readonly scope: PsScope;
	/** Short scope name for the roster's SCOPE column. */
	readonly scopeLabel: string;
	readonly snapshot: DaemonSnapshot;
	/** Launch command from the persisted spec, collapsed to one line. */
	readonly command: string;
	readonly cwd?: string;
	/** False when the snapshot came from disk with no broker supervising it. */
	readonly supervised: boolean;
}

/** One sample of a process's output. */
export interface OutputFrame {
	readonly lines: readonly string[];
	/** Byte offset to pass as the next `cursor`; undefined for disk reads. */
	readonly cursor?: number;
	readonly state: DaemonState;
	/** True when `lines` is a replayed PTY screen rather than a log tail. */
	readonly screen: boolean;
	/** True when the frame came from disk because no broker is alive. */
	readonly fromDisk: boolean;
}

export interface OutputRequest {
	readonly row: ProcessRow;
	readonly lines: number;
	/** Replay PTY output as a rendered screen when the process has a PTY. */
	readonly screen: boolean;
	/** Byte cursor from the previous frame; enables incremental follow. */
	readonly cursor?: number;
	/** Let the broker hold the request until new output arrives. */
	readonly follow: boolean;
	readonly signal?: AbortSignal;
}

function scopeLabel(scope: PsScope): string {
	if (scope.kind === "global") return `global:${scope.service ?? path.basename(scope.runtimeDir)}`;
	const dir = scope.projectDir;
	return dir ? path.basename(dir) || dir : path.basename(scope.runtimeDir);
}

/** Tail of a persisted log file, or "" when it is absent. */
async function tailFile(file: string, maxBytes: number): Promise<string> {
	const handle = Bun.file(file);
	const size = handle.size;
	if (!(size > 0)) return "";
	const slice = size > maxBytes ? handle.slice(size - maxBytes) : handle;
	try {
		return await slice.text();
	} catch {
		return "";
	}
}

export class ProcessStore {
	readonly #cwd: string;
	readonly #clients = new Map<string, Promise<DaemonBrokerClient | undefined>>();
	readonly #pty = new Map<string, boolean | undefined>();
	readonly #lifetime = new AbortController();
	#disposed = false;

	constructor(cwd: string) {
		this.#cwd = cwd;
	}

	/**
	 * Current roster. `all` widens from this session's project to every broker
	 * scope on the machine (other projects plus global services).
	 */
	async list(all: boolean): Promise<ProcessRow[]> {
		const ps = await loadPsData();
		const reports = await ps.collectReports(all, all ? {} : { dir: this.#cwd });
		const rows: ProcessRow[] = [];
		for (const report of reports) {
			const label = scopeLabel(report.scope);
			for (const daemon of report.daemons) {
				rows.push({
					key: `${report.scope.runtimeDir}\u0000${daemon.snapshot.name}`,
					scope: report.scope,
					scopeLabel: label,
					snapshot: daemon.snapshot,
					command: ps.collapseCommand(daemon.command),
					cwd: daemon.cwd,
					supervised: daemon.supervised,
				});
			}
		}
		return rows;
	}

	/**
	 * Whether a process runs under a PTY, read from the broker's persisted
	 * `meta.json`. Decides the newline stdin writes end with, and is reported in
	 * the output header. `undefined` when the file is unreadable.
	 *
	 * Cached per process generation.
	 */
	async usesPty(row: ProcessRow): Promise<boolean | undefined> {
		const cacheKey = `${row.key}\u0000${row.snapshot.id}`;
		if (this.#pty.has(cacheKey)) return this.#pty.get(cacheKey);
		let pty: boolean | undefined;
		try {
			const metaFile = path.join(row.scope.runtimeDir, "daemons", row.snapshot.name, "meta.json");
			const meta: unknown = await Bun.file(metaFile).json();
			if (meta !== null && typeof meta === "object" && "spec" in meta) {
				const spec: unknown = meta.spec;
				if (spec !== null && typeof spec === "object" && "pty" in spec && typeof spec.pty === "boolean") {
					pty = spec.pty;
				}
			}
		} catch {
			pty = undefined;
		}
		this.#pty.set(cacheKey, pty);
		return pty;
	}

	/** One output sample: broker stream when supervised, persisted log otherwise. */
	async output(request: OutputRequest): Promise<OutputFrame> {
		const { row } = request;
		const client = row.supervised ? await this.#client(row.scope) : undefined;
		if (!client) return this.#diskOutput(row, request.lines);

		const result = await client.request(
			{
				op: "logs",
				name: row.snapshot.name,
				lines: request.lines,
				head: false,
				follow: request.follow,
				cursor: request.cursor,
				renderTerminalRows: request.screen,
				timeoutMs: FOLLOW_TIMEOUT_MS,
			},
			this.#signal(request.signal),
		);
		if (result.op !== "logs") throw new Error(`Unexpected broker response ${result.op}`);
		const screenRows = request.screen ? result.terminalRows : undefined;
		return {
			lines: screenRows ?? splitLines(result.text),
			cursor: result.cursor,
			state: result.state,
			screen: screenRows !== undefined,
			fromDisk: false,
		};
	}

	/** Write to a process's stdin, deliver a signal, or both. */
	async send(row: ProcessRow, payload: { data?: string; signal?: DaemonSignal }): Promise<DaemonSnapshot> {
		const result = await this.#require(row).then((client) =>
			client.request({ op: "send", name: row.snapshot.name, ...payload }, this.#signal()),
		);
		if (result.op !== "send") throw new Error(`Unexpected broker response ${result.op}`);
		return result.daemon;
	}

	/** Stop, hard-kill, or restart a process. */
	async control(row: ProcessRow, action: ProcessAction): Promise<DaemonSnapshot> {
		const ps = await loadPsData();
		const client = await this.#require(row);
		const result = await client.request(
			action === "restart"
				? { op: "restart", name: row.snapshot.name }
				: {
						op: "stop",
						name: row.snapshot.name,
						timeoutMs: action === "kill" ? ps.KILL_GRACE_MS : STOP_GRACE_MS,
					},
			this.#signal(),
		);
		if (result.op !== "restart" && result.op !== "stop") {
			throw new Error(`Unexpected broker response ${result.op}`);
		}
		return result.daemon;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#lifetime.abort();
		const clients = [...this.#clients.values()];
		this.#clients.clear();
		this.#pty.clear();
		for (const pending of clients) {
			void pending.then((client) => client?.close()).catch(() => {});
		}
	}

	/** Broker client for a scope, or undefined when no broker owns it. */
	#client(scope: PsScope): Promise<DaemonBrokerClient | undefined> {
		const existing = this.#clients.get(scope.runtimeDir);
		if (existing) return existing;
		// A client request against a dead scope would spawn a broker; the viewer
		// only ever observes, so an unsupervised scope stays a disk read.
		if (this.#disposed || scope.brokerPid === undefined) return Promise.resolve(undefined);
		const pending = loadPsData()
			.then((ps) => ps.scopeClient(scope))
			.then((client) => {
				if (client && this.#disposed) {
					client.close();
					return undefined;
				}
				return client;
			})
			.catch(() => undefined);
		this.#clients.set(scope.runtimeDir, pending);
		return pending;
	}

	async #require(row: ProcessRow): Promise<DaemonBrokerClient> {
		const client = await this.#client(row.scope);
		if (!client) {
			throw new Error(
				row.scope.brokerPid === undefined
					? `No broker supervises ${row.scopeLabel}; ${row.snapshot.name} is read-only`
					: `Scope ${row.scopeLabel} is not addressable from this machine`,
			);
		}
		return client;
	}

	#signal(caller?: AbortSignal): AbortSignal {
		return caller ? AbortSignal.any([this.#lifetime.signal, caller]) : this.#lifetime.signal;
	}

	async #diskOutput(row: ProcessRow, lines: number): Promise<OutputFrame> {
		const dir = path.join(row.scope.runtimeDir, "daemons", row.snapshot.name);
		const [previous, current] = await Promise.all([
			tailFile(path.join(dir, "output.previous.log"), DISK_TAIL_BYTES),
			tailFile(path.join(dir, "output.log"), DISK_TAIL_BYTES),
		]);
		const joined = previous && current && !previous.endsWith("\n") ? `${previous}\n${current}` : `${previous}${current}`;
		const text = Bun.stripANSI(joined.length > DISK_TAIL_BYTES ? joined.slice(-DISK_TAIL_BYTES) : joined);
		return {
			lines: splitLines(text).slice(-lines),
			state: row.snapshot.state,
			screen: false,
			fromDisk: true,
		};
	}
}

/**
 * Split a plain log tail into renderable rows.
 *
 * Plain logs have no terminal emulator. Strip terminal sequences first, treat
 * CRLF as a line ending, then keep only text after a lone carriage return
 * because it overwrote the current row. Drop remaining C0 cursor controls;
 * tabs stay for the TUI's own tab expansion.
 */
function splitLines(text: string): string[] {
	const normalized = Bun.stripANSI(text).replaceAll("\r\n", "\n");
	const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	if (trimmed.length === 0) return [];
	return trimmed.split("\n").map((line) => {
		const carriage = line.lastIndexOf("\r");
		const visible = carriage === -1 ? line : line.slice(carriage + 1);
		return visible.replace(CONTROL_BYTES, "");
	});
}
