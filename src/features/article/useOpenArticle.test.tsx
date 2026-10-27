import { act, create } from 'react-test-renderer';
import { useOpenArticle } from './useOpenArticle';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const router = { push: (...args: unknown[]) => mockPush(...args) };
  return { useRouter: () => router };
});

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
});
afterEach(() => jest.useRealTimers());

function mount(from: 'feed' | 'reading-list') {
  const out = { open: undefined as never as (id: string) => void };
  function Harness() {
    out.open = useOpenArticle(from);
    return null;
  }
  act(() => void create(<Harness />));
  return out;
}

describe('useOpenArticle', () => {
  it('pushes the article route with the id and where the user came from', () => {
    mount('feed').open('mock-3');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/article/[id]', params: { id: 'mock-3', from: 'feed' } });
  });

  it('tells the screen it came from the Reading List', () => {
    mount('reading-list').open('mock-7');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/article/[id]', params: { id: 'mock-7', from: 'reading-list' } });
  });

  it('opens once when tapped several times in quick succession', () => {
    const { open } = mount('feed');
    open('mock-1');
    open('mock-1');
    open('mock-1');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('opens again once the moment has passed', () => {
    const { open } = mount('feed');
    open('mock-1');
    act(() => {
      jest.advanceTimersByTime(900);
    });
    open('mock-2');
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/article/[id]', params: { id: 'mock-2', from: 'feed' } });
  });
});
