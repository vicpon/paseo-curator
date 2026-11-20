# Settings browser harness

Run `npm run preview:settings` from the repository root and open http://127.0.0.1:4178.
This renders the actual [CuratorSettings](../../client/settings.tsx) component and shared
routing discovery with HTML substitutes for Paseo's injected host controls. It does not
install or reload a plugin, connect to the daemon, or send model requests. The catalog is
a fixture based on the standard CLI catalog observed 2026-11-20; models are explicitly fixtures.

Choose Claude or Codex under Review provider, pin a Review model, select Refresh providers,
then reload the browser. Both selections should persist in harness-only localStorage.
None clears both. Unsupported providers are omitted from the menu. Check desktop and 375px layouts.
Screenshots of this harness are browser evidence, not native Paseo UI verification.

- `main.tsx`, `index.html`, `style.css`: browser entry and clearly labeled fixture layout.
- `host-client.tsx`: fixture catalog, model controls, and local settings persistence.
- `host-ui.tsx`: HTML substitutes for host controls and the native refresh button.
- `vite.config.ts`: loopback-only server and module aliases.

The automated interaction regressions are [settings.test.tsx](../settings.test.tsx).
See [routing acceptance and limitations](../../docs/routing.md) and the [project README](../../README.md).
