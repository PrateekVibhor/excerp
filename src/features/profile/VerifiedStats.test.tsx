import { act, create } from 'react-test-renderer';
import { VerifiedStats } from './VerifiedStats';

const texts = (stats: Parameters<typeof VerifiedStats>[0]['stats']) => {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(<VerifiedStats stats={stats} />); });
  return r.root.findAllByType('Text' as never).map((t) => String(t.props.children));
};

describe('VerifiedStats', () => {
  it('Scenario: Total and breakdown - shows the total, then a row per topic in the order given', () => {
    const t = texts({ total: 8, byTopic: [{ topic: 'Generative AI', count: 5 }, { topic: 'Cloud', count: 3 }] });
    expect(t).toEqual(['VERIFIED', '8', 'Generative AI', '5', 'Cloud', '3']);
  });

  it('Scenario: No verified articles - shows the empty state and no rows', () => {
    const t = texts({ total: 0, byTopic: [] });
    expect(t[1]).toBe('No verified articles yet');
    expect(t).toHaveLength(3);
  });
});
