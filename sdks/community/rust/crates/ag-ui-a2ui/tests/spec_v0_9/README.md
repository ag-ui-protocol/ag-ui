# Official specification fixtures

Source: [a2ui-project/a2ui at ec12ba915ab21725929430bd14bcef04e5ee7f12](https://github.com/a2ui-project/a2ui/tree/ec12ba915ab21725929430bd14bcef04e5ee7f12/specification/v0_9_1/catalogs/basic/examples).

`examples/` contains all 43 basic catalog examples from the pinned v0.9.1
specification, copied without modification. Their wire messages and catalog IDs
retain the v0.9 spelling used by the official files. The historical directory
name remains to avoid duplicating the existing fixtures. `official_examples.rs`
validates every message against the full schema and finishes each surface stream.

The upstream repository and these fixtures are Apache-2.0 licensed. The copy of
`basic_catalog.json` is retained for the catalog metadata compatibility tests.
