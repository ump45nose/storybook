import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

import {
  formatFileContent,
  frameworkPackages,
  getAddonNames,
  rendererPackages,
} from 'storybook/internal/common';
import { loadConfig } from 'storybook/internal/csf-tools';

import jscodeshift from 'jscodeshift';
import path from 'path';
import picocolors from 'picocolors';
import { dedent } from 'ts-dedent';

import type { types as t } from 'storybook/internal/babel';

import { findFilesUp } from '../../util.ts';
import type { Fix } from '../types.ts';

const VITEST_ADDON_NAME = '@storybook/addon-vitest';
const VITEST_PLUGIN_MODULE = '@storybook/addon-vitest/vitest-plugin';
const A11Y_ADDON_NAME = '@storybook/addon-a11y';
const A11Y_PREVIEW_MODULE = '@storybook/addon-a11y/preview';

const SETUP_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cts', '.mts', '.cjs', '.mjs'];
const CONFIG_FILE_PATTERNS = ['vitest.config.{js,ts,mjs,cjs}', 'vite.config.{js,ts,mjs,cjs}'];

interface VitestSetupFileInfo {
  path: string;
  transform:
    | { kind: 'rewritten'; code: string }
    | { kind: 'empty' }
    | { kind: 'manual'; reason: string };
}

interface VitestSetupFileOptions {
  setupFiles: VitestSetupFileInfo[];
  configFiles: string[];
  unresolvedEntries: {
    configFile: string;
    expression: string;
  }[];
}

/**
 * `@storybook/addon-vitest` applies the project annotations itself, and `setProjectAnnotations`
 * replaces whatever was applied before it, so a leftover call in a Vitest setup file discards the
 * addon's annotations. This fix removes such calls when they only pass `.storybook/preview` or
 * `@storybook/addon-a11y/preview`, deletes setup files that end up empty, and drops their
 * `setupFiles` entries from the Vitest/Vite config files that reference them.
 */
