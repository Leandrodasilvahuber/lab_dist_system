// Jest setup file
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Make __dirname available
global.__dirname = __dirname;

// Import and configure environment variables
import dotenv from 'dotenv';
dotenv.config({ path: join(__dirname, '../.env.test') });

// Set test environment
process.env.NODE_ENV = 'test';
