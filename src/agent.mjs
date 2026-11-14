const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const forbiddenHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "trailer", "te", "keep-alive", "x-payloadbay-delivery-id"]);
const maximumBody = 1048576;

export function configuration(environment) {
	const server = new URL(environment.PAYLOADBAY_URL);
	const target = new URL(environment.PAYLOADBAY_RUNNER_TARGET);
	if (server.protocol !== "https:" && !(server.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(server.hostname))) throw Error("server_https_required");
	if (!["http:", "https:"].includes(target.protocol)) throw Error("target_http_required");
	for (const url of [server, target]) if (url.username || url.password || url.hash) throw Error("url_credentials_or_fragment_not_allowed");
	if (server.pathname !== "/" || server.search) throw Error("server_origin_required");
	const token = environment.PAYLOADBAY_RUNNER_TOKEN;
	if (!token || token.length < 32 || token.length > 4096 || /[\r\n]/.test(token)) throw Error("runner_token_required");

	return { server: server.origin, target: target.href, token, timeoutMs: 15000 };
}

async function boundedBody(response, maximum, signal) {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const parts = [];
	let size = 0;
	try {
		for (;;) {
			if (signal.aborted) throw Error("cancelled");
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximum) throw Error("response_too_large");
			parts.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}

	return Buffer.concat(parts);
}

function deliveryEnvelope(input) {
	if (!input || typeof input !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id ?? "") || typeof input.leaseToken !== "string" || input.leaseToken.length < 16 || input.leaseToken.length > 4096) throw Error("invalid_delivery");
	if (!methods.has(input.method) || typeof input.bodyBase64 !== "string" || input.bodyBase64.length > Math.ceil(maximumBody / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bodyBase64)) throw Error("invalid_request");
	if (!/^[a-f0-9]{64}$/.test(input.idempotencyKey ?? "")) throw Error("invalid_idempotency_key");
	const body = Buffer.from(input.bodyBase64, "base64");
	if (body.length > maximumBody || (["GET", "HEAD"].includes(input.method) && body.length)) throw Error("invalid_body");
	if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw Error("invalid_headers");
	const headers = new Headers();
	let headerBytes = 0;
	for (const [name, value] of Object.entries(input.headers)) {
		if (typeof value !== "string") throw Error("invalid_headers");
		headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
		if (headerBytes > 16384) throw Error("headers_too_large");
		if (!forbiddenHeaders.has(name.toLowerCase())) headers.set(name, value);
	}
	headers.set("x-payloadbay-delivery-id", input.idempotencyKey);
	const remaining = Date.parse(input.leaseExpiresAt) - Date.now();
	if (!Number.isFinite(remaining) || remaining < 1000) throw Error("lease_expired");

	return { id: input.id, leaseToken: input.leaseToken, method: input.method, body, headers, remaining };
}

export async function runOnce(config, signal = new AbortController().signal) {
	const transportSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
	const claim = await fetch(config.server + "/api/v1/runner/claim", { method: "POST", headers: { authorization: "Bearer " + config.token }, redirect: "error", signal: transportSignal });
	if (claim.status === 204) return { state: "idle" };
	if (claim.status === 401 || claim.status === 403) throw Error("runner_authorization_denied");
	if (!claim.ok) throw Error("claim_unavailable");
	const delivery = deliveryEnvelope(JSON.parse((await boundedBody(claim, 1500000, transportSignal)).toString("utf8")));
	const localSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs, delivery.remaining - 500)))]);
	let result;
	try {
		const response = await fetch(config.target, { method: delivery.method, headers: delivery.headers, ...(delivery.body.length ? { body: delivery.body } : {}), redirect: "manual", signal: localSignal });
		const body = await boundedBody(response, 65536, localSignal);
		result = { status: response.status, bodyBase64: body.toString("base64"), contentType: (response.headers.get("content-type") ?? "").slice(0, 1024) };
	} catch {
		if (signal.aborted) throw Error("cancelled");
		result = { networkError: "local_delivery_failed" };
	}
	const ack = await fetch(config.server + "/api/v1/runner/deliveries/" + encodeURIComponent(delivery.id) + "/complete", { method: "POST", headers: { authorization: "Bearer " + config.token, "content-type": "application/json" }, body: JSON.stringify({ leaseToken: delivery.leaseToken, result }), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
	await ack.body?.cancel();
	if (!ack.ok) throw Error("acknowledgement_not_committed");

	return { state: "reported", deliveryId: delivery.id, status: result.status };
}
