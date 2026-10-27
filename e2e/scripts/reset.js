// Resets the test server (spec 12): empties sign-ins, sessions and leaderboard, reseeds the sample articles, and leaves only
// the approved test reader on the allow-list. Maestro's http.post must send a body, so it sends an empty JSON object.
const server = typeof E2E_SERVER !== 'undefined' ? E2E_SERVER : 'http://localhost:8787'
const res = http.post(server + '/e2e/reset', { headers: { 'Content-Type': 'application/json' }, body: '{}' })
output.resetStatus = res.status
