#!/usr/bin/env node
/**
 * Gera o hash scrypt da chave de admin para o .env do local-server.
 *
 *   npm run admin:hash                 # pede a chave sem mostrar no terminal
 *   npm run admin:hash -- <chave>      # chave no argumento (fica no histórico do shell)
 *
 * Imprime ADMIN_API_KEY_HASH='scrypt$...' pronto para colar no .env. No dashboard
 * a chave continua sendo digitada normalmente; o local-server compara com o hash.
 */
import { hashApiKey } from '../src/common/auth.mjs';

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    if (!stdin.isTTY) return reject(new Error('Sem terminal interativo: passe a chave como argumento'));
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let key = '';
    const onData = chars => {
      for (const char of chars) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          return resolve(key);
        }
        // Ctrl+C ou Ctrl+D cancelam
        if (char === '\u0003' || char === '\u0004') { stdin.setRawMode(false); stderr.write('\n'); process.exit(130); }
        if (char === '\u007f' || char === '\b') key = key.slice(0, -1);
        else key += char;
      }
    };
    stdin.on('data', onData);
  });
}

// Mesmo mínimo que o scripts/deploy.sh exige para a chave na AWS
const RECOMMENDED_MIN_LENGTH = 16;

try {
  const key = process.argv[2] ?? await promptHidden('Chave de admin: ');
  if (key && key.length < RECOMMENDED_MIN_LENGTH) {
    console.error(`⚠️  Chave com ${key.length} caracteres: serve para uso local, mas a AWS (deploy.sh) exige no mínimo ${RECOMMENDED_MIN_LENGTH}.`);
  }
  // Aspas simples: o $ do hash não é expandido se o .env for carregado com source
  console.log(`ADMIN_API_KEY_HASH='${hashApiKey(key)}'`);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
