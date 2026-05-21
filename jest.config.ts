import type { Config } from 'jest'

const config: Config = {
	moduleFileExtensions: ['js', 'json', 'ts'],
	rootDir: '.',
	testRegex: '.*\\.spec\\.ts$',
	transform: {
		'^.+\\.(t|j)s$': [
			'ts-jest',
			{
				tsconfig: {
					module: 'commonjs',
					declaration: true,
					removeComments: true,
					emitDecoratorMetadata: true,
					experimentalDecorators: true,
					allowSyntheticDefaultImports: true,
					target: 'es2017',
					skipLibCheck: true,
					strictNullChecks: false,
					noImplicitAny: false,
					// Без types ts-jest наследует root tsconfig types=['node','multer']
					// и не видит jest globals (describe/it/expect/jest.fn) —
					// все *.spec.ts падали с TS2304/TS2593 при сборке (pre-existing).
					// Добавляем 'jest' ТОЛЬКО для test-сборки. Главный tsconfig
					// не трогаем — production bundle не имеет jest зависимостей.
					types: ['node', 'jest'],
				},
			},
		],
	},
	collectCoverageFrom: ['**/*.(t|j)s'],
	coverageDirectory: '../coverage',
	testEnvironment: 'node',
	moduleNameMapper: {
		'^src/(.*)$': '<rootDir>/src/$1',
	},
}

export default config
