# Third-party notices — TUI redesign reference library

Every file in this directory is third-party source, copied here unmodified so
that what the redesign claims to have read is on disk. Each entry records the
**origin** (repository, exact path, pinned immutable commit) and the
**licence** under which it may be kept in this MIT-licensed tree.

Pins are 40-hex commits resolved from a dotted-numeric release tag. A branch is
not a pin: `poppinss/cliui` publishes from a default branch named `6.x`, which
moves, so it is pinned to the commit behind `v6.8.1` and not to that branch.

`blob:` is `git hash-object` of the local copy. It proves these exact bytes are
present; it does **not** prove they came from the recorded URL. Proving that
needs a second fetch of the cited URL. Do not describe it as more than that.

---

## MIT sources

### `cliui-table.ts`
- Repository: `poppinss/cliui`
- Path: `src/table.ts`
- Pinned: `v6.8.1` = `319531c0be1946072e7da29ea45f4514939aff06`
- URL: https://github.com/poppinss/cliui/blob/319531c0be1946072e7da29ea45f4514939aff06/src/table.ts
- SPDX-License-Identifier: MIT — Copyright (c) Poppinss
- blob:`a312cc77c588b5bcf266f97ed3093863cc956615`
- The file carries no SPDX header; it points at the repository `LICENSE`, which is MIT.

### `cliui-icons.ts`
- Repository: `poppinss/cliui`
- Path: `src/icons.ts`
- Pinned: `v6.8.1` = `319531c0be1946072e7da29ea45f4514939aff06`
- URL: https://github.com/poppinss/cliui/blob/319531c0be1946072e7da29ea45f4514939aff06/src/icons.ts
- SPDX-License-Identifier: MIT — Copyright (c) Poppinss
- blob:`a556a5f0fa8f3d4b9245c75496176e17c4e2fb51`
- Header credits `@poppinss/utils` rather than `@poppinss/cliui`; both are MIT under the same owner.

### `cliui-instructions.ts`
- Repository: `poppinss/cliui`
- Path: `src/instructions.ts`
- Pinned: `v6.8.1` = `319531c0be1946072e7da29ea45f4514939aff06`
- URL: https://github.com/poppinss/cliui/blob/319531c0be1946072e7da29ea45f4514939aff06/src/instructions.ts
- SPDX-License-Identifier: MIT — Copyright (c) Poppinss
- blob:`6ff82b157928fcffecb40548095624850f936598`

### `lipgloss-color.go`
- Repository: `charmbracelet/lipgloss`
- Path: `color.go`
- Pinned: `v2.0.5` = `5bd778d050f0a5a130e7cf041917927496dbe722`
- URL: https://github.com/charmbracelet/lipgloss/blob/5bd778d050f0a5a130e7cf041917927496dbe722/color.go
- SPDX-License-Identifier: MIT — Copyright (c) 2021-2026 Charmbracelet, Inc
- blob:`7443dc10bb0bd49174c22ca1c5804b9ad22fb814`
- No SPDX header in the file; MIT is the repository's, confirmed by fetch.

### `textual-design.py`
- Repository: `Textualize/textual`
- Path: `src/textual/design.py`
- Pinned: `v8.2.8` = `1d99508b928a771b51e1a527319c6b87dcff9e05`
- URL: https://github.com/Textualize/textual/blob/1d99508b928a771b51e1a527319c6b87dcff9e05/src/textual/design.py
- SPDX-License-Identifier: MIT — Copyright (c) 2021 Will McGugan
- blob:`290de588054d79feb5158dac6f5ccf75729bd869`
- No SPDX header in the file; MIT is the repository's, confirmed by fetch.

### `lazygit-layout.go`
- Repository: `jesseduffield/lazygit`
- Path: `pkg/gui/layout.go`
- Pinned: `v0.64.0` = `aee0e40ec1235476e9328678f0f3e2462576b9ae`
- URL: https://github.com/jesseduffield/lazygit/blob/aee0e40ec1235476e9328678f0f3e2462576b9ae/pkg/gui/layout.go
- SPDX-License-Identifier: MIT — Copyright (c) 2018 Jesse Duffield
- blob:`bcdc0edfc9684ad3cc70b995bf850029787dab3b`
- No SPDX header in the file; MIT is the repository's, confirmed by fetch.

