# MCAP conformance files

The 416 `.mcap` files and the expected `<Name>.json` outputs in this folder are copied
unchanged from the official MCAP repository, `tests/conformance/data`
(https://github.com/foxglove/mcap, MIT License, © Foxglove Technologies Inc.).

Each variant combines optional MCAP features: `ch` chunks, `chx` chunk index, `mx`
message index, `st` statistics, `sum` summary offsets, `rch`/`rsh` channels/schemas
repeated in the summary, `pad` extra bytes in records, `ax`/`mdx` attachment/metadata index.

`npm run conformance` checks that .lumen Replay reads every message of every variant.
