import { defineConfig } from 'wxt';

/**
 * Public half of a key that pins the packaged extension's id (mipdebknhogpnnhmddnbjdflelnihkpi)
 * wherever it is unpacked. Without it, an unpacked extension's id comes from its folder, so
 * installing an update from a new folder would start an empty local library. Only the public
 * half exists; nothing secret is needed to load an unpacked extension. A Chrome Web Store
 * listing gets its own id and must be uploaded without this field.
 */
const PACKAGED_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApvays0/CoAKELJyOHUVAGH5JVRC5zlhSuEMWn07Wv2C8kdrzOh82d1iYEHxrP1mv8/5MJyHyOn2TRpJXowHgpvIMr92cDC8XA8zQlNerrrN+/azpijbf27jWiJfyX10wcLOnYeptxbrM0p4pQkv+yqv2P6poEdcEIfKttu7NoTxxuDQaCYzsxlp1nO3Sazklf5AOlICDimmiRNYqyuEbY9U3rB5XcEH/BZ4iIRFWVneFlARxgZj+pmHzACyNj5zhVpPJgPKbrOkYjQAj0Wx3wRZs9zoeXkhNFi0rPji54+uPro/0UcL6iyaqNrXSL7cIn8GCL6/i46UBjj7e0YCwzQIDAQAB';

// See https://wxt.dev/api/config.html
export default defineConfig({
  zip: { artifactTemplate: 'visual-memory-{{version}}-chrome.zip' },
  manifest: ({ mode }) => ({
    name: 'Visual Memory',
    ...(mode === 'production' ? { key: PACKAGED_KEY } : {}),
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
      // Import progress, so an import cut off by a service worker restart can resume; and the
      // sign-in session and sync cursor.
      'storage',
      // Retries uploads and checks for changes from other devices, even after the worker stops.
      'alarms',
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
