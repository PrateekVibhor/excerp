// Posting-driven library, step 2: the skill categories in the database. The file seeds them; a category the mapper proposes is saved as "proposed" and is
// rated and shown like any other until a person accepts or merges it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { detectTools, loadTaxonomy, type Category, type Taxonomy } from './taxonomy.ts';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function importTaxonomy(pool: pg.Pool, slug: string, t: Taxonomy): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO skill_taxonomies (role_slug, role, note, tools, examples, unplaced) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
       ON CONFLICT (role_slug) DO UPDATE SET role = EXCLUDED.role, note = EXCLUDED.note, tools = EXCLUDED.tools, examples = EXCLUDED.examples, unplaced = EXCLUDED.unplaced`,
      [slug, t.role, t.note ?? '', JSON.stringify(t.tools), JSON.stringify(t.examples ?? []), JSON.stringify(t.unplaced ?? [])],
    );
    for (const [i, c] of t.categories.entries()) {
      // status is kept for a category that is already there: re-importing the file must not undo a person's decision
      await client.query(
        `INSERT INTO skill_categories (role_slug, id, position, name, description, aliases) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (role_slug, id) DO UPDATE SET position = EXCLUDED.position, name = EXCLUDED.name, description = EXCLUDED.description, aliases = EXCLUDED.aliases`,
        [slug, c.id, i, c.name, c.description, JSON.stringify(c.aliases)],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The role's taxonomy with its active and proposed categories (merged ones are left out), or null when the database has none. */
export async function loadTaxonomyFromDb(db: pg.Pool | pg.PoolClient, slug: string): Promise<Taxonomy | null> {
  const head = (await db.query(`SELECT * FROM skill_taxonomies WHERE role_slug = $1`, [slug])).rows[0];
  if (!head) return null;
  const rows = (await db.query(`SELECT id, name, description, aliases, status FROM skill_categories WHERE role_slug = $1 AND status <> 'merged' ORDER BY position, id`, [slug])).rows;
  return {
    role: head.role, ...(head.note ? { note: head.note } : {}),
    categories: rows.map((r): Category => ({ id: r.id, name: r.name, description: r.description, aliases: r.aliases, status: r.status })),
    tools: head.tools, examples: head.examples, ...(head.unplaced?.length ? { unplaced: head.unplaced } : {}),
  };
}

/** Save a category the mapper proposed. Never over an id that exists; a tool or product name is not a category. */
export async function proposeCategory(pool: pg.Pool, slug: string, c: { id: string; name: string; description: string; aliases: string[] }): Promise<'added' | 'exists'> {
  if (!KEBAB.test(c.id)) throw new Error(`id "${c.id}" must be lower-case words joined by hyphens`);
  const t = await loadTaxonomyFromDb(pool, slug);
  if (!t) throw new Error(`no taxonomy for ${slug}`);
  if (detectTools(t, c.name).length || t.tools.some((x) => x.name.toLowerCase() === c.name.trim().toLowerCase())) throw new Error(`"${c.name}" names a tool, not a skill`);
  const r = await pool.query(
    `INSERT INTO skill_categories (role_slug, id, position, name, description, aliases, status)
     SELECT $1, $2, coalesce(max(position) + 1, 0), $3, $4, $5::jsonb, 'proposed' FROM skill_categories WHERE role_slug = $1
     ON CONFLICT (role_slug, id) DO NOTHING`,
    [slug, c.id, c.name, c.description, JSON.stringify(c.aliases)],
  );
  return r.rowCount ? 'added' : 'exists';
}

/** Write the taxonomy back to a categories.json for backup (proposed categories included, marked by their status). */
export async function exportTaxonomy(pool: pg.Pool, slug: string, dir: string): Promise<string> {
  const t = await loadTaxonomyFromDb(pool, slug);
  if (!t) throw new Error(`no taxonomy for ${slug}`);
  const file = join(dir, slug, 'categories.json');
  mkdirSync(join(dir, slug), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ role: t.role, ...(t.note ? { note: t.note } : {}), categories: t.categories, tools: t.tools, examples: t.examples ?? [], ...(t.unplaced?.length ? { unplaced: t.unplaced } : {}) }, null, 2)}\n`);
  return file;
}
export { loadTaxonomy };
