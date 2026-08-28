# Contributing

Contributions should preserve the exact anonymous device-route boundary,
requested-versus-confirmed hardware state, forward-only migrations, and the
physical-validation gates documented in the repository.

Before opening a change:

```bash
npm ci
npm run lint
npm test
```

For a schema change, generate a new migration with
`npm run db:generate -- --name descriptive_change`, inspect the SQL, and never
rewrite a migration that may already exist on an installation.

Do not commit `.env`, databases, cookies, Wi-Fi settings, tokens, device
credentials, compiled firmware candidates, or Hardware-in-the-Loop claims that
were not produced by the documented procedure.
