import { createCourseModeration, type CourseModeration } from './courses/courseModeration.ts';
import { createTrackedCompanies } from './courses/trackedCompanies.ts';
import { createDb } from './db.ts';
import { createModeration, type Moderation, type ReportSummary } from './moderation.ts';

const USAGE = `Usage: moderate <command>
  reports                              open reports, oldest first
  show <report-id>                     one report with the frozen copy of what was reported
  suspend <public-id> <days> [why]     hide a reader and stop their messaging
  unsuspend <public-id> [why]          lift a suspension
  ban <public-id> [why]                end access for good
  resolve <report-id> <resolved|dismissed> [what was done]
  delete-message <message-id> [why]    delete a message for both people
  log [how-many]                       what has been done, newest first

Courses:
  course-queue                         open flags, failed runs and withdrawn courses
  course-flag <flag-id>                one flag with its frozen copy and the chapter as it reads now
  course-dismiss <flag-id> [why]       handle a flag as not an error
  course-withdraw <course-id> <notice> withdraw a ready course; the notice is shown to its readers
  course-edit <chapter-id> <new text>  correct a chapter in a correction version (live until marked corrected)
  course-corrected <course-id>         corrections done: run the checks and, on a pass, republish
  course-regenerate <chapter-id> [why] ask for a chapter to be written again
  course-excerpts <course-id>          the claims about law, safety, money or health, with their supporting passages
  tracked-list                         the tracked companies
  tracked-add <domain> <employer...>   add a company as a candidate
  tracked-status <domain> <candidate|trusted|blocked>`;

const when = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function describe(r: ReportSummary): string {
  const who = r.reported ? `${r.reported.display_name ?? '?'} (${r.reported.public_id ?? 'no longer has an account'})` : 'unknown';
  return `${r.id}  ${when(r.created_at)}  ${r.kind}  ${r.reason}  ${who}${r.note ? `  note: ${r.note}` : ''}`;
}

/**
 * One command of the owner's moderation tool. Returns the exit code: 0 done, 1 not found or nothing to do, 2 not understood.
 * Everything that changes anything is written to the moderation log.
 */
export interface CourseTools {
  courses: CourseModeration;
  tracked: ReturnType<typeof createTrackedCompanies>;
}

