# GitHub-tools: Implementation Plan

Roadmap for the Code and Issues explorers and the two proposed new tabs. Each item was checked
against the code (and, where it relies on outside services, against those services) before it
went into this plan. Corrections to the original proposal are noted inline.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Bug fixes and polish (Code + Issues explorers) | Done |
| 2 | Local `.zip` archives in the Code Explorer | Done |
| 3 | Discussions Explorer tab (`discussions.html`) | Next |
| 4 | Dependencies & licences tab (`deps.html`), slimmed down | Later |

Phases 3 and 4 are swapped from the original proposal: Discussions reuses most of the Issues
Explorer and fits the app's purpose (packing content for an AI); the licence auditor is larger,
riskier and further from that purpose.

---

## Phase 1: Bug fixes and polish (done)

- [x] Copy button keeps its target label ("Copy for Claude" etc.) after build, part changes and
      the "Copied!" reset, in both apps. Done through `updateCopyBtnLabel()`;
      `copyLabel()` in `js/ui-labels.js` is no longer used by the apps.
- [x] Issues budget meter judges split builds by the largest part and shows a pre-build estimate
      while selecting. The Code Explorer's big token number now also tracks the pre-build estimate.
- [x] Issues settings persist in `localStorage`; `?format`, `?commentScope` and `?includePrs`
      are read on load and written by "Share link". Redaction, comment scope and instructions use
      `cfg_issues_*` keys because the Issues page defaults to aggressive redaction.
- [x] Instruction edits and budget presets keep "Export NLP overview" mode.
- [x] `chunkIssuesOutput` no longer counts instructions against part 1.
- [x] Issues secret scan covers titles and labels, scans only included comments, skips
      overview-only exports and reports the location (`title`, `body L12`, `comment 3 L2`).
- [x] Loading a repo clears the previous output; "Select linked" follows `#refs` in comments.
- [x] Date filter uses local dates; "Recently updated" sort added. (Sorting newest/oldest by issue
      number was not a bug: GitHub assigns numbers in creation order.)
- [x] Wrap button starts in its "on" state in both apps (the preview starts wrapped).
- [x] Issue rows: `PR` tag and `MERGED` badge, `#number` links to GitHub, label pills filter by
      label, per-issue token estimate, "Deselect hidden" button, `/` focuses search.
- [ ] Not done: expandable issue-body preview in the list (larger UI change; optional).

## Phase 2: Local `.zip` archives in the Code Explorer (done)

- [x] `js/zip-loader.js`: zero-dependency reader.
  - Reads only the end of the file and the central directory up front (`File.slice`), then one
    entry at a time on demand. (The original proposal read the whole archive into memory.)
  - Store (method 0) and Deflate (method 8, `DecompressionStream('deflate-raw')`).
  - ZIP64 supported (archives over 4 GB or with more than 65,535 entries) rather than rejected.
  - Strips one shared top-level folder and macOS `__MACOSX/` metadata; marks symlinks so the
    existing filter drops them.
  - Clear `ZipError` messages for non-zip, truncated and password-protected files.
  - Output capped at each entry's declared size, so a malformed entry cannot expand without limit.
  - No repo/branch guessing from the file name (that split `my-repo.zip` into repo `my`,
    branch `repo`); the archive is named by its root folder or file name.
- [x] "Open .zip" button and drop-anywhere support in `index.html`; the source note says the
      file is read locally. The repo box, share link and Issues tab link are left untouched, so
      they never point at a made-up `local/<repo>` GitHub repo.
- [x] `js/app.js`: one `loadSource(zipArchive)` pipeline for GitHub and zip; zip reads skip the
      network and request throttling. Secret scanning, redaction, minifying, chunking and the
      budget meter are unchanged.
- [x] Output names a zip by archive (`<repository>my-repo-main</repository>`,
      `<source>local archive my-repo-main.zip</source>`) with no branch or GitHub URL.
- [x] Tests: `tests/zip-loader.test.js` builds zips in memory and covers parsing, root stripping,
      symlinks, `__MACOSX`, errors, the expansion cap, redaction and formatter output.

## Phase 3: Discussions Explorer (`discussions.html`, `js/discussions-app.js`)

Checked: GitHub has a REST endpoint for repository discussions (a request for a repo with
Discussions off returns `410 Discussions are disabled for this repo` and links to
"List discussions for repository"). GitHub's GraphQL API always needs a token.

- [ ] `js/github-discussions-api.js`
  - REST (no token): list discussions and per-discussion comments, with the same paging,
    rate-limit and `Retry-After` handling as `js/github-issues-api.js`.
  - GraphQL (token only): discussions with category, upvotes, `isAnswered`, the accepted answer
    and first comments in one query. Fall back to REST on any GraphQL error.
  - Handle `410` (Discussions disabled) with a clear message.
- [ ] `js/nav.js` and the `.page-tabs` header in every page: add `'discussions'`.
- [ ] UI reusing the Issues Explorer: category filter, answered / unanswered filter, comment
      scope (`All`, `Accepted answer only`, `Accepted answer + maintainers`, `Question only`).
- [ ] Reuse `js/nlp.worker.js`, `js/issue-cleaner.js` and `js/secrets.js`; add discussion
      formatters (accepted answer marked) in the four output formats.
- [ ] Tests: fake-GitHub E2E flow like `tests/e2e/issues-flow.test.mjs`.

## Phase 4: Dependencies & licences (`deps.html`), slimmed down

The original proposal was a full licence-compatibility auditor. Problems found:

- "Conflict" verdicts are legal judgements that depend on how a package is used (linking,
  distribution, hosted service). The tool should flag packages for review, not issue verdicts.
- Classification errors: SSPL-1.0 is not OSI-approved and belongs under "restricted";
  EUPL-1.2 has explicit compatibility terms; `GPL-2.0-only` and `GPL-2.0-or-later` must be
  distinguished.
- GitHub's SBOM endpoint (`/dependency-graph/sbom`) needs the dependency graph enabled and
  often reports licences as `NOASSERTION`.
- Reading `pyproject.toml` / `Cargo.toml` needs a TOML parser, against the no-dependencies rule.
- `api.deps.dev` does allow browser requests (`access-control-allow-origin: *`), so it is a
  viable source of licences and transitive dependencies.

Proposed scope:

- [ ] Gather the dependency list: GitHub SBOM first; fall back to `package.json`,
      `requirements.txt` and `go.mod` (no TOML at first) plus deps.dev for licences.
      Works for `.zip` sources through the manifest files.
- [ ] Show packages with ecosystem, version, direct/transitive and SPDX licence; group licences
      as permissive / weak copyleft / strong copyleft / restricted or unknown, worded as
      "review", never "compatible" or "conflict".
- [ ] Pack the list (with the host repo's licence) as AI context in the four formats, with
      instruction presets: attribution file (`THIRD_PARTY_LICENSES.md`), review unknown licences,
      suggest permissive alternatives.