export const vitestSetupFile: Fix<VitestSetupFileOptions> = {
  id: 'vitest-setup-file',
  link: 'https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#vitest-addon-setprojectannotations-must-not-be-called-in-setup-files',

  promptType: 'auto',

  async check({ mainConfig, configDir: rawConfigDir, packageManager }) {
    if (!rawConfigDir) {
      return null;
    }
    // The CLI passes the config dir as given on the command line, which may be relative
    const configDir = path.resolve(rawConfigDir);

    const addons = getAddonNames(mainConfig);

    if (!addons.some((addon) => addon.includes(VITEST_ADDON_NAME))) {
      return null;
    }

    const candidateConfigFiles = findFilesUp(CONFIG_FILE_PATTERNS, packageManager.instanceDir);
    const candidateSetupFiles = new Set<string>();

    for (const extension of SETUP_FILE_EXTENSIONS) {
      const filePath = path.join(configDir, `vitest.setup${extension}`);

      if (existsSync(filePath)) {
        candidateSetupFiles.add(filePath);
      }
    }

    const unresolvedEntries: VitestSetupFileOptions['unresolvedEntries'] = [];
    const entriesByConfigFile = new Map<string, SetupFileEntry[]>();
    const referencesBySetupFile = new Map<
      string,
      { configFile: string; storybookProject: boolean }[]
    >();

    for (const configFile of candidateConfigFiles) {
      try {
        const entries = extractSetupFileEntries(readFileSync(configFile, 'utf8'), configFile);
        entriesByConfigFile.set(configFile, entries);

        for (const entry of entries) {
          if (entry.kind === 'unresolved') {
            unresolvedEntries.push({ configFile, expression: entry.expression });
          } else if (existsSync(entry.path)) {
            candidateSetupFiles.add(entry.path);

            const references = referencesBySetupFile.get(entry.path) ?? [];
            references.push({ configFile, storybookProject: entry.storybookProject });
            referencesBySetupFile.set(entry.path, references);
          }
        }
      } catch {
        // Skip config files that can't be read or parsed
      }
    }

    const a11yRegistered = addons.some((addon) => addon.includes(A11Y_ADDON_NAME));
    const setupFiles: VitestSetupFileInfo[] = [];

    for (const filePath of candidateSetupFiles) {
      let source: string;

      try {
        source = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      if (!source.includes('setProjectAnnotations')) {
        continue;
      }

      // A file only loaded by projects without the Storybook plugin (e.g. plain portable stories)
      // legitimately keeps its call; the Storybook project never runs it.
      const references = referencesBySetupFile.get(filePath) ?? [];
      const foreignReference = references.find((reference) => !reference.storybookProject);

      if (foreignReference && references.every((reference) => !reference.storybookProject)) {
        continue;
      }

      setupFiles.push({
        path: filePath,
        transform: foreignReference
          ? {
              kind: 'manual',
              reason: `it is also listed in "setupFiles" of a Vitest project without the Storybook plugin (${foreignReference.configFile}), so its "setProjectAnnotations" call is still needed there; remove the file from the Storybook project's "setupFiles" instead`,
            }
          : transformSetupFile(source, { setupFilePath: filePath, configDir, a11yRegistered }),
      });
    }

    if (setupFiles.length === 0) {
      return null;
    }

    const setupFilePaths = new Set(setupFiles.map((setupFile) => setupFile.path));
    const configFiles = candidateConfigFiles.filter((configFile) =>
      entriesByConfigFile
        .get(configFile)
        ?.some(
          (entry) =>
            entry.kind === 'resolved' && entry.storybookProject && setupFilePaths.has(entry.path)
        )
    );

    return { setupFiles, configFiles, unresolvedEntries };
  },

  prompt() {
    return `We'll remove "setProjectAnnotations" calls from your Vitest setup files, as ${VITEST_ADDON_NAME} now applies project annotations itself`;
  },

  async run({ result, dryRun }) {
    const { setupFiles, configFiles, unresolvedEntries } = result;

    const deletedFiles = setupFiles.filter((setupFile) => setupFile.transform.kind === 'empty');

    const problems = setupFiles.flatMap((setupFile) =>
      setupFile.transform.kind === 'manual'
        ? [`${picocolors.cyan(setupFile.path)}: ${setupFile.transform.reason}`]
        : []
    );

    // A computed entry may be the reference to a file we are about to delete
    if (deletedFiles.length > 0) {
      problems.push(
        ...unresolvedEntries.map(
          (entry) =>
            `${picocolors.cyan(entry.configFile)}: ${picocolors.gray(entry.expression)} is computed at runtime, so the ${picocolors.cyan('setupFiles')} it selects can't be matched without executing your config`
        )
      );
    }

    if (problems.length > 0) {
      // eslint-disable-next-line local-rules/no-uncategorized-errors
      throw new Error(
        dedent`
        The ${this.id} automigration couldn't migrate your Vitest setup file(s) automatically, but here are instructions for doing it yourself:

        ${problems.map((problem, index) => `${index + 1}) ${problem}`).join('\n\n')}

        ${picocolors.cyan(VITEST_ADDON_NAME)} applies your project annotations itself: your ${picocolors.cyan('.storybook/preview')} file and the previews of the addons registered in ${picocolors.cyan('.storybook/main')}. ${picocolors.cyan('setProjectAnnotations')} replaces those annotations, so it must not be called from a Vitest setup file. For each file listed above:
          1. If the call only passes your ${picocolors.cyan('.storybook/preview')} annotations, delete the call.
          2. If it passes an addon's annotations, register that addon in the ${picocolors.cyan('addons')} field of ${picocolors.cyan('.storybook/main')} and delete the call.
          3. If it passes custom annotations, move them into ${picocolors.cyan('.storybook/preview')} and delete the call.
          4. If nothing else remains in the file, delete it and remove its entry from ${picocolors.cyan('setupFiles')} in your Vitest config.
          5. If the file is shared with a Vitest project that uses portable stories directly, list it only in that project's ${picocolors.cyan('setupFiles')}.

        Read more: ${this.link}
      `
      );
    }

    for (const setupFile of setupFiles) {
      if (dryRun) {
        continue;
      }

      if (setupFile.transform.kind === 'rewritten') {
        writeFileSync(
          setupFile.path,
          await formatFileContent(setupFile.path, setupFile.transform.code),
          'utf8'
        );
      } else if (setupFile.transform.kind === 'empty') {
        unlinkSync(setupFile.path);
      }
    }

    if (deletedFiles.length === 0) {
      return;
    }

    const deletedPaths = new Set(deletedFiles.map((setupFile) => setupFile.path));

    for (const configFile of configFiles) {
      const { code, changed } = removeSetupFileEntries(
        readFileSync(configFile, 'utf8'),
        configFile,
        (resolvedPath) => deletedPaths.has(resolvedPath)
      );

      if (!changed) {
        continue;
      }

      // The rewritten config must still parse before we write it back
      loadConfig(code, configFile);

      if (!dryRun) {
        writeFileSync(configFile, await formatFileContent(configFile, code), 'utf8');
      }
    }
  },
};

