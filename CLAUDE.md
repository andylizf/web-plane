# web-plane development

## Production installation

Install the CLI as an npm package copy from GitHub, then build its local macOS
runtime:

```bash
npm install -g github:andylizf/web-plane
web-plane install
web-plane doctor
```

agent-browser 0.34.0 is a pinned package dependency because `attach` relies on
its persistent `--pin-tab` CDP target binding. Do not install a second copy or
its separate browser; web-plane supplies Chrome. Node.js 24 or newer is required
by both the package metadata and that dependency.

This project is not published on npm. The `web-plane` registry name is a
security placeholder, so never run `npm install -g web-plane`.

Never use `npm link`, or a global install from the local checkout, for the
production command. Those forms bind the executable to this mutable git tree;
changing branches can then mix one revision's JS with another revision's
Playwright patch and dylib.

`web-plane install` requires all web-plane browser sessions to be closed. It
rebuilds the small generated runtime from the checked-in lockfile every time,
then writes `~/.web-plane/runtime-version`. It leaves profiles and configuration
alone. Follow an upgrade with `web-plane doctor`.

For an exact production revision:

```bash
npm install -g github:andylizf/web-plane#<commit>
web-plane install
web-plane doctor
```

## Development

Do not point development commands at the production runtime. Use a project-local
runtime explicitly:

```bash
export WEB_PLANE_RUNTIME_DIR="$PWD/tmp/dev-runtime"
npm ci
node ./bin/web-plane.js install
node ./bin/web-plane.js doctor
```

For a package-level smoke test, install a tarball into an isolated prefix rather
than linking the checkout:

```bash
mkdir -p ./tmp/package-smoke
npm ci
npm pack --pack-destination ./tmp/package-smoke
npm install -g --prefix ./tmp/package-smoke/prefix ./tmp/package-smoke/web-plane-*.tgz
./tmp/package-smoke/prefix/bin/web-plane --version
```

Run `npm run check`, `npm run test:unit`, and `npm run test:doctor` before every
commit. Run `npm run test:integration` on an unlocked Mac before changing window
or launch behavior.

## Runtime invariant

The Node launcher, the two Playwright patches, and the two native sources
compiled into `window_suppress.dylib` (`window_suppress.m` and
`panel_control.m`) speak one state protocol. `RUNTIME_VERSION` in
`lib/config.js` names that protocol. Bump it whenever a change requires those
pieces to be deployed together, and add a doctor test proving the previous
protocol is rejected.

Do not patch `~/.web-plane/playwright-cli` by hand. Change the checked-in patch,
run the tests, install a package copy, and let `web-plane install` rebuild the
runtime from pristine locked dependencies.
