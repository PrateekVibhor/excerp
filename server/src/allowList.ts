import { createDb } from './db.ts';
import { createAuthStore, type AuthStore } from './authStore.ts';

const USAGE = `Usage: allow <command>
  add <email>      let this Google account in
  remove <email>   stop letting it in (takes effect on its next request)
  list             everyone on the list
  pending          people who signed in and are waiting to be added`;

const day = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Runs one command of the owner's allow-list tool. Returns the exit code: 0 done, 1 not understood. */
export async function runAllowCommand(args: string[], store: AuthStore, print: (line: string) => void): Promise<number> {
  const [command, email, ...extra] = args;
  const usage = () => {
    print(USAGE);
    return 1;
  };
  if (extra.length > 0) return usage();

  switch (command) {
    case 'add':
    case 'remove': {
      if (email === undefined) return usage();
      try {
        if (command === 'add') {
          const added = await store.addAllowed(email);
          print(added ? `Added ${email.trim().toLowerCase()}` : `${email.trim().toLowerCase()} was already on the list`);
        } else {
          const removed = await store.removeAllowed(email);
          print(removed ? `Removed ${email.trim().toLowerCase()}` : `${email.trim().toLowerCase()} was not on the list`);
        }
      } catch (error) {
        if (error instanceof RangeError) return usage(); // not an email address
        throw error;
      }
      return 0;
    }
    case 'list': {
      if (email !== undefined) return usage();
      const rows = await store.listAllowed();
      print(rows.length === 0 ? 'The allow-list is empty.' : rows.map((r) => `${r.email}   added ${day(r.added_at)}`).join('\n'));
      return 0;
    }
    case 'pending': {
      if (email !== undefined) return usage();
      const rows = await store.listPending();
      print(rows.length === 0 ? 'No one is waiting.' : rows.map((r) => `${r.email}   first asked ${day(r.first_requested_at)}, latest ${day(r.last_requested_at)}`).join('\n'));
      return 0;
    }
    default:
      return usage();
  }
}

// On the VM: docker compose exec api node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/allowList.ts list
// (the container already has DATABASE_URL). On this Mac: npm run allow -- list
if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const db = createDb(url);
  try {
    process.exitCode = await runAllowCommand(process.argv.slice(2), createAuthStore(db.pool), console.log);
  } catch {
    console.error('The allow-list could not be reached.'); // never echo connection details
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
