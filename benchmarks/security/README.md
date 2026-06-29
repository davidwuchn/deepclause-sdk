# Security Benchmark

Evaluates the DeepClause security planner against real CVEs and GHSAs from the [nelson](https://github.com/swelljoe/nelson) benchmark suite.

## Cases

9 cases covering 6 vulnerability classes across 5 languages:

| ID | Project | Language | Bug Class | Severity |
|----|---------|----------|-----------|----------|
| CVE-2026-5199 | temporalio/temporal | Go | broken-access-control | critical |
| CVE-2026-7474 | hashicorp/nomad | Go | path-traversal | critical |
| GHSA-9f49-8x56-jmjc | CESNET/libyang | C | use-after-free | medium |
| GHSA-cc7p-2j3x-x7xf | craftcms/cms | PHP | privilege-escalation | high |
| GHSA-f26g-jm89-4g65 | GitoxideLabs/gitoxide | Rust | rce | high |
| GHSA-j273-m5qq-6825 | junrar/junrar | Java | path-traversal | medium |
| GHSA-mpxh-8fq3-x8mh | FreeRDP/FreeRDP | C | heap-buffer-overflow | high |
| GHSA-w52v-v783-gw97 | TryGhost/Ghost | JavaScript | sql-injection | critical |
| GHSA-x9h5-r9v2-vcww | ImageMagick/ImageMagick | C | heap-buffer-overflow | high |

## Usage

```bash
# Run a single case
node benchmarks/security/run-security.mjs \
  --case GHSA-w52v-v783-gw97 \
  --model custom:aliyun:qwen3.6-27b

# Run all cases
node benchmarks/security/run-security.mjs \
  --all \
  --model custom:aliyun:qwen3.6-27b

# Skip re-cloning after a previous run
node benchmarks/security/run-security.mjs \
  --case GHSA-w52v-v783-gw97 \
  --skip-clone
```

## What It Does

For each case:
1. Clones the repo at the vulnerable commit
2. Runs `/security-planner` with a prompt describing the audit target
3. Runs the generated multi-strategy plan against the codebase
4. Checks if the output mentions the ground truth file and vulnerability class
5. Writes results to `benchmarks/security/runs/<case-id>/`

## Evaluation

A finding is counted as "found" if the plan output:
- Mentions at least one ground truth file path, AND
- Mentions the bug class, CWE, or vulnerability indicators

The check is conservative — it only checks for keywords, not semantic correctness.
