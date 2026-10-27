import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStore } from '../authStore.ts';
import type { Acted, CourseActivity } from '../courses/activity.ts';
import type { CourseReads, Read } from '../courses/reads.ts';
import type { CourseStarts, StartResult, StepResult } from '../courses/starts.ts';
import type { createCourseSettings } from '../courses/settings.ts';
import { INDUSTRIES } from '../courses/industries.ts';
import { LIST_MODE_LABELS, LIST_MODE_ROLES, MULTI_LIST_ROLES } from '../courses/listMode.ts';
import { requireAccount } from './me.ts';

export interface CourseRouteDeps {
  store: AuthStore;
  approved: (email: string) => Promise<boolean>;
  reads: CourseReads;
  starts: CourseStarts;
  activity: CourseActivity;
  settings: ReturnType<typeof createCourseSettings>;
  now: () => Date;
  /** Where a route that failed says so (the route and the kind of error only). The default is one JSON line on the console. */
  log?: (event: Record<string, unknown>) => void;
}

/** A route that threw: the reader is told the courses are unavailable, and the log gets the route and the class of the error, never its message, the request or anything of the reader's. */
function routeFailed(deps: CourseRouteDeps, request: FastifyRequest, reply: FastifyReply, error: unknown) {
  (deps.log ?? ((event) => console.log(JSON.stringify(event))))({ event: 'course_route_failed', route: `${request.method} ${request.routeOptions?.url ?? 'unknown'}`, error: error instanceof Error ? error.constructor.name : typeof error });
  return reply.code(503).send({ error: 'courses unavailable' }); // never echo database details
}

/**
 * The read side of Plan 16 courses. Everything needs a signed-in, approved account; with courses switched off every route answers 503.
 * An account that may not see a course is told 404, never 403, and a withdrawn course answers 409 on its content.
 */
export function registerCourseRoutes(app: FastifyInstance, deps: CourseRouteDeps) {
  /** Signed in, approved and courses on, then the read. */
  const route = (read: (accountId: string, params: Record<string, string>, query: Record<string, string | undefined>) => Promise<Read<unknown>>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      if ((await deps.settings.get()).coursesOff) return reply.code(503).send({ error: 'courses_off' });
      const result = await read(who.accountId, request.params as Record<string, string>, (request.query ?? {}) as Record<string, string | undefined>);
      if (result.kind === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (result.kind === 'withdrawn') return reply.code(409).send({ error: 'course_withdrawn' });
      return result.body;
    } catch (error) {
      return routeFailed(deps, request, reply, error);
    }
  };

  const r = deps.reads;
  app.get('/courses/options', route(async () => ({ kind: 'ok', body: { roles: LIST_MODE_ROLES.map((slug) => ({ name: LIST_MODE_LABELS[slug]!.toLowerCase(), label: LIST_MODE_LABELS[slug]!, available: MULTI_LIST_ROLES.includes(slug) })), industries: INDUSTRIES.map((i) => ({ key: i.key, label: i.label })) } })));
  app.get('/courses/:id', route((a, p) => r.home(a, p.id!)));
  app.get('/courses/:id/transparency', route((a, p) => r.transparency(a, p.id!)));
  app.get('/courses/:id/chapters/:chapterId', route((a, p) => r.chapter(a, p.id!, p.chapterId!)));
  app.get('/courses/:id/concepts', route((a, p) => r.concepts(a, p.id!)));
  app.get('/courses/:id/coverage', route((a, p) => r.coverage(a, p.id!)));
  app.get('/courses/:id/sections/:sectionId/quiz', route((a, p) => r.quiz(a, p.id!, p.sectionId!)));
  app.get('/concepts/:id/resources', route((a, p, q) => r.resources(a, p.id!, typeof q.course === 'string' ? q.course : undefined)));
  app.get('/me/courses', route(async (a) => ({ kind: 'ok', body: await r.mine(a) })));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The routes that start, review, approve, swap and cancel a course request (spec 16, section 5). */
export function registerCourseStartRoutes(app: FastifyInstance, deps: CourseRouteDeps) {
  const limited = (reply: FastifyReply, r: { code: string; retryAt: Date | null }) => reply.code(429).send({ error: r.code, retry_at: r.retryAt?.toISOString() ?? null });

  /** Signed in and approved, then the step; the step answers with its own kind. */
  const act = <T>(step: (accountId: string, request: FastifyRequest) => Promise<T>, reply_: (reply: FastifyReply, result: T) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      return reply_(reply, await step(who.accountId, request));
    } catch (error) {
      return routeFailed(deps, request, reply, error);
    }
  };

  const stepReply = (reply: FastifyReply, r: StepResult<Record<string, unknown>>, ok = 200) => {
    switch (r.kind) {
      case 'ok': return reply.code(ok).send(r.body);
      case 'not_found': return reply.code(404).send({ error: 'not found' });
      case 'conflict': return reply.code(409).send({ error: r.error });
      case 'withdrawn': return reply.code(409).send({ error: 'course_withdrawn' });
      case 'limited': return limited(reply, r);
      case 'off': return reply.code(503).send({ error: 'courses_off' });
    }
  };

  app.post('/courses', { bodyLimit: 16_384 }, act(
    (accountId, request) => deps.starts.start(accountId, isObject(request.body) ? request.body : {}),
    (reply, r: StartResult) => {
      switch (r.kind) {
        case 'created': return reply.code(202).send({ course_id: r.courseId, status: r.status });
        case 'existing': return reply.code(200).send({ course_id: r.courseId, status: r.status, existing: r.existing });
        case 'invalid': return reply.code(400).send({ error: r.error });
        case 'withdrawn': return reply.code(409).send({ error: 'course_withdrawn' });
        case 'limited': return limited(reply, r);
        case 'off': return reply.code(503).send({ error: 'courses_off' });
      }
    },
  ));
  app.get('/courses/:id/sources', act((a, req) => deps.starts.sources(a, (req.params as { id: string }).id), (reply, r) => stepReply(reply, r)));
  app.post('/courses/:id/approve', act((a, req) => deps.starts.approve(a, (req.params as { id: string }).id), (reply, r) => stepReply(reply, r)));
  app.post('/courses/:id/sources/:sourceId/replace', act((a, req) => deps.starts.replace(a, (req.params as { id: string }).id, (req.params as { sourceId: string }).sourceId), (reply, r) => stepReply(reply, r, 202)));
  app.post('/courses/:id/cancel', act((a, req) => deps.starts.cancel(a, (req.params as { id: string }).id), (reply, r) => stepReply(reply, r)));
}

