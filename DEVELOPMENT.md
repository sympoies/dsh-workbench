# Development

This repository is being initialized. The
[roadmap](https://github.com/sympoies/dsh-workbench/issues/10) owns the order
for the version contract, DSH Web and TUI ports, session handoff, and portable
release.

Use exact source tags or commits and keep a candidate graph separate from an
accepted release. Test Web and TUI against the same DSH session store and
workspace identity before claiming cross-interface resume.

For durable design or compatibility outcomes, update the current owner first,
then use `devlog new` to append one evidence-backed entry. Run `devlog check`
before delivery. The log's format and privacy rules are in
[docs/devlog/README.md](docs/devlog/README.md).

Before sending source for review, run `bash scripts/check-publication.sh` and
review the [publication checklist](docs/publication.md). A generated release
candidate must also pass each generated artifact tree to that script with
`--artifact PATH`, followed by human review.
