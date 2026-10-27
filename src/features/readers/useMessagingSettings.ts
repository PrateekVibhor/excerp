import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessagingSettings, SettingsPatch, SocialApi, SocialResult } from '../../data/socialApi';

export type SettingsStatus = 'loading' | 'ready' | 'unavailable';

/**
 * The reader's two switches (be seen, take messages) and what they have confirmed. `update` sends a change and gives back the
 * server's answer, so the screen can say why a change was refused; the settings shown are always the server's.
 */
export function useMessagingSettings(social: SocialApi | null) {
  const [status, setStatus] = useState<SettingsStatus>('loading');
  const [settings, setSettings] = useState<MessagingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!social) return;
    setStatus('loading');
    social.getSettings().then((res) => {
      if (!alive.current) return;
      if (res.kind === 'ok') {
        setSettings(res.value);
        setStatus('ready');
      } else setStatus('unavailable');
    });
    return () => {
      alive.current = false;
    };
  }, [social]);

  const update = useCallback(
    async (patch: SettingsPatch): Promise<SocialResult<MessagingSettings>> => {
      if (!social) return { kind: 'failed' };
      setBusy(true);
      const res = await social.putSettings(patch);
      if (alive.current) {
        setBusy(false);
        if (res.kind === 'ok') setSettings(res.value);
      }
      return res;
    },
    [social],
  );

  return { status, settings, busy, update };
}
