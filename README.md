# Boom — Focus Budget

A deliberately small Chrome extension: choose a group of sites, give the group one shared allowance, and start. When the allowance reaches zero, the sites redirect to a lock screen until the cooldown ends.

## Run it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin **Boom** and click its icon.

## MVP behavior

- Counts only time on the focused, active tab.
- A minute-based allowance, optionally fine-tuned to the second, is shared across every selected domain and its subdomains.
- When time is exhausted, selected sites are locked for the chosen cooldown.
- The extension automatically unlocks and clears the allowance when the cooldown ends.

This is intentionally not a daily-budget or scheduling product. Each session begins with one explicit **Start** action.

## Validate behavior

Run `node tests/background.test.cjs`. The test covers event-driven allowance timing, focus changes, consolidated blocking-rule installation, immediate redirection, optional early unlock, cooldown expiry, and blocking-rule removal.
