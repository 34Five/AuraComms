import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateEmailPrefix,emailSlug} from '../shared/email-prefix.ts';

for(const name of ['anthony','melina','merlin','atlas','support','support-test','sales','sales-test','operations','operations-test','notifications','notifications-test','spike-test','no-reply','noreply','postmaster','abuse','admin','hostmaster','webmaster'])test(`reserved prefix ${name} is rejected without relying on a database row`,()=>{
  assert.throws(()=>validateEmailPrefix(` ${name.toUpperCase()} `,'34five.studio'),{status:409});
});
test('prefixes accept only letters and numbers with single dot or hyphen separators',()=>{
  for(const prefix of ['megan','MEGAN','a.b-c','0','assistant-12'])assert.equal(validateEmailPrefix(prefix,'34five.studio'),prefix.toLowerCase());
  for(const prefix of ['a+b','x/y',"o'brien",'with_space','two words','a..b','a--b','a.-b','a-.b','.leading','trailing-','a@b','a'.repeat(65),'','é','\n'])assert.throws(()=>validateEmailPrefix(prefix,'34five.studio'),{status:400},prefix);
});
test('generated suggestions use the same separator grammar',()=>{
  for(const name of ['Dr. Émile O\'Neil','a..b','a.-b','--a--','日本語'])assert.match(emailSlug(name),/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
});
