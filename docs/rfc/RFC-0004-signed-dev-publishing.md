# RFC-0004: signed dev publishing and NixOS substitution

- Status: Implemented
- Date: 2026-08-17

## Context

The CI or development build host produces the closure that is published to the
cache. Nix clients normally require signed narinfos, while the Worker only
stores and serves the uploaded bytes. The private signing key must not be
committed to the application repository.

## Design

- A project-specific CI or development script builds the closure and uploads
  it using the standard Nix HTTP copy protocol.
- The publisher reads the Worker write password from a CI secret or an
  explicitly supplied netrc file; it never stores the password in the repo or
  prints it.
- A dedicated cache signing key is kept under the operator's Nix
  configuration. The publisher signs every closure path before `nix copy`.
- NixOS and nix-darwin configuration keeps the official cache and adds the
  deployment's HTTPS cache origin with its public key.

## Invariants and security

The private signing key and Worker tokens remain outside Git. The cache URL is
public-read, but uploads still require the Worker write secret. A cache key
rotation requires a new RFC or an update to this RFC and a coordinated config
rollout.

## Compatibility and migration

The script uses `nix build` and `nix copy`; no custom upload endpoint is needed.
Existing clients can continue to use standard Nix substituter configuration.

## Acceptance tests

- Build a representative project closure with Nix.
- Publish the complete closure.
- Verify the narinfo is served and carries a trusted `Sig:` line.
- Query the path through the HTTPS Nix store and compare binary bytes.
- Run the consumer configuration's checks after adding the substituter and
  key.

## Implementation notes

The deployment URL and public key are documented in the consumer's Nix
configuration. The private signing key is intentionally not part of this
repository.
