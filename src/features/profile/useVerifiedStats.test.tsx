import { act, create } from 'react-test-renderer';
import type { VerifiedRecord } from '../../data';
import { useVerifiedStats } from './useVerifiedStats';

// Focus is simulated: the callback runs on mount and again whenever `focusCount` changes.
let mockFocus = 0;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb, mockFocus]);
  },
}));
jest.mock('../../data', () => ({ verifiedRepository: { list: async () => [] } }));

const rec = (id: string, topic: string): VerifiedRecord => ({ article_id: id, verified_at: '2026-10-06T10:00:00.000Z', topic });

function fake(initial: VerifiedRecord[]) {
  const repo = {
    records: initial,
    fail: false,
    list: jest.fn(async (): Promise<VerifiedRecord[]> => {
      if (repo.fail) throw new Error('unreadable');
      return repo.records;
    }),
  };
  return repo;
}

async function mount(repo: ReturnType<typeof fake>) {
  const out = { stats: undefined as never as ReturnType<typeof useVerifiedStats> };
  function Harness() {
    out.stats = useVerifiedStats(repo);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Harness />); });
  return { out, rerender: () => act(async () => { renderer.update(<Harness />); }) };
}

beforeEach(() => { mockFocus = 0; });

describe('useVerifiedStats', () => {
  it('counts the records in the store', async () => {
    const { out } = await mount(fake([rec('a', 'Cloud'), rec('b', 'Cloud'), rec('c', 'Agents')]));
    expect(out.stats).toEqual({ total: 3, byTopic: [{ topic: 'Cloud', count: 2 }, { topic: 'Agents', count: 1 }] });
  });

  it('starts empty, and stays empty with no records', async () => {
    const { out } = await mount(fake([]));
    expect(out.stats).toEqual({ total: 0, byTopic: [] });
  });

  it('Scenario: Live update - recalculates when the screen gains focus again', async () => {
    const repo = fake([rec('a', 'Cloud')]);
    const { out, rerender } = await mount(repo);
    expect(out.stats.total).toBe(1);
    repo.records = [...repo.records, rec('b', 'Cloud')];
    mockFocus++;
    await rerender();
    expect(out.stats).toEqual({ total: 2, byTopic: [{ topic: 'Cloud', count: 2 }] });
    expect(repo.list).toHaveBeenCalledTimes(2);
  });

  it('Scenario: Store failure - an unreadable store gives the empty stats and does not throw', async () => {
    const repo = fake([rec('a', 'Cloud')]);
    repo.fail = true;
    const { out } = await mount(repo);
    expect(out.stats).toEqual({ total: 0, byTopic: [] });
  });

  it('a store that recovers shows its numbers on the next focus', async () => {
    const repo = fake([rec('a', 'Cloud')]);
    repo.fail = true;
    const { out, rerender } = await mount(repo);
    repo.fail = false;
    mockFocus++;
    await rerender();
    expect(out.stats.total).toBe(1);
  });
});
