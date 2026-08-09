// Metro config for the pnpm workspace. #209.
//
// Two things here are NOT optional, and Metro's failure mode for both is a 404 on the bundle with
// an `UnableToResolveError` that names a path relative to the repo root — never the real cause:
//
// 1. `watchFolders` must include the workspace root, because `@fsm/shared` is a `workspace:*`
//    dependency whose source lives outside this project root.
// 2. `watchFolders` must ALSO include pnpm's virtual store. `pnpm-workspace.yaml` relocates it to
//    `C:/pv` (`virtualStoreDir`) so the Windows native build stays under MAX_PATH — see
//    docs/runbooks/mobile-android-build.md §3b. That puts every real package file OUTSIDE the repo,
//    so without this entry Metro treats the store's absolute path as repo-relative and looks for
//    `<repo>/pv/...`, which does not exist. Symptom:
//      Unable to resolve module ./pv/expo-ro_<hash>/node_modules/expo-router/entry
//
// The store location is derived from a real symlink rather than hardcoded, so it keeps tracking
// `virtualStoreDir` if that setting ever moves.

const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// node_modules/expo-router is a pnpm symlink into the virtual store:
//   <store>/expo-ro_<hash>/node_modules/expo-router  ->  three levels up is the store root.
function resolveVirtualStoreRoot() {
  try {
    const linked = fs.realpathSync(path.join(projectRoot, 'node_modules', 'expo-router'));
    return path.resolve(linked, '..', '..', '..');
  } catch {
    return null;
  }
}

const config = getDefaultConfig(projectRoot);

const virtualStoreRoot = resolveVirtualStoreRoot();
const watchFolders = [workspaceRoot];

// Only add the store when it is genuinely outside the workspace; with pnpm's default
// (`<repo>/node_modules/.pnpm`) the workspace root already covers it.
if (virtualStoreRoot && !virtualStoreRoot.startsWith(workspaceRoot)) {
  watchFolders.push(virtualStoreRoot);
}

config.watchFolders = watchFolders;

// Watching the store is necessary but not sufficient. Metro addresses every module as a path
// relative to its *server root*, which Expo sets to the workspace root. `C:/pv` is a SIBLING of the
// repo, so that relative path starts with `..` — which Metro drops when it builds the module
// specifier, turning `../pv/...` into `<repo>/pv/...` and 404-ing the whole bundle. Rooting the
// server at the deepest directory that contains both keeps every path `..`-free.
// With pnpm's default in-repo store this evaluates to the workspace root, i.e. no behaviour change.
function commonAncestor(a, b) {
  const parts = [a, b].map((p) => path.resolve(p).split(path.sep));
  const shared = [];
  for (let i = 0; i < Math.min(parts[0].length, parts[1].length); i++) {
    if (parts[0][i].toLowerCase() !== parts[1][i].toLowerCase()) break;
    shared.push(parts[0][i]);
  }
  // A bare drive letter ("C:") needs the trailing separator to be an absolute path.
  return shared.length === 1 ? shared[0] + path.sep : shared.join(path.sep);
}

config.server = {
  ...config.server,
  unstable_serverRoot: virtualStoreRoot
    ? commonAncestor(workspaceRoot, virtualStoreRoot)
    : workspaceRoot,
};

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// NB: do NOT set `resolver.disableHierarchicalLookup = true` here. Expo's monorepo guide recommends
// it, but that guide assumes a hoisted (npm/yarn) layout. pnpm's isolated store resolves entirely by
// walking up from the importing file — `expo-router` reaches its own `@expo/metro-runtime` at
// `<store>/expo-ro_<hash>/node_modules/@expo/metro-runtime`. Disabling the walk-up makes every
// transitive dependency vanish, as `@expo/metro-runtime could not be found within the project`.

module.exports = config;
