module.exports = {
  parser: '@typescript-eslint/parser', // Specifies the ESLint parser
  parserOptions: {
    ecmaVersion: 2020, // Allows for the parsing of modern ECMAScript features
    sourceType: 'module', // Allows for the use of imports
  },
  plugins: [
    '@typescript-eslint',
    'jest',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    'brace-style'             : ['error', '1tbs'],
    'comma-dangle'            : ['error', 'always-multiline'],
    'jsx-quotes'              : ['error', 'prefer-single'],
    'object-curly-spacing'    : ['error', 'always'],
    'space-in-parens'         : ['error', 'never'],
    'semi'                    : 'off', // must be disabled for @typescript-eslint/semi to work
    '@typescript-eslint/semi' : ['error', 'never'],
  },
  env: {
    'node': true,
    'jest/globals': true,
  },
}
