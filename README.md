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

## What It Does

For Xiaohongshu interview notes, the SDK can:

1. incrementally search notes by query
2. hydrate note detail content
3. enrich comments
4. extract interview questions
5. mark likely seller / lead-gen accounts or notes
6. export:
   - `xhs_notes.json`
   - `xhs_questions.json`
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

External prerequisites:

- Node.js 20+
- `opencli`
- `omx`
- Chrome logged into `xiaohongshu.com`

## CLI

After build:

```bash
node dist/cli.js --help
```

Main commands:

```bash
npm run dev -- init
npm run dev -- sources
npm run dev -- harvest
npm run dev -- hydrate --limit 12
npm run dev -- comments --limit 8
npm run dev -- normalize
npm run dev -- questions
npm run dev -- overview
npm run dev -- doctor
npm run dev -- export
npm run dev -- seller-summary
npm run dev -- ralph "analyze the current dataset"
node dist/cli.js stats
node dist/cli.js doctor
node dist/cli.js export
node dist/cli.js seller-summary
node dist/cli.js cycle
node dist/cli.js nightly 8
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
npm run dev -- doctor
npm run dev -- stats
npm run dev -- export
npm run dev -- seller-summary
npm run dev -- cycle
npm run dev -- nightly 8
npm run dev -- omx-safe doctor
```

Command notes:

- `sources`: lists currently built-in source adapters
- `harvest`: runs incremental search only
- `hydrate`: fills note detail content only
- `comments`: enriches comments only
- `normalize`: refreshes question extraction and seller flags only
- `questions`: rebuilds `xhs_questions*.json` only
- `overview`: rebuilds overview and seller reports only
- `doctor`: verifies `node`, `opencli`, `omx`, config path, data dir, and report dir
- `export`: rebuilds question/topic/overview/seller outputs from existing note data
- `seller-summary`: refreshes seller-tagged reports from current note data
- `ralph`: shortcut for `omx-safe exec --full-auto '$ralph "..."'`

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
  xhs_questions_nlp.json
  xhs_questions_backend.json
  xhs_questions_algo.json
  company_round_summary.json
reports/xhs-miangjing/
  index.html
  xhs_questions_nlp.html
  xhs_questions_backend.html
  xhs_questions_algo.html
  seller_candidates.json
  author_seller_summary.json
  seller_summary.md
  progress.log
```

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
