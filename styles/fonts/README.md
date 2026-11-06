# Tool fonts

`../fonts.css` preserves the Inter 400/600/700 and JetBrains Mono 400 faces,
Unicode ranges, and `font-display: swap` from the Google Fonts CSS response:

<https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap>

Retrieved 2026-11-05 with a current Chromium user agent. The WOFF2 files are
unmodified downloads from the official URLs recorded with SHA-256 digests in
`sources.json`. Inter's weights share each subset's variable font file.

The fonts total 261,656 bytes across 13 files. The Latin pair is 69,424 bytes;
the browser loads other subsets only for matching text. Local hosting preserves
the requested font payload and removes the external stylesheet connection.

Copyright notices and the SIL Open Font License 1.1 are included in `fonts.css`
and the published `LICENSE.txt`. Official license sources:

- [Inter](https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt)
- [JetBrains Mono](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt)
