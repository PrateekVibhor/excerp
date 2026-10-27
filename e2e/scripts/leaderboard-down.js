// Makes the test server's /leaderboard answer 503 (LEADERBOARD_DOWN = "true") or answer normally again ("false").
const server = typeof E2E_SERVER !== 'undefined' ? E2E_SERVER : 'http://localhost:8787'
const res = http.post(server + '/e2e/leaderboard-down', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ down: LEADERBOARD_DOWN === 'true' }) })
output.downStatus = res.status
