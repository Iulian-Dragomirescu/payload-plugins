/**
 * Cuts a release by writing a version and pushing a tag. Publishing is the
 * `Release` workflow's job, and it only ever reacts to a tag named
 * `<package>@<version>`, so this script is the single place a version is
 * chosen.
 *
 * Run it with `pnpm release`. Every flag has an interactive equivalent:
 *
 *   --package <name>   skip the package picker
 *   --bump <kind>      patch | minor | major | prepatch | preminor |
 *                      premajor | prerelease
 *   --preid <id>       beta | alpha | rc | next, for the pre* bumps
 *   --version <exact>  an explicit version, instead of a bump
 *   --yes              take the flags as given and do not prompt
 *   --dry-run          print what would happen, touch nothing
 *   --no-push          commit and tag locally, push by hand
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import semver, { type ReleaseType } from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Git tags carry the package name so one repo can release many packages. */
const tagFor = (name: string, version: string) => `${name}@${version}`;

interface Pkg {
  name: string;
  version: string;
  dir: string;
  relDir: string;
}

interface Commit {
  subject: string;
  body: string;
  hash: string;
}

const { values: flags } = parseArgs({
  options: {
    package: { type: "string" },
    bump: { type: "string" },
    preid: { type: "string" },
    version: { type: "string" },
    yes: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-push": { type: "boolean", default: false },
  },
});

const dryRun = flags["dry-run"];

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** Runs a command for its effect, streaming output, unless this is a dry run. */
function exec(command: string, args: string[]): void {
  if (dryRun) {
    p.log.info(`dry run: ${command} ${args.join(" ")}`);
    return;
  }
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function bail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

function cancelled<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Nothing was changed.");
    process.exit(130);
  }
  return value as T;
}

/**
 * Refuses to start unless the working copy is somewhere a release can be cut
 * from. Every failure names the command that fixes it, because half of these
 * only ever happen once and the fix is never obvious in the moment.
 */
function preflight(): string {
  try {
    git("rev-parse", "--is-inside-work-tree");
  } catch {
    bail("Not a git repository. Run this from the repo root.");
  }

  let branch: string;
  try {
    branch = git("symbolic-ref", "--short", "HEAD");
  } catch {
    bail("HEAD is detached. Check out a branch first: git switch main");
  }

  if (git("status", "--porcelain")) {
    bail(
      "The working tree has uncommitted changes. A release tags a commit, so " +
        "commit or stash them first: git status",
    );
  }

  // Tags are the record of what was released, and they live on the remote.
  // Deciding the next version against a stale local set is how a version gets
  // published twice.
  try {
    git("fetch", "--tags", "--quiet", "origin");
  } catch {
    bail("Could not reach origin. Releases need the remote tag list.");
  }

  try {
    const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    const [behind] = git("rev-list", "--left-right", "--count", `${upstream}...HEAD`)
      .split(/\s+/)
      .map(Number);
    if (behind > 0) {
      bail(
        `${branch} is ${behind} commit(s) behind ${upstream}. Release the code ` +
          `that is actually on the remote: git pull --ff-only`,
      );
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      p.log.warn(`${branch} has no upstream branch. Pushing will create one.`);
    } else {
      throw error;
    }
  }

  return branch;
}

/**
 * Finds every package that can be published. `packages/` holds nothing but
 * shippable packages, so the only filter that matters is `private`.
 */
function publishablePackages(): Pkg[] {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(packagesDir, entry.name);
      let manifest: { name?: string; version?: string; private?: boolean };
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        return [];
      }
      if (manifest.private || !manifest.name || !manifest.version) return [];
      return [
        {
          name: manifest.name,
          version: manifest.version,
          dir,
          relDir: relative(root, dir),
        },
      ];
    });
}

/** Released versions of a package, newest first, read from the git tags. */
function releasedVersions(name: string): string[] {
  return git("tag", "--list", `${name}@*`)
    .split("\n")
    .filter(Boolean)
    .map((tag) => tag.slice(name.length + 1))
    // Git's own version sort mis-orders prereleases, so sort with semver.
    .filter((version) => semver.valid(version))
    .sort(semver.rcompare);
}

/** Commits since the last release that touched this package's directory. */
function commitsSince(pkg: Pkg, lastTag: string | undefined): Commit[] {
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const log = git(
    "log",
    range,
    "--format=%H%x1f%s%x1f%b%x1e",
    "--",
    pkg.relDir,
  );
  return log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body] = record.split("\x1f");
      return { hash: hash.slice(0, 7), subject, body: body ?? "" };
    });
}

