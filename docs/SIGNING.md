# Code signing (free, through SignPath Foundation)

Unsigned installers make Windows SmartScreen say "Windows protected your PC", and the install's UAC prompt shows "Unknown publisher". SignPath Foundation signs open-source projects for free with a certificate in its own name. The release workflow (`.github/workflows/release.yml`) is already set up for it: once the secret below exists, every GitHub release is signed automatically. Until then, releases build exactly the same, just unsigned.

What gets signed:
- `EZ Soundboard.exe`
- the mic plugin files: `ezsb-bridge.exe`, `ezsb-mic-setup.exe`, `EZSoundboardApo.dll`
- the installer, `EZ-Soundboard-Setup-x.y.z.exe` (this one removes the SmartScreen warning)

Only files built from this repo are signed. Electron's own DLLs and `uiohook-napi` are other projects' files, so they're left as they are.

## 1. Before you apply
- The repo must be **public**. (It is also required for in-app updates: installed copies download releases from GitHub without logging in.)
- It needs an **open-source license** (OSI-approved, such as MIT) in a `LICENSE` file. This repo now has an MIT license.
- Releases must be built by GitHub Actions. They are: `.github/workflows/release.yml`.
- Add a short "Code signing policy" section to the README. SignPath gives you the exact wording when you're accepted.

## 2. Apply
Apply at https://signpath.org/apply with the repo link `https://github.com/TheMishez/EZ_SoundBoard`. Review takes from a few days to a few weeks.

## 3. Once you're accepted
In SignPath:
1. Create a project with the slug **`EZ_SoundBoard`** and link it to this GitHub repo as a trusted build system.
2. Add two artifact configurations, pasting in the files from `docs/signing/`:
   - slug **`app`** ← `docs/signing/app.xml`
   - slug **`installer`** ← `docs/signing/installer.xml`
3. Use the signing policy slug **`release-signing`** (the Foundation's default).
4. Create an API token for a CI user that is allowed to submit to that policy.

In GitHub, open the repo's **Settings → Secrets and variables → Actions**:
- **Secrets** tab: add `SIGNPATH_API_TOKEN` = the API token.
- **Variables** tab: add `SIGNPATH_ORGANIZATION_ID` = your SignPath organization ID.
  (Only add `SIGNPATH_PROJECT_SLUG` / `SIGNPATH_POLICY_SLUG` if you used different slugs.)

That's it. The next release you publish is signed: first the program files inside, then the installer. `latest.yml` is then corrected so in-app updates still verify the download.

Note: with the Foundation's `release-signing` policy, SignPath may ask you to approve each signing request on their website. The workflow waits for it, so approve it and the run carries on.

## Releasing a new version
1. Bump `"version"` in `package.json` (for example `1.2.1`) and push to `main`.
2. On GitHub: **Releases → Draft a new release**, create the tag `v1.2.1` (it must match `package.json`), write what changed, and click **Publish release**.
3. The workflow builds, signs, and attaches `EZ-Soundboard-Setup-1.2.1.exe`, `latest.yml` and the Stream Deck plugin to the release.
4. Everyone running EZ Soundboard gets an **Update** button within 6 hours (or right away from Settings → Updates → Check now).

Don't delete `latest.yml` from a release: installed copies read it to find and verify the update.
