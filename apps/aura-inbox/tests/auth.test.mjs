import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './harness.mjs';

const SENDER = 'no-reply@34five.studio';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const inviteSql = readFileSync(new URL('../scripts/provision-invites.sql', import.meta.url), 'utf8');

test('both environments may send login mail', () => {
  assert.ok(config.send_email[0].allowed_sender_addresses.includes(SENDER));
  assert.ok(config.env.demo.send_email[0].allowed_sender_addresses.includes(SENDER));
});

test('the invite seed adds Akash once', t => {
  const x = setup(t);
  x.sql.exec(inviteSql); x.sql.exec(inviteSql);
  const rows = x.sql.prepare("SELECT email FROM demo_auth_invites WHERE email='akash@axiatechnologies.ai'").all();
  assert.equal(rows.length, 1);
  assert.deepEqual(x.sql.prepare('PRAGMA foreign_key_check').all(), []);
});