/**
 * Reads the conventional commits and proposes a bump. It is a suggestion, not
 * a decision: the commit type says what changed, only a person knows whether
 * it is worth a minor.
 */
function suggestBump(commits: Commit[], current: string): ReleaseType {
  const breaking = commits.some(
    (c) => /^[a-z]+(\(.+\))?!:/.test(c.subject) || /BREAKING[ -]CHANGE/.test(c.body),
  );
  const feature = commits.some((c) => /^feat(\(.+\))?!?:/.test(c.subject));

  // Under 0.x a breaking change is a minor, which is the whole point of 0.x.
  // Leaving it is a deliberate act, never a side effect of a commit message.
  if (breaking) return semver.major(current) === 0 ? "minor" : "major";
  if (feature) return "minor";
  return "patch";
}

function next(current: string, bump: ReleaseType, preid?: string): string {
  const value = preid ? semver.inc(current, bump, preid) : semver.inc(current, bump);
  if (!value) bail(`Cannot apply a ${bump} bump to ${current}.`);
  return value;
}

/** npm's dist-tag. A prerelease must never land on `latest`. */
function distTag(version: string): string {
  const pre = semver.prerelease(version);
  return pre ? String(pre[0]) : "latest";
}

async function chooseVersion(current: string, suggestion: ReleaseType) {
  if (flags.version) {
    if (!semver.valid(flags.version)) bail(`${flags.version} is not a valid version.`);
    return flags.version;
  }

  if (flags.bump) {
    return next(current, flags.bump as ReleaseType, flags.preid);
  }

  const channel = cancelled(
    await p.select({
      message: "Which channel?",
      options: [
        {
          value: "stable",
          label: "Stable",
          hint: `published as ${distTag("1.0.0")}`,
        },
        {
          value: "pre",
          label: "Prerelease",
          hint: "published under its own dist-tag, npm i pkg@beta",
        },
        { value: "custom", label: "An exact version I type myself" },
      ],
      initialValue: "stable",
    }),
  );

  if (channel === "custom") {
    return cancelled(
      await p.text({
        message: "Version",
        placeholder: current,
        validate: (value) => {
          if (!value || !semver.valid(value)) return "Not a valid semver version.";
          if (semver.lte(value, current)) return `Must be greater than ${current}.`;
          return undefined;
        },
      }),
    );
  }

  if (channel === "stable") {
    const label = (bump: ReleaseType) =>
      `${bump}${bump === suggestion ? "  (the commits suggest this)" : ""}`;
    const bump = cancelled(
      await p.select({
        message: `Bump from ${current}`,
        options: (["patch", "minor", "major"] as const).map((kind) => ({
          value: kind,
          label: label(kind),
          hint:
            next(current, kind) +
            (kind === "major" && semver.major(current) === 0 ? ", leaves 0.x" : ""),
        })),
        initialValue: suggestion === "major" ? "major" : suggestion,
      }),
    );
    return next(current, bump as ReleaseType);
  }

  const preid =
    flags.preid ??
    cancelled(
      await p.select({
        message: "Prerelease channel",
        options: [
          { value: "beta", label: "beta", hint: "feature complete, needs real use" },
          { value: "alpha", label: "alpha", hint: "expect it to break" },
          { value: "rc", label: "rc", hint: "shipping unless something turns up" },
          { value: "next", label: "next", hint: "a rolling preview of the next line" },
        ],
        initialValue: "beta",
      }),
    );

  const continues = semver.prerelease(current) !== null;
  const options = continues
    ? ([["prerelease", "another one on this line"]] as const)
    : ([] as const);

  const bump = cancelled(
    await p.select({
      message: `Prerelease of what, from ${current}`,
      options: [
        ...options.map(([kind, hint]) => ({
          value: kind,
          label: `${kind}  ${next(current, kind, preid)}`,
          hint,
        })),
        ...(["prepatch", "preminor", "premajor"] as const).map((kind) => ({
          value: kind,
          label: `${kind}  ${next(current, kind, preid)}`,
          hint: `first ${preid} of the next ${kind.slice(3)}`,
        })),
      ],
      initialValue: continues ? "prerelease" : "preminor",
    }),
  );

  return next(current, bump as ReleaseType, preid);
}

/**
 * Rewrites the `version` field in place. A parse and re-serialise would
 * reformat the whole manifest, which buries the one line that changed in a
 * diff nobody can review.
 */
