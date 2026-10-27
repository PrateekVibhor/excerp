import { StyleSheet } from 'react-native';
import { act, create } from 'react-test-renderer';
import { TopicCountRow } from './TopicCountRow';

const render = (props: { topic: string; count: number; max: number }) => {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(<TopicCountRow {...props} />); });
  return r;
};
const barWidth = (r: ReturnType<typeof create>) => StyleSheet.flatten(r.root.findByProps({ testID: 'topic-bar' }).props.style).width;

describe('TopicCountRow', () => {
  it('shows the topic and the count, and reads them as one item', () => {
    const r = render({ topic: 'Cloud', count: 3, max: 5 });
    const text = r.root.findAllByType('Text' as never).map((t) => t.props.children);
    expect(text).toEqual(['Cloud', 3]);
    expect(r.root.findByProps({ accessibilityLabel: 'Cloud, 3' })).toBeTruthy();
  });

  it('Scenario: Bar scale - the bar for 2 is half the width of the bar for 4', () => {
    expect(barWidth(render({ topic: 'A', count: 4, max: 4 }))).toBe('100%');
    expect(barWidth(render({ topic: 'B', count: 2, max: 4 }))).toBe('50%');
  });

  it('never draws a bar wider than the track, or a bar for a zero max', () => {
    expect(barWidth(render({ topic: 'A', count: 9, max: 4 }))).toBe('100%');
    expect(barWidth(render({ topic: 'A', count: 0, max: 0 }))).toBe('0%');
  });

  it('a long topic name wraps in the space left of the count', () => {
    const r = render({ topic: 'A very long topic name '.repeat(5), count: 12, max: 12 });
    const name = r.root.findAllByType('Text' as never)[0];
    expect(name.props.numberOfLines).toBe(2);
    expect(StyleSheet.flatten(name.props.style).flex).toBe(1);
  });
});
