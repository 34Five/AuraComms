import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.ts'
import {
	checkThreading,
	normalizeMessageId,
	sentKey,
} from '../src/threading.ts'

const TOKEN = 'local-test-token-with-at-least-32-characters'
// rule id - 97c320b8f69f43cd8383dab164d89cb4
function fixture() {
	const records = new Map()
	const sends = []
	const env = {
		SPIKE_SEND_TOKEN: TOKEN,
		SEND_ENABLED: 'true',
		EMAIL: {
			async send(message) {
				sends.push(message)
				return { messageId: '<LocalPart@CF.Example>' }
			},
		},
		SENT: {
			async get(key) {
				return records.has(key) ? JSON.parse(records.get(key)) : null
			},
			async put(key, value, options) {
				assert.equal(options.expirationTtl, 604800)
				records.set(key, value)
			},
		},
	}
	return { env, records, sends }
}

function request(body = { to: 'tester@example.com' }, options = {}) {
	return new Request(`https://spike.example${options.path ?? '/send'}`, {
		method: options.method ?? 'POST',
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			'Content-Type': 'application/json',
			...options.headers,
		},
		body:
			options.method === 'GET'
				? undefined
				: typeof body === 'string'
					? body
					: JSON.stringify(body),
	})
}

test('unknown routes, methods, and invalid credentials cannot send', async () => {
	const { env, sends } = fixture()
	for (const [options, status] of [
		[{ path: '/' }, 404],
		[{ method: 'GET' }, 405],
		[{ headers: { Authorization: 'Bearer wrong' } }, 401],
		[{ headers: { Authorization: '' } }, 401],
	]) {
		assert.equal(
			(await worker.fetch(request(undefined, options), env)).status,
			status,
		)
	}
	assert.equal(sends.length, 0)
})

test('missing or weak tokens fail closed', async () => {
	const { env, sends } = fixture()
	for (const token of [undefined, '', 'short']) {
		env.SPIKE_SEND_TOKEN = token
		assert.equal((await worker.fetch(request(), env)).status, 503)
	}
	assert.equal(sends.length, 0)
})

test('sending still requires explicit enablement for any recipient', async () => {
	const { env, sends } = fixture()
	for (const enabled of [undefined, 'false', 'TRUE']) {
		env.SEND_ENABLED = enabled
		assert.equal((await worker.fetch(request(), env)).status, 403)
	}
	assert.equal(sends.length, 0)
})

test('authenticated sending accepts recipients without a configured allowlist', async () => {
	const { env, sends } = fixture()
	const recipients = [
		'other@example.com',
		'person+tag@external.example',
		'Person@another.example',
	]
	for (const to of recipients) {
		const response = await worker.fetch(request({ to }), env)
		assert.equal(response.status, 202)
		assert.equal((await response.json()).send_status, 'accepted')
	}
	assert.deepEqual(sends.map(message => message.to), recipients)
})

test('invalid JSON, fields, recipients, and header injection do not call send', async () => {
	const { env, sends } = fixture()
	for (const body of [
		'{',
		'null',
		'[]',
		{},
		{ to: ['tester@example.com'] },
		{ to: 'tester@example.com,other@example.com' },
		{ to: 'other@example.com\r\nBcc: victim@example.com' },
		{ to: 'other@example.com;victim@example.com' },
		{ to: 'Person <other@example.com>' },
		{ to: 'tester@example.com', subject: 'Hello\r\nBcc: other@example.com' },
		{
			to: 'tester@example.com',
			inReplyTo: '<parent@cf.example>\r\nX-Test: bad',
		},
		{ to: 'tester@example.com', inReplyTo: 'not-an-id' },
		{ to: 'tester@example.com', references: 'parent@cf.example' },
		{ to: 'tester@example.com', references: [null] },
		{ to: 'tester@example.com', from: 'another@34five.studio' },
	]) {
		assert.equal(
			(await worker.fetch(request(body), env)).status,
			400,
			JSON.stringify(body),
		)
	}
	assert.equal(sends.length, 0)
})

test('request size is bounded without trusting Content-Length', async () => {
	const { env, sends } = fixture()
	assert.equal(
		(
			await worker.fetch(
				request({ to: 'tester@example.com', subject: 'a'.repeat(17000) }),
				env,
			)
		).status,
		413,
	)
	assert.equal(
		(
			await worker.fetch(
				request({}, { headers: { 'Content-Type': 'text/plain' } }),
				env,
			)
		).status,
		415,
	)
	assert.equal(sends.length, 0)
})

