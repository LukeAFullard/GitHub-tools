# GitHub-tools: Implementation Plan

Roadmap for the Code and Issues explorers and the two proposed new tabs. Each item was checked
against the code (and, where it relies on outside services, against those services) before it
went into this plan. Corrections to the original proposal are noted inline.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Bug fixes and polish (Code + Issues explorers) | Done |
| 2 | Local `.zip` archives in the Code Explorer | Done |
| 3 | Discussions Explorer tab (`discussions.html`) | Done |
| 4 | Dependencies & licences tab (`deps.html`), slimmed down | Done |

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

## Phase 3: Discussions Explorer (done)

Checked against GitHub's published API description and GraphQL schema: there is **no
documented REST API** for repository discussions (the REST paths respond but are absent from
GitHub's API description). GraphQL is the official route and always needs a token.

- [x] `js/github-discussions-api.js`
  - With a token: GraphQL. Lists 100 discussions per request; fetches comment threads (replies,
    accepted answer, hidden comments dropped) for 10 discussions per request, paging long
    threads. Queries validated against GitHub's published schema.
  - Without a token: the undocumented REST endpoints, read using the `discussion` schema GitHub
    publishes for webhooks; replies grouped by `parent_id`, the answer matched from
    `answer_html_url`. The page says so and recommends a token.
  - Clear errors for Discussions turned off (410 / `hasDiscussionsEnabled: false`), not found,
    rate limits and a missing token.
- [x] `discussions.html` + `js/discussions-app.js`: the Issues Explorer controller runs in a
      discussions mode instead of a second copy of it. Category filter and clickable category
      pills, answered / unanswered filter, upvotes, "answered" badge, comment scopes
      `Question only` / `Answer` / `Answer + maintainers` / `Full thread`, settings saved under
      `cfg_discussions_*`.
- [x] Formatters: `kind: 'discussions'` gives discussion wording plus category, answered,
      upvotes, `accepted_answer` and `reply_to` markers in all four formats. Issue output is
      unchanged.
- [x] "Discussions" tab on every page (`js/nav.js`).
- [x] Tests: `tests/discussions.test.js` (API client, scopes, formatters) and
      `tests/e2e/discussions-flow.test.mjs` (GraphQL and REST flows) against a fake GitHub.
- [ ] Not verified against live GitHub data: this environment could not call the GitHub API
      for other repositories. Try it on a public repo with Discussions (e.g. `whitphx/stlite`),
      with and without a token.

## Phase 4: Dependencies & licences (`deps.html`) (done)

The original proposal was a full licence-compatibility auditor. Problems found, and how the
built version handles them:

- "Conflict" verdicts are legal judgements that depend on how a package is used (linking,
  distribution, hosted service). **Built:** packages are grouped for review (permissive / weak
  copyleft / strong copyleft / restricted / unknown) with "review" wording and a not-legal-advice
  note in the page and in every output; no "compatible" or "conflict" verdicts.
- Classification errors in the proposal. **Built:** SSPL, BUSL, Elastic, PolyForm and
  CC-BY-NC/ND are "restricted"; EUPL is strong copyleft; `-only` / `-or-later` are recognised
  (and noted); linking exceptions such as Classpath move GPL to weak copyleft; `AND` takes the
  strictest part, `OR` the easiest known option.
- GitHub's SBOM endpoint. **Not used:** its synchronous export closes on 13 November 2026, and the
  replacement is an asynchronous job that redirects to a temporary download URL, which could not
  be tested from here. Its licence data is also often `NOASSERTION`.
- Reading `pyproject.toml` / `Cargo.toml` needs a TOML parser. **Built:** narrow line-based
  readers for the dependency sections only (PEP 621, Poetry, Cargo tables), no library.
- `api.deps.dev` allows browser requests. **Built:** it supplies licences, known security
  advisories and transitive dependency graphs (npm, PyPI, Cargo). Its stable v3 GET endpoints
  are used; the experimental batch endpoint is not (its CORS preflight fails for JSON POSTs).

What was built:

- [x] `js/manifest-parsers.js`: package.json, requirements*.txt, pyproject.toml, go.mod,
      Cargo.toml; skips vendored, hidden and (optionally) example/test/docs folders, local and VCS
      dependencies, and the repository's own workspace packages.
- [x] `js/license-classify.js`: SPDX expression parser and grouping, LICENSE-file detection for
      `.zip` sources.
- [x] `js/deps-api.js`: GitHub repo licence, tree and manifests, or a local `.zip`; deps.dev
      lookups with caching, retries, a concurrency limit and a 1,500-package cap. Ranges are checked
      at their lowest version (or the latest release when unpinned), and the output says so.
- [x] `deps.html` + `js/deps-app.js`: group pills, ecosystem / direct-transitive / advisories
      filters, dev and transitive toggles, target bar, instruction presets (review licences,
      attribution file, alternatives, advisories). The output contains the packages shown.
- [x] `js/deps-formatters.js`: report in the four formats, most-attention groups first;
      permissive packages can be listed one per line to save tokens.
- [x] "Dependencies" tab on every page; the header now fits four tabs on phones.
- [x] Tests: `tests/deps.test.js` and `tests/e2e/deps-flow.test.mjs`; checked live against
      deps.dev in a browser.

Possible follow-ups:

- [ ] Lockfiles (`package-lock.json`, `poetry.lock`, `Cargo.lock`) for exact installed versions.
- [ ] More ecosystems deps.dev supports (Maven, NuGet, RubyGems).

---

## Phase 5: Links, your own topic, landing page (done)

- [x] Links out: issue and discussion rows ("#123 ↗"), files in the code tree (GitHub blob URL;
      none for local .zip), packages (registry page, deps.dev, advisories on GitHub or OSV). Built
      in `js/links.js`: fixed https hosts, every data-derived path segment encoded, branch names
      validated; links open in a new tab with `noopener noreferrer`.
- [x] Your own topic (`js/topic-search.js`): every word must appear (word variants count, matched
      at word starts), "quoted phrases" exactly; plus related threads by TF-IDF cosine similarity to
      the centroid of the direct matches (threshold 0.18, at most 50), marked "related" in the list.
- [x] Landing page `index.html` in TimeDoco's palette and type; the Code tool moved to
      `code.html` and old `index.html?repo=` links are forwarded. Screenshots in `assets/` use a
      fictional `example/webapp` repo. `_headers`, `robots.txt`, `sitemap.xml`, `favicon.svg`, and
      `scripts/build-site.mjs` (copies the site into `dist/`).

### Hosting recommendation: `gitdoco.timedoco.com`

A subdomain, deployed as its own Cloudflare Pages project from this repository, rather than
`timedoco.com/gitdoco`:

- **Isolation.** A path on timedoco.com shares the origin with TimeDoco's app, so GitDoco (which
  renders third-party repository content) would share localStorage/IndexedDB with users'
  timesheets. A subdomain is a separate origin.
- **Headers.** TimeDoco's `_headers` CSP (`connect-src 'self' https://cloudflareinsights.com`)
  would block GitHub and deps.dev; a path would need per-path overrides in TimeDoco's repo.
- **Deploys.** The two sites ship independently, with no changes to TimeDoco's Vite build.

Steps: Cloudflare Pages → Create project → connect this repo → build command
`node scripts/build-site.mjs`, output `dist` → Custom domains → `gitdoco.timedoco.com` (Cloudflare
adds the CNAME when timedoco.com is on Cloudflare DNS). Optionally link to it from TimeDoco's
footer or nav.

### Open decisions

- [ ] Name and address: "GitDoco" at `gitdoco.timedoco.com` are used in the page, canonical URL,
      sitemap and social image; change them in `index.html`, `robots.txt` and `sitemap.xml` if
      different.
- [ ] Add a `LICENSE` file: `package.json` and the README say MIT but the repo has no license file.
- [ ] Analytics: TimeDoco's marketing pages use Cloudflare Web Analytics; none is added here (the
      CSP would need `static.cloudflareinsights.com`).

