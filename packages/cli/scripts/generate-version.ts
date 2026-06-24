/**
 * 从 package.json 生成 version.ts。
 * 构建前运行，让编译产物内置当前版本号。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgPath = join(import.meta.dir, "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const version = pkg.version;

const outPath = join(import.meta.dir, "../src/version.ts");
writeFileSync(
  outPath,
  `// 由 scripts/generate-version.ts 自动生成，请勿手动编辑\nexport const VERSION = "${version}";\n`,
);

console.log(`[generate-version] ${version} → src/version.ts`);
