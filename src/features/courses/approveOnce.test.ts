import type { CourseApi, CourseResult } from '../../data/courseApi';
import { approveOnce } from './approveOnce';
import { fakeCourses, ok, refused } from './testing';

type Approved = CourseResult<{ courseId: string; status: string }>;
const deferred = () => { let resolve!: (v: Approved) => void; const promise = new Promise<Approved>((r) => { resolve = r; }); return { promise, resolve }; };

describe('approveOnce', () => {
  it('while one approval of a list is in flight, every other ask shares it: one call is sent, all get its answer', async () => {
    const d = deferred();
    const api = fakeCourses({ approve: jest.fn(() => d.promise) });
    const asks = [approveOnce(api, 'c1'), approveOnce(api, 'c1'), approveOnce(api, 'c1')];
    d.resolve(ok({ courseId: 'c1', status: 'building' }));
    expect((await Promise.all(asks)).map((r) => r.kind)).toEqual(['ok', 'ok', 'ok']);
    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('once it has succeeded no second approval is ever sent for that list, even much later or from a screen opened afresh', async () => {
    const api = fakeCourses();
    await approveOnce(api, 'c1');
    await approveOnce(api, 'c1');
    expect(api.approve).toHaveBeenCalledTimes(1);
  });

  it('a different list is a different approval', async () => {
    const api = fakeCourses();
    await approveOnce(api, 'c1');
    await approveOnce(api, 'c2');
    expect(api.approve).toHaveBeenCalledTimes(2);
  });

  it('a failure or a refusal clears it, so asking again (Try again, or the next poll) sends a new one; a throw is cleared too', async () => {
    const approve = jest.fn()
      .mockResolvedValueOnce({ kind: 'failed', server: true })
      .mockResolvedValueOnce(refused(429, 'course_limit'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ok({ courseId: 'c1', status: 'building' }));
    const api = fakeCourses({ approve });
    expect((await approveOnce(api, 'c1')).kind).toBe('failed');
    expect((await approveOnce(api, 'c1')).kind).toBe('refused');
    await expect(approveOnce(api, 'c1')).rejects.toThrow('boom');
    expect((await approveOnce(api, 'c1')).kind).toBe('ok');
    expect(approve).toHaveBeenCalledTimes(4);
  });

  it('is kept per server connection, so one test or one sign-in never inherits another\'s', async () => {
    const [a, b]: CourseApi[] = [fakeCourses(), fakeCourses()];
    await approveOnce(a, 'c1');
    await approveOnce(b, 'c1');
    expect((a.approve as jest.Mock).mock.calls.length + (b.approve as jest.Mock).mock.calls.length).toBe(2);
  });
});
