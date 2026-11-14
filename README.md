# Payload Bay Runner (development)

Outbound-only delivery to a private local receiver. The local service does not
need a public port: Payload Bay receives webhooks and the Runner claims work over
an outbound authenticated connection.

Tracking: [Core #18](https://github.com/payloadbay/payloadbay/issues/18).

**Unreleased development agent.** The matching Core transport lives on the
`feat/18-runner-transport` branch and has passed a real Next.js/agent/private
receiver check. It is not in a published Core release. Do not point this
prototype at production or treat it as a general ngrok reverse proxy.

Node 22.23.5 or newer is required. Run checks with `bun run test`.
No runtime dependency or install token is required. Run `bun install` to
install the development-only push hook; `bun run check` matches its checks.

Set `PAYLOADBAY_URL` to the server HTTPS origin, `PAYLOADBAY_RUNNER_TARGET` to the
operator-approved local HTTP(S) URL and `PAYLOADBAY_RUNNER_TOKEN` in your secret
environment. Run `bun run start`. The URL and credential are never command-line
arguments. The server cannot select a local target or force redirect following.
Plain HTTP server connections are allowed only on loopback for development.

The proposed protocol has `POST /api/v1/runner/claim` return 204 when idle or a
bounded JSON delivery with `id`, `leaseToken`, `leaseExpiresAt`, `method`, `headers`
and `bodyBase64`, plus a stable `idempotencyKey` shared across retries of the
same logical send. `POST /api/v1/runner/deliveries/:id/complete` reports the lease
and a bounded response or network failure. Both endpoints require the matching unreleased Core transport.
The future server must enforce a revocable destination-scoped credential, durable
leases, immutable identity, expiry/fencing, backpressure and retained attempts.
Customer access must remain within the organization boundary.

The Runner forwards original bytes to its fixed target, does not follow local
redirects, and reports up to 64 KiB of response bytes. Larger responses are
reported as a delivery failure. Shutdown cancels work without claiming success.
If the receiver acted but the acknowledgement was lost, a later lease may deliver
again. Receivers should deduplicate using `x-payloadbay-delivery-id`; this is
at-least-once transport, never an exactly-once guarantee.
