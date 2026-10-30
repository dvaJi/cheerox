# Vendored HTML5 integration hooks

These directories contain html5ever 0.35.0, markup5ever 0.35.0 and html5gum 0.8.4,
with their original license files (MIT OR Apache-2.0 for html5ever/markup5ever;
MIT for html5gum). Their exact patched sources ship in
the npm package and are selected by the root Cargo manifest's
`[patch.crates-io]` entries.

Cheerox adds optional TreeSink observers for the parser's actual open-element
stack. Stack push, pop, replacement and truncation operations notify the sink
as they happen. These hooks allow a caller's parse5-compatible tree adapter to
observe the same construction process used by the Rust HTML5 tree builder.
Ordinary parsing uses the default observer methods.

An opt-in tokenizer flag also escapes private-use characters produced by
character references, emitting each escape and its character as one text token.
This preserves the distinction between literal Unicode and Cheerox's internal
representation of lone JavaScript UTF-16 surrogates.
The flag is disabled for upstream users of these crates. The original HTML5
character-reference decoding rules remain in place.

The patches preserve the HTML5 tree-building algorithms. Review changes against
the original [html5ever archive](https://crates.io/api/v1/crates/html5ever/0.35.0/download)
and [markup5ever archive](https://crates.io/api/v1/crates/markup5ever/0.35.0/download),
and the [html5gum archive](https://crates.io/api/v1/crates/html5gum/0.8.4/download).
Do not remove or edit the original third-party notices when updating these sources.
