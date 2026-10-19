export const PLACEHOLDER_TITLE = 'Visual Memory';

/** Temporary new-tab content until the wall lands in Phase 1. */
export function renderPlaceholder(root: HTMLElement): void {
  const wrapper = document.createElement('main');
  wrapper.className = 'placeholder';
  wrapper.dataset.testid = 'newtab-placeholder';

  const heading = document.createElement('h1');
  heading.textContent = PLACEHOLDER_TITLE;

  const body = document.createElement('p');
  body.textContent = 'Your saved sites will appear here.';

  wrapper.append(heading, body);
  root.replaceChildren(wrapper);
}