test('send uses the fixed sender, both bodies, replyTo, attachment, and expiring tracking', async () => {
	const { env, sends, records } = fixture()
	const response = await worker.fetch(request(), env)
	assert.equal(response.status, 202)
	const result = await response.json()
	assert.equal(result.messageId, '<LocalPart@CF.Example>')
	assert.equal(result.message_id_normalized, 'LocalPart@cf.example')
	assert.equal(result.send_status, 'accepted')
	assert.equal(result.delivery_status, 'unverified')
	assert.equal(result.tracking_status, 'stored')
	assert.equal(sends.length, 1)
	assert.deepEqual(sends[0].from, {
		email: 'spike-test@34five.studio',
		name: 'Aura Spike',
	})
	assert.equal(sends[0].replyTo, 'spike-test@34five.studio')
	assert.ok(sends[0].text && sends[0].html)
	assert.equal(sends[0].attachments[0].filename, 'spike.txt')
	assert.ok(sends[0].attachments[0].content.byteLength > 0)
	assert.equal(sends[0].headers['Message-ID'], undefined)
	const stored = JSON.parse(records.get(await sentKey(result.messageId)))
	assert.equal(stored.message_id_raw, result.messageId)
	assert.equal(stored.request_id, result.request_id)
})

test('outbound threading preserves subject and appends a bracketed parent once', async () => {
	const { env, sends } = fixture()
	const response = await worker.fetch(
		request({
			to: 'tester@example.com',
			subject: 'Re: Original subject',
			inReplyTo: 'Parent@CF.Example',
			references: ['<Root@cf.example>', 'Root@cf.example'],
		}),
		env,
	)
	assert.equal(response.status, 202)
	assert.equal(sends[0].subject, 'Re: Original subject')
	assert.equal(sends[0].headers['In-Reply-To'], '<Parent@CF.Example>')
	assert.equal(
		sends[0].headers.References,
		'<Root@cf.example> <Parent@CF.Example>',
	)
})

test('a full reference chain cannot silently discard its parent', async () => {
	const { env, sends } = fixture()
	const response = await worker.fetch(
		request({
			to: 'tester@example.com',
			inReplyTo: 'new@cf.example',
			references: Array.from({ length: 100 }, (_, i) => `${i}@cf.example`),
		}),
		env,
	)
	assert.equal(response.status, 400)
	assert.equal(sends.length, 0)
})

test('Cloudflare error codes survive without retries', async () => {
	const { env } = fixture()
	let attempts = 0
	env.EMAIL.send = async () => {
		attempts++
		throw Object.assign(new Error('suppressed'), {
			code: 'E_RECIPIENT_SUPPRESSED',
		})
	}
	const response = await worker.fetch(request(), env)
	assert.equal(response.status, 502)
	assert.equal((await response.json()).code, 'E_RECIPIENT_SUPPRESSED')
	assert.equal(attempts, 1)
})

test('KV failure after acceptance preserves the send result and prevents retry advice', async () => {
	const { env, sends } = fixture()
	env.SENT.put = async () => {
		throw new Error('KV unavailable')
	}
	const response = await worker.fetch(request(), env)
	assert.equal(response.status, 202)
	const result = await response.json()
	assert.equal(result.messageId, '<LocalPart@CF.Example>')
	assert.equal(result.send_status, 'accepted')
	assert.equal(result.tracking_status, 'failed')
	assert.equal(result.retry_safe, false)
	assert.equal(sends.length, 1)
})

test('normalization preserves local-part case and genuinely different domains', () => {
	assert.equal(normalizeMessageId(' <Mixed@CF.Example> '), 'Mixed@cf.example')
	assert.notEqual(
		normalizeMessageId('Mixed@cf.example'),
		normalizeMessageId('mixed@cf.example'),
	)
	assert.notEqual(
		normalizeMessageId('Mixed@one.example'),
		normalizeMessageId('Mixed@two.example'),
	)
})

test('an older reference match cannot pass the direct-parent check', async () => {
	const { env } = fixture()
	await worker.fetch(request(), env)
	const result = await checkThreading(env.SENT, '<other@cf.example>', [
		'LocalPart@cf.example',
	])
	assert.equal(result.in_reply_to_match, null)
	assert.equal(result.in_reply_to_status, 'pending')
	assert.deepEqual(result.references_matches, ['LocalPart@cf.example'])
})

test('a KV miss stays pending and can resolve through the protected recheck endpoint', async () => {
	const { env } = fixture()
	const body = { inReplyTo: '<LocalPart@CF.Example>' }
	env.SEND_ENABLED = 'false'
	let response = await worker.fetch(
		request(body, { path: '/thread-check' }),
		env,
	)
	assert.equal((await response.json()).in_reply_to_status, 'pending')
	env.SEND_ENABLED = 'true'
	await worker.fetch(request(), env)
	env.SEND_ENABLED = 'false'
	response = await worker.fetch(request(body, { path: '/thread-check' }), env)
	const resolved = await response.json()
	assert.equal(resolved.in_reply_to_match, true)
	assert.deepEqual(resolved.references_matches, [])
	response = await worker.fetch(
		request(body, { path: '/thread-check', headers: { Authorization: '' } }),
		env,
	)
	assert.equal(response.status, 401)
})