export async function runModerate(args: string[], moderation: Moderation, print: (line: string) => void, now: () => Date = () => new Date(), tools?: CourseTools): Promise<number> {
  const [command, first, second, ...rest] = args;
  const usage = () => {
    print(USAGE);
    return 2;
  };
  const words = (...parts: Array<string | undefined>) => parts.filter((p) => p !== undefined).join(' ');
  const done = (ok: boolean, yes: string, no: string) => {
    print(ok ? yes : no);
    return ok ? 0 : 1;
  };

  switch (command) {
    case 'reports': {
      const open = await moderation.openReports();
      if (open.length === 0) print('No open reports.');
      for (const r of open) print(describe(r));
      return 0;
    }
    case 'show': {
      if (first === undefined) return usage();
      const r = await moderation.showReport(first);
      if (!r) return done(false, '', 'No such report.');
      print(describe(r));
      print(`status: ${r.status}`);
      print(JSON.stringify(r.snapshot, null, 2));
      return 0;
    }
    case 'suspend': {
      const days = Number(second);
      if (first === undefined || !Number.isInteger(days) || days < 1 || days > 3650) return usage();
      return done(await moderation.suspend(first, days, words(...rest), now()), `Suspended for ${days} day(s).`, 'No such reader.');
    }
    case 'unsuspend':
      if (first === undefined) return usage();
      return done(await moderation.unsuspend(first, words(second, ...rest), now()), 'Suspension lifted.', 'No such reader.');
    case 'ban':
      if (first === undefined) return usage();
      return done(await moderation.ban(first, words(second, ...rest), now()), 'Banned.', 'No such reader.');
    case 'resolve': {
      if (first === undefined || (second !== 'resolved' && second !== 'dismissed')) return usage();
      return done(await moderation.resolveReport(first, second, words(...rest), now()), `Report ${second}.`, 'No such open report.');
    }
    case 'delete-message':
      if (first === undefined) return usage();
      return done(await moderation.deleteMessage(first, words(second, ...rest), now()), 'Message deleted.', 'No such message.');
    case 'log': {
      const n = first === undefined ? 20 : Number(first);
      if (!Number.isInteger(n) || n < 1) return usage();
      for (const e of await moderation.log(n)) print(`${when(e.created_at)}  ${e.actor.padEnd(6)}  ${e.action}  ${e.public_id ?? ''}  ${e.reason}`);
      return 0;
    }
    case 'course-queue': {
      if (!tools) return usage();
      const q = await tools.courses.queue();
      if (q.flags.length + q.failedRuns.length + q.withdrawn.length === 0) print('Nothing needs attention.');
      for (const f of q.flags) print(`flag ${f.id}  ${when(f.created_at)}  ${f.course_title}  ${f.target_type}  ${f.reason}${f.note ? `  note: ${f.note}` : ''}`);
      for (const r of q.failedRuns) print(`failed run ${r.id}  ${when(r.started_at)}  ${r.course_title}  ${r.kind}/${r.stage}  ${r.error}`);
      for (const w of q.withdrawn) print(`withdrawn ${w.course_id}  ${w.title}  ${w.withdrawal_note ?? ''}`);
      return 0;
    }
    case 'course-flag': {
      if (!tools || first === undefined) return usage();
      const f = await tools.courses.showFlag(first);
      if (!f) return done(false, '', 'No such flag.');
      print(`${f.id}  ${f.course_title}  ${f.target_type}  ${f.reason}  ${f.status}${f.action ? ` (${f.action})` : ''}  open readers: ${f.open_readers}`);
      if (f.note) print(`note: ${f.note}`);
      print('--- as flagged ---');
      print(f.snapshot);
      if (f.current_text !== null) {
        print('--- as it reads now ---');
        print(f.current_text);
      }
      return 0;
    }
    case 'course-dismiss':
      if (!tools || first === undefined) return usage();
      return done(await tools.courses.dismissFlag(first, words(second, ...rest)), 'Flag dismissed.', 'No such open flag.');
    case 'course-withdraw': {
      if (!tools || first === undefined || second === undefined) return usage();
      const r = await tools.courses.withdraw(first, words(second, ...rest), '');
      return done(r === 'ok', 'Withdrawn. Readers see the notice and no content.', r === 'invalid' ? 'A notice for readers is needed.' : 'No such ready course.');
    }
    case 'course-edit': {
      if (!tools || first === undefined || second === undefined) return usage();
      const r = await tools.courses.editChapter(first, words(second, ...rest));
      return done(r === 'ok', 'Saved in a correction version. Run course-corrected when you are done.', r === 'invalid' ? 'The text is empty or too long.' : r === 'not_editable' ? 'The course is not ready or withdrawn.' : 'No such chapter.');
    }
    case 'course-corrected': {
      if (!tools || first === undefined) return usage();
      const r = await tools.courses.markCorrected(first);
      switch (r.kind) {
        case 'published': return done(true, 'The checks passed and the corrected course is live.', '');
        case 'checks_failed': r.reasons.forEach((reason) => print(`check failed: ${reason}`)); return done(false, '', 'The checks failed; the course is unchanged. Edit and try again.');
        case 'no_checker': return done(false, '', 'The checks are not available yet, so nothing can be republished.');
        case 'nothing_to_publish': return done(false, '', 'There are no corrections to publish.');
        default: return done(false, '', 'No such course.');
      }
    }
    case 'course-regenerate':
      if (!tools || first === undefined) return usage();
      return done(await tools.courses.regenerate(first, words(second, ...rest)), 'Queued.', 'No such chapter.');
    case 'course-excerpts': {
      if (!tools || first === undefined) return usage();
      const rows = await tools.courses.excerpts(first);
      if (rows.length === 0) print('No claim excerpts.');
      for (const e of rows) print(`${e.category}  ${e.claim}  |  "${e.excerpt}"  ${e.url}`);
      return 0;
    }
    case 'tracked-list': {
      if (!tools) return usage();
      for (const t of await tools.tracked.list()) print(`${t.domain}  ${t.status}  ${t.employer}  successes ${t.successes}  failures ${t.failures}`);
      return 0;
    }
    case 'tracked-add': {
      if (!tools || first === undefined || second === undefined) return usage();
      const added = await tools.tracked.add({ employer: words(second, ...rest), domain: first, addedBy: 'owner' });
      if (added) await tools.courses.record('tracked_add', first, { domain: first.toLowerCase() });
      return done(added, 'Added as a candidate.', 'That domain is already listed.');
    }
    case 'tracked-status': {
      if (!tools || first === undefined || !['candidate', 'trusted', 'blocked'].includes(second ?? '')) return usage();
      const changed = await tools.tracked.setStatus(first, second as 'candidate' | 'trusted' | 'blocked');
      if (changed) await tools.courses.record('tracked_status', second!, { domain: first.toLowerCase() });
      return done(changed, `Now ${second}.`, 'No such domain.');
    }
    default:
      return usage();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    process.exitCode = await runModerate(process.argv.slice(2), createModeration(db.pool), console.log, undefined, { courses: createCourseModeration(db.pool), tracked: createTrackedCompanies(db.pool) });
  } catch {
    console.error('The database could not be reached.'); // never echo connection details
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
