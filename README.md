# pi-llm-tps

Live model throughput in [Pi](https://github.com/earendil-works/pi)'s status bar.

The extension selects a source from Pi's active model:

| Model provider | Source | Status |
| --- | --- | --- |
| `strata` (or `local` on port 8080) | Strata `/metrics` | Recent request wall average, current decode speed, reading/idle state |
| Other `local` models | `llama-server` journal | Live rolling decode speed and response average |

For Strata, the wall average covers up to 12 recent server requests, including the active request. It includes prompt reading and decode, but excludes time spent running tools. The current decode speed appears while the server is generating.

For `llama-server`, the extension follows journald and reads the rolling rate from lines like:

```text
slot print_timing: id 0 | task 2 | n_gen = 953, tg = 12.20 t/s, tg_3s = 11.98 t/s
```

## Install

```bash
pi install git:github.com/Kelsidavis/pi-llm-tps
```

Or copy `llm-tps.ts` into `~/.pi/agent/extensions/`. Run `/reload` in an open Pi session after installing or updating it. Remove the copied file before installing the package to avoid loading the extension twice.

## Configure the journal source

The journal source needs `journalctl` access and `stdbuf` (coreutils). It follows a systemd user unit named `llama-server.service` by default. Override the unit or scope with environment variables before starting Pi:

```bash
export LLM_TPS_UNIT=my-llama.service
export LLM_TPS_SCOPE=system  # default: user
```

The Strata source uses the active model's `baseUrl` and requires the server's `/metrics` endpoint. It is selected automatically for the `strata` provider or a `local` model on port 8080.

Run `/tps` to see the active source, sample count, and last reported speed. The extension does nothing in Pi modes without a UI.

## License

MIT
