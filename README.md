# GitHub Repo Context Packer

A zero-install, 100% client-side web application that fetches, filters, and formats source code from any public or private GitHub repository into an LLM-ready context file (Claude XML, Markdown, Generic XML, or JSON).

## Features

- **100% Client-Side Privacy:** Direct browser-to-GitHub API connection. Personal Access Tokens (PATs) and fine-grained PATs (`github_pat_`) remain strictly in memory.
- **Interactive File Selection:** Renders an interactive pre-download directory tree to select or deselect files and folders before fetching contents.
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

## Repository Structure

```
.
├── index.html          # Web interface
├── css/
│   └── style.css       # Clean, modern UI styling
└── js/
    ├── app.js          # Core application controller and UI event wiring
    ├── config.js       # Global constants, default ignore lists, API endpoints
    ├── formatters.js   # LLM context output formatters (XML, MD, JSON)
    ├── github-api.js   # GitHub API fetch logic & rate-limit handling
    ├── minifier.js     # Code minification & comment stripping engine
    ├── secrets.js      # Client-side secret scanning and redaction engine
    ├── tokenizer.js    # BPE regex token estimator
    ├── tokenizer.worker.js # Web Worker background tokenization
    └── tree.js         # File tree rendering & selection state management
```

## License

MIT
