# Public source and release audit

This repository is public. Review a file before committing it, and review
generated artifacts before publishing a release. The automated check below is
an early rejection gate; it cannot prove that a file is safe to publish.

## Source import

There is no imported predecessor application source in the repository's initial
history. For each proposed import from private work, record in its PR:

1. Original repository and file identity in the private review record; publish
   only a de-identified summary when that identity itself is private.
2. Why the selected source belongs in the portable product, and which host
   configuration or data was removed.
3. License and third-party provenance, including generated code or assets.
4. Review of the complete file, diff, tests, fixtures, documentation, and
   history exposure. Copy selected content into the new history; never mirror
   the old repository or its commits.

## Upstream attribution

The initial candidate sources were checked at their selected immutable
revisions. All three upstream source licenses are MIT:

| Component | Candidate source | Copyright holder | License evidence |
| --- | --- | --- |
| DeepSeek Harness | [`dsh-v0.1.7-rc.1` at `46a7f68b0922371ce7144b668b90e377d8e799f4`](https://github.com/deepseek-ai/deepseek-harness/tree/46a7f68b0922371ce7144b668b90e377d8e799f4) | DeepSeek | [MIT license at the pinned commit](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/LICENSE) |
| dsh-TUI | [`v0.11.0` at `19c76a1d877b69ee3f399147bf84f2bae3b10e58`](https://github.com/ccch1mneyyy/dsh-TUI/tree/19c76a1d877b69ee3f399147bf84f2bae3b10e58) | chimney (`ccch1mneyyy`) | [MIT license at the pinned commit](https://github.com/ccch1mneyyy/dsh-TUI/blob/19c76a1d877b69ee3f399147bf84f2bae3b10e58/LICENSE) |
| dsh-runtime-kit | [candidate commit `dd53024fb892831bd55fc2466259e9f5f4062cf1`](https://github.com/sympoies/dsh-runtime-kit/tree/dd53024fb892831bd55fc2466259e9f5f4062cf1) | Sympoies contributors | [MIT license at the pinned commit](https://github.com/sympoies/dsh-runtime-kit/blob/dd53024fb892831bd55fc2466259e9f5f4062cf1/LICENSE) |

The upstream copyright lines and license texts for these pinned source trees
are preserved in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). These are
candidate identities, not accepted pins or a complete dependency license
inventory. The Workbench's own source is MIT-licensed in [LICENSE](../LICENSE).

## Repeatable checks

The public `main` branch has an active GitHub ruleset with no bypass actors.
It requires a pull request and the `source` status check before an update,
and rejects deletion and force pushes. Verify the effective branch rules and
the required check in GitHub before a release; a workflow that runs only after
a direct push would be too late to protect public history.

Run `scripts/check-publication.sh` from the repository root on every PR. Pass
each generated bundle or release asset tree with `--artifact PATH`. For a
container candidate, export its image configuration and labels to a text/JSON
file outside the repository and pass that file as an artifact as well. Do the
same for the release workflow log after a candidate build. The script scans
tracked content, public names, and supplied artifact trees for selected secret,
identity, private path, and endpoint patterns without printing matching bytes
or pathnames. It rejects symlinks and unreadable files. Compressed archives are
rejected as opaque inputs, including renamed archives detected by file content.
Other binary assets also require a separate audited handling path before release.
Extract the exact finalized archive safely into a disposable tree and scan that
tree, then inspect the archive and manifest before publishing.

For the combined candidate profile, CI runs the pinned package manager's
`licenses list --prod --json` against the installed profile. The
`scripts/license-inventory.ts` adapter emits only package names, versions, and
declared license identifiers; it drops install paths and package-author
metadata, then the publication scanner checks the sanitized report. Each
platform's path-free inventory is included in the workflow summary. This is a
metadata inventory, not a legal conclusion or a substitute for the package
license files. Before distribution, review the exact inventory and preserve
the required notices from the included packages in the release output.

Before the first release, a human reviewer must also inspect:

- Every tracked file and imported source provenance record.
- Generated bundles, package archives, OCI configuration and labels, release
  assets, and workflow logs after rendering; build instructions alone do not
  establish their contents.
- The exact dependency license inventory and bundled notices.
- Installation and runtime receipts for personal paths, account settings,
  credentials, endpoints, and session data.

Record that final review against [#8](https://github.com/sympoies/dsh-workbench/issues/8)
before publishing. Repeat it after a change to the version tuple or artifact
contents. Keep private findings in the private deployment or security channel;
do not post sensitive bytes to public issues or CI logs.
