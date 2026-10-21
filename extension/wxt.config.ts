import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: ({ mode }) => ({
    name: 'Visual Memory',
    description:
      'Save sites exactly as they looked and find them again by describing what you saw.',
    permissions: [
      // A shortcut or toolbar click grants access to the current tab only.
      'activeTab',
      'scripting',
      'contextMenus',
      'notifications',
      'favicon',
      'unlimitedStorage',
      // Import progress, so an import cut off by a service worker restart can resume.
      'storage',
    ],
    // Importing open tabs captures tabs without a keypress on each one, which activeTab
    // can't cover. The new tab asks for this when you start an import, not at install.
    optional_host_permissions: ['<all_urls>'],
    // e2e tests can't press shortcuts, so their build gets standing access instead of activeTab.
    host_permissions: mode === 'e2e' ? ['<all_urls>'] : [],
    action: { default_title: 'Save this page' },
    commands: {
      'save-page': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save this page',
      },
      'save-and-close': {
        suggested_key: { default: 'Alt+Shift+X' },
        description: 'Save this page and close the tab',
      },
    },
  }),
});