/** What a reader does in a course: read, take a quiz, flag, see the changelog, ask for a refresh. Same sign-in and rules as reading. */
export function registerCourseActivityRoutes(app: FastifyInstance, deps: CourseRouteDeps) {
  const guard = (handler: (accountId: string, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const who = await requireAccount(request, reply, deps);
      if (!who) return reply;
      if ((await deps.settings.get()).coursesOff) return reply.code(503).send({ error: 'courses_off' });
      return await handler(who.accountId, request, reply);
    } catch (error) {
      return routeFailed(deps, request, reply, error);
    }
  };
  /** The common answers; each route says what success looks like. */
  const answer = <T>(reply: FastifyReply, r: Acted<T>, success: (body: T) => unknown) => {
    switch (r.kind) {
      case 'ok': return success(r.body);
      case 'not_found': return reply.code(404).send({ error: 'not found' });
      case 'withdrawn': return reply.code(409).send({ error: 'course_withdrawn' });
      case 'invalid': return reply.code(400).send({ error: r.error });
      case 'limited': return reply.code(429).send({ error: r.code, retry_at: r.retryAt?.toISOString() ?? null });
    }
  };
  const a = deps.activity;
  const params = (request: FastifyRequest) => request.params as Record<string, string>;

  app.post('/courses/:id/chapters/:chapterId/read', guard(async (acc, req, reply) => answer(reply, await a.markRead(acc, params(req).id!, params(req).chapterId!), () => reply.code(204).send())));
  app.post('/courses/:id/sections/:sectionId/quiz', { bodyLimit: 4096 }, guard(async (acc, req, reply) => {
    const body = req.body;
    return answer(reply, await a.gradeQuiz(acc, params(req).id!, params(req).sectionId!, isObject(body) ? body.answers : undefined), (r) => r);
  }));
  app.post('/me/course-flags', { bodyLimit: 4096 }, guard(async (acc, req, reply) => answer(reply, await a.flag(acc, isObject(req.body) ? req.body : {}), (r) => r)));
  app.get('/courses/:id/changes', guard(async (acc, req, reply) => {
    const raw = (req.query as { since?: string }).since;
    if (raw !== undefined && !/^\d{1,9}$/.test(raw)) return reply.code(400).send({ error: 'since must be a whole number' });
    return answer(reply, await a.changes(acc, params(req).id!, raw === undefined ? 0 : Number(raw)), (r) => r);
  }));
  app.post('/me/courses/:id/open', guard(async (acc, req, reply) => answer(reply, await a.open(acc, params(req).id!), () => reply.code(204).send())));
  app.patch('/me/courses/:id', { bodyLimit: 1024 }, guard(async (acc, req, reply) => answer(reply, await a.rename(acc, params(req).id!, isObject(req.body) && 'title' in req.body ? req.body.title : undefined), () => reply.code(204).send())));
  app.post('/me/courses/:id/seen', { bodyLimit: 1024 }, guard(async (acc, req, reply) => answer(reply, await a.seen(acc, params(req).id!, isObject(req.body) ? req.body.version : undefined), () => reply.code(204).send())));
  app.delete('/me/courses/:id', guard(async (acc, req, reply) => answer(reply, await a.leave(acc, params(req).id!), () => reply.code(204).send())));
  app.post('/courses/:id/refresh', guard(async (acc, req, reply) =>
    answer(reply, await a.refresh(acc, params(req).id!), (r) => reply.code(r.started ? 202 : 200).send({ course_id: r.course_id, status: r.status, ...(r.repeat ? { repeat: true } : {}) }))));
}
