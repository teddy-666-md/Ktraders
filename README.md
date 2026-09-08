# Deriv Bot Scanner 3.0

Render Web Service using Node.js + Playwright.

### Render
Runtime: Node
Build Command:
`npm install && npx playwright install chromium`
Start Command:
`node server.js`

The server renders public pages in a headless Chromium browser and inspects visible links, iframes, scripts, embedded URLs and XML references. It may discover more than a simple HTTP fetch when a public site renders its catalog with JavaScript.

It does not bypass authentication, CAPTCHA, Cloudflare challenges, paywalls, private APIs, or other access controls. Some sites deliberately hide direct download URLs until a user is logged in or performs a purchase; those cannot be extracted without authorized access.
