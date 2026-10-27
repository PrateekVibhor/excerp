import { Text } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { createFakeGoogleClient, FakeGoogleSheet, TEST_READERS } from './fakeGoogle';

const label = (n: ReactTestInstance) => n.props.accessibilityLabel as string | undefined;
async function show() {
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<FakeGoogleSheet />); });
  const buttons = () => r.root.findAll((n) => typeof n.props.onPress === 'function' && label(n) !== undefined);
  const choose = async (name: string) => { await act(async () => { buttons().find((b) => label(b) === name)!.props.onPress(); }); };
  const texts = () => r.root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
  return { r, buttons, choose, texts };
}
/** Starts a sign-in and lets the sheet appear, without waiting for the reader to choose. */
async function start<T>(run: () => Promise<T>) {
  let result!: Promise<T>;
  await act(async () => { result = run(); });
  return { result }; // wrapped: returning the promise itself would make `await start()` wait for the reader's choice
}

describe('the test readers', () => {
  it('are the three the spec names, with the tokens the test server understands', () => {
    expect(TEST_READERS).toEqual([
      { label: 'Test reader: approved', token: 'e2e:tester@example.com' },
      { label: 'Test reader: not approved', token: 'e2e:stranger@example.com' },
      { label: 'Test reader: unverified', token: 'e2e:unverified@example.com' },
    ]);
  });
});

describe('FakeGoogleSheet', () => {
  it('shows nothing until a sign-in asks for it', async () => {
    const sheet = await show();
    expect(sheet.texts()).toEqual([]);
    expect(sheet.buttons()).toEqual([]);
  });

  it('Scenario: Stand-in sheet - offers the three readers and Cancel under "Choose an account"', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    expect(sheet.texts()).toContain('Choose an account');
    expect(sheet.buttons().map(label)).toEqual(['Test reader: approved', 'Test reader: not approved', 'Test reader: unverified', 'Cancel']);
    await sheet.choose('Cancel');
    await pending;
  });

  it('choosing a reader signs in as that reader and closes the sheet', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    await sheet.choose('Test reader: approved');
    expect(await pending).toEqual({ kind: 'ok', idToken: 'e2e:tester@example.com' });
    expect(sheet.buttons()).toEqual([]);
  });

  it('each reader gives its own token', async () => {
    for (const reader of TEST_READERS) {
      const google = createFakeGoogleClient();
      const sheet = await show();
      const { result: pending } = await start(() => google.signIn());
      await sheet.choose(reader.label);
      expect(await pending).toEqual({ kind: 'ok', idToken: reader.token });
    }
  });

  it('Cancel is "cancelled", not an error', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    await sheet.choose('Cancel');
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(sheet.buttons()).toEqual([]);
  });

  it('asking again while the sheet is open cancels the first ask and shows one sheet', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: first } = await start(() => google.signIn());
    const { result: second } = await start(() => google.signIn());
    expect(await first).toEqual({ kind: 'cancelled' });
    expect(sheet.buttons().filter((b) => label(b) === 'Cancel')).toHaveLength(1);
    await sheet.choose('Test reader: approved');
    expect(await second).toEqual({ kind: 'ok', idToken: 'e2e:tester@example.com' });
  });
});

describe('the fake Google client without the sheet', () => {
  it('a silent sign-in has nobody to give before anyone chose', async () => {
    expect(await createFakeGoogleClient().signInSilently()).toEqual({ kind: 'none' });
  });

  it('a silent sign-in gives the same reader as the last choice, with no sheet', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    await sheet.choose('Test reader: not approved');
    await pending;
    expect(await google.signInSilently()).toEqual({ kind: 'ok', idToken: 'e2e:stranger@example.com' });
    expect(sheet.buttons()).toEqual([]); // the chooser did not open again
  });

  it('a cancelled sign-in is not remembered', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    await sheet.choose('Cancel');
    await pending;
    expect(await google.signInSilently()).toEqual({ kind: 'none' });
  });

  it('signing out forgets the reader, and never rejects', async () => {
    const google = createFakeGoogleClient();
    const sheet = await show();
    const { result: pending } = await start(() => google.signIn());
    await sheet.choose('Test reader: approved');
    await pending;
    await expect(google.signOut()).resolves.toBeUndefined();
    expect(await google.signInSilently()).toEqual({ kind: 'none' });
  });
});