const ANNOTATIONS_IMPORT_SOURCES = new Set([
  'storybook',
  'storybook/preview-api',
  'storybook/internal/preview-api',
  '@storybook/experimental-nextjs-vite',
  ...Object.keys(frameworkPackages),
  ...Object.keys(rendererPackages),
]);

const SCRIPT_EXTENSION = /\.(c|m)?(j|t)sx?$/;

interface TransformOptions {
  setupFilePath: string;
  configDir: string;
  a11yRegistered: boolean;
}

/**
 * Removes every top-level `setProjectAnnotations(...)` call whose arguments are only the
 * `.storybook/preview` module or `@storybook/addon-a11y/preview`, together with the imports that
 * become unused and any `beforeAll(project.beforeAll)` forwarding of the call's result. Any other
 * shape is reported for manual migration, because rewriting it could drop custom annotations.
 */
export function transformSetupFile(
  source: string,
  options: TransformOptions
): VitestSetupFileInfo['transform'] {
  const j = jscodeshift.withParser('ts');
  const root = j(source);
  const program: t.Program = root.get().node.program;

  const bindings = new Map<
    string,
    { declaration: t.ImportDeclaration; specifier: t.ImportDeclaration['specifiers'][number] }
  >();

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') {
      continue;
    }

    for (const specifier of statement.specifiers) {
      bindings.set(specifier.local.name, { declaration: statement, specifier });
    }
  }

  const callBinding = [...bindings.entries()].find(
    ([, { declaration, specifier }]) =>
      specifier.type === 'ImportSpecifier' &&
      specifier.imported.type === 'Identifier' &&
      specifier.imported.name === 'setProjectAnnotations' &&
      ANNOTATIONS_IMPORT_SOURCES.has(String(declaration.source.value))
  );

  if (!callBinding) {
    return {
      kind: 'manual',
      reason: 'it does not import "setProjectAnnotations" from a Storybook package',
    };
  }

  const unsupportedAnnotation = (node: t.Node | null) => ({
    ok: false as const,
    reason: `it passes annotations that are neither your ".storybook/preview" nor "${A11Y_PREVIEW_MODULE}": ${j(node as unknown as jscodeshift.ASTNode).toSource()}`,
  });

  const classifyAnnotation = (
    node: t.Expression | t.SpreadElement | t.ArgumentPlaceholder | null
  ): { ok: true; name: string } | { ok: false; reason: string } => {
    const identifier =
      node?.type === 'Identifier'
        ? node
        : node?.type === 'MemberExpression' &&
            !node.computed &&
            node.property.type === 'Identifier' &&
            node.property.name === 'composed' &&
            node.object.type === 'Identifier'
          ? node.object
          : null;
    const binding = identifier ? bindings.get(identifier.name) : undefined;
    const isModuleImport =
      binding?.specifier.type === 'ImportNamespaceSpecifier' ||
      binding?.specifier.type === 'ImportDefaultSpecifier';

    if (!identifier || !binding || !isModuleImport) {
      return unsupportedAnnotation(node);
    }

    const importSource = String(binding.declaration.source.value);
    if (resolvesToPreview(importSource, options)) {
      return { ok: true, name: identifier.name };
    }
    if (importSource === A11Y_PREVIEW_MODULE) {
      return options.a11yRegistered
        ? { ok: true, name: identifier.name }
        : {
            ok: false,
            reason: `it passes "${A11Y_PREVIEW_MODULE}" annotations, but ${A11Y_ADDON_NAME} is not registered in the "addons" field of your .storybook/main`,
          };
    }
    return unsupportedAnnotation(node);
  };

  const removedStatements = new Set<t.Statement>();
  const capturedNames = new Set<string>();
  const annotationNames = new Set<string>();

  let calls = 0;

  for (const statement of program.body) {
    const call =
      statement.type === 'ExpressionStatement' && isCallOf(statement.expression, callBinding[0])
        ? statement.expression
        : statement.type === 'VariableDeclaration' &&
            statement.declarations.length === 1 &&
            statement.declarations[0].id.type === 'Identifier' &&
            isCallOf(statement.declarations[0].init, callBinding[0])
          ? statement.declarations[0].init
          : null;

    if (!call) {
      continue;
    }

    calls += 1;

    if (call.arguments.length > 1) {
      return {
        kind: 'manual',
        reason: 'it calls "setProjectAnnotations" with unexpected arguments',
      };
    }

    const [argument] = call.arguments;
    const elements =
      argument?.type === 'ArrayExpression' ? argument.elements : argument ? [argument] : [];

    for (const element of elements) {
      const classified = classifyAnnotation(element);

      if (!classified.ok) {
        return { kind: 'manual', reason: classified.reason };
      }

      annotationNames.add(classified.name);
    }

    removedStatements.add(statement);
    if (statement.type === 'VariableDeclaration') {
      capturedNames.add((statement.declarations[0].id as t.Identifier).name);
    }
  }

  if (countReferences(j, root, callBinding[0]) !== calls) {
    return {
      kind: 'manual',
      reason:
        'the "setProjectAnnotations" call is conditional or wrapped, so it cannot be removed safely',
    };
  }

  for (const name of capturedNames) {
    const forwardings = program.body.filter((statement) => isBeforeAllForwarding(statement, name));

    if (countReferences(j, root, name) !== forwardings.length) {
      return {
        kind: 'manual',
        reason:
          'the value returned by "setProjectAnnotations" is used for more than forwarding "beforeAll"',
      };
    }

    forwardings.forEach((statement) => removedStatements.add(statement));
  }

  program.body = program.body.filter((statement) => !removedStatements.has(statement));

  for (const name of [callBinding[0], ...annotationNames, 'beforeAll']) {
    const binding = bindings.get(name);

    if (!binding || countReferences(j, root, name) > 0) {
      continue;
    }

    binding.declaration.specifiers = binding.declaration.specifiers.filter(
      (specifier) => specifier !== binding.specifier
    );

    if (binding.declaration.specifiers.length === 0) {
      program.body = program.body.filter((statement) => statement !== binding.declaration);
    }
  }

  if (program.body.length === 0) {
    return { kind: 'empty' };
  }

  return { kind: 'rewritten', code: root.toSource() };
}

