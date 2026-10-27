// Plan 16: reading a course as its readers see it, and the one owner action that touches a chapter (spec 16, sections 4 and 5).
// A chapter keeps its identity across versions; its text, and a section's quiz, are the latest row at or before the published version.
// Rows of a version that is building or failed are never shown.
import type pg from 'pg';

export interface PublishedChapter {
  id: string;
  title: string;
  body: string;
  /** The version the text was written in. */
  version: number;
  status: 'live' | 'under_review';
}

export interface OutlineSection {
  id: string;
  position: number;
  title: string;
  summary: string;
  chapters: Array<{ id: string; position: number; title: string; status: 'live' | 'under_review' }>;
}

/** Versions whose rows a reader may see once they are at or before the published one. */
const SHOWN = `('published', 'superseded')`;

export function createCourseStore(pool: pg.Pool) {
  return {
    /** The chapter as the published version has it, or null if it is removed, not yet added, or not of this course. */
    async publishedChapter(courseId: string, chapterId: string): Promise<PublishedChapter | null> {
      const { rows } = await pool.query(
        `SELECT ch.id, ch.status, t.title, t.body, v.version
         FROM courses c
         JOIN course_versions pub ON pub.id = c.published_version
         JOIN course_sections s ON s.course_id = c.id
         JOIN course_chapters ch ON ch.section_id = s.id
         JOIN course_versions added ON added.id = ch.added_in_version
         JOIN chapter_texts t ON t.chapter_id = ch.id
         JOIN course_versions v ON v.id = t.version_id
         WHERE c.id = $1 AND ch.id = $2 AND ch.status <> 'removed' AND added.version <= pub.version AND v.version <= pub.version AND v.status IN ${SHOWN}
         ORDER BY v.version DESC LIMIT 1`,
        [courseId, chapterId],
      );
      const r = rows[0];
      return r ? { id: r.id, title: r.title, body: r.body, version: r.version, status: r.status } : null;
    },

    /** The sections and chapters of the published version, in order, with each chapter's latest title. */
    async publishedOutline(courseId: string): Promise<OutlineSection[]> {
      const { rows } = await pool.query(
        `SELECT s.id AS section_id, s.position AS section_position, s.title AS section_title, s.summary,
                ch.id AS chapter_id, ch.position AS chapter_position, ch.status AS chapter_status, t.title AS chapter_title
         FROM courses c
         JOIN course_versions pub ON pub.id = c.published_version
         JOIN course_sections s ON s.course_id = c.id
         LEFT JOIN course_chapters ch ON ch.section_id = s.id AND ch.status <> 'removed'
              AND (SELECT a.version FROM course_versions a WHERE a.id = ch.added_in_version) <= pub.version
         LEFT JOIN LATERAL (
           SELECT t.title FROM chapter_texts t JOIN course_versions v ON v.id = t.version_id
           WHERE t.chapter_id = ch.id AND v.version <= pub.version AND v.status IN ${SHOWN} ORDER BY v.version DESC LIMIT 1
         ) t ON true
         WHERE c.id = $1 ORDER BY s.position, ch.position`,
        [courseId],
      );
      const sections = new Map<string, OutlineSection>();
      for (const r of rows) {
        let section = sections.get(r.section_id);
        if (!section) sections.set(r.section_id, (section = { id: r.section_id, position: r.section_position, title: r.section_title, summary: r.summary, chapters: [] }));
        if (r.chapter_id && r.chapter_title !== null) section.chapters.push({ id: r.chapter_id, position: r.chapter_position, title: r.chapter_title, status: r.chapter_status });
      }
      return [...sections.values()];
    },

    /** The section's quiz as the published version has it. */
    async publishedQuiz(sectionId: string): Promise<{ questions: unknown[]; version: number } | null> {
      const { rows } = await pool.query(
        `SELECT q.questions, v.version
         FROM course_sections s
         JOIN courses c ON c.id = s.course_id
         JOIN course_versions pub ON pub.id = c.published_version
         JOIN section_quizzes q ON q.section_id = s.id
         JOIN course_versions v ON v.id = q.version_id
         WHERE s.id = $1 AND v.version <= pub.version AND v.status IN ${SHOWN}
         ORDER BY v.version DESC LIMIT 1`,
        [sectionId],
      );
      return rows[0] ? { questions: rows[0].questions, version: rows[0].version } : null;
    },

    /** The owner takes a chapter out. The row, its text and every reader's mark stay; it just stops being shown. A refresh never does this. */
    async removeChapter(chapterId: string): Promise<void> {
      await pool.query(`UPDATE course_chapters SET status = 'removed' WHERE id = $1`, [chapterId]);
    },
  };
}
