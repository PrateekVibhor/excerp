// Puts the email named by ALLOW_EMAIL on the test server's allow-list, as the owner would with the allow command.
const server = typeof E2E_SERVER !== 'undefined' ? E2E_SERVER : 'http://localhost:8787'
const res = http.post(server + '/e2e/allow', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ALLOW_EMAIL }) })
output.allowStatus = res.status
