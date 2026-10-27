import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../src/index.ts'
import { checkThreading } from '../src/threading.ts'

function fixture(t) {
  const replies = []
  const records = new Map()
  const logs = []
  t.mock.method(console, 'log', value => logs.push(JSON.parse(value)))
  const env = {
    SEND_ENABLED: 'true',
    AUTO_REPLY_ENABLED: 'true',
    EMAIL: { send() { assert.fail('Automatic replies must use the native reply API') } },
    SENT: {
      async get(key, type) {
        const value = records.get(key)
        return value && type === 'json' ? JSON.parse(value) : value ?? null
      },
      async put(key, value, options) {
        assert.equal(options.expirationTtl, 604800)
        records.set(key, value)
      },
    },
  }
  function message({ subject = 'Hello Aura', text = 'Hello!', headers = [], html = false, attachment = false, from = 'tester@external.example', to = 'spike-test@34five.studio', id = '<demo-inbound@external.example>', reply } = {}) {
    const raw = [
      `From: Tester <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      ...(id === null ? [] : [`Message-ID: ${id}`]),
      ...headers,
      'MIME-Version: 1.0',
      ...(attachment ? [
        'Content-Type: multipart/mixed; boundary="demo"', '',
        '--demo', 'Content-Type: text/plain; charset=utf-8', '', text,
        '--demo', 'Content-Type: text/plain',
        'Content-Disposition: attachment; filename="uploaded.txt"',
        'Content-Transfer-Encoding: base64', '', 'cHJpdmF0ZSB1cGxvYWRlZCBjb250ZW50',
        '--demo--', '',
      ] : [`Content-Type: text/${html ? 'html' : 'plain'}; charset=utf-8`, '', text]),
    ].join('\r\n')
    return {
      from, to, rawSize: new TextEncoder().encode(raw).byteLength,
      raw: new Response(raw).body, headers: new Headers(),
      async reply(builder) {
        replies.push(builder)
        if (reply) return reply(builder)
        return { messageId: '<demo-outbound@34five.studio>' }
      },
    }
  }
  return { env, replies, records, logs, message }
}

test('default reply uses native threading and needs no HTTP token', async t => {
  const { env, replies, message, logs } = fixture(t)
  await worker.email(message(), env)
  assert.equal(replies.length, 1)
  const reply = replies[0]
  assert.equal(reply.subject, 'Re: Hello Aura')
  assert.equal(reply.from.email, 'spike-test@34five.studio')
  assert.equal(reply.replyTo, 'spike-test@34five.studio')
  assert.equal(reply.to, undefined, 'The runtime must choose the original sender')
  assert.equal(reply.headers['Auto-Submitted'], 'auto-replied')
  assert.equal(reply.headers['X-Auto-Response-Suppress'], 'All')
  assert.equal(reply.headers['In-Reply-To'], undefined, 'The runtime sets threading headers')
  assert.match(reply.text, /fixed demo response/)
  assert.ok(reply.html)
  assert.equal(reply.attachments, undefined)
  assert.equal(logs.find(log => log.event === 'auto_reply').send_status, 'accepted')
  assert.equal((await checkThreading(env.SENT, '<demo-outbound@34five.studio>', [])).in_reply_to_match, true)
})

for (const options of [
  { text: 'Please send an attachment.' },
  { text: 'Can you send ATTACHMENTS?' },
  { subject: 'Attachment test' },
  { html: true, text: '<p>Please send <strong>attachments</strong>.</p>' },
  { attachment: true, text: 'Here is a file.' },
]) {
  test(`sample attachment for ${JSON.stringify(options)}`, async t => {
    const { env, replies, message, logs } = fixture(t)
    await worker.email(message(options), env)
    const [attachment] = replies[0].attachments
    assert.equal(replies[0].attachments.length, 1)
    assert.equal(attachment.filename, 'aura-demo.txt')
    assert.equal(attachment.type, 'text/plain')
    assert.equal(attachment.disposition, 'attachment')
    const decoded = Buffer.from(attachment.content, 'base64')
    assert.match(decoded.toString(), /sample file for testing only/)
    assert.ok(decoded.byteLength < 1024)
    assert.doesNotMatch(decoded.toString(), /private uploaded content/)
    assert.equal(logs.find(log => log.event === 'auto_reply').attachment_size_bytes, decoded.byteLength)
    if (options.attachment) assert.match(replies[0].text, /received 1 attachment/)
  })
}

test('keyword detection uses whole words', async t => {
  const { env, replies, message } = fixture(t)
  await worker.email(message({ text: 'Reattachment and attachmentsExtra are not the trigger words.' }), env)
  assert.equal(replies[0].attachments, undefined)
})

test('human follow-ups keep the existing Re subject and can receive another reply', async t => {
  const { env, replies, message } = fixture(t)
  await worker.email(message(), env)
  await worker.email(message({ id: '<follow-up@external.example>', subject: 'Re: Hello Aura', headers: [
    'In-Reply-To: <demo-outbound@34five.studio>',
    'References: <demo-inbound@external.example> <demo-outbound@34five.studio>',
  ] }), env)
  assert.equal(replies.length, 2)
  assert.equal(replies[1].subject, 'Re: Hello Aura')
})

test('duplicate delivery does not cause another reply', async t => {
  const { env, replies, message, logs } = fixture(t)
  await worker.email(message(), env)
  await worker.email(message(), env)
  assert.equal(replies.length, 1)
  assert.equal(logs.find(log => log.reason === 'duplicate_message').event, 'auto_reply_skipped')
})

for (const headers of [
  ['Auto-Submitted: auto-replied'],
  ['Auto-Submitted: auto-generated'],
  ['Auto-Submitted: no', 'Auto-Submitted: auto-replied'],
  ['Precedence: bulk'],
  ['List-Id: Demo <demo.list.example>'],
  ['X-Auto-Response-Suppress: All'],
  ['X-Aura-Demo: true'],
  ['Content-Type: multipart/report; report-type=delivery-status'],
]) {
  test(`automated mail is not answered: ${headers.join(', ')}`, async t => {
    const { env, replies, message, logs } = fixture(t)
    await worker.email(message({ headers }), env)
    assert.equal(replies.length, 0)
    assert.ok(logs.some(log => log.reason === 'automated_message'))
  })
}

for (const from of ['', 'mailer-daemon@external.example', 'postmaster@external.example', 'noreply@external.example', 'no-reply@external.example', 'spike-test@34five.studio']) {
  test(`automated or empty sender is not answered: ${from}`, async t => {
    const { env, replies, message } = fixture(t)
    await worker.email(message({ from }), env)
    assert.equal(replies.length, 0)
  })
}

test('Reply-To cannot redirect the automatic reply to a third party', async t => {
  const { env, replies, message } = fixture(t)
  await worker.email(message({ headers: ['Reply-To: other@third-party.example'] }), env)
  assert.equal(replies.length, 1)
  assert.equal(replies[0].to, undefined)
  assert.doesNotMatch(JSON.stringify(replies[0]), /third-party/)
})

test('long threads stop replying', async t => {
  const { env, replies, message, logs } = fixture(t)
  const references = Array.from({ length: 20 }, (_, i) => `<${i}@external.example>`).join(' ')
  await worker.email(message({ headers: [`References: ${references}`] }), env)
  assert.equal(replies.length, 0)
  assert.ok(logs.some(log => log.reason === 'demo_thread_limit'))
})

for (const options of [{ id: null }, { id: 'bad-id' }, { id: '<one@a.example> <two@b.example>' }, { headers: ['Message-ID: <duplicate@b.example>'] }]) {
  test(`missing or ambiguous Message-ID is not answered: ${JSON.stringify(options)}`, async t => {
    const { env, replies, message } = fixture(t)
    await worker.email(message(options), env)
    assert.equal(replies.length, 0)
  })
}

test('both enable switches must be true', async t => {
  const { env, replies, message } = fixture(t)
  for (const variable of ['SEND_ENABLED', 'AUTO_REPLY_ENABLED']) {
    for (const value of [undefined, 'false', 'TRUE']) {
      const disabled = { ...env, [variable]: value }
      await worker.email(message(), disabled)
    }
  }
  assert.equal(replies.length, 0)
})

test('only the demo address triggers automatic replies', async t => {
  const { env, replies, message } = fixture(t)
  await worker.email(message({ to: 'anthony@34five.studio' }), env)
  assert.equal(replies.length, 0)
})

test('deduplication read or claim failure skips sending', async t => {
  const { env, replies, message, logs } = fixture(t)
  for (const method of ['get', 'put']) {
    const broken = { ...env, SENT: { ...env.SENT, [method]: async () => { throw new Error('KV unavailable') } } }
    await worker.email(message(), broken)
  }
  assert.equal(replies.length, 0)
  assert.equal(logs.filter(log => log.reason === 'deduplication_unavailable').length, 2)
})

test('native reply failure preserves diagnostics without throwing or retrying', async t => {
  const { env, replies, message, logs, records } = fixture(t)
  const options = { reply() { throw Object.assign(new Error('DMARC failure'), { code: 'E_TEST_DMARC' }) } }
  await worker.email(message(options), env)
  await worker.email(message(options), env)
  assert.equal(replies.length, 1)
  assert.equal(logs.find(log => log.event === 'auto_reply_error').code, 'E_TEST_DMARC')
  const saved = JSON.parse([...records.entries()].find(([key]) => key.startsWith('demo-reply:'))[1])
  assert.equal(saved.send_status, 'unknown')
  assert.equal(saved.error_message, 'DMARC failure')
  assert.equal(saved.incoming_message_id, '<demo-inbound@external.example>')
  assert.equal(saved.recipient, 'tester@external.example')
})

test('accepted replies store their outcome even when separate sent tracking is unavailable', async t => {
  const { env, message, records } = fixture(t)
  const put = env.SENT.put
  env.SENT.put = async (key, ...args) => {
    if (key.startsWith('sent:')) throw new Error('Sent tracking unavailable')
    return put(key, ...args)
  }
  await worker.email(message(), env)
  const saved = JSON.parse([...records.entries()].find(([key]) => key.startsWith('demo-reply:'))[1])
  assert.equal(saved.send_status, 'accepted')
  assert.equal(saved.message_id_raw, '<demo-outbound@34five.studio>')
  assert.equal(saved.tracking_status, 'failed')
})

test('error diagnostics are bounded, single-line, and redact the send secret', async t => {
  const { env, message, logs, records } = fixture(t)
  env.SPIKE_SEND_TOKEN = 'sensitive-demo-send-secret-with-at-least-32-characters'
  await worker.email(message({ reply() { throw new Error(`${env.SPIKE_SEND_TOKEN}\r\n${'x'.repeat(700)}`) } }), env)
  const error = logs.find(log => log.event === 'auto_reply_error')
  assert.match(error.error_message, /\[redacted\]/)
  assert.ok(error.error_message.length <= 512)
  assert.doesNotMatch(error.error_message, /[\r\n]/)
  assert.ok(!JSON.stringify([...records.values(), logs]).includes(env.SPIKE_SEND_TOKEN))
})

test('a failed outcome write never loses the original reply error or triggers a retry', async t => {
  const { env, message, replies, logs } = fixture(t)
  const put = env.SENT.put
  let writes = 0
  env.SENT.put = async (...args) => {
    if (++writes > 1) throw new Error('Outcome storage unavailable')
    return put(...args)
  }
  await worker.email(message({ reply() { throw new Error('Original reply failure') } }), env)
  await worker.email(message(), env)
  assert.equal(replies.length, 1)
  assert.equal(logs.find(log => log.event === 'auto_reply_error').error_message, 'Original reply failure')
  assert.ok(logs.some(log => log.event === 'auto_reply_outcome_storage_error'))
})

test('string errors are recorded safely', async t => {
  const { env, message, logs } = fixture(t)
  await worker.email(message({ reply() { throw 'Plain reply failure' } }), env)
  assert.equal(logs.find(log => log.event === 'auto_reply_error').error_message, 'Plain reply failure')
})

test('tracking failure after native reply acceptance never retries', async t => {
  const { env, replies, message, logs } = fixture(t)
  const put = env.SENT.put
  env.SENT.put = async (key, ...args) => {
    if (key.startsWith('sent:')) throw new Error('Tracking unavailable')
    return put(key, ...args)
  }
  await worker.email(message(), env)
  await worker.email(message(), env)
  assert.equal(replies.length, 1)
  assert.equal(logs.find(log => log.event === 'auto_reply').tracking_status, 'failed')
})

test('oversized incoming mail fails before parsing or replying', async t => {
  const { env, replies, message } = fixture(t)
  const oversized = message()
  oversized.rawSize = 25 * 1024 * 1024 + 1
  await assert.rejects(worker.email(oversized, env), /25 MiB/)
  assert.equal(replies.length, 0)
})

test('oversized subjects are logged without a reply', async t => {
  const { env, replies, message, logs } = fixture(t)
  await worker.email(message({ subject: 'x'.repeat(999) }), env)
  assert.equal(replies.length, 0)
  assert.ok(logs.some(log => log.reason === 'invalid_subject'))
})

test('the inbound stream size is enforced even when rawSize is understated', async t => {
  const { env, replies, message } = fixture(t)
  const oversized = message()
  oversized.rawSize = 0
  let cancelled = false
  oversized.raw = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(worker.email(oversized, env), /size limit/)
  assert.equal(cancelled, true)
  assert.equal(replies.length, 0)
})