function resolvesToPreview(importSource: string, options: TransformOptions) {
  if (!importSource.startsWith('.')) {
    return false;
  }
  const resolved = path
    .resolve(path.dirname(options.setupFilePath), importSource)
    .replace(SCRIPT_EXTENSION, '');
  return resolved === path.resolve(options.configDir, 'preview');
}

function isCallOf(node: t.Node | null | undefined, calleeName: string): node is t.CallExpression {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === calleeName
  );
}

function isBeforeAllForwarding(statement: t.Statement, resultName: string) {
  if (statement.type !== 'ExpressionStatement' || !isCallOf(statement.expression, 'beforeAll')) {
    return false;
  }
  const [argument] = statement.expression.arguments;
  return (
    statement.expression.arguments.length === 1 &&
    argument.type === 'MemberExpression' &&
    !argument.computed &&
    argument.object.type === 'Identifier' &&
    argument.object.name === resultName &&
    argument.property.type === 'Identifier' &&
    argument.property.name === 'beforeAll'
  );
}

/** Counts uses of a binding, ignoring its declaration, member property names and object keys. */
function countReferences(j: jscodeshift.JSCodeshift, root: jscodeshift.Collection, name: string) {
  return root
    .find(j.Identifier, { name })
    .filter((identifierPath) => {
      const parent = identifierPath.parent.node;
      if (
        parent.type === 'ImportSpecifier' ||
        parent.type === 'ImportDefaultSpecifier' ||
        parent.type === 'ImportNamespaceSpecifier' ||
        (parent.type === 'VariableDeclarator' && parent.id === identifierPath.node)
      ) {
        return false;
      }
      if (parent.type === 'MemberExpression' && !parent.computed) {
        return parent.property !== identifierPath.node;
      }
      if ((parent.type === 'ObjectProperty' || parent.type === 'Property') && !parent.computed) {
        return parent.key !== identifierPath.node || parent.shorthand === true;
      }
      return true;
    })
    .size();
}

