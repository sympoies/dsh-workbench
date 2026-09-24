# Development Log

This log records durable decisions and evidence about DSH Workbench's product
boundary, version compatibility, session handoff, and releases. Entries are
newest first by month. The current contract and runbooks remain authoritative;
the log explains why they took their shape.

Use `devlog new` for a shipped capability, compatibility or security decision,
validation milestone, incident-relevant finding, or useful external reference.
Skip routine edits and transient investigation. Run `devlog check` after
writing.

Each entry has a dated title and `Result`, `Why / context`, and `Evidence`
sections. Add `Links` or `Follow-up` when useful. Never include credentials,
personal identifiers, machine-local paths, internal hostnames, private
topology, provider payloads, session state, or private skill contents.

## Entry template

```markdown
## YYYY-MM-DD - Short title

### Result
- What now exists.

### Why / context
- Why this decision was made.

### Evidence
- Commands or observations that actually ran.

### Links
- Relevant public issue, pull request, or source.
```

## Months

- [2026-09](2026-09.md)
