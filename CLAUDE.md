# Claude instructions

## Git

- Before every push, merge the latest `main` into the working branch
  (`git fetch origin main && git merge origin/main`). Use a merge, not a rebase,
  and resolve any conflicts before pushing.
- Never merge a branch or PR into `main` unless explicitly asked.