/**
 * A `setupFiles` entry, either statically resolved to an absolute path or reported verbatim so a
 * deleted setup file never stays referenced by an entry the fix could not read. `storybookProject`
 * tells whether the project (or root config) owning the entry loads the `storybookTest` plugin.
 */
export type SetupFileEntry =
  | { kind: 'resolved'; path: string; storybookProject: boolean }
  | { kind: 'unresolved'; expression: string };

/**
 * Collects the entries of every `setupFiles` value in a Vitest/Vite config, resolving each against
 * the config's directory. Recognized forms are string literals, substitution-free template
 * literals, and `path.join`/`path.resolve`/`path.dirname` chains anchored on `import.meta.dirname`,
 * `__dirname` or `fileURLToPath(import.meta.url)`; anything else is returned as `unresolved`.
 */
export function extractSetupFileEntries(source: string, configFile: string): SetupFileEntry[] {
  const j = jscodeshift.withParser('ts');
  const root = j(source);
  const pluginNames = getStorybookPluginNames(j, root);
  const entries: SetupFileEntry[] = [];

  root
    .find(j.ObjectProperty)
    .filter((propertyPath) => isKeyNamed(propertyPath.value.key, 'setupFiles'))
    .forEach((propertyPath) => {
      const storybookProject = belongsToStorybookProject(j, propertyPath, pluginNames);
      const base = getSetupFilesBaseDir(propertyPath, configFile);
      if ('unresolvedRoot' in base) {
        entries.push({
          kind: 'unresolved',
          expression: `root: ${j(base.unresolvedRoot).toSource()}`,
        });
        return;
      }
      const value = propertyPath.value.value;
      const nodes = value.type === 'ArrayExpression' ? value.elements : [value];
      for (const node of nodes) {
        if (node) {
          entries.push(toSetupFileEntry(j, node, configFile, base.baseDir, storybookProject));
        }
      }
    });

  return entries;
}

function getStorybookPluginNames(j: jscodeshift.JSCodeshift, root: jscodeshift.Collection) {
  const names = new Set<string>();
  root
    .find(j.ImportDeclaration, { source: { value: VITEST_PLUGIN_MODULE } })
    .forEach((importPath) => {
      for (const specifier of importPath.node.specifiers ?? []) {
        if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'storybookTest') {
          const local = specifier.local?.name;
          names.add(typeof local === 'string' ? local : 'storybookTest');
        }
      }
    });
  return names;
}

type ObjectPropertyPath = jscodeshift.ASTPath<jscodeshift.ObjectProperty>;
type ObjectExpressionPath = jscodeshift.ASTPath<jscodeshift.ObjectExpression>;

function belongsToStorybookProject(
  j: jscodeshift.JSCodeshift,
  setupFilesPath: ObjectPropertyPath,
  pluginNames: Set<string>
): boolean {
  const configObject = getEnclosingConfigObject(setupFilesPath);
  return configObject !== null && configObjectUsesPlugin(j, configObject, pluginNames);
}

/** Walks from a property of a `test: {}` object up to the project or root config object owning it. */
function getEnclosingConfigObject(testFieldPath: ObjectPropertyPath): ObjectExpressionPath | null {
  const testProperty = testFieldPath.parent?.parent;
  if (
    !testProperty ||
    testProperty.node.type !== 'ObjectProperty' ||
    !isKeyNamed(testProperty.node.key, 'test')
  ) {
    return null;
  }
  const configObject = testProperty.parent;
  return configObject?.node.type === 'ObjectExpression' ? configObject : null;
}

