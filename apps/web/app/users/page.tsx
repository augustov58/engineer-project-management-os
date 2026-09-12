import { listUsers } from '../api';
import { disableUser } from './actions';
import { NewUserForm } from './new-user-form';

export const dynamic = 'force-dynamic';

/**
 * The people at the firm (issue #105, ADR-0055).
 *
 * Everyone here sees everything: there is no role and no scoped read, and what
 * an engineer did is recorded rather than prevented. The list is here so that
 * "any signed-in user creates the next one" is something the interface
 * actually offers, rather than a route with no way to reach it.
 *
 * Disabling is a stamp and never a delete: the rows a person wrote stay
 * theirs. The verb is the record's own — `disabled_at`, and the audit line
 * "user disabled" — and not *close*, which the glossary keeps for an issue.
 */
export default async function UsersPage() {
  const users = await listUsers();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">People</h1>
        <p className="text-muted-foreground text-sm">
          Everyone who can sign in to this deployment.
        </p>
      </div>

      <NewUserForm />

      <ul className="divide-y rounded-md border">
        {users.map((user) => (
          <li
            key={user.id}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <span className="text-sm">
              {user.name}{' '}
              <span className="text-muted-foreground">{user.email}</span>
            </span>
            <form action={disableUser.bind(null, user.id)}>
              <button
                type="submit"
                className="text-muted-foreground hover:text-destructive text-sm transition-colors"
              >
                Disable
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
