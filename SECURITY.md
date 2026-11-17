# Security Policy

## Supported versions

Security fixes go into the latest release. Light Code updates itself, so most users are on it
within hours of a release.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub:
[Security, Report a vulnerability](https://github.com/digitalscapemy/lightcode/security/advisories/new).

Include what you found, how to reproduce it, and the impact you expect. You will get a reply
within a few days, and we will keep you updated until it is fixed. With your permission, we will
credit you in the release notes.

## What we care about most

Light Code runs shells and passes text between terminals, agents and your system, so these
areas matter most:

- Text from a terminal, a transcript or a repository file reaching a shell command line, a URL
  handler or the page as markup
- An agent being able to answer a permission prompt or act outside what the user allowed
- Light Code writing files outside the places it says it writes (your shell profile, its own
  settings folder, and project folders you chose)