function configObjectUsesPlugin(
  j: jscodeshift.JSCodeshift,
  configObject: ObjectExpressionPath,
  pluginNames: Set<string>
): boolean {
  const plugins = findProperty(configObject.node, 'plugins');
  if (
    plugins &&
    j(plugins.value)
      .find(j.CallExpression)
      .some((call) => isCalleeOneOf(call.node.callee, pluginNames))
  ) {
    return true;
  }

  // `extends: true` inherits the plugins of the root config listing this project
  if (!findProperty(configObject.node, 'extends')) {
    return false;
  }
  const rootConfig = getEnclosingRootConfig(configObject);
  return rootConfig !== null && configObjectUsesPlugin(j, rootConfig, pluginNames);
}

function isCalleeOneOf(callee: jscodeshift.ASTNode, names: Set<string>) {
  if (callee.type === 'Identifier') {
    return names.has(callee.name);
  }
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    names.has(callee.property.name)
  );
}

/**
 * Vitest resolves relative `setupFiles` against the project's root, which defaults to the config
 * file's directory. `test.root` wins over the top-level `root`, and a nested project inherits both
 * from the root config listing it. A root that can't be read statically makes every entry
 * unresolvable.
 */
function getSetupFilesBaseDir(
  setupFilesPath: ObjectPropertyPath,
  configFile: string
): { baseDir: string } | { unresolvedRoot: jscodeshift.ASTNode } {
  const configDir = path.dirname(configFile);
  const testObject = setupFilesPath.parent?.node;
  const candidates: (jscodeshift.ASTNode | undefined)[] = [
    testObject?.type === 'ObjectExpression' ? findProperty(testObject, 'root')?.value : undefined,
  ];
  let configObject = getEnclosingConfigObject(setupFilesPath);
  while (configObject) {
    candidates.push(findProperty(configObject.node, 'root')?.value);
    configObject = getEnclosingRootConfig(configObject);
    const inheritedTest = configObject && findProperty(configObject.node, 'test')?.value;
    candidates.push(
      inheritedTest?.type === 'ObjectExpression'
        ? findProperty(inheritedTest, 'root')?.value
        : undefined
    );
  }

  const rootNode = candidates.find((candidate) => candidate !== undefined);
  if (!rootNode) {
    return { baseDir: configDir };
  }
  const root = resolveStaticPath(rootNode, configFile);
  return root === null ? { unresolvedRoot: rootNode } : { baseDir: path.resolve(configDir, root) };
}

function findProperty(objectNode: jscodeshift.ObjectExpression, name: string) {
  return objectNode.properties.find(
    (property): property is jscodeshift.ObjectProperty =>
      property.type === 'ObjectProperty' && isKeyNamed(property.key, name)
  );
}

/** From a `test.projects[n]` object to the root config object listing it, or null at the top. */
function getEnclosingRootConfig(configObject: ObjectExpressionPath): ObjectExpressionPath | null {
  const projectsProperty = configObject.parent?.parent;

  if (
    !projectsProperty ||
    projectsProperty.node.type !== 'ObjectProperty' ||
    !isKeyNamed(projectsProperty.node.key, 'projects')
  ) {
    return null;
  }

  return getEnclosingConfigObject(projectsProperty);
}

function toSetupFileEntry(
  j: jscodeshift.JSCodeshift,
  node: jscodeshift.ASTNode,
  configFile: string,
  baseDir: string,
  storybookProject: boolean
): SetupFileEntry {
  const resolved = resolveStaticPath(node, configFile);
  if (resolved !== null) {
    return { kind: 'resolved', path: path.resolve(baseDir, resolved), storybookProject };
  }
  let expression: string;
  try {
    expression = j(node).toSource();
  } catch {
    expression = String(node.type);
  }
  return { kind: 'unresolved', expression };
}

