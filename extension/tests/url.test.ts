import { describe, expect, it } from 'vitest';
import { dedupeKey, displayDomain, normalizeUrl, unsupportedReason } from '@/src/lib/url';

describe('normalizeUrl', () => {
  it('treats trivially different links to the same page as equal', () => {
    const variants = [
      'https://www.Example.com/work/',
      'https://example.com/work',
      'https://example.com/work#team',
      'https://example.com/work?utm_source=x&utm_medium=y',
      'https://example.com/work?fbclid=abc',
    ];
    expect(new Set(variants.map(normalizeUrl))).toEqual(new Set(['https://example.com/work']));
  });

  it('keeps meaningful query params, sorted', () => {
    expect(normalizeUrl('https://example.com/search?q=type&page=2')).toBe(
      'https://example.com/search?page=2&q=type',
    );
  });

  it('keeps hash routes but drops plain anchors', () => {
    expect(normalizeUrl('https://example.com/#/projects')).toBe('https://example.com#/projects');
    expect(normalizeUrl('https://example.com/#!/projects')).toBe('https://example.com#!/projects');
    expect(normalizeUrl('https://example.com/#about')).toBe('https://example.com');
  });

  it('keeps scheme and non-default ports distinct', () => {
    expect(normalizeUrl('http://example.com:8080/')).toBe('http://example.com:8080');
    expect(normalizeUrl('https://example.com:443/')).toBe('https://example.com');
  });
});

describe('dedupeKey', () => {
  it('uses a same-site canonical URL', () => {
    expect(
      dedupeKey('https://example.com/p?id=1&ref=tw', 'https://www.example.com/products/1'),
    ).toBe('https://example.com/products/1');
  });

  it('ignores a canonical on another host', () => {
    expect(dedupeKey('https://studio.design/work', 'https://other.com/')).toBe(
      'https://studio.design/work',
    );
  });

  it('ignores a malformed canonical', () => {
    expect(dedupeKey('https://example.com/a', 'not a url')).toBe('https://example.com/a');
  });
});

describe('unsupportedReason', () => {
  it.each([
    ['https://example.com/', null],
    ['http://localhost:3000/', null],
    [undefined, "Browser pages can't be saved."],
    ['chrome://settings', "Browser pages can't be saved."],
    ['chrome-extension://abc/newtab.html', "Browser pages can't be saved."],
    ['about:blank', "Browser pages can't be saved."],
    ['view-source:https://example.com', "Browser pages can't be saved."],
    ['file:///Users/me/site.html', "Local files can't be saved."],
    [
      'https://chromewebstore.google.com/detail/x',
      "Chrome doesn't let extensions capture the Web Store.",
    ],
    [
      'https://chrome.google.com/webstore/detail/x',
      "Chrome doesn't let extensions capture the Web Store.",
    ],
    ['https://example.com/paper.PDF', "PDFs can't be saved."],
  ])('%s', (url, expected) => {
    expect(unsupportedReason(url)).toBe(expected);
  });
});

describe('displayDomain', () => {
  it('drops www.', () => {
    expect(displayDomain('https://www.awwwards.com/sites/x')).toBe('awwwards.com');
  });
});
