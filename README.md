# pi-llm-tps

Live llama.cpp decode rate in the [pi](https://github.com/earendil-works/pi-coding-agent) status bar.

```
⚡ 15.91 t/s  (avg 14.02, 1066 tok)
```

## Why

When you run pi against a local `llama-server`, there is no feedback on how fast
it is actually decoding until the response finishes. That matters when you are
tuning `-ncmoe`, `-ub`, GPU offload or clocks — you want to see the effect while
it happens, not reconstruct it from logs afterwards.

`llama-server` already logs a rolling rate about every 3 seconds during
generation:

```
slot print_timing: id 0 | task 2 | n_gen = 953, tg = 12.20 t/s, tg_3s = 11.98 t/s
```

- `tg` — average across the whole response
- `tg_3s` — rolling 3-second window, the live number

So there is nothing to enable server-side: no `--metrics`, no patching
llama.cpp. This extension follows journald and mirrors that into pi's footer.

## Requirements

- `llama-server` running under systemd, logging to journald
- `journalctl` readable by the user running pi
- `stdbuf` (coreutils) — without it journalctl block-buffers into a pipe and the
  rate arrives in bursts instead of streaming

## Install

```bash
git clone https://github.com/Kelsidavis/pi-llm-tps
cp pi-llm-tps/llm-tps.ts ~/.pi/agent/extensions/
```

Extensions in `~/.pi/agent/extensions/` are auto-discovered. Restart pi, or
`/reload` in an existing session.

## Configure

Set the unit name to match your setup:

```bash
export LLM_TPS_UNIT=my-llama.service   # default: llama-server.service
export LLM_TPS_SCOPE=system            # default: user (systemctl --user)
```

For a systemd *user* unit the defaults are usually right apart from the name.

## Verifying

`⚡ --` means loaded but idle — the server only logs while generating, so this
is what you see between responses.

If it stays at `⚡ --` during generation, run `/tps`:

```
llm-tps: follower=running lines=42 last=12.04 t/s unit=llama-server.service scope=--user
```

- `follower=STOPPED` — the journalctl child died or never started
- `lines=0` while generating — wrong unit name, or the log format differs from
  the regex in `llm-tps.ts`

## Notes

- Reports the **server-side** rate. For a local provider that is what pi is
  receiving; if you point pi at a remote model, the footer will show nothing.
- Assumes one llama-server. Multiple backends need one unit name per instance.
- Costs one long-lived `journalctl -f` per pi session, cleaned up on
  `session_shutdown`.
- Guarded on `ctx.hasUI`, so it no-ops in print (`-p`) and JSON modes.

## License

MIT
