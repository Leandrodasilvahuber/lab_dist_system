/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.mjs'],
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@ecommerce/(.*)$': '<rootDir>/src/ecommerce/$1',
    '^@layers/(.*)$': '<rootDir>/src/layers/$1'
  },
  transform: {
    '^.+\\.mjs$': 'babel-jest'
  },
  testMatch: [
    '**/test/**/*.test.mjs',
    '**/__tests__/**/*.mjs'
  ],
  collectCoverageFrom: [
    'src/**/*.mjs',
    'src/**/*.js',
    '!src/**/*.config.mjs',
    '!src/ecommerce/**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.mjs']
};