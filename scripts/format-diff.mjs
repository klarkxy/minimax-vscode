#!/usr/bin/env node
// CI 用的 format:check 包装：只检查 PR 改动的文件，不动历史文件。
//
// 行为：
//   - 在 CI 上：取 origin/main...HEAD 的差异文件
//   - 在本地（无 origin/main）：取 HEAD 的 modified + others（lint-staged 不需要这个）
//   - 文件被 .prettierignore 覆盖的不报
//
// 退出码：0 = 通过；1 = 有不符合 Prettier 风格的文件。
import { execSync } from 'node:child_process';

function sh(cmd) {
	try {
		return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '';
	}
}

// PR 模式：origin/main...HEAD；本地兜底：HEAD 起的所有未跟踪 + 修改
let files = sh('git diff --name-only --diff-filter=ACMR origin/main...HEAD');
if (!files) {
	files = sh('git diff --name-only --diff-filter=ACMR HEAD');
}
if (!files) {
	console.log('format:diff: no changed files to check');
	process.exit(0);
}

const list = files.split(/\r?\n/).filter(Boolean);
// Prettier 不解析纯文本元文件（.gitignore / .gitattributes / .prettierignore），
// 也不解析二进制 / 锁文件 / 插件备份目录；这些不需要走 Prettier。
const SKIP_FILES = new Set(['.gitignore', '.gitattributes', '.prettierignore']);
const SKIP_RE = /\.(vsix|lock)$/i;
// .husky/ 下的 hook 是纯 shell，Prettier 不解析
const SKIP_DIRS = ['.husky/'];
const filtered = list.filter(
	(f) =>
		!SKIP_FILES.has(f) &&
		!SKIP_RE.test(f) &&
		!SKIP_DIRS.some((d) => f.includes(`/${d}`) || f.startsWith(d)),
);
if (filtered.length === 0) {
	console.log('format:diff: no changed files to check');
	process.exit(0);
}

console.log(`format:diff: checking ${filtered.length} file(s)`);
try {
	execSync(`npx prettier --check ${filtered.map((f) => `"${f}"`).join(' ')}`, {
		encoding: 'utf8',
		stdio: 'inherit',
	});
} catch (err) {
	// prettier 退出码非 0 时让 npm 失败
	process.exit(1);
}
