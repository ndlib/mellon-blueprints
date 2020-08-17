module.exports = {
    "restoreMocks": true,
    "roots": [
      "<rootDir>/test",
    ],
    testMatch: [ '**/*.test.ts'],
    "transform": {
      "^.+\\.tsx?$": "ts-jest",
    },
  }
