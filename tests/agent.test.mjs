import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { configuration, runOnce } from "../src/agent.mjs";

const token = "synthetic-runner-token-32-characters";
const bytes = Buffer.from([0, 255, 42, 10]);

async function fixture(run, options = {}) {
	const deliveries = [];
	const reports = [];
	let alternateCalls = 0;
	let envelope = { id: randomUUID(), idempotencyKey: "a".repeat(64), leaseToken: "synthetic-durable-lease-token", leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), method: "POST", bodyBase64: bytes.toString("base64"), headers: { "content-type": "application/octet-stream", host: "untrusted.example", "x-payloadbay-delivery-id": "forged" }, target: "http://untrusted.example" };
	const receiver = createServer(async (request, response) => {
		if (request.url === "/redirected") alternateCalls++;
		const parts = [];
		for await (const chunk of request) parts.push(chunk);
		deliveries.push({ body: Buffer.concat(parts), id: request.headers["x-payloadbay-delivery-id"], host: request.headers.host });
		if (options.redirect) return response.writeHead(302, { location: "/redirected" }).end();
		response.writeHead(503, { "content-type": "text/plain" }).end("synthetic receiver unavailable");
	});
	const server = createServer(async (request, response) => {
		assert.equal(request.headers.authorization, "Bearer " + token);
		if (request.url === "/api/v1/runner/claim") {
			if (options.idle) return response.writeHead(204).end();
			if (options.denied) return response.writeHead(403).end();
			return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(envelope));
		}
		assert.equal(request.url, "/api/v1/runner/deliveries/" + envelope.id + "/complete");
		const parts = [];
		for await (const chunk of request) parts.push(chunk);
		reports.push(JSON.parse(Buffer.concat(parts).toString()));
		if (options.dropAck) return request.socket.destroy();
		response.writeHead(204).end();
	});
	receiver.listen(0, "127.0.0.1");
	server.listen(0, "127.0.0.1");
	await Promise.all([once(receiver, "listening"), once(server, "listening")]);
	const config = configuration({ PAYLOADBAY_URL: "http://127.0.0.1:" + server.address().port, PAYLOADBAY_RUNNER_TARGET: "http://127.0.0.1:" + receiver.address().port + "/webhook", PAYLOADBAY_RUNNER_TOKEN: token });
	try {
		await run({
			config,
			deliveries,
			reports,
			get alternateCalls() {
				return alternateCalls;
			},
			setEnvelope: (value) => {
				envelope = { ...envelope, ...value };
			},
		});
	} finally {
		for (const service of [receiver, server]) service.closeAllConnections();
		await Promise.all([new Promise((resolve) => receiver.close(resolve)), new Promise((resolve) => server.close(resolve))]);
	}
}

test("configuration requires HTTPS server, explicit local target and bounded credentials", () => {
	const env = { PAYLOADBAY_URL: "https://payloadbay.example", PAYLOADBAY_RUNNER_TARGET: "http://localhost:3000/hook", PAYLOADBAY_RUNNER_TOKEN: token };
	assert.equal(configuration(env).target, env.PAYLOADBAY_RUNNER_TARGET);
	for (const change of [{ PAYLOADBAY_URL: "http://public.example" }, { PAYLOADBAY_URL: "https://secret:password@example.test" }, { PAYLOADBAY_URL: "https://example.test/path" }, { PAYLOADBAY_RUNNER_TARGET: "file:///etc/passwd" }, { PAYLOADBAY_RUNNER_TARGET: "http://user:password@localhost" }, { PAYLOADBAY_RUNNER_TOKEN: "short" }]) assert.throws(() => configuration({ ...env, ...change }));
});

test("outbound delivery uses fixed operator target, exact bytes, stable identity and records receiver failure", async () => {
	await fixture(async ({ config, deliveries, reports }) => {
		assert.equal((await runOnce(config)).state, "reported");
		assert.equal(deliveries.length, 1);
		assert.deepEqual(deliveries[0].body, bytes);
		assert.notEqual(deliveries[0].id, "forged");
		assert.notEqual(deliveries[0].host, "untrusted.example");
		assert.equal(reports[0].leaseToken, "synthetic-durable-lease-token");
		assert.equal(reports[0].result.status, 503);
		assert.equal(Buffer.from(reports[0].result.bodyBase64, "base64").toString(), "synthetic receiver unavailable");
	});
});

test("local redirects are reported without widening network access", async () => {
	await fixture(
		async (f) => {
			await runOnce(f.config);
			assert.equal(f.alternateCalls, 0);
			assert.equal(f.reports[0].result.status, 302);
		},
		{ redirect: true },
	);
});

test("lost acknowledgement remains uncertain and a later delivery retains its deduplication identity", async () => {
	await fixture(
		async ({ config, deliveries, reports }) => {
			await assert.rejects(runOnce(config));
			await assert.rejects(runOnce(config));
			assert.equal(deliveries.length, 2);
			assert.equal(reports.length, 2);
			assert.equal(deliveries[0].id, deliveries[1].id);
		},
		{ dropAck: true },
	);
});

test("expired and malformed deliveries never reach a private receiver", async () => {
	for (const invalid of [{ leaseExpiresAt: new Date(0).toISOString() }, { bodyBase64: "malformed!" }, { method: "CONNECT" }, { method: "GET" }, { headers: { test: "bad\r\nvalue" } }, { headers: { test: "a".repeat(16385) } }]) {
		await fixture(async ({ config, setEnvelope, deliveries, reports }) => {
			setEnvelope(invalid);
			await assert.rejects(runOnce(config));
			assert.equal(deliveries.length, 0);
			assert.equal(reports.length, 0);
		});
	}
});

test("idle and revoked credentials cannot trigger a local HTTP request", async () => {
	await fixture(
		async ({ config, deliveries }) => {
			assert.deepEqual(await runOnce(config), { state: "idle" });
			assert.equal(deliveries.length, 0);
		},
		{ idle: true },
	);
	await fixture(
		async ({ config, deliveries }) => {
			await assert.rejects(runOnce(config), { message: "runner_authorization_denied" });
			assert.equal(deliveries.length, 0);
		},
		{ denied: true },
	);
});
