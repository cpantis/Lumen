# Implementation — 2.8 Replay tool (text for the challenge document)

For sub-challenge 2.8 I built **StampTrace** (“Synchronised replay & test analysis for MCAP recordings”), a web application that replays every stream of a ROS 2 MCAP recording in sync, so that at any moment one can see what went into the component and what came out of it. The application runs entirely in the browser (TypeScript, React, Vite) and needs no ROS installation:
- the file is read through its index (`@mcap/core`) directly from a `Blob`, so multi-GB recordings are never loaded into memory;
- messages are decoded from the schemas stored in the file, in a Web Worker with an LRU cache and prefetching. Every encoding with a public specification in the MCAP registry is supported: `cdr` (`ros2msg`, `ros2idl`, `omgidl`), `ros1`, `protobuf`, `json`, `cbor` and `msgpack`;
- nothing is hard-coded: topics, types, frames and fields of view are discovered from the data. Foxglove well-known schemas (RawImage, CompressedImage, PointCloud, FrameTransform(s), CameraCalibration, LaserScan) are normalised to the ROS types, so every panel and analysis works on them too.

The interface is organised around the component, in three columns (*Inputs | Outputs FOV 1 | Outputs FOV 2*), with a timeline in which:
- every message is a tick;
- gaps are highlighted in red;
- empty or invalid messages are highlighted.

Each panel shows the age and the status of its message (OK, late, stale, empty, invalid). An input panel can show exactly the frame the current output was produced from, and the live latency is also translated into centimetres walked by the user.

The main technical decision was to keep **all computations in a pure library** (`src/core`), used identically by the application and by a Node CLI (`npm run metrics`). The library covers:
- rates, jitter, gaps and clock analysis;
- inference of causality from `header.stamp`;
- latency, skipped frames and content metrics;
- evaluation of the requirements defined in `config/thresholds.yaml`.

What the application shows and what the automatic tests report therefore come from the same code and the same thresholds, and a cross-validation screen checks it by comparing the `metrics.json` files.

The tool directly supports the analysis of the component:
- **2.1** — the inventory and the regularity plots export to Markdown/CSV, ready to paste into the document;
- **2.2** — the I/O diagram is inferred, not assumed: a topic is an output only if it copies the stamps of an input exactly and is published after it. Hardware-synchronised non-visual sensors (e.g. an IMU stamped on the camera clock) are not accepted as evidence;
- **2.3** — the 3D cloud ↔ depth consistency is computed over time, and missing calibration parameters are estimated (Nelder–Mead), with a confidence per parameter.

Every export carries the SHA-256 of the file, the application version and the thresholds used, so results can be reproduced exactly.

For reproducible tests I wrote a deterministic synthetic recording generator with the same structure as the real recording (two cameras, IMU, CameraInfo, TF, depth image and point cloud per FOV), into which I **injected known defects**:
- a latency spike;
- skipped frames;
- an input gap;
- frozen frames;
- an empty or NaN-filled cloud;
- a non-monotonic stamp;
- an IMU glitch;
- a geometrically shifted cloud.

The tests check that the application finds all of them: 49 unit, integration and compatibility tests (Vitest) and 16 end-to-end tests (Playwright), which cover every export and include an automatic WCAG AA accessibility audit in both themes. Compatibility with other recordings is verified on the 416 official MCAP conformance files and on recordings written with the official libraries (ROS 2, ROS 1, Foxglove schemas in protobuf and JSON), as well as truncated and corrupted files. Everything runs with a single command: `npm run test:all`. The interface has its own StampTrace logo — an input frame’s stamp traced to the output produced from it — and a visual style inspired by the .lumen identity (dark theme by default, Poppins/JetBrains Mono, pill buttons) and, being assistive technology, is fully usable with the keyboard and a screen reader. The interface is in English, with Romanian available in the settings.

*StampTrace — designed and developed by Calin Pantis.*
