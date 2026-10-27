// Plan 16, phase 4, stages 1 to 3: the source-finding run that precedes approval (spec 16, section 6). It records the role, finds the matching
// postings across the tracked companies, writes them as the course's sources (the pool, and near-matches as not used) and leaves the course
// awaiting approval. Nothing is generated and no generation tokens are spent before the reader approves.
import type pg from 'pg';
import type { Chat } from '../../llm.ts';
import { createSources } from '../sources.ts';
import { normalizeInput } from './normalize.ts';
import { findPostings, type SearchClient } from './postings.ts';
import { runStages, type RunResult, type Stage } from './run.ts';

export interface FindDeps {
  pool: pg.Pool;
  chat: Chat;
  search: SearchClient;
  now?: () => Date;
  creditBudget?: number;
  onStageStart?: (stage: string) => void;
}

interface Ctx {
  courseId: string;
  roleId: string;
  roleName: string;
  aliases: string[];
  found?: Awaited<ReturnType<typeof findPostings>>;
}

/** `runId` is the run the app already queued for this search (the runner passes it); left out, a new run is made, as the research scripts do. */
export async function findCourseSources(deps: FindDeps, courseId: string, runId?: number): Promise<RunResult> {
  const { pool, chat, search } = deps;
  const now = deps.now ?? (() => new Date());
  const sources = createSources(pool, now);
  const course = (await pool.query(`SELECT c.role_id, c.requested_by, r.name, r.description FROM courses c JOIN roles r ON r.id = c.role_id WHERE c.id = $1`, [courseId])).rows[0];
  if (!course) throw new Error('no such course');
  const ctx: Ctx = { courseId, roleId: course.role_id, roleName: course.name, aliases: (await pool.query(`SELECT title_seen FROM role_aliases WHERE role_id = $1`, [course.role_id])).rows.map((r) => r.title_seen) };

  const stages: Stage<Ctx>[] = [
    {
      name: 'normalize',
      async run(c) {
        const n = await normalizeInput({ chat, typed: c.roleName });
        if (!n.ok) {
          await pool.query(`UPDATE courses SET status = 'failed', failure_reason = $2 WHERE id = $1 AND status = 'finding_sources'`, [courseId, n.reason]); // a cancel is never overwritten
          throw new Error(n.reason);
        }
        if (!course.description) await pool.query(`UPDATE roles SET description = $2 WHERE id = $1`, [c.roleId, n.description]);
        for (const a of n.aliases) await sources.learnAlias(c.roleId, a, true);
        c.aliases = [...new Set([...c.aliases, ...n.aliases])];
      },
    },
    {
      name: 'find',
      async run(c, io) {
        const rows = (await pool.query(`SELECT employer, domain FROM tracked_companies WHERE status <> 'blocked' ORDER BY domain`)).rows as Array<{ employer: string; domain: string }>;
        const byEmployer = new Map<string, string[]>();
        for (const r of rows) byEmployer.set(r.employer, [...(byEmployer.get(r.employer) ?? []), r.domain]);
        c.found = await findPostings({ role: c.roleName, aliases: c.aliases, companies: [...byEmployer].map(([employer, domains]) => ({ employer, domains })), search, chat, io });
      },
    },
    {
      // A description the reader pasted becomes their own source: private to them, no link, and it never counts toward a skill's share of the postings. It is
      // read for its skills when the course is built; here it is only registered, once, so that it is listed for approval with the rest.
      name: 'reader',
      async run(c) {
        const owner = (await pool.query(`SELECT c.visibility, c.owner_account_id, i.pasted_text FROM courses c LEFT JOIN course_inputs i ON i.course_id = c.id AND i.account_id = c.owner_account_id WHERE c.id = $1`, [c.courseId])).rows[0];
        if (!owner || owner.visibility !== 'private' || !owner.owner_account_id || !owner.pasted_text?.trim()) return;
        if ((await pool.query(`SELECT 1 FROM course_sources WHERE course_id = $1 AND use = 'reader'`, [c.courseId])).rowCount) return;
        const id = await sources.registerPaste(c.roleId, owner.owner_account_id, { roleTitle: c.roleName });
        await sources.attach(c.courseId, id, 'reader');
      },
    },
    {
      name: 'record',
      async run(c) {
        for (const m of c.found!.matched) {
          const title = m.title.replace(/^job application for\s+/i, '').trim();
          // A title another company uses for the same job is an alias; a judged-same similar title is kept as one.
          const id = await sources.upsertPosting(c.roleId, { company: m.employer, roleTitle: title, url: m.url, match: m.match === 'exact' ? 'exact' : 'alias', foundVia: 'tracked_search' });
          await sources.attach(c.courseId, id, 'pool');
          if (m.match !== 'exact') await sources.learnAlias(c.roleId, title, true);
        }
        for (const n of c.found!.notUsed.filter((x) => x.reason === 'title only resembles the role')) {
          const id = await sources.upsertPosting(c.roleId, { company: n.employer, roleTitle: n.title.replace(/^job application for\s+/i, '').trim(), url: n.url, match: 'similar', foundVia: 'tracked_search' });
          await sources.attach(c.courseId, id, 'not_used', n.reason);
        }
        await pool.query(`UPDATE courses SET status = 'awaiting_approval' WHERE id = $1 AND status = 'finding_sources'`, [c.courseId]);
      },
    },
  ];
  return runStages(pool, { courseId, kind: 'source_finding', requestedBy: course.requested_by ?? undefined, now, creditBudget: deps.creditBudget, runId, onStageStart: deps.onStageStart }, stages, ctx);
}