### `opentui-renderable.ts`
- Repository: `sst/opentui`
- Path: `packages/core/src/Renderable.ts`
- Pinned: `v0.5.1` = `ad9a818d7a9d73f3386e92a445d0feb4b395c69e`
- URL: https://github.com/sst/opentui/blob/ad9a818d7a9d73f3386e92a445d0feb4b395c69e/packages/core/src/Renderable.ts
- SPDX-License-Identifier: MIT — Copyright (c) 2025 SST
- blob:`dcc4d78e31bd96df7835eca29795fb7fe83e05c4`
- This is the framework the harness already renders through (`@opentui/solid`,
  `@opentui/core`). It is vendored as the *contract we build against*, not as a
   design we are choosing between.

### `kilocode-prompt.tsx`
- Repository: `Kilo-Org/kilocode`
- Path: `packages/tui/src/component/prompt/index.tsx`
- Pinned: `64e5dd03633013b4564d0ac759747d606f74522c`
- URL: https://raw.githubusercontent.com/Kilo-Org/kilocode/64e5dd03633013b4564d0ac759747d606f74522c/packages/tui/src/component/prompt/index.tsx
- SPDX-License-Identifier: MIT — Copyright (c) 2026 Kilo Code; Copyright (c) 2025 opencode
- Licence text: `LICENSE-KILOCODE-MIT.txt`
- blob:`3449a9b099635eafd952b2b9a39cc11d0508e467`

### `kilocode-theme.json`
- Repository: `Kilo-Org/kilocode`
- Path: `packages/tui/src/theme/assets/kilo.json`
- Pinned: `64e5dd03633013b4564d0ac759747d606f74522c`
- URL: https://raw.githubusercontent.com/Kilo-Org/kilocode/64e5dd03633013b4564d0ac759747d606f74522c/packages/tui/src/theme/assets/kilo.json
- SPDX-License-Identifier: MIT — Copyright (c) 2026 Kilo Code; Copyright (c) 2025 opencode
- Licence text: `LICENSE-KILOCODE-MIT.txt`
- blob:`73323a16fc356bef4be9d4eabb758d225e7479e5`

### `LICENSE-KILOCODE-MIT.txt`
- Repository: `Kilo-Org/kilocode`
- Path: `LICENSE`
- Pinned: `64e5dd03633013b4564d0ac759747d606f74522c`
- URL: https://raw.githubusercontent.com/Kilo-Org/kilocode/64e5dd03633013b4564d0ac759747d606f74522c/LICENSE
- SPDX-License-Identifier: MIT — Copyright (c) 2026 Kilo Code; Copyright (c) 2025 opencode
- Licence text: `LICENSE-KILOCODE-MIT.txt` (this file)
- blob:`c5762eb3ad5a0e1788ef155772fe3c240ab23e42`

## Apache-2.0 sources

Apache-2.0 requires the licence text to travel with the copy. Both full texts
are vendored beside the source.

### `k9s-view-table.go`
- Repository: `derailed/k9s`
- Path: `internal/view/table.go`
- Pinned: `v0.51.0` = `558caafe7ba067467de46b320cc22ef11fef9c34`
- URL: https://github.com/derailed/k9s/blob/558caafe7ba067467de46b320cc22ef11fef9c34/internal/view/table.go
- SPDX-License-Identifier: Apache-2.0 — `// Copyright Authors of K9s`
- Licence text: `LICENSE-K9S-APACHE-2.0.txt`
- blob:`62404edde0b73965d867fedb2bfeb15e9aee3c9d`
- The only vendored file here that carries its own SPDX header inline.

### `trivy-report-table.go`
- Repository: `aquasecurity/trivy`
- Path: `pkg/report/table/table.go`
- Pinned: `v0.73.0` = `40c73e5d6166dcc0346a1ab4e94499d1572854e4`
- URL: https://github.com/aquasecurity/trivy/blob/40c73e5d6166dcc0346a1ab4e94499d1572854e4/pkg/report/table/table.go
- SPDX-License-Identifier: Apache-2.0 — Copyright Aqua Security Software Ltd.
- Licence text: `LICENSE-TRIVY-APACHE-2.0.txt`
- blob:`f0f81b44dce23d84b19c5d4b700f39836fbb9992`
- No SPDX header in the file; Apache-2.0 is the repository's, confirmed by fetch.

---

## Licence compatibility

This repository is MIT. MIT and Apache-2.0 are both permissive and both may be
copied into it, provided attribution is preserved — that is what this file is.
No copyleft source (GPL, AGPL, LGPL, SUL-1.0) is vendored here, and none may be.

`open-policy-agent/conftest` was considered for the verdict-rendering citation
and **rejected on licence grounds**: GitHub reports its licence as
`NOASSERTION`, meaning no machine-readable licence could be resolved. Copying an
unresolved licence into an MIT tree is precisely the risk this file exists to
prevent. `aquasecurity/trivy` was cited instead.

## MIT licence text

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
