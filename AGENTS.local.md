# Runner guidance

Runner is an outbound-only private receiver agent, separate from Core and its
release boundary. Track the initial work in payloadbay/payloadbay#18. Never
claim Core compatibility without the real Core/agent acceptance test.

The local operator chooses the fixed HTTP(S) target. Server envelopes cannot
select a target or cause redirects to be followed. Keep payloads, credentials,
URLs and response bodies out of normal logs. Preserve request bytes, bounded
responses, cancellation, lease fencing and at-least-once semantics.

Use Node built-ins and Bun package tooling. `bun run check` runs syntax checks
and real local HTTP tests; Husky runs it before pushing. CI uses the same check.
Keep the organization baseline in AGENTS.md unchanged. No release or production
networking changes are authorized by prototype implementation work.
