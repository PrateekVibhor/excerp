// Puts the list demo server back to its seeded state: the reader's six Skills lists (a ready one with new coverage, a shared one, a thin one, a building one at 62%, a failed one and an old one).
// Only the list demo server (npm run demo:lists) has this route; the plain test server answers 404.
const server = typeof E2E_SERVER !== 'undefined' ? E2E_SERVER : 'http://localhost:8787'
const res = http.post(server + '/e2e/demo/reset', { headers: { 'Content-Type': 'application/json' }, body: '{}' })
output.resetDemoStatus = res.status