function writeVersion(pkg: Pkg, version: string): void {
  const path = join(pkg.dir, "package.json");
  const source = readFileSync(path, "utf8");
  const updated = source.replace(
    /("version"\s*:\s*)"[^"]*"/,
    `$1"${version}"`,
  );
  if (updated === source) {
    bail(`Could not find a version field to update in ${relative(root, path)}.`);
  }
  if (dryRun) {
    p.log.info(`dry run: ${relative(root, path)} version -> ${version}`);
    return;
  }
  writeFileSync(path, updated);
}

async function main() {
  p.intro("Release");

  const branch = preflight();
  const packages = publishablePackages();
  if (packages.length === 0) bail("No publishable package found under packages/.");

  const pkg = flags.package
    ? (packages.find((candidate) => candidate.name === flags.package) ??
      bail(
        `No publishable package named ${flags.package}. Found: ` +
          packages.map((candidate) => candidate.name).join(", "),
      ))
    : packages.length === 1
      ? packages[0]
      : cancelled(
          await p.select({
            message: "Which package?",
            options: packages.map((candidate) => ({
              value: candidate,
              label: candidate.name,
              hint: candidate.version,
            })),
          }),
        );

  const released = releasedVersions(pkg.name);
  const lastTag = released[0] ? tagFor(pkg.name, released[0]) : undefined;
  const current = released[0] ?? pkg.version;

  if (!lastTag) {
    p.log.warn(
      `${pkg.name} has no release tag yet. Starting from the manifest version ` +
        `${pkg.version}.`,
    );
  } else if (semver.neq(current, pkg.version)) {
    p.log.warn(
      `Tags say ${current}, package.json says ${pkg.version}. The tags win, ` +
        `they are what npm has.`,
    );
  }

  const commits = commitsSince(pkg, lastTag);
  if (commits.length === 0) {
    const nothing = `Nothing under ${pkg.relDir} changed since ${lastTag}.`;
    if (flags.yes) {
      p.log.warn(nothing);
    } else {
      const proceed = cancelled(
        await p.confirm({ message: `${nothing} Release anyway?`, initialValue: false }),
      );
      if (!proceed) bail("Nothing to release.");
    }
  } else {
    const shown = commits.slice(0, 10).map((c) => `${c.hash}  ${c.subject}`);
    if (commits.length > shown.length) {
      shown.push(`... and ${commits.length - shown.length} more`);
    }
    p.note(shown.join("\n"), `${commits.length} commit(s) since ${lastTag ?? "the start"}`);
  }

  const version = await chooseVersion(current, suggestBump(commits, current));
  const tag = tagFor(pkg.name, version);
  const channel = distTag(version);

  if (git("tag", "--list", tag)) {
    bail(`${tag} already exists. That version was released.`);
  }
  if (released.length > 0 && !semver.prerelease(version) && semver.lt(version, released[0])) {
    p.log.warn(
      `${version} is older than ${released[0]}, and the workflow will still ` +
        `publish it as latest. Set the dist-tag by hand afterwards if that is wrong.`,
    );
  }

  p.note(
    [
      `package   ${pkg.name}`,
      `version   ${current} -> ${version}`,
      `tag       ${tag}`,
      `dist-tag  ${channel}`,
      `branch    ${branch}`,
      `install   npm i ${pkg.name}${channel === "latest" ? "" : `@${channel}`}`,
    ].join("\n"),
    dryRun ? "Dry run" : "About to release",
  );

  if (!flags.yes) {
    const go = cancelled(
      await p.confirm({
        message: flags["no-push"]
          ? "Commit and tag locally?"
          : "Push the tag? This publishes to npm.",
        initialValue: false,
      }),
    );
    if (!go) bail("Nothing was changed.");
  }

  writeVersion(pkg, version);
  exec("git", ["add", join(pkg.relDir, "package.json")]);
  exec("git", ["commit", "-m", `chore(release): ${tag}`]);
  exec("git", ["tag", "-a", tag, "-m", `${pkg.name} ${version}`]);

  if (flags["no-push"]) {
    p.outro(`Tagged locally. Push when ready: git push --atomic origin ${branch} ${tag}`);
    return;
  }

  try {
    // Atomic, so a rejected branch push cannot leave a tag behind that would
    // start a release of a commit the remote does not have.
    exec("git", ["push", "--atomic", "origin", branch, tag]);
  } catch (error) {
    p.log.error(
      `The push failed. Undo the local commit and tag with:\n` +
        `  git tag -d ${tag}\n` +
        `  git reset --hard HEAD~1`,
    );
    throw error;
  }

  p.outro(
    dryRun
      ? "Dry run finished, nothing was pushed."
      : `Pushed ${tag}. The Release workflow takes it from here.`,
  );
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
