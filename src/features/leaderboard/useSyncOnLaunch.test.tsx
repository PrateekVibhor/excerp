import * as fs from 'fs';
import * as path from 'path';
import { act, create } from 'react-test-renderer';
import type { SyncQueue } from '../../data';
import { useSyncOnLaunch } from './useSyncOnLaunch';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const queue = (flush: () => Promise<unknown>) => ({ enqueue: jest.fn(), flush: jest.fn(flush) }) as unknown as SyncQueue & { flush: jest.Mock };
function Launch({ q }: { q: SyncQueue }) {
  useSyncOnLaunch(q);
  return null;
}
const mount = async (q: SyncQueue) => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<Launch q={q} />);
  });
  return renderer;
};

describe('useSyncOnLaunch', () => {
  it('Scenario: sends what was left waiting, once, when the app starts', async () => {
    const q = queue(async () => ({ sent: 1, rejected: 0, remaining: 0 }));
    await mount(q);
    expect(q.flush).toHaveBeenCalledTimes(1);
  });

  it('does not send again when the screen redraws', async () => {
    const q = queue(async () => ({}));
    const renderer = await mount(q);
    await act(async () => renderer.update(<Launch q={q} />));
    await act(async () => renderer.update(<Launch q={q} />));
    expect(q.flush).toHaveBeenCalledTimes(1);
  });

  it('a send that fails, or even throws instead of failing quietly, does not break the app', async () => {
    await expect(mount(queue(async () => { throw new Error('offline'); }))).resolves.toBeDefined();
    const throwing = { enqueue: jest.fn(), flush: jest.fn(() => { throw new Error('thrown at once'); }) } as unknown as SyncQueue & { flush: jest.Mock };
    const renderer = await mount(throwing);
    expect(throwing.flush).toHaveBeenCalledTimes(1);
    expect(renderer.toJSON()).toBeNull(); // it rendered, and nothing escaped
  });

  it('uses the app\'s own queue when none is given', async () => {
    function Default() {
      useSyncOnLaunch();
      return null;
    }
    await act(async () => {
      create(<Default />);
    });
  });

  it('is what the app calls at start: the root layout uses it', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../../../app/_layout.tsx'), 'utf8');
    expect(layout).toMatch(/import \{ useSyncOnLaunch \} from '..\/src\/features\/leaderboard\/useSyncOnLaunch'/);
    expect(layout).toMatch(/useSyncOnLaunch\(\);/);
  });
});
