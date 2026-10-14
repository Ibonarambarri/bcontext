/**
 * The one action on the "signed in as someone else" page. A plain POST
 * form, like the user menu and the account modal: `/auth/signout` only
 * answers POST (clearing the session cookie is a write), so a GET link
 * would land on a 405. No JS needed, hence no "use client".
 */
export function SignOutButton() {
  return (
    <form action="/auth/signout" method="post">
      <button type="submit" className="pa-submit">
        Sign out
      </button>
    </form>
  );
}
