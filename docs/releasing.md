# Releasing Agent Core

Agent Core is versioned and published independently from Agent Memory, Agent
Flow, and Agentic Development.

## Release checklist

1. Work from a clean `main` branch.
2. Choose the next semantic version and update `package.json`.
3. Run:

   ```bash
   bun install --frozen-lockfile
   bun run ci
   bun run verify:package
   ```

4. Commit the version, create the matching `vX.Y.Z` tag, and push both.
5. Publish a GitHub Release for that tag.
6. Wait for the `Publish package` workflow.
7. Verify:

   ```bash
   npm view @jurgen1c/agent-core version
   ```

The first release is `v0.1.0`. Downstream packages depend on compatible semver
ranges; their versions do not need to match Core.

For the first publication of this new scoped package, add a repository Actions
secret named `NPM_TOKEN` containing a granular npm token with permission to
publish new `@jurgen1c` packages and bypass 2FA. After the bootstrap release,
remove the secret and configure npm Trusted Publishing for GitHub user
`jurgen1c`, repository `agent_core`, workflow `publish.yml`, allowed action
`npm publish`, and no environment.
