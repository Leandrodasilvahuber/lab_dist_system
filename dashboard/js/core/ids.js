// Idempotency-Key de uma compra (UUID v4). crypto.randomUUID só existe em
// contexto seguro (HTTPS ou localhost): no local-server aberto pela rede
// (HOST=0.0.0.0, http://192.168...) ele não existe, e getRandomValues existe
export function newIdempotencyKey(cryptoImpl = globalThis.crypto) {
    if (typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // versão 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
