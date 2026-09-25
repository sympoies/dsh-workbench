# DSH Workbench

DSH Workbench is a new public project for a version-locked DeepSeek Harness Web
and TUI workbench. It will package one validated combination of DeepSeek Harness,
dsh-TUI, and dsh-runtime-kit so both interfaces can discover eligible sessions
and resume them sequentially.

The project is in its design and compatibility phase. Its
[machine-readable contract](compatibility/workbench.json) pins a candidate
combination, but it does not yet provide an installable release. Follow the
[roadmap](https://github.com/sympoies/dsh-workbench/issues/10) for the
acceptance gates and release work.

This repository owns portable product code and release artifacts. Host paths,
credentials, exposure, persistent data, and deployment cutover belong to each
consumer's private deployment configuration.

See the [product and deployment boundary](docs/architecture.md) and
[public source and release audit](docs/publication.md). Workbench source is
available under the [MIT license](LICENSE).

The [contract guide](docs/compatibility.md) explains the release identity and
the candidate-to-accepted gate.

See [DEVELOPMENT.md](DEVELOPMENT.md) for contributor workflow and
[docs/devlog/README.md](docs/devlog/README.md) for durable development
decisions.
