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

| Component | Candidate source | License evidence |
| --- | --- | --- |
| DeepSeek Harness | [dsh-v0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1) | [MIT license at the tag](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/LICENSE) |
| dsh-TUI | [v0.11.0](https://github.com/ccch1mneyyy/dsh-TUI/releases/tag/v0.11.0) | [MIT license at the tag](https://github.com/ccch1mneyyy/dsh-TUI/blob/v0.11.0/LICENSE) |
| dsh-runtime-kit | [candidate commit](https://github.com/sympoies/dsh-runtime-kit/commit/d559389c94ad6f42d11899ca22f994815c382440) | [MIT license at the commit](https://github.com/sympoies/dsh-runtime-kit/blob/d559389c94ad6f42d11899ca22f994815c382440/LICENSE) |

These are candidate identities, not accepted pins or a complete dependency
license inventory. Before a release, inventory the exact packaged dependency
closure and include each required copyright and license notice in the
distribution. The Workbench's own source is MIT-licensed in [LICENSE](../LICENSE).

## Repeatable checks

Run `scripts/check-publication.sh` from the repository root on every PR. Pass
each generated bundle or release asset tree with `--artifact PATH`. For a
container candidate, export its image configuration and labels to a text/JSON
file outside the repository and pass that file as an artifact as well. Do the
same for the release workflow log after a candidate build. The script scans
tracked content and supplied artifacts for selected secret, identity, private
path, and endpoint patterns without printing matching lines. It rejects
symlinks and unreadable files in supplied artifact trees.

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
