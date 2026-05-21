module.exports = {
	parser: '@typescript-eslint/parser',
	parserOptions: {
		project: 'tsconfig.json',
		tsconfigRootDir: __dirname,
		sourceType: 'module',
	},
	plugins: ['prettier', '@typescript-eslint'],
	extends: ['plugin:prettier/recommended'],
	root: true,
	env: {
		node: true,
		jest: true,
	},
	ignorePatterns: ['.eslintrc.js'],
	rules: {
		'no-console': 1,
		'prettier/prettier': 0,
		// Informational warning — не блокирует build, только подсвечивает
		// `: any` в IDE. Сейчас ~204 occurrences, постепенный clean-up.
		'@typescript-eslint/no-explicit-any': 1,
	},
}
