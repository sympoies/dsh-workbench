# DSH Workbench

DSH Workbench is a new public project for a version-locked DeepSeek Harness Web
and TUI workbench. It will package one validated combination of DeepSeek Harness,
dsh-TUI, and dsh-runtime-kit so both interfaces can discover eligible sessions
and resume them sequentially.

The [machine-readable contract](compatibility/workbench.json) accepts the
exact Linux x64 component combination after installed Web/TUI and session
handoff checks. It does not yet provide a portable installer, published
Workbench release, or owner deployment. Follow the
[roadmap](https://github.com/sympoies/dsh-workbench/issues/10) for the
acceptance gates and release work.

This repository owns portable product code and release artifacts. Host paths,
credentials, exposure, persistent data, and deployment cutover belong to each
consumer's private deployment configuration.

See the [product and deployment boundary](docs/architecture.md),
[session handoff decision](docs/session-handoff.md), and
[public source and release audit](docs/publication.md). Workbench source is
available under the [MIT license](LICENSE); pinned upstream notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The [contract guide](docs/compatibility.md) explains the release identity and
the accepted compatibility gate.
The [combined candidate profile procedure](docs/combined-profile.md) records
the exact patched DSH, TUI, and runtime-kit assembly order.

See [DEVELOPMENT.md](DEVELOPMENT.md) for contributor workflow and
[docs/devlog/README.md](docs/devlog/README.md) for durable development
decisions.
