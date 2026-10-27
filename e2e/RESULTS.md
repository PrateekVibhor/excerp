# End-to-end test results — Feature 12, step 10

Recorded 2026-10-09 against `sdlc/intent-12.md`, `sdlc/spec-12.md` and `sdlc/plan-12.md`.

## What was run

| | |
| --- | --- |
| Code | git `26d1a44` (the app's own code is unchanged since the test builds were made) |
| Builds | `e2e-api`: EAS build `ad9e6c91-06fb-4332-90be-b72b19744e47`; `e2e-mock`: EAS build `645f792b-a1b3-415a-8b25-60b4cf8764d4` |
| Simulator | iPhone 17e (iOS 27.0). Flows 01 to 06 had also passed on the iPhone 18 Pro earlier. |
| Tools | Maestro 2.11.0, Temurin Java 17.0.20 |
| Command | `E2E_DEVICE=<iPhone 17e id> e2e/run.sh`, three times in a row |

## Three full runs

| Run | Started | Flows | Duration | Mac load at start | Left behind |
| --- | --- | --- | --- | --- | --- |
| 1 | 12:45 | 10 of 10 passed | 444 s | 8.5 | no test server, database schema or Maestro process; output 5.6 MB |
| 2 | 12:53 | 10 of 10 passed | 394 s | 5.2 | nothing; output 228 KB |
| 3 | 12:59 | 10 of 10 passed | 409 s | 3.4 | nothing; output 292 KB |

Flow times in the last run: 01 24 s, 02 23 s, 03 42 s, 04 29 s, 05 68 s, 06 46 s, 10 32 s, 11 39 s, 12 54 s, 13 47 s.

## Scenarios in `intent-12.md`

| Scenario | Result | Evidence |
| --- | --- | --- |
| One command runs every flow | pass | `e2e/run.sh`, three runs |
| Approved reader signs in | pass | flow 01 |
| Reader who cancels the sign-in sheet | pass | flow 02 |
| Reader who is not approved sees the waiting screen | pass | flow 03 (the unverified reader as well) |
| Waiting reader is approved | pass | flow 04; the Google sheet does not open a second time |
| Swiping saves and skips | pass | flow 10 |
| Running out of cards | pass | flow 11 ("You're all caught up", "9 stories reviewed · 1 saved") |
| Passing a quiz verifies the article | pass | flow 12 (Verified result; the Profile shows "1 verified articles") |
| Failing a quiz does not verify | pass | flow 13 ("2 of 3", "Try again"; the Profile still says "No verified articles yet") |
| Leaderboard shows a verified reader | pass | flow 05 (`1. Reader, 1 verified, you`) |
| Leaderboard states | pass | flow 06. The unreachable state uses the test server's `/e2e/leaderboard-down` switch, as `spec-12.md` specifies, not stopping the server. |
| Flows start clean | pass | every flow begins with clean-start; flow 02 follows flow 01 (which signs in) and still sees the sign-in screen |
| Live systems are untouched | pass, static | `src/e2e/safety.test.ts` and `e2e/check-bundles.sh`; network traffic was not captured |
| A failure leaves evidence | pass | a deliberately broken flow failed after its timeout and saved a screenshot and a screen dump |

## Scenarios in `spec-12.md`

| Scenario | Result | Evidence |
| --- | --- | --- |
| One command | pass | three runs; the server stops and its schema is dropped each time |
| Missing prerequisite | pass | `src/e2e/runScript.test.ts` (exit 2, names the missing tools) |
| Stand-in sheet | pass | every api flow signs in through it; the sheet was also looked at directly |
| Stand-in is build-time only | pass | `src/e2e/buildProfiles.test.ts`, `src/e2e/metroConfig.test.ts`, `e2e/check-bundles.sh` on real bundles (absent from three builds, present in `e2e-api`) |
| Test server cannot reach production | pass | `src/e2e/safety.test.ts`: the image copies only the package files, the shared types and `server/src`; no production code imports the test server or knows the `e2e:` token |
| Test token on the real verifier | pass | `server/e2e/server.test.ts`: the real Google check refuses `e2e:tester@example.com` |
| Reset | pass | `server/e2e/server.test.ts` (also with a `{}` body, as Maestro calls it) |
| Approving a waiting reader from a flow | pass | `server/e2e/server.test.ts` and flow 04 |
| Leaderboard failure switch | pass | `server/e2e/server.test.ts` and flow 06 |
| Flow data matches the app | pass | `src/e2e/flowData.test.ts` (14 tests); it fails when a correct answer or an article date is changed |
| Clean start | pass | as above |
| No fixed sleeps | pass | `src/e2e/safety.test.ts`; it fails when a wait command or a bare `sleep` is added |
| No live address | pass | `src/e2e/safety.test.ts`; it fails when a live address is added to a flow |
| Failure evidence | pass | the broken-flow and timeout runs |

## Scenarios in `plan-12.md`

| Scenario | Result | Evidence |
| --- | --- | --- |
| Steps run in order | pass | each step was checked before the next began; the leaderboard flows came last |
| Prerequisites are proven before anything is built on them | pass | a two-line flow ran on the simulator first; every Maestro command the spec names was confirmed |
| Every flow is repeatable | pass | each flow passed repeatedly; the full run passed three times in a row |
| A failing flow is caught | pass | a flow waiting for text that never appears fails within its timeout |
| Production is untouched | pass, static | no live address in any end-to-end file; the production image holds no test server and no test verifier; the stand-in is in no profile except `e2e-api` |
| Scope stays closed | pass | no Android flows, no cloud or CI setup, no screenshot comparison |

## Other checks that passed

- App: 75 suites, 1039 tests; typecheck clean.
- Server: 432 tests; typecheck clean.
- `e2e/check-bundles.sh`: the Google stand-in is absent from the live-style, `e2e-mock` and flag-not-`true` bundles, and present in `e2e-api`.

## What these results do not cover

- The real Google sign-in sheet cannot be driven by a script. The test build replaces it, so check the real sheet by hand on a development build before a release.
- The "no live address" promise is checked in files, build profiles and exported bundles. No network traffic was captured during a run.
- Only the ten flows in `e2e/flows/` exist. InMail, the Reading List beyond what a flow passes through, the Profile form, and Android are not covered.
- The test builds contain the app's code as it was when they were built. After any change to the app, build and fetch them again (see `README.md`), or a run tests old code.

## Build 6 run (2026-10-24)

| | |
| --- | --- |
| Code | git `5ca52d0` plus the one selector fix below (committed after the run) |
| Builds | `e2e-api`: EAS build `6d26d586-513c-4120-99b5-2ff9a9606996`; `e2e-mock`: EAS build `8559be25-fbd1-4c80-b6d4-9369171268d1`; both made from `5ca52d0` |
| Simulator | iPhone 17e (iOS 27.0) |
| Tools | Maestro 2.11.0, Java 17.0.20 |
| Commands | `E2E_DEVICE=<iPhone 17e id> e2e/run.sh` (plain test server, once); the two `lists` flows by hand against `npm run demo:lists` |

**Plain test server, `e2e/run.sh`: 11 of 11 flows passed on the first run**, with the intro cards now dismissed by `shared/dismiss-intro.yaml`:
01 sign-in-approved 65 s, 02 sign-in-cancelled 38 s, 03 waiting 54 s, 04 waiting-then-approved 47 s, 05 leaderboard-shows-reader 84 s, 06 leaderboard-states 60 s,
07 intro-cards (new) 77 s, 10 feed-swipe 49 s, 11 all-caught-up 60 s, 12 quiz-pass 72 s, 13 quiz-fail 66 s.

**List demo server, run by hand:**

| Flow | Result | Notes |
| --- | --- | --- |
| `lists/20-tab-order-and-ready-list` | pass (36 s), after one fix | First attempt failed: the Skills list tab's accessible name is "Skills list, New coverage" while the reader has the new-coverage dot (the demo reader does), so the exact text "Skills list" matched nothing. The flow now matches `Skills list.*`; no check was loosened. The screenshot of the failed attempt showed the tabs in the right order. |
| `lists/21-cancel-build` | **FAIL, an app bug** | Everything up to Stop building passed (opening the building list, 62%, the step labels, the menu with Cancel build and Close, Keep building changing nothing). After Stop building the dialog stays open with the red "Something went wrong on our side. Try again.", although the server did stop the list ("List stopped" and the calm message are behind the dialog). Cause: `cancel` in `src/data/courseApi.ts` parses the server's `200` JSON answer with `() => null`, which the shared `call` helper turns into `{ kind: 'failed', server: true }`. The delete step after it has not been exercised. Not fixed here (it is in `src/`). The flow was not changed. |

Evidence for the failure is under `e2e/output/lists-*/21/` (git-ignored). Both servers were stopped afterwards and the demo server's throwaway schema was dropped.

### Rerun after the Cancel build fix (2026-10-24)

| | |
| --- | --- |
| Code | git `f1f8835` (the fix: `cancel` now reads the server's `{course_id, status}` answer) |
| Build | `e2e-api`: EAS build `e173e45e-d66e-4168-a065-49cd19010e60`, made from `f1f8835` (the `e2e-mock` build and the plain flows were not redone; the fix touches only the list calls) |
| Simulator, tools | iPhone 17e (iOS 27.0), Maestro 2.11.0 |
| Server | `npm run demo:lists` on a fresh throwaway schema, stopped afterwards and the schema dropped |

| Flow | Result | Notes |
| --- | --- | --- |
| `lists/20-tab-order-and-ready-list` | pass | no change to the flow |
| `lists/21-cancel-build` | **pass, including Delete** | Stop building now shows "List stopped" with "You stopped this list. Delete it or start a new one." and no error; the options menu then offers Delete and Close but not Cancel build; Delete asks "Delete this list?", and Delete list removes it. No check was loosened and no flow file was changed. |

Not covered by any of this: the real Google and Apple sign-in sheets, real storage and timings on a phone, a real list build and cancel against production, and VoiceOver.
