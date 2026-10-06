module.exports = {
  env: {
    node: true,
    es2022: true
  },
  extends: [
    'eslint:recommended',
    // Padrões inseguros no código Node: eval, child_process e fs com entrada dinâmica, regex com ReDoS
    'plugin:security/recommended-legacy',
    // Imports quebrados e APIs que não existem no Node 22 (runtime das Lambdas)
    'plugin:n/recommended-module'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  settings: {
    node: { version: '>=22.0.0' }
  },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
    // Os scripts e testes importam devDependencies e não são publicados
    'n/no-unpublished-import': 'off',
    // process.exit é o jeito normal de encerrar os scripts de CLI
    'n/no-process-exit': 'off',
    // Scripts com #! rodam via node/npm, não como bin publicado
    'n/shebang': 'off',
    // obj[chave] dispara em todo acesso dinâmico (centenas de falsos positivos)
    'security/detect-object-injection': 'off'
  },
  overrides: [
    {
      // Testes e scripts locais leem arquivos e montam regex a partir de valores do próprio repositório
      files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
      rules: {
        'security/detect-non-literal-fs-filename': 'off',
        'security/detect-non-literal-regexp': 'off',
        'security/detect-unsafe-regex': 'off'
      }
    },
    {
      // O dashboard roda no navegador (document, confirm, fetch, localStorage)
      files: ['dashboard/**/*.js'],
      env: { browser: true, node: false },
      plugins: ['no-unsanitized'],
      extends: ['plugin:no-unsanitized/DOM'],
      rules: {
        // As telas montam HTML com template strings e escapeHtml dentro dos
        // componentes, o que a regra não enxerga. A garantia contra XSS é
        // test/unit/dashboard/xss.test.mjs; insertAdjacentHTML/document.write
        // continuam barrados por no-unsanitized/method
        'no-unsanitized/property': 'off',
        'n/no-unsupported-features/node-builtins': 'off',
        'n/no-missing-import': 'off'
      }
    }
  ]
}
