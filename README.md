# DSH Workbench

DSH Workbench is a new public project for a version-locked DeepSeek Harness Web
and TUI workbench. It will package one validated combination of DeepSeek Harness,
dsh-TUI, and dsh-runtime-kit so both interfaces can discover eligible sessions
and resume them sequentially.

The project is in its design and compatibility phase. It does not yet provide
an installable release. Follow the [roadmap](https://github.com/sympoies/dsh-workbench/issues/10)
for the planned contract, acceptance gates, and release work.

This repository owns portable product code and release artifacts. Host paths,
credentials, exposure, persistent data, and deployment cutover belong to each
consumer's private deployment configuration.

See [DEVELOPMENT.md](DEVELOPMENT.md) for contributor workflow and
[docs/devlog/README.md](docs/devlog/README.md) for durable development
decisions.
