import { storage } from './storage.js';
import { emit } from './events.js';

// Chave de admin: só neste navegador (localStorage), enviada como X-Api-Key
let adminKey = storage.get('adminKey', '');

export const getAdminKey = () => adminKey;

export function setAdminKey(value) {
    adminKey = value;
    storage.set('adminKey', adminKey);
    emit('admin', adminKey);
}
