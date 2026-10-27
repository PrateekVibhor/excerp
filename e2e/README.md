# End-to-end tests

Maestro flows that use the real app on the iOS simulator the way a reader does (spec 12, `sdlc/spec-12.md`).

## Run everything

```
e2e/run.sh
```

It checks the prerequisites, starts a test server on this Mac, installs each test build on the simulator, runs its flows, stops the
server (also on failure or Ctrl-C), and prints which flows passed. Exit code: `0` all passed, `1` a flow failed or timed out, `2` something
was missing or could not be set up.

Useful settings: `E2E_ONLY=waiting` (only flows whose `group/name` contains that text), `E2E_DEVICE=<simulator id>`,
`E2E_FLOW_TIMEOUT=<seconds>` (default 240).

## What you need once

- **Maestro** (`brew` could not install it here; the official release unpacked into `~/.maestro` works). `run.sh` finds `~/.maestro/bin` itself. To
  use `maestro` in your own shell, add `export PATH="$PATH:$HOME/.maestro/bin"` to your shell profile.
- **A Java 17 or newer runtime.**
- **Xcode** with a booted iPhone simulator. With two booted, `run.sh` uses the iPhone 18 Pro (or set `E2E_DEVICE`).
- **Postgres** running locally (the test server makes a throwaway schema in it; `DATABASE_URL` defaults to `postgres://localhost:5432/swipy`).
- **The two test builds**, fetched with `e2e/fetch-build.sh e2e-api` and `e2e/fetch-build.sh e2e-mock`.

## The two test builds

| Profile | Data | Used by |
| --- | --- | --- |
| `e2e-api` | the test server on `http://localhost:8787`, and a stand-in for Google's sign-in sheet | `flows/api` (sign-in, waiting, leaderboard) |
| `e2e-mock` | the app's nine built-in sample articles, no server | `flows/mock` (Feed swiping, quiz) |

**A build contains the app's code as it was when it was built.** After any change to the app, build again (`npx eas-cli build --profile e2e-api
--platform ios`, and the same for `e2e-mock`), then fetch it. A run prints each build's EAS id and finish time, and the git commit now, so a stale
build is visible. The commit label EAS shows is the last commit, not uncommitted changes that were uploaded with it.

If you change `EXPO_PUBLIC_E2E` while running Metro yourself, start Metro with `--clear`: the stand-in for Google is left out of every build except
`e2e-api`, and Metro would otherwise reuse an earlier answer.

## Build 6: intro cards and the Skills list flows

- **Intro cards.** Build 6 shows three cards over the app after sign-in (on the mock build, at once) on every cold start. `flows/shared/dismiss-intro.yaml` leaves them with
  Skip and proves they are gone; it is called in flows api/01, 04, 05, 06 and mock/10 to 13. It finds the cards by their own checkbox ("Don't show this again"), so it cannot
  tap the Feed's "Skip". With no cards on the build it waits 60 s once and carries on. `flows/api/07-intro-cards.yaml` tests the cards themselves.
- **Skills list flows** (`flows/lists/`) need the list demo server, not the plain test server (which has accounts and course routes off, so the Skills list tab says it needs the
  live app). They are **not part of `run.sh` yet**. To run them by hand, with the `e2e-api` build installed and nothing else on port 8787:

  ```
  cd server && npm run demo:lists          # six seeded lists, fake data, no credits; leave it running
  maestro test --device <simulator id> e2e/flows/lists/20-tab-order-and-ready-list.yaml
  maestro test --device <simulator id> e2e/flows/lists/21-cancel-build.yaml
  ```

  Each flow resets the demo itself (`flows/shared/reset-demo.yaml`). Stop the demo server with Ctrl-C so it drops its schema. Never use `npm run demo:real` for these.
- The test builds must be made again for any of this: the ones in `e2e/builds` are from before build 6.

## Waits

Flows wait for text to appear (`extendedWaitUntil`) and never sleep for a fixed time. A wait ends the moment its text shows, so a long limit costs
nothing when things work. After a reinstall the app starts cold and, on a busy Mac, can take well over 20 seconds to draw its first screen, so those
waits are 60 seconds.

## Reading a failure

Each flow's output is under `e2e/output/<run>/<group>/<flow>/`: a screenshot and a dump of what was on the screen when it failed, plus the log
at `<flow>.log` and a JUnit report at `<flow>.xml`. A flow that hangs is stopped after the timeout and reported as `TIMEOUT`. `e2e/output/` and
`e2e/builds/` are not committed.

## What is not covered

The real Google sign-in sheet cannot be driven by a script, so the test build replaces it. Check the real sheet by hand on a development build
before a release. The flows never use the live API.
