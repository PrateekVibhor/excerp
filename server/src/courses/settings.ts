// Plan 16: switches, caps and limits, kept in the course_settings table so they change without a deploy (spec 16, sections 4 and 5).
// A missing 'courses_off' row means courses are off. A stored value that is not valid is ignored in favour of the default.
import type pg from 'pg';

export class SettingError extends Error {}

export interface CourseSettings {
  coursesOff: boolean;
  /** Per reader. */
  perReader: { sourceSearchesPerDay: number; approvalsPerDay: number; approvalsPerMonth: number; refreshEveryDays: number; flagsPerDay: number; readsPerHour: number };
  /** Across all readers. Generous for the testing phase, to gather real cost data; a credit-based daily cap will replace these counts. */
  global: { sourceSearchesPerDay: number; generationsPerDay: number; refreshChecksPerDay: number };
  /** The testing-phase toggle: when true, the per-reader approval limits and the global daily counts apply to business analyst lists as to every other course. Off: they do not. */
  limitsOnBaLists: boolean;
  /** An overall safety cap on the search credits all course runs may use, counted from `baseline`. A total of 0 means no cap. */
  creditCap: { total: number; baseline: number };
}

export const COURSE_SETTING_DEFAULTS: CourseSettings = {
  coursesOff: true,
  perReader: { sourceSearchesPerDay: 5, approvalsPerDay: 1, approvalsPerMonth: 3, refreshEveryDays: 14, flagsPerDay: 10, readsPerHour: 600 },
  global: { sourceSearchesPerDay: 10, generationsPerDay: 8, refreshChecksPerDay: 10 },
  limitsOnBaLists: false,
  creditCap: { total: 0, baseline: 0 },
};

type Slot = { kind: 'boolean'; apply: (s: CourseSettings, v: boolean) => void } | { kind: 'count'; apply: (s: CourseSettings, v: number) => void };

const SLOTS: Record<string, Slot> = {
  courses_off: { kind: 'boolean', apply: (s, v) => void (s.coursesOff = v) },
  limits_on_ba_lists: { kind: 'boolean', apply: (s, v) => void (s.limitsOnBaLists = v) },
  'cap.credits_total': { kind: 'count', apply: (s, v) => void (s.creditCap.total = v) },
  'cap.credits_baseline': { kind: 'count', apply: (s, v) => void (s.creditCap.baseline = v) },
  'limit.source_searches_per_day': { kind: 'count', apply: (s, v) => void (s.perReader.sourceSearchesPerDay = v) },
  'limit.approvals_per_day': { kind: 'count', apply: (s, v) => void (s.perReader.approvalsPerDay = v) },
  'limit.approvals_per_month': { kind: 'count', apply: (s, v) => void (s.perReader.approvalsPerMonth = v) },
  'limit.refresh_every_days': { kind: 'count', apply: (s, v) => void (s.perReader.refreshEveryDays = v) },
  'limit.flags_per_day': { kind: 'count', apply: (s, v) => void (s.perReader.flagsPerDay = v) },
  'limit.reads_per_hour': { kind: 'count', apply: (s, v) => void (s.perReader.readsPerHour = v) },
  'cap.source_searches_per_day': { kind: 'count', apply: (s, v) => void (s.global.sourceSearchesPerDay = v) },
  'cap.generations_per_day': { kind: 'count', apply: (s, v) => void (s.global.generationsPerDay = v) },
  'cap.refresh_checks_per_day': { kind: 'count', apply: (s, v) => void (s.global.refreshChecksPerDay = v) },
};

export type SettingKey = keyof typeof SLOTS;

const valid = (slot: Slot, value: unknown): boolean => (slot.kind === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isInteger(value) && value >= 0);

export function createCourseSettings(pool: pg.Pool) {
  return {
    /** Every setting with its stored value, or its default. Read each time, so a change is seen at once. */
    async get(): Promise<CourseSettings> {
      const settings: CourseSettings = structuredClone(COURSE_SETTING_DEFAULTS);
      const { rows } = await pool.query(`SELECT key, value FROM course_settings`);
      for (const { key, value } of rows) {
        const slot = SLOTS[key];
        if (slot && valid(slot, value)) (slot.apply as (s: CourseSettings, v: unknown) => void)(settings, value);
      }
      return settings;
    },

    /** Stores a setting (the owner does this from the moderation tool). Refuses an unknown key or a value that makes no sense. */
    async set(key: SettingKey, value: unknown, at: Date = new Date()): Promise<void> {
      const slot = SLOTS[key];
      if (!slot) throw new SettingError(`unknown setting ${key}`);
      if (!valid(slot, value)) throw new SettingError(`${key} must be ${slot.kind === 'boolean' ? 'true or false' : 'a whole number, 0 or more'}`);
      await pool.query(
        `INSERT INTO course_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), at],
      );
    },
  };
}
