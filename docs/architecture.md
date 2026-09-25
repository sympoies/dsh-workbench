# Product and deployment boundary

DSH Workbench packages a reviewed combination of the official DeepSeek Harness
(DSH) Web experience, dsh-TUI, and dsh-runtime-kit. It owns the portable
integration, one immutable version contract, installation checks, and acceptance
tests. The current repository contains no imported predecessor application
source. The [roadmap](https://github.com/sympoies/dsh-workbench/issues/10)
tracks the work needed before a release is installable.

## Component ownership

| Surface | Owner | Workbench responsibility |
| --- | --- | --- |
| Conversation, tools, approvals, persistence, and session writer | Upstream DSH | Integrate public, supported interfaces; test the exact release. |
| Native browser experience | Upstream DSH and Workbench extension | Preserve native behavior while adding portable Workbench integration. |
| Terminal interface | dsh-TUI | Package a tested profile without making a particular terminal host a dependency. |
| Agent policy and managed checkout behavior | dsh-runtime-kit | Pin a supported revision and validate its exact DSH composition. |
| Host accounts, paths, volumes, exposure, credentials, and cutover | Consuming deployment | Supply private configuration and operate the released artifacts. |

Agent Console and other terminal hosts may launch the Workbench TUI package.
They are consumers of its interface, not part of its package or release graph.
Generic changes to DSH lifecycle or persistence belong with the DSH owner; a
Workbench-specific adapter may consume a documented upstream interface but
must not silently fork session semantics.

## Configuration inputs

The portable installer must require or validate these inputs before activation.
Names and a machine-readable schema will be finalized with the installer;
this table defines the public boundary now.

| Input | Requirement | Owner |
| --- | --- | --- |
| Web bind address and port | Explicit loopback or deployment-provided address; no public ingress default. | Deployment |
| DSH persistence root | Explicit writable location; never a path embedded in the release. | Deployment |
| Workspace identity and mounts | Explicit canonical mapping shared by Web and TUI; topology awaits the two-process proof. | Deployment |
| Runtime-kit policy/profile | Derived from the pinned release, with deployment-specific settings supplied separately. | Workbench and deployment |
| Provider credentials and user preferences | Injected at runtime by the deployment or user; absent from artifacts and install receipts. | Deployment |
| TUI invocation/profile location | Resolved from the installed package and deployment configuration, not from Agent Console paths. | Workbench and deployment |

The [session handoff decision](session-handoff.md) selects a shared explicit
persistence root and canonical workspace with sequential writers. The first
milestone stops the entire Web Host before TUI resumes a Web-held session.

The private deployment retains account names, hostnames, reverse proxy and
Tailscale settings, secret references and values, session logs, attachments,
user preferences, and existing installation state. Workbench release artifacts
must contain none of these. A deployment may map Web and TUI to the same
persistence and workspace only after the handoff proof in
[#6](https://github.com/sympoies/dsh-workbench/issues/6); sharing a directory
alone is not evidence that writers can hand off safely.

## Source and history

The public repository began with a new history. Source from the private
predecessor is imported only as individually reviewed files with a provenance
record, license check, privacy review, and diff review. Its Git history, local
configuration, and deployment data are never mirrored. See
[publication audit](publication.md) for the required import and release checks.
