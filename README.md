# omp-processes

Fullscreen process monitor for OMP. Open it with `Ctrl+P` or `/processes` to inspect every daemon-backed background process that agents started with `hub` `op:"start"`.

The viewer shows the live process list, its merged stdout and stderr, and an stdin prompt for the selected process. It talks to OMP's daemon broker directly. It does not show async `bash`, `task`, or `eval` jobs because those jobs have no live stdin or output stream.

## Install

From this checkout:

```sh
omp plugin link .
```

Or load it for one session:

```sh
omp -e ./extensions/processes.ts
```

Restart OMP after linking if it is already running.

## Controls

| Key | Action |
| --- | --- |
| `Ctrl+P` | Open the viewer |
| `/processes` | Open the viewer |
| `Up`/`Down`, `j`/`k` | Select a process |
| `PageUp`/`PageDown`, `Home`/`End`, `Shift+Up`/`Shift+Down` | Scroll output. Scrolling away from the tail pauses follow. |
| `f` | Toggle output follow |
| `v` | Toggle rendered PTY screen and plain log tail |
| `i`, `Enter` | Open stdin. `Enter` sends the line and `Esc` leaves stdin. |
| `Ctrl+C` | Send `SIGINT` to the selected process |
| `s`, `x`, `r` | Stop, kill, or restart. Press `y` to confirm. |
| `a` | Show processes from every project and global OMP service scope |
| `q`, `Esc` | Close the viewer |

A dead broker remains inspectable. The viewer reads its persisted output log and labels the process read-only. Live controls and stdin require an active broker.

## Requirements

OMP 18 or newer. The extension imports OMP's bundled `cli/ps-data` module, so it uses the same broker discovery and process protocol as `omp ps`.
