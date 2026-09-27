# Boom — Focus Budget

A deliberately small Chrome extension: choose a group of sites, give the group one shared allowance, and start. When the allowance reaches zero, the sites redirect to a lock screen until the cooldown ends.

## Run it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin **Boom** and click its icon.

## MVP behavior

- Counts only time on the focused, active tab.
- A 30-minute allowance is shared across every selected domain and its subdomains.
- When time is exhausted, selected sites are locked for the chosen cooldown.
- The extension automatically unlocks and clears the allowance when the cooldown ends.

This is intentionally not a daily-budget or scheduling product. Each session begins with one explicit **Start** action.

## Validate behavior

Run `node tests/background.test.cjs`. The test covers allowance consumption on the active tab, blocking-rule installation, immediate redirection, cooldown expiry, blocking-rule removal, and ignored heartbeats from inactive tabs.
