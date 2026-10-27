import { act, create } from 'react-test-renderer';
import { useToast } from './useToast';

function mount(durationMs?: number) {
  const api = {} as ReturnType<typeof useToast>;
  function Harness() {
    Object.assign(api, useToast(durationMs));
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Harness />);
  });
  return { api, renderer };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useToast', () => {
  it('shows a message, then clears it after the duration', () => {
    const { api } = mount(1000);
    expect(api.message).toBeNull();
    act(() => api.show('InMail sent to Maya Chen'));
    expect(api.message).toBe('InMail sent to Maya Chen');
    act(() => void jest.advanceTimersByTime(999));
    expect(api.message).toBe('InMail sent to Maya Chen');
    act(() => void jest.advanceTimersByTime(1));
    expect(api.message).toBeNull();
  });

  it('a new message replaces the old one and restarts the timer', () => {
    const { api } = mount(1000);
    act(() => api.show('first'));
    act(() => void jest.advanceTimersByTime(800));
    act(() => api.show('second'));
    act(() => void jest.advanceTimersByTime(800)); // the first timer would have fired by now
    expect(api.message).toBe('second');
    act(() => void jest.advanceTimersByTime(200));
    expect(api.message).toBeNull();
  });

  it('shows for about two seconds by default', () => {
    const { api } = mount();
    act(() => api.show('hello'));
    act(() => void jest.advanceTimersByTime(2100));
    expect(api.message).toBe('hello');
    act(() => void jest.advanceTimersByTime(200));
    expect(api.message).toBeNull();
  });

  it('stops its timer when unmounted', () => {
    const { api, renderer } = mount(1000);
    act(() => api.show('hello'));
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });
});
