import assert from 'node:assert/strict';
import test from 'node:test';
import { readGoogleSearch } from '../src/jiji/google-search.js';

const content = (text = 'ผลค้นจากเว็บ') => ({ parts: [{ text }] });
const metadata = overrides => ({
  webSearchQueries: ['query'],
  groundingChunks: [{ web: { uri: 'https://example.com/source' } }],
  searchEntryPoint: { renderedContent: '<a href="https://google.com/search?q=query">ค้นต่อ</a>' },
  ...overrides,
});
const candidate = groundingMetadata => ({ groundingMetadata });
function assertReason(reason, groundingMetadata, answer = content()) {
  assert.throws(() => readGoogleSearch(candidate(groundingMetadata), answer), error => {
    assert.equal(error.category, 'search_failed');
    assert.deepEqual(error.diagnostic, { stage: 'google_search', reason });
    return true;
  });
}

test('Google Search failures identify one static validation reason', () => {
  assertReason('search_text_invalid', metadata(), content(''));
  assertReason('search_metadata_missing', undefined);
  assertReason('search_queries_invalid', metadata({ webSearchQueries: [] }));
  assertReason('search_sources_invalid', metadata({ groundingChunks: [] }));
  assertReason('search_source_limit', metadata({ groundingChunks: Array.from({ length: 6 }, (_, i) => ({ web: { uri: `https://example.com/${i}` } })) }));
  assertReason('search_suggestions_invalid', metadata({ searchEntryPoint: { renderedContent: 'no links' } }));
  assertReason('search_url_invalid', metadata({ groundingChunks: [{ web: { uri: 'http://example.com/source' } }] }));
  assertReason('search_url_invalid', metadata({ searchEntryPoint: { renderedContent: '<a href="http://google.com">bad</a>' } }));
});

test('Search validation still caps suggestions and accepts safe grounded results', () => {
  const links = Array.from({ length: 6 }, (_, i) => `<a href="https://google.com/search?q=${i}">q</a>`).join('');
  const result = readGoogleSearch(candidate(metadata({ searchEntryPoint: { renderedContent: links } })), content());
  assert.equal(result.sources.length, 1);
  assert.equal(result.suggestions.length, 5);
  assert.equal(result.text, 'ผลค้นจากเว็บ');
});
