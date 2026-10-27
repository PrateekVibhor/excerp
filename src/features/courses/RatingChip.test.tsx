import { act, create } from 'react-test-renderer';
import { Text } from 'react-native';
import { CoverageMeter } from './CoverageMeter';
import { RatingChip } from './RatingChip';
import { colors } from '../../theme';
import { Polygon } from 'react-native-svg';

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));

const mount = (node: React.ReactElement) => {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(node); });
  return r;
};
const words = (r: ReturnType<typeof create>) => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
const flat = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(5).filter(Boolean));

describe('RatingChip', () => {
  it('says the rating in words, so it reads without colour', () => {
    expect(words(mount(<RatingChip band="strong" />))).toEqual(['STRONG']);
    expect(words(mount(<RatingChip band="thin" />))).toEqual(['THIN']);
    expect(words(mount(<RatingChip band="missing" />))).toEqual(['MISSING']);
  });
  it('is announced as the rating', () => {
    expect(mount(<RatingChip band="thin" />).toJSON()).toMatchObject({ props: { accessibilityLabel: 'Coverage: thin' } });
  });
  it('strong is solid deep teal, thin a mint tint, missing a dashed outline', () => {
    const style = (band: 'strong' | 'thin' | 'missing') => flat((mount(<RatingChip band={band} />).toJSON() as unknown as { props: { style: unknown } }).props.style);
    expect(style('strong').backgroundColor).toBe(colors.course.strong.bg);
    expect(style('thin').backgroundColor).toBe(colors.course.thin.bg);
    expect(style('missing')).toMatchObject({ borderStyle: 'dashed', borderColor: colors.course.missing.border });
  });
});

describe('CoverageMeter', () => {
  const m = { total: 14, strong: 8, thin: 4, missing: 2 };
  it('shows the counts with their words, and how many concepts there are', () => {
    const w = words(mount(<CoverageMeter meter={m} />));
    expect(w).toEqual(expect.arrayContaining(['COVERAGE', '14 concepts', '8', 'Strong', '4', 'Thin', '2', 'Missing']));
  });
  it('the bar is split in proportion, one part per rating that has concepts', () => {
    const r = mount(<CoverageMeter meter={m} />);
    const parts = r.root.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('meter-')).filter((n) => typeof n.type === 'string');
    expect(parts.map((p) => [p.props.testID, flat(p.props.style).flex])).toEqual([['meter-strong', 8], ['meter-thin', 4], ['meter-missing', 2]]);
  });
  it('a part with no concepts is left out, and the counts still say zero', () => {
    const r = mount(<CoverageMeter meter={{ total: 3, strong: 3, thin: 0, missing: 0 }} />);
    expect(r.root.findAll((n) => typeof n.type === 'string' && String(n.props.testID).startsWith('meter-')).map((n) => n.props.testID)).toEqual(['meter-strong']);
    expect(words(r)).toEqual(expect.arrayContaining(['0', 'Thin']));
  });
  it('is announced as a sentence', () => {
    expect(mount(<CoverageMeter meter={m} />).root.findAll((n) => n.props.accessibilityLabel === 'Coverage: 8 strong, 4 thin, 2 missing').length).toBeGreaterThan(0);
  });
  it('the compact form is the same split with the counts as 8·4·2', () => {
    const r = mount(<CoverageMeter meter={m} compact />);
    expect(words(r)).toEqual(['8·4·2']);
  });

  it('the thin part is drawn as diagonal stripes once its width is known (a plain tint until then)', () => {
    const r = mount(<CoverageMeter meter={m} />);
    const thin = r.root.findAll((n) => n.props.testID === 'meter-thin' && typeof n.type === 'string')[0]!;
    expect(r.root.findAllByType(Polygon)).toHaveLength(0);
    const measured = thin.findAll((n) => typeof n.props.onLayout === 'function')[0]!;
    act(() => { measured.props.onLayout({ nativeEvent: { layout: { width: 80, height: 10, x: 0, y: 0 } } }); });
    const stripes = r.root.findAllByType(Polygon);
    expect(stripes.length).toBeGreaterThanOrEqual(8);
    expect(stripes.every((p) => p.props.fill === colors.course.thin.stripeA)).toBe(true);
  });

  it('and the same in the small copy, whatever its height', () => {
    const r = mount(<CoverageMeter meter={m} compact />);
    const thin = r.root.findAll((n) => n.props.testID === 'meter-thin' && typeof n.type === 'string')[0]!;
    const measured = thin.findAll((n) => typeof n.props.onLayout === 'function')[0]!;
    act(() => { measured.props.onLayout({ nativeEvent: { layout: { width: 30, height: 6, x: 0, y: 0 } } }); });
    expect(r.root.findAllByType(Polygon).length).toBeGreaterThanOrEqual(3);
  });
});

