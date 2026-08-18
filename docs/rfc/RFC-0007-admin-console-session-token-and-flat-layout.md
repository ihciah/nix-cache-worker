# RFC-0007: admin console session token and flat layout

- Status: Implemented
- Date: 2026-08-18

## Context

The admin console currently uses a left navigation rail and keeps the admin
token only in JavaScript memory. A page refresh therefore returns the operator
to the login form even when the same browser tab is still being used.

## Goals and non-goals

This change will remove the left navigation rail and preserve a successfully
validated admin token across reloads of the same browser tab. It will not add a
server-side session, change the admin API, or make the token available to other
tabs or browser sessions.

## Design

Render the console as a single main-column view with the existing in-page
sections unchanged. Store the validated token in `sessionStorage` under a
page-specific key. On page load, restore the value and validate it through the
existing authenticated settings request before showing the console. On a
failed validation, remove the stored value and show the login form. On a
successful manual login, store the token only after validation succeeds.

The token input remains a password field and is cleared after a successful
login. The UI continues to send the token only in the `Authorization` header.

## Invariants and security

`sessionStorage` is scoped to the same origin and browser tab and is cleared
when that tab's page session ends. It is intentionally not `localStorage`,
cookies, a URL parameter, D1, Worker source, or a log destination. The token
is still exposed to JavaScript running in the admin origin, so the console must
continue to be served over HTTPS and must not introduce unsafe script injection.

The admin role, token source, API permissions, and anonymous cache behavior are
unchanged.

## Compatibility and migration

No HTTP endpoint, D1 schema, R2 object, or deployment binding changes. Existing
operators only need to enter the token once per browser tab after deployment;
the stored value is automatically discarded if it no longer authenticates.

## Acceptance tests

- `/admin` contains no left sidebar markup or sidebar layout rule.
- The page uses `sessionStorage` for the admin token and does not use
  `localStorage`.
- A stored token is validated on page load before the console is shown.
- Invalid stored tokens are removed and return the operator to the login form.
- The admin API and existing cache behavior remain unchanged.

## Implementation notes

Implementation is in `src/ui/admin.ts`; the static page test is in
`test/app.test.ts`. The implementation matches the design: the sidebar and its
responsive navigation styles are removed, and the validated token is restored
from `sessionStorage` and revalidated before the console is shown. This RFC
supersedes the previous memory-only browser storage wording for the admin
console while retaining the broader rule against persistent browser storage
and credentials outside the current page session.