function resolveStaticPath(
  node: jscodeshift.ASTNode | null | undefined,
  configFile: string
): string | null {
  if (!node) {
    return null;
  }

  const configDir = path.dirname(configFile);

  if (node.type === 'StringLiteral') {
    return node.value;
  }

  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length > 0 || node.quasis.length !== 1) {
      return null;
    }
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }

  if (node.type === 'Identifier' && node.name === '__dirname') {
    return configDir;
  }

  if (node.type === 'MemberExpression' && isImportMeta(node.object)) {
    if (node.property.type === 'Identifier' && node.property.name === 'dirname') {
      return configDir;
    }
    return null;
  }

  if (node.type !== 'CallExpression') {
    return null;
  }

  if (isCalleeNamed(node.callee, 'fileURLToPath')) {
    const [argument] = node.arguments;
    if (node.arguments.length !== 1 || !argument) {
      return null;
    }
    if (isImportMetaUrl(argument)) {
      return configFile;
    }
    if (argument.type === 'NewExpression' && isCalleeNamed(argument.callee, 'URL')) {
      const [relative, base] = argument.arguments;
      if (argument.arguments.length !== 2 || !isImportMetaUrl(base)) {
        return null;
      }
      const relativePath = resolveStaticPath(relative, configFile);
      return relativePath === null ? null : path.resolve(configDir, relativePath);
    }
    return null;
  }

  const pathMethod = getPathMethodName(node.callee);
  if (!pathMethod) {
    return null;
  }

  const segments: string[] = [];
  for (const argument of node.arguments) {
    const segment = resolveStaticPath(argument, configFile);
    if (segment === null) {
      return null;
    }
    segments.push(segment);
  }

  if (pathMethod === 'dirname') {
    return segments.length === 1 ? path.dirname(segments[0]) : null;
  }
  if (segments.length === 0) {
    return null;
  }
  return pathMethod === 'join' ? path.join(...segments) : path.resolve(...segments);
}

function isImportMeta(node: jscodeshift.ASTNode | null | undefined): boolean {
  return node?.type === 'MetaProperty' || (node?.type === 'Identifier' && node.name === 'import');
}

function isImportMetaUrl(node: jscodeshift.ASTNode | null | undefined): boolean {
  return (
    node?.type === 'MemberExpression' &&
    isImportMeta(node.object) &&
    node.property?.type === 'Identifier' &&
    node.property.name === 'url'
  );
}

function isCalleeNamed(callee: jscodeshift.ASTNode | null | undefined, name: string): boolean {
  if (callee?.type === 'Identifier') {
    return callee.name === name;
  }
  return (
    callee?.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === name
  );
}

function getPathMethodName(
  callee: jscodeshift.ASTNode | null | undefined
): 'join' | 'resolve' | 'dirname' | null {
  if (callee?.type !== 'MemberExpression' || callee.property?.type !== 'Identifier') {
    return null;
  }
  const method = callee.property.name;
  if (method !== 'join' && method !== 'resolve' && method !== 'dirname') {
    return null;
  }
  return callee.object?.type === 'Identifier' ? method : null;
}

/**
 * Removes the entries resolving to a target path from every `setupFiles` value of a Storybook
 * project in the config, and drops the property when a single-valued `setupFiles` or an emptied
 * array pointed at them.
 */
export function removeSetupFileEntries(
  source: string,
  configFile: string,
  isTargetPath: (resolvedPath: string) => boolean
) {
  const j = jscodeshift.withParser('ts');
  const root = j(source);
  const pluginNames = getStorybookPluginNames(j, root);
  let changed = false;

  root
    .find(j.ObjectProperty)
    .filter(
      (propertyPath) =>
        isKeyNamed(propertyPath.value.key, 'setupFiles') &&
        belongsToStorybookProject(j, propertyPath, pluginNames)
    )
    .forEach((propertyPath) => {
      const base = getSetupFilesBaseDir(propertyPath, configFile);
      if ('unresolvedRoot' in base) {
        return;
      }
      const isTargetNode = (node: jscodeshift.ASTNode) => {
        const entry = toSetupFileEntry(j, node, configFile, base.baseDir, true);
        return entry.kind === 'resolved' && isTargetPath(entry.path);
      };
      const value = propertyPath.value.value;

      if (value.type !== 'ArrayExpression') {
        if (isTargetNode(value)) {
          propertyPath.prune();
          changed = true;
        }
        return;
      }

      const elements = value.elements;
      if (!elements.some((element) => element && isTargetNode(element))) {
        return;
      }

      value.elements = elements.filter((element) => !(element && isTargetNode(element)));
      changed = true;

      if (value.elements.length === 0) {
        propertyPath.prune();
      }
    });

  return { code: root.toSource(), changed };
}

function isKeyNamed(key: { type: string; name?: unknown; value?: unknown }, name: string) {
  return (
    (key.type === 'Identifier' && key.name === name) ||
    (key.type === 'StringLiteral' && key.value === name)
  );
}
