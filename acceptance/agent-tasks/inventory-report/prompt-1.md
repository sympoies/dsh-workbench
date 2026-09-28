Add an `inv report` subcommand to this repository's stock-list tool. Follow the repository rules in AGENTS.md.

Behavior (`inv [--file PATH] report [--json] [--low-stock N]`; flags after `report` may appear in any order):

1. Text output, one line each:
   `SKUs: <number of items>`
   `Units: <total quantity>`
   `Value: <sum of quantity × price, formatted like the prices in list>`
   Then, unless the inventory is empty, a `Top items:` line followed by up to three lines `<SKU>\t<name>\t<value>` for the items with the highest value (quantity × price), highest first, ties broken by SKU ascending.
2. `--json` prints exactly one JSON object instead: `{"skus": n, "units": n, "valueCents": n, "top": [{"sku": ..., "name": ..., "valueCents": n}]}` with the same top-three rule (an empty array for an empty inventory).
3. `--low-stock N` (N an unsigned decimal integer) also reports items whose quantity is below N, sorted by quantity then SKU. Text mode appends a `Low stock:` line followed by `<SKU>\t<quantity>` lines (the heading is printed even when no item qualifies). JSON mode adds `"lowStock": [{"sku": ..., "quantity": n}]`.
4. An invalid N, a missing N, or any other argument to `report` is an error: exit status 1 and a message on stderr, like the existing commands.
5. Existing commands keep their current behavior.

Add tests for the new behavior and its edge cases, document the subcommand in the README, run the tests, and commit the work on a feature branch. Do not push or open a pull request yet; stop after the commit and report what you did.
