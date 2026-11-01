# GitDoco: Code, Issues, Discussions & Dependencies for your AI

A zero-install, 100% client-side web application that fetches, filters, cleans, and formats source code and issue threads from any public or private GitHub repository into an LLM-ready context file (Claude XML, Markdown, Generic XML, or JSON).

## Features

- **100% Client-Side Privacy:** Direct browser-to-GitHub API connection. Personal Access Tokens (PATs) and fine-grained PATs (`github_pat_`) remain strictly in memory.
- **Local `.zip` Archives (no token needed):** Click **Open .zip** or drop a repository `.zip` (e.g. GitHub's "Download ZIP") anywhere on the Code page. The archive is read in your browser and never uploaded: only its file list is read up front, and each selected file is unzipped on demand. Supports Deflate and Store compression and ZIP64 (very large archives); password-protected archives are not supported.
- **Landing page** (`index.html`) with a quick start; the Code tool is `code.html` (old `index.html?repo=...` links are forwarded).
- **Links out:** every issue and discussion row links to the thread on GitHub, every file in the code tree to the file on GitHub, and every package to its registry page (npm, PyPI, pkg.go.dev, crates.io), its deps.dev page and its security advisories.
- **Your own topic:** in Issues and Discussions, type a topic (words or an exact "phrase") to filter to the threads that mention it, plus related threads that discuss the same thing in other words (TF-IDF similarity). Related ones are marked.
- **Four Tools:** Switch between **Code Packer** (source tree packaging), **Issues Explorer** (issue thread triage & context packaging), **Discussions Explorer** (GitHub Discussions Q&A and ideas) and **Dependencies** (dependency licenses and advisories).
- **Dependencies:** Reads `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod` and `Cargo.toml` from a GitHub repo or a local `.zip`, looks up each package's license, known security advisories and (for npm, PyPI and Cargo) transitive dependencies on [deps.dev](https://deps.dev), and groups licenses for review: permissive, weak copyleft, strong copyleft, restricted (source-available or non-commercial) and unknown. The groups are a guide for review, not legal advice. Package names and versions are sent to deps.dev; nothing else is.
- **Discussions Explorer:** Filter by category and by answered / unanswered questions, then pack the question only, the accepted answer only, the answer plus the author's and maintainers' replies, or the full thread. Accepted answers and threaded replies are marked in every output format.
  - **With a token** it uses GitHub's official GraphQL API (about 10 discussion threads per request). For public repos a token with no permissions is enough.
  - **Without a token** it falls back to GitHub's REST discussions endpoints. These are not in GitHub's published API documentation, so they may change without notice.
- **Interactive File Selection & Issue Filtering:**
  - **Code Packer:** Interactive directory tree to select or deselect files and folders before fetching contents.
  - **Issues Explorer:** Multi-dimensional filters (state, labels, dates, comment counts, search, and cross-referenced `#refs`).
- **NLP Topic Clustering & N-Grams:** Client-side Web Worker powered TF-IDF cosine K-Means topic clustering and bigram/trigram phrase extraction for issues triage.
- **Noise Cleanup & Sanitization:** Automatically strips bot comments, low-signal replies ("+1", "me too"), images/base64 attachments, template boilerplate, and truncates massive log traces.
- **Context Chunking & Token Splitting:** Automatically splits large output context bundles into sequential multi-part chunks when exceeding a specified token limit (e.g. 100k tokens).
- **Background Web Worker Tokenization:** Offloads BPE token estimation to a Web Worker thread for seamless background processing.
- **Code Minification & Whitespace Stripping:** Optional code minification (Basic: whitespace & blank line cleanup; Aggressive: language-aware comment removal and full blank-line stripping) to maximize token efficiency.
- **Token Estimation:** BPE regex-based heuristic estimator matching Tiktoken / Claude token densities for immediate size feedback.
- **Multiple Output Formats:**
  - **Claude XML (`<documents>`)**: Optimized for Claude prompts.
  - **Markdown**: Standard Markdown code blocks.
  - **Generic XML**: Clean XML representation.
  - **JSON**: Structured JSON output.
- **API Limits & Pacing:** Uses the GitHub Git Trees API (recursive) to minimize rate consumption, respecting secondary rate limits with automatic `Retry-After` handling.
- **Zero Build Dependencies:** Built with vanilla HTML/CSS and native ES Modules. No bundlers or npm packages needed.

## Output Formats

| Format | Description | Extension |
| --- | --- | --- |
| **Claude XML** | Wrapped in `<documents>` and `<document>` tags with global repository metadata | `.xml` |
| **Markdown** | Structured Markdown header with code fences per file | `.md` |
| **Generic XML** | Minimalist XML structure with CDATA file wrappers | `.xml` |
| **JSON** | Machine-readable object with repo info, file tree, and content array | `.json` |

## Getting Started

### Local Development

Because modern web browsers enforce CORS restrictions on ES Modules over the `file://` protocol, serve the directory using any static HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js
npx serve .
```

Navigate to `http://localhost:8000` in your web browser.

### GitHub Pages Deployment

1. Push the repository to GitHub.
2. Go to **Settings** -> **Pages**.
3. Set source to **Deploy from a branch** and select `main` (root).

## Deploying

The site is static: no build step is needed to run it. To publish only the site files (not tests or tooling), run `npm run build` and serve `dist/`. On Cloudflare Pages: build command `node scripts/build-site.mjs`, output directory `dist`, no framework preset; `_headers` sets the security headers. The suggested address is `gitdoco.timedoco.com` (see `PLAN.md`).

## Security & Privacy

- **Repository content is untrusted input to your AI.** Code, issues, discussions and package metadata can contain text written to steer an AI (prompt injection). Review the output before sending it, especially for private or sensitive work.
- **Secrets:** known token and key formats are hidden by default; generic passwords and tokens in code are flagged, and hidden only with "Strict". Files such as `.env`, private keys, key stores, `.npmrc`/`.netrc` and Terraform state are replaced entirely.
- **Tokens** stay in memory and are only sent to `api.github.com`. Repository names loaded with a token are not remembered between visits.
- **Dependencies tab:** package names and versions (including a private repo's internal packages) are sent to deps.dev to look up licenses.
- **Content-Security-Policy:** every page sets a CSP that allows scripts only from the site itself and network requests only to GitHub and deps.dev. A `<meta>` tag cannot set everything, so if your host supports response headers, also send:

  ```
  Content-Security-Policy: frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  ```

## Repository Structure

```
.
├── index.html          # Landing page
├── code.html           # Code Packer Web interface
├── _headers            # Security headers for Cloudflare Pages / Netlify
├── scripts/build-site.mjs # Copies the public site into dist/ (no dependencies)
├── issues.html         # GitHub Issues Explorer Web interface
├── discussions.html    # GitHub Discussions Explorer Web interface
├── deps.html           # Dependencies & licenses Web interface
├── css/
│   ├── issues.css      # Issues explorer & mode switcher UI styling
│   └── style.css       # Clean, modern UI styling
└── js/
    ├── app.js          # Core Code Packer controller and UI event wiring
    ├── config.js       # Global constants, default ignore lists, API endpoints
    ├── formatters.js   # Code LLM context output formatters (XML, MD, JSON)
    ├── github-api.js   # GitHub API fetch logic & rate-limit handling
    ├── deps-api.js     # Manifests from GitHub or .zip, deps.dev license/advisory/graph lookups
    ├── deps-app.js     # Controller for deps.html
    ├── deps-formatters.js # Dependency license report formatters (XML, MD, JSON)
    ├── discussions-app.js # Entry for discussions.html (runs issues-app.js in discussions mode)
    ├── github-discussions-api.js # Discussions client: GraphQL with a token, REST fallback without
    ├── github-issues-api.js # GitHub Issues & comments API client
    ├── issue-cleaner.js # Issue sanitization, bot filtering, log truncation engine
    ├── issue-formatters.js # Issue LLM context output formatters & chunking
    ├── issues-app.js   # Controller for issues.html and discussions.html
    ├── landing.js      # Landing page quick start and old-link forwarding
    ├── license-classify.js # SPDX expression parsing and license grouping
    ├── links.js        # Safe outbound links (GitHub, registries, deps.dev, advisories)
    ├── nlp-text.js     # Shared text tokenizing for topics and topic search
    ├── manifest-parsers.js # package.json, requirements, pyproject, go.mod, Cargo.toml readers
    ├── minifier.js     # Code minification & comment stripping engine
    ├── nlp.worker.js   # Web Worker for N-grams & TF-IDF Cosine K-Means clustering
    ├── secrets.js      # Client-side secret scanning and redaction engine
    ├── tokenizer.js    # BPE regex token estimator
    ├── tokenizer.worker.js # Web Worker background tokenization
    ├── topic-search.js # "Your own topic" search: direct matches plus related threads
    ├── tree.js         # File tree rendering & selection state management
    └── zip-loader.js   # Local .zip reader (central directory + on-demand Deflate)
```

## License

MIT