test('long inbound reference chains report incomplete lookups explicitly', async () => {
	const { env } = fixture()
	let reads = 0
	env.SENT.get = async () => {
		reads++
		return null
	}
	const references = Array.from({ length: 101 }, (_, i) => `${i}@cf.example`)
	const result = await checkThreading(env.SENT, null, references)
	assert.equal(reads, 100)
	assert.equal(result.lookup_complete, false)
	assert.equal(result.unresolved_ids.length, 101)
	assert.equal(result.in_reply_to_status, 'not_provided')
})

const rawEmail = [
	'From: Sender <sender@example.com>',
	'To: spike-test@34five.studio',
	'Subject: Re: Spike',
	'Message-ID: <Incoming@Example.COM>',
	'In-Reply-To: <LocalPart@cf.example>',
	'References: <Root@example.com>\r\n <LocalPart@cf.example>',
	'Thread-Index: outlook-index',
	'Thread-Topic: Spike',
	'Authentication-Results: mx.example; dkim=pass',
	'Authentication-Results: second.example; spf=pass',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="spike"',
	'',
	'--spike',
	'Content-Type: text/plain',
	'',
	'Message body',
	'--spike',
	'Content-Type: text/plain',
	'Content-Disposition: attachment; filename="one.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	'SGVsbG8=',
	'--spike',
	'Content-Type: text/plain',
	'Content-Disposition: attachment; filename="two.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	'SGk=',
	'--spike--',
	'',
].join('\r\n')

test('inbound parsing logs raw headers and decoded attachment sizes without sending', async (t) => {
	const { env, sends } = fixture()
	await worker.fetch(request(), env)
	const lines = []
	t.mock.method(console, 'log', (value) => lines.push(JSON.parse(value)))
	const bytes = new TextEncoder().encode(rawEmail)
	await worker.email(
		{
			from: 'sender@example.com',
			to: 'spike-test@34five.studio',
			rawSize: bytes.byteLength,
			raw: new Response(bytes).body,
			headers: new Headers(),
			forward() {
				assert.fail('Must not forward')
			},
			reply() {
				assert.fail('Must not reply')
			},
		},
		env,
	)
	const inbound = lines.find((line) => line.event === 'inbound')
	assert.equal(inbound.message_id_raw, '<Incoming@Example.COM>')
	assert.equal(inbound.message_id_normalized, 'Incoming@example.com')
	assert.equal(inbound.raw_size_bytes, bytes.byteLength)
	assert.equal(inbound.attachment_count, 2)
	assert.deepEqual(
		inbound.attachments.map((attachment) => attachment.size_bytes),
		[5, 2],
	)
	assert.equal(inbound.authentication_results.length, 2)
	assert.equal(inbound.thread_index, 'outlook-index')
	assert.equal(inbound.in_reply_to_match, true)
	assert.equal(sends.length, 1)
})

test('inbound mail accepts an unlisted sender without HTTP credentials or sending enabled', async (t) => {
	const { env, sends } = fixture()
	delete env.SPIKE_SEND_TOKEN
	env.SEND_ENABLED = 'false'
	const lines = []
	t.mock.method(console, 'log', value => lines.push(JSON.parse(value)))
	const raw = rawEmail.replaceAll('sender@example.com', 'outside@unlisted.example')
	await worker.email({
		from: 'outside@unlisted.example',
		to: 'spike-test@34five.studio',
		rawSize: new TextEncoder().encode(raw).byteLength,
		raw: new Response(raw).body,
		headers: new Headers(),
	}, env)
	assert.equal(lines.find(line => line.event === 'inbound').envelope_from, 'outside@unlisted.example')
	assert.equal(sends.length, 0)
})

test('KV read failure still preserves inbound evidence', async (t) => {
	const { env } = fixture()
	env.SENT.get = async () => {
		throw new Error('KV unavailable')
	}
	const lines = []
	t.mock.method(console, 'log', (value) => lines.push(JSON.parse(value)))
	await worker.email(
		{
			from: 'sender@example.com',
			to: 'spike-test@34five.studio',
			rawSize: rawEmail.length,
			raw: new Response(rawEmail).body,
			headers: new Headers(),
		},
		env,
	)
	const inbound = lines.find((line) => line.event === 'inbound')
	assert.equal(inbound.in_reply_to_status, 'unavailable')
	assert.equal(inbound.attachment_count, 2)
})
