# InterviewOps SDK

`InterviewOps SDK` is a standalone Node.js package for running an interview-note collection pipeline on top of:

- `opencli` for Xiaohongshu collection
- `oh-my-codex` / `omx` for stable Codex-side orchestration

It is designed for the workflow you built earlier in `opencli`, but split into a dedicated SDK repository with:

- reusable domain types
- OpenCLI adapters
- OMX stabilization wrapper
- a nightly interview collection pipeline
- seller / lead-gen note marking
- JSON + HTML exports

Current release:

- `v0.1.0`
- Git tag: [`v0.1.0`](https://github.com/jerry609/InterviewOps-SDK/releases/tag/v0.1.0)

## What It Does

For Xiaohongshu interview notes, the SDK can:

1. incrementally search notes by query
2. hydrate note detail content
3. enrich comments
4. extract interview questions
5. mark likely seller / lead-gen accounts or notes
6. export:
   - `xhs_notes.json`
   - `xhs_questions.json` (loose / compatibility)
   - `xhs_questions_strict.json` (default reporting set)
   - topic buckets
   - company / round summary
   - filterable HTML overview
7. optionally auto-commit each cycle

## Install

```bash
git clone https://github.com/jerry609/InterviewOps-SDK.git
cd InterviewOps-SDK
npm install
npm run build
```

Quick sanity checks:

```bash
npm run typecheck
npm test
npm run build
```

External prerequisites:

- Node.js 20+
- `opencli`
- `omx`
- Chrome logged into `xiaohongshu.com`

Package notes:

- The published SDK is `ESM-only`
- The primary supported surface is the bundled CLI plus ESM imports
- TypeScript consumers should use a Node runtime config (`moduleResolution: "Node16"` or `"NodeNext"`)

## CLI

After build:

```bash
node dist/cli.js --help
```

Main commands:

```bash
npm run dev -- init
npm run dev -- template
npm run dev -- sources
npm run dev -- seed-import --source-notes /path/to/xhs_notes.json
npm run dev -- harvest
npm run dev -- hydrate --limit 12
npm run dev -- comments --limit 8
npm run dev -- normalize
npm run dev -- questions
npm run dev -- overview
npm run dev -- status
npm run dev -- doctor
npm run dev -- export
npm run dev -- seller-summary
npm run dev -- ralph "analyze the current dataset"
npm run dev -- ralph-loop 6 --workspace ./workspaces/xhs-agent-algo-feb2026
node dist/cli.js stats
node dist/cli.js template
node dist/cli.js doctor
node dist/cli.js export
node dist/cli.js seller-summary
node dist/cli.js cycle
node dist/cli.js nightly 8
node dist/cli.js ralph-loop 6 --workspace ./workspaces/xhs-agent-algo-feb2026
node dist/cli.js validate
node dist/cli.js omx-safe doctor
```

During development:

```bash
npm run dev -- init
npm run dev -- harvest
npm run dev -- hydrate --limit 12
npm run dev -- comments --limit 8
npm run dev -- normalize
npm run dev -- questions
npm run dev -- overview
npm run dev -- status
npm run dev -- doctor
npm run dev -- stats
npm run dev -- export
npm run dev -- seller-summary
npm run dev -- cycle
npm run dev -- nightly 8
npm run dev -- omx-safe doctor
```

Command notes:

- `template`: copies the bundled LaTeX interview template into the workspace
- `sources`: lists currently built-in source adapters
- `seed-import`: imports scoped seed notes from an existing `xhs_notes.json` into the target workspace
- `harvest`: runs incremental search only
- `hydrate`: fills note detail content only
- `comments`: enriches comments only
- `normalize`: refreshes question extraction and seller flags only
- `questions`: rebuilds both loose and strict `xhs_questions*.json` outputs
- `overview`: rebuilds strict overview HTML/summary plus seller reports
- `status`: shows current stats plus last recorded stage runs
- `doctor`: verifies `node`, `opencli`, `omx`, config path, data dir, and report dir
- `export`: rebuilds question/topic/overview/seller outputs from existing note data
- `seller-summary`: refreshes seller-tagged reports from current note data
- `ralph`: shortcut for `omx-safe exec --full-auto '$ralph "..."'`
- `ralph-loop`: repeatedly runs bounded Ralph collection cycles for a dedicated workspace

## Control Plane

The control plane is the typed orchestration layer that OMX/Codex reads before deciding the next action.

`control-status` prints the current typed orchestration snapshot:

```bash
npm run dev -- control-status --workspace ./workspaces/xhs-agent-algo-feb2026
```

`run-operation` executes exactly one typed operation and persists the result in workspace state and `operation_journal.jsonl`:

```bash
npm run dev -- run-operation hydrate --workspace ./workspaces/xhs-agent-algo-feb2026 --limit 12 --reason "pending_hydrate backlog dominates current cycle"
```

`ralph-loop` now uses `control-status` plus `run-operation` internally instead of a fixed stage sequence.

## OpenCLI Integration

By default the SDK calls:

```bash
opencli xiaohongshu search ...
opencli xiaohongshu note-detail ...
opencli xiaohongshu comments ...
```

If your working `opencli` is a local checkout instead of a globally installed binary, you can point the SDK at it:

```bash
export INTERVIEWOPS_OPENCLI_BINARY=npm
export INTERVIEWOPS_OPENCLI_ARGS_JSON='["-C","/path/to/opencli","run","dev","--"]'
```

That makes the SDK run commands like:

```bash
npm -C /path/to/opencli run dev -- xiaohongshu search ...
```

If live XHS search is unstable, you can seed a dedicated workspace from an
existing notes library first:

```bash
npm run dev -- seed-import \
  --workspace ./workspaces/xhs-agent-algo-feb2026 \
  --source-notes /home/master1/opencli/interview_data/xhs_notes.json
```

## OMX Stabilization

`omx-safe` wraps `omx` with a stable policy:

- removes common proxy environment variables
- forces `USE_OMX_EXPLORE_CMD=0`
- creates `.omx/state` automatically

Example:

```bash
npm run dev -- omx-safe doctor
```

## Default Layout

The SDK writes into the current workspace:

```text
interview_data/
  xhs_notes.json
  xhs_questions.json
  xhs_questions_strict.json
  xhs_questions_nlp.json
  xhs_questions_nlp_strict.json
  xhs_questions_backend.json
  xhs_questions_backend_strict.json
  xhs_questions_algo.json
  xhs_questions_algo_strict.json
  company_round_summary.json
reports/xhs-miangjing/
  index.html
  status.json
  run_history.jsonl
  xhs_questions_nlp.html
  xhs_questions_backend.html
  xhs_questions_algo.html
  seller_candidates.json
  author_seller_summary.json
  seller_summary.md
  progress.log
templates/
  interview-note-template.tex
  interview-note-template.pdf
```

Default reporting behavior:

- `xhs_questions.json` and `xhs_questions_{topic}.json` stay as loose compatibility exports
- `xhs_questions_strict.json` and `xhs_questions_{topic}_strict.json` are the cleaned question-bank exports
- `index.html`, topic HTML files, and `company_round_summary.json` default to the strict set

## Workspace Init

Create a local config and output directories in the current workspace:

```bash
npm run dev -- init
```

That writes:

```text
./interviewops.xhs.json
./interview_data/
./reports/xhs-miangjing/
```

You can also initialize another workspace:

```bash
npm run dev -- init --workspace /data/interviewops
```

## Example PRD

See:

- [`examples/xhs-miangjing.prd.json`](./examples/xhs-miangjing.prd.json)

By default the CLI uses:

1. `./interviewops.xhs.json` if it exists in the target workspace
2. otherwise the packaged example file

You can override it explicitly:

```bash
npm run dev -- cycle --prd ./examples/xhs-miangjing.prd.json
```

The PRD now includes:

- `source`
- query list
- `sellerWhitelist`
- data/report/state paths
- search/detail/comment batch and timeout policy
- harvest/sleep cadence

## Seller / Lead-Gen Marking

The SDK does **not** drop seller-team notes.  
It keeps them and marks them with:

- `seller_flag`
- `seller_tags`
- `seller_confidence`

These fields are propagated into:

- `xhs_notes.json`
- `xhs_questions.json`
- topic exports
- overview HTML
- `seller_candidates.json`
- `author_seller_summary.json`
- `seller_summary.md`

Whitelist config example:

```json
{
  "sellerWhitelist": {
    "authors": ["可信作者A"],
    "note_ids": ["69c9d37b0000000023007921"],
    "title_keywords": ["内部分享"],
    "urls": ["example.com/trusted"]
  }
}
```

Whitelisted notes keep raw seller tags/confidence for debugging, but:

- `seller_flag` will be forced to `false`
- `seller_whitelisted` will be `true`
- `seller_whitelist_reason` records the match source

## Purchase Link Detection

The SDK also marks notes that appear to contain purchase links.

Current outputs include:

- `purchase_link_flag`
- `purchase_links`
- `purchase_link_tags`
- `purchase_link_confidence`

Detection combines:

- explicit commerce URLs
- purchase-link phrases
- e-commerce platform mentions

These fields are surfaced in:

- note JSON
- question JSON
- topic HTML
- overview HTML
- seller summary markdown

## Source Adapters

Current built-in adapters:

- `xiaohongshu`

The pipeline now resolves a source adapter from config:

```json
{
  "source": "xiaohongshu"
}
```

That keeps the CLI stable while making it possible to add more sources later
without rewriting pipeline orchestration.

## Dedicated Agent / LLM Algorithm Workspace

Bundled workspace:

- [`workspaces/xhs-agent-algo-feb2026/interviewops.xhs.json`](./workspaces/xhs-agent-algo-feb2026/interviewops.xhs.json)
- [`workspaces/xhs-agent-algo-feb2026/README.md`](./workspaces/xhs-agent-algo-feb2026/README.md)

This workspace is scoped to:

- Xiaohongshu
- `2026-02-01` onward
- internet major companies
- `Agent / 智能体 / LLM / 大模型应用开发`
- `算法岗 / NLP / 大模型算法`

Run the dedicated Ralph loop:

```bash
npm run dev -- ralph-loop 6 --workspace ./workspaces/xhs-agent-algo-feb2026
```

What this dedicated loop is meant to collect:

- Xiaohongshu notes only
- internet major companies
- `Agent / 智能体 / LLM / 大模型应用开发`
- `算法岗 / NLP / 大模型算法`
- interview-note style content

It now uses a two-step strategy:

1. broad Xiaohongshu search queries
2. local `scopeFilter` narrowing to the exact `Agent/LLM + 算法岗 + 大厂 + 2026-02-01+` slice

This is intentional because overly narrow XHS queries like
`腾讯 agent 算法 面经` were timing out in practice.

Each `ralph-loop` cycle now reads `control-status`, selects one operation, and dispatches it through `run-operation` rather than stepping through a fixed stage list.

Primary broad query family includes:

- `腾讯 面经`
- `字节 面经`
- `阿里 面经`
- `美团 面经`
- `百度 面经`
- `京东 面经`
- `快手 面经`
- `LLM 算法 面经`
- `LLM 面经`
- `智能体 面经`
- `Agent 面经`
- `算法 面经`
- `NLP 面经`

Persisted outputs land in that workspace:

- `interview_data/xhs_notes.json`
- `interview_data/xhs_questions.json`
- `reports/xhs-agent-algo-feb2026/`

Curated filtered outputs land here:

- `reports/xhs-agent-algo-feb2026/scope_candidates.json`
- `reports/xhs-agent-algo-feb2026/scope_candidates.md`

If live search keeps timing out, recommended flow is:

1. `seed-import` from an existing `xhs_notes.json`
2. `export`
3. `status`
4. resume `ralph-loop` only after `opencli xiaohongshu search` is stable again

Recommended ways to monitor it:

```bash
tmux attach -t interviewops-agent-llm-algo
```

```bash
sed -n '1,120p' /tmp/interviewops/agent-llm-algo-loop.log
sed -n '1,120p' ./workspaces/xhs-agent-algo-feb2026/reports/xhs-agent-algo-feb2026/ralph-loop.log
```

And inspect structured status:

```bash
npm run dev -- status --workspace ./workspaces/xhs-agent-algo-feb2026
```

## LaTeX Template

Bundled assets:

- [`templates/interview-note-template.tex`](./templates/interview-note-template.tex)
- [`templates/interview-note-template.pdf`](./templates/interview-note-template.pdf)

Copy them into your workspace:

```bash
npm run dev -- template
```

## Auto Commit

By default the SDK does **not** auto-commit.

Enable it per command:

```bash
npm run dev -- cycle --auto-commit
npm run dev -- nightly 8 --auto-commit
```

## Tests

```bash
npm test
npm run typecheck
```
