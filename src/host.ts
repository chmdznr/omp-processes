/**
 * Bridge to the process-supervision code that already ships inside omp.
 *
 * `@oh-my-pi/pi-coding-agent/cli/ps-data` is a host-bundled module: the
 * extension loader rewrites the specifier onto the copy compiled into the omp
 * binary, so this is the same scope discovery, broker client, and snapshot
 * decoding that `omp ps` uses. It is imported lazily (and dynamically) so a
 * host that no longer publishes that entry degrades to a message in the UI
 * instead of breaking extension load.
 *
 * The specifier must stay a literal — the loader rewrites string literals in
 * import expressions, not variables.
 */

import type * as PsDataModule from "@oh-my-pi/pi-coding-agent/cli/ps-data";

export type PsData = typeof PsDataModule;

let pending: Promise<PsData> | undefined;

/** Load the host's process-supervision module. Rejects with a readable reason. */
export function loadPsData(): Promise<PsData> {
	pending ??= import("@oh-my-pi/pi-coding-agent/cli/ps-data").catch((cause: unknown) => {
		pending = undefined;
		throw new Error(
			`omp-processes: this omp build does not expose its process supervisor to extensions (${cause instanceof Error ? cause.message : String(cause)})`,
			{ cause },
		);
	});
	return pending;
}
