# Publishing the VS Code extension to the Marketplace

Everything that can be prepared in the repository is done: the manifest, icon, README, changelog and license files are in place, and `npm run ext:check` proves it (it runs the readiness tests and builds the package). What remains needs **your** accounts, so it is done by you, once: creating a publisher and a token. **Never paste the token into a chat, an issue or a commit**; anyone who has it can publish as you.

## 1. Create your publisher (once)

1. Open <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account (create one for free if you do not have it).
2. Choose **Create publisher**.
3. **ID**: `imhussain001` (this is what the extension's `publisher` field already says; the ID is permanent and unique across the Marketplace). **Name**: `Hussain Tak`.
   - If that ID is taken, pick another and change `publisher` in `extensions/vscode/package.json` (and the `codearchitect.*` links in the docs below) to match.
4. Fill in the contact details and save.

## 2. Create a Personal Access Token (once; renew when it expires)

1. Open <https://dev.azure.com>, sign in with the **same** Microsoft account, and create an organization if asked (any name).
2. Click your profile picture, then **Personal access tokens**, then **New Token**.
3. Name it `vsce`, set **Organization** to **All accessible organizations**, and set an expiry (the longest, one year, is typical).
4. Under **Scopes** choose **Custom defined**, then **Show all scopes**, and tick **Marketplace → Manage**. Nothing else.
5. Create it and **copy the token now**; it is shown once.

## 3. Log in and publish

From the repository folder (see the README's Quick start for how to open it):

```bash
npx @vscode/vsce login imhussain001
```

Paste the token when asked. Then:

```bash
npm run ext:publish
```

`ext:publish` first runs `ext:check` (the readiness tests plus building the package), then `vsce publish`. If you prefer not to store the login, set the token for one command instead (PowerShell: `$env:VSCE_PAT = "<token>"`; bash: `export VSCE_PAT=<token>`).

The extension appears at `https://marketplace.visualstudio.com/items?itemName=imhussain001.codearchitect-vscode` within a few minutes (the Marketplace scans it first). Anyone can then install it from the Extensions view (search *CodeArchitect*) or with:

```bash
code --install-extension imhussain001.codearchitect-vscode
```

## Before you publish: three decisions

- **The GitHub repository is private.** The listing links to it (Repository, Issues, Homepage), and those links will not open for the public. Either make the repository public, or remove `repository`, `homepage` and `bugs` from `extensions/vscode/package.json` (the readiness test checks for them, so update it too). The license is Apache-2.0 either way; making the repo public is what lets people read the source.
- **First release is marked Preview** (`"preview": true`): the listing shows a Preview badge. Remove it when you are happy with the quality.
- **Screenshots help.** The Marketplace page is just the README. Adding a few screenshots (absolute `https://` image URLs only; relative paths and SVGs are rejected) makes the listing far more convincing.

## Releasing updates

1. Change the code, add an entry to `extensions/vscode/CHANGELOG.md`, and bump `version` in `extensions/vscode/package.json` (the readiness test requires a changelog heading that matches the version).
2. `npm run ext:publish`.

`vsce publish patch` (or `minor` / `major`) bumps the version for you, but then edit the changelog heading to match before running `ext:check`.

### Publishing from GitHub (automatic)

`.github/workflows/publish-extension.yml` publishes when you push a tag named `ext-v<version>`. One-time setup: in the repository go to Settings → Secrets and variables → Actions → New repository secret, name it `VSCE_PAT`, and paste the Marketplace token. Then, for each release:

```bash
# after the version bump and changelog entry are merged to main
git checkout main && git pull
git tag ext-v0.2.0
git push origin ext-v0.2.0
```

The workflow refuses to publish if the tag does not match `extensions/vscode/package.json`, runs `ext:check` first, and keeps the `.vsix` as a run artifact. A failed run publishes nothing, so fix and re-tag (delete the tag first: `git push --delete origin ext-v0.2.0`). Tokens expire: when one does, create a new one and update the secret.

## Other things you may want

- **Open VSX** (used by VS Code forks such as VSCodium and some other editors) is a separate registry: <https://open-vsx.org>. It has its own token and `npx ovsx publish`.
- **Unpublishing or hiding** is done at <https://marketplace.visualstudio.com/manage> (the `…` menu on the extension).
- **Telemetry and privacy:** this extension collects nothing and sends nothing anywhere; it reads your workspace files locally. If that ever changes, the Marketplace requires you to say so in the README.
- **Trademark:** "CodeArchitect" is used as a product name, not a registered mark. If another extension already uses the display name, the Marketplace will tell you when you publish.
