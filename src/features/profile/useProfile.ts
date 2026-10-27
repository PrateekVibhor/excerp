import { useCallback, useEffect, useRef, useState } from 'react';
import { profileRepository, type Profile, type ProfileRepository } from '../../data';

export interface ProfileSource {
  profiles: ProfileRepository;
}

const defaults: ProfileSource = { profiles: profileRepository };

export type ProfileStatus = 'loading' | 'ready' | 'error';

/** The reader's own profile from the device: null until one is saved. */
export function useProfile(source: ProfileSource = defaults) {
  const [status, setStatus] = useState<ProfileStatus>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);

  const src = useRef(source);
  src.current = source;
  // Only the most recent load may update state.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    setStatus('loading');
    try {
      const saved = await src.current.profiles.getProfile();
      if (id !== latestLoad.current) return;
      setProfile(saved);
      setStatus('ready');
    } catch (error) {
      if (id !== latestLoad.current) return;
      console.warn('Could not load the profile', error);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      latestLoad.current++;
    };
  }, [load]);

  /** Writes the profile, then shows what was stored. Resolves false if the write failed. */
  const save = useCallback(async (next: Profile): Promise<boolean> => {
    try {
      setProfile(await src.current.profiles.saveProfile(next));
      return true;
    } catch (error) {
      console.error('Could not save the profile', error);
      return false;
    }
  }, []);

  return { status, profile, save, retry: load };
}
