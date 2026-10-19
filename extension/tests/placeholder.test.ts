// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_TITLE, renderPlaceholder } from '@/src/newtab/placeholder';

describe('renderPlaceholder', () => {
  it('replaces the root contents with the placeholder', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>stale</span>';

    renderPlaceholder(root);

    const main = root.querySelector('[data-testid="newtab-placeholder"]');
    expect(main).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe(PLACEHOLDER_TITLE);
    expect(root.textContent).not.toContain('stale');
  });
});
