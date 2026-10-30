// Serena TS 项目成员解析：显式受信任编译器、输入源文件目录和配置依赖跟踪。
const fs = require('node:fs');
const path = require('node:path');

/** 限制可信客户端输入大小，避免意外巨量配置列表。 */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/** 统一编译器与原生路径的分隔符。 */
function slash(file) {
  return file.replace(/\\/g, '/');
}

/** 判断绝对路径是否属于根目录。 */
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** 校验输入，并仅接受根目录内的相对配置和源文件路径。 */
function inputPaths(root, values) {
  return values
    .filter((value) => typeof value === 'string' && value !== '' && !path.isAbsolute(value))
    .map((value) => path.resolve(root, slash(value)))
    .filter((file) => inside(root, file) && file !== root);
}

/** 创建只包含输入源文件的虚拟目录视图。 */
function sourceDirectories(root, sources, key) {
  const directories = new Map();
  function entry(directory) {
    const name = key(directory);
    if (!directories.has(name)) directories.set(name, { files: new Set(), directories: new Set() });
    return directories.get(name);
  }
  entry(root);
  for (const file of sources) {
    let directory = path.dirname(file);
    entry(directory).files.add(path.basename(file));
    while (directory !== root && inside(root, directory)) {
      const parent = path.dirname(directory);
      entry(parent).directories.add(path.basename(directory));
      directory = parent;
    }
  }
  return (directory) => {
    const found = directories.get(key(directory));
    return {
      files: found ? [...found.files].sort() : [],
      directories: found ? [...found.directories].sort() : [],
    };
  };
}

/** 通过编译器配置 API 解析成员，不加载项目代码或配置插件。 */
function parseProjects(ts, input) {
  const root = path.resolve(input.root);
  const caseSensitive = ts.sys.useCaseSensitiveFileNames;
  const key = (file) => {
    const normalized = slash(path.resolve(file));
    return caseSensitive ? normalized : normalized.toLowerCase();
  };
  const sources = new Map(inputPaths(root, input.files).map((file) => [key(file), file]));
  const entries = sourceDirectories(root, sources.values(), key);
  const dependencies = new Map();
  const track = (file) => {
    const absolute = path.resolve(file);
    dependencies.set(key(absolute), absolute);
    return absolute;
  };
  const host = {
    useCaseSensitiveFileNames: caseSensitive,
    fileExists: (file) => ts.sys.fileExists(track(file)),
    directoryExists: (directory) => ts.sys.directoryExists(track(directory)),
    readFile: (file) => ts.sys.readFile(track(file)),
    getCurrentDirectory: () => root,
    getDirectories: (directory) =>
      entries(directory).directories.map((name) => path.join(directory, name)),
    realpath: (file) => path.resolve(file),
    readDirectory: (directory, extensions, excludes, includes, depth) =>
      ts.matchFiles(
        slash(directory),
        extensions,
        excludes,
        includes,
        caseSensitive,
        slash(root),
        depth,
        entries,
        slash,
      ),
  };
  const pending = inputPaths(root, input.configs);
  const visited = new Set();
  const projects = [];
  for (let index = 0; index < pending.length; index++) {
    const config = path.resolve(pending[index]);
    if (visited.has(key(config))) continue;
    visited.add(key(config));
    track(config);
    if (!inside(root, config)) continue;
    try {
      const loaded = ts.readConfigFile(config, host.readFile);
      if (
        loaded.error ||
        loaded.config === null ||
        typeof loaded.config !== 'object' ||
        Array.isArray(loaded.config)
      )
        continue;
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        host,
        path.dirname(config),
        undefined,
        config,
      );
      for (const reference of parsed.projectReferences ?? []) {
        const referenced = path.resolve(ts.resolveProjectReferencePath(reference));
        track(referenced);
        if (inside(root, referenced)) pending.push(referenced);
      }
      if (parsed.errors.some((error) => error.category === ts.DiagnosticCategory.Error)) continue;
      const members = new Set();
      for (const candidate of parsed.fileNames) {
        const file = sources.get(key(candidate));
        if (file) members.add(slash(path.relative(root, file)));
      }
      if (members.size > 0) {
        projects.push({ config: slash(path.relative(root, config)), files: [...members].sort() });
      }
    } catch {
      // 损坏或不可读取的单个配置不影响其他工程，已探测依赖仍然保留。
    }
  }
  projects.sort((left, right) => left.config.localeCompare(right.config));
  return { projects, dependencies: [...dependencies.values()].sort() };
}

/** 从 stdin 读取 JSON，使用调用者提供的绝对受信任编译器路径。 */
function main() {
  const compiler = process.argv[2];
  if (!compiler || !path.isAbsolute(compiler) || process.argv.length !== 3) {
    throw new Error('usage: node serena-projects.cjs <absolute trusted typescript.js path>');
  }
  const raw = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) throw new Error('project input is too large');
  const input = JSON.parse(raw);
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.root !== 'string' ||
    !path.isAbsolute(input.root) ||
    !Array.isArray(input.configs) ||
    !Array.isArray(input.files)
  ) {
    throw new Error('input must contain absolute root, configs and files arrays');
  }
  const ts = require(compiler);
  if (
    !ts.sys ||
    typeof ts.readConfigFile !== 'function' ||
    typeof ts.parseJsonConfigFileContent !== 'function' ||
    typeof ts.matchFiles !== 'function'
  ) {
    throw new Error('trusted compiler does not provide the TypeScript config API');
  }
  process.stdout.write(`${JSON.stringify(parseProjects(ts, input))}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `serena-projects: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
