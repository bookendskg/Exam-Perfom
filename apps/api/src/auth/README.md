# Authentication

How sign-in works today, and where the seams for SSO, magic links, MFA and email
verification are.

## What runs today

Login is **phone + password**. Passwords are argon2id (19 MiB, t=2) via
`@bookends/core`. Every failure path returns an identical `INVALID_CREDENTIALS`,
and an unknown phone still pays a full argon2 verify against a dummy hash — the
timing gap between "no such user" (~1 ms) and "wrong password" (~50 ms) is
otherwise an enumeration oracle.

A successful login writes a `user_sessions` row and returns:

- a **15-minute access JWT** (HS256, pinned; `sub`, `role`, `sid`, `iss`, `aud`),
- an **opaque 256-bit refresh token**, stored as sha256.

The refresh token is opaque on purpose. Nothing reads claims out of it, so
making it a JWT would only add a way to forge one with a leaked signing key.
Being a row, it is revocable by an `UPDATE`.

`sid` is the load-bearing part: it is a UUID that never leaves the server except
inside the JWT, and every request resolves the principal _from the database_ by
`sid`. A forged JWT alone is therefore not account takeover — the session must
also exist and be live.

### Per request

`authenticate` → verify JWT → `store.touch(sid)` → `Principal`.

Role, outlet scope and `mustChangePassword` are re-read from the database on
every request. Nothing authorisation-related is cached in the token, so a
revoked privilege stops working on the **next** request rather than whenever a
15-minute token happens to expire.

### Session rules (§7.5)

| Rule            | Behaviour                                                                |
| --------------- | ------------------------------------------------------------------------ |
| Staff           | exactly one live session; a new login supersedes the old                 |
| Admin roles     | concurrent sessions allowed                                              |
| Idle timeout    | 30 min staff, 2 h everyone else — enforced on `touch` **and** on refresh |
| Absolute expiry | 7 days (refresh token TTL)                                               |
| Password change | revokes everything and issues a **new session id**                       |
| `logout`        | ends the calling session                                                 |
| `logout-all`    | ends every session the user holds                                        |

### Lockout

Two tiers, because "one attacker" and "this account is under distributed attack"
need different answers:

- **per (phone, IP)** — 5 failures / 15 min, hard.
- **per phone, all IPs** — 50 / hour, loose.

Keying the hard limit on the phone alone would make the endpoint a denial-of-
service weapon: a phone number is the login identifier, not a secret, so anyone
could lock any account out at will. State lives in `login_attempts`, so it
survives restarts and is shared across instances.

---

## Seams for future methods

The tables below exist and are empty. **Nothing reads them yet.** They are here
so that adding a method later is a feature branch rather than a migration of
`users` under a live system.

### `user_identities` — Google, Microsoft, magic link

Keyed on `(provider, provider_user_id)`, where `provider_user_id` is the OIDC
`sub`, **not** the email. Emails get reassigned — a departing employee's address
handed to their replacement would silently transfer the account. `sub` does not.

To add a provider:

1. Exchange the provider's code for an ID token; verify its signature, `iss`,
   `aud` and `nonce`.
2. Look up `user_identities` by `(provider, sub)`.
3. **Found** → issue a session with the existing `SessionService.issue`. Nothing
   downstream changes; the session shape is identical to a password login.
4. **Not found** → do _not_ auto-create a user. This portal's accounts are
   provisioned by HR and carry an outlet, department and designation that an
   OIDC token cannot supply. Link to an existing user instead, after they have
   authenticated by some other means.

Magic links are modelled as a provider rather than a separate mechanism so that
one join table covers every non-password credential.

### `user_mfa_factors` — TOTP, SMS, recovery codes

`verified_at` is NULL until the user proves they can generate a code. A factor
must not count as usable before then, or a mis-scanned QR locks someone out of
their own account.

`secret` must be **encrypted at rest by the application** before it is written.
It cannot be hashed — TOTP has to recompute the code, so the value must be
recoverable — which makes encryption the only correct treatment. A leaked
database otherwise lets an attacker generate valid second factors, defeating the
point entirely.

Where it plugs in: login currently returns an `IssuedSession` directly. With MFA
enabled it returns a short-lived challenge instead, and the session is issued
only once a factor is satisfied. `SessionService` needs no changes.

### Email verification

Login is by phone, so **no flow depends on a verified email today**. The columns
record the fact so that a future email login, or notification delivery, can
require it.

`email_verification_tokens` is a table rather than a column pair on `users`
(which is how password reset works) because verification is not always about the
address currently on the account — changing an email should verify the _new_
address before it replaces the old, so the pending address needs somewhere to
live that is not `users.email`.

**The flow, end to end:**

1. **Request.** User adds or changes their email. Generate 32 random bytes,
   base64url. Insert a row with the sha256 of it, the address being proved, and
   `expires_at = now + 24h`. The raw token exists only in the message.
2. **Deliver.** Through `NotificationDispatcher` — the same seam password reset
   uses. In production that is currently `UnconfiguredDispatcher`; a delivery
   failure must be logged and swallowed, never surfaced, or the endpoint becomes
   an enumeration oracle exactly as `forgot-password` was.
3. **Redeem.** `POST /auth/verify-email { token }`. Look up by sha256. Reject if
   absent, `consumed_at` is set, or `expires_at` has passed — with one identical
   error for all three, since distinguishing them leaks which tokens are real.
4. **Apply.** In one transaction: set `users.email` to the row's `email`, set
   `users.email_verified_at = now()`, set `consumed_at = now()`.
5. **Re-request.** Do not overwrite a live token. Silently no-op instead, so a
   third party cannot invalidate the link a user is actually holding — the same
   defect `forgot-password` had.

Rows are kept after consumption rather than deleted, so a replayed link is
distinguishable from an invented one in the audit trail.

---

## Multi-tenancy

There is none. The only isolation axis is **outlet**, via `Outlet.managerId` →
`Principal.managedOutletIds`.

The tables added here are tenant-ready in the sense that none of their unique
constraints would need rewriting: `(provider, provider_user_id)` is globally
unique by construction, and the token columns are hashes.

`users.phone` is the one that blocks tenancy. It is globally unique today and
cannot stay that way once two companies may employ the same person — and since
login is `findUnique({ where: { phone } })`, changing it changes how a user is
identified at sign-in. That needs a tenant discriminator (subdomain, email
domain, or an explicit code) and is a project in its own right.
