setInterval(() => chrome.runtime.sendMessage({ type: "heartbeat" }).catch(() => {}), 5000);
