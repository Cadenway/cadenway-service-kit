import assert from 'node:assert/strict';
import { join } from 'node:path';
import ts from 'typescript';

const compilerOptions = {
  module: ts.ModuleKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  types: [],
};

const factory = ts.factory;
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function publicDeclaration(node) {
  if (!ts.isClassDeclaration(node)) return node;
  // Private fields are emitted for nominal typing. Moving private implementation details is allowed.
  const members = node.members.filter(
    (member) =>
      ts.isConstructorDeclaration(member) ||
      (!member.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword) &&
        !(member.name && ts.isPrivateIdentifier(member.name))),
  );
  return factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  );
}

function normalizeOptionalParameters(context) {
  function visit(node) {
    if (ts.isParameter(node) && node.questionToken && node.type && ts.isUnionTypeNode(node.type)) {
      // An optional parameter accepts undefined implicitly. Optional object properties can
      // distinguish it under exactOptionalPropertyTypes, so leave their unions intact.
      const types = node.type.types.filter(({ kind }) => kind !== ts.SyntaxKind.UndefinedKeyword);
      if (types.length && types.length !== node.type.types.length) {
        node = factory.updateParameterDeclaration(
          node,
          node.modifiers,
          node.dotDotDotToken,
          node.name,
          node.questionToken,
          types.length === 1 ? types[0] : factory.createUnionTypeNode(types),
          node.initializer,
        );
      }
    }
    return ts.visitEachChild(node, visit, context);
  }
  return (node) => ts.visitNode(node, visit);
}

function signature(node) {
  const result = ts.transform(publicDeclaration(node), [normalizeOptionalParameters]);
  try {
    return printer
      .printNode(ts.EmitHint.Unspecified, result.transformed[0], node.getSourceFile())
      .trim();
  } finally {
    result.dispose();
  }
}

/** Reads public declarations through an installed package's export map. */
export function readPublicApi(directory, entryPoints) {
  const importer = join(directory, 'consumer.mts');
  const entryFiles = entryPoints.map((entryPoint) => {
    const module = ts.resolveModuleName(
      entryPoint,
      importer,
      compilerOptions,
      ts.sys,
      undefined,
      undefined,
      ts.ModuleKind.ESNext,
    );
    const file = module.resolvedModule?.resolvedFileName;
    assert.ok(file, `Missing TypeScript entry point for ${entryPoint}`);
    assert.match(file, /\.d\.[cm]?ts$/u);
    return [entryPoint, file];
  });
  const program = ts.createProgram(
    [importer, ...entryFiles.map(([, file]) => file)],
    compilerOptions,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => directory,
      getNewLine: () => '\n',
    }),
  );

  const checker = program.getTypeChecker();
  return new Map(
    entryFiles.map(([entryPoint, file]) => {
      const source = program.getSourceFile(file);
      assert.ok(source, `Cannot read declarations for ${entryPoint}`);
      const entry = checker.getSymbolAtLocation(source);
      assert.ok(entry, `Missing TypeScript module for ${entryPoint}`);
      const declarations = checker.getExportsOfModule(entry).map((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        assert.ok(
          target.declarations?.length,
          `Unresolved declaration for ${entryPoint}#${symbol.name}`,
        );
        return [symbol.name, target.declarations.map(signature)];
      });
      return [entryPoint, new Map(declarations)];
    }),
  );
}
