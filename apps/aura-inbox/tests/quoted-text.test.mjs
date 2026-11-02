import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitQuotedText } from '../frontend/src/quoted-text.ts';

test('Gmail history and attribution collapse while the new reply stays visible', () => {
  const parts=splitQuotedText('Take this\n\nOn Mon, Nov 2, 2026 at 7:46 PM Sales Aura <sales@example.test> wrote:\n\n> Hello!\n>\n> Your previous email.');
  assert.deepEqual(parts.map(p=>p.quoted),[false,true]);
  assert.equal(parts[0].text,'Take this');
  assert.match(parts[1].text,/^On Mon/); assert.match(parts[1].text,/> Your previous email/);
});

test('inline replies between quote blocks remain visible', () => {
  const parts=splitQuotedText('My answers:\n\n> First question\n\nFirst answer.\n\n>> Nested second question\n> More context\n\nSecond answer.');
  assert.deepEqual(parts.map(p=>p.quoted),[false,true,false,true,false]);
  assert.equal(parts[2].text,'First answer.'); assert.equal(parts[4].text,'Second answer.');
});

test('wrapped attributions, Windows newlines and indented quote paragraphs fold together', () => {
  const parts=splitQuotedText('New text\r\n\r\nOn Monday,\r\nSales Aura wrote:\r\n\r\n  > Old text\r\n\r\n\t>> Nested text');
  assert.equal(parts.length,2); assert.equal(parts[0].text,'New text');
  assert.equal(parts[1].quoted,true); assert.match(parts[1].text,/On Monday/);
});

test('ordinary text and attribution-like sentences are not hidden', () => {
  const text='On my way.\nThe result is 10 > 5.\n\nThis is what I wrote:\nA new paragraph.';
  assert.deepEqual(splitQuotedText(text),[{quoted:false,text}]);
  assert.deepEqual(splitQuotedText('On Monday Alice wrote:\nThis is new text.'),[{quoted:false,text:'On Monday Alice wrote:\nThis is new text.'}]);
});

test('quote-only and empty messages are safe, and nested quote content is preserved', () => {
  assert.deepEqual(splitQuotedText(''),[]);
  assert.deepEqual(splitQuotedText('> Old\n>> Older\n> Oldest'),[{quoted:true,text:'> Old\n>> Older\n> Oldest'}]);
  assert.deepEqual(splitQuotedText('New 🌻\n> Old 🌱'),[{quoted:false,text:'New 🌻'},{quoted:true,text:'> Old 🌱'}]);
});

test('removing presentation-edge blanks never deletes message content', () => {
  const text='New reply\n> Old text\n\n> Next quoted paragraph\n\nA final note.';
  const parts=splitQuotedText(text);
  assert.equal(parts.filter(p=>p.quoted).length,1);
  assert.equal(parts[1].text,'> Old text\n\n> Next quoted paragraph');
  assert.equal(parts.at(-1).text,'A final note.');
});
